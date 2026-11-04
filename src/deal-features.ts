import type { BidSuit, Hand } from './types';
import { CARD_SUITS } from './types';

const HIGH_CARD_POINTS: Record<string, number> = { A: 4, K: 3, Q: 2, J: 1 };

export interface HandFeatures {
  hcp: number;
  /** hcp plus one point per card beyond four in a suit — the wash rule's count. */
  points: number;
  clubs: number;
  diamonds: number;
  hearts: number;
  spades: number;
  /** Suit lengths, longest first, e.g. "5-4-3-1". */
  shape: string;
  /** Cards held in the trump suit; null for no-trump or before a contract. */
  trumps: number | null;
}

/** Starting-hand strength. Recorded for insight and modelling, never as a rating input. */
export function handFeatures(hand: Hand, trumpSuit: BidSuit | null): HandFeatures {
  const lengths = CARD_SUITS.map((suit) => hand[suit].length);
  const hcp = CARD_SUITS.reduce(
    (sum, suit) => sum + hand[suit].reduce((n, value) => n + (HIGH_CARD_POINTS[value] ?? 0), 0),
    0,
  );
  return {
    hcp,
    points: hcp + lengths.reduce((n, length) => n + Math.max(0, length - 4), 0),
    clubs: lengths[0],
    diamonds: lengths[1],
    hearts: lengths[2],
    spades: lengths[3],
    shape: [...lengths].sort((a, b) => b - a).join('-'),
    trumps: trumpSuit && trumpSuit !== '🚫' ? hand[trumpSuit].length : null,
  };
}
