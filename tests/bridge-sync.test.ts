import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { webcrypto } from 'node:crypto';
import { dealBySuit, players } from './bridge-fixtures';

// Execute Bridge's actual browser connection code with controllable transport
// and time. Live Worker/WebSocket coverage lives in bridge-sync.pw.js.
function browserFixture() {
  vi.useFakeTimers();
  const sockets: any[] = [];
  const events: Record<string, () => void> = {};
  const overlay = new Set(['hidden']);
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    sent: any[] = [];
    onopen: any;
    onclose: any;
    onmessage: any;
    close = vi.fn(() => { this.readyState = 3; this.onclose?.(); });
    constructor() { sockets.push(this); }
    send(value: string) { this.sent.push(JSON.parse(value)); }
    open() { this.readyState = 1; this.onopen(); }
    receive(value: any) { this.onmessage({ data: JSON.stringify(value) }); }
  }
  const context: any = vm.createContext({
    WebSocket: Socket, Date, setTimeout, clearTimeout, setInterval, clearInterval,
    ws: null, roomCode: 'LOCAL', playerId: 'tg_1', playerName: 'Alice',
    identityReady: true, identityNeedsLogin: false, authToken: null, joinAs: null,
    reconnectTimer: null, reconnectDelay: 2000, connectionWatchdog: null,
    gameState: null, pendingPlay: null, awaitingGameState: true,
    normalizePlayerName: (name: string) => name, requestPlayerName: vi.fn(),
    CardHand: { cancelAll: vi.fn() }, renderState: vi.fn(),
    location: { protocol: 'http:', host: 'localhost' },
    document: { hidden: false, addEventListener: (name: string, fn: () => void) => { events[name] = fn; } },
    window: { addEventListener: (name: string, fn: () => void) => { events[name] = fn; } },
    $: () => ({ classList: { add: (name: string) => overlay.add(name), remove: (name: string) => overlay.delete(name) } }),
  });
  context.handleMessage = vi.fn((msg: any) => {
    if (msg.type === 'state') { context.gameState = msg.state; context.awaitingGameState = false; }
  });
  const source = fs.readFileSync('static/app.js', 'utf8');
  vm.runInContext(source.slice(source.indexOf('// --- WebSocket ---'), source.indexOf('// --- Sounds ---')), context);
  context.connect();
  const socket = sockets[0];
  const ready = () => { socket.open(); socket.receive({ type: 'state', state: { turn: 0 } }); };
  return { context, sockets, socket, ready, overlay, events };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('Bridge connection recovery', () => {
  it.each([false, true])('replaces a connection that never supplies its first state (open=%s)', open => {
    const { context, socket, sockets, overlay } = browserFixture();
    if (open) socket.open();
    vi.advanceTimersByTime(10000);
    expect(context.ws).toBeNull();
    expect(overlay.has('hidden')).toBe(false);
    expect(socket.close).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(2000);
    expect(sockets).toHaveLength(2);
  });

  it('repairs a missed broadcast on an open socket using a correlated state request', () => {
    const { context, socket, ready, sockets, overlay } = browserFixture(); ready();
    vi.advanceTimersByTime(15000);
    expect(socket.sent.at(-1)).toEqual({ type: 'sync', requestId: 1 });
    socket.receive({ type: 'state', requestId: 1, state: { turn: 3 } });
    expect(context.gameState.turn).toBe(3);
    expect(context.awaitingGameState).toBe(false);
    expect(overlay.has('hidden')).toBe(true);
    expect(sockets).toHaveLength(1);
  });

  it('reconnects a half-open socket even if chat/pongs/ordinary snapshots still arrive', () => {
    const { context, socket, ready, sockets } = browserFixture(); ready();
    vi.advanceTimersByTime(15000);
    const delayedMessage = socket.onmessage;
    socket.receive({ type: 'chat' });
    socket.onmessage({ data: 'pong' });
    socket.receive({ type: 'state', state: { turn: 1 } });
    vi.advanceTimersByTime(10000);
    expect(context.ws).toBeNull();
    expect(context.awaitingGameState).toBe(true);
    vi.advanceTimersByTime(2000);
    sockets[1].open(); sockets[1].receive({ type: 'state', state: { turn: 2 } });
    delayedMessage({ data: JSON.stringify({ type: 'state', state: { turn: 0 } }) });
    expect(context.gameState.turn).toBe(2);
    expect(socket.sent.filter((msg: any) => msg.type !== 'join' && msg.type !== 'sync')).toEqual([]);
  });

  it.each(['visibilitychange', 'online', 'pageshow', 'focus'])('refreshes an OPEN socket on %s and coalesces repeated wakeups', event => {
    const { context, socket, ready, overlay, events } = browserFixture(); ready();
    events[event](); events[event]();
    expect(socket.sent.filter((msg: any) => msg.type === 'sync')).toHaveLength(1);
    expect(context.awaitingGameState).toBe(true);
    expect(overlay.has('hidden')).toBe(false);
    context.send({ type: 'bid', bidNum: 1 });
    expect(socket.sent.some((msg: any) => msg.type === 'bid')).toBe(false);
    socket.receive({ type: 'state', requestId: 99, state: { turn: 99 } });
    expect(context.gameState.turn).toBe(0);
    expect(context.awaitingGameState).toBe(true);
    socket.receive({ type: 'state', requestId: 1, state: { turn: 1 } });
    expect(context.awaitingGameState).toBe(false);
    expect(overlay.has('hidden')).toBe(true);
    context.send({ type: 'bid', bidNum: 1 });
    expect(socket.sent.at(-1)).toEqual({ type: 'bid', bidNum: 1 });
  });

  it('releases an unacknowledged card without replaying it', () => {
    const { context, socket, ready } = browserFixture(); ready();
    context.pendingPlay = { value: 'A', suit: '♠' };
    vi.advanceTimersByTime(15000);
    socket.receive({ type: 'state', requestId: 1, state: { turn: 0 } });
    expect(context.pendingPlay).toBeNull();
    expect(socket.sent.map((msg: any) => msg.type)).toEqual(['join', 'sync']);
  });

  it('does not release a card played after the recovery request was sent', () => {
    const { context, socket, ready } = browserFixture(); ready();
    vi.advanceTimersByTime(15000);
    context.pendingPlay = { value: 'K', suit: '♠' };
    socket.receive({ type: 'state', requestId: 1, state: { turn: 0 } });
    expect(context.pendingPlay).toEqual({ value: 'K', suit: '♠' });
  });

  it('blocks stale input on wake even if a periodic sync is already pending', () => {
    const { context, socket, ready, events } = browserFixture(); ready();
    vi.advanceTimersByTime(15000);
    events.focus();
    expect(context.awaitingGameState).toBe(true);
    expect(socket.sent.filter((msg: any) => msg.type === 'sync')).toHaveLength(1);
    context.send({ type: 'pass' });
    expect(socket.sent.some((msg: any) => msg.type === 'pass')).toBe(false);
  });

  it('skips background polls and immediately replaces an expired request on wake', () => {
    const { context, socket, ready, events } = browserFixture(); ready();
    context.document.hidden = true;
    vi.advanceTimersByTime(30000);
    expect(socket.sent).toHaveLength(1);
    context.document.hidden = false;
    events.visibilitychange();
    vi.setSystemTime(Date.now() + 11000); // suspended timers, as when a phone sleeps
    events.visibilitychange();
    expect(context.ws).toBeNull();
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it('cancels all deadlines/polls when the room or identity is intentionally left', () => {
    const { context, socket, ready, sockets } = browserFixture(); ready();
    context.stopConnectionWatchdog(); context.ws = null; context.roomCode = null;
    vi.advanceTimersByTime(60000);
    expect(sockets).toHaveLength(1);
    expect(socket.sent).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers when sending the state request throws', () => {
    const { context, socket, ready } = browserFixture(); ready();
    socket.send = () => { throw new Error('network lost'); };
    vi.advanceTimersByTime(15000);
    expect(context.ws).toBeNull();
    expect(socket.close).toHaveBeenCalledOnce();
  });
});

function roomFixture() {
  function load(file: string, globals: Record<string, unknown> = {}) {
    const exports = {};
    const source = fs.readFileSync(file, 'utf8').replace(/^import .*;\r?\n/gm, '');
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInNewContext(code, { exports, crypto: webcrypto, structuredClone, ...globals }, { filename: file });
    return exports as any;
  }
  const { GameRoom } = load('src/game-room.ts', { ...load('src/types.ts'), ...load('src/player-name.ts'),
    DurableObject: class { constructor(public ctx: any, public env: any) {} }, WebSocketRequestResponsePair: class {} });
  let state: any;
  const storage = { get: async () => structuredClone(state), put: vi.fn() };
  const room = new GameRoom({ storage, getWebSockets: () => [], setWebSocketAutoResponse() {} }, {});
  state = room.createInitialState('LOCAL');
  state.players = players(); state.hands = dealBySuit(); state.phase = 'play';
  state.spectators = [{ id: 'watch', name: 'Watcher', watchingSeat: 1 }];
  return { room, state, storage };
}

describe('Bridge read-only sync protocol', () => {
  it.each(['tg_101', 'watch', 'outsider'])('returns only the permitted view for %s without writing or broadcasting', async id => {
    const { room, state, storage } = roomFixture();
    const ws = { send: vi.fn() }; const other = { send: vi.fn() };
    room.sessions.set(ws, { playerId: id }); room.sessions.set(other, { playerId: 'tg_102' });
    await room.webSocketMessage(ws, JSON.stringify({ type: 'sync', requestId: 7 }));
    const msg = JSON.parse(ws.send.mock.calls[0][0]);
    expect(msg.type).toBe('state'); expect(msg.requestId).toBe(7);
    expect(msg.state.hand).toEqual(id === 'tg_101' ? state.hands[0] : id === 'watch' ? state.hands[1] : null);
    expect(msg.state.allHands).toBeNull();
    expect(msg.state.mySeat).toBe(id === 'tg_101' ? 0 : id === 'watch' ? 1 : -1);
    expect(storage.put).not.toHaveBeenCalled(); expect(other.send).not.toHaveBeenCalled();
  });

  it.each([-1, null, '1', 1.5, Number.MAX_SAFE_INTEGER + 1])('ignores invalid request IDs (%s)', async requestId => {
    const { room, storage } = roomFixture(); const ws = { send: vi.fn() };
    room.sessions.set(ws, { playerId: 'tg_101' });
    await room.webSocketMessage(ws, JSON.stringify({ type: 'sync', requestId }));
    expect(ws.send).not.toHaveBeenCalled(); expect(storage.put).not.toHaveBeenCalled();
  });
});
