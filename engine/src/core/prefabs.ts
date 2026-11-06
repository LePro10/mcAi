// Procedural prefabs that make builds look alive: trees, bushes, rocks, flowers, street
// furniture. All generators are seeded (same seed → same result; default seed is derived from
// the position, so two prefabs at different places are never identical). Leaves are always
// persistent=true so they never decay.
//
// Prefabs are authored in local space (see frame.ts: −z = forward/away from the player, the
// "front" of oriented prefabs faces +z) and rotated into world space by params.facing.

import type { Vec3, Facing } from './types.ts';
import type { Registry } from './registry.ts';
import type { BlockSink } from './dsl.ts';
import { Frame } from './frame.ts';
import { blockId, isAir } from './blockstate.ts';
import { createRng, createNoise, hashSeed, type Rng, type Noise } from './noise.ts';

export interface PrefabInfo {
  name: string;
  description: string;
  params: Record<string, string>;
}

// ------------------------------------------------------------------ context

const SOFT_REPLACEABLE =
  /^minecraft:(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|dead_bush|snow|.*_leaves|vine|leaf_litter|short_dry_grass|tall_dry_grass|pink_petals|wildflowers|moss_carpet|pale_moss_carpet|dandelion|poppy|oxeye_daisy|azure_bluet|cornflower|bush|firefly_bush|seagrass)$/;

const GROUND =
  /^minecraft:(grass_block|dirt|coarse_dirt|podzol|rooted_dirt|moss_block|pale_moss_block|mud|mycelium|sand|red_sand|farmland|gravel|snow_block|clay|muddy_mangrove_roots)$/;

type Mode = 'force' | 'soft';

class Ctx {
  readonly sink: BlockSink;
  readonly reg: Registry;
  readonly frame: Frame;
  readonly rng: Rng;
  readonly noise: Noise;
  count = 0;
  private canon = new Map<string, string>();
  private placed = new Set<string>();

  constructor(sink: BlockSink, reg: Registry, frame: Frame, rng: Rng, noise: Noise) {
    this.sink = sink;
    this.reg = reg;
    this.frame = frame;
    this.rng = rng;
    this.noise = noise;
  }

  state(s: string): string {
    let c = this.canon.get(s);
    if (c === undefined) {
      c = this.reg.canonical(s);
      this.canon.set(s, c);
    }
    return c;
  }

  get(x: number, y: number, z: number): string {
    const [wx, wy, wz] = this.frame.toWorld([x, y, z]);
    return this.sink.get(wx, wy, wz);
  }

  /** soft = only into air / plants / leaves (never overwrite builds or our own wood) */
  set(x: number, y: number, z: number, state: string, mode: Mode = 'force'): boolean {
    x = Math.round(x);
    y = Math.round(y);
    z = Math.round(z);
    const key = `${x},${y},${z}`;
    const [wx, wy, wz] = this.frame.toWorld([x, y, z]);
    if (mode === 'soft') {
      if (this.placed.has(key)) return false;
      const cur = this.sink.get(wx, wy, wz);
      if (!isAir(cur) && !SOFT_REPLACEABLE.test(blockId(cur))) return false;
    }
    const s = this.frame.stateToWorld(this.state(state));
    this.sink.set(wx, wy, wz, s);
    this.placed.add(key);
    this.count++;
    return true;
  }

  isFree(x: number, y: number, z: number): boolean {
    const cur = this.get(x, y, z);
    return isAir(cur) || SOFT_REPLACEABLE.test(blockId(cur));
  }

  /** find the y of the first free block above suitable ground near y0 (null = no ground) */
  ground(x: number, z: number, y0 = 0, groundRe: RegExp = GROUND): number | null {
    let sawSolid = false;
    for (let y = y0 + 3; y >= y0 - 4; y--) {
      const below = this.get(x, y - 1, z);
      if (!isAir(below)) sawSolid = true;
      if (this.isFree(x, y, z) && groundRe.test(blockId(below))) return y;
    }
    return sawSolid ? null : y0; // unknown/empty world → assume flat ground at y0
  }

  /** log/wood block with an axis */
  log(x: number, y: number, z: number, id: string, axis: 'x' | 'y' | 'z' = 'y', mode: Mode = 'force'): void {
    const info = this.reg.info(id);
    this.set(x, y, z, info?.properties.axis ? `${id}[axis=${axis}]` : id, mode);
  }

  leaves(x: number, y: number, z: number, id: string): void {
    const info = this.reg.info(id);
    this.set(x, y, z, info?.properties.persistent ? `${id}[persistent=true]` : id, 'soft');
  }

  /** straight line of logs from a to b (axis from the dominant direction) */
  logLine(a: Vec3, b: Vec3, id: string, mode: Mode = 'force'): void {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const steps = Math.max(1, Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2]));
    const ad = d.map(Math.abs);
    const axis: 'x' | 'y' | 'z' = ad[1] >= ad[0] && ad[1] >= ad[2] ? 'y' : ad[0] >= ad[2] ? 'x' : 'z';
    let last = '';
    for (let i = 0; i <= steps; i++) {
      const p: Vec3 = [Math.round(a[0] + (d[0] * i) / steps), Math.round(a[1] + (d[1] * i) / steps), Math.round(a[2] + (d[2] * i) / steps)];
      const k = p.join(',');
      if (k === last) continue;
      last = k;
      this.log(p[0], p[1], p[2], id, axis, mode);
    }
  }

  /** organic leaf cluster: noisy ellipsoid with ragged edges */
  blob(c: Vec3, r: Vec3, leaf: string | (() => string), density = 0.88): void {
    const pick = typeof leaf === 'string' ? () => leaf : leaf;
    const [rx, ry, rz] = r.map((v) => Math.max(0.6, v));
    const seed = this.rng.rand() * 1000;
    for (let y = Math.floor(-ry - 1); y <= Math.ceil(ry + 1); y++)
      for (let z = Math.floor(-rz - 1); z <= Math.ceil(rz + 1); z++)
        for (let x = Math.floor(-rx - 1); x <= Math.ceil(rx + 1); x++) {
          const d = (x / rx) ** 2 + (y / ry) ** 2 + (z / rz) ** 2;
          const n = this.noise.noise3((c[0] + x) * 0.45 + seed, (c[1] + y) * 0.45, (c[2] + z) * 0.45) * 0.3;
          if (d > 1 + n) continue;
          if (d > 0.55 && this.rng.rand() > density) continue;
          this.leaves(c[0] + x, c[1] + y, c[2] + z, pick());
        }
  }

  /** hanging strand of blocks downwards from (x,y,z), stops at non-free blocks */
  hang(x: number, y: number, z: number, len: number, state: string | ((i: number, last: boolean) => string)): void {
    for (let i = 0; i < len; i++) {
      if (!this.isFree(x, y - i, z)) break;
      const s = typeof state === 'string' ? state : state(i, i === len - 1);
      this.set(x, y - i, z, s, 'soft');
    }
  }

  /** vines on the 4 sides of a column, attached to it */
  vinesAround(x: number, y0: number, y1: number, z: number, chance: number): void {
    const sides: Array<[number, number, string]> = [
      [-1, 0, 'east'],
      [1, 0, 'west'],
      [0, -1, 'south'],
      [0, 1, 'north'],
    ];
    for (const [dx, dz, face] of sides) {
      if (!this.rng.chance(chance)) continue;
      const top = this.rng.randInt(y0 + 1, y1);
      const len = this.rng.randInt(2, Math.max(2, top - y0));
      for (let y = top; y > top - len; y--) {
        if (!this.isFree(x + dx, y, z + dz)) break;
        this.set(x + dx, y, z + dz, `vine[${face}=true]`, 'soft');
      }
    }
  }
}

// ------------------------------------------------------------------ helpers

function num(p: Record<string, unknown>, k: string, d: number, min = -Infinity, max = Infinity): number {
  const v = p[k];
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
}

