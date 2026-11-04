import { describe, it, expect } from 'vitest';
import {
  evaluateSkillGame,
  isProvisional,
  skillK,
  teamExpectation,
  type SkillGame,
  type SkillSeat,
} from '../src/skill-rating';
import { computeEloDeltas } from '../src/elo';

function seat(seatNo: number, rating: number | null = 1000, games: number | null = 0, extra: Partial<SkillSeat> = {}): SkillSeat {
  return { seat: seatNo, telegramId: 100 + seatNo, isBot: false, replaced: false, rating, games, ...extra };
}

function game(seats: SkillSeat[], extra: Partial<SkillGame> = {}): SkillGame {
  return { bidder: 0, partner: 2, bidderWon: true, isPractice: false, seats, ...extra };
}

const deltaOf = (result: ReturnType<typeof evaluateSkillGame>, seatNo: number) =>
  result.players.find((p) => p.seat === seatNo)!.delta!;

describe('skill-v1 K-factor and provisional status', () => {
  it('falls from 40 to a floor of 16 over the first 24 games', () => {
    expect(skillK(0)).toBe(40);
    expect(skillK(10)).toBe(30);
    expect(skillK(24)).toBe(16);
    expect(skillK(200)).toBe(16);
  });

  it('marks players provisional for their first 20 games', () => {
    expect(isProvisional(19)).toBe(true);
    expect(isProvisional(20)).toBe(false);
  });
});

describe('teamExpectation', () => {
  it('keeps the legacy team-average expectation as the baseline', () => {
    expect(teamExpectation([1000, 1000], [1000, 1000])).toBe(0.5);
    // Same expectation as the legacy pair Elo: equal K gives equal-and-opposite deltas.
    const e = teamExpectation([1200, 1000], [1000, 1000]);
    const legacy = computeEloDeltas(
      [{ telegramId: 1, elo: 1200, gamesPlayed: 50 }, { telegramId: 2, elo: 1000, gamesPlayed: 50 }],
      [{ telegramId: 3, elo: 1000, gamesPlayed: 50 }, { telegramId: 4, elo: 1000, gamesPlayed: 50 }],
      true,
    );
    expect(legacy.get(1)).toBe(Math.round(16 * (1 - e)));
  });
});

describe('evaluateSkillGame', () => {
  it('applies a four-human 2-v-2 hand as a zero-sum exchange between equally certain players', () => {
    const result = evaluateSkillGame(game([seat(0), seat(1), seat(2), seat(3)]));
    expect(result).toMatchObject({ applied: true, reason: null, bidderExpected: 0.5 });
    expect(result.players.map((p) => p.delta)).toEqual([20, -20, 20, -20]);
    expect(result.players.map((p) => p.ratingAfter)).toEqual([1020, 980, 1020, 980]);
    expect(result.players.map((p) => p.role)).toEqual(['bidder', 'opposition', 'partner', 'opposition']);
  });

  it('rewards a win with a weaker partner more and charges a loss with one less', () => {
    const weakPartner = [seat(0, 1200, 50), seat(1, 1000, 50), seat(2, 800, 50), seat(3, 1000, 50)];
    const strongPartner = [seat(0, 1200, 50), seat(1, 1000, 50), seat(2, 1200, 50), seat(3, 1000, 50)];
    expect(deltaOf(evaluateSkillGame(game(weakPartner)), 0)).toBeGreaterThan(deltaOf(evaluateSkillGame(game(strongPartner)), 0));
    const lossWeak = deltaOf(evaluateSkillGame(game(weakPartner, { bidderWon: false })), 0);
    const lossStrong = deltaOf(evaluateSkillGame(game(strongPartner, { bidderWon: false })), 0);
    expect(lossWeak).toBeLessThan(0);
    expect(Math.abs(lossWeak)).toBeLessThan(Math.abs(lossStrong));
  });

  it('moves a provisional player more than an established partner after a win and after a loss', () => {
    const seats = [seat(0, 1000, 60), seat(1), seat(2, 1000, 0), seat(3)];
    const win = evaluateSkillGame(game(seats));
    const loss = evaluateSkillGame(game(seats, { bidderWon: false }));
    expect(deltaOf(win, 2)).toBeGreaterThan(deltaOf(win, 0));
    expect(deltaOf(loss, 2)).toBeLessThan(deltaOf(loss, 0));
    expect(deltaOf(win, 0)).toBeGreaterThan(0);
  });

  it.each([
    ['practice', { isPractice: true }, [seat(0), seat(1), seat(2), seat(3)]],
    ['bot', {}, [seat(0), seat(1), seat(2), seat(3, null, null, { telegramId: null, isBot: true })]],
    ['replacement', {}, [seat(0), seat(1, 1000, 0, { replaced: true }), seat(2), seat(3)]],
    ['solo', { partner: 0 }, [seat(0), seat(1), seat(2), seat(3)]],
    ['no-snapshot', {}, [seat(0), seat(1, null, null), seat(2), seat(3)]],
  ] as const)('records but does not apply a %s hand', (reason, extra, seats) => {
    const result = evaluateSkillGame(game([...seats], extra));
    expect(result.applied).toBe(false);
    expect(result.reason).toBe(reason);
    for (const p of result.players) expect(p.ratingAfter).toBe(p.ratingBefore);
  });

  it('keeps a prediction for excluded hands when every seat has a rating', () => {
    const solo = evaluateSkillGame(game([seat(0), seat(1), seat(2), seat(3)], { partner: 0 }));
    expect(solo.bidderExpected).toBe(0.5);
    expect(solo.players.find((p) => p.seat === 0)).toMatchObject({ role: 'bidder', teamRating: 1000, oppRating: 1000, delta: 20 });
    const withBot = evaluateSkillGame(game([seat(0), seat(1), seat(2), seat(3, null, null, { telegramId: null, isBot: true })]));
    expect(withBot.bidderExpected).toBeNull();
    expect(withBot.players).toHaveLength(3);
  });

  it('reports the first applicable exclusion only', () => {
    const result = evaluateSkillGame(game(
      [seat(0), seat(1, 1000, 0, { replaced: true }), seat(2), seat(3, null, null, { telegramId: null, isBot: true })],
      { partner: 0, isPractice: true },
    ));
    expect(result.reason).toBe('practice');
  });
});
