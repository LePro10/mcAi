// Composite architectural builders that emit finished block states (like roof()):
// bridge (walkable deck with half-slab stepping, rails, posts, piers, suspension ropes,
// lanterns) and slabEdge (projecting fascia rim around a floor plate with a light strip).
// Coordinates/states are in the caller's (local) space; `get` reads the world in that space.

import type { Vec3 } from './types.ts';
import type { Registry } from './registry.ts';
import { RegistryError } from './registry.ts';
import { blockId, isAir } from './blockstate.ts';
import type { StateSink } from './shapes.ts';
import { faceSupport, FULL } from './support.ts';

const r2 = (v: number) => Math.round(v * 2) / 2;

/** matching slab for a full block (oak_planks → oak_slab, stone_bricks → stone_brick_slab, quartz_block → quartz_slab …) */
export function slabFor(reg: Registry, full: string): string | null {
  const id = blockId(full).slice(10);
  if (id.endsWith('_slab')) return `minecraft:${id}`;
  const cands = [
    id.replace(/_planks$/, '_slab'),
    id.replace(/_bricks$/, '_brick_slab'),
    id.replace(/_tiles$/, '_tile_slab'),
    id.replace(/_block$/, '_slab'),
    id.replace(/s$/, '_slab'),
    `${id}_slab`,
    id.replace(/^(waxed_)?(.*)copper$/, '$1$2cut_copper_slab'),
  ];
  for (const c of cands) if (c !== id && reg.has(c) && reg.info(c)?.properties.type) return `minecraft:${c}`;
  return null;
}

/** matching fence for a wood block (spruce_planks/log → spruce_fence), stone → wall, else null */
export function railFor(reg: Registry, full: string): string | null {
  const id = blockId(full).slice(10);
  const wood = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|pale_oak|crimson|warped)_/.exec(id)?.[1];
  if (wood && reg.has(`${wood}_fence`)) return `minecraft:${wood}_fence`;
  const cands = [id.replace(/_bricks$/, '_brick_wall'), id.replace(/_tiles$/, '_tile_wall'), `${id}_wall`, id.replace(/s$/, '_wall')];
  for (const c of cands) if (c !== id && reg.has(c)) return `minecraft:${c}`;
  return null;
}

export interface BridgeParams {
  /** deck surface ends: the block you walk ON at each end is at y-1 … the standing level is y */
  from: Vec3;
  to: Vec3;
  width?: number;
  profile?: 'flat' | 'arch' | 'sag';
  /** arch: rise at the middle (default span/8, kept walkable); sag: drop at the middle (default span/12) */
  rise?: number;
  sag?: number;
  deck: string;
  deckSlab?: string;
  /** rail block (fence/wall); default: matching fence/wall of the deck; false = none */
  rail?: string | false;
  post?: string;
  postEvery?: number;
  /** pier block down to the ground under both deck edges (and the ends) */
  supports?: string;
  supportEvery?: number;
  /** suspension rope block (iron_chain or a fence) with towers at both ends */
  rope?: string;
  ropeHeight?: number;
  lantern?: string;
  lanternEvery?: number;
}

export interface BuildReport {
  warnings: string[];
}

/**
 * Bridge between two standing positions. The deck surface follows the profile, quantised to
 * half blocks: integer heights = full deck blocks, .5 = bottom slabs with a top slab beneath
 * (smooth 1-thick underside); neighbouring cells never differ by more than half a block, so the
 * bridge is walkable without jumping.
 */
