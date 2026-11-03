// Screenshot / animation-clip helpers shared by the UI capture scripts (not part of the Playwright suite).
// Clips use Chrome's DevTools screencast and are written as animated PNGs (APNG; each frame stores only
// the rectangle that changed), so no video tooling is needed.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// --- Minimal PNG decode / APNG encode (8-bit RGB or RGBA, non-interlaced, as Chrome produces) ---
function pngChunks(buf) {
  const chunks = [];
  for (let off = 8; off < buf.length;) {
    const len = buf.readUInt32BE(off);
    chunks.push({ type: buf.toString('ascii', off + 4, off + 8), data: buf.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
  }
  return chunks;
}
function decodePng(buf) {
  const chunks = pngChunks(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR').data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  if (ihdr[8] !== 8 || ihdr[12] !== 0 || ![2, 6].includes(ihdr[9])) return null;
  const bpp = ihdr[9] === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const stride = width * bpp;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[row + x - bpp] : 0;
      const b = y > 0 ? px[row - stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[row - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[row + x] = v & 255;
    }
  }
  return { width, height, bpp, colorType: ihdr[9], px };
}
/** 5 bits per channel: slight banding, far smaller frames. */
function quantize(img) {
  if (!img) return null;
  for (let i = 0; i < img.px.length; i++) if (img.bpp === 3 || i % 4 !== 3) img.px[i] &= 0xf8;
  return img;
}
function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([head, body, crc]);
}
/** Deflated scanlines (Sub filter) for one rectangle of an image. */
function encodeRect(img, x0, y0, w, h) {
  const rows = Buffer.alloc(h * (w * img.bpp + 1));
  for (let y = 0; y < h; y++) {
    const dst = y * (w * img.bpp + 1);
    rows[dst] = 1;
    const src = ((y0 + y) * img.width + x0) * img.bpp;
    for (let i = 0; i < w * img.bpp; i++) rows[dst + 1 + i] = (img.px[src + i] - (i >= img.bpp ? img.px[src + i - img.bpp] : 0)) & 255;
  }
  return zlib.deflateSync(rows, { level: 9 });
}
function changedRect(a, b) {
  let x0 = a.width, y0 = a.height, x1 = -1, y1 = -1;
  for (let y = 0; y < a.height; y++) {
    const row = y * a.width * a.bpp;
    for (let x = 0; x < a.width; x++) {
      const i = row + x * a.bpp;
      if (a.px[i] === b.px[i] && a.px[i + 1] === b.px[i + 1] && a.px[i + 2] === b.px[i + 2]) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
/** frames: [{ img, ms }] → APNG buffer; later frames are drawn over earlier ones (dispose none, blend source). */
function encodeApng(frames) {
  const first = frames[0].img;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(first.width, 0);
  ihdr.writeUInt32BE(first.height, 4);
  ihdr[8] = 8;
  ihdr[9] = first.colorType;
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(frames.length, 0);
  parts.push(chunk('acTL', actl));
  let seq = 0;
  frames.forEach((f, i) => {
    const r = f.rect ?? { x: 0, y: 0, w: first.width, h: first.height };
    const fctl = Buffer.alloc(26);
    fctl.writeUInt32BE(seq++, 0);
    fctl.writeUInt32BE(r.w, 4);
    fctl.writeUInt32BE(r.h, 8);
    fctl.writeUInt32BE(r.x, 12);
    fctl.writeUInt32BE(r.y, 16);
    fctl.writeUInt16BE(Math.min(65535, Math.max(20, Math.round(f.ms))), 20);
    fctl.writeUInt16BE(1000, 22);
    parts.push(chunk('fcTL', fctl));
    const data = encodeRect(f.img, r.x, r.y, r.w, r.h);
    if (i === 0) parts.push(chunk('IDAT', data));
    else {
      const n = Buffer.alloc(4);
      n.writeUInt32BE(seq++);
      parts.push(chunk('fdAT', Buffer.concat([n, data])));
    }
  });
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/**
 * Records `run()` with the DevTools screencast and writes an APNG to `file` (≈ `fps`, last frame held).
 * `ambientOff` is CSS that pauses looping ambient glows while recording: they repaint most of the
 * screen every frame, which would make each clip several MB. Event animations are unchanged.
 */
async function recordClip(page, file, run, { ambientOff = '', maxWidth = 300, fps = 9, hold = 1600 } = {}) {
  const style = await page.addStyleTag({ content: ambientOff || '/* none */' });
  const cdp = await page.context().newCDPSession(page);
  const shots = [];
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    shots.push({ buf: Buffer.from(data, 'base64'), t: metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'png', maxWidth, maxHeight: 4000, everyNthFrame: 1 });
  const started = Date.now() / 1000;
  await run();
  const ended = Date.now() / 1000;
  await cdp.send('Page.stopScreencast');
  await cdp.detach();
  await style.evaluate((n) => n.remove());
  // Sample at a steady rate; each frame shows the latest screencast image at that moment.
  const decoded = [];
  let last = null;
  let lastImg = null;
  for (let t = started; t <= ended; t += 1 / fps) {
    const s = shots.filter((x) => x.t <= t).pop() ?? shots[0];
    if (!s) continue;
    if (s !== last) { lastImg = quantize(decodePng(s.buf)) ?? lastImg; last = s; }
    if (!lastImg || (decoded[0] && (lastImg.width !== decoded[0].img.width || lastImg.height !== decoded[0].img.height))) continue;
    const prev = decoded.at(-1);
    if (prev && prev.img === lastImg) { prev.ms += 1000 / fps; continue; }
    decoded.push({ img: lastImg, ms: 1000 / fps });
  }
  for (let i = 1; i < decoded.length; i++) decoded[i].rect = changedRect(decoded[i - 1].img, decoded[i].img);
  const dur = decoded.map((f) => f.ms);
  const frames = decoded.filter((f, i) => i === 0 || f.rect);
  // Fold dropped (unchanged) frames' time into the frame before them.
  frames.forEach((f) => { f.ms = 0; });
  let k = 0;
  decoded.forEach((f, i) => { if (f === frames[k + 1]) k++; frames[k].ms += dur[i]; });
  frames.at(-1).ms += hold;
  fs.writeFileSync(file, encodeApng(frames));
  console.log('clip', path.basename(file), `${frames.length} frames`, `${Math.round(fs.statSync(file).size / 1024)} KB`);
}

module.exports = { recordClip };
