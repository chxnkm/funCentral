import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { handFeatures } from './deal-features';
import {
  SKILL_START_RATING,
  SKILL_SYSTEM,
  evaluateSkillGame,
  roleOf,
  teamExpectation,
  type SkillGameResult,
  type SkillSeat,
} from './skill-rating';
import {
  bidderSideSeats,
  bidderTricks,
  ratedTelegramId,
  type BridgeCompletion,
  type LegacyEloRow,
  type RatingSnapshot,
} from './bridge-completion';
import { gameRecordRows, gameRecordsStatement } from './stats-db';
import { getWinnerSeats } from './stats';

/** True when a query failed because migration 0013 has not been applied yet. */
export function isMissingTableError(err: unknown): boolean {
  return /no such table/i.test(err instanceof Error ? err.message : String(err));
}

/**
 * Reads every seated human's legacy Elo and skill rating (from `system`) when a
 * hand is dealt. Never throws: unavailable parts are null, and the hand is then
 * recorded without applying a rating (or rated at completion, in a season).
 */
export async function readRatingSnapshot(
  db: D1Database,
  gameId: string,
  seats: { telegramId: number | null }[],
  { system, seasonId }: { system: string; seasonId: number },
  now = Date.now(),
): Promise<RatingSnapshot> {
  const ids = [...new Set(seats.map((s) => s.telegramId).filter((id): id is number => id !== null))];
  const placeholders = ids.map(() => '?').join(',');

  let legacy: Map<number, { elo: number; games_played: number }> | null = null;
  let skill: Map<number, { rating: number; games: number }> | null = null;
  if (ids.length > 0) {
    legacy = await db
      .prepare(`SELECT telegram_id, elo, games_played FROM users WHERE telegram_id IN (${placeholders})`)
      .bind(...ids)
      .all<{ telegram_id: number; elo: number; games_played: number }>()
      .then((r) => new Map((r.results ?? []).map((row) => [row.telegram_id, row])))
      .catch(() => null);
    skill = await db
      .prepare(`SELECT telegram_id, rating, games FROM bridge_ratings WHERE system = ? AND telegram_id IN (${placeholders})`)
      .bind(system, ...ids)
      .all<{ telegram_id: number; rating: number; games: number }>()
      .then((r) => new Map((r.results ?? []).map((row) => [row.telegram_id, row])))
      .catch(() => null);
  }

  return {
    gameId,
    capturedAt: now,
    seasonId,
    seats: seats.map(({ telegramId }) => {
      if (telegramId === null) return { telegramId, elo: null, gamesPlayed: null, rating: null, ratingGames: null };
      const user = legacy?.get(telegramId);
      const rated = skill?.get(telegramId);
      return {
        telegramId,
        elo: user?.elo ?? null,
        gamesPlayed: user?.games_played ?? null,
        rating: skill ? (rated?.rating ?? SKILL_START_RATING) : null,
        ratingGames: skill ? (rated?.games ?? 0) : null,
      };
    }),
  };
}

function skillSeats(c: BridgeCompletion): SkillSeat[] {
  return c.players.map((p) => {
    const telegramId = ratedTelegramId(p);
    const snap = c.ratingSnapshot?.seats[p.seat];
    // The snapshot only counts if the same human held the seat when the hand was dealt.
    const known = !!snap && snap.telegramId === telegramId;
    return {
      seat: p.seat,
      telegramId,
      isBot: p.dealtAsBot,
      replaced: p.replaced,
      rating: known ? snap.rating : null,
      games: known ? snap.ratingGames : null,
    };
  });
}

function evaluate(c: BridgeCompletion, official: boolean): SkillGameResult | null {
  if (c.kind !== 'completed') return null;
  return evaluateSkillGame({
    bidder: c.bidder,
    partner: c.partner,
    bidderWon: c.bidderWon === true,
    isPractice: c.isPractice,
    seats: skillSeats(c),
    replacementIsRated: official,
  });
}

/**
 * One transaction's statements for a hand's skill rating: the rating update when
 * the hand qualifies, a rating event per human, and in an official season the
 * hand's game_records rows and group statistics; then starting-hand features and
 * a ledger row. The ledger row is written last and guards every write before it,
 * so repeating the transaction is a no-op.
 */
