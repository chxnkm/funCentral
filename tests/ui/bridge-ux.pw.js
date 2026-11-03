// Bridge and hub refresh: the contract strip, open seats, toast errors, the abandon dialog,
// seat plates clearing the trick, and the hub's game links and Telegram entry point.
// Real local Worker serving every static file; Bridge views are injected through the page's
// own globals, as the fixture tests do.
const { test, expect } = require('@playwright/test');
const { startWorker } = require('./live-worker.cjs');
test.setTimeout(120000);
let worker;
test.beforeAll(async () => { worker = await startWorker(4237); });
test.afterAll(async () => { await worker?.stop(); });

const C = '♣', D = '♦', H = '♥', S = '♠';
const HAND = { [C]: ['A', 'K', 'Q', '10'], [D]: ['A', 'J', '8'], [H]: ['K', '9', '7'], [S]: ['Q', '8', '2'] };
const PLAYERS = ['Alex', 'Blair', 'Casey', 'Drew'].map((name, seat) => ({ name, seat, connected: true }));
const PLAY = {
  phase: 'play', roomCode: 'BRUX', gameId: 'ux-1', hand: HAND, mySeat: 0, turn: 0, bid: 7, bidder: 0, trumpSuit: H, trumpBroken: true,
  partnerCard: `A ${S}`, partnerSeat: -1, playedCards: [null, `J ${C}`, `7 ${C}`, `9 ${C}`], currentSuit: C, sets: [2, 1, 2, 1], setsNeeded: 8,
  bidHistory: [{ seat: 0, name: 'Alex', bidNum: 7 }], isSpectator: false, spectators: [], isPractice: false, readySeats: [], players: PLAYERS,
  lastTrick: { cards: [`K ${D}`, `5 ${D}`, `2 ${D}`, `Q ${D}`], winner: 0 },
};

async function bridge(browser, viewport = { width: 390, height: 844 }) {
  const context = await browser.newContext({ viewport, isMobile: viewport.width < 900, hasTouch: viewport.width < 900 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err));
  page.on('dialog', (dialog) => { errors.push(new Error(`unexpected ${dialog.type()}: ${dialog.message()}`)); dialog.dismiss(); });
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/ws') return route.abort();
    return url.origin === worker.origin ? route.continue() : route.abort();
  });
  await page.addInitScript(() => localStorage.setItem('bridge.tableView', 'classic'));
  await page.goto(`${worker.origin}/bridge/`);
  return { page, context, errors };
}
async function show(page, state) {
  await page.evaluate((s) => {
    window.sentMoves = [];
    ws = { readyState: WebSocket.OPEN, send: (m) => window.sentMoves.push(JSON.parse(m)), close() {} };
    roomCode = s.roomCode;
    playerName = 'Alex';
    prevTurn = s.turn;
    lastGameOver = null;
    gameState = s;
    showScreen(`screen-${s.phase}`);
    handleMessage({ type: 'state', state: s });
  }, state);
}
async function done({ context, errors }) {
  expect(errors).toEqual([]);
  await context.close();
}

test('the contract strip shows the bid, a secret partner, trumps and trick progress; the partner is named once revealed', async ({ browser }) => {
  const c = await bridge(browser);
  try {
    await show(c.page, PLAY);
    await expect(c.page.locator('#play-bid-info')).toContainText('Contract');
    await expect(c.page.locator('#play-bid-info')).toContainText(`2 ${H}`);
    await expect(c.page.locator('#play-bid-info')).toContainText('Alex');
    await expect(c.page.locator('#play-partner-info')).toContainText('secret');
    await expect(c.page.locator('#play-trump-info')).toContainText(H);
    await expect(c.page.locator('#play-contract-progress')).toContainText('2/8');
    await expect(c.page.locator('#play-contract-progress .cp-def')).toHaveCount(0);
    // Seat plates carry an avatar initial and the trick count.
    await expect(c.page.locator('#seat-top-label .seat-avatar')).toHaveText('C');
    await expect(c.page.locator('#seat-top-label .seat-sets')).toHaveText('2');

    await show(c.page, { ...PLAY, partnerSeat: 2 });
    await expect(c.page.locator('#play-partner-info')).toContainText('Casey');
    await expect(c.page.locator('#play-contract-progress')).toContainText('Alex & Casey');
    await expect(c.page.locator('#play-contract-progress')).toContainText('4/8');
    await expect(c.page.locator('#play-contract-progress .cp-def')).toContainText('2/6');
    await expect(c.page.locator('#play-contract-progress')).toHaveCount(1);

    await show(c.page, { ...PLAY, bid: 9, trumpSuit: '🚫', setsNeeded: 8 });
    await expect(c.page.locator('#play-trump-info')).toContainText('No trump');
  } finally { await done(c); }
});

