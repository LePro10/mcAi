// Volume analysis for the agent: summaries, ASCII layer views, surface maps, dark spots, diffs.

import type { Box, Vec3, BlockVolume } from './types.ts';
import type { Registry } from './registry.ts';
import { AIR, blockId, isAir } from './blockstate.ts';
import { boxContains, boxSize, volIndex } from './volume.ts';

function airMask(v: BlockVolume): Uint8Array {
  const m = new Uint8Array(v.palette.length);
  for (let i = 0; i < v.palette.length; i++) m[i] = isAir(v.palette[i]) ? 1 : 0;
  return m;
}

function short(s: string): string {
  return s.startsWith('minecraft:') ? s.slice(10) : s;
}

// ------------------------------------------------------------------ summarize

export function summarize(
  v: BlockVolume,
  _reg?: Registry,
  opts: { byState?: boolean } = {},
): { counts: Record<string, number>; nonAir: number; bounds: Box | null } {
  const per = new Float64Array(v.palette.length);
  for (let i = 0; i < v.data.length; i++) per[v.data[i]]++;
  const air = airMask(v);
  const counts: Record<string, number> = {};
  let nonAir = 0;
  for (let p = 0; p < v.palette.length; p++) {
    if (!per[p] || air[p]) continue;
    const key = opts.byState ? v.palette[p] : blockId(v.palette[p]);
    counts[key] = (counts[key] ?? 0) + per[p];
    nonAir += per[p];
  }
  // sort by count desc for readability
  const sorted: Record<string, number> = {};
  for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) sorted[k] = n;
  let bounds: Box | null = null;
  if (nonAir) {
    const [sx, , sz] = boxSize(v.box);
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < v.data.length; i++) {
      if (air[v.data[i]]) continue;
      const x = i % sx;
      const r = (i - x) / sx;
      const z = r % sz;
      const y = (r - z) / sz;
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x;
      if (y > max[1]) max[1] = y;
      if (z > max[2]) max[2] = z;
    }
    const o = v.box.min;
    bounds = { min: [o[0] + min[0], o[1] + min[1], o[2] + min[2]], max: [o[0] + max[0], o[1] + max[1], o[2] + max[2]] };
  }
  return { counts: sorted, nonAir, bounds };
}

// ------------------------------------------------------------------ layerAscii

const SPECIAL: Array<[RegExp, string]> = [
  [/(^|_)water$/, '~'],
  [/(^|_)lava$/, '%'],
  [/glass_pane$|(^|_)glass$/, 'g'],
  [/_door$/, 'D'],
  [/_trapdoor$/, 't'],
  [/_stairs$/, '/'],
  [/_slab$/, '_'],
  [/_fence_gate$/, 'n'],
  [/_fence$/, '|'],
  [/_wall$/, 'H'],
  [/(^|_)torch$|lantern$|campfire$|froglight$|glowstone$|shroomlight$/, '*'],
  [/_leaves$/, '&'],
  [/_log$|_wood$|_stem$/, '#'],
  [/_planks$/, '='],
  [/(^|_)bricks?$/, 'B'],
  [/^grass_block$/, ','],
  [/^(dirt|coarse_dirt|rooted_dirt|mud)$/, ':'],
  [/^(short_grass|tall_grass|fern|large_fern)$/, '"'],
  [/_carpet$/, '-'],
  [/^iron_bars$/, '+'],
  [/(^|_)bed$/, 'b'],
  [/(^|_)chest$|barrel$/, 'C'],
];