function str<T extends string>(p: Record<string, unknown>, k: string, d: T, allowed?: readonly T[]): T {
  const v = p[k];
  if (typeof v !== 'string' || !v) return d;
  const s = v.replace(/^minecraft:/, '') as T;
  if (allowed && !allowed.includes(s)) {
    throw new Error(`invalid value "${v}" for "${k}" (allowed: ${allowed.join(', ')})`);
  }
  return s;
}

function sizeScale(p: Record<string, unknown>, rng: Rng): number {
  const s = str(p, 'size', 'medium', ['small', 'medium', 'large', 'huge'] as const);
  const base = { small: 0.7, medium: 1, large: 1.35, huge: 1.8 }[s];
  return base * rng.range(0.9, 1.12);
}

const DIRS4: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function leafMix(c: Ctx, items: Array<[string, number]>): () => string {
  return () => c.rng.weighted(items);
}

// ------------------------------------------------------------------ trees

function treeOak(c: Ctx, p: Record<string, unknown>, log = 'oak_log', leaf: string | (() => string) = 'oak_leaves'): void {
  const s = sizeScale(p, c.rng);
  const h = Math.round(num(p, 'height', c.rng.randInt(4, 6) * s, 3, 40));
  const fancy = s >= 1.25 || c.rng.chance(0.25);
  c.logLine([0, 0, 0], [0, h - 1, 0], log);
  const top: Vec3 = [0, h - 1, 0];
  const R = 2.3 * s;
  c.blob([top[0], top[1] + 0.5, top[2]], [R, 1.6 * s, R], leaf);
  if (fancy) {
    const nb = c.rng.randInt(2, 4);
    for (let i = 0; i < nb; i++) {
      const a = (i / nb) * Math.PI * 2 + c.rng.range(-0.4, 0.4);
      const y0 = Math.round(h * c.rng.range(0.45, 0.75));
      const len = Math.round(c.rng.range(2, 3.5) * s);
      const end: Vec3 = [Math.round(Math.cos(a) * len), y0 + Math.round(len * 0.7), Math.round(Math.sin(a) * len)];
      c.logLine([0, y0, 0], end, log);
      c.blob(end, [1.8 * s, 1.3 * s, 1.8 * s], leaf);
    }
  } else if (c.rng.chance(0.6)) {
    const [dx, dz] = c.rng.choice(DIRS4);
    const y0 = h - 2;
    c.log(dx, y0, dz, log, dx ? 'x' : 'z');
  }
}

function treeBirch(c: Ctx, p: Record<string, unknown>): void {
  const s = sizeScale(p, c.rng);
  const h = Math.round(num(p, 'height', c.rng.randInt(5, 8) * s, 4, 40));
  c.logLine([0, 0, 0], [0, h - 1, 0], 'birch_log');
  c.blob([0, h - 1, 0], [1.7 * s, 2.4 * s, 1.7 * s], 'birch_leaves', 0.85);
  c.leaves(0, h, 0, 'birch_leaves');
  c.leaves(0, h + 1, 0, 'birch_leaves');
}

function treeSpruce(c: Ctx, p: Record<string, unknown>): void {
  const s = sizeScale(p, c.rng);
  const h = Math.round(num(p, 'height', c.rng.randInt(8, 12) * s, 5, 50));
  const bare = Math.max(1, Math.round(h * c.rng.range(0.15, 0.3)));
  c.logLine([0, 0, 0], [0, h - 1, 0], 'spruce_log');
  const maxR = Math.max(1.5, h * 0.28);
  for (let y = bare; y <= h; y++) {
    const t = (y - bare) / Math.max(1, h - bare); // 0 bottom … 1 top
    let r = maxR * (1 - t) + 0.5;
    if ((h - y) % 2 === 1) r *= 0.7; // alternating rings → layered look
    const R = Math.ceil(r);
    for (let z = -R; z <= R; z++)
      for (let x = -R; x <= R; x++) {
        const d = Math.sqrt(x * x + z * z);
        if (d > r + c.rng.range(-0.3, 0.3)) continue;
        if (x === 0 && z === 0 && y < h) continue;
        c.leaves(x, y, z, 'spruce_leaves');
      }
  }
  c.leaves(0, h, 0, 'spruce_leaves');
  c.leaves(0, h + 1, 0, 'spruce_leaves');
}

function trunk2x2(c: Ctx, h: number, log: string, flare = true): void {
  for (const [x, z] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ] as const) {
    const hh = h - c.rng.randInt(0, 1);
    c.logLine([x, 0, z], [x, hh - 1, z], log);
  }
  if (flare) {
    // roots at the base
    for (const [x, z, dx, dz] of [
      [0, 0, -1, 0],
      [1, 0, 0, -1],
      [1, 1, 1, 0],
      [0, 1, 0, 1],
    ] as const) {
      if (c.rng.chance(0.6)) c.log(x + dx, 0, z + dz, log, dx ? 'x' : 'z');
      if (c.rng.chance(0.25)) c.log(x + dx, 1, z + dz, log, 'y');
    }
  }
}

function treeDarkOak(c: Ctx, p: Record<string, unknown>, log = 'dark_oak_log', leaf = 'dark_oak_leaves'): void {
  const s = sizeScale(p, c.rng);
  const h = Math.round(num(p, 'height', c.rng.randInt(6, 8) * s, 4, 40));
  trunk2x2(c, h, log);
  const cx = 0.5;
  const R = 3.6 * s;
  c.blob([cx, h, cx], [R, 1.5 * s, R], leaf, 0.9);
  c.blob([cx, h + 1.5, cx], [R * 0.6, 1.1, R * 0.6], leaf, 0.9);
  const nb = c.rng.randInt(2, 4);
  for (let i = 0; i < nb; i++) {
    const a = c.rng.range(0, Math.PI * 2);
    const len = Math.round(c.rng.range(2, 3.5) * s);
    const y0 = h - c.rng.randInt(2, 3);
    const end: Vec3 = [Math.round(cx + Math.cos(a) * len), y0 + 1, Math.round(cx + Math.sin(a) * len)];
    c.logLine([Math.round(cx + Math.cos(a)), y0, Math.round(cx + Math.sin(a))], end, log);
    c.blob(end, [2 * s, 1.2, 2 * s], leaf);
  }
}

function treePaleOak(c: Ctx, p: Record<string, unknown>): void {
  treeDarkOak(c, p, 'pale_oak_log', 'pale_oak_leaves');
  const R = Math.round(4 * sizeScale(p, c.rng));
  const h = 12;
  // hanging moss under the canopy
  for (let i = 0; i < 10 + R * 3; i++) {
    const x = c.rng.randInt(-R, R + 1);
    const z = c.rng.randInt(-R, R + 1);
    for (let y = h; y > 2; y--) {
      if (blockId(c.get(x, y, z)) === 'minecraft:pale_oak_leaves' && c.isFree(x, y - 1, z)) {
        const len = c.rng.randInt(1, 3);
        c.hang(x, y - 1, z, len, (_i, last) => `pale_hanging_moss[tip=${last}]`);
        break;
      }
    }
  }
  // moss carpet on the ground
  for (let i = 0; i < 6 + R * 2; i++) {
    const x = c.rng.randInt(-R, R + 1);
    const z = c.rng.randInt(-R, R + 1);
    const y = c.ground(x, z, 0);
    if (y !== null) c.set(x, y, z, 'pale_moss_carpet', 'soft');
  }
}

