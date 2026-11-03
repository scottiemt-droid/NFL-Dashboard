#!/usr/bin/env node
'use strict';
/* Writes the home-screen icons (icons/icon-180.png, -192, -512) — a football field drawn pixel by pixel.
   Usage: node tools/make-icons.js   (Node 18+, no installs) */
const fs = require('fs'), path = require('path'), zlib = require('zlib');

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = b => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => { const t = Buffer.from(type), l = Buffer.alloc(4), c = Buffer.alloc(4); l.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([l, t, data, c]); };

function png(size, px) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) px(x / size, y / size).forEach((v, i) => raw[y * (size * 3 + 1) + 1 + x * 3 + i] = v);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Full-bleed so iOS/Android masks crop cleanly: navy border, green field, white yard lines, gold football.
const NAVY = [19, 48, 110], GREEN = [29, 122, 70], WHITE = [244, 243, 239], BALL = [122, 62, 28], LACE = [244, 243, 239];
function field(u, v) {
  const m = 0.14;
  if (u < m || u > 1 - m || v < m || v > 1 - m) return NAVY;
  const bx = (u - 0.5) / 0.26, by = (v - 0.5) / 0.15;          // football: an ellipse with laces
  if (bx * bx + by * by <= 1) {
    if (Math.abs(by) < 0.12 && Math.abs(bx) < 0.5) return LACE;
    if (Math.abs(bx) < 0.5 && Math.abs(by) < 0.45 && [-0.36, -0.12, 0.12, 0.36].some(c => Math.abs(bx - c) < 0.05)) return LACE;
    return BALL;
  }
  const f = (v - m) / (1 - 2 * m);                                 // yard lines across the field
  if ([0.1, 0.3, 0.5, 0.7, 0.9].some(c => Math.abs(f - c) < 0.012)) return WHITE;
  return GREEN;
}

const dir = path.join(path.resolve(__dirname, '..'), 'icons');
fs.mkdirSync(dir, { recursive: true });
for (const s of [180, 192, 512]) fs.writeFileSync(path.join(dir, `icon-${s}.png`), png(s, field));
console.log('Wrote icons/icon-180.png, icon-192.png, icon-512.png');
