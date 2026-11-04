import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { BID_SUITS } from './types';
import { computeEloDeltas } from './elo';
import type { EloPlayer } from './elo';
import { getWinnerSeats } from './stats';
import { ratedTelegramId, type BridgeCompletion, type LegacyEloRow } from './bridge-completion';

export interface PlayerStatRow {
  telegramId: number;
  displayName: string;
  elo: number;
  games: number;
  wins: number;
  winPct: number;
  bidder: { games: number; wins: number; winPct: number };
  partner: { games: number; wins: number; winPct: number };
  opposition: { games: number; wins: number; winPct: number };
  favBidSuit: string | null;
}

export interface PairStatRow {
  player1: string;
  player2: string;
  games: number;
  wins: number;
  winPct: number;
}

/** One game_records row (legacy stats), for an authenticated player. */
export interface GameRecordRow {
  telegramId: number;
  seat: number;
  role: 'bidder' | 'partner' | 'opposition';
  won: 0 | 1;
  tricksWon: number;
  partnerTelegramId: number | null;
}

/**
 * Builds one game_records row per rated player (telegramId null = guest or bot, skipped).
 * A seat a bot took over mid-hand still counts for its original human.
 */
export function gameRecordRows(
  players: { seat: number; telegramId: number | null }[],
  bidderSeat: number,
  partnerSeat: number,
  sets: number[],
  winnerSeats: number[],
): GameRecordRow[] {
  const isSoloBidder = bidderSeat === partnerSeat;
  const bidderTeam = isSoloBidder ? [bidderSeat] : [bidderSeat, partnerSeat];
  const oppTeam = [0, 1, 2, 3].filter((s) => !bidderTeam.includes(s));

  const bidderTricksWon = bidderTeam.reduce((sum, s) => sum + (sets[s] ?? 0), 0);
  const oppTricksWon = oppTeam.reduce((sum, s) => sum + (sets[s] ?? 0), 0);

  // seat → telegram_id lookup (null for guests and bots)
  const seatToTgId: Record<number, number | null> = {};
  for (const p of players) seatToTgId[p.seat] = p.telegramId;

  return players.flatMap((player): GameRecordRow[] => {
    const { seat, telegramId } = player;
    if (telegramId === null) return [];
    let role: GameRecordRow['role'];
    let partnerTelegramId: number | null = null;

    if (seat === bidderSeat) {
      role = 'bidder';
      partnerTelegramId = isSoloBidder ? null : (seatToTgId[partnerSeat] ?? null);
    } else if (!isSoloBidder && seat === partnerSeat) {
      role = 'partner';
      partnerTelegramId = seatToTgId[bidderSeat] ?? null;
    } else {
      role = 'opposition';
      if (!isSoloBidder) {
        const oppPartnerSeat = oppTeam.find((s) => s !== seat) ?? null;
        partnerTelegramId = oppPartnerSeat !== null ? (seatToTgId[oppPartnerSeat] ?? null) : null;
      }
      // isSoloBidder: no natural pairs, leave partnerTelegramId as null
    }

    return [{
      telegramId,
      seat,
      role,
      won: winnerSeats.includes(seat) ? 1 : 0,
      tricksWon: bidderTeam.includes(seat) ? bidderTricksWon : oppTricksWon,
      partnerTelegramId,
    }];
  });
}

function pct(wins: number, games: number): number {
  return games === 0 ? 0 : Math.round((wins / games) * 1000) / 10;
}

