import { describe, it, expect } from 'vitest';
import { BRIDGE_SEASONS, bridgeNow, resolveSeason, seasonAt, startedSeasons, usesLegacyElo } from '../src/seasons';

const SEASON_2_START = Date.parse('2026-12-01T00:00:00+08:00');

describe('Bridge season schedule', () => {
  it('starts Season 2 fresh at midnight on 1 December, Singapore time', () => {
    expect(BRIDGE_SEASONS[1]).toMatchObject({ id: 2, ratingSystem: 'season-2', startsAt: SEASON_2_START });
    expect(seasonAt(SEASON_2_START - 1).id).toBe(1);
    expect(seasonAt(SEASON_2_START).id).toBe(2);
    expect(seasonAt(0).id).toBe(1);
  });

  it('rates Season 1 with the legacy Elo and later seasons with their own system', () => {
    expect(usesLegacyElo(BRIDGE_SEASONS[0])).toBe(true);
    expect(usesLegacyElo(BRIDGE_SEASONS[1])).toBe(false);
  });

  it('lists only started seasons, newest first', () => {
    expect(startedSeasons(SEASON_2_START - 1).map((s) => s.id)).toEqual([1]);
    expect(startedSeasons(SEASON_2_START).map((s) => s.id)).toEqual([2, 1]);
  });

  it('resolves a requested season only once it has started', () => {
    expect(resolveSeason('1', SEASON_2_START).id).toBe(1);
    expect(resolveSeason(null, SEASON_2_START).id).toBe(2);
    expect(resolveSeason('2', SEASON_2_START - 1).id).toBe(1);
    expect(resolveSeason('7', SEASON_2_START).id).toBe(2);
    expect(resolveSeason('abc', SEASON_2_START - 1).id).toBe(1);
  });

  it('pins the clock for local tests only when dev login is enabled', () => {
    expect(bridgeNow({ ALLOW_DEV_LOGIN: '1', TEST_NOW_MS: String(SEASON_2_START) })).toBe(SEASON_2_START);
    const before = Date.now();
    expect(bridgeNow({ TEST_NOW_MS: String(SEASON_2_START) })).toBeGreaterThanOrEqual(before);
    expect(bridgeNow({ ALLOW_DEV_LOGIN: '1' })).toBeGreaterThanOrEqual(before);
  });
});
