// Masks: predicates over the *current* block at a position (only modify where the mask matches).
// See docs/ENGINE-API.md (pattern.ts / mask.ts).
//
// String forms (case-insensitive, may be combined with top-level commas = any-of):
//   'air'          air, cave_air, void_air
//   'solid'        registry.isFullSolid (full cubes incl. glass/leaves)
//   'liquid'       water, lava, bubble_column (not waterlogged blocks)
//   'transparent'  registry.isTransparent; 'opaque' = not transparent
//   'replaceable'  air + #minecraft:replaceable (grass, flowers, snow layer, water, …)
//   '*' / 'any'    everything
//   'stone'        exact block id, any properties
//   'oak_stairs[half=top]'   block id + partial property match
//   '#minecraft:logs' / '#logs'   block tag
//   '!X'           negation of any of the above
import type { Registry } from './registry.ts';
import { blockId, isAir, normalizeId, parseBlockState } from './blockstate.ts';
import { splitTopLevel } from './pattern.ts';

export type MaskSpec = string | string[] | { not: MaskSpec } | { all: MaskSpec[] } | { any: MaskSpec[] };
export type MaskFn = (x: number, y: number, z: number, current: string) => boolean;

export class MaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaskError';
  }
}

type Pred = (state: string) => boolean;

const LIQUIDS = new Set(['minecraft:water', 'minecraft:lava', 'minecraft:bubble_column']);

function parseProps(state: string): Record<string, string> {
  const b = state.indexOf('[');
  const brace = state.indexOf('{');
  if (b < 0 || (brace >= 0 && brace < b)) return {};
  const e = state.indexOf(']', b);
  const out: Record<string, string> = {};
  for (const part of state.slice(b + 1, e).split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

function compileAtom(raw: string, reg: Registry): Pred {
  let s = raw.trim();
  if (!s) throw new MaskError('mask: empty entry');
  if (s.startsWith('!')) {
    const inner = compileAtom(s.slice(1), reg);
    return (st) => !inner(st);
  }
  const low = s.toLowerCase();
  switch (low) {
    case '*':
    case 'any':
      return () => true;
    case 'air':
      return isAir;
    case 'solid':
      return (st) => reg.isFullSolid(st);
    case 'liquid':
      return (st) => LIQUIDS.has(blockId(st));
    case 'transparent':
      return (st) => reg.isTransparent(st);
    case 'opaque':
      return (st) => !reg.isTransparent(st);
    case 'replaceable':
      return (st) => isAir(st) || reg.hasTag(blockId(st), 'minecraft:replaceable');
  }
  if (s.startsWith('#')) {
    const tag = normalizeId(s.slice(1));
    if (!reg.tagMembers(tag).length) throw new MaskError(`mask "${raw}": unknown or empty block tag ${tag}`);
    return (st) => reg.hasTag(blockId(st), tag);
  }
  let parsed;
  try {
    parsed = parseBlockState(s);
  } catch (e) {
    throw new MaskError(`mask "${raw}": ${(e as Error).message}`);
  }
  const info = reg.info(parsed.name);
  if (!info) {
    const sugg = reg.suggest(parsed.name, 5);
    throw new MaskError(
      `mask "${raw}": unknown block "${parsed.name}"` +
        (sugg.length ? `. Did you mean: ${sugg.join(', ')}?` : '') +
        ` (keywords: air, solid, liquid, transparent, opaque, replaceable, *, #tag, !negate)`,
    );
  }
  const want = Object.entries(parsed.props);
  for (const [k, v] of want) {
    const allowed = info.properties[k];
    if (!allowed)
      throw new MaskError(
        `mask "${raw}": ${parsed.name} has no property "${k}" (valid: ${Object.keys(info.properties).join(', ') || 'none'})`,
      );
    if (!allowed.includes(v)) throw new MaskError(`mask "${raw}": invalid value "${v}" for ${k} (valid: ${allowed.join(', ')})`);
  }
  const id = parsed.name;
  if (!want.length) return (st) => blockId(st) === id;
  return (st) => {
    if (blockId(st) !== id) return false;
    const p = parseProps(st);
    for (const [k, v] of want) if ((p[k] ?? info.default[k]) !== v) return false;
    return true;
  };
}

function compilePred(spec: MaskSpec, reg: Registry): Pred {
  if (typeof spec === 'string') {
    const parts = splitTopLevel(spec);
    if (!parts.length) throw new MaskError('mask: empty string');
    if (parts.length === 1) return compileAtom(parts[0], reg);
    const ps = parts.map((p) => compileAtom(p, reg));
    return (st) => ps.some((p) => p(st));
  }
  if (Array.isArray(spec)) {
    if (!spec.length) throw new MaskError('mask: empty list');
    const ps = spec.map((p) => compilePred(p, reg));
    return (st) => ps.some((p) => p(st));
  }
  if (spec && typeof spec === 'object') {
    if ('not' in spec) {
      const p = compilePred(spec.not, reg);
      return (st) => !p(st);
    }
    if ('all' in spec) {
      if (!Array.isArray(spec.all) || !spec.all.length) throw new MaskError('mask: "all" needs a non-empty list');
      const ps = spec.all.map((p) => compilePred(p, reg));
      return (st) => ps.every((p) => p(st));
    }
    if ('any' in spec) {
      if (!Array.isArray(spec.any) || !spec.any.length) throw new MaskError('mask: "any" needs a non-empty list');
      const ps = spec.any.map((p) => compilePred(p, reg));
      return (st) => ps.some((p) => p(st));
    }
  }
  throw new MaskError('mask: expected a string, a list, or {not}/{all}/{any}');
}

/** Compile a mask. The result is cached per distinct current state (masks are position-independent). */
export function compileMask(spec: MaskSpec, reg: Registry): MaskFn {
  const pred = compilePred(spec, reg);
  const cache = new Map<string, boolean>();
  return (_x, _y, _z, current) => {
    let v = cache.get(current);
    if (v === undefined) {
      v = pred(current);
      if (cache.size > 50_000) cache.clear();
      cache.set(current, v);
    }
    return v;
  };
}