function treeCherry(c: Ctx, p: Record<string, unknown>): void {
  const s = sizeScale(p, c.rng);
  const h = Math.round(num(p, 'height', c.rng.randInt(4, 6) * s, 3, 30));
  const lean = c.rng.choice(DIRS4);
  const top: Vec3 = [lean[0], h - 1, lean[1]];
  c.logLine([0, 0, 0], [0, Math.round(h / 2), 0], 'cherry_log');
  c.logLine([0, Math.round(h / 2), 0], top, 'cherry_log');
  const nb = c.rng.randInt(2, 3);
  const base = c.rng.range(0, Math.PI * 2);
  for (let i = 0; i < nb; i++) {
    const a = base + (i / nb) * Math.PI * 2 + c.rng.range(-0.3, 0.3);
    const len = Math.round(c.rng.range(3, 4.5) * s);
    const mid: Vec3 = [Math.round(top[0] + Math.cos(a) * len * 0.6), top[1] + 1, Math.round(top[2] + Math.sin(a) * len * 0.6)];
    const end: Vec3 = [Math.round(top[0] + Math.cos(a) * len), top[1] + 2, Math.round(top[2] + Math.sin(a) * len)];
    c.logLine(top, mid, 'cherry_log');
    c.logLine(mid, end, 'cherry_log');
    c.blob([end[0], end[1] + 0.5, end[2]], [2.6 * s, 1.5 * s, 2.6 * s], 'cherry_leaves', 0.9);
    // drooping edges
    for (let k = 0; k < 6; k++) {
      const x = end[0] + c.rng.randInt(-2, 2);
      const z = end[2] + c.rng.randInt(-2, 2);
      c.hang(x, end[1] - 1, z, c.rng.randInt(1, 2), 'cherry_leaves[persistent=true]');
    }
  }
  // petals on the ground
  const R = Math.round(4 * s);
  for (let i = 0; i < R * 4; i++) {
    const x = c.rng.randInt(-R, R);
    const z = c.rng.randInt(-R, R);
    const y = c.ground(x, z, 0);
    if (y !== null) c.set(x, y, z, `pink_petals[facing=${c.rng.choice(['north', 'south', 'east', 'west'])},flower_amount=${c.rng.randInt(1, 4)}]`, 'soft');
  }
}

function treeJungle(c: Ctx, p: Record<string, unknown>): void {
  const s = sizeScale(p, c.rng);
  const big = s >= 1;
  const h = Math.round(num(p, 'height', (big ? c.rng.randInt(13, 20) : c.rng.randInt(6, 9)) * s, 4, 60));
  if (big) trunk2x2(c, h, 'jungle_log');
  else c.logLine([0, 0, 0], [0, h - 1, 0], 'jungle_log');
  const cx = big ? 0.5 : 0;
  c.blob([cx, h, cx], [3.2 * s, 1.8, 3.2 * s], 'jungle_leaves', 0.9);
  const nb = big ? c.rng.randInt(2, 4) : c.rng.randInt(0, 2);
  for (let i = 0; i < nb; i++) {
    const a = c.rng.range(0, Math.PI * 2);
    const y0 = Math.round(h * c.rng.range(0.5, 0.8));
    const len = c.rng.randInt(2, 4);
    const end: Vec3 = [Math.round(cx + Math.cos(a) * (len + 1)), y0 + 2, Math.round(cx + Math.sin(a) * (len + 1))];
    c.logLine([Math.round(cx + Math.cos(a)), y0, Math.round(cx + Math.sin(a))], end, 'jungle_log');
    c.blob(end, [2, 1.2, 2], 'jungle_leaves');
  }
  c.vinesAround(0, 1, h - 2, 0, 0.7);
  if (big) c.vinesAround(1, 1, h - 2, 1, 0.7);
}

function treeAcacia(c: Ctx, p: Record<string, unknown>): void {
  const s = sizeScale(p, c.rng);
  const h = Math.round(num(p, 'height', c.rng.randInt(5, 7) * s, 4, 30));
  const [dx, dz] = c.rng.choice(DIRS4);
  const bend = Math.round(h * 0.45);
  c.logLine([0, 0, 0], [0, bend, 0], 'acacia_log');
  const top1: Vec3 = [dx * 2, h - 1, dz * 2];
  c.logLine([0, bend, 0], top1, 'acacia_log');
  c.blob([top1[0], top1[1] + 1, top1[2]], [3 * s, 0.8, 3 * s], 'acacia_leaves', 0.92);
  if (c.rng.chance(0.75)) {
    const top2: Vec3 = [-dx * 2 + dz, h - 2, -dz * 2 + dx];
    c.logLine([0, bend, 0], top2, 'acacia_log');
    c.blob([top2[0], top2[1] + 1, top2[2]], [2.2 * s, 0.7, 2.2 * s], 'acacia_leaves', 0.92);
  }
}

function treeMangrove(c: Ctx, p: Record<string, unknown>): void {
  const s = sizeScale(p, c.rng);
  const lift = c.rng.randInt(2, 3);
  const h = Math.round(num(p, 'height', c.rng.randInt(6, 9) * s, 5, 30));
  // arching roots
  const nr = c.rng.randInt(4, 6);
  for (let i = 0; i < nr; i++) {
    const a = (i / nr) * Math.PI * 2 + c.rng.range(-0.3, 0.3);
    const r = c.rng.range(1.6, 2.8);
    const end: Vec3 = [Math.round(Math.cos(a) * r), 0, Math.round(Math.sin(a) * r)];
    const mid: Vec3 = [Math.round(Math.cos(a) * r * 0.6), lift - 1, Math.round(Math.sin(a) * r * 0.6)];
    for (const [a1, b1] of [
      [[0, lift, 0] as Vec3, mid],
      [mid, end],
    ] as const) {
      const steps = Math.max(Math.abs(b1[0] - a1[0]), Math.abs(b1[1] - a1[1]), Math.abs(b1[2] - a1[2]), 1);
      for (let k = 0; k <= steps; k++) {
        c.set(
          Math.round(a1[0] + ((b1[0] - a1[0]) * k) / steps),
          Math.round(a1[1] + ((b1[1] - a1[1]) * k) / steps),
          Math.round(a1[2] + ((b1[2] - a1[2]) * k) / steps),
          'mangrove_roots',
        );
      }
    }
    c.set(end[0], -1, end[2], 'muddy_mangrove_roots', 'soft');
  }
  c.logLine([0, lift, 0], [0, h - 1, 0], 'mangrove_log');
  c.blob([0, h, 0], [2.8 * s, 1.8, 2.8 * s], 'mangrove_leaves', 0.9);
  for (let i = 0; i < 4; i++) {
    const x = c.rng.randInt(-2, 2);
    const z = c.rng.randInt(-2, 2);
    if (c.isFree(x, h - 2, z)) c.set(x, h - 2, z, `mangrove_propagule[hanging=true,age=${c.rng.randInt(0, 4)}]`, 'soft');
  }
  c.vinesAround(0, lift + 1, h - 2, 0, 0.4);
}

