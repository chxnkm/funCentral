'use strict';

// ---------- Card helpers (mirror src/taidi/engine.ts; the room stays authoritative) ----------
const SUIT_SYMBOL = { D: '♦', C: '♣', H: '♥', S: '♠' };
const SUIT_NAME = { D: 'Diamonds', C: 'Clubs', H: 'Hearts', S: 'Spades' };
const SUITS = ['D', 'C', 'H', 'S']; // low to high
const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2']; // low to high
const RANK_NAME = { J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace' };
const SEAT_COLORS = ['#f5c451', '#5ec8f2', '#c084fc', '#6ee7a8'];
const KIND_NAME = {
  single: 'Single', pair: 'Pair', triple: 'Triple', straight: 'Straight', flush: 'Flush',
  fullhouse: 'Full house', quads: 'Four of a kind', straightflush: 'Straight flush',
};
const DEAL = {
  2: { each: 17, note: '18 cards stay out of play' },
  3: { each: 17, note: 'last card turned face up for the 3♦ holder' },
  4: { each: 13, note: 'the whole deck' },
};

const rankOf = (c) => c.slice(0, -1);
const suitOf = (c) => c.slice(-1);
const rankIndex = (c) => RANKS.indexOf(rankOf(c));
const power = (c) => rankIndex(c) * 4 + SUITS.indexOf(suitOf(c));
const isRed = (c) => suitOf(c) === 'H' || suitOf(c) === 'D';
const label = (c) => rankOf(c) + SUIT_SYMBOL[suitOf(c)];
const cardText = (cards) => cards.map(label).join(' ');
const sortHand = (cards) => [...cards].sort((a, b) => power(a) - power(b));
const sortBySuit = (cards) => [...cards].sort((a, b) => SUITS.indexOf(suitOf(a)) - SUITS.indexOf(suitOf(b)) || rankIndex(a) - rankIndex(b));
const isOver = (g) => g.phase === 'done';
const seatColor = (seat) => SEAT_COLORS[seat % SEAT_COLORS.length];
const initialOf = (name) => ([...String(name || '?').trim()][0] || '?').toUpperCase();
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Classifies a set of cards, or null when it is not a legal combination. */
function classify(cards) {
  const n = cards.length;
  if (new Set(cards).size !== n) return null;
  const sorted = sortHand(cards);
  const top = sorted[n - 1];
  if (n === 1) return { kind: 'single', size: 1, tier: 0, power: power(top) };
  if (n === 2) return rankIndex(sorted[0]) === rankIndex(sorted[1]) ? { kind: 'pair', size: 2, tier: 0, power: power(top) } : null;
  if (n === 3) return sorted.every((c) => rankIndex(c) === rankIndex(top)) ? { kind: 'triple', size: 3, tier: 0, power: rankIndex(top) } : null;
  if (n !== 5) return null;

  const counts = new Map();
  for (const c of sorted) counts.set(rankIndex(c), (counts.get(rankIndex(c)) || 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const flush = sorted.every((c) => suitOf(c) === suitOf(top));
  const ranks = sorted.map(rankIndex);
  const straight = counts.size === 5 && ranks[4] <= RANKS.indexOf('A') && ranks[4] - ranks[0] === 4;

  if (straight && flush) return { kind: 'straightflush', size: 5, tier: 5, power: power(top) };
  if (groups[0][1] === 4) return { kind: 'quads', size: 5, tier: 4, power: groups[0][0] };
  if (groups[0][1] === 3 && groups[1] && groups[1][1] === 2) return { kind: 'fullhouse', size: 5, tier: 3, power: groups[0][0] };
  if (flush) return { kind: 'flush', size: 5, tier: 2, power: SUITS.indexOf(suitOf(top)) * 16 + rankIndex(top) };
  if (straight) return { kind: 'straight', size: 5, tier: 1, power: power(top) };
  return null;
}

function beats(a, b) {
  if (a.size !== b.size) return false;
  if (a.size === 5) return a.tier !== b.tier ? a.tier > b.tier : a.power > b.power;
  return a.power > b.power;
}

/** Why these cards can't be played right now (null when they can). Cosmetic: the room re-checks. */
function whyNot(g, cards) {
  if (!cards.length) return 'Select cards to play';
  const combo = classify(cards);
  if (!combo) return cards.length === 1 ? null : "That isn't a valid combination";
  if (g.mustInclude && !cards.includes(g.mustInclude)) return `The first play must include the ${label(g.mustInclude)}`;
  if (g.table && !beats(combo, g.table)) {
    return g.table.size === combo.size ? "That doesn't beat the table" : `Play ${g.table.size} card${g.table.size === 1 ? '' : 's'} to beat the table`;
  }
  return null;
}

/** Same-size strength order (weakest first). */
const comboOrder = (a, b) => (a.size === 5 && a.tier !== b.tier ? a.tier - b.tier : a.power - b.power);

let hintCache = { key: '', list: [] };
/**
 * Every play from my hand that the room would accept right now, weakest first. Following a play,
 * only same-size answers count; on a lead, five-card hands come first (they are the easiest to miss),
 * then triples, pairs and singles.
 */
function legalPlays(g) {
  if (!g?.hand || isOver(g)) return [];
  const hand = sortHand(g.hand);
  const key = `${hand.join()}|${g.table ? g.table.cards.join() : '-'}|${g.mustInclude || ''}`;
  if (hintCache.key === key) return hintCache.list;
  const sizes = g.table ? [g.table.size] : [5, 3, 2, 1];
  const found = [];
  const consider = (cards) => {
    const combo = classify(cards);
    if (combo && !whyNot(g, cards)) found.push({ cards, combo });
  };
  const byRank = new Map();
  for (const c of hand) byRank.set(rankIndex(c), [...(byRank.get(rankIndex(c)) || []), c]);
  for (const size of sizes) {
    if (size === 1) hand.forEach((c) => consider([c]));
    if (size === 2) for (const g2 of byRank.values()) for (let i = 0; i < g2.length; i++) for (let j = i + 1; j < g2.length; j++) consider([g2[i], g2[j]]);
    if (size === 3) for (const g3 of byRank.values()) if (g3.length >= 3) for (let i = 0; i < g3.length; i++) for (let j = i + 1; j < g3.length; j++) for (let k = j + 1; k < g3.length; k++) consider([g3[i], g3[j], g3[k]]);
    if (size === 5) {
      const n = hand.length;
      for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) for (let e = d + 1; e < n; e++) {
        consider([hand[a], hand[b], hand[c], hand[d], hand[e]]);
      }
    }
  }
  const rankSize = (x) => sizes.indexOf(x.combo.size);
  found.sort((x, y) => rankSize(x) - rankSize(y) || comboOrder(x.combo, y.combo));
  hintCache = { key, list: found.slice(0, 120) };
  return hintCache.list;
}

// ---------- DOM helpers ----------
const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

const ICON_PATHS = {
  sound: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/>',
  mute: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2.5"/>',
  log: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
};
function setIcon(node, name) {
  node.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</svg>`;
}

/**
 * One card face for every size (hand, table, log, flying copies): a corner index, a mirrored
 * corner, and a centre pip (court cards get a framed letter). `.card-corner` stays the tap
 * target tests aim for; `.td-cover` is the card back used while a card flips face up.
 */
function cardEl(code, { tag = 'div', mini = false } = {}) {
  const r = rankOf(code);
  const s = suitOf(code);
  const court = r === 'J' || r === 'Q' || r === 'K';
  const node = el(tag, `${mini ? 'card-mini' : 'card'} td-card ${isRed(code) ? 'red' : 'black'} suit-${s}${court ? ' td-court' : ''}${r === 'A' ? ' td-ace' : ''}${r === '10' ? ' td-ten' : ''}`);
  node.dataset.card = code;
  const corner = el('span', 'card-corner');
  corner.append(el('span', 'card-value', r), el('span', 'card-suit', SUIT_SYMBOL[s]));
  const foot = el('span', 'td-corner-b');
  foot.setAttribute('aria-hidden', 'true');
  foot.append(el('span', null, r), el('span', null, SUIT_SYMBOL[s]));
  let art;
  if (court) {
    art = el('span', 'td-court-art');
    art.append(el('span', 'td-court-letter', r), el('span', 'td-court-suit', SUIT_SYMBOL[s]));
  } else {
    art = el('span', 'td-pip', SUIT_SYMBOL[s]);
  }
  const cover = el('span', 'td-cover');
  node.append(corner, art, foot, cover);
  node.setAttribute('aria-label', `${RANK_NAME[r] ?? r} of ${SUIT_NAME[s]}`);
  return node;
}

/** A small inline card chip for the log, previews and results. */
function chipEl(code) {
  const chip = el('span', `td-chip-card ${isRed(code) ? 'red' : 'black'}`, label(code));
  chip.setAttribute('aria-label', `${RANK_NAME[rankOf(code)] ?? rankOf(code)} of ${SUIT_NAME[suitOf(code)]}`);
  return chip;
}
function chipsEl(cards) {
  const row = el('span', 'td-chips');
  row.append(...cards.map(chipEl));
  return row;
}
function backEl(cls = '') {
  return el('i', `td-back ${cls}`.trim());
}

function toast(message, kind = '') {
  const stack = $('toasts');
  const node = el('div', `td-toast ${kind}`.trim(), message);
  stack.append(node);
  while (stack.children.length > 3) stack.firstChild.remove();
  setTimeout(() => { node.classList.add('out'); setTimeout(() => node.remove(), 260); }, kind === 'error' ? 3800 : 2600);
}

/** Screen-reader play-by-play. */
function announce(text) {
  if (!text) return;
  const live = $('sr-live');
  live.append(el('p', null, text));
  while (live.children.length > 4) live.firstChild.remove();
}

// ---------- Identity ----------
function parseHash() {
  const raw = decodeURIComponent(location.hash.slice(1));
  if (!raw) return { room: null, pid: null };
  const [room, pid] = raw.split(':');
  return { room: /^[A-Za-z0-9]{4}$/.test(room) ? room.toUpperCase() : null, pid: pid || null };
}

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* blocked */ } },
};

const hashInfo = parseHash();
let playerId = hashInfo.pid || store.get('taidiPlayerId');
if (!playerId) playerId = (crypto.randomUUID?.() ?? `p${Date.now()}${Math.random().toString(36).slice(2)}`);
if (!hashInfo.pid) store.set('taidiPlayerId', playerId);
let playerName = store.get('playerName') || '';
let profile = null; // verified Telegram profile (FunAuth), null until signed in

// ---------- State ----------
let ws = null;
let roomCode = null;
let view = null;
let selected = new Set();
let reconnectDelay = 800;
let reconnectTimer = 0;
let lastGameNo = -1;
let overDismissed = false;
let joinSent = false;
/** 'full' when a join was rejected because the lobby was full; 'kicked' when removed by the host. */
let joinBlocked = null;
/** True once this tab has seen a game in this room (kept across reconnects, so a spectator is not auto-seated when the room returns to the lobby). */
let hasSeenGame = false;
let lastFocus = null;
const lobbySeen = new Set();
/** Hand order on screen: 'rank' (power order) or 'suit'. Purely cosmetic. */
let sortMode = store.get('taidiSort') === 'suit' ? 'suit' : 'rank';
/** Which suggestion the Hint button showed last, for the current hand and table. */
let hintAt = { key: '', index: -1 };

// ---------- Sound (synthesised, off by default) ----------
const sfx = (() => {
  let ctx = null;
  let on = store.get('taidiSound') === 'on';
  function audio() {
    if (!ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }
  function tone(freq, { at = 0, dur = 0.14, type = 'sine', gain = 0.1, slide = 0 } = {}) {
    const c = audio();
    if (!c) return;
    const t0 = c.currentTime + at;
    const osc = c.createOscillator();
    const amp = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(amp).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }
  function noise({ at = 0, dur = 0.1, gain = 0.12, freq = 1200 } = {}) {
    const c = audio();
    if (!c) return;
    const t0 = c.currentTime + at;
    const buffer = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = c.createBufferSource();
    const filter = c.createBiquadFilter();
    const amp = c.createGain();
    src.buffer = buffer;
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    amp.gain.value = gain;
    src.connect(filter).connect(amp).connect(c.destination);
    src.start(t0);
  }
  const SOUNDS = {
    card: () => noise({ dur: 0.07, gain: 0.1, freq: 2600 }),
    pick: () => tone(1320, { dur: 0.04, type: 'triangle', gain: 0.025 }),
    deal: () => [0, 0.06, 0.12, 0.18].forEach((d) => noise({ at: d, dur: 0.05, gain: 0.07, freq: 3000 })),
    pass: () => tone(240, { dur: 0.12, type: 'triangle', gain: 0.05, slide: -60 }),
    trick: () => { noise({ dur: 0.16, gain: 0.08, freq: 1800 }); tone(520, { dur: 0.16, type: 'triangle', gain: 0.05, slide: 260 }); },
    combo: () => [523, 659, 784].forEach((f, i) => tone(f, { at: i * 0.06, dur: 0.2, type: 'triangle', gain: 0.07 })),
    big: () => { [392, 523, 659, 784, 1047].forEach((f, i) => tone(f, { at: i * 0.06, dur: 0.26, type: 'triangle', gain: 0.08 })); noise({ dur: 0.18, gain: 0.14, freq: 500 }); },
    warn: () => { tone(880, { dur: 0.1, type: 'square', gain: 0.03 }); tone(880, { at: 0.14, dur: 0.1, type: 'square', gain: 0.03 }); },
    turn: () => { tone(660, { dur: 0.1, gain: 0.07 }); tone(990, { at: 0.1, dur: 0.16, gain: 0.07 }); },
    win: () => [523, 659, 784, 659, 784, 1047].forEach((f, i) => tone(f, { at: i * 0.12, dur: 0.3, type: 'triangle', gain: 0.09 })),
    lose: () => [392, 349, 311, 262].forEach((f, i) => tone(f, { at: i * 0.18, dur: 0.38, type: 'sawtooth', gain: 0.045 })),
  };
  return {
    get on() { return on; },
    play(name, delayMs = 0) {
      if (!on || !SOUNDS[name]) return;
      const run = () => { try { SOUNDS[name](); } catch { /* audio unavailable */ } };
      if (delayMs > 0) at(delayMs, run); // cancelled with the animation on a newer state or leave
      else run();
    },
    toggle() {
      on = !on;
      store.set('taidiSound', on ? 'on' : 'off');
      if (on) this.play('turn');
      return on;
    },
  };
})();

function vibrate(pattern) {
  try { if (navigator.vibrate && matchMedia('(pointer: coarse)').matches) navigator.vibrate(pattern); } catch { /* unsupported */ }
}

// ---------- Animation layer ----------
// Every state is rendered immediately (the table is always authoritative). Animations then
// replay the new log entries on top: cards fly from hand or seat to the felt (flipping face
// up when they come from another player), passes and combos float up, a won trick sweeps to
// its leader. They never take input, and a newer state finishes them instantly.
const FLY = 380;
const fx = { timers: new Set(), anims: new Set() };

function motionOK() {
  return !matchMedia('(prefers-reduced-motion: reduce)').matches && document.visibilityState === 'visible';
}
function at(ms, fn) {
  if (ms <= 0) { fn(); return; }
  const id = setTimeout(() => { fx.timers.delete(id); fn(); }, ms);
  fx.timers.add(id);
}
function anim(node, keyframes, opts) {
  if (!node?.animate) return null;
  const a = node.animate(keyframes, opts);
  fx.anims.add(a);
  a.finished.catch(() => {}).then(() => fx.anims.delete(a));
  return a;
}
function fxReset() {
  for (const id of fx.timers) clearTimeout(id);
  fx.timers.clear();
  for (const a of fx.anims) { try { a.finish(); } catch { a.cancel(); } }
  fx.anims.clear();
  $('fx').replaceChildren();
}

const R = (node) => {
  const r = node?.getBoundingClientRect?.();
  return r && r.width > 0 && r.height > 0 ? r : null;
};
const centerOf = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
/** A card-shaped box of width `w` centred on a rect. */
function cardBox(r, w = 34) {
  const c = centerOf(r);
  const h = w * 1.4;
  return { left: c.x - w / 2, top: c.y - h / 2, width: w, height: h, angle: 0 };
}
const plateOf = (seat) => document.querySelector(`#opponents .td-plate[data-seat="${seat}"]`);
const avatarOf = (seat) => plateOf(seat)?.querySelector('.td-avatar') ?? plateOf(seat);

/** Where a seat "is" on screen: its avatar on the felt, or my own hand. */
function anchorOf(seat) {
  const r = seat === view.you.seat ? R($('hand')) ?? R($('turn-banner')) : R(avatarOf(seat));
  return r ? centerOf(r) : null;
}

function snapshotScene() {
  const hand = new Map();
  for (const n of document.querySelectorAll('#hand .hand-card')) {
    const r = R(n);
    if (!r) continue;
    const c = centerOf(r);
    const w = n.offsetWidth;
    const h = n.offsetHeight;
    hand.set(n.dataset.card, { left: c.x - w / 2, top: c.y - h / 2, width: w, height: h, angle: parseFloat(n.style.getPropertyValue('--card-angle')) || 0 });
  }
  const table = [...document.querySelectorAll('#table-play .card-mini')].map((n) => ({ code: n.dataset.card, rect: R(n) })).filter((p) => p.rect);
  return { active: $('screen-game').classList.contains('active'), hand, table };
}

/** Moves a detached node from one box to another inside the fx layer. */
function flyNode(node, from, to, { delay = 0, duration = 420, rotate = [0, 0], fadeOut = false, arc = 0, easing = 'cubic-bezier(.2,.75,.25,1)', onLand } = {}) {
  if (!from || !to) return;
  node.classList.add('td-fly');
  Object.assign(node.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
  node.style.setProperty('--w', `${from.width}px`);
  $('fx').append(node);
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const s = to.width / from.width;
  const frames = [{ transform: `translate(0px, 0px) scale(1) rotate(${rotate[0]}deg)`, opacity: 1 }];
  if (arc) frames.push({ transform: `translate(${dx / 2}px, ${dy / 2 - arc}px) scale(${(1 + s) / 2}) rotate(${(rotate[0] + rotate[1]) / 2}deg)`, opacity: 1, offset: 0.5 });
  frames.push({ transform: `translate(${dx}px, ${dy}px) scale(${s}) rotate(${rotate[1]}deg)`, opacity: fadeOut ? 0 : 1 });
  const a = anim(node, frames, { duration, delay, easing, fill: 'both' });
  if (!a) { node.remove(); return; }
  a.finished.then(() => { node.remove(); onLand?.(); }).catch(() => node.remove());
}

/** FLIP: a real element appears to travel from `from` to where it now sits; `flip` turns it face up on the way. */
function flipFrom(node, from, { delay = 0, duration = FLY, arc = 0, flip = false } = {}) {
  const to = R(node);
  if (!to || !from) return;
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  const s = from.width / to.width;
  const mid = flip ? ' scaleX(0.06)' : '';
  const frames = [{ transform: `translate(${dx}px, ${dy}px) scale(${s}) rotate(${from.angle || 0}deg)`, zIndex: 5 }];
  if (arc || flip) frames.push({ transform: `translate(${dx / 2}px, ${dy / 2 - arc}px) scale(${(1 + s) / 2}) rotate(${(from.angle || 0) / 2}deg)${mid}`, zIndex: 5, offset: 0.55 });
  frames.push({ transform: 'none', zIndex: 5 });
  anim(node, frames, { duration, delay, easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'backwards' });
  const cover = flip && node.querySelector('.td-cover');
  if (cover) anim(cover, [{ opacity: 1 }, { opacity: 1, offset: 0.54 }, { opacity: 0, offset: 0.56 }, { opacity: 0 }], { duration, delay, fill: 'backwards' });
}

function floatText(text, point, { cls = '', delay = 0, duration = 1100, rise = 48 } = {}) {
  if (!point) return;
  at(delay, () => {
    const n = el('div', `td-float ${cls}`.trim(), text);
    n.style.left = `${point.x}px`;
    n.style.top = `${point.y}px`;
    $('fx').append(n);
    const a = anim(n, [
      { transform: 'translate(-50%, -50%) scale(.5)', opacity: 0 },
      { transform: 'translate(-50%, -50%) translateY(-10px) scale(1.18)', opacity: 1, offset: 0.18 },
      { transform: 'translate(-50%, -50%) translateY(-18px) scale(1)', opacity: 1, offset: 0.55 },
      { transform: `translate(-50%, -50%) translateY(-${rise}px) scale(.96)`, opacity: 0 },
    ], { duration, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'forwards' });
    a?.finished.then(() => n.remove()).catch(() => n.remove());
  });
}

function burst(point, { n = 16, colors = ['#f5c451', '#fff3c4', '#ff9f43'], delay = 0, spread = 100, size = 7 } = {}) {
  if (!point) return;
  at(delay, () => {
    for (let i = 0; i < n; i++) {
      const p = el('i', 'td-particle');
      const angle = (Math.PI * 2 * i) / n + Math.random() * 0.6;
      const dist = spread * (0.5 + Math.random() * 0.7);
      Object.assign(p.style, { left: `${point.x}px`, top: `${point.y}px`, width: `${size}px`, height: `${size}px`, background: colors[i % colors.length] });
      $('fx').append(p);
      const a = anim(p, [
        { transform: 'translate(-50%, -50%) scale(1) rotate(0deg)', opacity: 1 },
        { transform: `translate(-50%, -50%) translate(${Math.cos(angle) * dist}px, ${Math.sin(angle) * dist + 18}px) scale(.3) rotate(${180 + Math.random() * 180}deg)`, opacity: 0 },
      ], { duration: 700 + Math.random() * 300, easing: 'cubic-bezier(.15,.7,.3,1)', fill: 'forwards' });
      a?.finished.then(() => p.remove()).catch(() => p.remove());
    }
  });
}

/** A big caption over the felt ("Your turn", "X opens", …). */
function callout(text, kind = '', delay = 0, { sub = '', y = 0.5, duration = 1400 } = {}) {
  at(delay, () => {
    const t = R($('td-felt')) ?? R($('td-table'));
    if (!t) return;
    const n = el('div', `td-callout ${kind}`.trim());
    n.append(el('span', 'td-callout-main', text));
    if (sub) n.append(el('span', 'td-callout-sub', sub));
    n.style.left = `${t.left + t.width / 2}px`;
    n.style.top = `${t.top + t.height * y}px`;
    $('fx').append(n);
    const a = anim(n, [
      { opacity: 0, transform: 'translate(-50%, -50%) scale(.7)', filter: 'blur(6px)' },
      { opacity: 1, transform: 'translate(-50%, -50%) scale(1.05)', filter: 'blur(0)', offset: 0.16 },
      { opacity: 1, transform: 'translate(-50%, -50%) scale(1)', filter: 'blur(0)', offset: 0.78 },
      { opacity: 0, transform: 'translate(-50%, -50%) scale(1.06)', filter: 'blur(3px)' },
    ], { duration, easing: 'ease-out', fill: 'forwards' });
    a?.finished.then(() => n.remove()).catch(() => n.remove());
  });
}

function overlayFlash(cls, delay = 0, rect = null, duration = 650) {
  at(delay, () => {
    const n = el('div', `td-flash ${cls}`);
    const r = rect ?? { left: 0, top: 0, width: innerWidth, height: innerHeight };
    Object.assign(n.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    $('fx').append(n);
    const a = anim(n, [{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 0 }], { duration, easing: 'ease-out', fill: 'forwards' });
    a?.finished.then(() => n.remove()).catch(() => n.remove());
  });
}

function pulse(node, delay = 0, scale = 1.1) {
  if (!node) return;
  anim(node, [{ transform: 'scale(1)' }, { transform: `scale(${scale})`, offset: 0.4 }, { transform: 'scale(1)' }], { duration: 380, delay, easing: 'ease-out' });
}

function shake(node) {
  if (!node || !motionOK()) return;
  anim(node, [
    { transform: 'none' }, { transform: 'translateX(-7px)', offset: 0.2 }, { transform: 'translateX(6px)', offset: 0.45 },
    { transform: 'translateX(-3px)', offset: 0.7 }, { transform: 'none' },
  ], { duration: 320 });
}

function confetti(delay = 0) {
  at(delay, () => {
    const colors = ['#f5c451', '#ff6b6b', '#5ec8f2', '#6ee7a8', '#c084fc', '#fff3c4'];
    for (let i = 0; i < 64; i++) {
      const p = el('i', 'td-confetti');
      Object.assign(p.style, { left: `${Math.random() * innerWidth}px`, top: '-16px', background: colors[i % colors.length] });
      $('fx').append(p);
      const drift = (Math.random() - 0.5) * 160;
      const a = anim(p, [
        { transform: 'translate(0, 0) rotate(0deg)', opacity: 1 },
        { transform: `translate(${drift}px, ${innerHeight * (0.7 + Math.random() * 0.35)}px) rotate(${360 + Math.random() * 540}deg)`, opacity: 0.2 },
      ], { duration: 1800 + Math.random() * 1400, delay: Math.random() * 500, easing: 'cubic-bezier(.25,.6,.45,1)', fill: 'both' });
      a?.finished.then(() => p.remove()).catch(() => p.remove());
    }
  });
}

/** Where a played card starts: my own card's spot in hand, otherwise its owner's card backs. */
function sourceBox(code, seat, ctx, i = 0, n = 1) {
  if (seat === ctx.me) {
    const h = ctx.scene.hand.get(code);
    if (h) return h;
  }
  const plate = plateOf(seat);
  const pr = R(plate?.querySelector('.td-backs')) ?? R(avatarOf(seat)) ?? (seat === ctx.me ? R($('hand')) : null);
  if (!pr) return null;
  const b = cardBox(pr, 26);
  b.left += (i - (n - 1) / 2) * 10;
  return b;
}

/** The middle of the felt, where plays land. */
function feltBox(w = 56) {
  const r = R($('table-play')) ?? R($('td-felt'));
  return r ? cardBox(r, w) : null;
}

/** Plays the new log entries in order; returns how long the sequence runs (ms). */
function animateTransition(prev, next, scene) {
  const g = next.game;
  if (!motionOK() || !$('screen-game').classList.contains('active')) return 0;
  const pg = prev?.game;
  if (!pg || prev.gameNo !== next.gameNo || !scene.active) return g.log.length === 0 && !isOver(g) ? dealTimeline(g, next.you.seat) : 0;
  const lastSeq = pg.log.at(-1)?.seq ?? 0;
  if ((g.log.at(-1)?.seq ?? 0) < lastSeq) return 0; // log was reset (dev patch)
  const events = g.log.filter((e) => e.seq > lastSeq);
  if (!events.length || events.length > 12) return 0;

  const me = next.you.seat;
  const ctx = { g, pg, me, scene, events, held: [], tableHandled: false };
  let t = 0;
  for (const e of events) t = runEffect(e, ctx, t);

  // Turn hand-off cues.
  const myTurn = me >= 0 && g.currentSeat === me && !isOver(g);
  if (myTurn && (pg.currentSeat !== me || pg.phase !== 'play')) {
    callout(g.table ? 'Your turn' : 'Your lead', '', t + 40, { duration: 1000, sub: g.table ? `Beat the ${KIND_NAME[g.table.kind].toLowerCase()} or pass` : 'Play anything' });
    sfx.play('turn', t + 40);
    at(t + 40, () => vibrate(30));
    t += 120;
  }
  return t;
}

function runEffect(e, ctx, t) {
  switch (e.t) {
    case 'play': return fxPlay(e, ctx, t);
    case 'pass': return fxPass(e, ctx, t);
    case 'trick': return fxTrick(e, ctx, t);
    case 'won': return fxWon(e, ctx, t);
  }
  return t;
}

/**
 * Plays that landed (or are still landing) on the felt earlier in this update leave at time `t`:
 * covered by a newer play, or swept to whoever takes the table (`to`). Entries are registered
 * when their flight is scheduled, so a card still in the air is never left behind.
 */
function clearHeld(ctx, t, to = null, rotate = 0) {
  const entries = ctx.held.splice(0);
  if (!entries.length) return;
  at(t, () => {
    for (const h of entries) {
      h.gone = true;
      h.node?.remove();
      const copy = cardEl(h.code, { mini: true });
      if (to) flyNode(copy, h.box, to, { duration: 460, fadeOut: true, easing: 'cubic-bezier(.5,0,.75,.4)', rotate: [0, rotate] });
      else flyNode(copy, h.box, { ...h.box, width: h.box.width * 0.86, height: h.box.height * 0.86 }, { duration: FLY, fadeOut: true, easing: 'ease-in' });
    }
  });
}

function fxPlay(e, ctx, t) {
  const sources = e.cards.map((c, i) => sourceBox(c, e.seat, ctx, i, e.cards.length));
  const finalTable = ctx.g.table?.cards.join(',') === e.cards.join(',') ? [...document.querySelectorAll('#table-play .card-mini')] : null;
  const fromOther = e.seat !== ctx.me;

  // What was lying there before is covered up by the new play.
  if (!ctx.tableHandled && ctx.scene.table.length) {
    ctx.tableHandled = true;
    for (const old of ctx.scene.table) {
      flyNode(cardEl(old.code, { mini: true }), old.rect, { ...old.rect, width: old.rect.width * 0.86, height: old.rect.height * 0.86 }, { delay: t, duration: FLY, fadeOut: true, easing: 'ease-in' });
    }
  }
  clearHeld(ctx, t);
  sfx.play('card', t);
  if (finalTable) {
    finalTable.forEach((node, i) => flipFrom(node, sources[i], { delay: t + i * 55, arc: 26, flip: fromOther, duration: fromOther ? FLY + 80 : FLY }));
    anim($('play-tag'), [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, delay: t + FLY, fill: 'backwards' });
  } else {
    // This play was answered or cleared within the same update: let it land on the felt, then wait to be swept.
    const target = feltBox(54);
    e.cards.forEach((c, i) => {
      const box = target ? { ...target, left: target.left + (i - (e.cards.length - 1) / 2) * 30 } : null;
      const flying = cardEl(c, { mini: true });
      const entry = { code: c, box, node: flying, gone: false };
      if (box) ctx.held.push(entry);
      flyNode(flying, sources[i], box, {
        delay: t + i * 55, duration: FLY, arc: 26,
        onLand: () => {
          if (!box || entry.gone) return;
          const rest = cardEl(c, { mini: true });
          rest.classList.add('td-fly');
          Object.assign(rest.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
          rest.style.setProperty('--w', `${box.width}px`);
          $('fx').append(rest);
          entry.node = rest;
        },
      });
    });
  }

  let end = t + FLY + (e.cards.length - 1) * 55;
  // Combo names pop over the middle of the cards that were just played.
  const zone = R($('table-play'));
  const point = zone ? centerOf(zone) : null;
  const plate = plateOf(e.seat);
  if (plate && fromOther) pulse(avatarOf(e.seat), t + FLY);
  if (e.kind === 'quads' || e.kind === 'straightflush') {
    floatText(`${KIND_NAME[e.kind]}!`, point, { cls: 'td-float-big', delay: end - 120, duration: 1500, rise: 60 });
    burst(point, { n: 22, delay: end - 80, spread: 120 });
    overlayFlash('td-flash-big', end - 100, R($('td-felt')), 800);
    sfx.play('big', end - 100);
    at(end, () => vibrate([20, 40, 30]));
    end += 260;
  } else if (e.cards.length === 5) {
    floatText(`${KIND_NAME[e.kind]}!`, point, { cls: 'td-float-combo', delay: end - 120, duration: 1300 });
    burst(point, { n: 10, delay: end - 80, spread: 80 });
    sfx.play('combo', end - 100);
    end += 160;
  } else if (e.cards.every((c) => rankOf(c) === '2')) {
    // 2s are the top of their kind: give them a little weight.
    floatText({ 1: 'Big 2!', 2: 'Pair of 2s!', 3: 'Three 2s!' }[e.cards.length], point, { cls: 'td-float-combo', delay: end - 120, duration: 1200 });
    end += 120;
  }
  // The last time this seat plays in this update: warn if they're nearly out.
  const lastPlayOfSeat = [...ctx.events].reverse().find((x) => x.t === 'play' && x.seat === e.seat);
  const left = ctx.g.handCounts[e.seat];
  if (lastPlayOfSeat === e && left === 1 && !isOver(ctx.g)) {
    floatText(e.seat === ctx.me ? 'Last card!' : '1 card left!', anchorOf(e.seat), { cls: 'td-float-out', delay: end - 60, duration: 1300 });
    sfx.play('warn', end - 60);
    end += 120;
  }
  return end - FLY * 0.45;
}

function fxPass(e, ctx, t) {
  const p = anchorOf(e.seat);
  floatText('Pass', p, { cls: 'td-float-pass', delay: t, duration: 900, rise: 34 });
  sfx.play('pass', t);
  return t + 300;
}

function fxTrick(e, ctx, t) {
  // Everything lying on the felt is swept to whoever takes it.
  const winnerPoint = anchorOf(e.seat);
  const to = winnerPoint ? { left: winnerPoint.x - 10, top: winnerPoint.y - 14, width: 20, height: 28, angle: 0 } : null;
  const tilt = e.seat === ctx.me ? 0 : 12;
  clearHeld(ctx, t, to, tilt);
  if (!ctx.tableHandled) {
    ctx.tableHandled = true;
    // Cards that were already on the table before this update: their copies hold the spot until swept.
    for (const old of ctx.scene.table) {
      flyNode(cardEl(old.code, { mini: true }), old.rect, to, { delay: t, duration: 460, fadeOut: true, easing: 'cubic-bezier(.5,0,.75,.4)', rotate: [0, tilt] });
    }
  }
  sfx.play('trick', t);
  if (e.seat !== ctx.me) pulse(avatarOf(e.seat), t + 420);
  floatText(e.seat === ctx.me ? 'You lead' : `${who(e.seat)} leads`, winnerPoint, { cls: 'td-float-lead', delay: t + 380, duration: 1000, rise: 36 });
  return t + 520;
}

function fxWon(e, ctx, t) {
  const mine = e.seat === ctx.me;
  if (mine) {
    confetti(t);
    callout('You went out!', 'good', t, { sub: 'First to empty their hand', duration: 1800 });
    sfx.play('win', t);
    at(t, () => vibrate([30, 60, 30, 60, 60]));
  } else {
    callout(`${who(e.seat)} went out`, '', t, { sub: ctx.me >= 0 ? 'Better luck next hand' : '', duration: 1500 });
    sfx.play(ctx.me >= 0 ? 'lose' : 'win', t);
  }
  burst(anchorOf(e.seat), { n: 18, delay: t, spread: 110 });
  overlayFlash('td-flash-big', t, R($('td-felt')), 900);
  return t + 900;
}

/** A fresh deal: cards fan out from the middle of the table to every seat, then the opener is called. */
function dealTimeline(g, me) {
  const from = feltBox(40);
  const handCards = [...document.querySelectorAll('#hand .hand-card')];
  if (from) {
    for (const [i, node] of handCards.entries()) {
      const to = R(node);
      if (!to) continue;
      const angle = parseFloat(node.style.getPropertyValue('--card-angle')) || 0;
      const dx = from.left + from.width / 2 - (to.left + to.width / 2);
      const dy = from.top + from.height / 2 - (to.top + to.height / 2);
      anim(node, [
        { transform: `translate(${dx}px, ${dy}px) scale(${from.width / node.offsetWidth}) rotate(0deg)`, opacity: 0 },
        { opacity: 1, offset: 0.2 },
        { transform: `rotate(${angle}deg)`, opacity: 1 },
      ], { duration: 460, delay: 120 + i * 38, easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'backwards' });
    }
    // Card backs travel to every other seat.
    document.querySelectorAll('#opponents .td-plate').forEach((p, s) => {
      const target = R(p.querySelector('.td-backs')) ?? R(p.querySelector('.td-avatar'));
      if (!target) return;
      for (let k = 0; k < 4; k++) {
        flyNode(backEl('td-fly-back'), from, cardBox(target, 18), { delay: 120 + s * 60 + k * 110, duration: 420, arc: 18, fadeOut: true });
      }
    });
  }
  document.querySelectorAll('#opponents .td-plate').forEach((p, i) => {
    anim(p, [{ opacity: 0, transform: 'scale(.85)' }, { opacity: 1, transform: 'none' }], { duration: 360, delay: i * 90, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'backwards' });
  });
  const n = handCards.length;
  const dealt = 160 + Math.max(n, 4) * 38 + 380;
  sfx.play('deal', 100);
  const opener = g.currentSeat;
  callout(opener === me ? 'You open' : `${playerNameOf(opener)} opens`, '', dealt - 200, { sub: g.mustInclude ? `with the ${label(g.mustInclude)}` : '', duration: 1300 });
  return dealt + 200;
}

// ---------- Networking ----------
function connect(code) {
  if (window.FC_MOVED) return; // this page is forwarding to funcentral.vocs.io (fc-host.js)
  roomCode = code;
  clearTimeout(reconnectTimer);
  if (ws) { ws.onclose = null; ws.close(); }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = FunAuth.token();
  const socket = new WebSocket(`${proto}//${location.host}/api/taidi/ws?room=${code}&playerId=${encodeURIComponent(playerId)}${token ? `&token=${encodeURIComponent(token)}` : ''}`);
  ws = socket;
  joinSent = false;
  socket.onopen = () => {
    reconnectDelay = 800;
    $('overlay-reconnect').classList.add('hidden');
  };
  socket.onmessage = (event) => {
    if (ws !== socket) return;
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === 'state') onState(msg);
    else if (msg.type === 'error') onError(msg);
  };
  socket.onclose = (event) => {
    if (ws !== socket || !roomCode) return;
    // The room replaced this connection with a newer one (another tab/browser): stop here.
    // Coming back to this tab reconnects (visibilitychange) and takes the seat back.
    if (event.reason === 'Replaced by new connection') {
      toast('This game is open in another window — come back here to take it over');
      return;
    }
    $('overlay-reconnect').classList.remove('hidden');
    reconnectTimer = setTimeout(() => connect(roomCode), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.8, 10000);
  };
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  else toast('Reconnecting… try again in a moment', 'error');
}

function onError(msg) {
  if (msg.code === 'notFound') {
    toast(`Room ${roomCode} doesn't exist (or has expired)`, 'error');
    leaveRoom(false);
    return;
  }
  // A rejected join must not leave the lobby saying "Joining…" forever: remember
  // why it was rejected so the lobby can offer an explicit Take a Seat action
  // (full lobby) or say the player was removed (kicked), instead of auto-retrying.
  if (msg.message?.includes('removed from this lobby')) joinBlocked = 'kicked';
  else if (msg.message?.includes('This room is full')) joinBlocked = 'full';
  toast(msg.message, 'error');
  shake($('hand'));
  if (view && !view.game) render();
}

let overPending = false; // hold the results panel until the closing animation has played

function onState(next) {
  const prev = view;
  if (next.game) {
    hasSeenGame = true;
    if (roomCode) store.set(`taidiWatched:${roomCode}`, '1');
  }
  if (next.you?.kicked) joinBlocked = 'kicked';
  // Connection flags, names and late rating results don't change the game itself: refresh those
  // parts without interrupting an animation or the pending results panel.
  if (next.game && prev?.game && prev.gameNo === next.gameNo && JSON.stringify(next.game) === JSON.stringify(prev.game)) {
    view = next;
    renderTopBar();
    renderOpponents(next.game);
    renderMe(next.game);
    renderBanner(next.game, next.you.seat >= 0 && next.game.currentSeat === next.you.seat && !isOver(next.game));
    if (!overPending) syncOverModal();
    return;
  }
  // Finish any running animation first, so the snapshot reflects the settled table.
  fxReset();
  overPending = false;
  const scene = snapshotScene();
  view = next;
  if (next.you.kicked) joinBlocked = 'kicked';
  if (next.you.seat >= 0) { joinSent = true; joinBlocked = null; } // seated: never auto-join again on this connection (e.g. after a kick)
  if (next.game) {
    hasSeenGame = true;
    if (roomCode) store.set(`taidiWatched:${roomCode}`, '1');
  }
  // Join on first contact if we aren't seated yet and the game hasn't started (signed-in players only).
  // Never auto-join a spectator back in after a game, a kicked player, or a
  // rejected full-lobby join: those need an explicit Take a Seat (or stay out).
  if (!joinSent && next.you.seat < 0 && !next.game && FunAuth.token() && !hasSeenGame && !joinBlocked) {
    joinSent = true;
    send({ type: 'join', name: playerName });
  }
  if (next.gameNo !== lastGameNo) {
    lastGameNo = next.gameNo;
    overDismissed = false;
    selected.clear();
  }
  // A selection can be lined up while others play; it only keeps cards still in hand.
  const g = next.game;
  const pg = prev?.game;
  if (!g || isOver(g)) selected.clear();
  if (g?.hand) selected = new Set([...selected].filter((c) => g.hand.includes(c)));
  overPending = !!g && isOver(g);
  render();
  if (g && pg && prev.gameNo === next.gameNo) {
    const lastSeq = pg.log.at(-1)?.seq ?? 0;
    announce(g.log.filter((e) => e.seq > lastSeq).slice(-4).map(describe).join('. '));
  }
  const t = g ? animateTransition(prev, next, scene) : 0;
  if (overPending) at(t > 0 ? t + 500 : 0, () => { overPending = false; syncOverModal(); });
}

// ---------- Screens ----------
function showScreen(id) {
  for (const sc of document.querySelectorAll('.screen')) sc.classList.toggle('active', sc.id === id);
  document.body.dataset.screen = id;
  if (id !== 'screen-game') setLogOpen(false);
  keepAwake(id === 'screen-game' && !!view?.game && !isOver(view.game));
}

// Phones dim and lock mid-game while others think: hold a screen wake lock during play.
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener?.('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      await lock.release();
    }
  } catch { wakeLock = null; /* not allowed or unsupported */ }
}

function render() {
  const inRoom = !!roomCode;
  $('top-bar').classList.toggle('hidden', !inRoom);
  $('tb-room').textContent = roomCode || '';
  $('tb-name').textContent = playerName;
  renderTopBar();
  if (!inRoom) { showScreen('screen-home'); return; }
  if (!view) { showScreen('screen-lobby'); renderLobbyLoading(); return; }
  if (!view.game) { showScreen('screen-lobby'); renderLobby(); hideModal('modal-over'); return; }
  showScreen('screen-game');
  renderGame();
  if (!overPending) syncOverModal();
}

function renderTopBar() {
  const sound = $('btn-sound');
  setIcon(sound, sfx.on ? 'sound' : 'mute');
  sound.setAttribute('aria-pressed', String(sfx.on));
  sound.title = sfx.on ? 'Sound effects on' : 'Sound effects off';
  const g = view?.game;
  $('btn-end').classList.toggle('hidden', !(g && !isOver(g) && view.you.isHost && view.you.seat >= 0));
  $('btn-log').classList.toggle('hidden', !g);
}

// ---------- Lobby ----------
function renderLobbyLoading() {
  $('lobby-code').textContent = roomCode;
  $('lobby-players').replaceChildren(el('div', 'player-item td-empty td-connecting', 'Connecting…'));
  $('btn-start').classList.add('hidden');
  $('lobby-wait').textContent = '';
  $('lobby-setup').classList.add('hidden');
}

function statusDot(connected) {
  return el('span', `status-dot ${connected ? 'online' : 'offline'}`);
}

function avatarEl(p, seat) {
  const avatar = el('span', 'td-avatar', initialOf(p?.name));
  avatar.style.setProperty('--seat-color', seatColor(seat));
  if (p) avatar.append(statusDot(p.connected));
  return avatar;
}

function renderLobby() {
  const { players, you } = view;
  const max = view.maxPlayers;
  const min = view.minPlayers;
  $('lobby-code').textContent = view.roomCode;
  const list = $('lobby-players');
  list.replaceChildren();
  players.forEach((p, seat) => {
    const item = el('div', `player-item td-player${p.id === you.id ? ' is-you' : ''}`);
    item.style.setProperty('--seat-color', seatColor(seat));
    const identity = el('div', 'lobby-identity');
    identity.append(el('span', 'lobby-player-name', p.name));
    const meta = el('div', 'lobby-meta');
    if (p.id === you.id) meta.append(el('span', 'td-you', 'you'));
    if (p.isHost) meta.append(el('span', 'td-host', '👑 Host'));
    // Same signal as Bridge: non-members still play and are rated, but don't count for this group.
    if (p.isGroupMember === false) meta.append(el('span', 'not-ranked-badge', '⚠️ not in group'));
    if (!p.connected) meta.append(el('span', 'td-offline', 'offline'));
    if (!meta.childElementCount) meta.append(el('span', 'td-seat-no', `Seat ${seat + 1}`));
    const action = el('div', 'lobby-action');
    item.append(avatarEl(p, seat), identity, meta, action);
    if (!lobbySeen.has(p.id)) { lobbySeen.add(p.id); item.classList.add('td-enter'); }
    if (you.isHost && p.id !== you.id) {
      const kick = el('button', 'kick-btn', '✕');
      kick.type = 'button';
      kick.setAttribute('aria-label', `Remove ${p.name}`);
      kick.title = `Remove ${p.name}`;
      kick.onclick = () => send({ type: 'kick', playerId: p.id });
      action.append(kick);
    } else {
      item.classList.add('no-action');
    }
    list.append(item);
  });
  for (let i = players.length; i < max; i++) {
    const open = el('div', `player-item td-empty${i < min ? ' needed' : ''}`);
    const plus = el('span', 'td-avatar td-avatar-empty', '+');
    open.append(plus, el('span', 'td-empty-label', i < min ? 'Waiting for a player' : 'Open seat'));
    list.append(open);
  }

  const n = players.length;
  const setup = $('lobby-setup');
  setup.classList.toggle('hidden', n < min);
  if (n >= min) {
    const d = DEAL[n];
    const backs = el('span', 'td-setup-backs');
    for (let i = 0; i < Math.min(5, n + 1); i++) backs.append(backEl());
    const text = el('div', 'td-setup-text');
    text.append(el('div', 'td-setup-mode', `${n} players · ${d.each} cards each`), el('div', 'td-setup-note', d.note));
    if (view.groupName) text.append(el('div', 'td-setup-group', `💬 ${view.groupName}`));
    setup.replaceChildren(backs, text);
  }

  const seated = you.seat >= 0;
  $('btn-start').classList.toggle('hidden', !you.isHost);
  $('btn-start').disabled = n < min;
  const takeSeat = $('btn-take-seat');
  if (!seated && !FunAuth.token()) {
    $('lobby-wait').textContent = 'Sign in with Telegram on the Tai Di home screen to take a seat — you can watch until then.';
    takeSeat.classList.add('hidden');
    return;
  }
  $('btn-start').textContent = n < min ? `Need ${min - n} more to start` : `Start game · ${n} players`;
  const wait = $('lobby-wait');
  if (!seated && joinBlocked === 'kicked') {
    wait.textContent = 'You were removed from this lobby.';
    takeSeat.classList.add('hidden');
  } else if (!seated && (joinBlocked === 'full' || hasSeenGame)) {
    // Explicit action, not another auto-join: the visitor was rejected while full,
    // or watched a game and stayed a spectator when it ended.
    wait.textContent = n >= max
      ? 'This room is full — take a seat when one opens.'
      : joinBlocked === 'full' ? 'A seat is open — take it to play.' : 'You were watching — take a seat to play.';
    takeSeat.classList.remove('hidden');
    takeSeat.disabled = n >= max;
  } else {
    takeSeat.classList.add('hidden');
    wait.textContent = !seated
      ? (n >= max ? 'This room is full.' : 'Joining…')
      : you.isHost
        ? (n < min ? `Share the code — you need at least ${min} players.` : n < max ? `Share the code — up to ${max} can play, or start now.` : 'Table is full — ready when you are.')
        : `Waiting for ${players.find((p) => p.isHost)?.name ?? 'the host'} to start...`;
  }
}

// ---------- Game rendering ----------
const playerNameOf = (seat) => view.players[seat]?.name ?? `Player ${seat + 1}`;
const who = (seat) => (seat === view.you.seat ? 'You' : playerNameOf(seat));

function renderGame() {
  const g = view.game;
  const myTurn = view.you.seat >= 0 && g.currentSeat === view.you.seat && !isOver(g);
  const game = $('td-game');
  game.classList.toggle('my-turn', myTurn);
  game.classList.toggle('watching', view.you.seat < 0);
  game.dataset.players = String(g.numPlayers);
  renderOpponents(g);
  renderMe(g);
  renderTable(g);
  renderBanner(g, myTurn);
  renderHand(g, myTurn);
  renderPreview(g, myTurn);
  renderActions(g, myTurn);
  renderLog(g);
}

/**
 * Seats around the felt, counter-clockwise from the bottom (the next player sits on the right).
 * A seated player is at the bottom with their hand; a spectator sees every seat on the felt.
 */
function seatLayout(n, me) {
  if (me >= 0) {
    const pos = { 2: ['top'], 3: ['right', 'left'], 4: ['right', 'top', 'left'] }[n];
    return Array.from({ length: n - 1 }, (_, i) => ({ seat: (me + 1 + i) % n, pos: pos[i] }));
  }
  const pos = { 2: ['bottom', 'top'], 3: ['bottom', 'right', 'left'], 4: ['bottom', 'right', 'top', 'left'] }[n];
  return Array.from({ length: n }, (_, i) => ({ seat: i, pos: pos[i] }));
}

/** The plays and passes of the trick in progress (since the table was last cleared). */
function currentTrick(g) {
  const out = [];
  for (let i = g.log.length - 1; i >= 0; i--) {
    const e = g.log[i];
    if (e.t === 'trick') break;
    out.unshift(e);
  }
  return out;
}

/** Each seat's status in the trick in progress: 'top' (owns the table), 'pass', or null. */
function seatStatus(g) {
  const status = new Map();
  if (isOver(g)) return status;
  if (g.table) status.set(g.table.seat, 'top');
  // The last `passes` log entries are the passes since the table's play.
  const passes = g.log.filter((e) => e.t === 'pass').slice(-g.passes);
  if (g.passes) for (const e of passes) status.set(e.seat, 'pass');
  return status;
}

function bubbleFor(g, seat, status) {
  if (isOver(g)) return g.winner === seat ? ['win', '🏆 Out first'] : null;
  if (g.currentSeat === seat) return ['think', g.table ? 'Thinking' : 'To lead'];
  if (status.get(seat) === 'pass') return ['pass', 'Pass'];
  if (status.get(seat) === 'top') return ['top', 'On top'];
  return null;
}

function renderOpponents(g) {
  const box = $('opponents');
  box.replaceChildren();
  const status = seatStatus(g);
  for (const { seat, pos } of seatLayout(g.numPlayers, view.you.seat)) {
    const p = view.players[seat];
    const active = !isOver(g) && g.currentSeat === seat;
    const left = g.handCounts[seat];
    const plate = el('div', `td-plate td-seat${active ? ' active' : ''}${g.winner === seat ? ' winner' : ''}${p?.connected === false ? ' offline' : ''}${left === 1 && !isOver(g) ? ' last-card' : ''}${left > 1 && left <= 3 && !isOver(g) ? ' low' : ''}`);
    plate.dataset.seat = String(seat);
    plate.dataset.pos = pos;
    plate.style.setProperty('--seat-color', seatColor(seat));
    const name = p?.name ?? `Player ${seat + 1}`;
    plate.setAttribute('aria-label', `${name}: ${left === 0 ? 'out' : plural(left, 'card')}${active ? ', to play' : ''}${p?.connected === false ? ', offline' : ''}`);

    const avatar = avatarEl(p, seat);
    if (p?.isHost) avatar.append(el('span', 'td-crown', '👑'));
    const count = el('span', 'td-count', String(left));
    count.setAttribute('aria-hidden', 'true');
    avatar.append(count);

    const info = el('div', 'td-plate-info');
    info.append(el('span', 'td-plate-name', name));
    info.append(el('span', `td-plate-count${left <= 3 && left > 0 ? ' low' : ''}`, left === 0 ? 'out!' : left === 1 && !isOver(g) ? 'Last card!' : plural(left, 'card')));

    const backs = el('div', 'td-backs');
    backs.setAttribute('aria-hidden', 'true');
    const shown = Math.min(left, 13);
    backs.style.setProperty('--n', String(shown));
    for (let i = 0; i < shown; i++) backs.append(backEl());

    plate.append(avatar, info, backs);
    const bubble = bubbleFor(g, seat, status);
    if (bubble) {
      const b = el('span', `td-bubble td-bubble-${bubble[0]}`, bubble[1]);
      if (bubble[0] === 'think') b.append(el('i', 'td-dots'));
      plate.append(b);
    }
    if (p?.connected === false) plate.append(el('span', 'td-plate-tag td-offline-tag', 'offline'));
    box.append(plate);
  }
}

/** My own plate in the hand dock: who I am, how many cards I hold, and my trick status. */
function renderMe(g) {
  const box = $('me-plate');
  const me = view.you.seat;
  if (me < 0) { box.replaceChildren(el('span', 'td-me-watch', '👀 Spectating')); return; }
  const p = view.players[me];
  const left = g.handCounts[me];
  const avatar = avatarEl(p, me);
  const info = el('div', 'td-me-info');
  info.append(el('span', 'td-me-name', 'You'), el('span', `td-me-count${left <= 3 && left > 0 ? ' low' : ''}`, left === 0 ? 'out!' : plural(left, 'card')));
  box.replaceChildren(avatar, info);
  const status = seatStatus(g).get(me);
  if (status && g.currentSeat !== me) box.append(el('span', `td-bubble td-bubble-${status}`, status === 'pass' ? 'Pass' : 'On top'));
}

function renderTable(g) {
  const meta = $('table-meta');
  const bits = [];
  if (g.exposed) {
    const chip = el('span', 'td-chip td-chip-exposed');
    chip.append('Face-up ', chipEl(g.exposed));
    bits.push(chip);
  }
  if (g.unused) bits.push(el('span', 'td-chip', `${g.unused} cards out of play`));
  meta.replaceChildren(...bits);

  // Earlier plays of this trick lie underneath, slightly askew.
  const trick = currentTrick(g).filter((e) => e.t === 'play');
  const earlier = g.table ? trick.slice(0, -1).slice(-3) : [];
  $('trick-pile').replaceChildren(...earlier.map((e, i) => {
    const group = el('div', 'td-pile-play');
    const tilt = ((e.seq * 37) % 15) - 7;
    group.style.setProperty('--tilt', `${tilt}deg`);
    group.style.setProperty('--depth', String(earlier.length - i));
    for (const code of e.cards) group.append(cardEl(code, { mini: true }));
    return group;
  }));

  const play = $('table-play');
  const caption = $('table-caption');
  const tag = $('play-tag');
  play.replaceChildren();
  play.dataset.size = String(g.table?.cards.length ?? 0);
  if (g.table) {
    for (const code of g.table.cards) play.append(cardEl(code, { mini: true }));
    tag.replaceChildren(el('i', 'td-tag-dot'), el('span', 'td-tag-name', who(g.table.seat)), el('span', 'td-tag-kind', KIND_NAME[g.table.kind]));
    tag.style.setProperty('--seat-color', seatColor(g.table.seat));
    tag.classList.remove('hidden');
    caption.textContent = `${who(g.table.seat)} played a ${KIND_NAME[g.table.kind].toLowerCase()}${g.passes ? ` · ${g.passes} pass${g.passes === 1 ? '' : 'es'}` : ''}`;
  } else {
    tag.classList.add('hidden');
    const empty = el('div', 'td-empty-table');
    if (isOver(g)) {
      empty.append(el('span', 'td-empty-main', 'Game over'));
    } else if (g.mustInclude) {
      const ghost = cardEl(g.mustInclude, { mini: true });
      ghost.classList.replace('card-mini', 'td-ghost-card');
      empty.append(ghost, el('span', 'td-empty-main', 'Opening play'));
    } else {
      empty.append(el('span', 'td-empty-main', 'Free lead'), el('span', 'td-empty-sub', 'Any single, pair, triple or five'));
    }
    play.append(empty);
    const leader = g.currentSeat === view.you.seat ? 'You lead' : `${playerNameOf(g.currentSeat)} leads`;
    caption.textContent = isOver(g) ? '' : g.mustInclude ? `${who(g.currentSeat)} must open with the ${label(g.mustInclude)}` : `${leader} — any play`;
  }
}

function renderBanner(g, myTurn) {
  const banner = $('turn-banner');
  banner.classList.toggle('mine', myTurn);
  if (banner.dataset.turn !== `${view.gameNo}:${g.currentSeat}:${g.phase}`) {
    banner.dataset.turn = `${view.gameNo}:${g.currentSeat}:${g.phase}`;
    banner.classList.remove('pop');
    void banner.offsetWidth;
    banner.classList.add('pop');
  }
  if (isOver(g)) banner.textContent = g.winner === view.you.seat ? '🏆 You went out first!' : `${playerNameOf(g.winner)} went out first`;
  else if (view.you.seat < 0) banner.textContent = `Watching — ${playerNameOf(g.currentSeat)} to play`;
  else if (myTurn) banner.textContent = g.table ? 'Your turn — beat the table or pass' : g.mustInclude ? `Your lead — include the ${label(g.mustInclude)}` : 'Your lead — play anything';
  else banner.textContent = `Waiting for ${playerNameOf(g.currentSeat)}…`;
}

// ---------- Hand ----------
const displayOrder = (cards) => (sortMode === 'suit' ? sortBySuit(cards) : sortHand(cards));

/**
 * Lays the hand out in pixels: one gently arced row, or two flat rows when a 17-card hand
 * would otherwise hide the card indices on a narrow phone. Every card keeps its top-left index
 * visible (that is where taps land).
 */
function fanLayout(container, n) {
  const width = container.clientWidth || 340;
  const short = innerHeight < 560;
  const wide = width >= 700;
  const pad = 6;
  const minSlice = 0.4;
  const byHeight = Math.max(40, Math.round((innerHeight * (short ? 0.16 : 0.19)) / 1.4));
  let cardW = Math.min(Math.round(clamp(width / (wide ? 9.5 : 6.1), 48, wide ? 94 : 86)), byHeight);
  const fits = (w, k) => k <= 1 || (width - 2 * pad - w) / (k - 1) >= w * minSlice;
  let rows = 1;
  if (!fits(cardW, n)) {
    const shrunk = Math.floor((width - 2 * pad) / (1 + (n - 1) * minSlice));
    if (shrunk >= 50 || n <= 13 || short) cardW = Math.max(38, Math.min(cardW, shrunk));
    else {
      rows = 2;
      cardW = Math.min(Math.round(clamp(width / 5.2, 48, 80)), byHeight + 8);
    }
  }
  const cardH = cardW * 1.4;
  const perRow = Math.ceil(n / rows);
  const spacing = perRow > 1 ? Math.min(cardW * 0.68, (width - 2 * pad - cardW) / (perRow - 1)) : 0;
  const rowGap = cardH * 0.5;
  // Short screens lay the cards flat: every pixel of height goes to the table.
  const step = rows === 1 && n > 1 && !short ? Math.min(1.6, 16 / (n - 1)) : 0;
  const arc = rows === 1 && !short ? cardW * 0.008 : 0;
  const lift = Math.round(cardW * 0.24);
  const mid = (perRow - 1) / 2;
  container.style.setProperty('--hand-card-width', `${cardW}px`);
  container.style.setProperty('--hand-lift', `${lift}px`);
  container.style.setProperty('--corner-font', `${Math.round(cardW * 0.27)}px`);
  container.style.height = `${Math.round(lift + (rows - 1) * rowGap + cardH + arc * mid * mid + 6)}px`;
  container.dataset.rows = String(rows);
  return (i) => {
    const row = rows === 2 && i >= perRow ? 1 : 0;
    const j = row ? i - perRow : i;
    const count = row ? n - perRow : perRow;
    const m = (count - 1) / 2;
    return { left: width / 2 + (j - m) * spacing - cardW / 2, top: lift + row * rowGap + arc * (j - m) ** 2, angle: (j - m) * step };
  };
}

function handCardEl(code) {
  const node = cardEl(code, { tag: 'button' });
  node.type = 'button';
  node.classList.add('hand-card');
  // Mouse and touch pick cards on pointerdown (see the hand's pointer handlers); a keyboard
  // Enter/Space arrives as a click with no pointer detail and no pointer press just before it.
  node.addEventListener('click', (e) => { if (e.detail === 0 && performance.now() - lastPointerPick > 600) onCardTap(code); });
  return node;
}

const canPick = () => {
  const g = view?.game;
  return !!g && !isOver(g) && view.you.seat >= 0 && !!g.hand;
};

/** Keyed: surviving cards keep their buttons (focus, transitions), new ones are inserted in order. */
function renderHand(g, myTurn) {
  const hand = $('hand');
  if (!g.hand) {
    hand.style.height = 'auto';
    hand.classList.remove('interactive');
    hand.replaceChildren(el('div', 'td-hand-empty', 'You are watching this game.'));
    return;
  }
  const cards = displayOrder(g.hand);
  hand.classList.toggle('interactive', myTurn);
  hand.classList.toggle('pickable', canPick());
  for (const node of [...hand.children]) if (!node.classList.contains('hand-card') || !cards.includes(node.dataset.card)) node.remove();
  const nodes = new Map([...hand.children].map((n) => [n.dataset.card, n]));
  const place = fanLayout(hand, cards.length);
  const hinted = new Set(currentHint()?.cards ?? []);
  cards.forEach((code, i) => {
    const node = nodes.get(code) ?? handCardEl(code);
    if (hand.children[i] !== node) hand.insertBefore(node, hand.children[i] ?? null);
    const pos = place(i);
    node.style.left = `${pos.left}px`;
    node.style.top = `${pos.top}px`;
    node.style.setProperty('--card-angle', `${pos.angle}deg`);
    node.style.setProperty('--card-order', String(i + 1));
    const isSel = selected.has(code);
    node.classList.toggle('is-selected', isSel);
    node.classList.toggle('td-must', !!g.mustInclude && code === g.mustInclude && myTurn);
    node.classList.toggle('td-hinted', isSel && hinted.has(code));
    node.setAttribute('aria-pressed', String(isSel));
    node.disabled = isOver(g);
    node.dataset.key = String(i + 1);
  });
  if (!cards.length) hand.append(el('div', 'td-hand-empty', 'Your hand is empty'));
}

function onCardTap(code, mode = null) {
  const g = view?.game;
  if (!canPick() || !g.hand.includes(code)) return false;
  const on = mode ? mode === 'on' : !selected.has(code);
  if (on && selected.has(code)) return true;
  if (!on && !selected.has(code)) return true;
  if (on && selected.size >= 5) {
    if (!pickDrag?.warned) toast('A play is at most five cards', 'error');
    if (pickDrag) pickDrag.warned = true;
    return false;
  }
  if (on) selected.add(code); else selected.delete(code);
  hintAt.index = -1;
  sfx.play('pick');
  refreshHandArea();
  return true;
}

// Slide-to-select: press a card and drag across others to pick (or drop) them all.
let pickDrag = null;
let lastPointerPick = -Infinity;
function wireHandPointer() {
  const hand = $('hand');
  hand.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    const card = e.target.closest?.('.hand-card');
    if (!card || card.disabled || !canPick()) return;
    const code = card.dataset.card;
    lastPointerPick = performance.now();
    pickDrag = { id: e.pointerId, mode: selected.has(code) ? 'off' : 'on', seen: new Set([code]), warned: false };
    onCardTap(code, pickDrag.mode);
    try { hand.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  });
  hand.addEventListener('pointermove', (e) => {
    if (!pickDrag || e.pointerId !== pickDrag.id) return;
    const under = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('#hand .hand-card');
    const code = under?.dataset.card;
    if (!code || pickDrag.seen.has(code)) return;
    pickDrag.seen.add(code);
    onCardTap(code, pickDrag.mode);
  });
  const end = (e) => { if (pickDrag && e.pointerId === pickDrag.id) pickDrag = null; };
  hand.addEventListener('pointerup', end);
  hand.addEventListener('pointercancel', end);
  hand.addEventListener('lostpointercapture', end);
  // Arrow keys walk the hand.
  hand.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const cards = [...hand.querySelectorAll('.hand-card')];
    const i = cards.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    cards[clamp(i + (e.key === 'ArrowRight' ? 1 : -1), 0, cards.length - 1)].focus();
  });
}

