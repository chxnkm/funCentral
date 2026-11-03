import { describe, it, expect } from 'vitest';
import { computeConnect4Deltas, expectedScore, START_RATING } from '../src/connect4/rating';

const player = (telegramId: number, place: number, rating = 1000, gamesPlayed = 0) => ({ telegramId, place, rating, gamesPlayed });
const sum = (m: Map<number, number>) => [...m.values()].reduce((a, b) => a + b, 0);

describe('connect4 rating', () => {
  it('starts everyone at 1000 and expects an even match between equals', () => {
    expect(START_RATING).toBe(1000);
    expect(expectedScore(1000, 1000)).toBe(0.5);
    expect(expectedScore(1400, 1000)).toBeGreaterThan(0.9);
  });

  it('two equal new players swing by half of K', () => {
    const d = computeConnect4Deltas([player(1, 1), player(2, 2)]);
    expect(d.get(1)).toBe(16);
    expect(d.get(2)).toBe(-16);
    expect(sum(d)).toBe(0);
  });

  it('a draw between equal players changes nothing', () => {
    const d = computeConnect4Deltas([player(1, 1), player(2, 1)]);
    expect(d.get(1)).toBe(0);
    expect(d.get(2)).toBe(0);
  });

  it('pays more for beating a stronger opponent, and takes more for losing to a weaker one', () => {
    const upset = computeConnect4Deltas([player(1, 1, 1000), player(2, 2, 1400)]);
    const expected = computeConnect4Deltas([player(1, 2, 1000), player(2, 1, 1400)]);
    expect(upset.get(1)!).toBeGreaterThan(16);
    expect(upset.get(2)!).toBeLessThan(-16);
    expect(expected.get(1)!).toBeGreaterThan(-8);
    expect(expected.get(1)!).toBeLessThan(0);
  });

  it('uses K=32 for the first 30 games and K=16 after', () => {
    const d = computeConnect4Deltas([player(1, 1, 1000, 0), player(2, 2, 1000, 50)]);
    expect(d.get(1)).toBe(16);
    expect(d.get(2)).toBe(-8);
  });

  it('returns nothing unless exactly two players are supplied', () => {
    expect(computeConnect4Deltas([player(1, 1)]).size).toBe(0);
    expect(computeConnect4Deltas([]).size).toBe(0);
    expect(computeConnect4Deltas([player(1, 1), player(2, 2), player(3, 2)]).size).toBe(0);
  });
});
