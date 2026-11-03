// Screenshot / animation capture for Tai Di UI review (not part of the Playwright suite).
// Real local Worker + Durable Objects with seeded rooms; scenarios are set with the dev-only patch hook.
//   PLAYWRIGHT_CHANNEL=chrome node tests/ui/taidi-capture.cjs docs/taidi-ui/after [--clips]
// --clips also records short animation clips (APNG, see capture-kit.cjs).
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('@playwright/test');
const { startWorker } = require('./live-worker.cjs');
const { recordClip: recordApng } = require('./capture-kit.cjs');

const out = path.resolve(process.argv[2] || 'taidi-shots');
const wantClips = process.argv.includes('--clips');
const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const SMALL = { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const LANDSCAPE = { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const TABLET = { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 };
const DESKTOP = { viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1 };
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
// Looping ambient glows are paused while recording clips; event animations are unchanged.
const AMBIENT_OFF = '.td-plate.active .td-avatar, .td-seat.active .td-avatar::before, .td-game.my-turn .td-felt, #btn-act.ready, .td-hero-card, .td-ghost-card, .td-hand .td-must, .td-seat.last-card .td-count, .td-pass.suggest, .td-empty.needed .td-avatar-empty, .td-dots::after { animation: none !important; }';
const recordClip = (page, file, run, opts = {}) => recordApng(page, path.join(out, file), run, { ambientOff: AMBIENT_OFF, ...opts });

// A full 52-card deal for four players (seat order Ada, Bea, Cy, Di).
const ADA = ['3D', '4C', '5H', '6S', '7D', '9C', '9H', 'JD', 'QS', 'KC', 'AH', '2C', '2S'];
const BEA = ['3C', '4D', '5D', '6H', '7C', '8D', '10C', '10D', '10H', '10S', 'JH', 'QD', 'KD'];
const CY = ['3H', '4H', '5C', '6C', '7H', '8C', '9D', 'JS', 'QC', 'KH', 'AC', 'AD', '2D'];
const DI = ['3S', '4S', '5S', '6D', '7S', '8H', '8S', '9S', 'JC', 'QH', 'KS', 'AS', '2H'];
const STRAIGHT = ['3D', '4C', '5H', '6S', '7D'];
const FLUSH = ['4D', '5D', '8D', 'QD', 'KD'];
const QUADS = ['10C', '10D', '10H', '10S', '3C'];
const without = (hand, cards) => hand.filter((c) => !cards.includes(c));
const FRESH = { phase: 'play', winner: null, placements: null, exposed: null, unused: 0, passes: 0 };
const OPEN = { ...FRESH, hands: [ADA, BEA, CY, DI], currentSeat: 0, mustInclude: '3D', table: null, log: [], seq: 0 };
const PAIR_ON_TABLE = {
  ...FRESH,
  hands: [without(ADA, STRAIGHT), without(BEA, ['JH']), CY, without(DI, ['8H', '8S'])],
  currentSeat: 0, mustInclude: null, passes: 1,
  table: { kind: 'pair', size: 2, tier: 0, power: 5 * 4 + 3, seat: 3, cards: ['8H', '8S'] },
  log: [
    { seq: 1, t: 'play', seat: 0, cards: STRAIGHT, kind: 'straight' },
    { seq: 2, t: 'pass', seat: 1 }, { seq: 3, t: 'pass', seat: 2 }, { seq: 4, t: 'pass', seat: 3 },
    { seq: 5, t: 'trick', seat: 0 },
    { seq: 6, t: 'play', seat: 0, cards: ['9C'], kind: 'single' },
    { seq: 7, t: 'play', seat: 1, cards: ['JH'], kind: 'single' },
    { seq: 8, t: 'pass', seat: 2 }, { seq: 9, t: 'pass', seat: 3 }, { seq: 10, t: 'pass', seat: 0 },
    { seq: 11, t: 'trick', seat: 1 },
    { seq: 12, t: 'play', seat: 1, cards: ['6H'], kind: 'single' },
    { seq: 13, t: 'pass', seat: 2 },
    { seq: 14, t: 'play', seat: 3, cards: ['8H', '8S'], kind: 'pair' },
  ],
  seq: 14,
};

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const worker = await startWorker(4233);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  const api = (p, init) => fetch(`${worker.origin}${p}`, init);
  const login = async (name) => (await (await api('/api/auth/dev', { method: 'POST', body: JSON.stringify({ displayName: name }) })).json());
  const createRoom = async (seed) => (await (await api('/api/taidi/create', { method: 'POST', body: JSON.stringify({ seed }) })).json()).roomCode;
  const patch = async (room, game) => { const r = await api(`/api/taidi/debug/patch?room=${room}`, { method: 'POST', body: JSON.stringify(game) }); if (!r.ok) throw new Error(await r.text()); };
  const contexts = [];

  async function client(name, device, room, query = '') {
    const context = await browser.newContext(device);
    contexts.push(context);
    const page = await context.newPage();
    page.on('pageerror', (err) => console.error(`[${name}] page error:`, err.message));
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      return url.origin === worker.origin || FONT_HOSTS.includes(url.hostname) ? route.continue() : route.abort();
    });
    const auth = name ? (await login(name)).token : null;
    await page.addInitScript((t) => { if (t) localStorage.setItem('authToken', t); window.confirm = () => true; }, auth);
    await page.goto(`${worker.origin}/taidi/${query}${room ? `#${room}` : ''}`);
    return page;
  }
  const settle = (page, ms = 1400) => page.waitForTimeout(ms);
  // JPEG keeps the evidence folder small; clips stay APNG.
  const shot = async (page, name) => { await page.screenshot({ path: path.join(out, `${name}.jpg`), type: 'jpeg', quality: 82 }); console.log('captured', name); };
  const handIdle = (page) => page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'
    || !a.effect?.target?.closest?.('#hand') || a.effect.getComputedTiming().endTime === Infinity));
  async function tapCard(page, code) {
    await handIdle(page);
    const point = await page.evaluate((c) => {
      const card = document.querySelector(`#hand .hand-card[data-card="${c}"]`);
      const corner = card.querySelector('.card-corner').getBoundingClientRect();
      return { x: corner.left + corner.width / 2, y: corner.top + Math.min(10, corner.height / 2) };
    }, code);
    await page.mouse.click(point.x, point.y);
  }
  const tapAll = async (page, codes) => { for (const c of codes) await tapCard(page, c); };
  const clear = (page) => page.keyboard.press('Escape');
  const seatOf = (page) => page.evaluate(() => view?.you?.seat);

  /** Seats `names` (with matching devices) in a fresh room, in order; the first is the host. */
  async function table(seed, players) {
    const room = await createRoom(seed);
    const pages = [];
    for (const [name, device] of players) {
      const page = await client(name, device, room);
      pages.push(page);
      await pages[0].waitForFunction((n) => view?.players?.length === n, pages.length);
      if (await seatOf(page) !== pages.length - 1) throw new Error(`${name} is not in seat ${pages.length - 1}`);
    }
    return { room, pages };
  }
  async function start(pages) {
    await pages[0].locator('#btn-start').click();
    for (const p of pages) await p.locator('#screen-game.active').waitFor();
  }

  try {
    // A few rated players, so the leaderboard and stats have rows.
    const rated = [['Mei', 1112, 24, 11, 1.9], ['Jun', 1064, 18, 7, 2.2], ['Wei', 1031, 12, 4, 2.4], ['Ling', 998, 9, 2, 2.6], ['Hao', 962, 15, 3, 2.9]];
    for (const [name, rating, games, wins, avg] of rated) {
      const { telegramId } = await login(name);
      await worker.db.prepare('INSERT INTO taidi_ratings (telegram_id, rating, games_played, wins, updated_at) VALUES (?, ?, ?, ?, 0)').bind(telegramId, rating, games, wins).run();
      await worker.db.prepare('INSERT INTO taidi_rating_history (game_id, telegram_id, place, rating_before, rating_after, delta, played_at) VALUES (?, ?, ?, 1000, 1000, 0, 0)').bind(`seed-${name}`, telegramId, avg).run();
    }

    // Home (signed in) on a phone and desktop, rules, and the signed-out home.
    const home = await client('Visitor', MOBILE);
    await settle(home);
    await shot(home, 'home-390');
    await home.locator('#btn-rules-home').click();
    await settle(home, 700);
    await shot(home, 'rules-390');
    const homeDesk = await client('Visitor Desk', DESKTOP);
    await settle(homeDesk);
    await shot(homeDesk, 'home-1366');
    const guest = await client(null, MOBILE);
    await settle(guest);
    await shot(guest, 'home-signed-out-390');

    const stats = await client('Mei', MOBILE, null, '?view=stats');
    await settle(stats);
    await shot(stats, 'stats-390');

    // Four players: Ada (phone, host), Bea (desktop), Cy and Di (phones).
    const { room, pages } = await table(7, [['Ada', MOBILE], ['Bea', DESKTOP], ['Cy', MOBILE], ['Di', MOBILE]]);
    const [ada, bea, cy, di] = pages;
    await settle(ada);
    await shot(ada, 'lobby-390');
    await shot(bea, 'lobby-1366');
    await start(pages);
    await settle(ada, 450);
    await shot(ada, 'deal-mid-390');
    await settle(ada, 2400);

    // Ada opens: she must include the 3♦.
    await patch(room, OPEN);
    await settle(ada);
    await shot(ada, 'open-390');
    await tapAll(ada, STRAIGHT);
    await settle(ada, 500);
    await shot(ada, 'combo-390');
    await clear(ada);
    await tapAll(ada, ['4C', '9H']);
    await settle(ada, 500);
    await shot(ada, 'invalid-390');
    await clear(ada);
    await tapAll(ada, STRAIGHT);
    await ada.locator('#btn-act').click();
    await settle(ada, 260);
    await shot(ada, 'play-mid-390');
    await settle(bea, 1600);

    // Bea (desktop) answers: a flush selected, then four of a kind played.
    await tapAll(bea, FLUSH);
    await settle(bea, 500);
    await shot(bea, 'answer-1366');
    await clear(bea);
    await tapAll(bea, QUADS);
    await bea.locator('#btn-act').click();
    await settle(bea, 520);
    await shot(bea, 'quads-mid-1366');
    await settle(ada, 1800);
    await shot(ada, 'waiting-390');

    // Everyone passes: the table goes to Bea.
    for (const p of [cy, di, ada]) { await p.locator('#btn-pass').click(); await settle(p, 900); }
    await settle(bea, 1200);
    await shot(bea, 'lead-1366');

    // A pair on the table; Ada to answer, the log and a spectator on desktop.
    await patch(room, PAIR_ON_TABLE);
    await settle(ada, 4200);
    await shot(ada, 'pair-390');
    const watcher = await client('Watcher', DESKTOP, room);
    await watcher.locator('#screen-game.active').waitFor();
    await settle(watcher);
    await shot(watcher, 'watching-1366');

    // Endgame: Ada and Cy are down to one card each.
    await patch(room, { ...FRESH, hands: [['2S'], without(BEA, QUADS), ['AD'], without(DI, ['8H', '8S'])], currentSeat: 0, table: null, mustInclude: null, log: [], seq: 0 });
    await settle(ada);
    await shot(ada, 'last-card-390');
    await tapCard(ada, '2S');
    await ada.locator('#btn-act').click();
    await settle(ada, 3200);
    await shot(ada, 'win-390');
    await shot(cy, 'lose-390');
    await shot(bea, 'over-1366');

    // Other viewports on the same table.
    await bea.locator('#btn-again').click();
    for (const p of pages) await p.locator('#screen-lobby.active').waitFor();
    await start(pages);
    await patch(room, { ...OPEN, currentSeat: 2, mustInclude: null, table: { kind: 'single', size: 1, tier: 0, power: 2 * 4 + 1, seat: 1, cards: ['5D'] }, hands: [ADA, without(BEA, ['5D']), CY, DI], log: [{ seq: 1, t: 'play', seat: 1, cards: ['5D'], kind: 'single' }], seq: 1 });
    const small = await client('Small', SMALL, room);
    await small.locator('#screen-game.active').waitFor();
    await settle(small);
    await shot(small, 'watching-360');
    await settle(cy);
    await tapCard(cy, '6C');
    await settle(cy, 500);
    await shot(cy, 'turn-390');
    const tablet = await client('Cy', TABLET, room);
    await tablet.locator('#screen-game.active').waitFor();
    await settle(tablet);
    await shot(tablet, 'turn-820');
    const land = await client('Cy', LANDSCAPE, room);
    await land.locator('#screen-game.active').waitFor();
    await settle(land);
    await shot(land, 'turn-844x390');

    // Two and three players.
    const two = await table(21, [['Eve', MOBILE], ['Fox', MOBILE]]);
    await start(two.pages);
    await settle(two.pages[0], 2600);
    await shot(two.pages[0], 'two-players-390');
    const three = await table(32, [['Gus', MOBILE], ['Hal', DESKTOP], ['Ivy', MOBILE]]);
    await start(three.pages);
    await settle(three.pages[1], 2600);
    await shot(three.pages[1], 'three-players-1366');
    await shot(three.pages[0], 'three-players-390');

    if (wantClips) {
      const c = await table(41, [['Jo', MOBILE], ['Kai', MOBILE], ['Lu', MOBILE], ['Mo', MOBILE]]);
      const [jo, kai, lu, mo] = c.pages;
      await recordClip(jo, 'clip-deal-390.png', async () => {
        await c.pages[0].locator('#btn-start').click();
        await settle(jo, 2600);
      });
      await patch(c.room, OPEN);
      await settle(jo, 1200);
      await recordClip(jo, 'clip-straight-390.png', async () => {
        await settle(jo, 200);
        await tapAll(jo, STRAIGHT);
        await settle(jo, 700);
        await jo.locator('#btn-act').click();
        await settle(jo, 1400);
      });
      await settle(kai, 400);
      await recordClip(jo, 'clip-quads-390.png', async () => {
        await kai.evaluate((cards) => send({ type: 'play', cards }), QUADS);
        await settle(jo, 2200);
      });
      await recordClip(jo, 'clip-trick-390.png', async () => {
        await lu.evaluate(() => send({ type: 'pass' }));
        await settle(jo, 600);
        await mo.evaluate(() => send({ type: 'pass' }));
        await settle(jo, 600);
        await jo.locator('#btn-pass').click();
        await settle(jo, 1600);
      });
      await patch(c.room, { ...FRESH, hands: [['2S'], without(BEA, QUADS), ['AD'], DI], currentSeat: 0, table: null, mustInclude: null, log: [], seq: 0 });
      await settle(jo, 1200);
      await recordClip(jo, 'clip-win-390.png', async () => {
        await tapCard(jo, '2S');
        await settle(jo, 500);
        await jo.locator('#btn-act').click();
        await settle(jo, 3600);
      });
    }
  } finally {
    for (const c of contexts) await c.close();
    await browser.close();
    await worker.stop();
  }
})().catch((err) => { console.error(err); process.exit(1); });