function refreshHandArea() {
  const g = view?.game;
  if (!g) return;
  const myTurn = view.you.seat >= 0 && g.currentSeat === view.you.seat && !isOver(g);
  renderHand(g, myTurn);
  renderPreview(g, myTurn);
  renderActions(g, myTurn);
}

function currentHint() {
  const g = view?.game;
  if (!g || hintAt.index < 0 || hintAt.key !== hintCache.key) return null;
  return hintCache.list[hintAt.index] ?? null;
}

function useHint() {
  const g = view?.game;
  if (!g || view.you.seat !== g.currentSeat || isOver(g)) return;
  const list = legalPlays(g);
  if (!list.length) {
    toast(g.table ? 'Nothing in your hand beats that — pass' : 'No legal play found', 'error');
    pulse($('btn-pass'), 0, 1.06);
    return;
  }
  hintAt = { key: hintCache.key, index: hintAt.key === hintCache.key ? (hintAt.index + 1) % list.length : 0 };
  selected = new Set(list[hintAt.index].cards);
  sfx.play('pick');
  refreshHandArea();
}

function renderPreview(g, myTurn) {
  const live = $('preview');
  const next = previewContent(g, myTurn);
  // An aria-live region: only touch it when what it says changes, so screen readers don't repeat it.
  if (live.className === next.className && live.textContent === next.textContent) return;
  live.className = next.className;
  live.replaceChildren(...next.childNodes);
}

