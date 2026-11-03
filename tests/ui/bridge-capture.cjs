// Screenshot capture for Bridge and hub UI review (not part of the Playwright suite).
// Real local Worker; Bridge screens are set up by injecting exact views through the page's
// own globals (as the fixture tests do), so before/after use identical states.
//   PLAYWRIGHT_CHANNEL=chrome node tests/ui/bridge-capture.cjs docs/bridge-ui/after
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('@playwright/test');
const { startWorker } = require('./live-worker.cjs');

const out = path.resolve(process.argv[2] || 'bridge-shots');
const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const SMALL = { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const LANDSCAPE = { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const TABLET = { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 };
const DESKTOP = { viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1 };
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

const C = '♣', D = '♦', H = '♥', S = '♠';
const HAND = { [C]: ['A', 'K', 'Q', '10'], [D]: ['A', 'J', '8'], [H]: ['K', '9', '7'], [S]: ['Q', '8', '2'] };
const PLAYERS = [
  { name: 'Alex', seat: 0, connected: true, elo: 1084, wins: 14, gamesPlayed: 26 },
  { name: 'Blair', seat: 1, connected: true, elo: 1012, wins: 9, gamesPlayed: 21 },
  { name: 'Casey', seat: 2, connected: true, isBot: true, botLevel: 'sophisticated' },
  { name: 'Drew', seat: 3, connected: true, elo: 968, wins: 6, gamesPlayed: 19 },
];
const BASE = {
  roomCode: 'BRDG', gameId: 'capture-1', hand: HAND, mySeat: 0, turn: 0, bid: -1, bidder: -1, trumpSuit: null, trumpBroken: false,
  partnerCard: null, partnerSeat: -1, playedCards: [null, null, null, null], currentSuit: null, sets: [0, 0, 0, 0], setsNeeded: 0,
  bidHistory: [], isSpectator: false, watchingSeat: undefined, spectators: [], isPractice: false, readySeats: [], players: PLAYERS,
  groupId: '-1001', groupName: 'Friday Bridge Club',
};
const BIDS = [
  { seat: 1, name: 'Blair', bidNum: 0 }, { seat: 2, name: 'Casey', bidNum: null }, { seat: 3, name: 'Drew', bidNum: 6 },
  { seat: 0, name: 'Alex', bidNum: 7 }, { seat: 1, name: 'Blair', bidNum: null }, { seat: 2, name: 'Casey', bidNum: null }, { seat: 3, name: 'Drew', bidNum: null },
];
const STATES = {
  lobby: { ...BASE, phase: 'lobby', players: PLAYERS.slice(0, 3), gameStartAt: null },
  bidding: { ...BASE, phase: 'bidding', turn: 0, bid: 6, bidder: 3, bidHistory: BIDS.slice(0, 3) },
  partner: { ...BASE, phase: 'partner', turn: 0, bid: 7, bidder: 0, trumpSuit: H, setsNeeded: 8, bidHistory: BIDS },
  play: {
    ...BASE, phase: 'play', turn: 0, bid: 7, bidder: 0, trumpSuit: H, trumpBroken: true, partnerCard: `A ${S}`, setsNeeded: 8,
    playedCards: [null, `J ${C}`, `7 ${C}`, `9 ${C}`], currentSuit: C, sets: [2, 1, 2, 1], bidHistory: BIDS,
    spectators: [{ name: 'Erin', watchingSeat: 0 }],
    lastTrick: { cards: [`K ${D}`, `5 ${D}`, `2 ${D}`, `Q ${D}`], winner: 0 },
  },
  gameover: {
    ...BASE, phase: 'gameover', turn: 0, bid: 7, bidder: 0, trumpSuit: H, partnerCard: `A ${S}`, partnerSeat: 2, setsNeeded: 8,
    sets: [5, 2, 3, 3], bidHistory: BIDS, allInitialHands: [HAND, HAND, HAND, HAND], allFinalHands: [{}, {}, {}, {}],
  },
};
const CHAT = [
  { id: 'c1', sequence: 1, name: 'Blair', seat: 1, text: 'Evening all 👋' },
  { id: 'c2', sequence: 2, name: 'Alex', seat: 0, text: 'Casey is a bot tonight, Drew is on the way' },
  { id: 'c3', sequence: 3, name: 'Drew', seat: 3, text: 'here! deal me in' },
];

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const worker = await startWorker(4235);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  const api = (p, init) => fetch(`${worker.origin}${p}`, init);
  const login = async (name) => (await (await api('/api/auth/dev', { method: 'POST', body: JSON.stringify({ displayName: name }) })).json());
  const contexts = [];

  // Leaderboard rows for the home screens.
  for (const [name, elo, wins, games] of [['Mei', 1142, 31, 52], ['Jun', 1090, 22, 40], ['Wei', 1051, 18, 37], ['Ling', 1003, 12, 30], ['Hao', 977, 9, 25]]) {
    const { telegramId } = await login(name);
    await worker.db.prepare('UPDATE users SET elo = ?, wins = ?, games_played = ? WHERE telegram_id = ?').bind(elo, wins, games, telegramId).run();
  }
  const STATS = [
    { displayName: 'Mei', elo: 1142, games: 52, winPct: 60, bidder: { games: 14, winPct: 64 }, partner: { games: 12, winPct: 58 }, opposition: { games: 26, winPct: 57 } },
    { displayName: 'Jun', elo: 1090, games: 40, winPct: 55, bidder: { games: 11, winPct: 55 }, partner: { games: 9, winPct: 44 }, opposition: { games: 20, winPct: 60 } },
    { displayName: 'Alex', elo: 1084, games: 26, winPct: 54, bidder: { games: 8, winPct: 62 }, partner: { games: 6, winPct: 50 }, opposition: { games: 12, winPct: 50 } },
  ];
  const HISTORY = [
    { gameId: 'g3', bidLevel: 2, trumpSuit: H, bidderSeat: 0, seatMap: PLAYERS.map((p) => ({ seat: p.seat, name: p.name })), won: true, role: 'bidder', isPractice: false, tricksWon: 8, setsNeeded: 8, playedAt: 1762100000 },
    { gameId: 'g2', bidLevel: 3, trumpSuit: '🚫', bidderSeat: 1, seatMap: PLAYERS.map((p) => ({ seat: p.seat, name: p.name })), won: false, role: 'opposition', isPractice: false, tricksWon: 4, setsNeeded: 5, playedAt: 1762010000 },
    { gameId: 'g1', bidLevel: 1, trumpSuit: S, bidderSeat: 2, seatMap: PLAYERS.map((p) => ({ seat: p.seat, name: p.name })), won: true, role: 'partner', isPractice: true, tricksWon: 7, setsNeeded: 7, playedAt: 1761900000 },
  ];

  async function client(device, { name = 'Alex', path: p = '/bridge/', view = 'classic' } = {}) {
    const context = await browser.newContext(device);
    contexts.push(context);
    const page = await context.newPage();
    page.on('pageerror', (err) => console.error(`[${p}] page error:`, err.message));
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/ws') return route.abort();
      if (url.pathname.startsWith('/api/games/mine')) return route.fulfill({ json: HISTORY });
      if (url.pathname === '/api/stats') return route.fulfill({ json: STATS });
      if (url.pathname === '/api/stats/pairs' || url.pathname === '/api/groups') return route.fulfill({ json: [] });
      if (url.pathname === '/api/betting/leaderboard') return route.fulfill({ json: [] });
      return url.origin === worker.origin || FONT_HOSTS.includes(url.hostname) ? route.continue() : route.abort();
    });
    const auth = name ? (await login(name)).token : null;
    await page.addInitScript(({ t, n, v }) => {
      if (t) localStorage.setItem('authToken', t);
      if (n) localStorage.setItem('playerName', n);
      localStorage.setItem('bridge.tableView', v);
    }, { t: auth, n: name, v: view });
    await page.goto(`${worker.origin}${p}`);
    await page.waitForTimeout(900);
    return page;
  }
  /** Shows a Bridge phase with an exact view, through the client's own render path. */
  async function inject(page, key, extra = {}) {
    await page.evaluate(({ state, chat, key }) => {
      ws = { readyState: WebSocket.OPEN, send() {}, close() {} };
      roomCode = state.roomCode;
      playerName = 'Alex';
      prevTurn = state.turn;
      lastGameOver = key === 'gameover' ? { winnerNames: ['Alex', 'Casey'], bidderWon: true, _soundPlayed: true } : null;
      gameState = state;
      showScreen(`screen-${state.phase === 'play' || state.isSpectator && state.watchingSeat === -1 ? 'play' : state.phase}`);
      handleMessage({ type: 'state', state });
      handleMessage({ type: 'chatHistory', roomCode: state.roomCode, epoch: 'cap', sequence: chat.length, messages: chat });
    }, { state: { ...STATES[key], ...extra }, chat: CHAT, key });
    await page.evaluate(() => { document.scrollingElement.scrollTop = 0; document.body.scrollTop = 0; });
    await page.mouse.move(0, 0);
    await page.waitForTimeout(700);
  }
  const shot = async (page, name) => { await page.screenshot({ path: path.join(out, `${name}.jpg`), type: 'jpeg', quality: 82 }); console.log('captured', name); };
  const scrollTo = (page, sel) => page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'start' }), sel);

  try {
    // Hub.
    for (const [device, suffix] of [[MOBILE, '390'], [DESKTOP, '1366']]) {
      const hub = await client(device, { path: '/' });
      await shot(hub, `hub-${suffix}`);
      await hub.evaluate(() => (document.querySelector('#leaderboard-section') ?? document.body).scrollIntoView({ block: 'start' }));
      await hub.waitForTimeout(300);
      await shot(hub, `hub-lower-${suffix}`);
    }
    const hubOut = await client(MOBILE, { path: '/', name: null });
    await shot(hubOut, 'hub-signed-out-390');

    // Bridge home and side screens.
    for (const [device, suffix] of [[MOBILE, '390'], [DESKTOP, '1366']]) {
      const home = await client(device);
      await shot(home, `home-${suffix}`);
      await home.evaluate(() => showMatchHistory());
      await home.waitForTimeout(700);
      await shot(home, `history-${suffix}`);
      await home.evaluate(() => showStats());
      await home.waitForTimeout(700);
      await shot(home, `stats-${suffix}`);
    }
    const signedOut = await client(MOBILE, { name: null });
    await shot(signedOut, 'home-signed-out-390');
    const role = await client(MOBILE);
    await role.evaluate(() => showScreen('screen-role-choice'));
    await role.waitForTimeout(400);
    await shot(role, 'role-choice-390');

    // Game phases on a phone and desktop, Classic and 2.5D.
    for (const view of ['classic', '25d']) {
      for (const [device, suffix] of [[MOBILE, '390'], [DESKTOP, '1366']]) {
        const page = await client(device, { view });
        const tag = `${view}-${suffix}`;
        await inject(page, 'lobby');
        await shot(page, `lobby-${tag}`);
        await inject(page, 'bidding');
        await shot(page, `bidding-${tag}`);
        if (suffix === '390') { await scrollTo(page, '#bidding-hand-section'); await page.waitForTimeout(300); await shot(page, `bidding-hand-${tag}`); }
        await inject(page, 'partner');
        await shot(page, `partner-${tag}`);
        await inject(page, 'play');
        await shot(page, `play-${tag}`);
        if (suffix === '390') { await scrollTo(page, '#play-hand-section'); await page.waitForTimeout(300); await shot(page, `play-hand-${tag}`); }
        await inject(page, 'gameover');
        await shot(page, `gameover-${tag}`);
      }
    }

    // Other sizes and situations (Classic).
    const small = await client(SMALL);
    await inject(small, 'play');
    await shot(small, 'play-classic-360');
    const land = await client(LANDSCAPE);
    await inject(land, 'play');
    await shot(land, 'play-classic-844x390');
    const tablet = await client(TABLET);
    await inject(tablet, 'play');
    await shot(tablet, 'play-classic-820');
    const watcher = await client(MOBILE);
    await inject(watcher, 'play', { isSpectator: true, watchingSeat: -1, mySeat: -1 });
    await shot(watcher, 'spectator-choose-390');
    const loss = await client(MOBILE);
    await inject(loss, 'gameover', { mySeat: 1 });
    await loss.evaluate(() => { lastGameOver = { winnerNames: ['Alex', 'Casey'], bidderWon: true, _soundPlayed: true }; renderGameOver(gameState); });
    await loss.waitForTimeout(500);
    await shot(loss, 'gameover-loss-390');
  } finally {
    for (const c of contexts) await c.close();
    await browser.close();
    await worker.stop();
  }
})().catch((err) => { console.error(err); process.exit(1); });