function treeGiantOak(c: Ctx, p: Record<string, unknown>): void {
  const s = sizeScale(p, c.rng);
  const h = Math.round(num(p, 'height', c.rng.randInt(16, 22) * s, 10, 60));
  const r0 = Math.max(1.5, 2.2 * s);
  // tapered trunk of oak_wood (bark on all sides)
  for (let y = 0; y < h; y++) {
    const t = y / h;
    const r = r0 * (1 - t * 0.55) + (y < 3 ? (3 - y) * 0.6 : 0); // flared base
    const ox = Math.sin(y * 0.25) * 0.6;
    const oz = Math.cos(y * 0.2) * 0.6;
    const R = Math.ceil(r + 1);
    for (let z = -R; z <= R; z++)
      for (let x = -R; x <= R; x++) {
        if ((x - ox) ** 2 + (z - oz) ** 2 > r * r) continue;
        c.set(x, y, z, 'oak_wood[axis=y]');
      }
  }
  // surface roots
  const nr = c.rng.randInt(4, 7);
  for (let i = 0; i < nr; i++) {
    const a = (i / nr) * Math.PI * 2 + c.rng.range(-0.3, 0.3);
    const len = r0 + c.rng.range(2, 4);
    c.logLine([Math.round(Math.cos(a) * r0), 0, Math.round(Math.sin(a) * r0)], [Math.round(Math.cos(a) * len), 0, Math.round(Math.sin(a) * len)], 'oak_log');
  }
  // spiralling branches with big leaf clouds
  const nb = c.rng.randInt(5, 8);
  const phase = c.rng.range(0, Math.PI * 2);
  for (let i = 0; i < nb; i++) {
    const a = phase + i * 2.4 + c.rng.range(-0.2, 0.2); // golden angle-ish
    const y0 = Math.round(h * (0.45 + (0.5 * i) / nb));
    const len = c.rng.range(5, 8) * s;
    const mid: Vec3 = [Math.round(Math.cos(a) * len * 0.5), y0 + Math.round(len * 0.25), Math.round(Math.sin(a) * len * 0.5)];
    const end: Vec3 = [Math.round(Math.cos(a) * len), y0 + Math.round(len * 0.45), Math.round(Math.sin(a) * len)];
    c.logLine([0, y0, 0], mid, 'oak_log');
    c.logLine(mid, end, 'oak_log');
    c.logLine([mid[0], mid[1] - 1, mid[2]], [end[0], end[1] - 1, end[2]], 'oak_log');
    c.blob(end, [3.5 * s, 2.3 * s, 3.5 * s], leafMix(c, [['oak_leaves', 8], ['azalea_leaves', 2], ['flowering_azalea_leaves', 1]]), 0.9);
  }
  c.blob([0, h + 1, 0], [4.5 * s, 3 * s, 4.5 * s], leafMix(c, [['oak_leaves', 8], ['azalea_leaves', 2], ['flowering_azalea_leaves', 1]]), 0.9);
  c.vinesAround(0, Math.round(h * 0.5), h, Math.ceil(r0), 0.5);
}

function treeWillow(c: Ctx, p: Record<string, unknown>): void {
  const s = sizeScale(p, c.rng);
  const h = Math.round(num(p, 'height', c.rng.randInt(5, 7) * s, 4, 30));
  const leaf = str(p, 'leaves', 'oak_leaves');
  c.logLine([0, 0, 0], [0, h, 0], 'oak_log');
  for (const [dx, dz] of DIRS4) if (c.rng.chance(0.7)) c.log(dx, h - 1, dz, 'oak_log', dx ? 'x' : 'z');
  const R = 3.4 * s;
  c.blob([0, h + 0.5, 0], [R, 1.6, R], leaf, 0.92);
  // weeping strands from the canopy edge
  const n = Math.round(18 * s * s);
  for (let i = 0; i < n; i++) {
    const a = c.rng.range(0, Math.PI * 2);
    const rr = R * c.rng.range(0.7, 1.05);
    const x = Math.round(Math.cos(a) * rr);
    const z = Math.round(Math.sin(a) * rr);
    let y = h + 2;
    while (y > h - 2 && c.isFree(x, y, z) && blockId(c.get(x, y, z)) !== `minecraft:${leaf}`) y--;
    const len = c.rng.randInt(3, Math.max(4, h - 1));
    if (c.rng.chance(0.7)) c.hang(x, y - 1, z, len, `${leaf}[persistent=true]`);
    else {
      // vine strand: attach to the leaf above via up=true
      for (let k = 1; k <= len; k++) {
        if (!c.isFree(x, y - k, z)) break;
        c.set(x, y - k, z, 'vine[up=true]', 'soft');
      }
    }
  }
}

function treePalm(c: Ctx, p: Record<string, unknown>): void {
  const s = sizeScale(p, c.rng);
  const h = Math.round(num(p, 'height', c.rng.randInt(7, 10) * s, 5, 30));
  const [dx, dz] = c.rng.choice(DIRS4);
  const lean = c.rng.range(1.5, 3);
  let prev: Vec3 = [0, 0, 0];
  for (let y = 1; y <= h; y++) {
    const t = y / h;
    const off = lean * t * t;
    const cur: Vec3 = [Math.round(dx * off), y, Math.round(dz * off)];
    c.logLine(prev, cur, 'jungle_log');
    prev = cur;
  }
  const top = prev;
  c.leaves(top[0], top[1] + 1, top[2], 'jungle_leaves');
  const fronds = c.rng.randInt(6, 8);
  const phase = c.rng.range(0, Math.PI);
  for (let i = 0; i < fronds; i++) {
    const a = phase + (i / fronds) * Math.PI * 2;
    const len = c.rng.range(3.5, 5) * s;
    for (let k = 1; k <= Math.round(len); k++) {
      const t = k / len;
      const x = top[0] + Math.round(Math.cos(a) * k);
      const z = top[2] + Math.round(Math.sin(a) * k);
      const y = top[1] + 1 - Math.round(t * t * 2.6);
      c.leaves(x, y, z, 'jungle_leaves');
      if (k === Math.round(len)) c.leaves(x, y - 1, z, 'jungle_leaves');
    }
  }
  // coconuts: cocoa pods hanging on the trunk top (facing points to the log)
  for (const [ox, oz, face] of [
    [1, 0, 'west'],
    [-1, 0, 'east'],
    [0, 1, 'north'],
    [0, -1, 'south'],
  ] as const) {
    if (c.rng.chance(0.4) && c.isFree(top[0] + ox, top[1] - 1, top[2] + oz)) {
      c.set(top[0] + ox, top[1] - 1, top[2] + oz, `cocoa[facing=${face},age=2]`, 'soft');
    }
  }
}

function treeMaple(c: Ctx, p: Record<string, unknown>): void {
  const s = sizeScale(p, c.rng);
  const palette = str(p, 'palette', 'autumn', ['autumn', 'red', 'orange', 'yellow'] as const);
  const mix: Array<[string, number]> =
    palette === 'red'
      ? [['red_poplar_leaves', 8], ['orange_poplar_leaves', 2]]
      : palette === 'orange'
        ? [['orange_poplar_leaves', 8], ['red_poplar_leaves', 1], ['yellow_poplar_leaves', 1]]
        : palette === 'yellow'
          ? [['yellow_poplar_leaves', 8], ['orange_poplar_leaves', 2]]
          : [['red_poplar_leaves', 4], ['orange_poplar_leaves', 4], ['yellow_poplar_leaves', 2]];
  const leaf = leafMix(c, mix);
  const h = Math.round(num(p, 'height', c.rng.randInt(5, 7) * s, 4, 30));
  c.logLine([0, 0, 0], [0, h, 0], 'dark_oak_log');
  for (let i = 0; i < 3; i++) {
    const a = c.rng.range(0, Math.PI * 2);
    const y0 = h - c.rng.randInt(1, 3);
    const end: Vec3 = [Math.round(Math.cos(a) * 2.5 * s), y0 + 2, Math.round(Math.sin(a) * 2.5 * s)];
    c.logLine([0, y0, 0], end, 'dark_oak_log');
    c.blob(end, [2.2 * s, 1.7 * s, 2.2 * s], leaf, 0.9);
  }
  c.blob([0, h + 1, 0], [3 * s, 2.3 * s, 3 * s], leaf, 0.9);
  // fallen leaves
  const R = Math.round(4 * s);
  for (let i = 0; i < R * 4; i++) {
    const x = c.rng.randInt(-R, R);
    const z = c.rng.randInt(-R, R);
    const y = c.ground(x, z, 0);
    if (y !== null) c.set(x, y, z, `leaf_litter[facing=${c.rng.choice(['north', 'south', 'east', 'west'])},segment_amount=${c.rng.randInt(1, 4)}]`, 'soft');
  }
}