export async function getPlayerStats(db: D1Database, groupId?: string): Promise<PlayerStatRow[]> {
  const where = groupId ? 'WHERE gr.group_id = ?' : '';
  const bindings: string[] = groupId ? [groupId] : [];

  const main = await db
    .prepare(
      `SELECT
         u.telegram_id, u.display_name, u.elo,
         COUNT(*) as games,
         SUM(gr.won) as wins,
         ROUND(100.0 * SUM(gr.won) / COUNT(*), 1) as win_pct,
         SUM(CASE WHEN gr.role = 'bidder' THEN 1 ELSE 0 END) as bidder_games,
         SUM(CASE WHEN gr.role = 'bidder' AND gr.won = 1 THEN 1 ELSE 0 END) as bidder_wins,
         SUM(CASE WHEN gr.role = 'partner' THEN 1 ELSE 0 END) as partner_games,
         SUM(CASE WHEN gr.role = 'partner' AND gr.won = 1 THEN 1 ELSE 0 END) as partner_wins,
         SUM(CASE WHEN gr.role = 'opposition' THEN 1 ELSE 0 END) as opp_games,
         SUM(CASE WHEN gr.role = 'opposition' AND gr.won = 1 THEN 1 ELSE 0 END) as opp_wins
       FROM game_records gr
       JOIN users u ON u.telegram_id = gr.telegram_id
       ${where}
       GROUP BY gr.telegram_id
       ORDER BY win_pct DESC`,
    )
    .bind(...bindings)
    .all<{
      telegram_id: number; display_name: string; elo: number;
      games: number; wins: number; win_pct: number;
      bidder_games: number; bidder_wins: number;
      partner_games: number; partner_wins: number;
      opp_games: number; opp_wins: number;
    }>();

  const suitWhere = groupId ? "WHERE role = 'bidder' AND group_id = ?" : "WHERE role = 'bidder'";
  const suits = await db
    .prepare(
      `SELECT telegram_id, bid_suit
       FROM (
         SELECT telegram_id, bid_suit,
                ROW_NUMBER() OVER (PARTITION BY telegram_id ORDER BY COUNT(*) DESC) as rn
         FROM game_records
         ${suitWhere}
         GROUP BY telegram_id, bid_suit
       )
       WHERE rn = 1`,
    )
    .bind(...bindings)
    .all<{ telegram_id: number; bid_suit: string }>();

  const favSuit = new Map((suits.results ?? []).map((r) => [r.telegram_id, r.bid_suit]));

  return (main.results ?? []).map((r) => ({
    telegramId: r.telegram_id,
    displayName: r.display_name,
    elo: r.elo,
    games: r.games,
    wins: r.wins,
    winPct: r.win_pct,
    bidder: { games: r.bidder_games, wins: r.bidder_wins, winPct: pct(r.bidder_wins, r.bidder_games) },
    partner: { games: r.partner_games, wins: r.partner_wins, winPct: pct(r.partner_wins, r.partner_games) },
    opposition: { games: r.opp_games, wins: r.opp_wins, winPct: pct(r.opp_wins, r.opp_games) },
    favBidSuit: favSuit.get(r.telegram_id) ?? null,
  }));
}

export async function getPairStats(db: D1Database, groupId?: string): Promise<PairStatRow[]> {
  const where = groupId ? 'WHERE gr1.group_id = ? AND gr2.group_id = ?' : '';
  const bindings: string[] = groupId ? [groupId, groupId] : [];

  const rows = await db
    .prepare(
      `SELECT
         u1.display_name as player1,
         u2.display_name as player2,
         COUNT(*) as games,
         SUM(CASE WHEN gr1.won = 1 THEN 1 ELSE 0 END) as wins,
         ROUND(100.0 * SUM(CASE WHEN gr1.won = 1 THEN 1 ELSE 0 END) / COUNT(*), 1) as win_pct
       FROM game_records gr1
       JOIN game_records gr2
         ON gr1.game_id = gr2.game_id
        AND gr1.telegram_id < gr2.telegram_id
        AND gr1.won = gr2.won
       JOIN users u1 ON u1.telegram_id = gr1.telegram_id
       JOIN users u2 ON u2.telegram_id = gr2.telegram_id
       ${where}
       GROUP BY gr1.telegram_id, gr2.telegram_id
       HAVING COUNT(*) >= 2
       ORDER BY win_pct DESC`,
    )
    .bind(...bindings)
    .all<{ player1: string; player2: string; games: number; wins: number; win_pct: number }>();

  return (rows.results ?? []).map((r) => ({
    player1: r.player1,
    player2: r.player2,
    games: r.games,
    wins: r.wins,
    winPct: r.win_pct,
  }));
}

// Every rated write for a hand is skipped once its game_records rows exist. Those rows are
// inserted last in the same transaction, so a retried or duplicated completion is a no-op.
const NOT_RECORDED = 'NOT EXISTS (SELECT 1 FROM game_records WHERE game_id = ?)';

/**
 * Records a rated hand's legacy stats in one D1 transaction: users wins/games_played,
 * group_stats, pair Elo (users.elo + elo_history) and game_records. Formula and
 * eligibility are unchanged from the previous per-table writers; Elo is added to the
 * stored value instead of overwriting it, so concurrent games cannot lose updates.
 * Returns the hand's Elo changes as stored, whether this call or an earlier one applied them.
 */
