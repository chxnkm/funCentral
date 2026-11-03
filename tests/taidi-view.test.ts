import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTaiDiHarness, connect, readRoom } from './taidi-persistence-harness';

type Harness = Awaited<ReturnType<typeof createTaiDiHarness>>;
let worker: Harness;

/** Opens a socket as tg_<id> and resolves with the first view the room sends it. */
async function firstView(room: Awaited<ReturnType<Harness['room']>>, id: number) {
  const response = await room.fetch(`https://room.test/?playerId=tg_${id}&name=Player${id}`, { headers: { Upgrade: 'websocket' } });
  const ws = response.webSocket!;
  const view = new Promise<any>((resolve) => ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.type === 'state') resolve(msg);
  }));
  ws.accept();
  try { return await view; } finally { try { ws.close(1000); } catch {} }
}

describe('Tai Di per-player view', () => {
  beforeAll(async () => {
    worker = await createTaiDiHarness();
    await worker.db.prepare('CREATE TABLE IF NOT EXISTS users (telegram_id INTEGER PRIMARY KEY, display_name TEXT NOT NULL)').run();
  }, 30000);
  afterAll(async () => { await worker?.stop(); });

  it('keeps other hands hidden during play and reveals every hand once the game is over', async () => {
    const room = await worker.room('reveal-at-end');
    expect((await room.fetch('https://room.test/create', { method: 'POST', body: JSON.stringify({ roomCode: 'VIEW', seed: 9 }) })).status).toBe(200);
    const host = await connect(room, 1);
    const guest = await connect(room, 2);
    try {
      host.send(JSON.stringify({ type: 'join', name: 'Host' }));
      guest.send(JSON.stringify({ type: 'join', name: 'Guest' }));
      await expect.poll(async () => (await readRoom(room)).state.players.length).toBe(2);
      host.send(JSON.stringify({ type: 'start' }));
      await expect.poll(async () => (await readRoom(room)).state.game?.phase ?? null).toBe('play');

      const { state } = await readRoom(room);
      Object.assign(state.game, { hands: [['KS'], ['3C', '5D']], currentSeat: 0, table: null, mustInclude: null, passes: 0 });
      await room.fetch('https://room.test/__state', { method: 'POST', body: JSON.stringify(state) });

      const during = await firstView(room, 2);
      expect(during.game.revealed).toBeNull();
      expect(during.game.hand).toEqual(['3C', '5D']);
      expect(JSON.stringify(during)).not.toContain('"KS"');

      const hostAgain = await connect(room, 1);
      try {
        hostAgain.send(JSON.stringify({ type: 'play', cards: ['KS'] }));
        await expect.poll(async () => (await readRoom(room)).state.game?.phase ?? null).toBe('done');
      } finally { try { hostAgain.close(1000); } catch {} }

      const after = await firstView(room, 2);
      expect(after.game.revealed).toEqual([[], ['3C', '5D']]);
      expect(after.game.placements).toEqual([1, 2]);
    } finally {
      try { host.close(1000); } catch {}
      try { guest.close(1000); } catch {}
    }
  }, 30000);
});
