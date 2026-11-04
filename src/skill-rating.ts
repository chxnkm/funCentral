/**
 * Shadow Bridge skill rating ("skill-v1"). Pure: no Cloudflare or D1 dependencies.
 *
 * It keeps the legacy team-average Elo expectation as its baseline and changes
 * only what the rating plan agreed (docs/bridge-rating.md):
 * - ratings come from a snapshot taken at the start of the hand, and changes are
 *   added to the live rating, so concurrent games never alter each other's maths;
 * - each player's own confidence sets how far they move: K falls from 40 to 16
 *   over the first 24 games, so a provisional player moves more after a win or a
 *   loss and the formula never decides which partner caused the result;
 * - hands the 2-v-2 formula cannot judge fairly yet (practice, bots, mid-hand bot
 *   replacements, solo contracts, missing snapshots) keep their prediction but
 *   move nobody's rating.
 * Card strength is recorded separately and is deliberately not an input.
 */

export const SKILL_SYSTEM = 'skill-v1';
export const SKILL_START_RATING = 1000;
export const SKILL_PROVISIONAL_GAMES = 20;
const K_MAX = 40;
const K_MIN = 16;

export type SkillRole = 'bidder' | 'partner' | 'opposition';
export type SkillExclusion = 'practice' | 'bot' | 'replacement' | 'solo' | 'no-snapshot';

export function skillK(gamesBefore: number): number {
  return Math.max(K_MIN, K_MAX - gamesBefore);
}

export function isProvisional(games: number): boolean {
  return games < SKILL_PROVISIONAL_GAMES;
}

function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Expected score of team A against team B from each side's average rating (the legacy formula). */
export function teamExpectation(teamA: number[], teamB: number[]): number {
  return 1 / (1 + Math.pow(10, (average(teamB) - average(teamA)) / 400));
}

export function roleOf(seat: number, bidder: number, partner: number): SkillRole {
  if (seat === bidder) return 'bidder';
  if (seat === partner) return 'partner';
  return 'opposition';
}

export interface SkillSeat {
  seat: number;
  /** Effective human identity (the original player for a replacement bot); null for bots. */
  telegramId: number | null;
  /** Seated as a bot when the hand was dealt. */
  isBot: boolean;
  /** A bot played this seat for part of the hand. */
  replaced: boolean;
  /** Rating and games at the start of the hand; null when no snapshot was taken. */
  rating: number | null;
  games: number | null;
}

export interface SkillGame {
  bidder: number;
  partner: number;
  bidderWon: boolean;
  isPractice: boolean;
  seats: SkillSeat[];
  /**
   * Official seasons rate a hand a bot finished for a player who left, crediting
   * that player, so leaving cannot avoid a loss. The trial only records them.
   */
  replacementIsRated?: boolean;
}

export interface SkillPlayerResult {
  seat: number;
  telegramId: number;
  role: SkillRole;
  ratingBefore: number | null;
  gamesBefore: number | null;
  k: number | null;
  teamRating: number | null;
  oppRating: number | null;
  expected: number | null;
  score: 0 | 1;
  /** Proposed change; it is applied only when the game result is applied. */
  delta: number | null;
  ratingAfter: number | null;
}

export interface SkillGameResult {
  applied: boolean;
  reason: SkillExclusion | null;
  bidderExpected: number | null;
  players: SkillPlayerResult[];
}

export function exclusionFor(game: SkillGame): SkillExclusion | null {
  if (game.isPractice) return 'practice';
  if (game.seats.some((s) => s.isBot || s.telegramId === null)) return 'bot';
  if (!game.replacementIsRated && game.seats.some((s) => s.replaced)) return 'replacement';
  if (game.bidder === game.partner) return 'solo';
  if (game.seats.some((s) => s.rating === null || s.games === null)) return 'no-snapshot';
  return null;
}

export function evaluateSkillGame(game: SkillGame): SkillGameResult {
  const reason = exclusionFor(game);
  const bidderSide = game.bidder === game.partner ? [game.bidder] : [game.bidder, game.partner];
  // A prediction needs every seat's starting rating; excluded hands still get one when possible.
  const predictable = game.seats.every((s) => s.rating !== null);
  const sideRatings = (onBidderSide: boolean) =>
    game.seats.filter((s) => bidderSide.includes(s.seat) === onBidderSide).map((s) => s.rating as number);
  const bidderExpected = predictable ? teamExpectation(sideRatings(true), sideRatings(false)) : null;

  const players = game.seats.flatMap((s): SkillPlayerResult[] => {
    if (s.telegramId === null) return [];
    const onBidderSide = bidderSide.includes(s.seat);
    const score = onBidderSide === game.bidderWon ? 1 : 0;
    const expected = bidderExpected === null ? null : onBidderSide ? bidderExpected : 1 - bidderExpected;
    const k = s.games === null ? null : skillK(s.games);
    const delta = expected === null || k === null ? null : k * (score - expected);
    return [{
      seat: s.seat,
      telegramId: s.telegramId,
      role: roleOf(s.seat, game.bidder, game.partner),
      ratingBefore: s.rating,
      gamesBefore: s.games,
      k,
      teamRating: predictable ? average(sideRatings(onBidderSide)) : null,
      oppRating: predictable ? average(sideRatings(!onBidderSide)) : null,
      expected,
      score,
      delta,
      ratingAfter: s.rating === null ? null : s.rating + (reason === null && delta !== null ? delta : 0),
    }];
  });

  return { applied: reason === null, reason, bidderExpected, players };
}