/** The line above the hand: guidance, or the selected combination (or why it can't be played). */
function previewContent(g, myTurn) {
  const box = el('div', 'td-preview');
  const cards = sortHand([...selected]);
  const seated = view.you.seat >= 0 && !!g.hand;
  if (!seated || isOver(g)) return box;
  if (!cards.length) {
    if (!myTurn) {
      box.classList.add('dim');
      box.textContent = 'Line up your next play while you wait';
      return box;
    }
    const legal = legalPlays(g);
    if (g.table && !legal.length) {
      box.classList.add('warn');
      box.textContent = `Nothing in your hand beats this ${KIND_NAME[g.table.kind].toLowerCase()} — pass`;
    } else if (g.table) {
      box.classList.add('dim');
      box.textContent = `Beat it with ${g.table.size === 1 ? 'a higher single' : g.table.size === 5 ? 'a stronger five-card hand' : `a higher ${KIND_NAME[g.table.kind].toLowerCase()}`} · ${plural(legal.length, 'option')}`;
    } else if (g.mustInclude) {
      box.classList.add('dim');
      box.textContent = `Your opening play must include the ${label(g.mustInclude)}`;
    } else {
      box.classList.add('dim');
      box.textContent = 'You have the lead — play anything';
    }
    return box;
  }
  const combo = classify(cards);
  const problem = myTurn ? whyNot(g, cards) : (combo ? null : cards.length === 1 ? null : "That isn't a valid combination");
  const clear = el('button', 'td-clear', '✕');
  clear.type = 'button';
  clear.setAttribute('aria-label', 'Clear selection');
  clear.title = 'Clear selection (Esc)';
  clear.addEventListener('click', () => { selected.clear(); hintAt.index = -1; refreshHandArea(); });
  if (problem) {
    box.classList.add('bad');
    box.append(el('span', 'td-preview-text', problem));
  } else {
    box.classList.add('ok');
    const text = el('span', 'td-preview-text');
    text.append(el('b', null, KIND_NAME[combo.kind]), `: ${cardText(cards)}`);
    const hint = currentHint();
    if (hint && hint.cards.length === cards.length && hint.cards.every((c) => selected.has(c))) {
      text.append(el('span', 'td-preview-extra', ` · hint ${hintAt.index + 1}/${hintCache.list.length}`));
    } else if (myTurn && g.table) {
      text.append(el('span', 'td-preview-extra', ` · beats ${cardText(g.table.cards)}`));
    } else if (!myTurn) {
      text.append(el('span', 'td-preview-extra', ' · lined up'));
    }
    box.append(text);
  }
  box.append(clear);
  return box;
}

