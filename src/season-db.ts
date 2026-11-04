import type { D1Database } from '@cloudflare/workers-types';
import { getGroupLeaderboard, getLeaderboard, getUser, type LeaderboardEntry } from './db';
import { seasonById, usesLegacyElo, type BridgeSeason } from './seasons';
import { SKILL_PROVISIONAL_GAMES } from './skill-rating';

export interface SeasonBoardEntry extends LeaderboardEntry {
  /** Fewer than SKILL_PROVISIONAL_GAMES rated hands this season (later seasons only). */
  provisional?: boolean;
}

export interface SeasonBoard {
  top: SeasonBoardEntry[];
  me: (SeasonBoardEntry & { telegramId: number }) | null;
}

interface BoardRow { display_name: string; rating: number; wins: number; games: number; rank: number }

function entry(r: BoardRow): SeasonBoardEntry {
  return {
    rank: r.rank,
    displayName: r.display_name,
    elo: Math.round(r.rating),
    wins: r.wins,
    gamesPlayed: r.games,
    provisional: r.games < SKILL_PROVISIONAL_GAMES,
  };
}

function board(top: BoardRow[], me: BoardRow | null, telegramId?: number): SeasonBoard {
  const entries = top.map(entry);
  // As before: the caller's own row is added only when they are outside the top five.
  if (!telegramId || !me || me.games === 0 || me.rank <= 5) return { top: entries, me: null };
  return { top: entries, me: { ...entry(me), telegramId } };
}

/** The Bridge board for a season, in getLeaderboard's shape: legacy Elo for Season 1, the season rating after. */
export async function getSeasonLeaderboard(db: D1Database, season: BridgeSeason, telegramId?: number): Promise<SeasonBoard> {
  if (usesLegacyElo(season)) return getLeaderboard(db, telegramId);
  const top = await db
    .prepare(
      `SELECT u.display_name, r.rating, r.wins, r.games, RANK() OVER (ORDER BY r.rating DESC) AS rank
       FROM bridge_ratings r
       JOIN users u ON u.telegram_id = r.telegram_id
       WHERE r.system = ? AND r.games > 0
       ORDER BY r.rating DESC
       LIMIT 5`,
    )
    .bind(season.ratingSystem)
    .all<BoardRow>();
  const me = telegramId
    ? await db
      .prepare(
        `SELECT u.display_name, r.rating, r.wins, r.games,
                (SELECT COUNT(*) + 1 FROM bridge_ratings r2 WHERE r2.system = r.system AND r2.games > 0 AND r2.rating > r.rating) AS rank
         FROM bridge_ratings r
         JOIN users u ON u.telegram_id = r.telegram_id
         WHERE r.system = ? AND r.telegram_id = ?`,
      )
      .bind(season.ratingSystem, telegramId)
      .first<BoardRow>()
    : null;
  return board(top.results ?? [], me, telegramId);
}

/** A group's Bridge board for a season: verified members' games in the group, ranked by their season rating. */
export async function getSeasonGroupLeaderboard(
  db: D1Database,
  season: BridgeSeason,
  groupId: string,
  telegramId?: number,
): Promise<SeasonBoard> {
  if (usesLegacyElo(season)) return getGroupLeaderboard(db, groupId, telegramId);
  const top = await db
    .prepare(
      `SELECT u.display_name, r.rating, gs.wins, gs.games_played AS games, RANK() OVER (ORDER BY r.rating DESC) AS rank
       FROM bridge_season_group_stats gs
       JOIN bridge_ratings r ON r.telegram_id = gs.telegram_id AND r.system = ?
       JOIN users u ON u.telegram_id = gs.telegram_id
       WHERE gs.season_id = ? AND gs.group_id = ? AND gs.games_played > 0
       ORDER BY r.rating DESC
       LIMIT 5`,
    )
    .bind(season.ratingSystem, season.id, groupId)
    .all<BoardRow>();
  const me = telegramId
    ? await db
      .prepare(
        `SELECT u.display_name, r.rating, gs.wins, gs.games_played AS games,
                (SELECT COUNT(*) + 1
                 FROM bridge_season_group_stats gs2
                 JOIN bridge_ratings r2 ON r2.telegram_id = gs2.telegram_id AND r2.system = r.system
                 WHERE gs2.season_id = gs.season_id AND gs2.group_id = gs.group_id AND gs2.games_played > 0
                   AND r2.rating > r.rating) AS rank
         FROM bridge_season_group_stats gs
         JOIN bridge_ratings r ON r.telegram_id = gs.telegram_id AND r.system = ?
         JOIN users u ON u.telegram_id = gs.telegram_id
         WHERE gs.season_id = ? AND gs.group_id = ? AND gs.telegram_id = ?`,
      )
      .bind(season.ratingSystem, season.id, groupId, telegramId)
      .first<BoardRow>()
    : null;
  return board(top.results ?? [], me, telegramId);
}

