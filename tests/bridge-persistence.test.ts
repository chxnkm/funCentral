// Bridge hand completion against real local workerd + D1 (SQLite): durable
// outbox, atomic and idempotent writes, retry across restart, the all-pass
// redeal log, and the shadow rating trial with and without migration 0013.
import { afterEach, describe, expect, it } from 'vitest';
import { connect, createBridgeHarness, readRoom, waitFor, writeRoom } from './bridge-persistence-harness';
import { dealBySuit, finishedState, nearFinalState, players } from './bridge-fixtures';
import { buildCompletion, type RatingSnapshot } from '../src/bridge-completion';
import { persistRatedResult } from '../src/stats-db';
import { persistShadow } from '../src/rating-db';
import { insertGameHands } from '../src/game-logging';
import { settleBetsAndUpdateElo } from '../src/betting-db';

let harness: Awaited<ReturnType<typeof createBridgeHarness>> | null = null;
afterEach(async () => {
  await harness?.stop();
  harness = null;
});

const snapshot = (gameId = 'game-fixture'): RatingSnapshot => ({
  gameId,
  capturedAt: 1_700_000_000_000,
  seasonId: 1,
  seats: [101, 102, 103, 104].map((telegramId) => ({ telegramId, elo: 1000, gamesPlayed: 0, rating: 1000, ratingGames: 0 })),
});

async function count(table: string, where = '1 = 1', ...binds: unknown[]): Promise<number> {
  const row = await harness!.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...binds).first<{ n: number }>();
  return row!.n;
}

async function users() {
  const rows = await harness!.db.prepare('SELECT telegram_id, elo, wins, games_played FROM users ORDER BY telegram_id').all<{ telegram_id: number; elo: number; wins: number; games_played: number }>();
  return rows.results;
}

async function playLastCard(roomName: string) {
  const room = await harness!.room(roomName);
  await writeRoom(room, { state: nearFinalState(), ratingSnapshot: snapshot() });
  const ws = await connect(room, 'tg_104');
  ws.send(JSON.stringify({ type: 'playCard', card: '2 ♣' }));
  return { room, ws };
}

