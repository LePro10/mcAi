// Terrain analysis (ground heights per column) and terraform operations
// (flatten / smooth / raise / lower / naturalize_edges) on top of an EditSession.

import type { Box, WorldBackend } from '../core/types.ts';
import type { Registry } from '../core/registry.ts';
import type { EditSession } from '../core/session.ts';
import { blockId, isAir } from '../core/blockstate.ts';

export interface Columns {
  x0: number;
  z0: number;
  w: number;
  d: number;
  /** y of the top ground block per column (x fastest), or NaN if none in range */
  ground: Float64Array;
  /** top ground block id per column */
  top: string[];
  /** block under the top ground block */
  sub: string[];
  water: Uint8Array;
  veg: Uint8Array;
}

const NATURAL_TOPS = new Set([
  'minecraft:grass_block', 'minecraft:dirt', 'minecraft:coarse_dirt', 'minecraft:podzol', 'minecraft:mycelium',
  'minecraft:sand', 'minecraft:red_sand', 'minecraft:gravel', 'minecraft:snow_block', 'minecraft:stone',
  'minecraft:rooted_dirt', 'minecraft:mud', 'minecraft:clay', 'minecraft:moss_block', 'minecraft:terracotta',
  'minecraft:red_terracotta', 'minecraft:orange_terracotta', 'minecraft:deepslate', 'minecraft:andesite',
  'minecraft:diorite', 'minecraft:granite', 'minecraft:tuff', 'minecraft:calcite', 'minecraft:pale_moss_block',
]);

export function isWater(state: string): boolean {
  const id = blockId(state);
  return id === 'minecraft:water' || id === 'minecraft:bubble_column' || /waterlogged=true/.test(state) && !isGroundId(id);
}

function isGroundId(id: string): boolean {
  return NATURAL_TOPS.has(id);
}

/** Ground = a full solid block that is not part of a tree. */
export function isGround(state: string, reg: Registry): boolean {
  if (isAir(state)) return false;
  const id = blockId(state);
  if (NATURAL_TOPS.has(id)) return true;
  if (reg.hasTag(id, 'minecraft:leaves') || reg.hasTag(id, 'minecraft:logs')) return false;
  if (id.endsWith('_mushroom_block') || id === 'minecraft:mushroom_stem' || id === 'minecraft:bee_nest') return false;
  return reg.isFullSolid(state);
}

export function isVegetation(state: string, reg: Registry): boolean {
  if (isAir(state)) return false;
  const id = blockId(state);
  if (reg.hasTag(id, 'minecraft:leaves') || reg.hasTag(id, 'minecraft:logs')) return true;
  if (reg.hasTag(id, 'minecraft:flowers') || reg.hasTag(id, 'minecraft:saplings') || reg.hasTag(id, 'minecraft:replaceable_by_trees')) return true;
  return /(^|_)(grass|fern|bush|flower|vine|roots|lichen|mushroom|dead_bush|sugar_cane|bamboo|kelp|seagrass|lily_pad|petals|cactus|berry|azalea|dripleaf|moss_carpet|snow)$/.test(id.slice(10)) || id === 'minecraft:snow';
}

/** Default replacement material below a top block. */
export function subFor(top: string): string {
  switch (top) {
    case 'minecraft:sand': return 'minecraft:sandstone';
    case 'minecraft:red_sand': return 'minecraft:red_sandstone';
    case 'minecraft:gravel': return 'minecraft:gravel';
    case 'minecraft:snow_block': return 'minecraft:dirt';
    case 'minecraft:mud': return 'minecraft:mud';
    default: return NATURAL_TOPS.has(top) && /stone|deepslate|andesite|diorite|granite|tuff|calcite|terracotta/.test(top) ? top : 'minecraft:dirt';
  }
}