function treePoplar(c: Ctx, p: Record<string, unknown>): void {
  const s = sizeScale(p, c.rng);
  const h = Math.round(num(p, 'height', c.rng.randInt(8, 12) * s, 5, 40));
  const color = str(p, 'color', 'yellow', ['yellow', 'orange', 'red'] as const);
  c.logLine([0, 0, 0], [0, h - 1, 0], 'poplar_log');
  c.blob([0, h * 0.68, 0], [1.6 * s, h * 0.36, 1.6 * s], `${color}_poplar_leaves`, 0.9);
  c.leaves(0, h, 0, `${color}_poplar_leaves`);
}

// ------------------------------------------------------------------ small nature

function bush(c: Ctx, p: Record<string, unknown>): void {
  const kind = str(p, 'leaves', c.rng.choice(['oak_leaves', 'azalea_leaves', 'flowering_azalea_leaves', 'spruce_leaves', 'jungle_leaves']));
  const s = sizeScale(p, c.rng);
  const r = 1.3 * s;
  if (c.rng.chance(0.5)) c.log(0, 0, 0, 'oak_log');
  c.blob([0, r * 0.6, 0], [r * c.rng.range(0.9, 1.3), r * 0.8, r * c.rng.range(0.9, 1.3)], kind, 0.85);
  if (c.rng.chance(0.4)) c.blob([c.rng.randInt(-1, 1), 0.3, c.rng.randInt(-1, 1)], [r * 0.7, r * 0.5, r * 0.7], kind, 0.8);
}

function boulder(c: Ctx, p: Record<string, unknown>): void {
  const s = sizeScale(p, c.rng);
  const count = Math.round(num(p, 'count', c.rng.randInt(1, 3), 1, 12));
  const mossy = num(p, 'moss', 0.3, 0, 1);
  const mix: Array<[string, number]> = [
    ['stone', 5],
    ['andesite', 3],
    ['cobblestone', 2],
    ['tuff', 1],
    ['mossy_cobblestone', 4 * mossy],
  ];
  for (let k = 0; k < count; k++) {
    const r = (k === 0 ? 1.8 : c.rng.range(0.8, 1.4)) * s;
    const cx = k === 0 ? 0 : Math.round(c.rng.range(-2.5, 2.5) * s);
    const cz = k === 0 ? 0 : Math.round(c.rng.range(-2.5, 2.5) * s);
    const rx = r * c.rng.range(0.9, 1.4);
    const rz = r * c.rng.range(0.9, 1.4);
    const ry = r * c.rng.range(0.6, 0.9);
    const R = Math.ceil(Math.max(rx, rz) + 1);
    const seed = c.rng.rand() * 100;
    for (let y = -1; y <= Math.ceil(ry); y++)
      for (let z = -R; z <= R; z++)
        for (let x = -R; x <= R; x++) {
          const d = (x / rx) ** 2 + (y / ry) ** 2 + (z / rz) ** 2;
          const n = c.noise.noise3((cx + x) * 0.5 + seed, y * 0.5, (cz + z) * 0.5) * 0.35;
          if (d > 1 + n) continue;
          const top = (x / rx) ** 2 + ((y + 1) / ry) ** 2 + (z / rz) ** 2 > 1 + n;
          const st = top && c.rng.chance(mossy) ? 'mossy_cobblestone' : c.rng.weighted(mix);
          c.set(cx + x, y, cz + z, st);
          if (top && c.rng.chance(mossy * 0.5)) c.set(cx + x, y + 1, cz + z, 'moss_carpet', 'soft');
        }
  }
}

const FLOWERS: Record<string, Array<[string, number]>> = {
  plains: [['short_grass', 10], ['dandelion', 3], ['poppy', 3], ['oxeye_daisy', 2], ['azure_bluet', 2], ['cornflower', 1], ['tall_grass', 2]],
  forest: [['short_grass', 8], ['fern', 3], ['lily_of_the_valley', 2], ['poppy', 1], ['lilac', 1], ['rose_bush', 1], ['peony', 1], ['bush', 2]],
  flower_forest: [['allium', 2], ['azure_bluet', 2], ['red_tulip', 2], ['orange_tulip', 2], ['white_tulip', 2], ['pink_tulip', 2], ['oxeye_daisy', 2], ['cornflower', 2], ['lily_of_the_valley', 2], ['lilac', 1], ['rose_bush', 1], ['peony', 1]],
  meadow: [['wildflowers', 4], ['short_grass', 6], ['tall_grass', 2], ['cornflower', 2], ['allium', 1], ['azure_bluet', 2], ['oxeye_daisy', 2], ['dandelion', 1]],
  cherry_grove: [['pink_petals', 8], ['short_grass', 3]],
  swamp: [['blue_orchid', 4], ['short_grass', 6], ['fern', 2]],
  taiga: [['fern', 6], ['large_fern', 2], ['sweet_berry_bush', 2], ['short_grass', 4], ['brown_mushroom', 1]],
  savanna: [['short_dry_grass', 6], ['tall_dry_grass', 3], ['short_grass', 3], ['dead_bush', 1]],
  desert: [['dead_bush', 3], ['short_dry_grass', 4], ['tall_dry_grass', 2]],
  jungle: [['fern', 5], ['large_fern', 2], ['short_grass', 5], ['bush', 2]],
  pale_garden: [['closed_eyeblossom', 3], ['open_eyeblossom', 1], ['pale_moss_carpet', 4], ['short_grass', 2]],
  sunflower_plains: [['sunflower', 4], ['short_grass', 6], ['dandelion', 2], ['tall_grass', 2]],
  garden: [['red_tulip', 2], ['orange_tulip', 2], ['white_tulip', 2], ['pink_tulip', 2], ['allium', 2], ['peony', 2], ['rose_bush', 2], ['lilac', 2], ['torchflower', 1], ['cornflower', 2], ['oxeye_daisy', 1]],
};
const DOUBLE_PLANTS = new Set(['tall_grass', 'large_fern', 'lilac', 'rose_bush', 'peony', 'sunflower', 'pitcher_plant']);

function plant(c: Ctx, x: number, y: number, z: number, id: string): void {
  if (DOUBLE_PLANTS.has(id)) {
    if (!c.isFree(x, y + 1, z) || !c.isFree(x, y, z)) return;
    c.set(x, y, z, `${id}[half=lower]`, 'soft');
    c.set(x, y + 1, z, `${id}[half=upper]`, 'soft');
    return;
  }
  const face = c.rng.choice(['north', 'south', 'east', 'west']);
  if (id === 'pink_petals' || id === 'wildflowers') {
    c.set(x, y, z, `${id}[facing=${face},flower_amount=${c.rng.randInt(1, 4)}]`, 'soft');
  } else if (id === 'sweet_berry_bush') c.set(x, y, z, `sweet_berry_bush[age=${c.rng.randInt(2, 3)}]`, 'soft');
  else c.set(x, y, z, id, 'soft');
}

function flowerPatch(c: Ctx, p: Record<string, unknown>): void {
  const biome = str(p, 'biome', 'plains', Object.keys(FLOWERS) as never) as string;
  const radius = num(p, 'radius', c.rng.randInt(3, 5), 1, 16);
  const density = num(p, 'density', 0.45, 0.05, 1);
  const mix = FLOWERS[biome];
  const groundRe = biome === 'desert' || biome === 'savanna' ? /^minecraft:(sand|red_sand|grass_block|dirt|coarse_dirt|terracotta|.*_terracotta)$/ : GROUND;
  const R = Math.ceil(radius);
  // clumps: flowers of one kind cluster together, like in vanilla
  const clumpCenters = Array.from({ length: Math.max(2, Math.round(radius)) }, () => ({
    x: c.rng.range(-radius, radius),
    z: c.rng.range(-radius, radius),
    id: c.rng.weighted(mix),
  }));
  for (let z = -R; z <= R; z++)
    for (let x = -R; x <= R; x++) {
      const d = Math.sqrt(x * x + z * z) / radius;
      const edge = c.noise.noise2(x * 0.4 + 11, z * 0.4) * 0.3;
      if (d > 1 + edge) continue;
      if (!c.rng.chance(density * (1.1 - d * 0.6))) continue;
      const y = c.ground(x, z, 0, groundRe);
      if (y === null) continue;
      let best = clumpCenters[0];
      let bd = Infinity;
      for (const cc of clumpCenters) {
        const dd = (cc.x - x) ** 2 + (cc.z - z) ** 2;
        if (dd < bd) {
          bd = dd;
          best = cc;
        }
      }
      plant(c, x, y, z, c.rng.chance(0.7) ? best.id : c.rng.weighted(mix));
    }
}

