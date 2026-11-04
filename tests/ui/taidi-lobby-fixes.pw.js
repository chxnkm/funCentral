// Tai Di lobby fixes for vocsong's PR #80 review, driven through a real local
// Worker + Durable Object + D1 in Chromium. Each test also captures a
// screenshot into TAIDI_SHOTS (default: a screenshots folder next to the repo)
// so a PR comment can show the fix working, not just assert it.
const { test, expect } = require('@playwright/test');
const { startWorker } = require('./live-worker.cjs');
const fs = require('node:fs');
const path = require('node:path');
test.setTimeout(240000);
let worker;
const SHOTS = process.env.TAIDI_SHOTS || path.join(__dirname, '..', '..', '..', 'funcentral-screenshots');
test.beforeAll(async () => { worker = await startWorker(4227); fs.mkdirSync(SHOTS, { recursive: true }); });
test.afterAll(async () => { await worker?.stop(); });

const api = (p, init) => fetch(`${worker.origin}${p}`, init);
async function token(name) {
  const res = await api('/api/auth/dev', { method: 'POST', body: JSON.stringify({ displayName: name }) });
  const data = await res.json();
  return data;
}
async function createRoom(seed = 1) {
  const res = await api('/api/taidi/create', { method: 'POST', body: JSON.stringify({ seed }) });
  return (await res.json()).roomCode;
}
async function client(browser, name, { mobile = false, room = null, signedIn = true } = {}) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err));
  await page.route('**/*', (route) => (new URL(route.request().url()).origin === worker.origin ? route.continue() : route.abort()));
  const auth = signedIn ? await token(name) : null;
  await page.addInitScript(({ auth }) => {
    if (auth) localStorage.setItem('authToken', auth.token);
    window.confirm = () => true;
  }, { auth: auth ? { token: auth.token } : null });
  await page.goto(`${worker.origin}/taidi/${room ? `#${room}` : ''}`);
  return { page, context, name, errors, telegramId: auth?.telegramId };
}
async function close(pages) {
  for (const p of pages) {
    expect(p.errors, `page errors for ${p.name}`).toEqual([]);
    await p.context.close();
  }
}
const view = (page) => page.evaluate(() => view);
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name), fullPage: true });
// The lobby screen is taller than a mobile viewport, and its wait text /
// Take a Seat button sit below the fold. Scroll the evidence into view first,
// then capture the viewport — a full-page/element shot was still cropping
// below the player list on mobile.
const lobbyShot = async (page, name, target = '#btn-take-seat') => {
  const el = page.locator(target);
  if (await el.count()) await el.scrollIntoViewIfNeeded().catch(() => {});
  await page.screenshot({ path: path.join(SHOTS, name) });
};

test('kicked player stays out after a reload, and is not auto-seated', async ({ browser }) => {
  const room = await createRoom(61);
  const host = await client(browser, 'Host61', { room });
  const guest = await client(browser, 'Guest61', { room, mobile: true });
  try {
    await expect(host.page.locator('#lobby-players .td-player')).toHaveCount(2);
    // Lobby names must render horizontally, not one character per line: the
    // name's box must be wider than it is tall (regression for the 7px-column bug).
    const nameBox = await host.page.locator('.lobby-player-name').first().boundingBox();
    expect(nameBox.width).toBeGreaterThan(nameBox.height * 2);
    await guest.page.reload();
    await expect.poll(async () => (await view(guest.page))?.you.seat).toBe(1);
    await host.page.locator('#lobby-players .kick-btn').click();
    await expect(host.page.locator('#lobby-players .td-player')).toHaveCount(1);
    await expect(guest.page.locator('#lobby-wait')).toContainText('removed from this lobby');
    await guest.page.reload();
    await expect.poll(async () => (await view(guest.page))?.you.seat).toBe(-1);
    await expect(host.page.locator('#lobby-players .td-player')).toHaveCount(1);
    await expect(guest.page.locator('#lobby-wait')).toContainText('removed from this lobby');
    await lobbyShot(guest.page, 'taidi-kicked-stays-out.png', '#lobby-wait');
  } finally { await close([host, guest]); }
});

test('full-lobby visitor gets Take a Seat when a seat opens, instead of stuck Joining', async ({ browser }) => {
  const room = await createRoom(62);
  const pages = [];
  for (let i = 0; i < 4; i++) pages.push(await client(browser, `P62_${i}`, { room }));
  try {
    await expect(pages[0].page.locator('#lobby-players .td-player')).toHaveCount(4);
    const visitor = await client(browser, 'Visitor62', { room, mobile: true });
    try {
      await expect(visitor.page.locator('#btn-take-seat')).toBeVisible();
      await expect(visitor.page.locator('#btn-take-seat')).toBeDisabled();
      await expect(visitor.page.locator('#lobby-wait')).toContainText('This room is full');
      await lobbyShot(visitor.page, 'taidi-full-lobby-take-seat-disabled.png');
      // One seated player leaves the lobby; the visitor's button must enable.
      await pages[3].page.locator('#btn-leave').click();
      await expect(pages[0].page.locator('#lobby-players .td-player')).toHaveCount(3);
      await expect(visitor.page.locator('#btn-take-seat')).toBeEnabled();
      await expect(visitor.page.locator('#lobby-wait')).toContainText('A seat is open');
      await lobbyShot(visitor.page, 'taidi-full-lobby-take-seat-enabled.png');
      await visitor.page.locator('#btn-take-seat').click();
      await expect.poll(async () => (await view(visitor.page))?.you.seat).toBeGreaterThanOrEqual(0);
      await expect(pages[0].page.locator('#lobby-players .td-player')).toHaveCount(4);
      await lobbyShot(visitor.page, 'taidi-full-lobby-seated.png', '#lobby-wait');
    } finally { await visitor.context.close(); }
  } finally { await close(pages); }
});

