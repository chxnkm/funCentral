import { describe, it, expect } from 'vitest';
import { gameRecordRows, getPlayerStats, getPairStats } from '../src/stats-db';

// Seats 0-3 with the given telegram ids (null = guest or bot).
function seats(ids: (number | null)[]) {
  return ids.map((telegramId, seat) => ({ seat, telegramId }));
}

describe('gameRecordRows', () => {
  it('builds one row per rated player', () => {
    expect(gameRecordRows(seats([1, 2, 3, 4]), 0, 1, [4, 4, 5, 5], [0, 1])).toHaveLength(4);
  });

  it('skips guests and bots', () => {
    const rows = gameRecordRows(seats([1, null, 3, null]), 0, 1, [4, 4, 5, 5], [0, 1]);
    expect(rows.map((r) => r.telegramId)).toEqual([1, 3]);
  });

  it('assigns roles correctly: bidder, partner, opposition', () => {
    const rows = gameRecordRows(seats([10, 20, 30, 40]), 0, 2, [5, 4, 5, 4], [0, 2]);
    expect(rows.map((r) => r.role)).toEqual(['bidder', 'opposition', 'partner', 'opposition']);
    expect(rows.map((r) => r.partnerTelegramId)).toEqual([30, 40, 10, 20]);
  });

  it('gives each side its combined tricks', () => {
    const rows = gameRecordRows(seats([1, 2, 3, 4]), 0, 2, [5, 4, 3, 1], [0, 2]);
    expect(rows.map((r) => r.tricksWon)).toEqual([8, 5, 8, 5]);
  });

  it('sets partner_telegram_id to null for a solo bidder (partner === bidder)', () => {
    const rows = gameRecordRows(seats([1, 2, 3, 4]), 0, 0, [7, 2, 2, 2], [0]);
    expect(rows.map((r) => r.partnerTelegramId)).toEqual([null, null, null, null]);
    expect(rows.map((r) => r.role)).toEqual(['bidder', 'opposition', 'opposition', 'opposition']);
  });

  it('sets won=1 for winner seats and won=0 for losers', () => {
    const rows = gameRecordRows(seats([100, 200, 300, 400]), 0, 1, [5, 5, 4, 4], [0, 1]);
    expect(rows.map((r) => r.won)).toEqual([1, 1, 0, 0]);
  });
});

// Mock that returns empty results (smoke tests — SQL logic is tested via D1)
function makeEmptyDb() {
  return {
    prepare(_sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            all: async () => ({ results: [] }),
            first: async () => null,
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe('getPlayerStats', () => {
  it('returns an empty array when no records exist', async () => {
    const db = makeEmptyDb();
    const result = await getPlayerStats(db);
    expect(result).toEqual([]);
  });

  it('accepts an optional groupId without throwing', async () => {
    const db = makeEmptyDb();
    const result = await getPlayerStats(db, '-100200300');
    expect(result).toEqual([]);
  });
});

describe('getPairStats', () => {
  it('returns an empty array when no records exist', async () => {
    const db = makeEmptyDb();
    const result = await getPairStats(db);
    expect(result).toEqual([]);
  });
});