function fallenLog(c: Ctx, p: Record<string, unknown>): void {
  const wood = str(p, 'wood', c.rng.choice(['oak', 'birch', 'spruce', 'dark_oak', 'jungle']));
  const len = Math.round(num(p, 'length', c.rng.randInt(3, 6), 2, 16));
  const id = `${wood}_log`;
  c.log(0, 0, -2, id, 'y'); // stump
  for (let i = 0; i < len; i++) {
    c.log(i - Math.floor(len / 2), 0, 0, id, 'x');
    if (c.rng.chance(0.35)) c.set(i - Math.floor(len / 2), 1, 0, 'moss_carpet', 'soft');
    else if (c.rng.chance(0.15)) c.set(i - Math.floor(len / 2), 1, 0, c.rng.choice(['brown_mushroom', 'red_mushroom']), 'soft');
  }
}

function stump(c: Ctx, p: Record<string, unknown>): void {
  const wood = str(p, 'wood', c.rng.choice(['oak', 'birch', 'spruce', 'dark_oak']));
  c.log(0, 0, 0, `${wood}_log`, 'y');
  if (c.rng.chance(0.5)) c.log(0, 1, 0, `${wood}_log`, 'y');
  for (const [dx, dz] of DIRS4) {
    if (c.rng.chance(0.3)) c.log(dx, 0, dz, `${wood}_log`, dx ? 'x' : 'z');
    else if (c.rng.chance(0.3)) c.set(dx, 0, dz, c.rng.choice(['moss_carpet', 'brown_mushroom', 'fern']), 'soft');
  }
}

// ------------------------------------------------------------------ street furniture

function lampPost(c: Ctx, p: Record<string, unknown>): void {
  const style = str(p, 'style', c.rng.choice(['wood', 'stone', 'iron'] as const), ['wood', 'stone', 'iron'] as const);
  const h = Math.round(num(p, 'height', c.rng.randInt(3, 4), 2, 10));
  const light = str(p, 'light', 'lantern', ['lantern', 'soul_lantern', 'copper_lantern'] as const);
  const arms = str(p, 'arms', c.rng.choice(['none', 'one', 'two'] as const), ['none', 'one', 'two'] as const);
  const post = style === 'wood' ? str(p, 'wood', 'dark_oak') + '_fence' : style === 'stone' ? 'stone_brick_wall' : 'iron_bars';
  const base = style === 'wood' ? 'stone_bricks' : style === 'stone' ? 'chiseled_stone_bricks' : 'polished_andesite';
  c.set(0, 0, 0, base);
  for (let y = 1; y <= h; y++) c.set(0, y, 0, style === 'stone' ? `${post}[up=true]` : post);
  if (arms === 'none') {
    c.set(0, h + 1, 0, `${light}[hanging=false]`);
    return;
  }
  // top cap and arm(s) with hanging lanterns
  const cap = style === 'wood' ? 'dark_oak_slab[type=bottom]' : 'stone_brick_slab[type=bottom]';
  c.set(0, h + 1, 0, cap);
  const armBlock = style === 'iron' ? 'iron_bars' : style === 'wood' ? post : 'stone_brick_wall';
  // arm connects back toward the post (west for the +x arm, east for the −x arm)
  const sides: Array<[number, string]> = arms === 'two' ? [[1, 'west'], [-1, 'east']] : [[1, 'west']];
  for (const [dx, back] of sides) {
    const arm = style === 'stone' ? `${armBlock}[${back}=low,up=false]` : `${armBlock}[${back}=true]`;
    c.set(dx, h, 0, arm);
    c.set(dx, h - 1, 0, `${light}[hanging=true]`);
  }
}

function bench(c: Ctx, p: Record<string, unknown>): void {
  const wood = str(p, 'wood', c.rng.choice(['oak', 'spruce', 'dark_oak', 'birch']));
  const len = Math.round(num(p, 'length', c.rng.randInt(2, 3), 1, 8));
  const x0 = -Math.floor(len / 2);
  // seat faces the player (+z): stairs[facing=north] puts the backrest at −z
  for (let i = 0; i < len; i++) c.set(x0 + i, 0, 0, `${wood}_stairs[facing=north,half=bottom]`);
  const arm = str(p, 'armrests', 'trapdoor', ['trapdoor', 'sign', 'none'] as const);
  if (arm === 'trapdoor') {
    c.set(x0 - 1, 0, 0, `${wood}_trapdoor[facing=west,open=true,half=bottom]`);
    c.set(x0 + len, 0, 0, `${wood}_trapdoor[facing=east,open=true,half=bottom]`);
  } else if (arm === 'sign') {
    c.set(x0 - 1, 0, 0, `${wood}_wall_sign[facing=west]`);
    c.set(x0 + len, 0, 0, `${wood}_wall_sign[facing=east]`);
  }
  if (c.rng.chance(0.4)) c.set(x0 + len + (arm === 'none' ? 0 : 1), 0, 0, 'potted_' + c.rng.choice(['poppy', 'red_tulip', 'cornflower', 'fern', 'azure_bluet']));
}

function well(c: Ctx, p: Record<string, unknown>): void {
  const stone = str(p, 'stone', c.rng.choice(['cobblestone', 'stone_bricks', 'mossy_cobblestone']));
  const wood = str(p, 'wood', c.rng.choice(['oak', 'spruce', 'dark_oak']));
  const depth = Math.round(num(p, 'depth', 3, 1, 12));
  const wallSuffix = stone.endsWith('bricks') ? stone.replace(/s$/, '') + '_wall' : stone + '_wall';
  // shaft: water column with stone lining, rim of walls on top
  for (let y = -depth; y <= 0; y++)
    for (let z = -2; z <= 2; z++)
      for (let x = -2; x <= 2; x++) {
        const ring = Math.abs(x) === 2 || Math.abs(z) === 2;
        if (ring || y === -depth) c.set(x, y, z, c.rng.chance(0.2) ? 'mossy_cobblestone' : stone);
        else c.set(x, y, z, 'water');
      }
  for (let z = -2; z <= 2; z++)
    for (let x = -2; x <= 2; x++) {
      if (Math.abs(x) === 2 || Math.abs(z) === 2) c.set(x, 1, z, wallSuffix);
    }
  // posts + roof
  for (const [x, z] of [
    [-2, 0],
    [2, 0],
  ] as const) {
    c.set(x, 2, z, `${wood}_fence`);
    c.set(x, 3, z, `${wood}_fence`);
  }
  for (let x = -2; x <= 2; x++) {
    c.set(x, 4, -1, `${wood}_stairs[facing=south,half=bottom]`);
    c.set(x, 4, 1, `${wood}_stairs[facing=north,half=bottom]`);
    c.set(x, 4, 0, `${wood}_slab[type=bottom]`);
    c.set(x, 5, 0, `${wood}_slab[type=bottom]`);
  }
  c.set(-2, 4, 0, `${wood}_planks`);
  c.set(2, 4, 0, `${wood}_planks`);
  c.set(0, 3, 0, 'iron_chain[axis=y]');
  c.set(0, 2, 0, c.rng.chance(0.5) ? 'lantern[hanging=true]' : 'iron_chain[axis=y]');
}