test('mid-game spectator stays a spectator when the room returns to the lobby', async ({ browser }) => {
  const room = await createRoom(63);
  const host = await client(browser, 'Host63', { room });
  const other = await client(browser, 'Other63', { room });
  try {
    await expect(host.page.locator('#lobby-players .td-player')).toHaveCount(2);
    await host.page.locator('#btn-start').click();
    await expect(host.page.locator('#screen-game')).toHaveClass(/active/);
    const spectator = await client(browser, 'Watcher63', { room, mobile: true });
    try {
      await expect(spectator.page.locator('#screen-game')).toHaveClass(/active/);
      expect((await view(spectator.page)).you.seat).toBe(-1);
      await host.page.locator('#btn-end').click();
      await host.page.locator('#confirm-ok').click();
      await expect(spectator.page.locator('#screen-lobby')).toHaveClass(/active/);
      // Must not be auto-seated: still a spectator, with an explicit action.
      expect((await view(spectator.page)).you.seat).toBe(-1);
      await expect(spectator.page.locator('#btn-take-seat')).toBeVisible();
      await expect(spectator.page.locator('#btn-take-seat')).toBeEnabled();
      await lobbyShot(spectator.page, 'taidi-spectator-stays-spectator.png');
      await spectator.page.locator('#btn-take-seat').click();
      await expect.poll(async () => (await view(spectator.page))?.you.seat).toBeGreaterThanOrEqual(0);
    } finally { await spectator.context.close(); }
  } finally { await close([host, other]); }
});

for (const sameName of [false, true]) {
  test(`leaderboard: tied player cut off by the top-five limit still sees their own row${sameName ? ' with the same display name' : ''}`, async ({ browser }) => {
    // Seed ratings directly: Ann/Ben above, Cat/Dan/Eli/Fay tied at 1000, with
    // Fay's games_played lowest so LIMIT 5 cuts her off despite sharing rank 3.
    const suffix = sameName ? 65 : 64;
    const names = [[`Ann${suffix}`, 1100, 10], [`Ben${suffix}`, 1050, 10], [`Cat${suffix}`, 1000, 10], [`Dan${suffix}`, 1000, 9], [`Eli${suffix}`, 1000, 8], [`Fay${suffix}`, 1000, 1]];
    await worker.db.prepare('DELETE FROM taidi_ratings').run();
    const ids = {};
    for (const [name] of names) {
      const auth = await token(name);
      ids[name] = auth.telegramId;
    }
    for (const [name, rating, games] of names) {
      await worker.db.prepare('INSERT INTO taidi_ratings (telegram_id, rating, games_played, wins, updated_at) VALUES (?, ?, ?, 0, 0)').bind(ids[name], rating, games).run();
    }
    const fay = await client(browser, `Fay${suffix}`, { signedIn: true });
    try {
      if (sameName) {
        // Distinct identities can have the same visible name, rank and rating.
        await worker.db.prepare('UPDATE users SET display_name = ? WHERE telegram_id IN (?, ?)').bind('Same name', ids[`Cat${suffix}`], ids[`Fay${suffix}`]).run();
      }
      // The hub leaderboard card (Tai Di tab) must show the top 5 plus a "You" row for Fay.
      await fay.page.goto(worker.origin);
      await fay.page.locator('.lb-tab[data-game="taidi"]').click();
      await expect(fay.page.locator('.lb-row.lb-me')).toContainText('You');
      await expect(fay.page.locator('.lb-row.lb-me')).toContainText('1000');
      await expect(fay.page.locator('.lb-row')).toHaveCount(6);
      if (sameName) await expect(fay.page.locator('.lb-row:not(.lb-me) .lb-name')).toContainText(['Ann65', 'Ben65', 'Same name', 'Dan65', 'Eli65']);
      await shot(fay.page, `taidi-leaderboard-tied-you-row${sameName ? '-same-name' : ''}.png`);
      // The server suppresses the extra row when this identity is in the top five.
      const ann = await client(browser, `Ann${suffix}`);
      try {
        await ann.page.goto(worker.origin);
        await ann.page.locator('.lb-tab[data-game="taidi"]').click();
        await expect(ann.page.locator('.lb-row')).toHaveCount(5);
        await expect(ann.page.locator('.lb-row.lb-me')).toHaveCount(0);
      } finally { await ann.context.close(); }
    } finally { await fay.context.close(); }
  });
}
