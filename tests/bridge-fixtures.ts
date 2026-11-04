// Shared Bridge hand fixtures for completion, logging and persistence tests.
import type { GameState, Hand, Player, Suit, TrickLogEntry } from '../src/types';

export const VALUES = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2'];
// Seat 0 holds every spade, seat 1 hearts, seat 2 diamonds, seat 3 clubs.
export const SEAT_SUITS: Suit[] = ['♠', '♥', '♦', '♣'];

export function emptyHand(): Hand {
  return { '♣': [], '♦': [], '♥': [], '♠': [] };
}

export function dealBySuit(): Hand[] {
  return SEAT_SUITS.map((suit) => ({ ...emptyHand(), [suit]: [...VALUES] }));
}

export function players(): Player[] {
  return [
    { id: 'tg_101', name: 'Ann', seat: 0, connected: true, isGroupMember: true },
    { id: 'tg_102', name: 'Ben', seat: 1, connected: true, isGroupMember: true },
    { id: 'tg_103', name: 'Cat', seat: 2, connected: true, isGroupMember: true },
    { id: 'tg_104', name: 'Dan', seat: 3, connected: true, isGroupMember: true },
  ];
}

/** Trick t (1-based) has every seat play its t-th card, seat 0 leading. */
export function trickLog(tricks: number, lastTrickCards = 4): TrickLogEntry[] {
  const log: TrickLogEntry[] = [];
  for (let t = 1; t <= tricks; t++) {
    for (let seat = 0; seat < (t === tricks ? lastTrickCards : 4); seat++) {
      log.push({ trickNum: t, playOrder: seat + 1, seat, card: `${VALUES[t - 1]} ${SEAT_SUITS[seat]}` });
    }
  }
  return log;
}

function baseState(): GameState {
  return {
    roomCode: 'ROOM',
    phase: 'play',
    players: players(),
    hands: dealBySuit(),
    turn: 0,
    bidder: 0,
    bid: 4, // 1 🚫 — seven tricks needed
    trumpSuit: '🚫',
    setsNeeded: 7,
    sets: [0, 0, 0, 0],
    trumpBroken: false,
    firstPlayer: 0,
    currentSuit: null,
    playedCards: [null, null, null, null],
    partner: 2,
    partnerCard: 'A ♦',
    passCount: 0,
    lastTrick: null,
    trickComplete: false,
    bidHistory: [{ seat: 0, name: 'Ann', bidNum: 4 }, { seat: 1, name: 'Ben', bidNum: null }, { seat: 2, name: 'Cat', bidNum: null }, { seat: 3, name: 'Dan', bidNum: null }],
    spectators: [],
    firstBidder: 0,
    groupId: '-100',
    groupName: 'Test group',
    gameStartAt: null,
    partnerRevealed: true,
    gameId: 'game-fixture',
    readySeats: [],
    trickLog: [],
    trickWinners: [],
    initialHands: dealBySuit(),
    origin: null,
    pingCooldowns: {},
    disconnectTimers: {},
    isPractice: false,
    redealCount: 0,
    replacedSeats: [],
    dealtBotSeats: [],
  };
}

/** A hand the bidder side (seats 0 and 2) has just won, 7 tricks to 6. */
export function finishedState(overrides: Partial<GameState> = {}): GameState {
  return {
    ...baseState(),
    phase: 'gameover',
    hands: [emptyHand(), emptyHand(), emptyHand(), emptyHand()],
    sets: [5, 3, 2, 3],
    trickLog: trickLog(13),
    ...overrides,
  };
}

/**
 * Twelve tricks played (6-6), seats 0-2 have played to the last trick and seat 3
 * holds its final card. Seat 0 led the only spade, so "2 ♣" ends the hand and the
 * bidder side wins 7-6.
 */
export function nearFinalState(overrides: Partial<GameState> = {}): GameState {
  return {
    ...baseState(),
    hands: [emptyHand(), emptyHand(), emptyHand(), { ...emptyHand(), '♣': ['2'] }],
    sets: [4, 3, 2, 3],
    turn: 3,
    firstPlayer: 0,
    currentSuit: '♠',
    playedCards: ['2 ♠', '2 ♥', '2 ♦', null],
    trickLog: trickLog(13, 3),
    ...overrides,
  };
}
