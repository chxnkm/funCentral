// Keeps the documented trial queries and the Season 1 close runbook executable
// against the current schema, using a real local D1 with one recorded hand.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createBridgeHarness } from './bridge-persistence-harness';
import { buildCompletion, type RatingSnapshot } from '../src/bridge-completion';
import { persistRatedResult } from '../src/stats-db';
import { persistGameLog } from '../src/game-logging';
import { persistSeasonResult, persistShadow } from '../src/rating-db';
import { BRIDGE_SEASONS } from '../src/seasons';
import { finishedState } from './bridge-fixtures';

function blocks(file: string): [string, string][] {
  const sql = readFileSync(path.resolve(import.meta.dirname, '..', file), 'utf8');
  return sql.split(/^-- name: /m).slice(1).map((block) => {
    const [name, ...lines] = block.split(/\r?\n/);
    const statement = lines.filter((l) => !l.trimStart().startsWith('--')).join('\n').trim().replace(/;$/, '');
    return [name.trim(), statement];
  });
}

let harness: Awaited<ReturnType<typeof createBridgeHarness>>;
beforeAll(async () => {
  harness = await createBridgeHarness();
  const snapshot: RatingSnapshot = {
    gameId: 'game-fixture', capturedAt: 0, seasonId: 1,
    seats: [101, 102, 103, 104].map((telegramId) => ({ telegramId, elo: 1000, gamesPlayed: 0, rating: 1000, ratingGames: 0 })),
  };
  const c = buildCompletion(finishedState(), { kind: 'completed', bidderWon: true }, snapshot);
  c.legacy = (await persistRatedResult(harness.db, c)).elo;
  await persistGameLog(harness.db, c);
  await persistShadow(harness.db, c);
});
afterAll(async () => harness?.stop());

describe('documented Bridge rating queries', () => {
  it.each(blocks('docs/bridge-rating-queries.sql'))('%s runs and is read-only', async (_name, statement) => {
    expect(statement).toMatch(/^SELECT/);
    const result = await harness.db.prepare(statement).all();
    expect(result.results.length).toBeGreaterThan(0);
  });

  it('reports the recorded hand in the summary queries', async () => {
    const queries = Object.fromEntries(blocks('docs/bridge-rating-queries.sql'));
    expect((await harness.db.prepare(queries['prediction-accuracy']).first())).toMatchObject({ hands: 1, legacy_brier: 0.25, skill_brier: 0.25, bidder_win_rate: 1 });
    expect((await harness.db.prepare(queries['audit-mismatched-hand-logs']).first())).toEqual({ mismatched_hands: 0 });
    expect((await harness.db.prepare(queries['audit-history-coverage']).first())).toMatchObject({ rated_hands: 1, logged_hands: 1, rated_without_log: 0, trial_hands: 1 });
  });

  it('flags a hand log whose starting hand does not contain the cards played', async () => {
    await harness.db.prepare(`UPDATE game_hands SET initial_hand = '["A ♣"]' WHERE game_id = 'game-fixture' AND seat = 0`).run();
    const queries = Object.fromEntries(blocks('docs/bridge-rating-queries.sql'));
    expect((await harness.db.prepare(queries['audit-mismatched-hand-logs']).first())).toEqual({ mismatched_hands: 1 });
  });
});

describe('Season 1 close runbook', () => {
  it('archives Season 1 standings without changing live ratings, hands over to Season 2, and can be rerun', async () => {
    // A Season 2 hand for the same players must not count in the Season 1 archive.
    const season2 = buildCompletion(finishedState({ gameId: 'season-2-hand', seasonId: 2 }), { kind: 'completed', bidderWon: true }, null);
    await persistSeasonResult(harness.db, season2, 'season-2');
    const before = await harness.db.prepare('SELECT telegram_id, elo, wins, games_played FROM users ORDER BY telegram_id').all();
    for (let run = 0; run < 2; run++) {
      for (const [, statement] of blocks('docs/bridge-season-close.sql')) await harness.db.prepare(statement).run();
    }
    const standings = await harness.db.prepare('SELECT telegram_id, rank, rating, games, wins, bidder_games, bidder_wins, partner_games, opposition_games FROM bridge_season_standings ORDER BY telegram_id').all();
    expect(standings.results).toEqual([
      { telegram_id: 101, rank: 1, rating: 1016, games: 1, wins: 1, bidder_games: 1, bidder_wins: 1, partner_games: 0, opposition_games: 0 },
      { telegram_id: 102, rank: 3, rating: 984, games: 1, wins: 0, bidder_games: 0, bidder_wins: 0, partner_games: 0, opposition_games: 1 },
      { telegram_id: 103, rank: 1, rating: 1016, games: 1, wins: 1, bidder_games: 0, bidder_wins: 0, partner_games: 1, opposition_games: 0 },
      { telegram_id: 104, rank: 3, rating: 984, games: 1, wins: 0, bidder_games: 0, bidder_wins: 0, partner_games: 0, opposition_games: 1 },
    ]);
    expect(await harness.db.prepare('SELECT COUNT(*) AS n FROM bridge_season_group_standings').first()).toEqual({ n: 4 });
    expect((await harness.db.prepare('SELECT season_id, status, ended_at FROM bridge_seasons ORDER BY season_id').all()).results).toEqual([
      { season_id: 1, status: 'closed', ended_at: BRIDGE_SEASONS[1].startsAt / 1000 },
      { season_id: 2, status: 'active', ended_at: null },
    ]);
    expect((await harness.db.prepare('SELECT telegram_id, elo, wins, games_played FROM users ORDER BY telegram_id').all()).results).toEqual(before.results);
  });
});
