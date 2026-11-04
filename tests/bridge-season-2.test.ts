// Season 2 (from 1 December 2026, 00:00 SGT) against real local workerd + D1:
// hands dealt in Season 2 are rated by the fresh season rating and never touch
// the Season 1 (legacy Elo) tables; boards, stats and rating changes follow.
import { afterEach, describe, expect, it } from 'vitest';
import { connect, createBridgeHarness, readRoom, waitFor, writeRoom } from './bridge-persistence-harness';
import { nearFinalState, players } from './bridge-fixtures';
import type { RatingSnapshot } from '../src/bridge-completion';
import { BRIDGE_SEASONS, seasonById } from '../src/seasons';
import { getHandRatingChanges, getSeasonGroupLeaderboard, getSeasonLeaderboard, getSeasonStanding } from '../src/season-db';
import { getPairStats, getPlayerStats } from '../src/stats-db';

const SEASON_2 = seasonById(2)!;
let harness: Awaited<ReturnType<typeof createBridgeHarness>> | null = null;
afterEach(async () => {
  await harness?.stop();
  harness = null;
});

const snapshot = (gameId = 'game-fixture'): RatingSnapshot => ({
  gameId,
  capturedAt: SEASON_2.startsAt + 60_000,
  seasonId: 2,
  seats: [101, 102, 103, 104].map((telegramId) => ({ telegramId, elo: 1000, gamesPlayed: 0, rating: 1000, ratingGames: 0 })),
});

async function all(sql: string, ...binds: unknown[]) {
  return (await harness!.db.prepare(sql).bind(...binds).all()).results;
}

async function finishSeason2Hand(roomName: string, state = nearFinalState({ seasonId: 2 }), snap: RatingSnapshot | null = snapshot()) {
  const room = await harness!.room(roomName);
  await writeRoom(room, snap ? { state, ratingSnapshot: snap } : { state });
  const ws = await connect(room, 'tg_104');
  ws.send(JSON.stringify({ type: 'playCard', card: '2 ♣' }));
  const after = await waitFor(() => readRoom(room), (r) => r.state.phase === 'gameover' && r.completions.length === 0);
  ws.close();
  return after;
}

