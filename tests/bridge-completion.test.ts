import { describe, it, expect } from 'vitest';
import {
  buildCompletion,
  completionDone,
  completionMessage,
  ratedTelegramId,
  type RatingSnapshot,
} from '../src/bridge-completion';
import { handFeatures } from '../src/deal-features';
import { dealBySuit, emptyHand, finishedState } from './bridge-fixtures';

const snapshot = (gameId: string): RatingSnapshot => ({
  gameId,
  capturedAt: 1_700_000_000_000,
  seasonId: 1,
  seats: [101, 102, 103, 104].map((telegramId) => ({ telegramId, elo: 1000, gamesPlayed: 3, rating: 1000, ratingGames: 0 })),
});

describe('buildCompletion', () => {
  it('captures a rated hand with every step outstanding', () => {
    const c = buildCompletion(finishedState(), { kind: 'completed', bidderWon: true }, snapshot('game-fixture'), 1234);
    expect(c).toMatchObject({ gameId: 'game-fixture', kind: 'completed', bidderWon: true, completedAt: 1234, redealCount: 0 });
    expect(c.steps).toEqual({ rated: false, notify: false, log: false, betting: false, shadow: false });
    expect(c.ratingSnapshot?.seasonId).toBe(1);
    expect(completionDone(c)).toBe(false);
  });

  it('skips the rated step for practice and keeps only the shadow ledger for abandoned hands', () => {
    const practice = buildCompletion(finishedState({ isPractice: true }), { kind: 'completed', bidderWon: false }, null);
    expect(practice.steps).toEqual({ rated: true, notify: false, log: false, betting: false, shadow: false });
    const abandoned = buildCompletion(finishedState(), { kind: 'abandoned' }, null);
    expect(abandoned.bidderWon).toBeNull();
    expect(abandoned.steps).toEqual({ rated: true, notify: true, log: true, betting: true, shadow: false });
  });

  it('ignores a snapshot taken for another hand', () => {
    expect(buildCompletion(finishedState(), { kind: 'abandoned' }, snapshot('older-hand'), 1).ratingSnapshot).toBeNull();
  });

  it('copies hands and logs so later room changes cannot alter the record', () => {
    const state = finishedState();
    const c = buildCompletion(state, { kind: 'completed', bidderWon: true }, null);
    state.initialHands[0]['♠'] = [];
    state.trickLog.length = 0;
    expect(c.initialHands[0]['♠']).toHaveLength(13);
    expect(c.trickLog).toHaveLength(52);
  });

  it('rates the human who was dealt in, not one covered by a bot from an earlier hand', () => {
    const state = finishedState({ replacedSeats: [1], dealtBotSeats: [3] });
    state.players[1] = { ...state.players[1], id: 'bot_replacement_1', isBot: true, originalPlayerId: 'tg_102' };
    state.players[3] = { ...state.players[3], id: 'bot_replacement_0', isBot: true, originalPlayerId: 'tg_104' };
    const c = buildCompletion(state, { kind: 'completed', bidderWon: true }, null);
    expect(c.players.map((p) => [p.dealtAsBot, p.replaced])).toEqual([[false, false], [false, true], [false, false], [true, true]]);
    expect(c.players.map(ratedTelegramId)).toEqual([101, 102, 103, null]);
  });

  it('treats plain bots as dealt bots for rooms that predate dealtBotSeats', () => {
    const state = finishedState({ dealtBotSeats: undefined });
    state.players[2] = { ...state.players[2], id: 'bot_2', isBot: true };
    state.players[3] = { ...state.players[3], id: 'bot_replacement_3', isBot: true, originalPlayerId: 'tg_104' };
    const c = buildCompletion(state, { kind: 'completed', bidderWon: true }, null);
    expect(c.players.map((p) => p.dealtAsBot)).toEqual([false, false, true, false]);
  });
});

describe('completionMessage', () => {
  it('reports a made contract with legacy Elo changes, bidder side first, names escaped', () => {
    const state = finishedState();
    state.players[0].name = 'Ann <b>';
    const c = buildCompletion(state, { kind: 'completed', bidderWon: true }, null);
    c.legacy = [
      { telegramId: 104, eloBefore: 1000, eloAfter: 984, delta: -16 },
      { telegramId: 101, eloBefore: 1000, eloAfter: 1016, delta: 16 },
    ];
    expect(completionMessage(c)).toBe('🏆 Ann &lt;b&gt; & Cat won!\nBid 1 🚫, made 7/7 tricks\n  Ann &lt;b&gt;: +16 → 1016\n  Dan: -16 → 984');
  });

  it('reports a defended contract and practice hands', () => {
    const c = buildCompletion(finishedState({ sets: [3, 4, 2, 4], isPractice: true }), { kind: 'completed', bidderWon: false }, null);
    expect(completionMessage(c)).toBe("🛡️ Ben & Dan defended!\nAnn's 1 🚫 bid failed\n(practice — unrated)");
  });
});

describe('handFeatures', () => {
  it('counts high-card points, the wash length bonus, shape and trumps', () => {
    const spades = dealBySuit()[0];
    expect(handFeatures(spades, '♠')).toEqual({
      hcp: 10, points: 19, clubs: 0, diamonds: 0, hearts: 0, spades: 13, shape: '13-0-0-0', trumps: 13,
    });
    const mixed = { ...emptyHand(), '♠': ['A', 'K', '9', '5', '2'], '♥': ['Q', 'J', '3'], '♦': ['7', '6', '4'], '♣': ['10', '8'] };
    expect(handFeatures(mixed, '🚫')).toMatchObject({ hcp: 10, points: 11, shape: '5-3-3-2', trumps: null });
    expect(handFeatures(mixed, null).trumps).toBeNull();
    expect(handFeatures(mixed, '♣').trumps).toBe(2);
  });
});