export interface HandRatingChange {
  name: string;
  delta: number;
  eloBefore: number;
  eloAfter: number;
}

/**
 * The rating changes shown after a hand: legacy Elo history for Season 1 hands,
 * the hand's season rating after that (rounded; delta = after − before as shown).
 */
export async function getHandRatingChanges(db: D1Database, gameId: string): Promise<HandRatingChange[]> {
  const legacy = await db
    .prepare(
      `SELECT u.display_name, eh.delta, eh.elo_before, eh.elo_after
       FROM elo_history eh
       JOIN users u ON u.telegram_id = eh.telegram_id
       WHERE eh.game_id = ?`,
    )
    .bind(gameId)
    .all<{ display_name: string; delta: number; elo_before: number; elo_after: number }>();
  if ((legacy.results ?? []).length > 0) {
    return legacy.results.map((r) => ({ name: r.display_name, delta: r.delta, eloBefore: r.elo_before, eloAfter: r.elo_after }));
  }

  const ledger = await db
    .prepare('SELECT season_id FROM bridge_game_ledger WHERE game_id = ?')
    .bind(gameId)
    .first<{ season_id: number | null }>()
    .catch(() => null);
  const season = ledger?.season_id ? seasonById(ledger.season_id) : undefined;
  if (!season || usesLegacyElo(season)) return [];
  const rows = await db
    .prepare(
      `SELECT u.display_name, e.rating_before, e.rating_after
       FROM bridge_rating_events e
       JOIN users u ON u.telegram_id = e.telegram_id
       WHERE e.system = ? AND e.game_id = ? AND e.applied = 1
       ORDER BY e.seat`,
    )
    .bind(season.ratingSystem, gameId)
    .all<{ display_name: string; rating_before: number; rating_after: number }>();
  return (rows.results ?? []).map((r) => {
    const eloBefore = Math.round(r.rating_before);
    const eloAfter = Math.round(r.rating_after);
    return { name: r.display_name, delta: eloAfter - eloBefore, eloBefore, eloAfter };
  });
}

/** A player's standing shown at their seat for the current season; null before their first rated hand. */
export async function getSeasonStanding(
  db: D1Database,
  season: BridgeSeason,
  telegramId: number,
): Promise<{ wins: number; gamesPlayed: number; elo: number } | null> {
  if (usesLegacyElo(season)) {
    const user = await getUser(db, telegramId);
    return user && user.games_played > 0 ? { wins: user.wins, gamesPlayed: user.games_played, elo: user.elo } : null;
  }
  const row = await db
    .prepare('SELECT rating, wins, games FROM bridge_ratings WHERE system = ? AND telegram_id = ?')
    .bind(season.ratingSystem, telegramId)
    .first<{ rating: number; wins: number; games: number }>();
  return row && row.games > 0 ? { wins: row.wins, gamesPlayed: row.games, elo: Math.round(row.rating) } : null;
}
