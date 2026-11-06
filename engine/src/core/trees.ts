// Connectivity analysis on a BlockVolume: natural trees, tree debris (cut-off branches, leaves
// far from wood) and floating clusters. All functions work on volume indices (x fastest, then
// z, then y) and return Uint8Array masks / component lists. Pure, no I/O.

import type { BlockVolume, Box, Vec3 } from './types.ts';
import type { Registry } from './registry.ts';
import { propOf } from './registry.ts';
import { blockId, isAir } from './blockstate.ts';
import { boxSize } from './volume.ts';
import { isFluidState } from './support.ts';

const NATURAL_GROUND = new Set([
  'grass_block', 'dirt', 'coarse_dirt', 'podzol', 'mycelium', 'sand', 'red_sand', 'gravel', 'snow_block', 'stone', 'rooted_dirt',
  'mud', 'clay', 'moss_block', 'terracotta', 'red_terracotta', 'orange_terracotta', 'yellow_terracotta', 'white_terracotta',
  'brown_terracotta', 'light_gray_terracotta', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'calcite', 'pale_moss_block',
  'sandstone', 'red_sandstone', 'bedrock', 'dirt_path', 'farmland', 'ice', 'packed_ice', 'blue_ice', 'powder_snow', 'netherrack',
  'soul_sand', 'soul_soil', 'end_stone', 'dripstone_block', 'smooth_basalt', 'obsidian', 'suspicious_sand', 'suspicious_gravel',
  'coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'deepslate_coal_ore', 'deepslate_iron_ore', 'deepslate_copper_ore', 'magma_block',
]);

/** natural terrain material (what the world generator makes as ground) */
export function isNaturalGround(state: string): boolean {
  return NATURAL_GROUND.has(blockId(state).slice(10));
}

export type Kind = 0 | 1 | 2 | 3 | 4 | 5;
/** per-palette classification */
export const K_AIR = 0, K_LOG = 1, K_LEAF = 2, K_SOLID = 3, K_SOFT = 4, K_FLUID = 5;

/** 0 air, 1 log (not stripped), 2 leaves, 3 other solid/structure, 4 soft (plants, vines, snow layer…), 5 fluid */
export function classifyPalette(v: BlockVolume, reg: Registry): Uint8Array {
  const k = new Uint8Array(v.palette.length);
  v.palette.forEach((s, i) => {
    if (isAir(s)) k[i] = K_AIR;
    else if (isFluidState(s)) k[i] = K_FLUID;
    else {
      const id = blockId(s);
      if (reg.hasTag(id, 'minecraft:logs') && !id.includes('stripped')) k[i] = K_LOG;
      else if (reg.hasTag(id, 'minecraft:leaves')) k[i] = K_LEAF;
      else if (reg.isFullSolid(s) || reg.hasTag(id, 'minecraft:blocks_motion') && !reg.hasTag(id, 'minecraft:replaceable')) k[i] = K_SOLID;
      else k[i] = K_SOFT;
    }
  });
  return k;
}

interface Grid {
  sx: number;
  sy: number;
  sz: number;
  layer: number;
  n: number;
}
function grid(v: BlockVolume): Grid {
  const [sx, sy, sz] = boxSize(v.box);
  return { sx, sy, sz, layer: sx * sz, n: sx * sy * sz };
}

/** 6-neighbour indices of i (−1 for outside) into out[0..5]; returns whether i is on the volume boundary */
function nb6(g: Grid, i: number, out: Int32Array): boolean {
  const x = i % g.sx, z = ((i / g.sx) | 0) % g.sz, y = (i / g.layer) | 0;
  out[0] = x > 0 ? i - 1 : -1;
  out[1] = x < g.sx - 1 ? i + 1 : -1;
  out[2] = z > 0 ? i - g.sx : -1;
  out[3] = z < g.sz - 1 ? i + g.sx : -1;
  out[4] = y > 0 ? i - g.layer : -1;
  out[5] = y < g.sy - 1 ? i + g.layer : -1;
  return x === 0 || z === 0 || y === 0 || x === g.sx - 1 || z === g.sz - 1 || y === g.sy - 1;
}

function* nb26(g: Grid, i: number): Generator<number> {
  const x = i % g.sx, z = ((i / g.sx) | 0) % g.sz, y = (i / g.layer) | 0;
  for (let dy = -1; dy <= 1; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= g.sy) continue;
    for (let dz = -1; dz <= 1; dz++) {
      const zz = z + dz;
      if (zz < 0 || zz >= g.sz) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= g.sx || (dx === 0 && dy === 0 && dz === 0)) continue;
        yield yy * g.layer + zz * g.sx + xx;
      }
    }
  }
}

export function posOf(v: BlockVolume, i: number): Vec3 {
  const sx = v.box.max[0] - v.box.min[0] + 1, sz = v.box.max[2] - v.box.min[2] + 1;
  const x = i % sx, z = ((i / sx) | 0) % sz, y = (i / (sx * sz)) | 0;
  return [v.box.min[0] + x, v.box.min[1] + y, v.box.min[2] + z];
}

