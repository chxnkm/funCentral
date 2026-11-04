import { describe, it, expect } from 'vitest';
import { insertGameHands, persistGameLog } from '../src/game-logging';
import { buildCompletion } from '../src/bridge-completion';
import type { Player, Hand } from '../src/types';
import { finishedState } from './bridge-fixtures';

function makeMockDb() {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return { _sql: sql, _args: args };
        },
      };
    },
    async batch(stmts: Array<{ _sql: string; _args: unknown[] }>) {
      for (const s of stmts) calls.push({ sql: s._sql, args: s._args });
      return stmts.map(() => ({ success: true, results: [], meta: {} }));
    },
    _calls: calls,
  } as unknown as D1Database & { _calls: typeof calls };
}

function makeHand(clubs = ['A'], diamonds = ['K'], hearts = ['Q'], spades = ['J']): Hand {
  return { '♣': clubs, '♦': diamonds, '♥': hearts, '♠': spades };
}

function makePlayers(): Player[] {
  return [
    { id: 'tg_1', name: 'Alice', seat: 0, connected: true },
    { id: 'tg_2', name: 'Bob',   seat: 1, connected: true },
    { id: 'bot_0', name: 'Bot A', seat: 2, connected: true },
    { id: 'guest_x', name: 'Carol', seat: 3, connected: true },
  ];
}

describe('insertGameHands', () => {
  it('upserts one row per player with flattened card arrays', async () => {
    const db = makeMockDb();
    const players = makePlayers();
    const hands = [makeHand(), makeHand(), makeHand(), makeHand()];
    await insertGameHands(db, 'game-1', players, hands);
    expect(db._calls).toHaveLength(4);
    expect(db._calls[0].sql).toContain('INSERT INTO game_hands');
    // An all-pass redeal writes the same rows again with the new cards.
    expect(db._calls[0].sql).toContain('ON CONFLICT(game_id, seat) DO UPDATE SET');
    expect(db._calls[0].sql).toContain('initial_hand = excluded.initial_hand');
    expect(db._calls[0].sql).not.toContain('played_at = excluded');
    expect(db._calls[0].args[0]).toBe('game-1');
    expect(db._calls[0].args[1]).toBe(0); // seat
    expect(db._calls[0].args[2]).toBe('Alice'); // name
    expect(db._calls[0].args[3]).toBe(1); // telegram_id (from tg_1)
    const hand0 = JSON.parse(db._calls[0].args[4] as string) as string[];
    expect(hand0).toContain('A ♣');
    expect(hand0).toContain('K ♦');
    // Guest (non-tg_) and bot should have null telegram_id
    expect(db._calls[2].args[3]).toBe(null); // Bot A
    expect(db._calls[3].args[3]).toBe(null); // Carol (guest)
  });

  it('keeps the participation index for a bot covering an absent human', async () => {
    const db = makeMockDb();
    const players = makePlayers();
    players[2] = { ...players[2], id: 'bot_replacement_2', isBot: true, originalPlayerId: 'tg_3' };
    await insertGameHands(db, 'game-1', players, [makeHand(), makeHand(), makeHand(), makeHand()]);
    expect(db._calls[2].args[3]).toBe(3);
  });
});

describe('persistGameLog', () => {
  it('writes hands, every card and the metadata in one batch', async () => {
    const db = makeMockDb();
    const c = buildCompletion(finishedState(), { kind: 'completed', bidderWon: true }, null, 1_700_000_000_000);
    await persistGameLog(db, c);
    expect(db._calls).toHaveLength(4 + 52 + 1);

    const [hand0] = db._calls;
    expect(hand0.sql).toContain('final_hand = excluded.final_hand');
    expect(JSON.parse(hand0.args[4] as string)).toHaveLength(13); // dealt hand from the room record
    expect(JSON.parse(hand0.args[5] as string)).toEqual([]); // final hand
    expect(hand0.args[6]).toBe(1_700_000_000);

    const trick = db._calls[4];
    expect(trick.sql).toContain('INSERT OR IGNORE INTO game_tricks');
    expect(trick.args).toEqual(['game-fixture', 1, 1, 0, 'A ♠']);

    const metadata = db._calls[56];
    expect(metadata.sql).toContain('INSERT OR IGNORE INTO game_metadata');
    expect(metadata.args.slice(0, 5)).toEqual(['game-fixture', 0, 4, '🚫', 'A ♦']);
    expect(JSON.parse(metadata.args[7] as string)).toEqual([5, 3, 2, 3]);
    expect(metadata.args[8]).toBe('bidder');
    expect(metadata.args[10]).toBe(0);
  });

  it('labels a defended practice hand', async () => {
    const db = makeMockDb();
    const c = buildCompletion(finishedState({ isPractice: true }), { kind: 'completed', bidderWon: false }, null);
    await persistGameLog(db, c);
    const metadata = db._calls[db._calls.length - 1];
    expect(metadata.args[8]).toBe('opponents');
    expect(metadata.args[10]).toBe(1);
  });
});