test('the lobby shows open seats without disturbing the player rows', async ({ browser }) => {
  const c = await bridge(browser);
  try {
    await show(c.page, { ...PLAY, phase: 'lobby', players: PLAYERS.slice(0, 2), gameStartAt: null });
    await expect(c.page.locator('#lobby-players .player-item')).toHaveCount(2);
    await expect(c.page.locator('#lobby-players .lobby-open-seat')).toHaveCount(2);
    await expect(c.page.locator('#lobby-players .lobby-open-seat').first()).toContainText('Open seat');
    await expect(c.page.locator('.lobby-bots')).toBeVisible();
    await show(c.page, { ...PLAY, phase: 'lobby', players: PLAYERS, gameStartAt: null });
    await expect(c.page.locator('#lobby-players .lobby-open-seat')).toHaveCount(0);
    await expect(c.page.locator('.lobby-bots')).toBeHidden();
  } finally { await done(c); }
});

test('errors are toasts, not browser dialogs, and the abandon vote is a styled dialog', async ({ browser }) => {
  const c = await bridge(browser);
  try {
    await show(c.page, PLAY);
    await c.page.evaluate(() => handleMessage({ type: 'error', message: 'That card cannot be played' }));
    await expect(c.page.locator('.connection-toast.toast-error')).toContainText('That card cannot be played');
    await expect(c.page.locator('.connection-toast.toast-error')).toHaveAttribute('role', 'alert');

    await c.page.evaluate(() => handleMessage({ type: 'abandonVotePrompt', timeoutSeconds: 60 }));
    const dialog = c.page.getByRole('alertdialog', { name: 'Abandon this deal?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#vote-no')).toBeFocused();
    await dialog.locator('#vote-no').click();
    await expect(dialog).toHaveCount(0);
    expect(await c.page.evaluate(() => sentMoves)).toEqual([{ type: 'respondAbandon', accept: false }]);

    await c.page.evaluate(() => handleMessage({ type: 'youArePartner', bidderName: 'Alex' }));
    await expect(c.page.locator('.partner-reveal-banner')).toContainText("Alex's secret partner");
  } finally { await done(c); }
});

for (const viewport of [{ width: 320, height: 740 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1366, height: 900 }]) {
  test(`Classic seat plates clear the trick, the last trick and each other at ${viewport.width}×${viewport.height}`, async ({ browser }) => {
    const c = await bridge(browser, viewport);
    try {
      await show(c.page, { ...PLAY, playedCards: [`A ${C}`, `J ${C}`, `7 ${C}`, `9 ${C}`] });
      const overlaps = await c.page.evaluate(() => {
        const rect = (n) => n.getBoundingClientRect();
        const others = [...document.querySelectorAll('#trick-area .card-mini')].map((n) => ({ id: `trick ${n.parentElement.className}`, r: rect(n) }));
        others.push({ id: 'last-trick-panel', r: rect(document.getElementById('last-trick-panel')) });
        const labels = [...document.querySelectorAll('#play-table .seat-label')].map((n) => ({ id: n.id, r: rect(n) }));
        const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
        const out = [];
        labels.forEach((l, i) => {
          for (const o of [...others, ...labels.slice(i + 1)]) if (hit(l.r, o.r)) out.push(`${l.id} × ${o.id}`);
        });
        return out;
      });
      expect(overlaps).toEqual([]);
      expect(await c.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await done(c); }
  });
}

test('the hub links each game once, offers the Telegram group link and greets a signed-in player', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err));
  await page.route('**/*', (route) => (new URL(route.request().url()).origin === worker.origin ? route.continue() : route.abort()));
  const { token } = await (await fetch(`${worker.origin}/api/auth/dev`, { method: 'POST', body: JSON.stringify({ displayName: 'Hub Reader' }) })).json();
  await page.addInitScript((t) => localStorage.setItem('authToken', t), token);
  try {
    await page.goto(worker.origin);
    for (const [name, href] of [[/Floating Bridge/, '/bridge/'], [/Regicide/, '/regicide/'], [/Tai Di/, '/taidi/']]) {
      await expect(page.getByRole('link', { name })).toHaveAttribute('href', href);
    }
    // The worker's configured bot name (local_test_only here) drives the Telegram link.
    await expect(page.locator('#hub-telegram')).toHaveAttribute('href', 'https://t.me/local_test_only?startgroup=true');
    await expect(page.locator('#hub-telegram-note')).toBeVisible();
    await expect(page.locator('#hub-greeting')).toHaveText('Welcome back, Hub Reader');
    await expect(page.locator('.game-tile .hub-card').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
