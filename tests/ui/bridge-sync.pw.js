const { test, expect } = require('@playwright/test');
const { startWorker } = require('./live-worker.cjs');

let worker;
test.setTimeout(60000);
test.beforeAll(async () => { worker = await startWorker(4234); });
test.afterAll(async () => { await worker?.stop(); });

async function room() {
  const response = await fetch(`${worker.origin}/api/create`, { method: 'POST', body: '{}' });
  expect(response.ok).toBe(true);
  return (await response.json()).roomCode;
}

test('two tabs with the same identity do not repeatedly replace each other', async ({ browser }) => {
  const code = await room();
  const a = await client(browser, code, 'Same Bridge player', 'classic', true);
  let b;
  try {
    await a.page.clock.pauseAt(new Date(Date.now() + 1000));
    b = await client(browser, code, 'Same Bridge player', 'classic');
    await expect.poll(() => a.page.evaluate(() => ws === null)).toBe(true);
    expect(await a.page.evaluate(() => playerId)).toBe(await b.page.evaluate(() => playerId));
    await a.page.clock.fastForward(60000);
    // The displaced tab must stay paused rather than evicting the new tab.
    expect(await a.page.evaluate(() => sentFrames.filter(msg => msg.type === 'join').length)).toBe(1);
    expect(await b.page.evaluate(() => ws?.readyState === WebSocket.OPEN && !awaitingGameState)).toBe(true);
    await a.page.evaluate(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      for (const name of ['focus', 'online', 'pageshow']) window.dispatchEvent(new Event(name));
    });
    expect(await a.page.evaluate(() => ws)).toBeNull();
    await expect(a.page.locator('#reconnect-status')).toHaveText('This game is active in another tab or browser.');
    await a.page.screenshot({ path: test.info().outputPath('session-replaced-mobile.png'), animations: 'disabled' });
    await a.page.getByRole('button', { name: 'Reconnect here', exact: true }).click();
    await expect.poll(() => a.page.evaluate(() => ws?.readyState === WebSocket.OPEN && !awaitingGameState)).toBe(true);
    await expect.poll(() => b.page.evaluate(() => ws === null)).toBe(true);
    expect(await a.page.evaluate(() => gameState.players.length)).toBe(1);
    expect(await a.page.evaluate(() => sentFrames.filter(msg => msg.type === 'join').length)).toBe(2);
    // Taking the game back is explicit and retains the same seat, without
    // causing the displaced second tab to fight back on its next foreground.
    await b.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    expect(await b.page.evaluate(() => ws)).toBeNull();
    await b.page.getByRole('button', { name: 'Leave room', exact: true }).click();
    await expect(b.page.locator('#screen-home')).toBeVisible();
    expect(a.errors).toEqual([]); expect(b.errors).toEqual([]);
  } finally { await a.context.close(); await b?.context.close(); }
});

async function client(browser, code, name, mode, mobile = false) {
  const login = await fetch(`${worker.origin}/api/auth/dev`, { method: 'POST', body: JSON.stringify({ displayName: name }) });
  expect(login.ok).toBe(true);
  const { token } = await login.json();
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1366, height: 900 },
    isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === worker.origin ? route.continue() : route.abort());
  await page.addInitScript(({ code, name, token, mode }) => {
    localStorage.setItem('authToken', token); localStorage.setItem('playerName', name);
    localStorage.setItem('bridge.tableView', mode);
    sessionStorage.setItem('roomCode', code); sessionStorage.setItem('joinRole', 'player');
    window.sentFrames = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function(value) { sentFrames.push(JSON.parse(value)); return send.call(this, value); };
  }, { code, name, token, mode });
  await page.clock.install();
  await page.goto(`${worker.origin}/bridge/`);
  await expect.poll(() => page.evaluate(() => gameState?.mySeat)).toBeGreaterThanOrEqual(0);
  return { context, page, errors };
}

