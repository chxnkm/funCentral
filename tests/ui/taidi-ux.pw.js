// Tai Di table UX: hints, sorting, slide-to-select, lining up a play while waiting, the log
// sheet, revealed hands at the end, and the layout at phone/tablet/desktop sizes. Real local
// Worker + Durable Object; scenarios are set with the dev-only /api/taidi/debug/patch hook.
const { test, expect } = require('@playwright/test');
const { startWorker } = require('./live-worker.cjs');
test.setTimeout(180000);
let worker;
test.beforeAll(async () => { worker = await startWorker(4229); });
test.afterAll(async () => { await worker?.stop(); });

const api = (path, init) => fetch(`${worker.origin}${path}`, init);
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const DESKTOP = { viewport: { width: 1280, height: 900 } };

async function client(browser, name, room, device = DESKTOP) {
  const context = await browser.newContext(device);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err));
  await page.route('**/*', (route) => (new URL(route.request().url()).origin === worker.origin ? route.continue() : route.abort()));
  const { token } = await (await api('/api/auth/dev', { method: 'POST', body: JSON.stringify({ displayName: name }) })).json();
  await page.addInitScript((t) => localStorage.setItem('authToken', t), token);
  await page.goto(`${worker.origin}/taidi/#${room}`);
  return { page, context, errors, name };
}
async function patch(room, game) {
  const res = await api(`/api/taidi/debug/patch?room=${room}`, { method: 'POST', body: JSON.stringify(game) });
  expect(res.ok).toBe(true);
}
/** Two seated players in a started game; returns [seat 0, seat 1]. */
async function duo(browser, seed, devices = [DESKTOP, DESKTOP]) {
  const { roomCode: room } = await (await api('/api/taidi/create', { method: 'POST', body: JSON.stringify({ seed }) })).json();
  const a = await client(browser, `Uxa${seed}`, room, devices[0]);
  await expect(a.page.locator('#lobby-players .td-player')).toHaveCount(1);
  const b = await client(browser, `Uxb${seed}`, room, devices[1]);
  await expect(a.page.locator('#lobby-players .td-player')).toHaveCount(2);
  await a.page.locator('#btn-start').click();
  for (const p of [a, b]) await expect(p.page.locator('#screen-game')).toHaveClass(/active/);
  return { room, a, b };
}
async function close(...clients) {
  for (const c of clients) {
    expect(c.errors, `page errors for ${c.name}`).toEqual([]);
    await c.context.close();
  }
}
const selection = (page) => page.evaluate(() => [...selected].sort());
const handOrder = (page) => page.locator('#hand .hand-card').evaluateAll((cards) => cards.map((c) => c.dataset.card));
/** The exposed index corner of a fanned card, where a finger lands. */
async function corner(page, code) {
  return page.evaluate((c) => {
    const r = document.querySelector(`#hand .hand-card[data-card="${c}"] .card-corner`).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + Math.min(10, r.height / 2) };
  }, code);
}
async function waitHandIdle(page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || !a.effect?.target?.closest?.('#hand')));
}

test('hint cycles legal answers, and a hand that cannot answer is told to pass', async ({ browser }) => {
  const { room, a, b } = await duo(browser, 71);
  try {
    await patch(room, {
      hands: [['4C', '6D', '6S', '9H', 'KS'], ['3C', '5H', '8D', 'JC', '2S']], currentSeat: 1, mustInclude: null, passes: 0,
      table: { kind: 'single', size: 1, tier: 0, power: 2 * 4 + 1, seat: 0, cards: ['5C'] }, log: [{ seq: 1, t: 'play', seat: 0, cards: ['5C'], kind: 'single' }], seq: 1,
    });
    await expect(b.page.locator('#preview')).toContainText('higher single');
    const seen = [];
    for (let i = 0; i < 4; i++) {
      await b.page.locator('#btn-hint').click();
      const picked = await selection(b.page);
      expect(picked).toHaveLength(1);
      seen.push(picked[0]);
      await expect(b.page.locator('#btn-act')).toBeEnabled();
      await expect(b.page.locator('#btn-hint')).toContainText(`${i + 1}/4`);
    }
    // Weakest first, every legal single, then it wraps around.
    expect(seen).toEqual(['5H', '8D', 'JC', '2S']);
    await b.page.locator('#btn-hint').click();
    expect(await selection(b.page)).toEqual(['5H']);
    await b.page.keyboard.press('Escape');
    expect(await selection(b.page)).toEqual([]);

    // Nothing beats a 2♠: the preview says so, Pass is suggested and Hint is off.
    await patch(room, { table: { kind: 'single', size: 1, tier: 0, power: 12 * 4 + 3, seat: 0, cards: ['2S'] }, hands: [['4C', '6D', '6S', '9H', 'KS'], ['3C', '5H', '8D', 'JC', 'AS']] });
    await expect(b.page.locator('#preview')).toContainText('Nothing in your hand beats');
    await expect(b.page.locator('#btn-pass')).toHaveClass(/suggest/);
    await expect(b.page.locator('#btn-hint')).toBeDisabled();
    // Leading: five-card hands are suggested first.
    await patch(room, { currentSeat: 0, table: null, hands: [['4C', '5D', '6S', '7H', '8C', 'KS'], ['3C', '5H', '8D', 'JC', 'AS']] });
    await a.page.locator('#btn-hint').click();
    expect(await selection(a.page)).toEqual(['4C', '5D', '6S', '7H', '8C']);
    await expect(a.page.locator('#preview')).toContainText('Straight');
  } finally { await close(a, b); }
});