/**
 * Natural trees: everything reachable (26-connected over logs, leaves and their attachments such
 * as vines/cocoa/bee nests) from natural leaves (persistent=false), skipping positions edited by
 * this job. `edited(i)` gets the volume index.
 */
export function naturalTreeMask(v: BlockVolume, reg: Registry, edited: (i: number) => boolean): Uint8Array {
  const g = grid(v);
  const kind = classifyPalette(v, reg);
  const attach = new Uint8Array(v.palette.length);
  const natLeaf = new Uint8Array(v.palette.length);
  v.palette.forEach((s, i) => {
    const id = blockId(s).slice(10);
    if (id === 'vine' || id === 'cocoa' || id === 'bee_nest' || id === 'mangrove_roots' || id === 'mangrove_propagule' || id === 'moss_carpet' || id === 'snow' || id === 'glow_lichen' || id === 'pale_hanging_moss') attach[i] = 1;
    if (kind[i] === K_LEAF && propOf(s, 'persistent') !== 'true') natLeaf[i] = 1;
  });
  const out = new Uint8Array(g.n);
  const stack: number[] = [];
  for (let i = 0; i < g.n; i++) {
    if (natLeaf[v.data[i]!] && !edited(i)) {
      out[i] = 1;
      stack.push(i);
    }
  }
  while (stack.length) {
    const i = stack.pop()!;
    for (const j of nb26(g, i)) {
      if (out[j]) continue;
      const p = v.data[j]!;
      const k = kind[p];
      if (k !== K_LOG && k !== K_LEAF && !attach[p]) continue;
      if (k === K_LEAF && !natLeaf[p]) continue; // persistent leaves are someone's build
      if (edited(j)) continue;
      out[j] = 1;
      stack.push(j);
    }
  }
  return out;
}

/** Block counts behind a tree-debris result. */
export interface DebrisResult {
  mask: Uint8Array;
  logs: number;
  leaves: number;
}

/**
 * Tree debris: (1) log groups (26-connected) that touch no ground/structure block and not the
 * volume boundary — branches cut off from their trunk; (2) leaves farther than 6 steps (through
 * leaves, vanilla decay distance) from any remaining log, unless their leaf cluster rests on
 * ground/structure (hedges, bushes) or reaches the volume boundary.
 */
export function treeDebrisMask(v: BlockVolume, reg: Registry): DebrisResult {
  const g = grid(v);
  const kind = classifyPalette(v, reg);
  const K = (i: number) => kind[v.data[i]!]!;
  const mask = new Uint8Array(g.n);
  const seen = new Uint8Array(g.n);
  const n6 = new Int32Array(6);
  let logs = 0, leaves = 0;
  // 1. floating log groups
  for (let s = 0; s < g.n; s++) {
    if (seen[s] || K(s) !== K_LOG) continue;
    const comp: number[] = [s];
    seen[s] = 1;
    let anchored = false;
    for (let q = 0; q < comp.length; q++) {
      const i = comp[q]!;
      if (nb6(g, i, n6)) anchored = true;
      for (let d = 0; d < 6; d++) {
        const j = n6[d]!;
        if (j >= 0 && K(j) === K_SOLID) anchored = true;
      }
      for (const j of nb26(g, i)) {
        if (!seen[j] && K(j) === K_LOG) {
          seen[j] = 1;
          comp.push(j);
        }
      }
    }
    if (!anchored) {
      for (const i of comp) mask[i] = 1;
      logs += comp.length;
    }
  }
  // 2. leaf distance from remaining logs (6-connected through leaves)
  const dist = new Uint8Array(g.n).fill(255);
  let frontier: number[] = [];
  for (let i = 0; i < g.n; i++) if (K(i) === K_LOG && !mask[i]) {
    dist[i] = 0;
    frontier.push(i);
  }
  for (let d = 1; d <= 6 && frontier.length; d++) {
    const next: number[] = [];
    for (const i of frontier) {
      nb6(g, i, n6);
      for (let k = 0; k < 6; k++) {
        const j = n6[k]!;
        if (j < 0 || K(j) !== K_LEAF || dist[j] <= d) continue;
        dist[j] = d;
        next.push(j);
      }
    }
    frontier = next;
  }
  // leaf clusters without any leaf within distance: debris unless anchored
  const lseen = new Uint8Array(g.n);
  for (let s = 0; s < g.n; s++) {
    if (lseen[s] || K(s) !== K_LEAF || dist[s] !== 255) continue;
    const comp: number[] = [s];
    lseen[s] = 1;
    let anchored = false;
    for (let q = 0; q < comp.length; q++) {
      const i = comp[q]!;
      if (nb6(g, i, n6)) anchored = true;
      for (let k = 0; k < 6; k++) {
        const j = n6[k]!;
        if (j < 0) continue;
        const kj = K(j);
        if (kj === K_SOLID) anchored = true;
        if (kj === K_LEAF && !lseen[j] && dist[j] === 255) {
          lseen[j] = 1;
          comp.push(j);
        }
      }
    }
    if (!anchored) {
      for (const i of comp) mask[i] = 1;
      leaves += comp.length;
    }
  }
  return { mask, logs, leaves };
}

