// Render-box expansion: grow a requested render box so connected parts of the build that the box
// cuts through are shown whole (no half houses / "floating cube" cross-sections at the box edge).
import type { Box, EditBatch } from '../core/types.ts';
import { PosMap } from '../core/posmap.ts';
import { blockId, isAir } from '../core/blockstate.ts';
import { terrainClass } from './scene.ts';

/**
 * Positions that currently hold built (non-air, non-terrain) blocks according to a sequence of edit
 * batches (oldest first; later batches override earlier ones). Terraformed ground, water and plants
 * never count as "the build".
 */
export function builtMask(batches: Iterable<EditBatch>, maxPositions = 3_000_000): PosMap<boolean> {
  const m = new PosMap<boolean>();
  const builtCache = new Map<string, boolean>();
  const isBuilt = (s: string): boolean => {
    let b = builtCache.get(s);
    if (b === undefined) {
      b = !isAir(s) && terrainClass(blockId(s)) === 0;
      builtCache.set(s, b);
    }
    return b;
  };
  for (const bt of batches) {
    const n = bt.states.length;
    for (let i = 0; i < n; i++) {
      const x = bt.positions[3 * i], y = bt.positions[3 * i + 1], z = bt.positions[3 * i + 2];
      if (isBuilt(bt.palette[bt.states[i]])) {
        if (m.size >= maxPositions) return m;
        m.set(x, y, z, true);
      } else m.delete(x, y, z);
    }
  }
  return m;
}

/**
 * Grow `box` to the bounds of every 26-connected component of `built` that has a block inside it,
 * exploring at most `maxExtra` blocks beyond the box on each side (and staying inside `limit`).
 */
export function expandToComponents(box: Box, built: PosMap<boolean>, opts: { maxExtra?: number; limit?: Box; maxVisit?: number } = {}): Box {
  const ext = opts.maxExtra ?? 24;
  let lo = [box.min[0] - ext, box.min[1] - ext, box.min[2] - ext];
  let hi = [box.max[0] + ext, box.max[1] + ext, box.max[2] + ext];
  if (opts.limit) {
    lo = lo.map((v, i) => Math.max(v, opts.limit!.min[i]));
    hi = hi.map((v, i) => Math.min(v, opts.limit!.max[i]));
  }
  const maxVisit = opts.maxVisit ?? 2_000_000;
  const seen = new PosMap<boolean>();
  const stack: number[] = [];
  built.forEach((_v, x, y, z) => {
    if (x >= box.min[0] && x <= box.max[0] && y >= box.min[1] && y <= box.max[1] && z >= box.min[2] && z <= box.max[2]) {
      seen.set(x, y, z, true);
      stack.push(x, y, z);
    }
  });
  const min = [...box.min], max = [...box.max];
  while (stack.length && seen.size < maxVisit) {
    const z = stack.pop()!, y = stack.pop()!, x = stack.pop()!;
    if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
    if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
    if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy, nz = z + dz;
          if (nx < lo[0] || ny < lo[1] || nz < lo[2] || nx > hi[0] || ny > hi[1] || nz > hi[2]) continue;
          if (!built.has(nx, ny, nz) || seen.has(nx, ny, nz)) continue;
          seen.set(nx, ny, nz, true);
          stack.push(nx, ny, nz);
        }
  }
  return { min: [min[0], min[1], min[2]], max: [max[0], max[1], max[2]] };
}

/** terraform materials: re-shaped ground the cutaway may still remove */
const SOIL = new Set([
  'grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium', 'sand', 'red_sand', 'gravel', 'mud', 'clay', 'snow_block', 'stone',
]);

/**
 * Positions the renderer must never cut away: everything this job placed (non-air) except plain
 * terraform soil (grass/dirt/sand/stone fill). Agent-placed andesite, sandstone, terracotta, plants … stay.
 */
export function keepMask(batches: Iterable<EditBatch>, maxPositions = 3_000_000): PosMap<boolean> {
  const m = new PosMap<boolean>();
  const cache = new Map<string, boolean>();
  for (const bt of batches) {
    const n = bt.states.length;
    for (let i = 0; i < n; i++) {
      const s = bt.palette[bt.states[i]];
      let k = cache.get(s);
      if (k === undefined) {
        k = !isAir(s) && !SOIL.has(blockId(s).slice(10));
        cache.set(s, k);
      }
      const x = bt.positions[3 * i], y = bt.positions[3 * i + 1], z = bt.positions[3 * i + 2];
      if (k) {
        if (m.size >= maxPositions) return m;
        m.set(x, y, z, true);
      } else m.delete(x, y, z);
    }
  }
  return m;
}