function skillRatingStatements(
  db: D1Database,
  c: BridgeCompletion,
  evaluation: SkillGameResult | null,
  { system, official }: { system: string; official: boolean },
): D1PreparedStatement[] {
  const playedAt = Math.floor(c.completedAt / 1000);
  const completed = c.kind === 'completed';
  const partnerKnown = c.bidder >= 0 && c.partner >= 0;
  const bidderSide = partnerKnown ? bidderSideSeats(c.bidder, c.partner) : [];

  // The trial compares itself with the legacy Elo change on the same hand.
  const legacyById = new Map((official ? [] : c.legacy ?? []).map((r) => [r.telegramId, r]));
  const legacyBefore = (onBidderSide: boolean) => c.players
    .filter((p) => bidderSide.includes(p.seat) === onBidderSide)
    .map((p) => legacyById.get(ratedTelegramId(p) ?? NaN)?.eloBefore)
    .filter((elo): elo is number => elo !== undefined);
  const legacyExpected = completed && legacyBefore(true).length > 0 && legacyBefore(false).length > 0
    ? teamExpectation(legacyBefore(true), legacyBefore(false))
    : null;

  const NOT_LEDGERED = 'NOT EXISTS (SELECT 1 FROM bridge_game_ledger WHERE game_id = ?)';
  const stmts: D1PreparedStatement[] = [];

  if (evaluation?.applied) {
    for (const p of evaluation.players) {
      stmts.push(db
        .prepare(
          `INSERT INTO bridge_ratings (system, telegram_id, rating, games, wins, updated_at)
           SELECT ?, ?, ?, 1, ?, ? WHERE ${NOT_LEDGERED}
           ON CONFLICT(system, telegram_id) DO UPDATE SET
             rating = rating + ?,
             games = games + 1,
             wins = wins + excluded.wins,
             updated_at = excluded.updated_at`,
        )
        .bind(system, p.telegramId, SKILL_START_RATING + p.delta!, p.score, playedAt, c.gameId, p.delta!));
    }
  }

  // Practice hands keep their ledger and deal features only.
  if (evaluation && !c.isPractice) {
    for (const p of evaluation.players) {
      const legacy = legacyById.get(p.telegramId);
      stmts.push(db
        .prepare(
          `INSERT OR IGNORE INTO bridge_rating_events
             (system, game_id, telegram_id, seat, role, applied, reason, rating_before, games_before, k,
              team_rating, opp_rating, expected, score, delta, rating_after, legacy_before, legacy_delta, played_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          system, c.gameId, p.telegramId, p.seat, p.role, evaluation.applied ? 1 : 0, evaluation.reason,
          p.ratingBefore, p.gamesBefore, p.k, p.teamRating, p.oppRating, p.expected, p.score, p.delta, p.ratingAfter,
          legacy?.eloBefore ?? null, legacy?.delta ?? null, playedAt,
        ));
    }
  }

  // In a season, rated hands also feed the stats screen and the group boards.
  if (official && evaluation?.applied) {
    const winnerSeats = getWinnerSeats(c.bidder, c.partner, c.bidderWon === true);
    const rows = gameRecordRows(c.players.map((p) => ({ seat: p.seat, telegramId: ratedTelegramId(p) })), c.bidder, c.partner, c.sets, winnerSeats);
    if (rows.length > 0) stmts.push(gameRecordsStatement(db, c, rows, NOT_LEDGERED));
    if (c.groupId) {
      for (const p of c.players) {
        const telegramId = ratedTelegramId(p);
        if (telegramId === null || !p.isGroupMember) continue;
        stmts.push(db
          .prepare(
            `INSERT INTO bridge_season_group_stats (season_id, group_id, telegram_id, wins, games_played)
             SELECT ?, ?, ?, ?, 1 WHERE ${NOT_LEDGERED}
             ON CONFLICT(season_id, group_id, telegram_id) DO UPDATE SET
               games_played = games_played + 1,
               wins = wins + excluded.wins`,
          )
          .bind(c.seasonId, c.groupId, telegramId, winnerSeats.includes(p.seat) ? 1 : 0, c.gameId));
      }
    }
  }

  // Before the partner is called, trumpSuit is only the current high bid.
  const contractTrump = partnerKnown ? c.trumpSuit : null;
  const features = c.players.map((p) => ({ p, f: handFeatures(c.initialHands[p.seat], contractTrump) }));
  for (const { p, f } of features) {
    const onBidderSide = bidderSide.includes(p.seat);
    stmts.push(db
      .prepare(
        `INSERT OR IGNORE INTO bridge_deal_features
           (game_id, seat, telegram_id, is_bot, role, hcp, points, clubs, diamonds, hearts, spades, shape, trumps, won)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        c.gameId, p.seat, ratedTelegramId(p), p.dealtAsBot ? 1 : 0,
        partnerKnown ? roleOf(p.seat, c.bidder, c.partner) : null,
        f.hcp, f.points, f.clubs, f.diamonds, f.hearts, f.spades, f.shape, f.trumps,
        completed ? (onBidderSide === c.bidderWon ? 1 : 0) : null,
      ));
  }

  const sideFeatures = features.filter(({ p }) => bidderSide.includes(p.seat)).map(({ f }) => f);
  const reason = evaluation ? evaluation.reason : 'abandoned';
  stmts.push(db
    .prepare(
      `INSERT OR IGNORE INTO bridge_game_ledger
         (game_id, season_id, room_code, group_id, status, is_practice, has_bot, has_replacement, is_solo,
          redeal_count, bidder_seat, partner_seat, bid_num, trump_suit, bidder_won, bidder_tricks, tricks_played,
          sets_needed, bidder_side_hcp, bidder_side_trumps, legacy_expected, skill_expected, skill_applied,
          skill_reason, dealt_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      // Completions saved before seasons were assigned at deal carry the snapshot's season.
      c.gameId, c.seasonId ?? c.ratingSnapshot?.seasonId ?? 1, c.roomCode, c.groupId, c.kind,
      c.isPractice ? 1 : 0,
      c.players.some((p) => p.dealtAsBot) ? 1 : 0,
      c.players.some((p) => p.replaced) ? 1 : 0,
      partnerKnown ? (c.bidder === c.partner ? 1 : 0) : null,
      c.redealCount,
      c.bidder >= 0 ? c.bidder : null,
      c.partner >= 0 ? c.partner : null,
      c.bid >= 0 ? c.bid : null,
      c.trumpSuit,
      completed ? (c.bidderWon ? 1 : 0) : null,
      partnerKnown ? bidderTricks(c) : null,
      c.sets.reduce((sum, n) => sum + n, 0),
      c.setsNeeded >= 0 ? c.setsNeeded : null,
      partnerKnown ? sideFeatures.reduce((sum, f) => sum + f.hcp, 0) : null,
      partnerKnown && c.trumpSuit && c.trumpSuit !== '🚫' ? sideFeatures.reduce((sum, f) => sum + (f.trumps ?? 0), 0) : null,
      legacyExpected,
      evaluation?.bidderExpected ?? null,
      evaluation?.applied ? 1 : 0,
      reason,
      c.ratingSnapshot ? Math.floor(c.ratingSnapshot.capturedAt / 1000) : null,
      playedAt,
    ));

  return stmts;
}

/**
 * Records a Season 1 hand for the rating trial in one D1 transaction: deal
 * features, the shadow skill-rating evaluation per human next to their legacy
 * Elo change, the shadow rating update when the hand qualifies, and a ledger
 * row. Repeating it is a no-op. Throws "no such table" until migration 0013.
 */
export async function persistShadow(db: D1Database, c: BridgeCompletion): Promise<void> {
  await db.batch(skillRatingStatements(db, c, evaluate(c, false), { system: SKILL_SYSTEM, official: false }));
}

/**
 * Rates a hand dealt in a skill-rated season (Season 2 on) in one D1
 * transaction: the season rating, rating events, game_records, season group
 * statistics, deal features and the ledger. A player who left mid-hand still
 * takes the result. If no starting ratings were captured at the deal, the
 * current ratings are read now (and kept on the completion for retries); a hand
 * is never left unrated because a read failed, so that throws and is retried.
 * Returns the season rating changes as stored, rounded as shown to players.
 */
export async function persistSeasonResult(db: D1Database, c: BridgeCompletion, system: string): Promise<LegacyEloRow[]> {
  if (c.kind === 'completed' && !c.isPractice && !c.ratingSnapshot) {
    c.ratingSnapshot = await readRatingSnapshot(
      db, c.gameId, c.players.map((p) => ({ telegramId: ratedTelegramId(p) })), { system, seasonId: c.seasonId },
    );
  }
  const evaluation = evaluate(c, true);
  if (evaluation?.reason === 'no-snapshot') throw new Error(`Season ratings unavailable for hand ${c.gameId}`);
  await db.batch(skillRatingStatements(db, c, evaluation, { system, official: true }));

  const stored = await db
    .prepare('SELECT telegram_id, rating_before, rating_after FROM bridge_rating_events WHERE system = ? AND game_id = ? AND applied = 1 ORDER BY seat')
    .bind(system, c.gameId)
    .all<{ telegram_id: number; rating_before: number; rating_after: number }>();
  return (stored.results ?? []).map((r) => {
    const eloBefore = Math.round(r.rating_before);
    const eloAfter = Math.round(r.rating_after);
    return { telegramId: r.telegram_id, eloBefore, eloAfter, delta: eloAfter - eloBefore };
  });
}
