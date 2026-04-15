// Generates the PWA icons used by the app.
// Produces solid-background PNGs with a white "T" glyph — no external deps.
// Run with: `node scripts/generate-icons.js`

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── PNG helpers ────────────────────────────────────────────────────────────

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(size, drawFn) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8);   // bit depth
  ihdr.writeUInt8(6, 9);   // color type: RGBA
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = drawFn(x, y, size);
      const off = y * (stride + 1) + 1 + x * 4;
      raw[off] = r; raw[off + 1] = g; raw[off + 2] = b; raw[off + 3] = a;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Icon drawing ────────────────────────────────────────────────────────────
//
// App-like icon: a deep-blue rounded square with a white "T" glyph in the
// centre — same palette as the app's `--active-bg` / accent. Content fits in
// the 80 % maskable safe zone so the same file can serve as "any" + maskable.

function roundedMask(x, y, size, cornerFrac) {
  const r = size * cornerFrac;
  const inTL = x < r && y < r && Math.hypot(r - x, r - y) > r;
  const inTR = x >= size - r && y < r && Math.hypot(x - (size - r), r - y) > r;
  const inBL = x < r && y >= size - r && Math.hypot(r - x, y - (size - r)) > r;
  const inBR = x >= size - r && y >= size - r
    && Math.hypot(x - (size - r), y - (size - r)) > r;
  return !(inTL || inTR || inBL || inBR);
}

function drawTGlyph(x, y, size) {
  // Horizontal bar of the T (top crossbar).
  const hLeft = size * 0.28, hRight = size * 0.72;
  const hTop  = size * 0.30, hBot   = size * 0.41;
  if (x >= hLeft && x < hRight && y >= hTop && y < hBot) return true;

  // Vertical stem of the T.
  const vLeft = size * 0.44, vRight = size * 0.56;
  const vBot  = size * 0.74;
  if (x >= vLeft && x < vRight && y >= hTop && y < vBot) return true;

  return false;
}

function makeIconPixel({ rounded }) {
  // Background matching the app's accent-over-dark palette.
  const BG = [0x1d, 0x2b, 0x55, 255]; // deep indigo
  const FG = [0xff, 0xff, 0xff, 255];
  const TRANSPARENT = [0, 0, 0, 0];

  return (x, y, size) => {
    if (rounded && !roundedMask(x, y, size, 0.22)) return TRANSPARENT;
    if (drawTGlyph(x, y, size)) return FG;
    return BG;
  };
}

// ── Emit files ──────────────────────────────────────────────────────────────

const publicDir = path.join(__dirname, '..', 'public');

const outputs = [
  // Rounded transparent-corner icons — "any" purpose.
  { file: 'icon-192.png',        size: 192, rounded: true },
  { file: 'icon-512.png',        size: 512, rounded: true },
  // Fully-filled square — "maskable" purpose (platform applies its own mask).
  { file: 'icon-maskable.png',   size: 512, rounded: false },
  // iOS home-screen icon (platform auto-rounds corners).
  { file: 'apple-touch-icon.png', size: 180, rounded: false },
];

for (const { file, size, rounded } of outputs) {
  const buf = encodePng(size, makeIconPixel({ rounded }));
  const outPath = path.join(publicDir, file);
  fs.writeFileSync(outPath, buf);
  console.log(`wrote ${outPath} (${size}×${size}, ${buf.length} bytes)`);
}