test('sort by suit, slide to select, and line up a play while waiting', async ({ browser }) => {
  const { room, a, b } = await duo(browser, 72, [PHONE, DESKTOP]);
  try {
    await patch(room, {
      hands: [['3D', '5S', '7D', '9C', 'JH', 'KD', '2C'], ['4C', '6H', '8S', 'QC', 'AD']], currentSeat: 1, mustInclude: null, passes: 0, table: null, log: [], seq: 0,
    });
    await expect(a.page.locator('#hand .hand-card')).toHaveCount(7);
    expect(await handOrder(a.page)).toEqual(['3D', '5S', '7D', '9C', 'JH', 'KD', '2C']);
    await a.page.locator('#btn-sort').click();
    expect(await handOrder(a.page)).toEqual(['3D', '7D', 'KD', '9C', '2C', 'JH', '5S']);
    await expect(a.page.locator('#btn-sort')).toContainText('Suit');
    // The choice sticks across a reload.
    await a.page.reload();
    await expect(a.page.locator('#hand .hand-card')).toHaveCount(7);
    expect(await handOrder(a.page)).toEqual(['3D', '7D', 'KD', '9C', '2C', 'JH', '5S']);

    // Not my turn: a slide across three diamonds lines them up without sending anything.
    await waitHandIdle(a.page);
    const from = await corner(a.page, '3D');
    const mid = await corner(a.page, '7D');
    const to = await corner(a.page, 'KD');
    await a.page.mouse.move(from.x, from.y);
    await a.page.mouse.down();
    await a.page.mouse.move(mid.x, mid.y, { steps: 4 });
    await a.page.mouse.move(to.x, to.y, { steps: 4 });
    await a.page.mouse.up();
    expect(await selection(a.page)).toEqual(['3D', '7D', 'KD']);
    await expect(a.page.locator('#preview')).toContainText("isn't a valid combination");
    await expect(a.page.locator('#btn-act')).toBeDisabled();
    // Sliding back over a picked card from a picked card drops them.
    await a.page.mouse.move(to.x, to.y);
    await a.page.mouse.down();
    await a.page.mouse.move(mid.x, mid.y, { steps: 4 });
    await a.page.mouse.up();
    expect(await selection(a.page)).toEqual(['3D']);

    // The lined-up single survives the other player's move and is playable on my turn.
    await b.page.evaluate(() => send({ type: 'play', cards: ['4C'] }));
    await expect(a.page.locator('#turn-banner')).toContainText('Your turn');
    expect(await selection(a.page)).toEqual(['3D']);
    await expect(a.page.locator('#preview')).toContainText("doesn't beat");
    await a.page.locator('#preview .td-clear').click();
    expect(await selection(a.page)).toEqual([]);
  } finally { await close(a, b); }
});

test('the log is a sheet on phones and a column on desktop; results reveal what was left', async ({ browser }) => {
  const { room, a, b } = await duo(browser, 73, [PHONE, DESKTOP]);
  try {
    await patch(room, { hands: [['KS'], ['3C', '5D', '9H']], currentSeat: 0, table: null, mustInclude: null, passes: 0 });
    // Desktop: the log column is always there and the toggle is not.
    await expect(b.page.locator('#log-panel')).toBeVisible();
    await expect(b.page.locator('#btn-log')).toBeHidden();
    // Phone: closed until asked for, then closes with Escape.
    await expect(a.page.locator('#log-panel')).toBeHidden();
    await a.page.locator('#btn-log').click();
    await expect(a.page.locator('#log-panel')).toBeVisible();
    await expect(a.page.locator('#btn-log')).toHaveAttribute('aria-expanded', 'true');
    await a.page.keyboard.press('Escape');
    await expect(a.page.locator('#log-panel')).toBeHidden();

    await a.page.evaluate(() => send({ type: 'play', cards: ['KS'] }));
    for (const p of [a, b]) await expect(p.page.locator('#modal-over')).toBeVisible();
    await expect(a.page.locator('#over-title')).toHaveText('You win!');
    await expect(b.page.locator('#over-results .td-result').nth(1).locator('.td-chip-card')).toHaveText(['3♣', '5♦', '9♥']);
    await expect(b.page.locator('#log li').first()).toContainText('went out first');
  } finally { await close(a, b); }
});