export interface FloatingCluster {
  size: number;
  bounds: Box;
  /** most common block id */
  block: string;
  sample: Vec3;
}

/**
 * Floating clusters: 6-connected components of non-air, non-fluid blocks that do not reach the
 * bottom/side boundary of the volume (the terrain and everything standing on it does; unknown
 * beyond the boundary → assumed connected). Leaf-only clusters within 6 blocks of a log are treated as canopy (ignored).
 * Returns clusters sorted by size (small first) — the largest floating mass is reported too
 * (it may be an intentional floating island; the caller decides).
 */
export function findFloating(v: BlockVolume, reg: Registry, opts: { maxClusters?: number; within?: Box } = {}): FloatingCluster[] {
  const g = grid(v);
  const kind = classifyPalette(v, reg);
  const K = (i: number) => kind[v.data[i]!]!;
  const occupied = (k: number) => k === K_LOG || k === K_LEAF || k === K_SOLID || k === K_SOFT;
  // cells within 6 blocks (Chebyshev) of a log, by separable dilation — the canopy rule
  let near: Uint8Array | null = null;
  const nearLog = (i: number): boolean => {
    if (!near) {
      let cur: Uint8Array = new Uint8Array(g.n);
      for (let i2 = 0; i2 < g.n; i2++) if (K(i2) === K_LOG) cur[i2] = 1;
      const R = 6;
      const pass = (src: Uint8Array, stride: number, len: number, coord: (j: number) => number): Uint8Array => {
        const dst = new Uint8Array(g.n);
        for (let j = 0; j < g.n; j++) {
          if (!src[j]) continue;
          const c = coord(j);
          for (let d = -R; d <= R; d++) {
            const cc = c + d;
            if (cc < 0 || cc >= len) continue;
            dst[j + d * stride] = 1;
          }
        }
        return dst;
      };
      cur = pass(cur, 1, g.sx, (j) => j % g.sx);
      cur = pass(cur, g.sx, g.sz, (j) => ((j / g.sx) | 0) % g.sz);
      cur = pass(cur, g.layer, g.sy, (j) => (j / g.layer) | 0);
      near = cur;
    }
    return near[i] === 1;
  };
  const seen = new Uint8Array(g.n);
  const n6 = new Int32Array(6);
  const out: FloatingCluster[] = [];
  const w = opts.within;
  for (let s = 0; s < g.n; s++) {
    if (seen[s] || !occupied(K(s))) continue;
    const comp: number[] = [s];
    seen[s] = 1;
    let grounded = false;
    let onlyLeaves = true;
    for (let q = 0; q < comp.length; q++) {
      const i = comp[q]!;
      const p = v.data[i]!;
      if (kind[p] !== K_LEAF && kind[p] !== K_SOFT) onlyLeaves = false;
      const y = (i / g.layer) | 0;
      const x = i % g.sx, z = ((i / g.sx) | 0) % g.sz;
      if (y === 0 || x === 0 || z === 0 || x === g.sx - 1 || z === g.sz - 1) grounded = true;
      nb6(g, i, n6);
      for (let d = 0; d < 6; d++) {
        const j = n6[d]!;
        if (j < 0 || seen[j] || !occupied(K(j))) continue;
        seen[j] = 1;
        comp.push(j);
      }
      if (comp.length > 200_000) grounded = true; // huge mass: not "small junk"
    }
    if (grounded) continue;
    if (onlyLeaves && comp.some((i) => K(i) === K_LEAF) && comp.some((i) => nearLog(i))) continue;
    const counts = new Map<string, number>();
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    let inside = !w;
    for (const i of comp) {
      const p = posOf(v, i);
      for (let a = 0; a < 3; a++) {
        if (p[a]! < min[a]!) min[a] = p[a]!;
        if (p[a]! > max[a]!) max[a] = p[a]!;
      }
      if (w && !inside && p[0] >= w.min[0] && p[0] <= w.max[0] && p[1] >= w.min[1] && p[1] <= w.max[1] && p[2] >= w.min[2] && p[2] <= w.max[2]) inside = true;
      const id = blockId(v.palette[v.data[i]!]!);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    if (!inside) continue;
    const block = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
    out.push({ size: comp.length, bounds: { min, max }, block, sample: posOf(v, comp[0]!) });
    if (out.length >= (opts.maxClusters ?? 2000)) break;
  }
  return out.sort((a, b) => a.size - b.size);
}
