'use strict';
/**
 * Generate the PWA icons with zero dependencies: a tiny rasteriser plus a PNG
 * encoder on top of node:zlib. Run with `node scripts/make-icons.js`.
 *
 * Output (public/icons/):
 *   icon-192.png, icon-512.png                     — "any" purpose, rounded square
 *   icon-maskable-192.png, icon-maskable-512.png   — full-bleed, 20% safe margin
 *   apple-touch-icon-180.png                       — opaque, iOS
 *   favicon-32.png                                 — browser tab
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- PNG encoding ----------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = -1;
  for (const byte of buf) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- shape tests (normalized 0..1 coordinates) ----------
function insideRoundedSquare(x, y, radius) {
  if (x < 0 || x > 1 || y < 0 || y > 1) return false;
  const r = radius;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r || (x >= r && x <= 1 - r) || (y >= r && y <= 1 - r);
}

function insidePolygon(px, py, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function insideCircle(px, py, cx, cy, r) {
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

function insideCapsule(px, py, ax, ay, bx, by, radius) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return (px - cx) ** 2 + (py - cy) ** 2 <= radius * radius;
}

/** Shopping cart glyph in a 0..1 box. */
function insideCart(x, y) {
  // handle
  if (insideCapsule(x, y, 0.12, 0.24, 0.30, 0.28, 0.035)) return true;
  // basket
  if (insidePolygon(x, y, [[0.29, 0.30], [0.84, 0.35], [0.76, 0.60], [0.37, 0.60]])) return true;
  // slats (kept white so the basket reads as a cart, not a box)
  if (insidePolygon(x, y, [[0.44, 0.33], [0.47, 0.33], [0.45, 0.58], [0.42, 0.58]])) return true;
  if (insidePolygon(x, y, [[0.64, 0.34], [0.67, 0.34], [0.62, 0.59], [0.59, 0.59]])) return true;
  // wheels
  if (insideCircle(x, y, 0.45, 0.72, 0.062)) return true;
  if (insideCircle(x, y, 0.71, 0.72, 0.062)) return true;
  return false;
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Render one icon.
 * @param {number} size          output pixels (square)
 * @param {{maskable?: boolean}} options
 */
function renderIcon(size, { maskable = false } = {}) {
  const SS = 4; // supersampling per axis
  const rgba = Buffer.alloc(size * size * 4);
  const top = [22, 163, 74];    // #16a34a
  const bottom = [21, 128, 61]; // #15803d
  const radius = maskable ? 0 : 0.22;
  // Maskable icons keep the glyph inside the 80% safe zone.
  const scale = maskable ? 0.62 : 0.74;
  const offset = (1 - scale) / 2;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (!maskable && !insideRoundedSquare(x, y, radius)) continue;
          const bg = mix(top, bottom, y);
          const gx = (x - offset) / scale;
          const gy = (y - offset) / scale;
          const glyph = gx >= 0 && gx <= 1 && gy >= 0 && gy <= 1 && insideCart(gx, gy);
          const color = glyph ? [255, 255, 255] : bg;
          r += color[0]; g += color[1]; b += color[2]; a += 1;
        }
      }
      const samples = SS * SS;
      const idx = (py * size + px) * 4;
      if (a === 0) { rgba[idx + 3] = 0; continue; }
      rgba[idx] = Math.round(r / a);
      rgba[idx + 1] = Math.round(g / a);
      rgba[idx + 2] = Math.round(b / a);
      rgba[idx + 3] = Math.round((a / samples) * 255);
    }
  }
  return encodePng(size, size, rgba);
}

const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');
const targets = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-192.png', 192, { maskable: true }],
  ['icon-maskable-512.png', 512, { maskable: true }],
  ['apple-touch-icon-180.png', 180, { maskable: true }],
  ['favicon-32.png', 32, { maskable: true }],
];

if (require.main === module) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, size, options] of targets) {
    const png = renderIcon(size, options);
    fs.writeFileSync(path.join(OUT_DIR, name), png);
    console.log(`${name.padEnd(28)} ${size}x${size}  ${(png.length / 1024).toFixed(1)} KB`);
  }
}

module.exports = { renderIcon, encodePng, insideCart };
