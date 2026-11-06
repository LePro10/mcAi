// Block patterns: what to place at each position. Deterministic: random choices come from a
// hash of (x, y, z, seed), never from iteration order. Every referenced block is
// canonicalized once at compile time (errors mention the bad entry).
// See docs/ENGINE-API.md (pattern.ts / mask.ts).
import type { Box } from './types.ts';
import type { Registry } from './registry.ts';

export type PatternSpec =
  | string
  | { block: string; weight?: number }[]
  | { type: 'gradient'; axis: 'x' | 'y' | 'z'; stops: string[]; dither?: boolean; from?: number; to?: number }
  | { type: 'noise'; scale?: number; blocks: string[]; seed?: number }
  | { type: 'checker' | 'stripes'; blocks: string[]; size?: number; axis?: 'x' | 'y' | 'z' };

/** returns a canonical block state, or null = leave the position unchanged */
export type PatternFn = (x: number, y: number, z: number) => string | null;

export class PatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatternError';
  }
}

// ---------------------------------------------------------------------------------------
// hashing / noise

/** 32-bit avalanche hash of integer coordinates + seed → [0, 1) */
export function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (seed | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (x | 0), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ (y | 0), 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h ^ (z | 0), 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** mulberry32 seeded PRNG */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GRAD = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1],
  [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

function gradDot(ix: number, iy: number, iz: number, seed: number, dx: number, dy: number, dz: number): number {
  const g = GRAD[Math.floor(hash3(ix, iy, iz, seed) * 12)];
  return g[0] * dx + g[1] * dy + g[2] * dz;
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** 3D gradient (Perlin) noise, roughly in [-1, 1] */
export function perlin3(x: number, y: number, z: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const fx = x - x0, fy = y - y0, fz = z - z0;
  const u = fade(fx), v = fade(fy), w = fade(fz);
  const n000 = gradDot(x0, y0, z0, seed, fx, fy, fz);
  const n100 = gradDot(x0 + 1, y0, z0, seed, fx - 1, fy, fz);
  const n010 = gradDot(x0, y0 + 1, z0, seed, fx, fy - 1, fz);
  const n110 = gradDot(x0 + 1, y0 + 1, z0, seed, fx - 1, fy - 1, fz);
  const n001 = gradDot(x0, y0, z0 + 1, seed, fx, fy, fz - 1);
  const n101 = gradDot(x0 + 1, y0, z0 + 1, seed, fx - 1, fy, fz - 1);
  const n011 = gradDot(x0, y0 + 1, z0 + 1, seed, fx, fy - 1, fz - 1);
  const n111 = gradDot(x0 + 1, y0 + 1, z0 + 1, seed, fx - 1, fy - 1, fz - 1);
  const nx00 = n000 + u * (n100 - n000);
  const nx10 = n010 + u * (n110 - n010);
  const nx01 = n001 + u * (n101 - n001);
  const nx11 = n011 + u * (n111 - n011);
  const nxy0 = nx00 + v * (nx10 - nx00);
  const nxy1 = nx01 + v * (nx11 - nx01);
  return nxy0 + w * (nxy1 - nxy0);
}

/** two-octave fBm of perlin3 */
export function fbm3(x: number, y: number, z: number, seed: number): number {
  return perlin3(x, y, z, seed) * 0.7 + perlin3(x * 2.03 + 17.1, y * 2.03 - 5.3, z * 2.03 + 9.7, seed ^ 0x5bd1e995) * 0.3;
}

// quantile table so that noise values map to (approximately) uniform [0,1)
let QUANT: Float64Array | null = null;
function quantiles(): Float64Array {
  if (QUANT) return QUANT;
  const rnd = mulberry32(12345);
  const n = 20000;
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = fbm3(rnd() * 1000, rnd() * 1000, rnd() * 1000, 777);
  s.sort();
  const q = new Float64Array(257);
  for (let i = 0; i <= 256; i++) q[i] = s[Math.min(n - 1, Math.floor((i * (n - 1)) / 256))];
  QUANT = q;
  return q;
}

/** fBm noise remapped to approximately uniform [0, 1) */
export function uniformNoise3(x: number, y: number, z: number, seed: number): number {
  const q = quantiles();
  const v = fbm3(x, y, z, seed);
  let lo = 0, hi = 256;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (q[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  if (lo <= 0) return 0;
  if (lo >= 256) return 0.999999;
  const a = q[lo - 1], b = q[lo];
  const f = b > a ? (v - a) / (b - a) : 0;
  return Math.min(0.999999, (lo - 1 + f) / 256);
}

// 4x4 Bayer matrix thresholds in (0,1)
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const bayer = (u: number, v: number) => BAYER4[((v & 3) << 2) | (u & 3)];

// ---------------------------------------------------------------------------------------
// parsing helpers

/** split at top-level commas (ignores commas inside [...] and {...}) */
export function splitTopLevel(s: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") {
      if (depth > 0) quote = c;
    } else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === sep && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter((x) => x.length > 0);
}

const WEIGHT_RE = /^(\d+(?:\.\d+)?)\s*(%|\*)\s*(.+)$/s;

function canon(reg: Registry, block: string, where: string): string | null {
  const b = block.trim();
  if (b === 'keep') return null;
  const r = reg.tryCanonical(b);
  if (!r.ok) throw new PatternError(`${where} "${b}": ${r.error}`);
  return r.state;
}

interface Weighted {
  fn: PatternFn;
  weight: number;
}

function compileWeighted(items: Weighted[], seed: number): PatternFn {
  if (items.length === 1) return items[0].fn;
  const total = items.reduce((a, b) => a + b.weight, 0);
  if (!(total > 0)) throw new PatternError('pattern weights must sum to more than 0');
  const cum = new Float64Array(items.length);
  let acc = 0;
  for (let i = 0; i < items.length; i++) {
    acc += items[i].weight / total;
    cum[i] = acc;
  }
  cum[items.length - 1] = 1.0000001;
  const fns = items.map((i) => i.fn);
  return (x, y, z) => {
    const r = hash3(x, y, z, seed);
    let i = 0;
    while (r >= cum[i]) i++;
    return fns[i](x, y, z);
  };
}

const constFn = (s: string | null): PatternFn => () => s;

function compileString(spec: string, reg: Registry, seed: number, where: string): PatternFn {
  const parts = splitTopLevel(spec);
  if (!parts.length) throw new PatternError(`${where}: empty pattern`);
  if (parts.length === 1 && !WEIGHT_RE.test(parts[0])) return constFn(canon(reg, parts[0], where));
  const items: Weighted[] = parts.map((p) => {
    const m = WEIGHT_RE.exec(p);
    const weight = m ? Number(m[1]) : 1;
    const block = m ? m[3] : p;
    if (!(weight >= 0)) throw new PatternError(`${where}: bad weight in "${p}"`);
    return { fn: constFn(canon(reg, block, where)), weight };
  });
  return compileWeighted(items.filter((i) => i.weight > 0), seed);
}

function subPatterns(list: unknown, reg: Registry, seed: number, where: string): PatternFn[] {
  if (!Array.isArray(list) || !list.length) throw new PatternError(`${where}: needs a non-empty list of blocks`);
  return list.map((b, i) => {
    if (typeof b !== 'string') throw new PatternError(`${where}[${i}]: expected a block string`);
    return compileString(b, reg, (seed + Math.imul(i + 1, 0x632be5ab)) | 0, `${where}[${i}]`);
  });
}

const AXIS_I = { x: 0, y: 1, z: 2 } as const;

/**
 * Compile a pattern. opts.bounds is needed for gradients (unless `from`/`to` are given);
 * coordinates passed to the returned function are the ones the caller uses (the DSL uses
 * local build coordinates).
 */
export function compilePattern(spec: PatternSpec, reg: Registry, opts: { seed?: number; bounds?: Box } = {}): PatternFn {
  const seed = (opts.seed ?? 0) | 0;
  if (typeof spec === 'string') return compileString(spec, reg, seed, 'pattern');
  if (Array.isArray(spec)) {
    if (!spec.length) throw new PatternError('pattern: empty block list');
    const items: Weighted[] = spec.map((e, i) => {
      if (!e || typeof e !== 'object' || typeof (e as any).block !== 'string')
        throw new PatternError(`pattern[${i}]: expected {block: string, weight?: number}`);
      const w = (e as any).weight ?? 1;
      if (typeof w !== 'number' || !(w >= 0)) throw new PatternError(`pattern[${i}]: weight must be a number >= 0`);
      return { fn: compileString((e as any).block, reg, (seed + Math.imul(i + 1, 0x7feb352d)) | 0, `pattern[${i}]`), weight: w };
    });
    return compileWeighted(items.filter((i) => i.weight > 0), seed);
  }
  if (!spec || typeof spec !== 'object') throw new PatternError('pattern: expected a string, a list or an object with "type"');
  const s = spec as any;
  switch (s.type) {
    case 'gradient': {
      const ai = AXIS_I[s.axis as 'x' | 'y' | 'z'];
      if (ai === undefined) throw new PatternError(`gradient: axis must be x, y or z (got ${s.axis})`);
      const stops = subPatterns(s.stops, reg, seed, 'gradient.stops');
      let lo: number, hi: number;
      if (typeof s.from === 'number' && typeof s.to === 'number') {
        lo = s.from;
        hi = s.to;
      } else if (opts.bounds) {
        lo = opts.bounds.min[ai];
        hi = opts.bounds.max[ai];
      } else throw new PatternError('gradient: needs bounds (give "from"/"to" along the axis)');
      const n = stops.length;
      const span = hi - lo;
      const dither = !!s.dither;
      const ua = ai === 0 ? 2 : 0; // the two other axes, for the dither matrix
      const va = ai === 1 ? 2 : 1;
      const c = [0, 0, 0];
      return (x, y, z) => {
        c[0] = x; c[1] = y; c[2] = z;
        let t = span === 0 ? 0 : (c[ai] - lo) / span;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        let idx: number;
        if (dither && n > 1) {
          const f = t * (n - 1);
          const i0 = Math.floor(f);
          idx = i0 + (f - i0 > bayer(c[ua], c[va]) ? 1 : 0);
        } else idx = Math.floor(t * n);
        if (idx >= n) idx = n - 1;
        return stops[idx](x, y, z);
      };
    }
    case 'noise': {
      const blocks = subPatterns(s.blocks, reg, seed, 'noise.blocks');
      const scale = s.scale ?? 6;
      if (typeof scale !== 'number' || !(scale > 0)) throw new PatternError('noise: scale must be > 0');
      const nseed = ((s.seed ?? seed) | 0) ^ 0x1b873593;
      const n = blocks.length;
      const inv = 1 / scale;
      return (x, y, z) => {
        const v = uniformNoise3(x * inv + 0.37, y * inv + 0.71, z * inv + 0.13, nseed);
        return blocks[Math.min(n - 1, Math.floor(v * n))](x, y, z);
      };
    }
    case 'checker':
    case 'stripes': {
      const blocks = subPatterns(s.blocks, reg, seed, `${s.type}.blocks`);
      const size = s.size ?? 1;
      if (!Number.isInteger(size) || size < 1) throw new PatternError(`${s.type}: size must be an integer >= 1`);
      const n = blocks.length;
      const mod = (v: number) => ((v % n) + n) % n;
      if (s.type === 'stripes') {
        const ai = AXIS_I[(s.axis ?? 'y') as 'x' | 'y' | 'z'];
        if (ai === undefined) throw new PatternError(`stripes: axis must be x, y or z`);
        return (x, y, z) => {
          const c = ai === 0 ? x : ai === 1 ? y : z;
          return blocks[mod(Math.floor(c / size))](x, y, z);
        };
      }
      const skip = s.axis === undefined ? -1 : AXIS_I[s.axis as 'x' | 'y' | 'z'];
      if (skip === undefined) throw new PatternError(`checker: axis must be x, y or z`);
      return (x, y, z) => {
        const sum =
          (skip === 0 ? 0 : Math.floor(x / size)) + (skip === 1 ? 0 : Math.floor(y / size)) + (skip === 2 ? 0 : Math.floor(z / size));
        return blocks[mod(sum)](x, y, z);
      };
    }
    default:
      throw new PatternError(
        `pattern: unknown type "${s.type}". Use a block string, "60%a,40%b", [{block,weight}], or {type: gradient|noise|checker|stripes}`,
      );
  }
}

/** all distinct canonical states a pattern may produce (best effort, for previews/validation) */
export function patternBlocks(spec: PatternSpec, reg: Registry): string[] {
  const out = new Set<string>();
  const addStr = (s: string) => {
    for (const p of splitTopLevel(s)) {
      const m = WEIGHT_RE.exec(p);
      const b = (m ? m[3] : p).trim();
      if (b !== 'keep') out.add(reg.canonical(b));
    }
  };
  if (typeof spec === 'string') addStr(spec);
  else if (Array.isArray(spec)) spec.forEach((e) => addStr(e.block));
  else if ((spec as any).stops) (spec as any).stops.forEach(addStr);
  else if ((spec as any).blocks) (spec as any).blocks.forEach(addStr);
  return [...out];
}
