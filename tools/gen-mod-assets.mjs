#!/usr/bin/env node
// Generates the mod's pixel-art textures (no dependencies): the Architect's Wand item texture
// (16×16) and the mod icon (128×128). Output goes into mod/src/main/resources/assets/mcai/.
// Re-run after changing the design: node tools/gen-mod-assets.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'mod', 'src', 'main', 'resources', 'assets', 'mcai');

function png(width, height, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const hex = (h, a = 255) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a];

class Canvas {
  constructor(w, h) { this.w = w; this.h = h; this.px = Buffer.alloc(w * h * 4); }
  set(x, y, c) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    const a = c[3] / 255;
    for (let k = 0; k < 3; k++) this.px[i + k] = Math.round(c[k] * a + this.px[i + k] * (1 - a));
    this.px[i + 3] = Math.max(this.px[i + 3], c[3]);
  }
  get(x, y) { const i = (y * this.w + x) * 4; return [...this.px.subarray(i, i + 4)]; }
}

// ---------------------------------------------------------------- wand 16×16

const C = {
  woodDark: hex('#3d2614'), wood: hex('#6e4524'), woodLight: hex('#9c6a3a'),
  goldDark: hex('#a8741f'), gold: hex('#e8b84a'), goldLight: hex('#fff1a8'),
  gemDeep: hex('#1b4f8f'), gem: hex('#2f9fe0'), gemLight: hex('#7fe6ff'), gemCore: hex('#e9fdff'),
  glow: hex('#b98cff', 170), spark: hex('#ffffff', 230),
};

function wand() {
  const c = new Canvas(16, 16);
  // staff: diagonal from bottom-left (2,13) to (10,5), 2 px thick with a highlight edge
  for (let i = 0; i <= 8; i++) {
    const x = 2 + i, y = 13 - i;
    c.set(x, y, C.wood);
    c.set(x + 1, y, C.woodDark);      // shadow side
    c.set(x, y - 1, i < 8 ? C.woodLight : C.wood); // lit side
  }
  // pommel
  c.set(1, 14, C.goldDark); c.set(2, 14, C.gold); c.set(1, 13, C.gold); c.set(2, 13, C.goldLight);
  // gold band under the gem
  for (const [x, y, col] of [[8, 6, C.goldLight], [9, 6, C.gold], [9, 7, C.goldDark], [10, 6, C.goldDark], [8, 5, C.gold], [9, 5, C.goldLight], [10, 5, C.gold], [11, 6, C.goldDark]]) c.set(x, y, col);
  // gem: diamond centred at (12,3), radius 2
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    if (Math.abs(dx) + Math.abs(dy) > 2) continue;
    const lit = -dx - dy; // top-left is lit
    const col = dx === 0 && dy === 0 ? C.gemCore : lit >= 2 ? C.gemLight : lit >= 0 ? C.gem : C.gemDeep;
    c.set(12 + dx, 3 + dy, col);
  }
  c.set(11, 2, C.gemCore);
  // magic glow + sparkles
  for (const [x, y] of [[12, 0], [15, 3], [12, 6], [9, 3]]) c.set(x, y, C.glow);
  c.set(14, 0, C.spark); c.set(15, 1, C.glow); c.set(9, 1, C.spark); c.set(15, 6, C.glow);
  return c;
}

// ---------------------------------------------------------------- icon 128×128

function icon(w16) {
  const S = 128;
  const c = new Canvas(S, S);
  const r = 22;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    // rounded square
    const qx = Math.max(r - x, x - (S - 1 - r), 0), qy = Math.max(r - y, y - (S - 1 - r), 0);
    if (qx * qx + qy * qy > r * r) continue;
    const t = (x + y) / (2 * S);
    const base = [Math.round(18 + 20 * t), Math.round(32 + 30 * t), Math.round(64 + 50 * t), 255];
    // blueprint grid
    const grid = x % 16 === 0 || y % 16 === 0 ? 1 : x % 4 === 0 && y % 4 === 0 ? 0.5 : 0;
    c.set(x, y, grid ? [base[0] + 30 * grid, base[1] + 45 * grid, base[2] + 60 * grid, 255] : base);
  }
  // wand scaled ×6, centred
  const k = 6, off = (S - 16 * k) / 2;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const p = w16.get(x, y);
    if (p[3] === 0) continue;
    for (let yy = 0; yy < k; yy++) for (let xx = 0; xx < k; xx++) c.set(off + x * k + xx, off + y * k + yy, p);
  }
  return c;
}

const w = wand();
mkdirSync(join(ASSETS, 'textures', 'item'), { recursive: true });
writeFileSync(join(ASSETS, 'textures', 'item', 'architect_wand.png'), png(16, 16, w.px));
writeFileSync(join(ASSETS, 'icon.png'), png(128, 128, icon(w).px));
console.log(`wrote ${join(ASSETS, 'textures/item/architect_wand.png')} and icon.png`);