function renderActions(g, myTurn) {
  const act = $('btn-act');
  const pass = $('btn-pass');
  const hint = $('btn-hint');
  const over = isOver(g);
  const seated = view.you.seat >= 0;
  $('action-bar').classList.toggle('hidden', !seated);
  if (over) {
    act.textContent = 'Results';
    act.dataset.action = 'results';
    act.disabled = false;
    act.classList.remove('ready');
    pass.classList.add('hidden');
    hint.classList.add('hidden');
    return;
  }
  pass.classList.remove('hidden');
  hint.classList.remove('hidden');
  act.dataset.action = 'play';
  const cards = [...selected];
  const problem = whyNot(g, cards);
  const combo = cards.length ? classify(cards) : null;
  act.textContent = myTurn && combo && !problem ? `Play ${KIND_NAME[combo.kind].toLowerCase()}` : cards.length ? `Play ${cards.length}` : 'Play';
  act.disabled = !myTurn || !!problem;
  act.classList.toggle('ready', !act.disabled);
  pass.disabled = !myTurn || !g.canPass;
  pass.title = myTurn && !g.canPass ? 'You are leading — you have to play' : 'Pass this turn (P)';
  const stuck = myTurn && g.canPass && !legalPlays(g).length;
  pass.classList.toggle('suggest', stuck);
  hint.disabled = !myTurn || stuck;
  const n = myTurn ? legalPlays(g).length : 0;
  hint.querySelector('.td-hint-label').textContent = currentHint() ? `Hint ${hintAt.index + 1}/${n}` : 'Hint';
  hint.title = myTurn ? (stuck ? 'Nothing beats the table' : `Suggest a play (H) · ${plural(n, 'option')}`) : 'Hints are available on your turn';
  const sort = $('btn-sort');
  sort.textContent = sortMode === 'suit' ? '⇅ Suit' : '⇅ Rank';
  sort.setAttribute('aria-label', `Sorted by ${sortMode} — switch`);
  sort.classList.toggle('hidden', !g.hand);
}