/** Fetch the y range needed to analyse `foot` (x/z only) and prefetch it into the session. */
export async function prefetchTerrain(backend: WorldBackend, session: EditSession, foot: Box, yMax: number, dimension: string, minY: number): Promise<{ ylo: number; yhi: number }> {
  const hm = await backend.heightmap(foot.min[0], foot.min[2], foot.max[0], foot.max[2], 'surface', dimension);
  let lo = Infinity, hi = -Infinity;
  for (const h of hm.data) {
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  if (!Number.isFinite(lo)) lo = hi = minY;
  // ground can be under trees/water: look up to 40 blocks below the surface minimum
  const ylo = Math.max(minY, lo - 40);
  const yhi = Math.max(hi, yMax);
  await session.prefetch({ min: [foot.min[0], ylo, foot.min[2]], max: [foot.max[0], yhi, foot.max[2]] });
  return { ylo, yhi };
}

export function analyzeColumns(get: (x: number, y: number, z: number) => string, foot: Box, ylo: number, yhi: number, reg: Registry): Columns {
  const w = foot.max[0] - foot.min[0] + 1;
  const d = foot.max[2] - foot.min[2] + 1;
  const n = w * d;
  const cols: Columns = { x0: foot.min[0], z0: foot.min[2], w, d, ground: new Float64Array(n).fill(NaN), top: new Array(n).fill(''), sub: new Array(n).fill(''), water: new Uint8Array(n), veg: new Uint8Array(n) };
  for (let dz = 0; dz < d; dz++) {
    for (let dx = 0; dx < w; dx++) {
      const x = foot.min[0] + dx, z = foot.min[2] + dz, i = dz * w + dx;
      for (let y = yhi; y >= ylo; y--) {
        const s = get(x, y, z);
        if (isAir(s)) continue;
        if (isGround(s, reg)) {
          cols.ground[i] = y;
          cols.top[i] = blockId(s);
          cols.sub[i] = blockId(get(x, y - 1, z));
          break;
        }
        if (isWater(s)) cols.water[i] = 1;
        else if (isVegetation(s, reg)) cols.veg[i] = 1;
      }
    }
  }
  return cols;
}

export interface TerrainStats {
  min: number;
  max: number;
  avg: number;
  median: number;
  waterPct: number;
  vegPct: number;
  tops: [string, number][];
}

export function terrainStats(c: Columns): TerrainStats {
  const hs: number[] = [];
  let water = 0, veg = 0;
  const tops = new Map<string, number>();
  for (let i = 0; i < c.ground.length; i++) {
    const g = c.ground[i]!;
    if (!Number.isNaN(g)) hs.push(g);
    if (c.water[i]) water++;
    if (c.veg[i]) veg++;
    if (c.top[i]) tops.set(c.top[i]!, (tops.get(c.top[i]!) ?? 0) + 1);
  }
  hs.sort((a, b) => a - b);
  const n = c.ground.length || 1;
  return {
    min: hs[0] ?? NaN,
    max: hs[hs.length - 1] ?? NaN,
    avg: hs.length ? Math.round((hs.reduce((a, b) => a + b, 0) / hs.length) * 10) / 10 : NaN,
    median: hs.length ? hs[Math.floor(hs.length / 2)]! : NaN,
    waterPct: Math.round((water / n) * 100),
    vegPct: Math.round((veg / n) * 100),
    tops: [...tops].sort((a, b) => b[1] - a[1]).slice(0, 6),
  };
}

export type TerraformAction = 'flatten' | 'smooth' | 'raise' | 'lower' | 'naturalize_edges';

export interface TerraformParams {
  action: TerraformAction;
  /** footprint (x/z used) in world space */
  foot: Box;
  /** working area (footprint + ring) clipped to the allowed box */
  area: Box;
  allowed: Box;
  y?: number;
  amount?: number;
  radius?: number;
  iterations?: number;
  blend?: number;
  shape?: 'flat' | 'dome';
  width?: number;
  clearAbove?: boolean;
  top?: string;
  fill?: string;
  seed?: number;
}

function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

/** distance (in blocks, chebyshev-ish euclid) of column x,z outside the footprint; 0 inside */
function outsideDist(f: Box, x: number, z: number): number {
  const dx = x < f.min[0] ? f.min[0] - x : x > f.max[0] ? x - f.max[0] : 0;
  const dz = z < f.min[2] ? f.min[2] - z : z > f.max[2] ? z - f.max[2] : 0;
  return Math.sqrt(dx * dx + dz * dz);
}

/** distance of an inside column to the footprint edge (0 on the edge) */
function insideDist(f: Box, x: number, z: number): number {
  return Math.min(x - f.min[0], f.max[0] - x, z - f.min[2], f.max[2] - z);
}

function blur(src: Float64Array, w: number, d: number, r: number): Float64Array {
  const out = new Float64Array(src.length);
  for (let z = 0; z < d; z++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx, zz = z + dz;
          if (xx < 0 || zz < 0 || xx >= w || zz >= d) continue;
          const v = src[zz * w + xx]!;
          if (Number.isNaN(v)) continue;
          s += v;
          n++;
        }
      }
      out[z * w + x] = n ? s / n : src[z * w + x]!;
    }
  }
  return out;
}

