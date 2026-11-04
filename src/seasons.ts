/**
 * Bridge seasons. Pure: no Cloudflare or D1 dependencies.
 *
 * A hand belongs to the season in which it was dealt, so a hand that starts
 * before a season boundary and finishes after it still counts for the old
 * season. The schedule lives in code so the boundary needs no database read on
 * the deal path; migration rows in `bridge_seasons` mirror it for reporting and
 * archiving (tests check that they agree).
 */

import { SKILL_SYSTEM } from './skill-rating';

export interface BridgeSeason {
  id: number;
  name: string;
  /** 'elo-v1' = the legacy pair Elo in users.elo; otherwise a bridge_ratings.system. */
  ratingSystem: string;
  /** Start, in ms since the epoch. */
  startsAt: number;
}

export const LEGACY_RATING_SYSTEM = 'elo-v1';

export const BRIDGE_SEASONS: readonly BridgeSeason[] = [
  // First rated hand after the 0006 stats reset.
  { id: 1, name: 'Season 1', ratingSystem: LEGACY_RATING_SYSTEM, startsAt: Date.UTC(2026, 3, 4, 9, 14, 55) },
  // 1 December 2026, 00:00 Singapore time (UTC+8). Starts fresh at 1000.
  { id: 2, name: 'Season 2', ratingSystem: 'season-2', startsAt: Date.UTC(2026, 10, 30, 16, 0, 0) },
];

/** The season a hand dealt at `ms` belongs to (Season 1 for anything earlier). */
export function seasonAt(ms: number): BridgeSeason {
  let current = BRIDGE_SEASONS[0];
  for (const season of BRIDGE_SEASONS) if (season.startsAt <= ms) current = season;
  return current;
}

/** Seasons that have started by `ms`, newest first. */
export function startedSeasons(ms: number): BridgeSeason[] {
  return BRIDGE_SEASONS.filter((s) => s.id === 1 || s.startsAt <= ms).reverse();
}

export function seasonById(id: number): BridgeSeason | undefined {
  return BRIDGE_SEASONS.find((s) => s.id === id);
}

/** Season 1 is rated by the legacy Elo; later seasons by their own skill rating. */
export function usesLegacyElo(season: BridgeSeason): boolean {
  return season.ratingSystem === LEGACY_RATING_SYSTEM;
}

/**
 * The requested season if it has started, else the current one. Accepts the raw
 * `?season=` query value.
 */
export function resolveSeason(requested: string | null | undefined, ms: number): BridgeSeason {
  const id = Number(requested);
  const season = Number.isInteger(id) ? seasonById(id) : undefined;
  return season && startedSeasons(ms).includes(season) ? season : seasonAt(ms);
}

/**
 * The clock used for season boundaries. Local tests may pin it with TEST_NOW_MS,
 * which is honoured only where dev login is enabled (never in production).
 */
export function bridgeNow(env: { ALLOW_DEV_LOGIN?: string; TEST_NOW_MS?: string }): number {
  const pinned = Number(env.TEST_NOW_MS);
  return env.ALLOW_DEV_LOGIN === '1' && env.TEST_NOW_MS && Number.isFinite(pinned) ? pinned : Date.now();
}

/**
 * The bridge_ratings system a hand dealt in this season is evaluated on:
 * Season 1 hands feed the shadow trial; later seasons rate their own system.
 */
export function skillSystemFor(season: BridgeSeason): string {
  return usesLegacyElo(season) ? SKILL_SYSTEM : season.ratingSystem;
}

/** Whether hands dealt in this season are rated by the legacy Elo (unknown ids count as Season 1). */
export function isLegacySeasonId(id: number | undefined): boolean {
  return usesLegacyElo(seasonById(id ?? 1) ?? BRIDGE_SEASONS[0]);
}