// ---------- Log ----------
function describe(entry) {
  switch (entry.t) {
    case 'play': return `${who(entry.seat)} played ${KIND_NAME[entry.kind].toLowerCase()} ${cardText(entry.cards)}`;
    case 'pass': return `${who(entry.seat)} passed`;
    case 'trick': return `${who(entry.seat)} took the table`;
    case 'won': return `${who(entry.seat)} went out first`;
    default: return '';
  }
}

function logItem(e) {
  const li = el('li', `log-${e.t}`);
  li.style.setProperty('--seat-color', seatColor(e.seat));
  const name = el('b', 'td-log-who', who(e.seat));
  switch (e.t) {
    case 'play':
      li.append(el('i', 'td-log-dot'), name, ` played ${KIND_NAME[e.kind].toLowerCase()} `, chipsEl(e.cards));
      break;
    case 'pass': li.append(el('i', 'td-log-dot'), name, ' passed'); break;
    case 'trick': li.append(name, ' took the table'); break;
    case 'won': li.append('🏆 ', name, ' went out first'); break;
    default: return null;
  }
  return li;
}

function renderLog(g) {
  const list = $('log');
  const items = [...g.log].reverse().map(logItem).filter(Boolean);
  list.replaceChildren(...items);
  if (!items.length) list.append(el('li', 'td-log-empty', 'No plays yet — the opener is up.'));
}