export async function persistRatedResult(
  db: D1Database,
  c: BridgeCompletion,
): Promise<{ applied: boolean; elo: LegacyEloRow[] }> {
  const winnerSeats = getWinnerSeats(c.bidder, c.partner, c.bidderWon === true);
  const rows = gameRecordRows(
    c.players.map((p) => ({ seat: p.seat, telegramId: ratedTelegramId(p) })),
    c.bidder, c.partner, c.sets, winnerSeats,
  );
  const playedAt = Math.floor(c.completedAt / 1000);
  const stmts: D1PreparedStatement[] = [];

  for (const row of rows) {
    stmts.push(db
      .prepare(`UPDATE users SET games_played = games_played + 1, wins = wins + ? WHERE telegram_id = ? AND ${NOT_RECORDED}`)
      .bind(row.won, row.telegramId, c.gameId));
  }

  if (c.groupId) {
    // Verified group members only; a bot-replaced seat is not counted for the group.
    for (const p of c.players) {
      if (p.dealtAsBot || !p.id.startsWith('tg_') || !p.isGroupMember) continue;
      stmts.push(db
        .prepare(
          `INSERT INTO group_stats (group_id, telegram_id, wins, games_played)
           SELECT ?, ?, ?, 1 WHERE ${NOT_RECORDED} AND EXISTS (SELECT 1 FROM groups WHERE group_id = ?)
           ON CONFLICT(group_id, telegram_id) DO UPDATE SET
             games_played = games_played + 1,
             wins = wins + excluded.wins`,
        )
        .bind(c.groupId, Number(p.id.slice(3)), winnerSeats.includes(p.seat) ? 1 : 0, c.gameId, c.groupId));
    }
  }

  for (const change of await legacyEloChanges(db, c, rows, winnerSeats)) {
    stmts.push(
      db.prepare(`UPDATE users SET elo = elo + ? WHERE telegram_id = ? AND ${NOT_RECORDED}`)
        .bind(change.delta, change.telegramId, c.gameId),
      db.prepare(
        `INSERT INTO elo_history (game_id, telegram_id, elo_before, elo_after, delta, played_at)
         SELECT ?, ?, ?, ?, ?, ? WHERE ${NOT_RECORDED}`,
      ).bind(c.gameId, change.telegramId, change.eloBefore, change.eloAfter, change.delta, playedAt, c.gameId),
    );
  }

  if (rows.length > 0) {
    const bidLevel = Math.floor(c.bid / 5) + 1;
    const bidSuit = BID_SUITS[c.bid % 5];
    stmts.push(db
      .prepare(
        `INSERT INTO game_records
           (game_id, group_id, played_at, telegram_id, role, won, bid_level, bid_suit, tricks_won, partner_telegram_id)
         SELECT v.column1, v.column2, v.column3, v.column4, v.column5, v.column6, v.column7, v.column8, v.column9, v.column10
         FROM (VALUES ${rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}) AS v
         WHERE ${NOT_RECORDED} AND EXISTS (SELECT 1 FROM users u WHERE u.telegram_id = v.column4)`,
      )
      .bind(
        ...rows.flatMap((r) => [c.gameId, c.groupId, playedAt, r.telegramId, r.role, r.won, bidLevel, bidSuit, r.tricksWon, r.partnerTelegramId]),
        c.gameId,
      ));
  }

  if (stmts.length === 0) return { applied: false, elo: [] };
  const results = await db.batch(stmts);
  const applied = rows.length > 0 && (results[results.length - 1].meta?.changes ?? 0) > 0;

  const stored = await db
    .prepare('SELECT telegram_id, elo_before, elo_after, delta FROM elo_history WHERE game_id = ? ORDER BY id')
    .bind(c.gameId)
    .all<{ telegram_id: number; elo_before: number; elo_after: number; delta: number }>();
  return {
    applied,
    elo: (stored.results ?? []).map((r) => ({ telegramId: r.telegram_id, eloBefore: r.elo_before, eloAfter: r.elo_after, delta: r.delta })),
  };
}

/** Pair Elo exactly as before: needs two or more authenticated players, and a users row on each side. */
async function legacyEloChanges(
  db: D1Database,
  c: BridgeCompletion,
  rows: GameRecordRow[],
  winnerSeats: number[],
): Promise<LegacyEloRow[]> {
  if (rows.length < 2) return [];
  const userRows = await db
    .prepare(`SELECT telegram_id, elo, games_played FROM users WHERE telegram_id IN (${rows.map(() => '?').join(',')})`)
    .bind(...rows.map((r) => r.telegramId))
    .all<{ telegram_id: number; elo: number; games_played: number }>();
  const userMap = new Map((userRows.results ?? []).map((r) => [r.telegram_id, r]));

  const seatToPlayer = new Map<number, EloPlayer>();
  for (const row of rows) {
    const user = userMap.get(row.telegramId);
    // games_played + 1: the K-factor used to be chosen after this hand had already been counted.
    if (user) seatToPlayer.set(row.seat, { telegramId: row.telegramId, elo: user.elo, gamesPlayed: user.games_played + 1 });
  }

  const bidderTeamSeats = c.bidder === c.partner ? [c.bidder] : [c.bidder, c.partner];
  const oppTeamSeats = [0, 1, 2, 3].filter((s) => !bidderTeamSeats.includes(s));
  const teamA = bidderTeamSeats.map((s) => seatToPlayer.get(s)).filter(Boolean) as EloPlayer[];
  const teamB = oppTeamSeats.map((s) => seatToPlayer.get(s)).filter(Boolean) as EloPlayer[];
  if (teamA.length === 0 || teamB.length === 0) return [];

  const deltas = computeEloDeltas(teamA, teamB, winnerSeats.includes(c.bidder));
  return [...teamA, ...teamB].map((p) => {
    const delta = deltas.get(p.telegramId) ?? 0;
    return { telegramId: p.telegramId, eloBefore: p.elo, eloAfter: p.elo + delta, delta };
  });
}
