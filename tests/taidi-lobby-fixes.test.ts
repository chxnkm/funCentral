import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTaiDiHarness, connect, readRoom } from './taidi-persistence-harness';
import { getTaiDiLeaderboard } from '../src/taidi/db';

type Harness = Awaited<ReturnType<typeof createTaiDiHarness>>;
let worker: Harness;

const create = async (room: any) => {
  const response = await room.fetch('https://room.test/create', {
    method: 'POST', body: JSON.stringify({ roomCode: 'TEST', seed: 5 }),
  });
  expect(response.status).toBe(200);
};

describe('Tai Di lobby fixes (vocsong PR #80 review)', () => {
  beforeAll(async () => {
    worker = await createTaiDiHarness();
    await worker.db.prepare('CREATE TABLE IF NOT EXISTS users (telegram_id INTEGER PRIMARY KEY, display_name TEXT NOT NULL)').run();
  }, 30000);
  afterAll(async () => { await worker?.stop(); });

  it('a kicked player cannot rejoin the same room (server-side)', async () => {
    const room = await worker.room('kicked-rejoin');
    await create(room);
    const host = await connect(room, 1);
    const guest = await connect(room, 2);
    try {
      host.send(JSON.stringify({ type: 'join', name: 'Host' }));
      guest.send(JSON.stringify({ type: 'join', name: 'Guest' }));
      await expect.poll(async () => (await readRoom(room)).state.players.length).toBe(2);
      host.send(JSON.stringify({ type: 'kick', playerId: 'tg_2' }));
      await expect.poll(async () => (await readRoom(room)).state.players.length).toBe(1);
      // Reconnect-style rejoin attempt on the same socket, and a fresh socket.
      guest.send(JSON.stringify({ type: 'join', name: 'Guest' }));
      await new Promise((r) => setTimeout(r, 300));
      expect((await readRoom(room)).state.players.map((p: any) => p.id)).toEqual(['tg_1']);
      const guest2 = await connect(room, 2);
      try {
        guest2.send(JSON.stringify({ type: 'join', name: 'Guest' }));
        await new Promise((r) => setTimeout(r, 300));
        expect((await readRoom(room)).state.players.map((p: any) => p.id)).toEqual(['tg_1']);
      } finally { try { guest2.close(1000); } catch {} }
    } finally {
      try { host.close(1000); } catch {}
      try { guest.close(1000); } catch {}
    }
  }, 30000);

  it('a player tied at the leaderboard cutoff still gets their own row when cut off by LIMIT', async () => {
    for (const table of ['taidi_games', 'taidi_rating_history', 'taidi_ratings', 'taidi_group_stats']) {
      await worker.db.prepare(`DELETE FROM ${table}`).run();
    }
    await worker.db.prepare('DELETE FROM users').run();
    const players: [number, string, number, number][] = [
      [1, 'Ann', 1100, 10], [2, 'Ben', 1050, 10],
      [3, 'Cat', 1000, 10], [4, 'Dan', 1000, 9], [5, 'Eli', 1000, 8], [6, 'Fay', 1000, 1],
    ];
    for (const [id, name, rating, games] of players) {
      await worker.db.prepare('INSERT OR REPLACE INTO users (telegram_id, display_name) VALUES (?, ?)').bind(id, name).run();
      await worker.db.prepare('INSERT INTO taidi_ratings (telegram_id, rating, games_played, wins, updated_at) VALUES (?, ?, ?, 0, 0)').bind(id, rating, games).run();
    }
    const board = await getTaiDiLeaderboard(worker.db as any, 6, 5);
    expect(board.top.map((e) => e.displayName)).toEqual(['Ann', 'Ben', 'Cat', 'Dan', 'Eli']);
    expect(board.top.map((e) => e.displayName)).not.toContain('Fay');
    // Fay is tied at rank 3, but is not in the returned top 5 rows, so her own row must appear.
    expect(board.me).toEqual({ rank: 3, displayName: 'Fay', elo: 1000, wins: 0, gamesPlayed: 1 });
    // Names are not identity: Cat and Fay can share every field used by the UI guard.
    await worker.db.prepare('UPDATE users SET display_name = ? WHERE telegram_id IN (3, 6)').bind('Same name').run();
    const sameName = await getTaiDiLeaderboard(worker.db as any, 6, 5);
    expect(sameName.top[2]).toMatchObject({ displayName: 'Same name', rank: 3, elo: 1000 });
    expect(sameName.me).toEqual({ rank: 3, displayName: 'Same name', elo: 1000, wins: 0, gamesPlayed: 1 });
    expect((await getTaiDiLeaderboard(worker.db as any, 3, 5)).me).toBeNull();
  });
});