function setLogOpen(open) {
  const was = document.body.classList.contains('log-open');
  document.body.classList.toggle('log-open', open);
  $('btn-log').setAttribute('aria-expanded', String(open));
  if (open && !was) requestAnimationFrame(() => $('btn-log-close').focus({ preventScroll: true }));
  else if (!open && was && document.activeElement?.closest?.('#log-panel')) $('btn-log').focus({ preventScroll: true });
}

// ---------- Game over ----------
function showModal(id) {
  const m = $(id);
  if (!m.classList.contains('hidden')) return;
  if (!document.querySelector('.td-modal:not(.hidden)')) lastFocus = document.activeElement;
  m.classList.remove('hidden');
  document.body.classList.add('modal-open');
  if (id !== 'modal-confirm') requestAnimationFrame(() => m.querySelector('button:not(.hidden):not([disabled])')?.focus({ preventScroll: true }));
}

function hideModal(id) {
  const m = $(id);
  if (m.classList.contains('hidden')) return;
  m.classList.add('hidden');
  if (!document.querySelector('.td-modal:not(.hidden)')) {
    document.body.classList.remove('modal-open');
    if (lastFocus?.isConnected) lastFocus.focus({ preventScroll: true });
    lastFocus = null;
  }
}

function syncOverModal() {
  const g = view?.game;
  if (g && isOver(g) && !overDismissed) showOverModal(g);
  else hideModal('modal-over');
}

