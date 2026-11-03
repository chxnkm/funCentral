// Connect 4 rating: standard two-player Elo, separate from Bridge's ELO,
// Regicide's rating and Tai Di's rating — stored in connect4_ratings.

export const START_RATING = 1000;

export interface RatedPlayer {
  telegramId: number;
  rating: number;
  gamesPlayed: number;
}

export interface PlacedPlayer extends RatedPlayer {
  /** 1 = win, 2 = loss; on a draw both players carry place 1 (a 0.5 result). */
  place: number;
}

/** Elo expectation of a player rated `own` against one rated `other`. */
export function expectedScore(own: number, other: number): number {
  return 1 / (1 + Math.pow(10, (other - own) / 400));
}

/**
 * Rating change per player for a finished two-player game. Each player's delta
 * is their own K (32 for the first 30 games, then 16, as in elo.ts) times the
 * difference between their score (1 win / 0.5 draw / 0 loss) and expectation.
 */
export function computeConnect4Deltas(players: PlacedPlayer[]): Map<number, number> {
  const deltas = new Map<number, number>();
  if (players.length !== 2) return deltas;
  for (const me of players) {
    const other = players.find((p) => p !== me)!;
    const score = me.place < other.place ? 1 : me.place === other.place ? 0.5 : 0;
    const k = me.gamesPlayed < 30 ? 32 : 16;
    deltas.set(me.telegramId, Math.round(k * (score - expectedScore(me.rating, other.rating))));
  }
  return deltas;
}
