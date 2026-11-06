// Rotation & mirroring of positions and block states (structure-template semantics).
// See docs/ENGINE-API.md (core-geometry / transform.ts).
//
// Conventions: QuarterTurns = clockwise when viewed from above (+y): north→east→south→west.
// Mirror 'x' flips the x coordinate (east<->west); mirror 'z' flips z (north<->south).
//
// Property families handled (generic, driven by property names + allowed values, so new
// blocks with the same families work automatically):
//   facing / horizontal_facing (4- or 6-way, hopper's 5-way)   → direction rotated/mirrored
//   axis (x|y|z, nether portal x|z)                            → x<->z on odd turns
//   rotation 0..15 (signs, banners, skulls)                    → +4 per turn; mirror like vanilla Mirror.mirror(rot,16)
//   north/east/south/west (bool, none|low|tall, none|side|up)  → values permuted
//   shape (stairs)  straight|inner_*|outer_*                    → unchanged on rotate; left<->right on every mirror
//   shape (rails)   north_south|east_west|ascending_*|curves    → directions rotated/mirrored
//   hinge (doors)                                              → left<->right on mirror
//   type left|right|single (chests, copper chests)             → left<->right on mirror
//   side_chain left|right (shelves)                            → left<->right on mirror
//   orientation (jigsaw, crafter: 'front_top')                 → both directions transformed
//   face/attachment/half/part/up/down/...                      → unchanged
//
// Deviation from vanilla (deliberate): vanilla StairBlock.mirror only swaps inner/outer
// left/right when the stair faces along the mirror axis; stairs facing across it keep their
// shape, which is geometrically wrong (a mirror always swaps handedness). We always swap,
// so that mirror∘rotate identities hold and mirrored corners look right.
import type { Vec3 } from './types.ts';
import type { Registry } from './registry.ts';
import { formatBlockState, parseBlockState } from './blockstate.ts';

export type QuarterTurns = 0 | 1 | 2 | 3;
export type Dir = 'north' | 'east' | 'south' | 'west' | 'up' | 'down';

const CW: Record<string, string> = { north: 'east', east: 'south', south: 'west', west: 'north', up: 'up', down: 'down' };
const MX: Record<string, string> = { east: 'west', west: 'east', north: 'north', south: 'south', up: 'up', down: 'down' };
const MZ: Record<string, string> = { north: 'south', south: 'north', east: 'east', west: 'west', up: 'up', down: 'down' };

export function rotateDir<T extends string>(d: T, turns: number): T {
  let r: string = d;
  for (let i = 0; i < (((turns % 4) + 4) % 4); i++) r = CW[r] ?? r;
  return r as T;
}
export function mirrorDir<T extends string>(d: T, axis: 'x' | 'z'): T {
  return ((axis === 'x' ? MX : MZ)[d] ?? d) as T;
}

const HORIZ = ['north', 'east', 'south', 'west'] as const;
const STAIR_SHAPES = new Set(['straight', 'inner_left', 'inner_right', 'outer_left', 'outer_right']);
const SWAP_LR: Record<string, string> = {
  left: 'right',
  right: 'left',
  inner_left: 'inner_right',
  inner_right: 'inner_left',
  outer_left: 'outer_right',
  outer_right: 'outer_left',
};

function railShape(shape: string, f: (d: string) => string): string {
  if (shape.startsWith('ascending_')) return 'ascending_' + f(shape.slice(10));
  const parts = shape.split('_');
  if (parts.length !== 2) return shape;
  const a = f(parts[0]);
  const b = f(parts[1]);
  // canonical names: north_south, east_west, south_east, south_west, north_west, north_east
  const set = new Set([a, b]);
  if (set.has('north') && set.has('south')) return 'north_south';
  if (set.has('east') && set.has('west')) return 'east_west';
  const ns = set.has('north') ? 'north' : 'south';
  const ew = set.has('east') ? 'east' : 'west';
  return `${ns}_${ew}`;
}

type Xf = { kind: 'rot'; turns: QuarterTurns } | { kind: 'mirror'; axis: 'x' | 'z' };