const ordinal = (n) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : Math.min(n % 10, 4) % 4]}`;
const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };

function showOverModal(g) {
  const me = view.you.seat;
  const youWon = g.winner === me;
  const myPlace = me >= 0 ? g.placements[me] : null;
  $('over-title').textContent = youWon ? 'You win!' : `${playerNameOf(g.winner)} wins`;
  $('over-sub').textContent = me >= 0 && !youWon ? `You finished ${ordinal(myPlace)}` : 'First to empty their hand';
  $('over-badge').textContent = youWon ? '🏆' : me < 0 ? '🎴' : MEDAL[myPlace] ?? '🃏';
  const box = document.querySelector('#modal-over .td-over');
  box.classList.toggle('outcome-win', youWon);
  box.classList.toggle('outcome-loss', me >= 0 && !youWon);
  const order = g.placements.map((place, seat) => ({ place, seat })).sort((a, b) => a.place - b.place || a.seat - b.seat);
  const rows = order.map(({ place, seat }) => {
    const row = el('div', `td-result${seat === me ? ' me' : ''}${place === 1 ? ' first' : ''}`);
    row.style.setProperty('--seat-color', seatColor(seat));
    row.append(el('span', 'td-result-place', MEDAL[place] ?? `${place}.`));
    row.append(avatarEl(view.players[seat], seat));
    const main = el('div', 'td-result-main');
    main.append(el('span', 'td-result-name', who(seat)));
    const left = g.handCounts[seat];
    const held = g.revealed?.[seat];
    if (left > 0 && held?.length) {
      const cards = el('span', 'td-result-cards');
      cards.append(...sortHand(held).map(chipEl));
      main.append(cards);
    }
    row.append(main, el('span', 'td-result-left', left === 0 ? 'out' : `${left} left`));
    return row;
  });
  // The staggered entrance only plays when the panel opens, not on every refresh while it is open.
  const opening = $('modal-over').classList.contains('hidden');
  rows.forEach((r, i) => r.style.setProperty('--i', String(i)));
  $('over-results').replaceChildren(...rows);
  for (const id of ['over-results', 'over-title', 'over-rating', 'over-badge']) $(id).classList.toggle('fresh', opening);
  renderRatingResult(opening);
  showModal('modal-over');
}

function renderRatingResult(opening = false) {
  const box = $('over-rating');
  const result = view?.lastRating;
  if (!result || result.gameId !== view.gameId || !result.changes.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  if (opening) box.classList.add('fresh');
  const biggest = Math.max(1, ...result.changes.map((c) => Math.abs(c.delta)));
  box.replaceChildren(el('div', 'td-rating-head', 'Rating'), ...[...result.changes].sort((a, b) => a.place - b.place).map((c, i) => {
    const row = el('div', `td-rating-row${c.seat === view.you.seat ? ' me' : ''}`);
    row.style.setProperty('--i', String(i));
    const bar = el('span', `td-rating-bar ${c.delta >= 0 ? 'up' : 'down'}`);
    bar.style.setProperty('--w', `${Math.round((Math.abs(c.delta) / biggest) * 100)}%`);
    row.append(el('span', null, c.name || 'Player'), bar, el('b', c.delta >= 0 ? 'up' : 'down', `${c.delta >= 0 ? '+' : ''}${c.delta}`), el('span', 'td-rating-after', String(c.after)));
    return row;
  }));
}

let confirmDone = null;
/** A styled confirm dialog; resolves true/false. */
function askConfirm({ title, body, ok = 'OK', danger = false }) {
  if (confirmDone) confirmDone(false);
  return new Promise((resolve) => {
    $('confirm-title').textContent = title;
    $('confirm-body').textContent = body;
    const okBtn = $('confirm-ok');
    okBtn.textContent = ok;
    okBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
    confirmDone = (value) => {
      confirmDone = null;
      hideModal('modal-confirm');
      resolve(value);
    };
    showModal('modal-confirm');
    okBtn.focus();
  });
}

// ---------- Stats (Bridge's Players table, ranking only) ----------
let statsRows = [];
let statsMinGames = 3;
let statsSort = { col: 'elo', dir: 'desc' };

async function showStats() {
  showScreen('screen-stats');
  history.replaceState(null, '', `${location.pathname}?view=stats`);
  $('stats-content').innerHTML = '<p class="stats-empty">Loading…</p>';
  try {
    const res = await fetch('/api/taidi/stats');
    statsRows = res.ok ? await res.json() : [];
  } catch { statsRows = []; }
  renderStats();
}

function hideStats() {
  history.replaceState(null, '', location.pathname);
  render();
}

function sortStats(col) {
  statsSort = statsSort.col === col ? { col, dir: statsSort.dir === 'desc' ? 'asc' : 'desc' } : { col, dir: col === 'name' || col === 'avg' ? 'asc' : 'desc' };
  renderStats();
}

function renderStats() {
  const content = $('stats-content');
  for (const b of document.querySelectorAll('#td-min-games .min-games-btn')) b.classList.toggle('active', Number(b.dataset.value) === statsMinGames);
  const sortFns = {
    elo: (r) => r.elo, games: (r) => r.games, wins: (r) => r.wins, winPct: (r) => r.winPct,
    avg: (r) => r.avgPlace, name: (r) => r.displayName.toLowerCase(),
  };
  const fn = sortFns[statsSort.col] ?? sortFns.elo;
  const sorted = statsRows.filter((r) => r.games >= statsMinGames).sort((a, b) => {
    const av = fn(a), bv = fn(b);
    return statsSort.dir === 'desc' ? (bv > av ? 1 : bv < av ? -1 : 0) : (av > bv ? 1 : av < bv ? -1 : 0);
  });
  if (!sorted.length) {
    content.innerHTML = `<p class="stats-empty">No players with ${statsMinGames}+ games yet.</p>`;
    return;
  }
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const medals = ['🥇', '🥈', '🥉'];
  const arrow = (col) => (statsSort.col !== col ? '<span class="sort-arrow">⇅</span>' : `<span class="sort-arrow active">${statsSort.dir === 'desc' ? '▼' : '▲'}</span>`);
  const th = (col, text, left = false) => `<th class="${left ? 'stats-th-left' : ''}${statsSort.col === col ? ' sorted' : ''}" data-sort="${col}">${text} ${arrow(col)}</th>`;
  const body = sorted.map((r, i) => `<tr>
      <td class="stats-td-name">${i < 3 ? medals[i] : `${i + 1}.`} ${esc(r.displayName)}</td>
      <td class="stats-td-num stats-elo">${r.elo}</td>
      <td class="stats-td-num">${r.games}</td>
      <td class="stats-td-num">${r.wins}</td>
      <td class="stats-td-num">${r.winPct}%</td>
      <td class="stats-td-num">${Number(r.avgPlace).toFixed(1)}</td>
    </tr>`).join('');
  content.innerHTML = `<div class="stats-table-wrap"><table class="stats-table">
    <thead><tr>${th('name', 'Player', true)}${th('elo', 'Rating')}${th('games', 'G')}${th('wins', 'W')}${th('winPct', 'Win%')}${th('avg', 'Avg place')}</tr></thead>
    <tbody>${body}</tbody></table></div>`;
  for (const cell of content.querySelectorAll('th[data-sort]')) cell.addEventListener('click', () => sortStats(cell.dataset.sort));
}

// ---------- Room lifecycle ----------
function enterRoom(code) {
  roomCode = code;
  view = null;
  lastGameNo = -1;
  joinSent = false;
  joinBlocked = null;
  // A spectator who watched a game in this room before (same tab, or a reload)
  // must not be auto-seated on re-entry: they can still take a seat explicitly.
  hasSeenGame = store.get(`taidiWatched:${code}`) === '1';
  lobbySeen.clear();
  history.replaceState(null, '', `#${code}${hashInfo.pid ? `:${hashInfo.pid}` : ''}`);
  render();
  connect(code);
}