test('several plays replayed from one update leave nothing behind on the animation layer', async ({ browser }) => {
  const { room, a, b } = await duo(browser, 75);
  try {
    await patch(room, { hands: [['3D', '5C', '9H', 'KS'], ['4C', '6H', '8D', 'JC']], currentSeat: 0, mustInclude: null, table: null, passes: 0, log: [], seq: 0 });
    await expect(a.page.locator('#hand .hand-card')).toHaveCount(4);
    // One update carries four plays (as when a tab catches up): each covers the one before.
    await patch(room, {
      hands: [['9H', 'KS'], ['6H', 'JC']], currentSeat: 0, passes: 0,
      table: { kind: 'single', size: 1, tier: 0, power: 5 * 4, seat: 1, cards: ['8D'] },
      log: [
        { seq: 1, t: 'play', seat: 0, cards: ['3D'], kind: 'single' }, { seq: 2, t: 'play', seat: 1, cards: ['4C'], kind: 'single' },
        { seq: 3, t: 'play', seat: 0, cards: ['5C'], kind: 'single' }, { seq: 4, t: 'play', seat: 1, cards: ['8D'], kind: 'single' },
      ],
      seq: 4,
    });
    await expect(a.page.locator('#table-play .card-mini')).toHaveCount(1);
    await a.page.waitForFunction(() => document.querySelector('#fx').childElementCount > 0 || document.getAnimations().length > 0);
    await a.page.waitForFunction(() => document.getAnimations().every((x) => x.playState !== 'running' || x.effect?.getComputedTiming().endTime === Infinity), null, { timeout: 10000 });
    expect(await a.page.evaluate(() => document.querySelector('#fx').childElementCount), 'no cards left on the animation layer').toBe(0);
    expect(await a.page.locator('#table-play .card-mini').evaluateAll((n) => n.map((x) => x.dataset.card))).toEqual(['8D']);
  } finally { await close(a, b); }
});

for (const [label, device] of [
  ['small phone 360×640', { viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true }],
  ['phone 390×844', PHONE],
  ['landscape phone 844×390', { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true }],
  ['tablet 820×1180', { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true }],
  ['desktop 1366×900', { viewport: { width: 1366, height: 900 } }],
]) {
  test(`layout holds on a ${label}: no overlap, no side scroll, every index visible`, async ({ browser }) => {
    const { room, a, b } = await duo(browser, 74, [device, DESKTOP]);
    try {
      await patch(room, {
        hands: [['3D', '4C', '5H', '6S', '7D', '8C', '9H', '10S', 'JD', 'QC', 'KH', 'AS', '2D', '2C', '2H', 'AC', 'KS'], ['3C', '4D']],
        currentSeat: 0, mustInclude: null, passes: 0, table: { kind: 'single', size: 1, tier: 0, power: 0, seat: 1, cards: ['3H'] },
        log: [{ seq: 1, t: 'play', seat: 1, cards: ['3H'], kind: 'single' }], seq: 1,
      });
      await expect(a.page.locator('#hand .hand-card')).toHaveCount(17);
      await waitHandIdle(a.page);
      const layout = await a.page.evaluate(() => {
        const r = (sel) => document.querySelector(sel).getBoundingClientRect();
        const felt = r('#td-felt');
        const dock = r('#hand-area');
        const cards = [...document.querySelectorAll('#hand .hand-card')];
        const hidden = cards.filter((card) => {
          const c = card.querySelector('.card-corner').getBoundingClientRect();
          const hit = document.elementFromPoint(c.left + c.width / 2, c.top + Math.min(8, c.height / 2));
          return hit?.closest('.hand-card') !== card;
        }).map((card) => card.dataset.card);
        const act = r('#btn-act');
        return {
          overlap: Math.round(felt.bottom - dock.top), sideScroll: document.documentElement.scrollWidth > innerWidth,
          feltHeight: Math.round(felt.height), hidden, actionsOnScreen: act.bottom <= innerHeight + 1 && act.top >= 0,
        };
      });
      expect(layout.overlap, 'felt must end above the hand dock').toBeLessThanOrEqual(0);
      expect(layout.sideScroll).toBe(false);
      expect(layout.feltHeight).toBeGreaterThanOrEqual(160);
      expect(layout.hidden, 'every card index must be tappable').toEqual([]);
      expect(layout.actionsOnScreen, 'Play/Pass stay on screen').toBe(true);
    } finally { await close(a, b); }
  });
}