describe('Bridge Season 2', () => {
  it('matches the migration row to the code schedule', async () => {
    harness = await createBridgeHarness();
    expect(await all('SELECT season_id, name, rating_system, status, started_at FROM bridge_seasons ORDER BY season_id')).toEqual([
      { season_id: 1, name: 'Season 1', rating_system: 'elo-v1', status: 'active', started_at: expect.any(Number) },
      { season_id: 2, name: 'Season 2', rating_system: 'season-2', status: 'planned', started_at: BRIDGE_SEASONS[1].startsAt / 1000 },
    ]);
  });

  it('rates a Season 2 hand fresh and leaves the Season 1 tables untouched', async () => {
    harness = await createBridgeHarness();
    await finishSeason2Hand('S2');

    expect(await all('SELECT elo, wins, games_played FROM users WHERE telegram_id <= 104')).toEqual(
      Array(4).fill({ elo: 1000, wins: 0, games_played: 0 }),
    );
    expect(await all('SELECT COUNT(*) AS n FROM elo_history')).toEqual([{ n: 0 }]);
    expect(await all('SELECT COUNT(*) AS n FROM group_stats')).toEqual([{ n: 0 }]);
    expect(await all("SELECT system, telegram_id, rating, games, wins FROM bridge_ratings ORDER BY telegram_id")).toEqual([
      { system: 'season-2', telegram_id: 101, rating: 1020, games: 1, wins: 1 },
      { system: 'season-2', telegram_id: 102, rating: 980, games: 1, wins: 0 },
      { system: 'season-2', telegram_id: 103, rating: 1020, games: 1, wins: 1 },
      { system: 'season-2', telegram_id: 104, rating: 980, games: 1, wins: 0 },
    ]);
    expect(await all("SELECT COUNT(*) AS n FROM bridge_rating_events WHERE system = 'season-2' AND applied = 1 AND legacy_delta IS NULL")).toEqual([{ n: 4 }]);
    expect(await all('SELECT season_id, skill_applied, legacy_expected FROM bridge_game_ledger')).toEqual([{ season_id: 2, skill_applied: 1, legacy_expected: null }]);
    expect(await all('SELECT COUNT(*) AS n FROM game_records')).toEqual([{ n: 4 }]);
    expect(await all("SELECT telegram_id, wins, games_played FROM bridge_season_group_stats WHERE season_id = 2 AND group_id = '-100' ORDER BY telegram_id")).toEqual([
      { telegram_id: 101, wins: 1, games_played: 1 }, { telegram_id: 102, wins: 0, games_played: 1 },
      { telegram_id: 103, wins: 1, games_played: 1 }, { telegram_id: 104, wins: 0, games_played: 1 },
    ]);
    await waitFor(async () => harness!.telegram.length, (n) => n === 1);
    expect(harness.telegram[0].text).toBe('🏆 Ann & Cat won!\nBid 1 🚫, made 7/7 tricks\n  Ann: +20 → 1020\n  Cat: +20 → 1020\n  Ben: -20 → 980\n  Dan: -20 → 980');

    // Boards, stats, the game-over lookup and seat standings read the season rating.
    const board = await getSeasonLeaderboard(harness.db, SEASON_2, 104);
    expect(board.top.map((e) => [e.rank, e.displayName, e.elo, e.wins, e.gamesPlayed, e.provisional])).toEqual([
      [1, 'Ann', 1020, 1, 1, true], [1, 'Cat', 1020, 1, 1, true], [3, 'Ben', 980, 0, 1, true], [3, 'Dan', 980, 0, 1, true],
    ]);
    expect(board.me).toBeNull();
    expect((await getSeasonGroupLeaderboard(harness.db, SEASON_2, '-100')).top).toHaveLength(4);
    expect(await getHandRatingChanges(harness.db, 'game-fixture')).toEqual([
      { name: 'Ann', delta: 20, eloBefore: 1000, eloAfter: 1020 },
      { name: 'Ben', delta: -20, eloBefore: 1000, eloAfter: 980 },
      { name: 'Cat', delta: 20, eloBefore: 1000, eloAfter: 1020 },
      { name: 'Dan', delta: -20, eloBefore: 1000, eloAfter: 980 },
    ]);
    expect(await getSeasonStanding(harness.db, SEASON_2, 101)).toEqual({ wins: 1, gamesPlayed: 1, elo: 1020 });
    expect(await getSeasonStanding(harness.db, BRIDGE_SEASONS[0], 101)).toBeNull();

    const season2Stats = await getPlayerStats(harness.db, undefined, { seasonId: 2, ratingSystem: 'season-2', excludeLaterSeasons: false });
    expect(season2Stats.map((r) => [r.telegramId, r.elo, r.games, r.wins]).sort()).toEqual([[101, 1020, 1, 1], [102, 980, 1, 0], [103, 1020, 1, 1], [104, 980, 1, 0]]);
    expect(await getPlayerStats(harness.db, undefined, { seasonId: 1, ratingSystem: null, excludeLaterSeasons: true })).toEqual([]);
    expect(await getPairStats(harness.db, '-100', { seasonId: 2, ratingSystem: 'season-2', excludeLaterSeasons: false })).toEqual([]);
  });

  it('charges a player who left mid-hand with the Season 2 result', async () => {
    harness = await createBridgeHarness();
    const state = nearFinalState({ seasonId: 2, replacedSeats: [1] });
    state.players[1] = { ...state.players[1], id: 'bot_replacement_1', isBot: true, originalPlayerId: 'tg_102', connected: true };
    await finishSeason2Hand('LEAVER', state);
    expect(await all("SELECT telegram_id, rating FROM bridge_ratings WHERE telegram_id = 102")).toEqual([{ telegram_id: 102, rating: 980 }]);
    expect(await all('SELECT has_replacement, skill_applied FROM bridge_game_ledger')).toEqual([{ has_replacement: 1, skill_applied: 1 }]);
  });

  it('rates a Season 2 hand from current ratings when no deal snapshot was taken', async () => {
    harness = await createBridgeHarness();
    await harness.db.prepare("INSERT INTO bridge_ratings (system, telegram_id, rating, games, wins, updated_at) VALUES ('season-2', 101, 1100, 30, 20, 0)").run();
    await finishSeason2Hand('NOSNAP', nearFinalState({ seasonId: 2 }), null);
    const [ann] = await all("SELECT rating, games FROM bridge_ratings WHERE telegram_id = 101") as { rating: number; games: number }[];
    expect(ann.games).toBe(31);
    // Established (K=16) and favoured: a small gain.
    expect(ann.rating).toBeGreaterThan(1100);
    expect(ann.rating).toBeLessThan(1108);
    expect(await all('SELECT skill_applied FROM bridge_game_ledger')).toEqual([{ skill_applied: 1 }]);
  });

  it('records but does not rate a Season 2 hand dealt with a bot', async () => {
    harness = await createBridgeHarness();
    // The partner seat was dealt to a bot (it has already played to the last trick).
    const state = nearFinalState({ seasonId: 2, dealtBotSeats: [2] });
    state.players[2] = { ...state.players[2], id: 'bot_2', name: 'Bot', isBot: true };
    const snap = snapshot();
    snap.seats[2] = { telegramId: null, elo: null, gamesPlayed: null, rating: null, ratingGames: null };
    await finishSeason2Hand('BOT', state, snap);
    expect(await all('SELECT skill_applied, skill_reason, has_bot FROM bridge_game_ledger')).toEqual([{ skill_applied: 0, skill_reason: 'bot', has_bot: 1 }]);
    expect(await all('SELECT COUNT(*) AS n FROM bridge_ratings')).toEqual([{ n: 0 }]);
    expect(await all('SELECT COUNT(*) AS n FROM game_records')).toEqual([{ n: 0 }]);
  });

  it('assigns the season when the hand is dealt', { timeout: 20_000 }, async () => {
    harness = await createBridgeHarness({ bindings: { ALLOW_DEV_LOGIN: '1', TEST_NOW_MS: String(SEASON_2.startsAt + 1) } });
    const room = await harness.room('DEAL');
    const lobby = nearFinalState({ phase: 'lobby', players: players().map((p) => ({ ...p, connected: false })) });
    await writeRoom(room, { state: lobby });
    const sockets: WebSocket[] = [];
    for (const p of players()) sockets.push(await connect(room, p.id));
    sockets[0].send(JSON.stringify({ type: 'startGame' }));
    const dealt = await waitFor(() => readRoom(room), (r) => r.state.phase === 'bidding' && r.snapshot !== null);
    for (const ws of sockets) ws.close();
    expect(dealt.state.seasonId).toBe(2);
    expect(dealt.snapshot).toMatchObject({ gameId: dealt.state.gameId, seasonId: 2 });
    expect(dealt.snapshot.seats.map((s: { rating: number }) => s.rating)).toEqual([1000, 1000, 1000, 1000]);
  });
});
