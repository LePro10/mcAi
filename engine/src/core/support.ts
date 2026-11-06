// Physical plausibility of placed blocks: which blocks need support (vanilla canSurvive) and
// whether they have it. Used by EditSession.flush to drop (or warn about) floating attachables:
// vines without a wall, torches in mid-air, flowers on stone, lanterns hanging from nothing …
//
// The real game places mcAI batches without neighbour updates, so unsupported blocks would
// "float" until something updates them — and then pop off. We mirror vanilla's rules as closely
// as reasonable from block states alone (no collision shapes): each neighbour face is classified
// as NONE / CENTER (posts: fences, walls, chains, rods, panes …) / FULL (sturdy face).
// Unknown neighbours (outside what the caller knows) always count as supporting.

import type { Vec3 } from './types.ts';
import type { Registry } from './registry.ts';
import { propOf } from './registry.ts';
import { blockId, isAir } from './blockstate.ts';

export type SupportMode = 'drop' | 'warn' | 'off';
export type Dir = 'north' | 'south' | 'east' | 'west' | 'up' | 'down';
export type HDir = 'north' | 'south' | 'east' | 'west';

export const DIR_VEC: Record<Dir, Vec3> = {
  north: [0, 0, -1],
  south: [0, 0, 1],
  east: [1, 0, 0],
  west: [-1, 0, 0],
  up: [0, 1, 0],
  down: [0, -1, 0],
};
export const OPPOSITE: Record<Dir, Dir> = { north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up' };
const CW: Record<HDir, HDir> = { north: 'east', east: 'south', south: 'west', west: 'north' };
const CCW: Record<HDir, HDir> = { north: 'west', west: 'south', south: 'east', east: 'north' };
const DIRS: Dir[] = ['north', 'south', 'east', 'west', 'up', 'down'];
const HDIRS: HDir[] = ['north', 'south', 'east', 'west'];

// Face support bits, mirroring vanilla SupportType (verified against the decompiled 26.3 code:
// Block.canSupportCenter / SupportType / VoxelShape.getFaceShape — the face is the slice of the
// support shape AT the block boundary, so a top slab has no bottom face and a bottom slab no top face).
export const NONE = 0;
/** the 2x2-pixel center column is covered (SupportType.CENTER): torches, lanterns, candles, hanging signs */
export const CENTER = 1;
/** the outer 2-pixel ring is covered (SupportType.RIGID): rails, repeaters, comparators */
export const RIGID = 2;
/** full sturdy face (SupportType.FULL): vines, ladders, wall torches, buttons, doors */
export const FULL = 3;

/** state at a position, or undefined when unknown (unknown = assume supported) */
export type SupportGetter = (x: number, y: number, z: number) => string | undefined;

/** Why a block was dropped / trimmed. `msg` is meant for the agent. */
export interface SupportKind {
  key: string;
  label: string;
  msg: string;
}

const K = (key: string, label: string, msg: string): SupportKind => ({ key, label, msg });
export const KINDS = {
  vine: K('vine', 'floating vines', 'vines need a solid face behind them (or a vine above to hang from)'),
  multiface: K('multiface', 'glow lichen/sculk vein faces', 'each face needs a solid block on that side'),
  wall: K('wall', 'wall-mounted blocks', 'wall torches, ladders, signs, banners, buttons, levers, hooks and buds need a solid block behind them (opposite to facing)'),
  floor: K('floor', 'unsupported torches/lanterns/candles', 'they need a full or post-like block below (fence, wall, chain, top slab — not a bottom slab, chest or air)'),
  hanging: K('hanging', 'hanging blocks without a ceiling', 'hanging lanterns/signs, roots, spore blossoms and cave vines need a block above with a bottom face: full block, bottom slab, bottom-half stairs, chain or fence (top slabs, upside-down stairs and top trapdoors have none)'),
  plant: K('plant', 'plants on wrong ground', 'flowers, grass, saplings and bushes need grass_block/dirt/moss/mud/farmland below (crops: farmland; cactus: sand; dead bush/dry grass: sand or terracotta too)'),
  cover: K('cover', 'unsupported carpets/plates/rails/snow', 'carpets, pressure plates, rails, redstone, snow layers and doors need a solid block below'),
  water: K('water', 'misplaced water plants', 'lily pads need water below; seagrass/kelp/coral need a solid floor'),
  cocoa: K('cocoa', 'cocoa without a jungle log', 'cocoa needs a jungle log on its facing side'),
  scaffolding: K('scaffolding', 'unsupported scaffolding', 'scaffolding needs a block below within 6 horizontal steps'),
  part: K('part', 'orphaned multi-block halves', 'the other half (door/tall plant) is missing'),
  gravity: K('gravity', 'falling blocks over air', 'sand/gravel/concrete powder/anvils fall when updated — put something solid under them'),
} as const;

export interface Verdict {
  kind: SupportKind;
  /** replacement state for multiface trimming; undefined = remove the block */
  trim?: string;
  /** only warn, never drop (gravity blocks) */
  warnOnly?: boolean;
  /** the neighbour cell that should provide the support */
  need?: Vec3;
}

type Rule = (x: number, y: number, z: number, state: string, get: SupportGetter, ctx: SupportCtx) => Verdict | null;

class SupportCtx {
  reg: Registry;
  private faces = new Map<string, Int8Array>();
  private rules = new Map<string, Rule | null>();
  constructor(reg: Registry) {
    this.reg = reg;
  }
  /** support level a block offers on its face `face` */
  face(state: string, face: Dir): number {
    let f = this.faces.get(state);
    if (!f) {
      f = new Int8Array(6);
      for (let i = 0; i < 6; i++) f[i] = computeFace(this.reg, state, DIRS[i]!);
      if (this.faces.size > 50_000) this.faces.clear();
      this.faces.set(state, f);
    }
    return f[DIRS.indexOf(face)]!;
  }
  rule(state: string): Rule | null {
    let r = this.rules.get(state);
    if (r === undefined) {
      r = computeRule(this.reg, state);
      if (this.rules.size > 50_000) this.rules.clear();
      this.rules.set(state, r);
    }
    return r;
  }
  tag(state: string, tag: string): boolean {
    return this.reg.hasTag(blockId(state), tag);
  }
}

const ctxCache = new WeakMap<Registry, SupportCtx>();
function ctxFor(reg: Registry): SupportCtx {
  let c = ctxCache.get(reg);
  if (!c) ctxCache.set(reg, (c = new SupportCtx(reg)));
  return c;
}

// ------------------------------------------------------------------ helpers

const sh = (state: string) => blockId(state).slice(10);

export function isFluidState(state: string): boolean {
  const id = blockId(state);
  return id === 'minecraft:water' || id === 'minecraft:lava' || id === 'minecraft:bubble_column';
}

const WATER_PLANTS = new Set(['minecraft:seagrass', 'minecraft:tall_seagrass', 'minecraft:kelp', 'minecraft:kelp_plant', 'minecraft:bubble_column']);

/** blocks that always sit inside water (no waterlogged property) */
export function isWaterPlant(state: string): boolean {
  return WATER_PLANTS.has(blockId(state));
}

/** contains water: water, bubble columns, water plants, waterlogged=true blocks */
export function holdsWater(state: string): boolean {
  const id = blockId(state);
  return id === 'minecraft:water' || WATER_PLANTS.has(id) || propOf(state, 'waterlogged') === 'true';
}

/**
 * What remains when a block is removed: water for waterlogged blocks and underwater plants
 * (seagrass, kelp, bubble columns …) so rivers and ponds are never drained, else air.
 */
export function removedState(state: string): string {
  const id = blockId(state);
  if (id === 'minecraft:water' || id === 'minecraft:lava') return 'minecraft:air';
  return holdsWater(state) ? 'minecraft:water' : 'minecraft:air';
}

/** non-air, non-fluid, not a replaceable plant — vanilla `isSolid()`-ish (signs, banners) */
function solidish(c: SupportCtx, s: string): boolean {
  if (isAir(s) || isFluidState(s)) return false;
  if (c.reg.isFullSolid(s)) return true;
  if (c.tag(s, 'minecraft:replaceable')) return false;
  return c.tag(s, 'minecraft:blocks_motion') || c.face(s, 'up') > 0 || c.face(s, 'down') > 0;
}

function computeFace(reg: Registry, state: string, face: Dir): number {
  if (isAir(state) || isFluidState(state)) return NONE;
  const s = sh(state);
  const p = (k: string) => propOf(state, k);
  if (s.endsWith('_slab')) {
    const t = p('type');
    return t === 'double' ? FULL : t === 'bottom' ? (face === 'down' ? FULL : NONE) : face === 'up' ? FULL : NONE;
  }
  if (s.endsWith('_stairs')) {
    const half = p('half');
    if (face === 'down') return half === 'bottom' ? FULL : NONE;
    if (face === 'up') return half === 'top' ? FULL : NONE;
    const f = p('facing') as HDir;
    const shape = p('shape');
    if (face === f && (shape === 'straight' || shape?.startsWith('inner'))) return FULL;
    if (shape === 'inner_left' && face === CCW[f]) return FULL;
    if (shape === 'inner_right' && face === CW[f]) return FULL;
    return NONE;
  }
  if (reg.hasTag(blockId(state), 'minecraft:trapdoors')) {
    if (p('open') === 'true') return face === OPPOSITE[p('facing') as Dir] ? FULL : NONE;
    return p('half') === 'top' ? (face === 'up' ? FULL : NONE) : face === 'down' ? FULL : NONE;
  }
  if (s === 'snow') return p('layers') === '8' ? FULL : face === 'down' ? FULL : NONE;
  if (s === 'farmland' || s === 'dirt_path' || s === 'soul_sand' || s === 'mud' || s === 'honey_block') return FULL;
  if (reg.isFullSolid(state)) return FULL;
  const vertical = face === 'up' || face === 'down';
  if (reg.hasTag(blockId(state), 'minecraft:fences') || reg.hasTag(blockId(state), 'minecraft:walls')) return vertical ? CENTER : NONE;
  if (s.endsWith('_pane') || s === 'iron_bars' || s.endsWith('_bars')) return vertical ? CENTER : NONE;
  if (s === 'chain' || s === 'iron_chain' || s.endsWith('_chain')) return vertical && p('axis') === 'y' ? CENTER : NONE;
  if (s === 'end_rod' || s.endsWith('lightning_rod')) {
    const f = p('facing');
    return vertical && (f === 'up' || f === 'down') ? CENTER : !vertical && face === f ? CENTER : NONE;
  }
  if (s === 'hopper') return face === 'up' ? RIGID : face === 'down' ? CENTER : NONE; // bowl rim, spout
  if (s.endsWith('_carpet')) return face === 'down' ? FULL : NONE;
  if (s === 'scaffolding') return face === 'up' ? FULL : NONE;
  if (s === 'chest' || s === 'trapped_chest' || s === 'ender_chest' || s.endsWith('copper_chest')) return face === 'down' ? CENTER : NONE;
  if (s.endsWith('_fence_gate')) return face === 'up' && p('open') !== 'true' ? CENTER : NONE; // #unstable_bottom_center
  if (s.endsWith('_wall')) return vertical ? CENTER : NONE;
  if (s === 'mangrove_roots' || s === 'composter') return FULL;
  if (s === 'cauldron' || s.endsWith('_cauldron')) return face === 'up' ? RIGID : NONE; // rim ring; legs cut the sides/bottom
  if (s === 'pointed_dripstone') return vertical ? CENTER : NONE;
  if (s === 'lectern' || s === 'stonecutter' || s === 'enchanting_table' || s === 'daylight_detector' || s.endsWith('_bed')) return face === 'down' ? FULL : NONE;
  if (s === 'anvil' || s === 'chipped_anvil' || s === 'damaged_anvil') return face === 'up' ? CENTER : NONE;
  if (s === 'bell' || s === 'campfire' || s === 'soul_campfire' || s === 'brewing_stand' || s === 'grindstone') return face === 'down' ? CENTER : NONE;
  return NONE;
}

const has = (c: SupportCtx, get: SupportGetter, x: number, y: number, z: number, d: Dir, level: number): boolean => {
  const v = DIR_VEC[d];
  const s = get(x + v[0], y + v[1], z + v[2]);
  if (s === undefined) return true;
  return (c.face(s, OPPOSITE[d]) & level) === level;
};
const at = (get: SupportGetter, x: number, y: number, z: number, d: Dir): string | undefined => {
  const v = DIR_VEC[d];
  return get(x + v[0], y + v[1], z + v[2]);
};
const below = (get: SupportGetter, x: number, y: number, z: number) => get(x, y - 1, z);

function onTag(c: SupportCtx, get: SupportGetter, x: number, y: number, z: number, tags: string[], kind: SupportKind): Verdict | null {
  const b = below(get, x, y, z);
  if (b === undefined) return null;
  for (const t of tags) if (c.tag(b, t)) return null;
  return { kind };
}

/** vanilla VineBlock.getUpdatedState: drop faces without support; returns the trimmed state or null if unchanged */
function vineRule(x: number, y: number, z: number, state: string, get: SupportGetter, c: SupportCtx): Verdict | null {
  let st = state;
  let changed = false;
  if (propOf(st, 'up') === 'true' && !has(c, get, x, y, z, 'up', FULL)) {
    st = setProp(st, 'up', 'false');
    changed = true;
  }
  const above = get(x, y + 1, z);
  for (const d of HDIRS) {
    if (propOf(st, d) !== 'true') continue;
    if (has(c, get, x, y, z, d, FULL)) continue;
    if (above === undefined) continue;
    if (blockId(above) === 'minecraft:vine' && propOf(above, d) === 'true') continue;
    st = setProp(st, d, 'false');
    changed = true;
  }
  const any = propOf(st, 'up') === 'true' || HDIRS.some((d) => propOf(st, d) === 'true');
  if (!any) return { kind: KINDS.vine };
  return changed ? { kind: KINDS.vine, trim: st } : null;
}

function multifaceRule(x: number, y: number, z: number, state: string, get: SupportGetter, c: SupportCtx): Verdict | null {
  let st = state;
  let changed = false;
  let any = false;
  for (const d of DIRS) {
    if (propOf(st, d) !== 'true') continue;
    if (has(c, get, x, y, z, d, FULL)) {
      any = true;
      continue;
    }
    st = setProp(st, d, 'false');
    changed = true;
  }
  if (!any) return { kind: KINDS.multiface };
  return changed ? { kind: KINDS.multiface, trim: st } : null;
}

function shortState(s: string): string {
  const id = sh(s);
  const half = /[[,](half|type)=(top|bottom|double)/.exec(s);
  return half ? `${id}[${half[1]}=${half[2]}]` : id;
}

export function setProp(state: string, prop: string, value: string): string {
  return state.replace(new RegExp(`([\\[,]${prop}=)[a-z0-9_]+`), `$1${value}`);
}

const behind = (x: number, y: number, z: number, f: Dir): Vec3 => {
  const v = DIR_VEC[OPPOSITE[f]];
  return [x + v[0], y + v[1], z + v[2]];
};
const wallRule = (level: number): Rule => (x, y, z, state, get, c) => {
  const f = propOf(state, 'facing') as Dir;
  return has(c, get, x, y, z, OPPOSITE[f], level) ? null : { kind: KINDS.wall, need: behind(x, y, z, f) };
};
const solidBehind: Rule = (x, y, z, state, get, c) => {
  const f = propOf(state, 'facing') as Dir;
  const s = at(get, x, y, z, OPPOSITE[f]);
  return s === undefined || solidish(c, s) ? null : { kind: KINDS.wall, need: behind(x, y, z, f) };
};
const floorCenter: Rule = (x, y, z, _s, get, c) => (has(c, get, x, y, z, 'down', CENTER) ? null : { kind: KINDS.floor });
const ceilCenter: Rule = (x, y, z, _s, get, c) => (has(c, get, x, y, z, 'up', CENTER) ? null : { kind: KINDS.hanging });
const ceilFull: Rule = (x, y, z, _s, get, c) => (has(c, get, x, y, z, 'up', FULL) ? null : { kind: KINDS.hanging });
const floorFullCover: Rule = (x, y, z, _s, get, c) => (has(c, get, x, y, z, 'down', FULL) ? null : { kind: KINDS.cover });
// pressure plates: canSupportRigidBlock || canSupportCenter
const floorCenterCover: Rule = (x, y, z, _s, get, c) => (has(c, get, x, y, z, 'down', CENTER) || has(c, get, x, y, z, 'down', RIGID) ? null : { kind: KINDS.cover });
const floorRigid: Rule = (x, y, z, _s, get, c) => (has(c, get, x, y, z, 'down', RIGID) ? null : { kind: KINDS.cover });
const notEmptyBelow: Rule = (x, y, z, _s, get) => {
  const b = below(get, x, y, z);
  return b === undefined || !isAir(b) ? null : { kind: KINDS.cover };
};
const solidBelow = (kind: SupportKind): Rule => (x, y, z, _s, get, c) => {
  const b = below(get, x, y, z);
  return b === undefined || solidish(c, b) ? null : { kind };
};
const plantOn = (...tags: string[]): Rule => (x, y, z, _s, get, c) => onTag(c, get, x, y, z, tags.map((t) => `minecraft:${t}`), KINDS.plant);
/** `self` stacks on itself (cane, cactus, bamboo, kelp, vines growing up/down) */
const stackOr = (ids: string[], dir: 'up' | 'down', base: Rule | null, kind: SupportKind): Rule => (x, y, z, state, get, c) => {
  const s = dir === 'down' ? get(x, y - 1, z) : get(x, y + 1, z);
  if (s === undefined) return null;
  if (ids.includes(blockId(s))) return null;
  if (base) return base(x, y, z, state, get, c);
  return { kind };
};
const upperHalf: Rule = (x, y, z, state, get) => {
  const b = below(get, x, y, z);
  if (b === undefined) return null;
  return blockId(b) === blockId(state) && propOf(b, 'half') === 'lower' ? null : { kind: KINDS.part };
};
const doubleLowerHalf = (rule: Rule): Rule => (x, y, z, state, get, c) => (propOf(state, 'half') === 'upper' ? upperHalf(x, y, z, state, get, c) : rule(x, y, z, state, get, c));

const faceAttached: Rule = (x, y, z, state, get, c) => {
  const face = propOf(state, 'face');
  if (face === 'floor') return has(c, get, x, y, z, 'down', FULL) ? null : { kind: KINDS.wall, need: [x, y - 1, z] };
  if (face === 'ceiling') return has(c, get, x, y, z, 'up', FULL) ? null : { kind: KINDS.wall, need: [x, y + 1, z] };
  return wallRule(FULL)(x, y, z, state, get, c);
};

const waterBelow: Rule = (x, y, z, _s, get, c) => {
  const b = below(get, x, y, z);
  if (b === undefined) return null;
  return holdsWater(b) || c.tag(b, 'minecraft:supports_lily_pad') ? null : { kind: KINDS.water };
};
const seaFloor = (self: string[], cannot: string): Rule => (x, y, z, _s, get, c) => {
  const b = below(get, x, y, z);
  if (b === undefined) return null;
  if (self.includes(blockId(b))) return null;
  if (c.tag(b, `minecraft:${cannot}`)) return { kind: KINDS.water };
  return c.face(b, 'up') === FULL ? null : { kind: KINDS.water };
};

const cactusRule: Rule = (x, y, z, _s, get, c) => {
  for (const d of HDIRS) {
    const n = at(get, x, y, z, d);
    if (n !== undefined && solidish(c, n) && blockId(n) !== 'minecraft:cactus') return { kind: KINDS.plant };
  }
  const b = below(get, x, y, z);
  if (b === undefined || blockId(b) === 'minecraft:cactus' || c.tag(b, 'minecraft:supports_cactus')) return null;
  return { kind: KINDS.plant };
};

const sugarCane: Rule = (x, y, z, _s, get, c) => {
  const b = below(get, x, y, z);
  if (b === undefined || blockId(b) === 'minecraft:sugar_cane') return null;
  if (!c.tag(b, 'minecraft:supports_sugar_cane')) return { kind: KINDS.plant };
  for (const d of HDIRS) {
    const v = DIR_VEC[d];
    const n = get(x + v[0], y - 1, z + v[2]);
    if (n === undefined || holdsWater(n) || c.tag(n, 'minecraft:supports_sugar_cane_adjacently')) return null;
  }
  return { kind: KINDS.plant };
};

const snowRule: Rule = (x, y, z, _s, get, c) => {
  const b = below(get, x, y, z);
  if (b === undefined) return null;
  if (c.tag(b, 'minecraft:cannot_support_snow_layer')) return { kind: KINDS.cover };
  if (c.tag(b, 'minecraft:support_override_snow_layer')) return null;
  if (blockId(b) === 'minecraft:snow') return propOf(b, 'layers') === '8' ? null : { kind: KINDS.cover };
  return c.face(b, 'up') === FULL ? null : { kind: KINDS.cover };
};

const dripstone: Rule = (x, y, z, state, get, c) => {
  const dir = propOf(state, 'vertical_direction');
  if (dir === 'down') {
    const a = get(x, y + 1, z);
    if (a === undefined || (blockId(a) === 'minecraft:pointed_dripstone' && propOf(a, 'vertical_direction') === 'down')) return null;
    return has(c, get, x, y, z, 'up', FULL) ? null : { kind: KINDS.hanging };
  }
  const b = get(x, y - 1, z);
  if (b === undefined || (blockId(b) === 'minecraft:pointed_dripstone' && propOf(b, 'vertical_direction') === 'up')) return null;
  return has(c, get, x, y, z, 'down', FULL) ? null : { kind: KINDS.floor };
};

const scaffoldingRule: Rule = (x, y, z, _s, get, c) => {
  // vanilla ScaffoldingBlock.getDistance: 0 on a sturdy block or above supported scaffolding; +1 per horizontal step; 7 = falls
  const supportedBase = (xx: number, yy: number, zz: number): boolean => {
    const b = get(xx, yy - 1, zz);
    if (b === undefined) return true;
    if (blockId(b) === 'minecraft:scaffolding') return true; // column: assume the column itself is supported
    return c.face(b, 'up') === FULL;
  };
  if (supportedBase(x, y, z)) return null;
  const seen = new Set<string>([`${x},${z}`]);
  let frontier: [number, number][] = [[x, z]];
  for (let step = 1; step <= 6 && frontier.length; step++) {
    const next: [number, number][] = [];
    for (const [fx, fz] of frontier)
      for (const d of HDIRS) {
        const v = DIR_VEC[d];
        const nx = fx + v[0], nz = fz + v[2];
        const k = `${nx},${nz}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const s = get(nx, y, nz);
        if (s === undefined) return null;
        if (blockId(s) !== 'minecraft:scaffolding') continue;
        if (supportedBase(nx, y, nz)) return null;
        next.push([nx, nz]);
      }
    frontier = next;
  }
  return { kind: KINDS.scaffolding };
};

const gravityRule: Rule = (x, y, z, _s, get) => {
  const b = below(get, x, y, z);
  if (b === undefined) return null;
  return isAir(b) || isFluidState(b) ? { kind: KINDS.gravity, warnOnly: true } : null;
};

const GRAVITY = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|.*_concrete_powder|anvil|chipped_anvil|damaged_anvil|dragon_egg)$/;

function computeRule(reg: Registry, state: string): Rule | null {
  if (isAir(state) || isFluidState(state)) return null;
  const id = blockId(state);
  const s = id.slice(10);
  const tag = (t: string) => reg.hasTag(id, `minecraft:${t}`);
  // multiface
  if (s === 'vine') return vineRule;
  if (s === 'glow_lichen' || s === 'sculk_vein' || s === 'resin_clump') return multifaceRule;
  // wall mounted (support behind = opposite of facing)
  if (s === 'ladder' || s.endsWith('wall_torch') || s === 'tripwire_hook') return wallRule(FULL);
  if (s.endsWith('_wall_sign') || s.endsWith('_wall_banner')) return solidBehind;
  if (s.endsWith('_wall_hanging_sign')) {
    return (x, y, z, st, get, c) => {
      const f = propOf(st, 'facing') as HDir;
      for (const d of [CW[f], CCW[f]]) {
        const n = at(get, x, y, z, d);
        if (n === undefined || solidish(c, n) || blockId(n).endsWith('_hanging_sign')) return null;
      }
      return { kind: KINDS.wall };
    };
  }
  if (s.endsWith('amethyst_bud') || s === 'amethyst_cluster') {
    return (x, y, z, st, get, c) => {
      const f = propOf(st, 'facing') as Dir;
      return has(c, get, x, y, z, OPPOSITE[f], FULL) ? null : { kind: KINDS.wall };
    };
  }
  if (tag('wall_corals') || s.endsWith('_coral_wall_fan')) return wallRule(FULL);
  if (tag('buttons') || s === 'lever') return faceAttached;
  if (s === 'cocoa') {
    return (x, y, z, st, get, c) => {
      const n = at(get, x, y, z, propOf(st, 'facing') as Dir);
      return n === undefined || c.tag(n, 'minecraft:supports_cocoa') || c.tag(n, 'minecraft:jungle_logs') ? null : { kind: KINDS.cocoa };
    };
  }
  // hanging / standing small lights
  if ((s === 'lantern' || s.endsWith('_lantern')) && reg.info(id)?.properties.hanging) return (x, y, z, st, get, c) => (propOf(st, 'hanging') === 'true' ? ceilCenter : floorCenter)(x, y, z, st, get, c);
  if ((s === 'torch' || s.endsWith('_torch')) && !s.includes('wall')) return floorCenter;
  if (tag('candles') || s === 'candle' || s.endsWith('_candle')) return floorCenter;
  if (s.endsWith('candle_cake') || s === 'cake') return solidBelow(KINDS.floor);
  if (s.endsWith('_hanging_sign')) return ceilCenter;
  if (s.endsWith('_sign') || (s.endsWith('_banner') && !s.includes('wall'))) return solidBelow(KINDS.floor);
  if (s === 'hanging_roots' || s === 'spore_blossom') return ceilFull;
  if (s === 'cave_vines' || s === 'cave_vines_plant') return stackOr(['minecraft:cave_vines', 'minecraft:cave_vines_plant'], 'up', ceilFull, KINDS.hanging);
  if (s === 'weeping_vines' || s === 'weeping_vines_plant') return stackOr(['minecraft:weeping_vines', 'minecraft:weeping_vines_plant'], 'up', ceilFull, KINDS.hanging);
  if (s === 'twisting_vines' || s === 'twisting_vines_plant') return stackOr(['minecraft:twisting_vines', 'minecraft:twisting_vines_plant'], 'down', floorFullCover, KINDS.cover);
  if (s === 'pale_hanging_moss') return stackOr(['minecraft:pale_hanging_moss'], 'up', ceilFull, KINDS.hanging);
  if (s === 'pointed_dripstone') return dripstone;
  // floor covers
  if (s.endsWith('_carpet')) return notEmptyBelow;
  if (tag('pressure_plates')) return floorCenterCover;
  if (tag('rails') || s === 'repeater' || s === 'comparator') return floorRigid;
  if (s === 'redstone_wire') return floorFullCover;
  if (s === 'snow') return snowRule;
  if (s === 'leaf_litter') return floorFullCover;
  if (tag('doors')) return doubleLowerHalf(floorFullCover);
  if (s === 'scaffolding') return scaffoldingRule;
  // water plants
  if (s === 'lily_pad') return waterBelow;
  if (s === 'seagrass') return seaFloor([], 'cannot_support_seagrass');
  if (s === 'tall_seagrass') return doubleLowerHalf(seaFloor([], 'cannot_support_seagrass'));
  if (s === 'kelp' || s === 'kelp_plant') return seaFloor(['minecraft:kelp', 'minecraft:kelp_plant'], 'cannot_support_kelp');
  if (s === 'sea_pickle') return (x, y, z, st, get, c) => (has(c, get, x, y, z, 'down', CENTER) ? null : { kind: KINDS.water });
  if (tag('corals') || tag('coral_plants') || s.endsWith('_coral_fan')) return (x, y, z, st, get, c) => (has(c, get, x, y, z, 'down', FULL) ? null : { kind: KINDS.water });
  // plants (vanilla mayPlaceOn tags)
  if (s === 'cactus') return cactusRule;
  if (s === 'sugar_cane') return sugarCane;
  if (s === 'bamboo' || s === 'bamboo_sapling') return plantOn('supports_bamboo');
  if (tag('crops') || s === 'torchflower_crop' || s === 'pitcher_crop' || s === 'melon_stem' || s === 'pumpkin_stem' || s === 'attached_melon_stem' || s === 'attached_pumpkin_stem')
    return doubleLowerHalf(plantOn('supports_crops'));
  if (s === 'nether_wart') return plantOn('supports_nether_wart');
  if (s === 'wither_rose') return plantOn('supports_wither_rose');
  if (s === 'crimson_fungus' || s === 'warped_fungus' || s === 'crimson_roots' || s === 'warped_roots' || s === 'nether_sprouts') return plantOn('supports_crimson_fungus', 'nylium');
  if (s === 'dead_bush' || s === 'short_dry_grass' || s === 'tall_dry_grass') return plantOn('supports_dry_vegetation');
  if (s === 'azalea' || s === 'flowering_azalea') return plantOn('supports_azalea');
  if (s === 'small_dripleaf') return doubleLowerHalf(plantOn('supports_small_dripleaf', 'supports_vegetation'));
  if (s === 'brown_mushroom' || s === 'red_mushroom') return (x, y, z, st, get, c) => (has(c, get, x, y, z, 'down', FULL) ? null : { kind: KINDS.plant });
  if (s === 'chorus_flower' || s === 'chorus_plant') return null;
  if (s === 'mangrove_propagule') return (x, y, z, st, get, c) => (propOf(st, 'hanging') === 'true' ? ceilCenter(x, y, z, st, get, c) : plantOn('supports_mangrove_propagule', 'supports_vegetation')(x, y, z, st, get, c));
  if (s === 'cactus_flower') return plantOn('support_override_cactus_flower', 'supports_cactus', 'supports_vegetation');
  if (tag('leaves')) return null; // cherry/azalea leaves carry the 'flowers' tag
  if (tag('flowers') || tag('small_flowers') || tag('saplings') || s === 'short_grass' || s === 'fern' || s === 'tall_grass' || s === 'large_fern' || s === 'sweet_berry_bush' || s === 'bush' || s === 'firefly_bush' || s === 'pink_petals' || s === 'wildflowers' || s === 'sunflower' || s === 'lilac' || s === 'rose_bush' || s === 'peony' || s === 'pitcher_plant' || s === 'open_eyeblossom' || s === 'closed_eyeblossom')
    return doubleLowerHalf(plantOn('supports_vegetation'));
  if (GRAVITY.test(s)) return gravityRule;
  return null;
}

/** Check one block. Returns null when it may stay as it is. */
export function checkSupportAt(x: number, y: number, z: number, state: string, get: SupportGetter, reg: Registry): Verdict | null {
  const c = ctxFor(reg);
  const r = c.rule(state);
  return r ? r(x, y, z, state, get, c) : null;
}

/** Whether a state has any survival rule (cheap; cached). */
export function needsSupport(state: string, reg: Registry): boolean {
  return ctxFor(reg).rule(state) !== null;
}

/** support level a block offers on one face (NONE/CENTER/FULL) */
export function faceSupport(state: string, face: Dir, reg: Registry): number {
  return ctxFor(reg).face(state, face);
}

export interface SupportChange {
  pos: Vec3;
  from: string;
  /** new state (removedState for drops, trimmed multiface state otherwise) */
  to: string;
  kind: SupportKind;
  trimmed: boolean;
  need?: Vec3;
  /** state found at `need` */
  found?: string;
}

export interface SupportReport {
  changes: SupportChange[];
  /** warn-only findings (gravity blocks, or everything in mode 'warn') */
  warnings: SupportChange[];
}

/**
 * Resolve support for `seeds` (positions that were set or whose neighbours changed), cascading:
 * removing a block re-checks its neighbours (a vine chain loses its lower part when the top goes).
 * `get` must see the pending edits; `set` receives every change (never called in mode 'warn').
 * `allow(x,y,z)` limits which positions may be modified (others are reported as warnings).
 */
export function resolveSupport(
  seeds: Iterable<Vec3>,
  get: SupportGetter,
  reg: Registry,
  opts: { mode: SupportMode; set?: (x: number, y: number, z: number, state: string) => void; allow?: (x: number, y: number, z: number) => boolean; maxChanges?: number } ,
): SupportReport {
  const report: SupportReport = { changes: [], warnings: [] };
  if (opts.mode === 'off') return report;
  const c = ctxFor(reg);
  const overlay = new Map<string, string>();
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const g: SupportGetter = (x, y, z) => {
    const o = overlay.get(key(x, y, z));
    return o !== undefined ? o : get(x, y, z);
  };
  // process top-down so hanging chains resolve in one pass; re-queue neighbours of changes
  let queue: Vec3[] = [...seeds];
  const maxChanges = opts.maxChanges ?? 2_000_000;
  const warned = new Set<string>();
  for (let round = 0; round < 64 && queue.length; round++) {
    queue.sort((a, b) => b[1] - a[1]);
    const next: Vec3[] = [];
    const seen = new Set<string>();
    for (const p of queue) {
      const [x, y, z] = p;
      const st = g(x, y, z);
      if (st === undefined) continue;
      const rule = c.rule(st);
      if (!rule) continue;
      const k = key(x, y, z);
      if (seen.has(k)) continue;
      seen.add(k);
      const v = rule(x, y, z, st, g, c);
      if (!v) continue;
      const to = v.trim ?? removedState(st);
      const need: Vec3 | undefined = v.need ?? (v.kind === KINDS.hanging ? [x, y + 1, z] : v.kind === KINDS.floor || v.kind === KINDS.plant || v.kind === KINDS.cover || v.kind === KINDS.water ? [x, y - 1, z] : undefined);
      const found = need ? g(need[0], need[1], need[2]) : undefined;
      const ch: SupportChange = { pos: [x, y, z], from: st, to, kind: v.kind, trimmed: v.trim !== undefined, ...(need ? { need } : {}), ...(found ? { found } : {}) };
      if (v.warnOnly || opts.mode === 'warn' || (opts.allow && !opts.allow(x, y, z))) {
        if (!warned.has(k)) {
          warned.add(k);
          report.warnings.push(ch);
        }
        continue;
      }
      if (report.changes.length >= maxChanges) break;
      overlay.set(k, to);
      opts.set?.(x, y, z, to);
      report.changes.push(ch);
      // neighbours may have depended on this block; a trimmed block may be checked again
      for (const d of DIRS) {
        const dv = DIR_VEC[d];
        next.push([x + dv[0], y + dv[1], z + dv[2]]);
      }
    }
    queue = next;
  }
  return report;
}

/** Group changes by kind for a compact agent message. */
export function summarizeSupport(changes: SupportChange[], fmt: (p: Vec3) => string = (p) => `[${p.join(',')}]`, verb = 'dropped'): string[] {
  const groups = new Map<string, SupportChange[]>();
  for (const ch of changes) {
    const k = ch.kind.key + (ch.trimmed ? ':trim' : '');
    let l = groups.get(k);
    if (!l) groups.set(k, (l = []));
    l.push(ch);
  }
  const out: string[] = [];
  for (const [k, l] of groups) {
    const kind = l[0]!.kind;
    const samples = l.slice(0, 4).map((ch) => `${fmt(ch.pos)} ${sh(ch.from)}${ch.need ? ` (support cell ${fmt(ch.need)}: ${ch.found ? shortState(ch.found) : '?'})` : ''}`).join(', ');
    const what = k.endsWith(':trim') ? `trimmed ${l.length} ${kind.label} (unsupported faces removed)` : `${verb} ${l.length} ${kind.label}`;
    out.push(`${what} — ${kind.msg}; e.g. ${samples}`);
  }
  return out;
}