function fountain(c: Ctx, p: Record<string, unknown>): void {
  const r = Math.round(num(p, 'radius', c.rng.randInt(3, 4), 2, 10));
  const stone = str(p, 'stone', c.rng.choice(['stone_bricks', 'polished_andesite', 'smooth_stone', 'quartz_bricks']));
  const rim = str(p, 'rim', stone === 'stone_bricks' ? 'stone_brick_wall' : stone === 'polished_andesite' ? 'andesite_wall' : 'stone_brick_wall');
  const pillar = Math.round(num(p, 'height', c.rng.randInt(2, 4), 1, 10));
  for (let z = -r - 1; z <= r + 1; z++)
    for (let x = -r - 1; x <= r + 1; x++) {
      const d = Math.sqrt(x * x + z * z);
      if (d > r + 0.5) {
        if (d <= r + 1.5) c.set(x, -1, z, c.rng.chance(0.7) ? stone : 'cobblestone'); // path ring
        continue;
      }
      c.set(x, -1, z, stone); // floor
      if (d > r - 0.5) c.set(x, 0, z, rim);
      else c.set(x, 0, z, 'water');
    }
  for (let y = 0; y <= pillar; y++) c.set(0, y, 0, y === pillar ? 'chiseled_stone_bricks' : stone);
  // top bowl
  for (const [dx, dz] of DIRS4) c.set(dx, pillar, dz, 'stone_brick_slab[type=bottom]');
  c.set(0, pillar + 1, 0, 'water');
  if (c.rng.chance(0.5)) {
    for (const [dx, dz] of DIRS4) c.set(dx * r, 1, dz * r, 'lantern');
  }
}

function marketStall(c: Ctx, p: Record<string, unknown>): void {
  const wood = str(p, 'wood', c.rng.choice(['oak', 'spruce', 'dark_oak', 'birch']));
  const colors = ['red', 'white', 'yellow', 'blue', 'green', 'orange', 'lime', 'light_blue', 'purple', 'brown'];
  const c1 = str(p, 'color', c.rng.choice(colors));
  let c2 = c.rng.choice(colors);
  if (c2 === c1) c2 = 'white';
  const w = Math.round(num(p, 'width', c.rng.randInt(3, 4), 2, 8));
  const d = 2;
  const x0 = -Math.floor(w / 2);
  const x1 = x0 + w - 1;
  // posts
  for (const x of [x0, x1])
    for (const z of [0, -d]) for (let y = 0; y <= 2; y++) c.set(x, y, z, `${wood}_fence`);
  // counter at the front (+z side faces the customer)
  for (let x = x0 + 1; x <= x1 - 1; x++) {
    c.set(x, 0, 0, c.rng.chance(0.6) ? 'barrel[facing=up]' : `${wood}_planks`);
    c.set(x, 1, 0, `${wood}_slab[type=bottom]`);
  }
  // goods
  const goods = ['potted_red_tulip', 'potted_poppy', 'melon', 'pumpkin', 'hay_block[axis=y]', 'decorated_pot[facing=south]', 'composter', 'barrel[facing=up]', 'potted_fern'];
  for (let x = x0 + 1; x <= x1 - 1; x++) {
    if (c.rng.chance(0.5)) c.set(x, 0, -d + 1, c.rng.choice(goods));
  }
  c.set(x0 + 1, 0, -d, `chest[facing=south]`);
  // striped awning reaching one block past the counter
  for (let x = x0; x <= x1; x++) {
    const col = (x - x0) % 2 === 0 ? c1 : c2;
    for (let z = -d; z <= 1; z++) c.set(x, 3, z, `${col}_wool`);
  }
  if (c.rng.chance(0.6)) c.set(x1, 2, -d + 1, 'lantern[hanging=true]');
}

function campfireSeating(c: Ctx, p: Record<string, unknown>): void {
  const soul = str(p, 'fire', 'campfire', ['campfire', 'soul_campfire'] as const);
  const wood = str(p, 'wood', c.rng.choice(['oak', 'spruce', 'birch', 'dark_oak']));
  c.set(0, 0, 0, `${soul}[lit=true,signal_fire=false]`);
  const seats = Math.round(num(p, 'seats', c.rng.randInt(3, 4), 2, 4));
  const spots: Array<[number, number, 'x' | 'z']> = c.rng.shuffle([
    [0, -2, 'x'],
    [2, 0, 'z'],
    [0, 2, 'x'],
    [-2, 0, 'z'],
  ]);
  for (let i = 0; i < seats; i++) {
    const [x, z, axis] = spots[i];
    const kind = c.rng.chance(0.65) ? 'log' : 'stairs';
    if (kind === 'log') {
      c.log(x, 0, z, `stripped_${wood}_log`, axis);
      if (axis === 'x') c.log(x + c.rng.choice([-1, 1]), 0, z, `stripped_${wood}_log`, axis);
      else c.log(x, 0, z + c.rng.choice([-1, 1]), `stripped_${wood}_log`, axis);
    } else {
      // stairs face the fire: the backrest is on the far side
      const facing = z < 0 ? 'north' : z > 0 ? 'south' : x > 0 ? 'east' : 'west';
      c.set(x, 0, z, `${wood}_stairs[facing=${facing},half=bottom]`);
    }
  }
  if (c.rng.chance(0.5)) c.set(c.rng.choice([-2, 2]), 0, c.rng.choice([-2, 2]), 'barrel[facing=up]');
  for (let i = 0; i < 3; i++) {
    const x = c.rng.randInt(-3, 3);
    const z = c.rng.randInt(-3, 3);
    if (Math.abs(x) + Math.abs(z) > 3) c.set(x, 0, z, c.rng.choice(['short_grass', 'fern', 'brown_mushroom']), 'soft');
  }
}

function pile(c: Ctx, p: Record<string, unknown>, items: Array<[string, number]>): void {
  const s = sizeScale(p, c.rng);
  const r = 1.6 * s;
  const R = Math.ceil(r);
  for (let z = -R; z <= R; z++)
    for (let x = -R; x <= R; x++) {
      const d = Math.sqrt(x * x + z * z);
      const hgt = Math.round((r - d) * c.rng.range(0.8, 1.3) + c.noise.noise2(x * 0.7, z * 0.7) * 0.6);
      for (let y = 0; y < hgt; y++) {
        const st = c.rng.weighted(items);
        c.set(x, y, z, st);
      }
    }
}

function hayPile(c: Ctx, p: Record<string, unknown>): void {
  pile(c, p, [
    ['hay_block[axis=y]', 3],
    ['hay_block[axis=x]', 2],
    ['hay_block[axis=z]', 2],
  ]);
  if (c.rng.chance(0.5)) c.set(c.rng.randInt(-2, 2), 0, c.rng.randInt(-2, 2) || 2, 'composter', 'soft');
}

function cratePile(c: Ctx, p: Record<string, unknown>): void {
  const wood = str(p, 'wood', c.rng.choice(['spruce', 'oak', 'dark_oak']));
  pile(c, p, [
    ['barrel[facing=up]', 4],
    ['barrel[facing=north]', 1],
    ['barrel[facing=east]', 1],
    ['composter', 2],
    [`${wood}_planks`, 1],
    ['chiseled_bookshelf[facing=south]', 0.2],
  ]);
}

// ------------------------------------------------------------------ registry of prefabs

type Gen = (c: Ctx, p: Record<string, unknown>) => void;

const TREE_PARAMS = { size: 'small | medium | large | huge (default medium)', height: 'trunk height override (blocks)' };
const ORIENT = { facing: 'north | east | south | west — the front faces the player looking this way (default north)' };