for (const mode of ['classic', '25d']) {
  test(`missed live card broadcasts recover on the same OPEN socket (${mode})`, async ({ browser }) => {
    const code = await room(); const clients = [];
    try {
      for (let i = 0; i < 4; i++) clients.push(await client(browser, code, `Sync ${mode} ${i}`, mode, i % 2 === 1));
      await expect.poll(() => clients[0].page.evaluate(() => gameState?.phase), { timeout: 15000 }).toBe('bidding');
      const bySeat = [];
      for (const c of clients) {
        await expect.poll(() => c.page.evaluate(() => gameState?.phase)).toBe('bidding');
        bySeat[await c.page.evaluate(() => gameState.mySeat)] = c;
      }
      const state = () => clients[0].page.evaluate(() => gameState);
      await bySeat[(await state()).turn].page.locator('.bid-btn:enabled').first().click();
      await expect.poll(async () => (await state()).bid).toBeGreaterThanOrEqual(0);
      for (let i = 0; i < 3; i++) {
        const turn = (await state()).turn;
        await bySeat[turn].page.locator('#btn-pass').click();
        await expect.poll(async () => i === 2 ? (await state()).phase : (await state()).turn).not.toBe(i === 2 ? 'bidding' : turn);
      }
      await bySeat[(await state()).bidder].page.locator('.partner-card-btn:enabled').first().click();
      await expect.poll(async () => (await state()).phase).toBe('play');
      const turn = (await state()).turn;
      const actor = bySeat[turn]; const observer = bySeat[(turn + 1) % 4];
      await expect.poll(() => observer.page.evaluate(() => gameState.phase)).toBe('play');
      await observer.page.clock.pauseAt(new Date(Date.now() + 1000));
      const before = await observer.page.evaluate(() => {
        window.originalSocket = ws; window.originalMessage = ws.onmessage;
        window.syncReplies = 0;
        ws.onmessage = event => {
          const msg = JSON.parse(event.data);
          if (msg.type === 'state' && msg.requestId === undefined) return; // lose only game broadcasts
          if (msg.type === 'state' && msg.requestId !== undefined) syncReplies++;
          originalMessage(event);
        };
        return { gameId: gameState.gameId, hand: gameState.hand, mySeat: gameState.mySeat, joins: sentFrames.filter(m => m.type === 'join').length };
      });
      // A real accepted card, delivered to the other clients, never updates the
      // observer's view until the watchdog requests an authoritative snapshot.
      await actor.page.locator('#play-hand .hand-card:not(.disabled)').first().focus();
      await actor.page.keyboard.press('Enter');
      await expect.poll(() => actor.page.evaluate(() => gameState.turn)).not.toBe(turn);
      expect(await observer.page.evaluate(() => gameState.turn)).toBe(turn);
      expect(await observer.page.evaluate(() => ws.readyState)).toBe(WebSocket.OPEN);
      await observer.page.clock.fastForward(15000);
      await expect.poll(() => observer.page.evaluate(() => gameState.turn)).toBe((turn + 1) % 4);
      expect(await observer.page.evaluate(() => ({ gameId: gameState.gameId, hand: gameState.hand, mySeat: gameState.mySeat,
        joins: sentFrames.filter(m => m.type === 'join').length }))).toEqual(before);
      expect(await observer.page.evaluate(() => ws === originalSocket && syncReplies > 0 && !awaitingGameState)).toBe(true);
      // The screen now exposes that player's legal cards instead of waiting for
      // someone else's turn, with no reload or additional join.
      await expect(observer.page.locator('#play-hand .hand-card:not(.disabled)')).not.toHaveCount(0);
      await expect(observer.page.locator('#overlay-reconnect')).toBeHidden();
      for (const c of clients) expect(c.errors).toEqual([]);
    } finally { for (const c of clients) await c.context.close(); }
  });

  test(`half-open connection recovers automatically and rejects late frames (${mode})`, async ({ browser }) => {
    const code = await room(); const a = await client(browser, code, `Offline A ${mode}`, mode, true);
    let b;
    try {
      await a.page.clock.pauseAt(new Date(Date.now() + 1000));
      const before = await a.page.evaluate(() => {
        window.originalSocket = ws; window.delayedMessage = ws.onmessage; window.staleView = structuredClone(gameState);
        window.blockedSyncs = 0;
        ws.onmessage = () => {}; // silent network failure, readyState stays OPEN
        const send = ws.send.bind(ws);
        ws.send = value => { if (JSON.parse(value).type === 'sync') { blockedSyncs++; return; } send(value); };
        return { id: playerId, seat: gameState.mySeat };
      });
      b = await client(browser, code, `Offline B ${mode}`, mode);
      await expect.poll(() => b.page.evaluate(() => gameState.players.length)).toBe(2);
      expect(await a.page.evaluate(() => gameState.players.length)).toBe(1);
      expect(await a.page.evaluate(() => ws.readyState)).toBe(WebSocket.OPEN);
      await a.page.clock.fastForward(15000);
      expect(await a.page.evaluate(() => blockedSyncs)).toBe(1);
      await a.page.clock.fastForward(10000);
      await expect(a.page.locator('#overlay-reconnect')).toBeVisible();
      expect(await a.page.evaluate(() => awaitingGameState)).toBe(true);
      await a.page.clock.fastForward(2000);
      await expect.poll(() => a.page.evaluate(() => gameState.players.length)).toBe(2);
      expect(await a.page.evaluate(() => ws !== originalSocket && ws.readyState === WebSocket.OPEN)).toBe(true);
      expect(await a.page.evaluate(() => ({ id: playerId, seat: gameState.mySeat }))).toEqual(before);
      await a.page.evaluate(() => delayedMessage({ data: JSON.stringify({ type: 'state', state: staleView }) }));
      expect(await a.page.evaluate(() => gameState.players.length)).toBe(2);
      await expect(a.page.locator('#overlay-reconnect')).toBeHidden();
      // A tab/network wake also refreshes a socket that still looks healthy.
      await a.page.evaluate(() => {
        window.resumedSocket = ws; window.droppedStates = 0;
        const message = ws.onmessage;
        ws.onmessage = event => {
          const msg = JSON.parse(event.data);
          if (msg.type === 'state' && msg.requestId === undefined) { droppedStates++; return; }
          message(event);
        };
      });
      await b.page.evaluate(() => leaveGame());
      await expect.poll(() => a.page.evaluate(() => droppedStates)).toBeGreaterThan(0);
      expect(await a.page.evaluate(() => gameState.players.length)).toBe(2);
      await a.page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
      await expect.poll(() => a.page.evaluate(() => gameState.players.length)).toBe(1);
      expect(await a.page.evaluate(() => ws === resumedSocket && !awaitingGameState)).toBe(true);
      // Intentional leave cancels the watchdog rather than pulling the player
      // back into a room after the next timeout.
      await a.page.evaluate(() => leaveGame());
      const frames = await a.page.evaluate(() => sentFrames.length);
      await a.page.clock.fastForward(60000);
      expect(await a.page.evaluate(() => ({ ws, roomCode, frames: sentFrames.length }))).toEqual({ ws: null, roomCode: null, frames });
      expect(a.errors).toEqual([]); expect(b.errors).toEqual([]);
    } finally { await a.context.close(); await b?.context.close(); }
  });
}
