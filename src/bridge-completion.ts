import type { BidHistoryEntry, BidSuit, GameState, Hand, TrickLogEntry } from './types';
import { getBidFromNum } from './bridge';
import { escapeHtml } from './telegram';

/** Ratings read when a hand is dealt, so the hand is judged on its starting ratings. */
export interface RatingSnapshotSeat {
  /** Human at the seat when dealt; null for bots. */
  telegramId: number | null;
  /** Legacy Elo (users.elo / games_played); null when unavailable. */
  elo: number | null;
  gamesPlayed: number | null;
  /** Shadow skill rating; null when the rating tables are unavailable. */
  rating: number | null;
  ratingGames: number | null;
}

export interface RatingSnapshot {
  gameId: string;
  capturedAt: number;
  seasonId: number | null;
  seats: RatingSnapshotSeat[];
}

export interface CompletionPlayer {
  seat: number;
  id: string;
  originalPlayerId?: string;
  name: string;
  isBot: boolean;
  isGroupMember?: boolean;
  /** A bot held this seat when the hand was dealt (including a bot still covering an absent human). */
  dealtAsBot: boolean;
  /** A bot played this seat for some or all of the hand after its human left. */
  replaced: boolean;
}

export interface LegacyEloRow {
  telegramId: number;
  eloBefore: number;
  eloAfter: number;
  delta: number;
}

/**
 * Durable record of a finished (or abandoned) hand, saved in room storage with
 * the final state before any D1 or Telegram I/O. Each step is retried until it
 * succeeds; every D1 step is idempotent, so a retry never double-counts.
 */
export interface BridgeCompletion {
  gameId: string;
  roomCode: string;
  groupId: string | null;
  kind: 'completed' | 'abandoned';
  completedAt: number;
  isPractice: boolean;
  players: CompletionPlayer[];
  bidder: number;
  partner: number;
  bid: number;
  trumpSuit: BidSuit | null;
  partnerCard: string | null;
  setsNeeded: number;
  sets: number[];
  /** null when the hand was abandoned. */
  bidderWon: boolean | null;
  bidHistory: BidHistoryEntry[];
  initialHands: Hand[];
  finalHands: Hand[];
  trickLog: TrickLogEntry[];
  redealCount: number;
  ratingSnapshot: RatingSnapshot | null;
  /** true = done or not applicable for this hand. */
  steps: { rated: boolean; notify: boolean; log: boolean; betting: boolean; shadow: boolean };
  /** Legacy Elo changes for this hand, filled in by the rated step. */
  legacy: LegacyEloRow[] | null;
  attempts: number;
  shadowAttempts: number;
  nextAttemptAt: number;
}

export type CompletionOutcome = { kind: 'completed'; bidderWon: boolean } | { kind: 'abandoned' };

/** The human a seat belongs to: the original player for a replacement bot. */
export function effectiveTelegramId(player: { id: string; originalPlayerId?: string }): number | null {
  const id = player.originalPlayerId || player.id;
  return id.startsWith('tg_') ? Number(id.slice(3)) : null;
}

/**
 * The human who receives this seat's rated result. Only a human seated when the hand
 * was dealt is rated, even if a bot finished it for them; a seat dealt to a bot
 * (such as one still covering a player who left an earlier hand) rates nobody.
 */
export function ratedTelegramId(player: CompletionPlayer): number | null {
  return player.dealtAsBot ? null : effectiveTelegramId(player);
}

export function bidderSideSeats(bidder: number, partner: number): number[] {
  return bidder === partner ? [bidder] : [bidder, partner];
}

export function bidderTricks(c: Pick<BridgeCompletion, 'bidder' | 'partner' | 'sets'>): number {
  return bidderSideSeats(c.bidder, c.partner).reduce((sum, seat) => sum + (c.sets[seat] ?? 0), 0);
}

export function buildCompletion(
  state: GameState,
  outcome: CompletionOutcome,
  snapshot: RatingSnapshot | null,
  now = Date.now(),
): BridgeCompletion {
  const completed = outcome.kind === 'completed';
  const replacedSeats = state.replacedSeats ?? [];
  // Rooms dealt before dealtBotSeats existed: a bot without an original human was dealt as a bot.
  const dealtAsBot = (p: GameState['players'][number]) =>
    state.dealtBotSeats ? state.dealtBotSeats.includes(p.seat) : !!p.isBot && !p.originalPlayerId;
  return {
    gameId: state.gameId,
    roomCode: state.roomCode,
    groupId: state.groupId,
    kind: outcome.kind,
    completedAt: now,
    isPractice: state.isPractice,
    players: [...state.players].sort((a, b) => a.seat - b.seat).map((p) => ({
      seat: p.seat,
      id: p.id,
      originalPlayerId: p.originalPlayerId,
      name: p.name,
      isBot: !!p.isBot,
      isGroupMember: p.isGroupMember,
      dealtAsBot: dealtAsBot(p),
      replaced: !!p.originalPlayerId || replacedSeats.includes(p.seat),
    })),
    bidder: state.bidder,
    partner: state.partner,
    bid: state.bid,
    trumpSuit: state.trumpSuit,
    partnerCard: state.partnerCard,
    setsNeeded: state.setsNeeded,
    sets: [...state.sets],
    bidderWon: completed ? outcome.bidderWon : null,
    bidHistory: structuredClone(state.bidHistory),
    initialHands: structuredClone(state.initialHands),
    finalHands: structuredClone(state.hands),
    trickLog: structuredClone(state.trickLog),
    redealCount: state.redealCount ?? 0,
    ratingSnapshot: snapshot && snapshot.gameId === state.gameId ? snapshot : null,
    // Abandoned hands only feed the shadow ledger; practice hands skip ratings.
    steps: { rated: !completed || state.isPractice, notify: !completed, log: !completed, betting: !completed, shadow: false },
    legacy: null,
    attempts: 0,
    shadowAttempts: 0,
    nextAttemptAt: 0,
  };
}

export function completionDone(c: BridgeCompletion): boolean {
  return Object.values(c.steps).every(Boolean);
}

/** Group result message, as previously posted from the room. Names are HTML-escaped. */
export function completionMessage(c: BridgeCompletion): string {
  const bidStr = getBidFromNum(c.bid);
  const name = (seat: number) => escapeHtml(c.players[seat]?.name ?? `Seat ${seat + 1}`);
  const bidderSide = bidderSideSeats(c.bidder, c.partner);
  const defenders = [0, 1, 2, 3].filter((s) => !bidderSide.includes(s));
  const suffix = c.isPractice ? '\n(practice — unrated)' : legacyEloLines(c, [...bidderSide, ...defenders], name);
  return c.bidderWon
    ? `🏆 ${bidderSide.map(name).join(' & ')} won!\nBid ${bidStr}, made ${bidderTricks(c)}/${c.setsNeeded} tricks${suffix}`
    : `🛡️ ${defenders.map(name).join(' & ')} defended!\n${name(c.bidder)}'s ${bidStr} bid failed${suffix}`;
}

function legacyEloLines(c: BridgeCompletion, seatOrder: number[], name: (seat: number) => string): string {
  const lines = seatOrder.flatMap((seat) => {
    const telegramId = c.players[seat] ? ratedTelegramId(c.players[seat]) : null;
    const row = c.legacy?.find((r) => r.telegramId === telegramId);
    return row ? [`  ${name(seat)}: ${row.delta >= 0 ? '+' : ''}${row.delta} → ${row.eloAfter}`] : [];
  });
  return lines.length > 0 ? '\n' + lines.join('\n') : '';
}