function leaveRoom(notify = true) {
  if (notify) send({ type: 'leave' });
  const socket = ws;
  ws = null;
  roomCode = null;
  view = null;
  selected.clear();
  fxReset();
  if (socket) socket.onmessage = null;
  clearTimeout(reconnectTimer);
  if (socket) { socket.onclose = null; setTimeout(() => socket.close(), 50); }
  history.replaceState(null, '', location.pathname);
  $('overlay-reconnect').classList.add('hidden');
  for (const m of document.querySelectorAll('.td-modal')) m.classList.add('hidden');
  document.body.classList.remove('modal-open');
  render();
}

async function requireName() {
  if (!FunAuth.token()) { toast('Sign in with Telegram first', 'error'); return false; }
  const input = $('input-name');
  const name = input.value.trim();
  if (!name) {
    input.focus();
    toast('Enter your name first', 'error');
    return false;
  }
  // Telegram accounts without a usable name pick one once, saved to the shared profile (like Bridge).
  if (!input.readOnly && profile && name !== profile.displayName) {
    try {
      await fetch('/api/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${FunAuth.token()}` }, body: JSON.stringify({ displayName: name }) });
      profile.displayName = name;
    } catch { /* keep going with the local name */ }
  }
  playerName = name;
  store.set('playerName', name);
  return true;
}

/** Bridge's home flow: signed in → game section with the Telegram name; otherwise the login box. */
function showSignedIn(p) {
  profile = p;
  $('login-section').classList.add('hidden');
  $('game-section').classList.remove('hidden');
  const input = $('input-name');
  const name = p.nameRequired ? '' : (p.displayName || playerName);
  input.value = name;
  input.readOnly = !!(p.displayName && !p.nameRequired);
  input.classList.toggle('input-readonly', input.readOnly);
  if (name) { playerName = name; store.set('playerName', name); }
  const status = $('auth-status');
  status.innerHTML = '';
  if (p.displayName) {
    status.append('Logged in as ', el('strong', null, p.displayName), ' · ');
    const out = el('a', null, 'Logout');
    out.href = '#';
    out.onclick = (e) => { e.preventDefault(); FunAuth.logout(); profile = null; showSignedOut(); FunLeaderboard.mount($('leaderboard-section'), { game: 'taidi' }); };
    status.append(out);
  }
}

function showSignedOut() {
  $('game-section').classList.add('hidden');
  $('login-section').classList.remove('hidden');
  FunAuth.mountLogin($('login-section'), (p) => {
    showSignedIn(p);
    FunLeaderboard.mount($('leaderboard-section'), { game: 'taidi' });
    if (pendingRoom) { const room = pendingRoom; pendingRoom = null; enterRoom(room); }
  });
}

let pendingRoom = null;
async function initAuth() {
  const p = await FunAuth.profile();
  if (p) showSignedIn(p);
  else showSignedOut();
}

async function createRoom() {
  if (!await requireName()) return;
  const btn = $('btn-create');
  btn.disabled = true;
  try {
    const res = await fetch('/api/taidi/create', { method: 'POST' });
    if (!res.ok) throw new Error('create failed');
    const { roomCode: code } = await res.json();
    enterRoom(code);
  } catch {
    toast('Could not create a room — check your connection', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function joinRoom() {
  if (!await requireName()) return;
  const code = $('input-code').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) {
    $('input-code').focus();
    shake($('input-code'));
    toast('Room codes are 4 characters', 'error');
    return;
  }
  enterRoom(code);
}

function inviteUrl() {
  return `${location.origin}${location.pathname}#${roomCode}`;
}

async function shareInvite() {
  const url = inviteUrl();
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ title: 'Tai Di on funCentral', text: `Join my Tai Di game — room ${roomCode}`, url }); return; } catch { /* cancelled */ }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied 📋');
  } catch {
    prompt('Copy this invite link:', url);
  }
}

function playSelected() {
  const g = view?.game;
  if (!g || isOver(g)) return;
  send({ type: 'play', cards: [...selected] });
}

function toggleSort() {
  sortMode = sortMode === 'rank' ? 'suit' : 'rank';
  store.set('taidiSort', sortMode);
  refreshHandArea();
}

// ---------- Wire up ----------
// Decorative faces: the home hero and the combo examples in the rules.
for (const hero of document.querySelectorAll('.td-hero-card[data-card]')) {
  const face = cardEl(hero.dataset.card);
  face.classList.add(...hero.classList);
  face.removeAttribute('aria-label');
  hero.replaceWith(face);
}
for (const li of document.querySelectorAll('.td-combo-list li[data-example]')) {
  const row = el('span', 'td-combo-cards');
  row.setAttribute('aria-hidden', 'true');
  for (const code of li.dataset.example.split(' ')) row.append(cardEl(code, { mini: true }));
  li.prepend(row);
}
setIcon($('btn-rules'), 'help');
setIcon($('btn-end'), 'stop');
setIcon($('btn-log'), 'log');
wireHandPointer();

$('input-name').value = playerName;
$('btn-create').addEventListener('click', createRoom);
$('btn-join').addEventListener('click', joinRoom);
$('input-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
$('input-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
$('input-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') ($('input-code').value ? joinRoom() : createRoom()); });
$('btn-share').addEventListener('click', shareInvite);
$('lobby-code-btn').addEventListener('click', shareInvite);
$('tb-room').addEventListener('click', shareInvite);
$('btn-start').addEventListener('click', () => send({ type: 'start' }));
$('btn-take-seat').addEventListener('click', () => {
  // Explicit re-attempt after a full-lobby rejection or watching a game: the
  // room re-checks (full/kicked) and seats the player, or rejects again.
  joinSent = true;
  send({ type: 'join', name: playerName });
});
$('btn-leave').addEventListener('click', async () => {
  const g = view?.game;
  const midGame = g && !isOver(g) && view.you.seat >= 0;
  if (midGame && !await askConfirm({ title: 'Leave this game?', body: 'The table waits for you — your seat is kept if you come back.', ok: 'Leave', danger: true })) return;
  leaveRoom(true);
});
$('btn-end').addEventListener('click', async () => {
  if (!view?.game) return;
  const ok = await askConfirm({
    title: 'End this game?',
    body: 'Everyone returns to the lobby. A game that is ended early is not rated.',
    ok: 'End game',
    danger: true,
  });
  if (ok) send({ type: 'backToLobby' });
});
$('btn-sound').addEventListener('click', () => { sfx.toggle(); renderTopBar(); });
$('btn-pass').addEventListener('click', () => send({ type: 'pass' }));
$('btn-hint').addEventListener('click', useHint);
$('btn-sort').addEventListener('click', toggleSort);
$('btn-act').addEventListener('click', () => {
  const action = $('btn-act').dataset.action;
  if (action === 'results') { overDismissed = false; showOverModal(view.game); return; }
  if (action === 'play') playSelected();
});
$('btn-log').addEventListener('click', () => setLogOpen(!document.body.classList.contains('log-open')));
$('btn-log-close').addEventListener('click', () => setLogOpen(false));
$('log-scrim').addEventListener('click', () => setLogOpen(false));
$('btn-stats').addEventListener('click', showStats);
$('btn-stats-home').addEventListener('click', hideStats);
for (const b of document.querySelectorAll('#td-min-games .min-games-btn')) {
  b.addEventListener('click', () => { statsMinGames = Number(b.dataset.value); renderStats(); });
}
$('btn-again').addEventListener('click', () => send({ type: 'backToLobby' }));
$('btn-over-close').addEventListener('click', () => { overDismissed = true; hideModal('modal-over'); });
$('confirm-ok').addEventListener('click', () => confirmDone?.(true));
$('confirm-cancel').addEventListener('click', () => confirmDone?.(false));
$('modal-confirm').addEventListener('click', (e) => { if (e.target === e.currentTarget) confirmDone?.(false); });

const openRules = () => showModal('modal-rules');
$('btn-rules').addEventListener('click', openRules);
$('btn-rules-home').addEventListener('click', openRules);
$('btn-rules-lobby').addEventListener('click', openRules);
$('modal-rules').addEventListener('click', (e) => {
  if (e.target === e.currentTarget || e.target.closest('[data-close]')) hideModal('modal-rules');
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (confirmDone) confirmDone(false);
    else if (!$('modal-rules').classList.contains('hidden')) hideModal('modal-rules');
    else if (document.body.classList.contains('log-open')) setLogOpen(false);
    else if (selected.size && view?.game) { selected.clear(); hintAt.index = -1; refreshHandArea(); }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.('input, textarea, select')) return;
  const g = view?.game;
  if (!g || isOver(g) || !$('screen-game').classList.contains('active') || document.querySelector('.td-modal:not(.hidden)')) return;
  if (view.you.seat < 0 || !g.hand) return;
  const key = e.key.toLowerCase();
  const myTurn = g.currentSeat === view.you.seat;
  if (/^[1-9]$/.test(key)) {
    const code = displayOrder(g.hand)[Number(key) - 1];
    if (code) { e.preventDefault(); onCardTap(code); }
  } else if (key === 's') {
    toggleSort();
  } else if (!myTurn) {
    // Playing, passing and hints wait for my turn.
  } else if (key === 'enter' && !e.target.closest?.('button')) {
    if (!$('btn-act').disabled) { e.preventDefault(); $('btn-act').click(); }
  } else if (key === 'p') {
    const p = $('btn-pass');
    if (!p.disabled) p.click();
  } else if (key === 'h') {
    useHint();
  }
});

// The fan is laid out in pixels, so re-lay it when the width changes.
let resizeTimer = 0;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (view?.game) refreshHandArea(); }, 100);
});

// Reconnect promptly when a phone wakes the tab.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && roomCode && ws?.readyState !== WebSocket.OPEN) connect(roomCode); // also takes over from another window
  if (document.visibilityState === 'visible') keepAwake(document.body.dataset.screen === 'screen-game' && !!view?.game && !isOver(view.game));
});
setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.send('ping'); }, 25000);

function openFromHash(room) {
  $('input-code').value = room;
  if (FunAuth.token() && playerName) enterRoom(room);
  else { pendingRoom = room; render(); toast(`Sign in to join room ${room}`); }
}

// An invite link opened in an already-loaded tab only changes the hash.
addEventListener('hashchange', () => {
  const { room } = parseHash();
  if (room && room !== roomCode) {
    if (roomCode) leaveRoom(true);
    openFromHash(room);
  }
});

FunLeaderboard.mount($('leaderboard-section'), { game: 'taidi' });
initAuth().finally(() => {
  if (hashInfo.room) openFromHash(hashInfo.room);
  else if (new URLSearchParams(location.search).get('view') === 'stats') showStats();
  else render();
});