export function bridge(p: BridgeParams, reg: Registry, emit: StateSink, get: (x: number, y: number, z: number) => string): BuildReport {
  const warnings: string[] = [];
  const C = (s: string, what: string) => {
    const r = reg.tryCanonical(s);
    if (!r.ok) throw new RegistryError(`bridge ${what}: ${r.error}`);
    return r.state;
  };
  const deck = C(p.deck, 'deck');
  const slabId = p.deckSlab ? blockId(C(p.deckSlab, 'deckSlab')) : slabFor(reg, deck);
  if (!slabId) warnings.push(`no slab found for ${blockId(deck).slice(10)} — deck uses full blocks only (steps may need a jump); pass deckSlab`);
  const slabBottom = slabId ? reg.canonical(`${slabId}[type=bottom]`) : null;
  const slabTop = slabId ? reg.canonical(`${slabId}[type=top]`) : null;
  const rail = p.rail === false ? null : p.rail ? C(p.rail, 'rail') : (() => { const r = railFor(reg, deck); return r ? reg.canonical(r) : null; })();
  const post = p.post ? C(p.post, 'post') : null;
  const support = p.supports ? C(p.supports, 'supports') : null;
  const rope = p.rope ? blockId(C(p.rope, 'rope')) : null;
  const lantern = p.lantern ? C(p.lantern, 'lantern') : null;

  const [x0, y0, z0] = p.from, [x1, y1, z1] = p.to;
  const dx = x1 - x0, dz = z1 - z0;
  const L = Math.hypot(dx, dz);
  if (L < 1) throw new Error('bridge: from and to must be at least 1 block apart horizontally');
  const ux = dx / L, uz = dz / L; // span direction
  const vx = -uz, vz = ux; // perpendicular
  const width = Math.max(1, Math.round(p.width ?? 3));
  const hw = (width - 1) / 2;
  const profile = p.profile ?? 'flat';
  // continuous standing height along the span (s = 0..L)
  const rise = profile === 'arch' ? p.rise ?? Math.max(1, L / 8) : 0;
  const sag = profile === 'sag' ? p.sag ?? Math.max(1, L / 12) : 0;
  const H = (s: number) => {
    const t = s / L;
    const base = y0 + (y1 - y0) * t;
    const bump = 4 * t * (1 - t);
    return base + rise * bump - sag * bump;
  };
  // sample stations every half block along the span and clamp slopes to 0.5 per block
  // one station per block along the span; neighbouring stations differ by at most half a block
  const N = Math.max(1, Math.ceil(L));
  const st = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) st[i] = r2(H((i / N) * L));
  st[0] = y0;
  st[N] = y1;
  if (Math.abs(y1 - y0) > 0.5 * N) warnings.push(`the ends differ by ${Math.abs(y1 - y0)} blocks over a ${N}-block span — too steep to walk with half-slab steps (max ${0.5 * N}); add stairs or move an end`);
  const maxD = 0.5;
  let clamped = false;
  for (let pass = 0; pass < 6; pass++) {
    // keep the end heights; pull inner stations toward their neighbours
    for (let i = 1; i < N; i++) {
      if (st[i]! - st[i - 1]! > maxD) { st[i] = st[i - 1]! + maxD; clamped = true; }
      if (st[i - 1]! - st[i]! > maxD) { st[i] = st[i - 1]! - maxD; clamped = true; }
    }
    for (let i = N - 1; i > 0; i--) {
      if (st[i]! - st[i + 1]! > maxD) { st[i] = st[i + 1]! + maxD; clamped = true; }
      if (st[i + 1]! - st[i]! > maxD) { st[i] = st[i + 1]! - maxD; clamped = true; }
    }
  }
  if (clamped && profile !== 'flat') warnings.push('profile flattened to stay walkable (max half a block per block); lower rise/sag or lengthen the span');
  const heightAt = (s: number) => st[Math.max(0, Math.min(N, Math.round((s / L) * N)))]!;

  // cells: rasterize the footprint
  const minX = Math.floor(Math.min(x0, x1) - hw - 1), maxX = Math.ceil(Math.max(x0, x1) + hw + 1);
  const minZ = Math.floor(Math.min(z0, z1) - hw - 1), maxZ = Math.ceil(Math.max(z0, z1) + hw + 1);
  const out = new Map<string, [number, number, number, string]>();
  const put = (x: number, y: number, z: number, s: string) => out.set(`${x},${y},${z}`, [x, y, z, s]);
  const spanAxis = Math.abs(ux) >= Math.abs(uz) ? 'x' : 'z';
  interface Cell { x: number; z: number; s: number; t: number; T: number; edge: boolean }
  const cells: Cell[] = [];
  for (let z = minZ; z <= maxZ; z++)
    for (let x = minX; x <= maxX; x++) {
      const rx = x - x0, rz = z - z0;
      const s = rx * ux + rz * uz;
      const t = rx * vx + rz * vz;
      if (s < -0.5 || s > L + 0.5 || Math.abs(t) > hw + 0.5) continue;
      const sc = Math.max(0, Math.min(L, s));
      cells.push({ x, z, s: sc, t, T: heightAt(sc), edge: Math.abs(t) > hw - 0.5 });
    }
  const railY = new Map<string, number>();
  for (const c of cells) {
    const T = c.T;
    const k = Math.floor(T);
    const half = T - k >= 0.25;
    if (c.edge && rail && width >= 2) {
      // rail sits where the deck is: on the full block (y=k) or replacing the slab (y=k)
      if (half) {
        if (slabTop) put(c.x, k - 1, c.z, slabTop);
        else put(c.x, k, c.z, deck);
      } else put(c.x, k - 1, c.z, deck);
      put(c.x, k, c.z, rail);
      railY.set(`${c.x},${c.z}`, k);
      continue;
    }
    if (half && slabBottom) {
      put(c.x, k, c.z, slabBottom);
      if (slabTop) put(c.x, k - 1, c.z, slabTop);
    } else put(c.x, Math.round(T) - 1, c.z, deck);
  }

  // diagonal spans: rail cells that only touch at a corner get a connector so fences link up (4-connected)
  if (rail && width >= 2) {
    for (const side of [-1, 1]) {
      const rc = cells.filter((c) => c.edge && Math.sign(c.t) === side).sort((a, b) => a.s - b.s);
      for (let i = 1; i < rc.length; i++) {
        const a = rc[i - 1]!, c = rc[i]!;
        if (Math.abs(a.x - c.x) !== 1 || Math.abs(a.z - c.z) !== 1) continue;
        const cand = [[c.x, a.z], [a.x, c.z]].map(([x, z]) => ({ x: x!, z: z!, t: (x! - x0) * vx + (z! - z0) * vz }));
        if (cand.some((q) => railY.has(`${q.x},${q.z}`))) continue;
        const q = cand.sort((u, v) => side * v.t - side * u.t)[0]!; // the outer one
        const ry = Math.min(railY.get(`${a.x},${a.z}`) ?? Math.floor(a.T), railY.get(`${c.x},${c.z}`) ?? Math.floor(c.T));
        const T = Math.min(a.T, c.T);
        const k = Math.floor(T);
        if (T - k >= 0.25) {
          if (slabTop) put(q.x, k - 1, q.z, slabTop);
        } else put(q.x, k - 1, q.z, deck);
        put(q.x, ry, q.z, rail);
        railY.set(`${q.x},${q.z}`, ry);
      }
    }
  }

  // posts / lanterns along both rails
  const postEvery = Math.max(2, Math.round(p.postEvery ?? 4));
  const lanternEvery = Math.max(postEvery, Math.round(p.lanternEvery ?? postEvery * 2));
  const edgeCells = cells.filter((c) => c.edge);
  const atStation = (c: Cell, every: number) => {
    const sr = Math.round(c.s);
    return Math.abs(c.s - sr) < 0.5 && (sr % every === 0 || sr === Math.round(L));
  };
  const seenPost = new Set<string>();
  for (const c of edgeCells) {
    if (!(post || lantern || rope)) break;
    if (!atStation(c, postEvery)) continue;
    const key = `${Math.round(c.s)},${Math.sign(c.t)}`;
    if (seenPost.has(key)) continue;
    seenPost.add(key);
    const ry = railY.get(`${c.x},${c.z}`) ?? Math.floor(c.T);
    let top = ry;
    if (post) {
      put(c.x, ry, c.z, post);
      put(c.x, ry + 1, c.z, post);
      top = ry + 1;
    }
    if (lantern && atStation(c, lanternEvery) && !(rope && (Math.round(c.s) === 0 || Math.round(c.s) === Math.round(L)))) put(c.x, top + 1, c.z, lantern);
  }

  // suspension ropes: towers at both ends of each rail, a sagging rope between, hangers every 2
  if (rope && width >= 2) {
    const ropeH = Math.max(3, Math.round(p.ropeHeight ?? 5));
    const wood = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_/.exec(blockId(deck).slice(10))?.[1];
    const towerBlock = post ?? (wood && reg.has(`stripped_${wood}_log`) ? reg.canonical(`stripped_${wood}_log[axis=y]`) : deck);
    for (const side of [-1, 1]) {
      const sideCells = edgeCells.filter((c) => Math.sign(c.t) === side || (side === 1 && c.t === 0 && width === 1));
      if (!sideCells.length) continue;
      const byS = new Map<number, Cell>();
      for (const c of sideCells) {
        const sr = Math.round(c.s);
        const prev = byS.get(sr);
        if (!prev || Math.abs(Math.abs(c.t) - hw) < Math.abs(Math.abs(prev.t) - hw)) byS.set(sr, c);
      }
      const ss = [...byS.keys()].sort((a, b) => a - b);
      const sA = ss[0]!, sB = ss[ss.length - 1]!;
      const cA = byS.get(sA)!, cB = byS.get(sB)!;
      const yA = (railY.get(`${cA.x},${cA.z}`) ?? Math.floor(cA.T)) + ropeH;
      const yB = (railY.get(`${cB.x},${cB.z}`) ?? Math.floor(cB.T)) + ropeH;
      for (const [c, ytop] of [[cA, yA], [cB, yB]] as const) {
        const ry = railY.get(`${c.x},${c.z}`) ?? Math.floor(c.T);
        for (let y = ry; y <= ytop; y++) put(c.x, y, c.z, towerBlock);
        if (lantern) put(c.x, ytop + 1, c.z, lantern);
      }
      let prevY: number | null = null;
      for (const sr of ss) {
        const c = byS.get(sr)!;
        if (sr === sA || sr === sB) {
          prevY = sr === sA ? yA : yB;
          continue;
        }
        const t = (sr - sA) / Math.max(1, sB - sA);
        const ry = railY.get(`${c.x},${c.z}`) ?? Math.floor(c.T);
        const low = ry + 1;
        const lin = yA + (yB - yA) * t;
        const yr = Math.max(low, Math.round(lin - (lin - low) * 4 * t * (1 - t)));
        const ropeState = (vertical: boolean) => (rope.endsWith('chain') ? reg.canonical(`${rope}[axis=${vertical ? 'y' : spanAxis}]`) : reg.canonical(rope));
        // keep the rope continuous: a vertical run at the column where the height changes
        if (prevY !== null && prevY !== yr) {
          const dir = prevY > yr ? 1 : -1;
          for (let y = yr + dir; y !== prevY + dir; y += dir) put(c.x, y, c.z, ropeState(true));
        }
        put(c.x, yr, c.z, ropeState(prevY !== null && prevY !== yr));
        if ((sr - sA) % 2 === 0) for (let y = ry + 1; y < yr; y++) put(c.x, y, c.z, ropeState(true));
        prevY = yr;
      }
    }
  }

  // piers under both edges every supportEvery (and at both ends) down to the ground
  if (support) {
    const every = Math.max(2, Math.round(p.supportEvery ?? 6));
    const seen = new Set<string>();
    for (const c of edgeCells.length ? edgeCells : cells) {
      if (!atStation(c, every)) continue;
      const key = `${c.x},${c.z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const k = Math.floor(c.T);
      const half = c.T - k >= 0.25;
      let y = (half ? k - 1 : k - 1) - 1;
      for (let d = 0; d < 48; d++, y--) {
        const s = get(c.x, y, c.z);
        if (!isAir(s) && !/water|lava|seagrass|kelp|bubble_column|short_grass|fern|_flower|tall_grass|snow$/.test(blockId(s)) && !reg.hasTag(blockId(s), 'minecraft:replaceable')) break;
        if (!out.has(`${c.x},${y},${c.z}`)) put(c.x, y, c.z, support);
      }
    }
  }
  const sorted = [...out.values()].sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0] - b[0]);
  for (const [x, y, z, s] of sorted) emit(x, y, z, s);
  return { warnings };
}

export interface SlabEdgeParams {
  /** floor plate footprint (x/z); y = the plate's top block layer */
  box: { min: Vec3; max: Vec3 };
  block: string;
  /** rim width beyond the plate (default 1) */
  overhang?: number;
  /** 'top' slab (flush with the floor, thin modern edge; default), 'bottom' slab, or 'full' blocks */
  half?: 'top' | 'bottom' | 'full';
  /** light strip block (sea_lantern, ochre_froglight, end_rod, …) */
  light?: string;
  /** 'under' the outer rim (soffit strip, default) or 'inline' replacing rim blocks */
  lightAt?: 'under' | 'inline';
  lightEvery?: number;
}

/** Projecting rim (fascia) around a floor plate, optional light strip under/inside it. */
export function slabEdge(p: SlabEdgeParams, reg: Registry, emit: StateSink): BuildReport {
  const warnings: string[] = [];
  const b = p.box;
  const y = b.max[1];
  const o = Math.max(1, Math.round(p.overhang ?? 1));
  const half = p.half ?? 'top';
  const base = reg.tryCanonical(p.block);
  if (!base.ok) throw new RegistryError(`slab_edge block: ${base.error}`);
  let rim = base.state;
  if (half !== 'full') {
    const sl = slabFor(reg, rim);
    if (sl) rim = reg.canonical(`${sl}[type=${half}]`);
    else warnings.push(`no slab for ${blockId(rim).slice(10)} — using full blocks`);
  }
  let light: string | null = null;
  if (p.light) {
    const l = reg.tryCanonical(p.light);
    if (!l.ok) throw new RegistryError(`slab_edge light: ${l.error}`);
    light = l.state;
    if (blockId(light) === 'minecraft:end_rod') light = reg.canonical('end_rod[facing=down]');
  }
  const every = Math.max(1, Math.round(p.lightEvery ?? 1));
  const x0 = b.min[0] - o, x1 = b.max[0] + o, z0 = b.min[2] - o, z1 = b.max[2] + o;
  let k = 0;
  for (let z = z0; z <= z1; z++)
    for (let x = x0; x <= x1; x++) {
      const inside = x >= b.min[0] && x <= b.max[0] && z >= b.min[2] && z <= b.max[2];
      if (inside) continue;
      const outer = x === x0 || x === x1 || z === z0 || z === z1;
      const lit = light && outer && k++ % every === 0;
      if (lit && (p.lightAt ?? 'under') === 'inline') emit(x, y, z, light!);
      else emit(x, y, z, rim);
      if (lit && (p.lightAt ?? 'under') === 'under') emit(x, y - 1, z, light!);
    }
  return { warnings };
}

export interface VinesParams {
  box: { min: Vec3; max: Vec3 };
  /** 0..1 share of wall columns that get vines (default 0.35); clumped by noise */
  density?: number;
  /** 'hang' from the top of walls / under eaves (default), 'grow' up from the ground, or 'both' */
  from?: 'hang' | 'grow' | 'both';
  /** max strand length (default 6) */
  length?: number;
  /** only on exterior faces (default true): cells reachable from outside and open to the sky or the outside */
  onlyOutside?: boolean;
  /** 'vine' (default) or 'glow_lichen' / 'sculk_vein' style multiface blocks */
  block?: string;
  seed?: number;
}

/**
 * Vines on wall faces inside `box`: every placed vine has a full solid face behind it (faces set
 * automatically) or hangs from the vine above, so the support check keeps them. Exterior
 * detection = air reachable from the box boundary (through air/plants only) that either sees the
 * sky or has a sky-lit cell within 3 steps straight away from its wall (under eaves).
 */
export function vines(p: VinesParams, reg: Registry, emit: StateSink, get: (x: number, y: number, z: number) => string): BuildReport {
  const warnings: string[] = [];
  const b = p.box;
  const [x0, y0, z0] = [b.min[0] - 1, b.min[1] - 1, b.min[2] - 1];
  const [x1, y1, z1] = [b.max[0] + 1, b.max[1] + 1, b.max[2] + 1];
  const sx = x1 - x0 + 1, sy = y1 - y0 + 1, sz = z1 - z0 + 1;
  if (sx * sy * sz > 4_000_000) throw new Error('vines: box too large (max ~4M cells) — split it');
  const blockId0 = blockId(reg.canonical(p.block ?? 'vine'));
  const multiface = reg.info(blockId0)?.properties.north !== undefined;
  if (!multiface) throw new Error(`vines: block must be a multiface block like vine or glow_lichen, got ${blockId0}`);
  const isVine = blockId0 === 'minecraft:vine';
  const density = Math.max(0, Math.min(1, p.density ?? 0.35));
  const maxLen = Math.max(1, Math.round(p.length ?? 6));
  const mode = p.from ?? 'hang';
  const idx = (x: number, y: number, z: number) => ((y - y0) * sz + (z - z0)) * sx + (x - x0);
  const state = new Array<string>(sx * sy * sz);
  const open = new Uint8Array(sx * sy * sz); // 1 = air/plant (passable)
  for (let y = y0; y <= y1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        const s = get(x, y, z);
        const i = idx(x, y, z);
        state[i] = s;
        const id = blockId(s);
        open[i] = isAir(s) || (reg.hasTag(id, 'minecraft:replaceable') && !/water|lava|bubble/.test(id)) || reg.hasTag(id, 'minecraft:flowers') && !reg.hasTag(id, 'minecraft:leaves') ? 1 : 0;
      }
  // flood fill from the boundary
  const outside = new Uint8Array(sx * sy * sz);
  const stack: number[] = [];
  for (let y = y0; y <= y1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        if (x !== x0 && x !== x1 && y !== y0 && y !== y1 && z !== z0 && z !== z1) continue;
        const i = idx(x, y, z);
        if (open[i] && !outside[i]) {
          outside[i] = 1;
          stack.push(i);
        }
      }
  const layer = sx * sz;
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % sx, z = ((i / sx) | 0) % sz, y = (i / layer) | 0;
    const nb = [x > 0 ? i - 1 : -1, x < sx - 1 ? i + 1 : -1, z > 0 ? i - sx : -1, z < sz - 1 ? i + sx : -1, y > 0 ? i - layer : -1, y < sy - 1 ? i + layer : -1];
    for (const j of nb) if (j >= 0 && open[j] && !outside[j]) { outside[j] = 1; stack.push(j); }
  }
  const DIRS: [HDirName, number, number][] = [['north', 0, -1], ['south', 0, 1], ['east', 1, 0], ['west', -1, 0]];
  const coveredAbove = new Map<number, boolean>(); // column covered above the box (roofs reaching higher)
  const sky = (x: number, y: number, z: number) => {
    for (let yy = y + 1; yy <= y1; yy++) if (!open[idx(x, yy, z)]) return false;
    const k = (x - x0) * 65536 + (z - z0);
    let c = coveredAbove.get(k);
    if (c === undefined) {
      c = false;
      for (let yy = y1 + 1; yy <= y1 + 32; yy++) {
        const st = get(x, yy, z);
        if (!isAir(st) && !reg.hasTag(blockId(st), 'minecraft:replaceable')) { c = true; break; }
      }
      coveredAbove.set(k, c);
    }
    return !c;
  };
  /** an open cell with sky access within 3 steps straight away from the wall (eaves, porches) */
  const freeAway = (x: number, y: number, z: number, dx: number, dz: number) => {
    for (let k = 1; k <= 3; k++) {
      const xx = x - dx * k, zz = z - dz * k;
      if (xx < x0 || xx > x1 || zz < z0 || zz > z1) return true;
      if (!open[idx(xx, y, zz)]) return false;
      if (sky(xx, y, zz)) return true;
    }
    return false;
  };
  /** faces of a vine at (x,y,z) with a full wall behind, honouring onlyOutside */
  const faces = (x: number, y: number, z: number): string[] => {
    const i = idx(x, y, z);
    if (!open[i] || !isAir(state[i]!)) return [];
    if ((p.onlyOutside ?? true) && !outside[i]) return [];
    // doorways / window gaps (walls on two opposite sides) stay free
    const solidAt = (dx: number, dz: number) => !open[idx(x + dx, y, z + dz)];
    if ((solidAt(1, 0) && solidAt(-1, 0)) || (solidAt(0, 1) && solidAt(0, -1))) return [];
    const out: string[] = [];
    for (const [d, dx, dz] of DIRS) {
      const n = state[idx(x + dx, y, z + dz)]!;
      if (faceSupport(n, OPP[d], reg) < FULL) continue;
      if ((p.onlyOutside ?? true) && !sky(x, y, z) && !freeAway(x, y, z, dx, dz)) continue;
      out.push(d);
    }
    return out;
  };
  // deterministic hash noise for clumped columns
  let seed = (p.seed ?? 1) >>> 0;
  const hash = (x: number, z: number, k: number) => {
    let h = (x * 374761393 + z * 668265263 + k * 2246822519 + seed * 3266489917) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const clump = (x: number, z: number) => (hash(Math.floor(x / 3), Math.floor(z / 3), 7) * 0.6 + hash(x, z, 9) * 0.4);
  const placed = new Set<string>();
  let strands = 0;
  const put = (x: number, y: number, z: number, fs: string[]) => {
    const props = ['east', 'north', 'south', 'west'].map((d) => `${d}=${fs.includes(d)}`).join(',');
    const st = isVine ? reg.canonical(`vine[${props},up=false]`) : reg.canonical(`${blockId0}[${props},down=false,up=false]`);
    emit(x, y, z, st);
    placed.add(`${x},${y},${z}`);
  };
  for (let z = b.min[2]; z <= b.max[2]; z++)
    for (let x = b.min[0]; x <= b.max[0]; x++) {
      if (clump(x, z) > density) continue;
      const len = 1 + Math.floor(hash(x, z, 3) * maxLen);
      if (mode === 'hang' || mode === 'both') {
        // start right under a non-candidate (wall top, eave) and hang down
        for (let y = b.max[1]; y >= b.min[1]; y--) {
          const fs = faces(x, y, z);
          if (!fs.length || faces(x, y + 1, z).length) continue;
          let k = 0;
          for (let yy = y; yy >= b.min[1] && k < len; yy--, k++) {
            const f2 = k === 0 ? fs : faces(x, yy, z).filter((d) => fs.includes(d));
            const keep = isVine ? (f2.length ? f2 : fs) : f2;      // vines may hang free under a vine
            if (!keep.length || !isAir(state[idx(x, yy, z)]!) || (!f2.length && !isVine)) break;
            if (!f2.length && yy < y - 1 && hash(x, z, 11 + k) < 0.5) break;
            put(x, yy, z, keep);
          }
          strands++;
          break;
        }
      }
      if (mode === 'grow' || mode === 'both') {
        for (let y = b.min[1]; y <= b.max[1]; y++) {
          const fs = faces(x, y, z);
          if (!fs.length || faces(x, y - 1, z).length) continue;
          let k = 0;
          for (let yy = y; yy <= b.max[1] && k < len; yy++, k++) {
            const f2 = faces(x, yy, z);
            if (!f2.length) break;
            if (!placed.has(`${x},${yy},${z}`)) put(x, yy, z, f2);
          }
          strands++;
          break;
        }
      }
    }
  if (!strands) warnings.push('no exterior wall faces found for vines in this box (needs full blocks with air beside them; onlyOutside:false to include interiors)');
  return { warnings };
}

type HDirName = 'north' | 'south' | 'east' | 'west';
const OPP: Record<HDirName, HDirName> = { north: 'south', south: 'north', east: 'west', west: 'east' };