describe('Bridge hand completion persistence', () => {
  it('records a finished hand once, with legacy stats, logs, shadow trial and one group post', async () => {
    harness = await createBridgeHarness();
    const { room, ws } = await playLastCard('FINISH');
    const after = await waitFor(() => readRoom(room), (r) => r.state.phase === 'gameover' && r.completions.length === 0);
    ws.close();

    expect(after.state.sets).toEqual([5, 3, 2, 3]);
    expect(await users()).toMatchObject([
      { telegram_id: 101, elo: 1016, wins: 1, games_played: 1 },
      { telegram_id: 102, elo: 984, wins: 0, games_played: 1 },
      { telegram_id: 103, elo: 1016, wins: 1, games_played: 1 },
      { telegram_id: 104, elo: 984, wins: 0, games_played: 1 },
      { telegram_id: 105, elo: 1000, wins: 0, games_played: 0 },
    ]);
    expect(await count('game_records', 'game_id = ?', 'game-fixture')).toBe(4);
    expect(await count('elo_history', 'game_id = ?', 'game-fixture')).toBe(4);
    expect(await count('group_stats', "group_id = '-100' AND games_played = 1")).toBe(4);
    expect(await count('game_tricks', 'game_id = ?', 'game-fixture')).toBe(52);
    expect(await count('game_metadata', "game_id = ? AND winning_team = 'bidder'", 'game-fixture')).toBe(1);
    expect(await count('game_hands', "game_id = ? AND final_hand = '[]'", 'game-fixture')).toBe(4);

    const ledger = await harness.db.prepare('SELECT * FROM bridge_game_ledger').first<Record<string, unknown>>();
    expect(ledger).toMatchObject({
      game_id: 'game-fixture', season_id: 1, status: 'completed', is_practice: 0, has_bot: 0, has_replacement: 0,
      is_solo: 0, bidder_won: 1, bidder_tricks: 7, tricks_played: 13, bidder_side_hcp: 20, bidder_side_trumps: null,
      legacy_expected: 0.5, skill_expected: 0.5, skill_applied: 1, skill_reason: null, dealt_at: 1_700_000_000,
    });
    const events = await harness.db.prepare('SELECT telegram_id, role, applied, delta, rating_after, legacy_before, legacy_delta FROM bridge_rating_events ORDER BY telegram_id').all();
    expect(events.results).toEqual([
      { telegram_id: 101, role: 'bidder', applied: 1, delta: 20, rating_after: 1020, legacy_before: 1000, legacy_delta: 16 },
      { telegram_id: 102, role: 'opposition', applied: 1, delta: -20, rating_after: 980, legacy_before: 1000, legacy_delta: -16 },
      { telegram_id: 103, role: 'partner', applied: 1, delta: 20, rating_after: 1020, legacy_before: 1000, legacy_delta: 16 },
      { telegram_id: 104, role: 'opposition', applied: 1, delta: -20, rating_after: 980, legacy_before: 1000, legacy_delta: -16 },
    ]);
    const ratings = await harness.db.prepare("SELECT telegram_id, rating, games, wins FROM bridge_ratings WHERE system = 'skill-v1' ORDER BY telegram_id").all();
    expect(ratings.results).toEqual([
      { telegram_id: 101, rating: 1020, games: 1, wins: 1 },
      { telegram_id: 102, rating: 980, games: 1, wins: 0 },
      { telegram_id: 103, rating: 1020, games: 1, wins: 1 },
      { telegram_id: 104, rating: 980, games: 1, wins: 0 },
    ]);
    const features = await harness.db.prepare('SELECT seat, role, hcp, points, shape, won FROM bridge_deal_features ORDER BY seat').all();
    expect(features.results).toEqual([
      { seat: 0, role: 'bidder', hcp: 10, points: 19, shape: '13-0-0-0', won: 1 },
      { seat: 1, role: 'opposition', hcp: 10, points: 19, shape: '13-0-0-0', won: 0 },
      { seat: 2, role: 'partner', hcp: 10, points: 19, shape: '13-0-0-0', won: 1 },
      { seat: 3, role: 'opposition', hcp: 10, points: 19, shape: '13-0-0-0', won: 0 },
    ]);
    await waitFor(async () => harness!.telegram.length, (n) => n === 1);
    expect(harness.telegram[0]).toMatchObject({ chat_id: '-100' });
    expect(harness.telegram[0].text).toBe('🏆 Ann & Cat won!\nBid 1 🚫, made 7/7 tricks\n  Ann: +16 → 1016\n  Cat: +16 → 1016\n  Ben: -16 → 984\n  Dan: -16 → 984');

    // A later alarm finds nothing left to do and changes nothing.
    await room.fetch('https://room.test/__retry');
    expect(await count('elo_history')).toBe(4);
    expect(harness.telegram).toHaveLength(1);
  });

  it('keeps a failed rated write in the outbox across a restart and applies it once on retry', async () => {
    harness = await createBridgeHarness();
    await harness.db.prepare("CREATE TRIGGER fail_records BEFORE INSERT ON game_records BEGIN SELECT RAISE(ABORT, 'injected failure'); END").run();
    const { room, ws } = await playLastCard('RETRY');
    const failed = await waitFor(() => readRoom(room), (r) => r.completions.length === 1 && r.completions[0].attempts === 1);
    ws.close();

    expect(failed.state.phase).toBe('gameover');
    expect(failed.completions[0].steps).toEqual({ rated: false, notify: false, log: true, betting: true, shadow: false });
    expect(failed.alarm).not.toBeNull();
    // The whole rated transaction rolled back: no partial counters or Elo.
    expect((await users()).every((u) => u.games_played === 0 && u.elo === 1000)).toBe(true);
    expect(await count('elo_history')).toBe(0);
    expect(await count('group_stats')).toBe(0);
    expect(await count('game_metadata')).toBe(1); // replay log is an independent step
    expect(harness.telegram).toHaveLength(0);

    await harness.restart();
    const restarted = await harness.room('RETRY');
    expect((await readRoom(restarted)).completions).toHaveLength(1);

    await harness.db.prepare('DROP TRIGGER fail_records').run();
    await restarted.fetch('https://room.test/__retry');
    expect((await readRoom(restarted)).completions).toEqual([]);
    expect((await users()).filter((u) => u.games_played === 1).map((u) => u.elo)).toEqual([1016, 984, 1016, 984]);
    expect(await count('game_records')).toBe(4);
    expect(await count('bridge_game_ledger')).toBe(1);
    await waitFor(async () => harness!.telegram.length, (n) => n === 1);

    await restarted.fetch('https://room.test/__retry');
    expect(await count('game_records')).toBe(4);
    expect(await count('elo_history')).toBe(4);
    expect(await count('bridge_rating_events')).toBe(4);
  });

  it('does not reapply a hand whose writes already committed', async () => {
    harness = await createBridgeHarness();
    const c = buildCompletion(finishedState(), { kind: 'completed', bidderWon: true }, snapshot());
    const first = await persistRatedResult(harness.db, c);
    const second = await persistRatedResult(harness.db, c);
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.elo).toEqual(first.elo);
    expect(await count('game_records')).toBe(4);
    expect((await users()).map((u) => u.games_played)).toEqual([1, 1, 1, 1, 0]);

    c.legacy = first.elo;
    await persistShadow(harness.db, c);
    await persistShadow(harness.db, c);
    expect(await count('bridge_rating_events')).toBe(4);
    const ann = await harness.db.prepare('SELECT rating, games FROM bridge_ratings WHERE telegram_id = 101').first();
    expect(ann).toEqual({ rating: 1020, games: 1 });

    await harness.db.prepare(
      `INSERT INTO betting_records (game_id, spectator_id, spectator_name, watched_seat, prediction, placed_at)
       VALUES ('game-fixture', 'tg_105', 'Eve', 0, 'win', 0)`,
    ).run();
    await settleBetsAndUpdateElo(harness.db, 'game-fixture', true);
    await settleBetsAndUpdateElo(harness.db, 'game-fixture', true);
    expect(await harness.db.prepare('SELECT betting_elo FROM users WHERE telegram_id = 105').first()).toEqual({ betting_elo: 1016 });
    expect(await count('betting_elo_history')).toBe(1);
  });

  it('adds concurrent hands for a shared player instead of losing one update', async () => {
    harness = await createBridgeHarness();
    const db = harness.db;
    let reads = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => { release = resolve; });
    // Both hands read the same starting Elo before either commits.
    const gated = {
      prepare(sql: string) {
        const statement = db.prepare(sql);
        if (!sql.startsWith('SELECT telegram_id, elo, games_played FROM users')) return statement;
        return { bind: (...values: unknown[]) => ({ async all() {
          const result = await statement.bind(...values).all();
          if (++reads === 2) release();
          await bothRead;
          return result;
        } }) };
      },
      batch: (statements: D1PreparedStatement[]) => db.batch(statements),
    } as unknown as D1Database;
    const second = players();
    second[1] = { ...second[1], id: 'tg_105', name: 'Eve' };
    const c1 = buildCompletion(finishedState({ gameId: 'hand-1' }), { kind: 'completed', bidderWon: true }, null);
    const c2 = buildCompletion(finishedState({ gameId: 'hand-2', players: second }), { kind: 'completed', bidderWon: true }, null);
    await Promise.all([persistRatedResult(gated, c1), persistRatedResult(gated, c2)]);
    expect((await users()).map((u) => [u.telegram_id, u.elo, u.games_played])).toEqual([
      [101, 1032, 2], [102, 984, 1], [103, 1032, 2], [104, 968, 2], [105, 984, 1],
    ]);
  });

  it('still records legacy stats when the rating tables have not been migrated', async () => {
    harness = await createBridgeHarness({ skipMigrations: ['0013_bridge_rating_foundation.sql', '0014_bridge_season_2.sql'] });
    const { room, ws } = await playLastCard('NOTABLES');
    const after = await waitFor(() => readRoom(room), (r) => r.state.phase === 'gameover' && r.completions.length === 0);
    ws.close();
    expect(after.alarm).toBeNull();
    expect(await count('game_records')).toBe(4);
    expect((await users())[0]).toMatchObject({ elo: 1016, games_played: 1 });
    await waitFor(async () => harness!.telegram.length, (n) => n === 1);
  });

  it('replaces the recorded starting hands after an all-pass redeal', async () => {
    harness = await createBridgeHarness();
    const room = await harness.room('REDEAL');
    const passes = players().slice(0, 3).map((p) => ({ seat: p.seat, name: p.name, bidNum: null }));
    const bidding = nearFinalState({
      phase: 'bidding', hands: dealBySuit(), bidder: -1, bid: -1, partner: -1, partnerCard: null, trumpSuit: null,
      setsNeeded: -1, sets: [0, 0, 0, 0], passCount: 3, turn: 3, playedCards: [null, null, null, null],
      currentSuit: null, trickLog: [], bidHistory: passes, partnerRevealed: false,
    });
    await writeRoom(room, { state: bidding });
    await insertGameHands(harness.db, 'game-fixture', bidding.players, bidding.hands);
    const dealtAt = await harness.db.prepare('SELECT played_at FROM game_hands WHERE seat = 0').first<{ played_at: number }>();

    const ws = await connect(room, 'tg_104');
    ws.send(JSON.stringify({ type: 'pass' }));
    const after = await waitFor(() => readRoom(room), (r) => r.state.redealCount === 1);
    ws.close();

    expect(after.state.bidHistory).toEqual([]);
    expect(after.state.initialHands).toEqual(after.state.hands);
    expect(after.state.initialHands).not.toEqual(dealBySuit());
    const newSeat0 = (['♣', '♦', '♥', '♠'] as const).flatMap((suit) => after.state.hands[0][suit].map((v: string) => `${v} ${suit}`));
    const logged = await waitFor(
      () => harness!.db.prepare('SELECT initial_hand, played_at FROM game_hands WHERE game_id = ? AND seat = 0').bind('game-fixture').first<{ initial_hand: string; played_at: number }>(),
      (row) => row?.initial_hand === JSON.stringify(newSeat0),
    );
    expect(logged!.played_at).toBe(dealtAt!.played_at);
  });

  it('ledgers an abandoned hand for the trial without rating anyone', async () => {
    harness = await createBridgeHarness();
    const room = await harness.room('ABANDON');
    const state = nearFinalState({ players: players().map((p) => ({ ...p, connected: p.seat === 0 })) });
    await writeRoom(room, { state, ratingSnapshot: snapshot() });
    const ws = await connect(room, 'tg_101');
    ws.send(JSON.stringify({ type: 'initiateAbandon' }));
    await waitFor(() => readRoom(room), (r) => r.state.phase === 'lobby' && r.completions.length === 0);
    ws.close();

    expect(await harness.db.prepare('SELECT status, bidder_won, skill_applied, skill_reason, bidder_tricks, tricks_played FROM bridge_game_ledger').first())
      .toEqual({ status: 'abandoned', bidder_won: null, skill_applied: 0, skill_reason: 'abandoned', bidder_tricks: 6, tricks_played: 12 });
    expect(await count('bridge_deal_features', 'won IS NULL')).toBe(4);
    expect(await count('bridge_rating_events')).toBe(0);
    expect(await count('game_records')).toBe(0);
    expect((await users()).every((u) => u.elo === 1000)).toBe(true);
    expect(harness.telegram).toHaveLength(0);
  });
});