const FALLBACK = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@$&?!;<>(){}[]^`\'';

/**
 * One character per block of the horizontal layer `y`: rows are z (north at the top), columns x
 * (west at the left). '.' = air, ' ' = outside the volume. Legend maps char → block id.
 */
export function layerAscii(
  v: BlockVolume,
  y: number,
  opts: { byState?: boolean } = {},
): { grid: string[]; legend: Record<string, string> } {
  const [sx, , sz] = boxSize(v.box);
  const legend: Record<string, string> = {};
  const charOf = new Map<string, string>();
  const used = new Set<string>(['.', ' ']);
  const pick = (key: string): string => {
    let c = charOf.get(key);
    if (c) return c;
    const s = short(blockId(key));
    for (const [re, ch] of SPECIAL) {
      if (re.test(s) && !used.has(ch)) {
        c = ch;
        break;
      }
    }
    if (!c) {
      // first letters of words, upper then lower case, then any letter of the name
      const words = s.split(/[_:]/).filter(Boolean);
      const cands: string[] = [];
      for (const w of words.slice().reverse()) cands.push(w[0].toUpperCase(), w[0].toLowerCase());
      for (const ch of s.replace(/[^a-z0-9]/g, '')) cands.push(ch.toUpperCase(), ch);
      c = cands.find((ch) => !used.has(ch)) ?? [...FALLBACK].find((ch) => !used.has(ch)) ?? '?';
    }
    used.add(c);
    charOf.set(key, c);
    legend[c] = opts.byState ? short(key) : s;
    return c;
  };
  const grid: string[] = [];
  const inY = y >= v.box.min[1] && y <= v.box.max[1];
  for (let z = 0; z < sz; z++) {
    let row = '';
    for (let x = 0; x < sx; x++) {
      if (!inY) {
        row += ' ';
        continue;
      }
      const s = v.palette[v.data[volIndex(v.box, v.box.min[0] + x, y, v.box.min[2] + z)]];
      row += isAir(s) ? '.' : pick(opts.byState ? s : blockId(s));
    }
    grid.push(row);
  }
  return { grid, legend };
}

// ------------------------------------------------------------------ surfaceMap

/**
 * Highest non-air block per column (x fastest, then z). Columns without blocks get
 * box.min.y - 1 and top ''. With `solidOnly`, plants/leaves/transparent blocks are skipped.
 */
export function surfaceMap(
  v: BlockVolume,
  reg: Registry,
  opts: { solidOnly?: boolean; ignoreLeaves?: boolean } = {},
): { heights: Int16Array; tops: string[]; w: number; d: number } {
  const [sx, sy, sz] = boxSize(v.box);
  const skip = new Uint8Array(v.palette.length);
  for (let i = 0; i < v.palette.length; i++) {
    const s = v.palette[i];
    if (isAir(s)) skip[i] = 1;
    else if (opts.solidOnly && !reg.isFullSolid(s)) skip[i] = 1;
    else if (opts.ignoreLeaves && /_leaves$/.test(blockId(s))) skip[i] = 1;
  }
  const heights = new Int16Array(sx * sz);
  const tops: string[] = new Array(sx * sz).fill('');
  const layer = sx * sz;
  for (let z = 0; z < sz; z++)
    for (let x = 0; x < sx; x++) {
      const col = z * sx + x;
      heights[col] = v.box.min[1] - 1;
      for (let y = sy - 1; y >= 0; y--) {
        const p = v.data[y * layer + col];
        if (skip[p]) continue;
        heights[col] = v.box.min[1] + y;
        tops[col] = v.palette[p];
        break;
      }
    }
  return { heights, tops, w: sx, d: sz };
}

// ------------------------------------------------------------------ light

const EMIT: Record<string, number> = {
  glowstone: 15,
  sea_lantern: 15,
  lantern: 15,
  jack_o_lantern: 15,
  beacon: 15,
  shroomlight: 15,
  ochre_froglight: 15,
  verdant_froglight: 15,
  pearlescent_froglight: 15,
  lava: 15,
  lava_cauldron: 15,
  fire: 15,
  end_portal: 15,
  end_gateway: 15,
  conduit: 15,
  torch: 14,
  wall_torch: 14,
  copper_torch: 14,
  copper_wall_torch: 14,
  end_rod: 14,
  nether_portal: 11,
  soul_torch: 10,
  soul_wall_torch: 10,
  soul_lantern: 10,
  soul_fire: 10,
  crying_obsidian: 10,
  enchanting_table: 7,
  ender_chest: 7,
  glow_lichen: 7,
  sculk_catalyst: 6,
  amethyst_cluster: 5,
  large_amethyst_bud: 4,
  magma_block: 3,
  medium_amethyst_bud: 2,
  firefly_bush: 2,
  small_amethyst_bud: 1,
  brewing_stand: 1,
  brown_mushroom: 1,
  dragon_egg: 1,
  end_portal_frame: 1,
  sculk_sensor: 1,
  calibrated_sculk_sensor: 1,
};

function propVal(state: string, prop: string): string | undefined {
  const m = new RegExp(`[\\[,]${prop}=([a-z0-9_]+)`).exec(state);
  return m ? m[1] : undefined;
}

/** Approximate block light emitted by a state (0..15). */
export function lightEmission(state: string): number {
  const id = short(blockId(state));
  const lit = propVal(state, 'lit');
  if (id.endsWith('copper_lantern')) return 15;
  if (id === 'campfire') return lit === 'false' ? 0 : 15;
  if (id === 'soul_campfire') return lit === 'false' ? 0 : 10;
  if (id === 'furnace' || id === 'blast_furnace' || id === 'smoker') return lit === 'true' ? 13 : 0;
  if (id === 'redstone_lamp') return lit === 'true' ? 15 : 0;
  if (id === 'redstone_torch' || id === 'redstone_wall_torch') return lit === 'false' ? 0 : 7;
  if (id === 'redstone_ore' || id === 'deepslate_redstone_ore') return lit === 'true' ? 9 : 0;
  if (id.endsWith('copper_bulb')) {
    if (lit !== 'true') return 0;
    return id.includes('oxidized') ? 4 : id.includes('weathered') ? 8 : id.includes('exposed') ? 12 : 15;
  }
  if (id === 'candle' || id.endsWith('_candle')) return lit === 'true' ? 3 * Number(propVal(state, 'candles') ?? 1) : 0;
  if (id.endsWith('candle_cake')) return lit === 'true' ? 3 : 0;
  if (id === 'sea_pickle') return propVal(state, 'waterlogged') === 'true' ? 3 * Number(propVal(state, 'pickles') ?? 1) + 3 : 0;
  if (id === 'cave_vines' || id === 'cave_vines_plant') return propVal(state, 'berries') === 'true' ? 14 : 0;
  if (id === 'light') return Number(propVal(state, 'level') ?? 15);
  if (id === 'respawn_anchor') return [0, 3, 7, 11, 15][Number(propVal(state, 'charges') ?? 0)] ?? 0;
  if (id === 'creaking_heart') return 0;
  return EMIT[id] ?? 0;
}

/**
 * Block-light field of a volume (BFS flood fill from emitters, −1 per step, blocked by opaque
 * full blocks). Light from outside the volume is not considered. Returns one level per block.
 */
export function computeBlockLight(v: BlockVolume, reg: Registry): Uint8Array {
  const [sx, sy, sz] = boxSize(v.box);
  const n = v.data.length;
  const light = new Uint8Array(n);
  const emit = new Uint8Array(v.palette.length);
  const opaque = new Uint8Array(v.palette.length);
  for (let i = 0; i < v.palette.length; i++) {
    const s = v.palette[i];
    emit[i] = lightEmission(s);
    opaque[i] = !isAir(s) && reg.isFullSolid(s) && !reg.isTransparent(s) ? 1 : 0;
  }
  // bucketed BFS (levels 15..1)
  const buckets: number[][] = Array.from({ length: 16 }, () => []);
  for (let i = 0; i < n; i++) {
    const e = emit[v.data[i]];
    if (e > 0) {
      light[i] = e;
      buckets[e].push(i);
    }
  }
  const layer = sx * sz;
  for (let lvl = 15; lvl >= 2; lvl--) {
    const q = buckets[lvl];
    for (let k = 0; k < q.length; k++) {
      const i = q[k];
      if (light[i] !== lvl) continue;
      const x = i % sx;
      const r = (i - x) / sx;
      const z = r % sz;
      const y = (r - z) / sz;
      const nl = lvl - 1;
      const visit = (j: number): void => {
        if (light[j] >= nl) return;
        if (opaque[v.data[j]]) return;
        light[j] = nl;
        buckets[nl].push(j);
      };
      if (x > 0) visit(i - 1);
      if (x < sx - 1) visit(i + 1);
      if (z > 0) visit(i - sx);
      if (z < sz - 1) visit(i + sx);
      if (y > 0) visit(i - layer);
      if (y < sy - 1) visit(i + layer);
    }
    q.length = 0;
  }
  return light;
}

/**
 * Spots where hostile mobs could spawn: air block with a full opaque floor below, air above
 * (2 blocks of headroom; the top layer counts the space above the volume as air) and block
 * light 0 (current vanilla rule). Light sources outside the volume are ignored, sky light too.
 */
export function findDarkSpots(v: BlockVolume, reg: Registry, opts: { maxResults?: number } = {}): Vec3[] {
  const max = opts.maxResults ?? 5000;
  const [sx, sy, sz] = boxSize(v.box);
  const light = computeBlockLight(v, reg);
  const air = new Uint8Array(v.palette.length);
  const floor = new Uint8Array(v.palette.length);
  for (let i = 0; i < v.palette.length; i++) {
    const s = v.palette[i];
    air[i] = isAir(s) ? 1 : 0;
    const id = blockId(s);
    floor[i] =
      !air[i] && reg.isFullSolid(s) && !reg.isTransparent(s) && id !== 'minecraft:bedrock' && id !== 'minecraft:barrier' ? 1 : 0;
  }
  const layer = sx * sz;
  const out: Vec3[] = [];
  for (let y = 1; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++) {
        const i = y * layer + z * sx + x;
        if (!air[v.data[i]] || light[i] > 0) continue;
        if (!floor[v.data[i - layer]]) continue;
        if (y + 1 < sy && !air[v.data[i + layer]]) continue;
        out.push([v.box.min[0] + x, v.box.min[1] + y, v.box.min[2] + z]);
        if (out.length >= max) return out;
      }
  return out;
}

// ------------------------------------------------------------------ diff

export interface VolumeDiff {
  /** [x, y, z, from, to] for every differing position */
  changes: Array<[number, number, number, string, string]>;
  added: number;
  removed: number;
  replaced: number;
  /** true when changes was truncated at `maxChanges` */
  truncated: boolean;
}

/** Differences between two volumes over the union of their boxes (outside a box = air). */
export function diffVolumes(a: BlockVolume, b: BlockVolume, opts: { maxChanges?: number } = {}): VolumeDiff {
  const max = opts.maxChanges ?? 1_000_000;
  const min: Vec3 = [0, 1, 2].map((i) => Math.min(a.box.min[i], b.box.min[i])) as Vec3;
  const mx: Vec3 = [0, 1, 2].map((i) => Math.max(a.box.max[i], b.box.max[i])) as Vec3;
  const res: VolumeDiff = { changes: [], added: 0, removed: 0, replaced: 0, truncated: false };
  const at = (v: BlockVolume, x: number, y: number, z: number): string => {
    const bx = v.box;
    if (x < bx.min[0] || x > bx.max[0] || y < bx.min[1] || y > bx.max[1] || z < bx.min[2] || z > bx.max[2]) return AIR;
    return v.palette[v.data[volIndex(bx, x, y, z)]];
  };
  for (let y = min[1]; y <= mx[1]; y++)
    for (let z = min[2]; z <= mx[2]; z++)
      for (let x = min[0]; x <= mx[0]; x++) {
        const s1 = at(a, x, y, z);
        const s2 = at(b, x, y, z);
        if (s1 === s2) continue;
        const a1 = isAir(s1);
        const a2 = isAir(s2);
        if (a1 && a2) continue;
        if (a1) res.added++;
        else if (a2) res.removed++;
        else res.replaced++;
        if (res.changes.length < max) res.changes.push([x, y, z, s1, s2]);
        else res.truncated = true;
      }
  return res;
}

// ------------------------------------------------------------------ dark spot classes

export type DarkClass = 'interior' | 'covered' | 'outdoor' | 'roof';

/**
 * Classify dark spots: `interior` = a non-leaf roof within `roofMax` above and walls in ≥ 3 of
 * the 4 horizontal directions within `wallMax`; `covered` = something above (eaves, canopy,
 * bridge) but open; `outdoor` = open sky; `roof` = standing on a roof surface (≥ 3 stairs/slabs
 * around the spot) and not interior — not meant to be walked on.
 */
export function classifyDarkSpots(v: BlockVolume, reg: Registry, spots: Vec3[], opts: { roofMax?: number; wallMax?: number } = {}): DarkClass[] {
  const roofMax = opts.roofMax ?? 16, wallMax = opts.wallMax ?? 12;
  const kind = new Uint8Array(v.palette.length); // 0 air/soft, 1 leaves, 2 stairs/slab, 3 solid
  v.palette.forEach((s, i) => {
    if (isAir(s)) return;
    const id = blockId(s);
    if (reg.hasTag(id, 'minecraft:leaves')) kind[i] = 1;
    else if (id.endsWith('_stairs') || id.endsWith('_slab')) kind[i] = 2;
    else if (reg.isFullSolid(s) || reg.hasTag(id, 'minecraft:blocks_motion')) kind[i] = 3;
  });
  const at = (x: number, y: number, z: number): number => (boxContains(v.box, x, y, z) ? kind[v.data[volIndex(v.box, x, y, z)]!]! : 0);
  const out: DarkClass[] = [];
  for (const [x, y, z] of spots) {
    let above = 0;
    for (let yy = y + 2; yy <= y + roofMax; yy++) {
      const k = at(x, yy, z);
      if (k) {
        above = k;
        break;
      }
    }
    let walls = 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      for (let d = 1; d <= wallMax; d++) {
        const k = Math.max(at(x + dx * d, y, z + dz * d), at(x + dx * d, y + 1, z + dz * d));
        if (k >= 2) {
          walls++;
          break;
        }
      }
    }
    if (above && above !== 1 && walls >= 3) {
      out.push('interior');
      continue;
    }
    let tiles = 0;
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        if (at(x + dx, y, z + dz) === 2 || at(x + dx, y - 1, z + dz) === 2) tiles++;
      }
    if (tiles >= 3) out.push('roof');
    else out.push(above ? 'covered' : 'outdoor');
  }
  return out;
}