const PREFABS: Record<string, { description: string; params: Record<string, string>; gen: Gen; oriented?: boolean }> = {
  oak_tree: { description: 'Oak tree; larger sizes get branches with extra leaf clusters', params: TREE_PARAMS, gen: (c, p) => treeOak(c, p) },
  birch_tree: { description: 'Slender birch with a narrow crown', params: TREE_PARAMS, gen: treeBirch },
  spruce_tree: { description: 'Conical spruce with layered rings', params: TREE_PARAMS, gen: treeSpruce },
  dark_oak_tree: { description: '2x2 dark oak with wide flat canopy and roots', params: TREE_PARAMS, gen: (c, p) => treeDarkOak(c, p) },
  pale_oak_tree: { description: '2x2 pale oak with hanging pale moss and moss carpet', params: TREE_PARAMS, gen: treePaleOak },
  cherry_tree: { description: 'Cherry blossom with arching branches, drooping pink leaves and petals on the ground', params: TREE_PARAMS, gen: treeCherry },
  jungle_tree: { description: 'Jungle tree (2x2 giant for medium+), branches and vines', params: TREE_PARAMS, gen: treeJungle },
  acacia_tree: { description: 'Acacia with bent, forked trunk and flat umbrella canopies', params: TREE_PARAMS, gen: treeAcacia },
  mangrove_tree: { description: 'Mangrove raised on arching roots, propagules and vines', params: TREE_PARAMS, gen: treeMangrove },
  giant_oak: { description: 'Fantasy giant oak: tapered bark trunk, flared roots, spiralling branches, huge leaf clouds (15-30 blocks)', params: TREE_PARAMS, gen: treeGiantOak },
  willow_tree: { description: 'Weeping willow with hanging leaf strands and vines', params: { ...TREE_PARAMS, leaves: 'leaf block (default oak_leaves)' }, gen: treeWillow },
  palm_tree: { description: 'Curved palm trunk with drooping fronds and cocoa', params: TREE_PARAMS, gen: treePalm },
  maple_tree: { description: 'Autumn maple: dark trunk, red/orange/yellow poplar leaves, leaf litter', params: { ...TREE_PARAMS, palette: 'autumn | red | orange | yellow' }, gen: treeMaple },
  poplar_tree: { description: 'Tall columnar poplar', params: { ...TREE_PARAMS, color: 'yellow | orange | red' }, gen: treePoplar },
  bush: { description: 'Leafy bush (random or given leaves)', params: { size: 'small | medium | large', leaves: 'leaf block, e.g. azalea_leaves' }, gen: bush },
  boulder: { description: 'Boulder / rock cluster of stone, andesite, cobble, tuff with moss', params: { size: 'small | medium | large | huge', count: 'rocks in the cluster (1-12)', moss: '0..1 mossiness (default 0.3)' }, gen: boulder },
  flower_patch: { description: 'Biome-appropriate flowers/grass in natural clumps, only on grass/dirt', params: { biome: Object.keys(FLOWERS).join(' | '), radius: 'blocks (default 3-5)', density: '0..1 (default 0.45)' }, gen: flowerPatch },
  fallen_log: { description: 'Fallen log with stump, moss and mushrooms', params: { wood: 'oak | birch | spruce | dark_oak | jungle', length: '2-16', ...ORIENT }, gen: fallenLog, oriented: true },
  stump: { description: 'Tree stump with roots and moss', params: { wood: 'oak | birch | spruce | dark_oak' }, gen: stump },
  lamp_post: { description: 'Street lamp: wood/stone/iron post with lantern on top or hanging from arms', params: { style: 'wood | stone | iron', height: '2-10', light: 'lantern | soul_lantern | copper_lantern', arms: 'none | one | two', ...ORIENT }, gen: lampPost, oriented: true },
  bench: { description: 'Bench of stairs facing the front (+z), with armrests', params: { wood: 'oak | spruce | dark_oak | …', length: '1-8', armrests: 'trapdoor | sign | none', ...ORIENT }, gen: bench, oriented: true },
  well: { description: 'Village well 5x5: stone shaft with water, wooden roof, chain + lantern', params: { stone: 'cobblestone | stone_bricks | mossy_cobblestone', wood: 'oak | spruce | dark_oak', depth: '1-12', ...ORIENT }, gen: well, oriented: true },
  fountain: { description: 'Round fountain: basin with rim, central pillar with water on top (flows in-game)', params: { radius: '2-10', stone: 'stone_bricks | polished_andesite | smooth_stone | quartz_bricks', height: 'pillar 1-10' }, gen: fountain },
  market_stall: { description: 'Market stall with striped wool awning, counter, goods, chest', params: { wood: 'oak | spruce | …', color: 'wool color', width: '2-8', ...ORIENT }, gen: marketStall, oriented: true },
  campfire_seating: { description: 'Lit campfire with log/stair seats around it', params: { fire: 'campfire | soul_campfire', wood: 'oak | spruce | …', seats: '2-4' }, gen: campfireSeating },
  hay_pile: { description: 'Organic pile of hay bales', params: { size: 'small | medium | large' }, gen: hayPile },
  crate_pile: { description: 'Pile of barrels/crates', params: { size: 'small | medium | large', wood: 'spruce | oak | dark_oak' }, gen: cratePile },
};

const ALIASES: Record<string, string> = {
  oak: 'oak_tree',
  tree: 'oak_tree',
  birch: 'birch_tree',
  spruce: 'spruce_tree',
  pine: 'spruce_tree',
  dark_oak: 'dark_oak_tree',
  pale_oak: 'pale_oak_tree',
  cherry: 'cherry_tree',
  jungle: 'jungle_tree',
  acacia: 'acacia_tree',
  mangrove: 'mangrove_tree',
  fantasy_oak: 'giant_oak',
  willow: 'willow_tree',
  weeping_willow: 'willow_tree',
  palm: 'palm_tree',
  maple: 'maple_tree',
  autumn_maple: 'maple_tree',
  poplar: 'poplar_tree',
  rock: 'boulder',
  rocks: 'boulder',
  flowers: 'flower_patch',
  lamp: 'lamp_post',
  lantern_post: 'lamp_post',
  stall: 'market_stall',
  campfire: 'campfire_seating',
  hay: 'hay_pile',
  crates: 'crate_pile',
  barrels: 'crate_pile',
};

export function listPrefabs(): PrefabInfo[] {
  return Object.entries(PREFABS).map(([name, d]) => ({ name, description: d.description, params: d.params }));
}

export function resolvePrefabName(name: string): string | undefined {
  const n = String(name).toLowerCase().trim().replace(/[\s-]+/g, '_');
  if (PREFABS[n]) return n;
  return ALIASES[n];
}

/**
 * Place a prefab with its base at `at` (= first air block above the ground for nature
 * prefabs). Returns the number of blocks set. Throws with a helpful message for unknown names
 * or invalid params.
 */
export function placePrefab(
  name: string,
  at: Vec3,
  params: Record<string, unknown>,
  sink: BlockSink,
  reg: Registry,
  seed?: number,
): number {
  const key = resolvePrefabName(name);
  if (!key) {
    throw new Error(`unknown prefab "${name}". Available: ${Object.keys(PREFABS).join(', ')}`);
  }
  const def = PREFABS[key];
  const p = params ?? {};
  const s = seed ?? (hashSeed(`${key}:${at[0]},${at[1]},${at[2]}`) ^ hashSeed(typeof p.seed === 'number' ? p.seed : 0));
  const rng = createRng(s);
  const noise = createNoise(s);
  let facing: Facing = 'north';
  if (typeof p.facing === 'string' && p.facing) {
    if (!['north', 'east', 'south', 'west'].includes(p.facing)) {
      throw new Error(`invalid facing "${p.facing}" (north | east | south | west)`);
    }
    facing = p.facing as Facing;
  } else if (!def.oriented) {
    facing = rng.choice(['north', 'east', 'south', 'west'] as const); // free rotation → more variety
  }
  const frame = new Frame(at, facing, reg);
  const ctx = new Ctx(sink, reg, frame, rng.fork('gen'), noise);
  def.gen(ctx, p);
  return ctx.count;
}