function transformProps(props: Record<string, string>, allowed: Record<string, string[]>, xf: Xf): Record<string, string> {
  const dir = xf.kind === 'rot' ? (d: string) => rotateDir(d, xf.turns) : (d: string) => mirrorDir(d, xf.axis);
  const isMirror = xf.kind === 'mirror';
  const out: Record<string, string> = { ...props };
  // north/east/south/west permutation
  if (HORIZ.every((d) => d in props)) {
    for (const d of HORIZ) out[dir(d)] = props[d];
  }
  for (const [k, v] of Object.entries(props)) {
    const vals = allowed[k] ?? [];
    switch (k) {
      case 'facing':
      case 'horizontal_facing':
        out[k] = dir(v);
        break;
      case 'axis':
        if (!isMirror && (xf.turns & 1) && (v === 'x' || v === 'z')) out[k] = v === 'x' ? 'z' : 'x';
        break;
      case 'rotation': {
        const r = Number(v);
        if (!Number.isInteger(r) || vals.length !== 16) break;
        let n: number;
        if (!isMirror) n = (r + 4 * xf.turns) % 16;
        else if (xf.axis === 'x') n = (16 - r) % 16; // vanilla FRONT_BACK
        else n = (24 - r) % 16; // vanilla LEFT_RIGHT
        out[k] = String(n);
        break;
      }
      case 'shape':
        if (STAIR_SHAPES.has(v) && vals.includes('outer_left')) {
          if (isMirror) out[k] = SWAP_LR[v] ?? v;
        } else if (vals.includes('north_south')) {
          const n = railShape(v, dir);
          if (vals.includes(n)) out[k] = n;
        }
        break;
      case 'hinge':
      case 'side_chain':
        if (isMirror && SWAP_LR[v]) out[k] = SWAP_LR[v];
        break;
      case 'type':
        if (isMirror && (v === 'left' || v === 'right') && vals.includes('single')) out[k] = SWAP_LR[v];
        break;
      case 'orientation': {
        const [a, b] = v.split('_');
        if (a && b) {
          const n = `${dir(a)}_${dir(b)}`;
          if (vals.includes(n)) out[k] = n;
        }
        break;
      }
    }
  }
  return out;
}

const rotCache = new WeakMap<Registry, Map<string, string>>();

function cacheFor(reg: Registry): Map<string, string> {
  let m = rotCache.get(reg);
  if (!m) {
    m = new Map();
    rotCache.set(reg, m);
  }
  return m;
}

function applyXf(state: string, xf: Xf, reg: Registry, key: string): string {
  const cache = cacheFor(reg);
  const brace = state.indexOf('{');
  const head = brace >= 0 ? state.slice(0, brace) : state;
  const nbt = brace >= 0 ? state.slice(brace) : '';
  const ck = key + head;
  let out = cache.get(ck);
  if (out === undefined) {
    const canon = reg.canonical(head);
    const p = parseBlockState(canon);
    const info = reg.info(p.name)!;
    if (!Object.keys(p.props).length) out = canon;
    else out = formatBlockState({ name: p.name, props: transformProps(p.props, info.properties, xf) });
    if (cache.size > 200_000) cache.clear();
    cache.set(ck, out);
  }
  return nbt ? out + nbt : out;
}

/** Rotate a block state clockwise (seen from above) by `turns` quarter turns. Returns canonical state. */
export function rotateState(state: string, turns: QuarterTurns, reg: Registry): string {
  const t = ((((turns as number) % 4) + 4) % 4) as QuarterTurns;
  if (t === 0) return reg.canonical(state);
  return applyXf(state, { kind: 'rot', turns: t }, reg, 'r' + t + '|');
}

/** Mirror a block state. axis 'x' flips east<->west, 'z' flips north<->south. Returns canonical state. */
export function mirrorState(state: string, axis: 'x' | 'z', reg: Registry): string {
  return applyXf(state, { kind: 'mirror', axis }, reg, 'm' + axis + '|');
}

/** Rotate a position clockwise (from above) around pivot (default origin). (x,z) → (−z,x) per turn. */
export function rotatePos(v: Vec3, turns: QuarterTurns, pivot: Vec3 = [0, 0, 0]): Vec3 {
  const x = v[0] - pivot[0];
  const z = v[2] - pivot[2];
  let rx: number, rz: number;
  switch (((((turns as number) % 4) + 4) % 4) as QuarterTurns) {
    case 0: rx = x; rz = z; break;
    case 1: rx = -z; rz = x; break;
    case 2: rx = -x; rz = -z; break;
    default: rx = z; rz = -x; break;
  }
  return [rx + pivot[0] + 0, v[1], rz + pivot[2] + 0];
}

/** Mirror a position: axis 'x' flips x around pivot.x, 'z' flips z around pivot.z. */
export function mirrorPos(v: Vec3, axis: 'x' | 'z', pivot: Vec3 = [0, 0, 0]): Vec3 {
  if (axis === 'x') return [2 * pivot[0] - v[0] + 0, v[1], v[2]];
  return [v[0], v[1], 2 * pivot[2] - v[2] + 0];
}
