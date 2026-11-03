import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConnect4RoomHarness, connectSocket, fireAlarm, readRoom } from './connect4-room-harness';

type Harness = Awaited<ReturnType<typeof createConnect4RoomHarness>>;
let harness: Harness;

describe('Connect 4 bot room (live workerd)', () => {
  beforeAll(async () => { harness = await createConnect4RoomHarness(); }, 30000);
  afterAll(async () => { await harness?.stop(); });

  it('schedules and applies a bot reply after the host drops, without rating the game', async () => {
    const room = await harness.room('bot-room');
    const created = await room.fetch('https://internal/create', { method: 'POST', body: JSON.stringify({ roomCode: 'BOT1' }) });
    expect(created.ok).toBe(true);

    const host = await connectSocket(room, 'tg_1', 'Ann');
    await new Promise((r) => setTimeout(r, 20));
    host.send({ type: 'join', name: 'Ann' });
    await new Promise((r) => setTimeout(r, 20));
    host.send({ type: 'addBot' });
    await new Promise((r) => setTimeout(r, 20));

    let state = await readRoom(room);
    expect(state.state.players).toHaveLength(2);
    expect(state.state.players[1].isBot).toBe(true);

    host.send({ type: 'start' });
    await new Promise((r) => setTimeout(r, 20));
    state = await readRoom(room);
    expect(state.state.game).toBeTruthy();
    expect(state.state.game.currentSeat).toBe(0); // host (red) opens

    host.send({ type: 'drop', col: 3 });
    await new Promise((r) => setTimeout(r, 50));
    state = await readRoom(room);
    // The human move is committed and the bot's reply is scheduled.
    expect(state.state.game.moveCount).toBe(1);
    expect(state.state.game.currentSeat).toBe(1);
    expect(state.state.botMoveAt).toBeGreaterThan(Date.now());

    // The alarm fires (here after waiting out the delay, then invoked directly
    // as a fallback) and the bot drops.
    await new Promise((r) => setTimeout(r, 900));
    await fireAlarm(room);
    state = await readRoom(room);
    expect(state.state.game.moveCount).toBe(2);
    expect(state.state.game.currentSeat).toBe(0);
    expect(state.state.botMoveAt).toBeNull();
    expect(state.state.game.board.flat().filter((c: number) => c === 2)).toHaveLength(1);

    // Practice games against a bot are never queued for rating.
    expect(state.state.pendingRatings).toBeUndefined();
    expect(state.state.lastRating).toBeNull();
  });
});