function rand(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

export interface TerraformResult {
  columns: number;
  raised: number;
  lowered: number;
  targetY?: number;
  warnings: string[];
}

/**
 * Apply a terraform action. `cols` must cover `p.area`. Writes through `set` (world coords).
 */
export function terraform(
  p: TerraformParams,
  cols: Columns,
  get: (x: number, y: number, z: number) => string,
  set: (x: number, y: number, z: number, s: string) => void,
  reg: Registry,
): TerraformResult {
  const { w, d } = cols;
  const G = cols.ground;
  const T = new Float64Array(G);
  const warnings: string[] = [];
  const f = p.foot;
  const res: TerraformResult = { columns: 0, raised: 0, lowered: 0, warnings };
  const idx = (x: number, z: number) => (z - cols.z0) * w + (x - cols.x0);
  const each = (fn: (x: number, z: number, i: number) => void) => {
    for (let z = p.area.min[2]; z <= p.area.max[2]; z++) for (let x = p.area.min[0]; x <= p.area.max[0]; x++) fn(x, z, idx(x, z));
  };
  const inFoot = (x: number, z: number) => x >= f.min[0] && x <= f.max[0] && z >= f.min[2] && z <= f.max[2];

  switch (p.action) {
    case 'flatten': {
      let target = p.y;
      if (target === undefined) {
        const hs: number[] = [];
        each((x, z, i) => {
          if (inFoot(x, z) && !Number.isNaN(G[i]!)) hs.push(G[i]!);
        });
        hs.sort((a, b) => a - b);
        target = hs.length ? hs[Math.floor(hs.length / 2)]! : p.allowed.min[1];
      }
      res.targetY = target;
      const blend = p.blend ?? 4;
      each((x, z, i) => {
        if (Number.isNaN(G[i]!)) {
          if (inFoot(x, z)) T[i] = target!;
          return;
        }
        if (inFoot(x, z)) T[i] = target!;
        else if (blend > 0) {
          const dist = outsideDist(f, x, z);
          if (dist <= blend) {
            const t = smoothstep(dist / (blend + 1));
            T[i] = target! + (G[i]! - target!) * t;
          }
        }
      });
      break;
    }
    case 'smooth': {
      let cur: Float64Array = G;
      const r = p.radius ?? 2;
      for (let k = 0; k < (p.iterations ?? 2); k++) cur = blur(cur, w, d, r);
      each((x, z, i) => {
        if (inFoot(x, z) && !Number.isNaN(G[i]!)) T[i] = cur[i]!;
      });
      break;
    }
    case 'raise':
    case 'lower': {
      const amt = (p.amount ?? 3) * (p.action === 'lower' ? -1 : 1);
      const cx = (f.min[0] + f.max[0]) / 2, cz = (f.min[2] + f.max[2]) / 2;
      const rx = Math.max(0.5, (f.max[0] - f.min[0] + 1) / 2), rz = Math.max(0.5, (f.max[2] - f.min[2] + 1) / 2);
      each((x, z, i) => {
        if (!inFoot(x, z) || Number.isNaN(G[i]!)) return;
        let k = 1;
        if ((p.shape ?? 'dome') === 'dome') {
          const nx = (x - cx) / rx, nz = (z - cz) / rz;
          const r2 = nx * nx + nz * nz;
          k = r2 >= 1 ? 0 : smoothstep(1 - Math.sqrt(r2));
        }
        T[i] = G[i]! + amt * k;
      });
      break;
    }
    case 'naturalize_edges': {
      const width = p.width ?? 3;
      const sm = blur(blur(G, w, d, 2), w, d, 1);
      each((x, z, i) => {
        if (Number.isNaN(G[i]!)) return;
        const o = outsideDist(f, x, z);
        const ins = inFoot(x, z) ? insideDist(f, x, z) : -1;
        // ring: just outside the footprint (and the outermost inside rows)
        if ((o > 0 && o <= width) || (ins >= 0 && ins < 1)) {
          const t = o > 0 ? 1 - smoothstep(o / (width + 1)) : 0.5;
          T[i] = G[i]! + (sm[i]! - G[i]!) * t;
        }
      });
      break;
    }
  }

  const rnd = rand(p.seed ?? 1);
  const yMin = p.allowed.min[1], yMax = p.allowed.max[1];
  // most common natural top in the area, for columns without one
  const topCount = new Map<string, number>();
  for (const t of cols.top) if (t && NATURAL_TOPS.has(t)) topCount.set(t, (topCount.get(t) ?? 0) + 1);
  const commonTop = [...topCount].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'minecraft:grass_block';

  each((x, z, i) => {
    const g0 = G[i]!;
    const t = Math.round(Math.max(yMin, Math.min(yMax, T[i]!)));
    const g = Number.isNaN(g0) ? yMin - 1 : g0;
    const natural = cols.top[i] && NATURAL_TOPS.has(cols.top[i]!) ? cols.top[i]! : commonTop;
    const top = p.top ?? (natural === 'minecraft:dirt' && p.action === 'naturalize_edges' ? 'minecraft:grass_block' : natural);
    const fill = p.fill ?? subFor(top);
    let changed = false;
    if (t > g) {
      for (let y = Math.max(g + 1, yMin); y <= t; y++) {
        set(x, y, z, y === t ? top : y >= t - 3 ? fill : 'minecraft:stone');
      }
      // bury the old top (grass under dirt looks wrong)
      if (g >= yMin && g < t && (cols.top[i] === 'minecraft:grass_block' || cols.top[i] === 'minecraft:mycelium' || cols.top[i] === 'minecraft:podzol')) set(x, g, z, fill);
      res.raised++;
      changed = true;
    } else if (t < g) {
      for (let y = t + 1; y <= Math.min(g, yMax); y++) set(x, y, z, 'minecraft:air');
      if (t >= yMin) set(x, t, z, top);
      res.lowered++;
      changed = true;
    }
    const surface = Math.max(t, g);
    if (changed || p.action === 'flatten') {
      // remove loose vegetation on top of a changed column
      for (let y = Math.min(t, g) + 1; y <= Math.min(yMax, surface + 2); y++) {
        if (y <= t) continue;
        const s = get(x, y, z);
        if (!isAir(s) && (isVegetation(s, reg) || isWater(s)) && !reg.hasTag(blockId(s), 'minecraft:logs')) set(x, y, z, 'minecraft:air');
      }
    }
    if (p.action === 'flatten' && (p.clearAbove ?? true) && inFoot(x, z)) {
      for (let y = t + 1; y <= yMax; y++) {
        if (!isAir(get(x, y, z))) set(x, y, z, 'minecraft:air');
      }
    }
    if (p.action === 'naturalize_edges') {
      const o = outsideDist(f, x, z);
      const width = p.width ?? 3;
      if (o > 0 && o <= width && t >= yMin) {
        const s = get(x, t, z);
        const above = get(x, t + 1, z);
        if (blockId(s) === 'minecraft:dirt' && isAir(above)) set(x, t, z, 'minecraft:grass_block');
        if ((blockId(s) === 'minecraft:grass_block' || top === 'minecraft:grass_block') && isAir(above) && t + 1 <= yMax) {
          const r = rnd();
          if (r < 0.12) set(x, t + 1, z, 'minecraft:short_grass');
          else if (r < 0.15) set(x, t + 1, z, 'minecraft:fern');
        }
      }
    }
    if (changed) res.columns++;
  });
  if (G.some((g) => Number.isNaN(g))) warnings.push('some columns had no ground in range (void/deep water); they were filled up to the target height');
  return res;
}

/** y of the natural ground block at x,z (skips plants, trees, water); falls back to the surface height. */
export async function groundY(backend: WorldBackend, reg: Registry, x: number, z: number, dimension?: string): Promise<number> {
  const hm = await backend.heightmap(x, z, x, z, 'surface', dimension);
  const top = hm.data[0] ?? 64;
  const info = await backend.info();
  const lo = Math.max(info.minY, top - 48);
  const v = await backend.getBlocks({ min: [x, lo, z], max: [x, top, z] }, dimension);
  for (let y = top; y >= lo; y--) {
    if (isGround(v.palette[v.data[y - lo]!]!, reg)) return y;
  }
  return top;
}
