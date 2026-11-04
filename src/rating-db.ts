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
  type RatingSnapshot,
} from './bridge-completion';

/** True when a query failed because migration 0013 has not been applied yet. */
export function isMissingTableError(err: unknown): boolean {
  return /no such table/i.test(err instanceof Error ? err.message : String(err));
}

/**
 * Reads every seated human's legacy Elo and shadow skill rating when a hand is
 * dealt. Never throws: unavailable parts are null, and the shadow rating then
 * records the hand without applying it.
 */
export async function readRatingSnapshot(
  db: D1Database,
  gameId: string,
  seats: { telegramId: number | null }[],
  now = Date.now(),
): Promise<RatingSnapshot> {
  const ids = [...new Set(seats.map((s) => s.telegramId).filter((id): id is number => id !== null))];
  const placeholders = ids.map(() => '?').join(',');

  let legacy: Map<number, { elo: number; games_played: number }> | null = null;
  let skill: Map<number, { rating: number; games: number }> | null = null;
  let seasonId: number | null = null;
  if (ids.length > 0) {
    legacy = await db
      .prepare(`SELECT telegram_id, elo, games_played FROM users WHERE telegram_id IN (${placeholders})`)
      .bind(...ids)
      .all<{ telegram_id: number; elo: number; games_played: number }>()
      .then((r) => new Map((r.results ?? []).map((row) => [row.telegram_id, row])))
      .catch(() => null);
    skill = await db
      .prepare(`SELECT telegram_id, rating, games FROM bridge_ratings WHERE system = ? AND telegram_id IN (${placeholders})`)
      .bind(SKILL_SYSTEM, ...ids)
      .all<{ telegram_id: number; rating: number; games: number }>()
      .then((r) => new Map((r.results ?? []).map((row) => [row.telegram_id, row])))
      .catch(() => null);
  }
  seasonId = await db
    .prepare("SELECT season_id FROM bridge_seasons WHERE status = 'active' LIMIT 1")
    .first<{ season_id: number }>()
    .then((r) => r?.season_id ?? null)
    .catch(() => null);

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

/**
 * Records a hand for the rating trial, in one D1 transaction: starting-hand
 * features for every seat, the shadow skill-rating evaluation per human next to
 * their legacy Elo change, the shadow rating update when the hand qualifies, and
 * a ledger row. The ledger row is written last and guards the rating update, so
 * repeating this call is a no-op. Throws "no such table" until migration 0013.
 */
export async function persistShadow(db: D1Database, c: BridgeCompletion): Promise<void> {
  const playedAt = Math.floor(c.completedAt / 1000);
  const completed = c.kind === 'completed';
  const partnerKnown = c.bidder >= 0 && c.partner >= 0;
  const bidderSide = partnerKnown ? bidderSideSeats(c.bidder, c.partner) : [];
  const evaluation: SkillGameResult | null = completed
    ? evaluateSkillGame({
      bidder: c.bidder, partner: c.partner, bidderWon: c.bidderWon === true, isPractice: c.isPractice, seats: skillSeats(c),
    })
    : null;

  const legacyById = new Map((c.legacy ?? []).map((r) => [r.telegramId, r]));
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
        .bind(SKILL_SYSTEM, p.telegramId, SKILL_START_RATING + p.delta!, p.score, playedAt, c.gameId, p.delta!));
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
          SKILL_SYSTEM, c.gameId, p.telegramId, p.seat, p.role, evaluation.applied ? 1 : 0, evaluation.reason,
          p.ratingBefore, p.gamesBefore, p.k, p.teamRating, p.oppRating, p.expected, p.score, p.delta, p.ratingAfter,
          legacy?.eloBefore ?? null, legacy?.delta ?? null, playedAt,
        ));
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
       VALUES (?, COALESCE(?, (SELECT season_id FROM bridge_seasons WHERE status = 'active' LIMIT 1)),
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      c.gameId, c.ratingSnapshot?.seasonId ?? null, c.roomCode, c.groupId, c.kind,
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

  await db.batch(stmts);
}
