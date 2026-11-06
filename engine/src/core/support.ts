// Physical plausibility of placed blocks: which blocks need support (vanilla canSurvive) and
// whether they have it. Used by EditSession.flush to drop (or warn about) floating attachables:
// vines without a wall, torches in mid-air, flowers on stone, lanterns hanging from nothing …
//
// The real game places mcAI batches without neighbour updates, so unsupported blocks would
// "float" until something updates them — and then pop off. The rules are ported from the 26.3
// canSurvive / updateShape code (verified by tools/vanilla-diff.mjs --suite support against the
// real server). Neighbour faces come from the registry physics (physics.ts: vanilla isFaceSturdy
// FULL / CENTER / RIGID, collision + support face fullness, legacy isSolid …) and fall back to the
// id heuristics in computeFaceHeuristic for blocks without data.
// Unknown neighbours (outside what the caller knows) always count as supporting.
//
// Deliberate approximations (docs/VANILLA-DIFF.md "Status after fixes"):
//  * mushrooms: vanilla needs raw brightness < 13; we estimate sky exposure from the column above
//    (and the 2-block neighbourhood) and ignore block light (torches) — see mushroomRule;
//  * candles and wall hanging signs never pop in vanilla (no survival check in updateShape) → no rule;
//  * farmland / dirt path under a legacy-solid block turn into dirt (vanilla scheduled tick):
//    reported as kind `soil` with the replacement state, applied before other rules.

import type { Vec3 } from './types.ts';
import type { Registry } from './registry.ts';
import { propOf } from './registry.ts';
import { blockId, isAir } from './blockstate.ts';
import { PF } from './physics.ts';

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

// Face support bits, mirroring vanilla SupportType (Block.canSupportCenter / SupportType /
// VoxelShape.getFaceShape — the face is the slice of the support shape AT the block boundary, so a
// top slab has no bottom face and a bottom slab no top face). A FULL face is also CENTER and RIGID.
export const NONE = 0;
/** the 2x2-pixel center column is covered (SupportType.CENTER): torches, lanterns, hanging signs */
export const CENTER = 1;
/** the outer 2-pixel ring is covered (SupportType.RIGID): rails, repeaters, comparators */
export const RIGID = 2;
/** full sturdy face (SupportType.FULL): ladders, wall torches, buttons, doors (= CENTER | RIGID | 4) */
export const FULL = 7;

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
  vine: K('vine', 'floating vines', 'vines need a solid face behind them (or a vine above to hang from; leaves work); a ceiling vine (up=true) needs a block above whose TOP face is full — a top slab works, a bottom slab does not (vanilla quirk)'),
  multiface: K('multiface', 'glow lichen/sculk vein faces', 'each face needs a solid block on that side'),
  wall: K('wall', 'wall-mounted blocks', 'wall torches, ladders, signs, banners, buttons, levers, hooks and buds need a solid block behind them (opposite to facing)'),
  floor: K('floor', 'unsupported torches/lanterns/signs', 'they need a sturdy centre below (full block, fence, wall, chain, top slab — not a bottom slab, chest, leaves, dirt path, farmland or air); signs, banners and cakes need a solid block'),
  hanging: K('hanging', 'hanging blocks without a ceiling', 'hanging lanterns/signs, roots, spore blossoms and cave vines need a block above with a bottom face: full block, bottom slab, bottom-half stairs, chain or fence (not leaves, top slabs, upside-down stairs, top trapdoors, fence gates)'),
  plant: K('plant', 'plants on wrong ground', 'flowers, grass, saplings and bushes need grass_block/dirt/moss/mud/farmland below (crops: farmland; cactus: sand; dead bush/dry grass: sand or terracotta too; chorus: end stone; mushrooms: mycelium/podzol/nylium, or a dark spot on an opaque block)'),
  cover: K('cover', 'unsupported carpets/plates/rails/snow', 'carpets, pressure plates, rails, redstone, snow layers and doors need a solid block below (leaves, dirt path, farmland and honey blocks have no sturdy top; ascending rails also need a block on the high side)'),
  water: K('water', 'misplaced water plants', 'lily pads need water below; seagrass/kelp/coral need a solid floor'),
  cocoa: K('cocoa', 'cocoa without a jungle log', 'cocoa needs a jungle log on its facing side'),
  scaffolding: K('scaffolding', 'unsupported scaffolding', 'scaffolding needs a block below within 6 horizontal steps'),
  part: K('part', 'orphaned multi-block halves', 'the other half (door/tall plant) is missing'),
  gravity: K('gravity', 'falling blocks over air', 'sand/gravel/concrete powder/anvils fall when updated — put something solid under them (air, fluids, fire and replaceable blocks like snow layers, grass or vines do not hold them)'),
  bell: K('bell', 'unsupported bells', 'floor bells need a sturdy block below, ceiling bells a sturdy centre above, wall bells a sturdy block on their facing side'),
  soil: K('soil', 'farmland/dirt path under solid blocks', 'farmland and dirt paths turn into dirt when a solid block (door, plate, lantern, full block …) sits on them — replaced with dirt; keep paths/fields clear on top (fence gates and crops are fine)'),
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

const DIR_INDEX: Record<Dir, number> = { north: 0, south: 1, east: 2, west: 3, up: 4, down: 5 };
/** physics direction bits (Direction.values(): down, up, north, south, west, east) */
const PBIT: Record<Dir, number> = { down: 1, up: 2, north: 4, south: 8, west: 16, east: 32 };

class SupportCtx {
  reg: Registry;
  // per state: [0..5] support level per DIRS face, [6..11] multiface attach (support|collision face full), [12..17] collision face full
  private faces = new Map<string, Int8Array>();
  private rules = new Map<string, Rule | null>();
  constructor(reg: Registry) {
    this.reg = reg;
  }
  private facts(state: string): Int8Array {
    let f = this.faces.get(state);
    if (!f) {
      f = new Int8Array(18);
      const ph = isAir(state) || isFluidState(state) ? null : this.reg.physics(state);
      for (let i = 0; i < 6; i++) {
        const d = DIRS[i]!;
        if (ph) {
          const b = PBIT[d];
          f[i] = ph[0] & b ? FULL : (ph[1] & b ? CENTER : 0) | (ph[2] & b ? RIGID : 0);
          f[6 + i] = (ph[3] | ph[4]) & b ? 1 : 0;
          f[12 + i] = ph[3] & b ? 1 : 0;
        } else {
          f[i] = computeFaceHeuristic(this.reg, state, d);
          f[6 + i] = f[12 + i] = f[i] === FULL || this.reg.hasTag(blockId(state), 'minecraft:leaves') ? 1 : 0;
        }
      }
      if (this.faces.size > 50_000) this.faces.clear();
      this.faces.set(state, f);
    }
    return f;
  }
  /** support level a block offers on its face `face` */
  face(state: string, face: Dir): number {
    return this.facts(state)[DIR_INDEX[face]]!;
  }
  /** MultifaceBlock.canAttachTo: the support OR collision shape face is full (vines, lichen, moss) */
  attach(state: string, face: Dir): boolean {
    return this.facts(state)[6 + DIR_INDEX[face]] === 1;
  }
  /** Block.isFaceFull(collisionShape, face) (snow layers) */
  collisionFull(state: string, face: Dir): boolean {
    return this.facts(state)[12 + DIR_INDEX[face]] === 1;
  }
  /** a physics flag (PF.*); `fallback` when the state has no data */
  flag(state: string, bit: number, fallback: () => boolean): boolean {
    if (isAir(state)) return false;
    const ph = this.reg.physics(state);
    return ph ? (ph[5] & bit) !== 0 : fallback();
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

/** vanilla legacy `BlockState.isSolid()` (signs, banners, cakes, cactus neighbours, farmland/path) */
function solidish(c: SupportCtx, s: string): boolean {
  if (isAir(s) || isFluidState(s)) return false;
  return c.flag(s, PF.LEGACY_SOLID, () => {
    if (c.reg.isFullSolid(s)) return true;
    if (c.tag(s, 'minecraft:replaceable')) return false;
    return c.tag(s, 'minecraft:blocks_motion') || c.face(s, 'up') > 0 || c.face(s, 'down') > 0;
  });
}

/** id heuristics for blocks without physics data (modded blocks with an older mod) */
function computeFaceHeuristic(reg: Registry, state: string, face: Dir): number {
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
  if (s === 'soul_sand' || s === 'mud') return FULL;
  if (s === 'farmland' || s === 'dirt_path') return face === 'down' ? FULL : face === 'up' ? NONE : CENTER;
  if (s === 'honey_block' || reg.hasTag(blockId(state), 'minecraft:leaves')) return NONE;
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
  if (s === 'mangrove_roots') return FULL;
  if (s === 'composter') return face === 'up' ? RIGID : FULL;
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

/** MultifaceBlock.canAttachTo(level, d, neighbour): its face toward us is a full support or collision face */
const attaches = (c: SupportCtx, get: SupportGetter, x: number, y: number, z: number, d: Dir, faceOfNeighbour: Dir = OPPOSITE[d]): boolean => {
  const v = DIR_VEC[d];
  const s = get(x + v[0], y + v[1], z + v[2]);
  return s === undefined || c.attach(s, faceOfNeighbour);
};

/**
 * vanilla VineBlock.getUpdatedState: drop faces without support; returns the trimmed state or null
 * if unchanged. Quirk: `up` is tested with isAcceptableNeighbour(above, DOWN) → canAttachTo checks
 * the face DOWN.getOpposite() = the TOP face of the block above (a ceiling vine survives under a top
 * slab but pops under a bottom slab).
 */
function vineRule(x: number, y: number, z: number, state: string, get: SupportGetter, c: SupportCtx): Verdict | null {
  let st = state;
  let changed = false;
  if (propOf(st, 'up') === 'true' && !attaches(c, get, x, y, z, 'up', 'up')) {
    st = setProp(st, 'up', 'false');
    changed = true;
  }
  const above = get(x, y + 1, z);
  for (const d of HDIRS) {
    if (propOf(st, d) !== 'true') continue;
    if (attaches(c, get, x, y, z, d)) continue;
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
    if (attaches(c, get, x, y, z, d)) {
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
/** Block.canSupportCenter(level, above, DOWN): CENTER bottom face and not #unstable_bottom_center (fence gates) */
const canSupportCenterAbove = (c: SupportCtx, get: SupportGetter, x: number, y: number, z: number): boolean => {
  const a = get(x, y + 1, z);
  if (a === undefined) return true;
  return !c.tag(a, 'minecraft:unstable_bottom_center') && (c.face(a, 'down') & CENTER) === CENTER;
};
const ceilCenter: Rule = (x, y, z, _s, get, c) => (canSupportCenterAbove(c, get, x, y, z) ? null : { kind: KINDS.hanging });
/** hanging signs test isFaceSturdy(above, DOWN, CENTER) directly (no unstable_bottom_center check) */
const ceilCenterSturdy: Rule = (x, y, z, _s, get, c) => (has(c, get, x, y, z, 'up', CENTER) ? null : { kind: KINDS.hanging });
const ceilFull: Rule = (x, y, z, _s, get, c) => (has(c, get, x, y, z, 'up', FULL) ? null : { kind: KINDS.hanging });
const floorFullCover: Rule = (x, y, z, _s, get, c) => (has(c, get, x, y, z, 'down', FULL) ? null : { kind: KINDS.cover });
// pressure plates: canSupportRigidBlock || canSupportCenter
const floorCenterCover: Rule = (x, y, z, _s, get, c) => (has(c, get, x, y, z, 'down', CENTER) || has(c, get, x, y, z, 'down', RIGID) ? null : { kind: KINDS.cover });
const floorRigid: Rule = (x, y, z, _s, get, c) => (has(c, get, x, y, z, 'down', RIGID) ? null : { kind: KINDS.cover });
/** BaseRailBlock.shouldBeRemoved: RIGID below, and for ascending rails RIGID on top of the block on the high side */
const railRule: Rule = (x, y, z, state, get, c) => {
  if (!has(c, get, x, y, z, 'down', RIGID)) return { kind: KINDS.cover };
  const shape = propOf(state, 'shape');
  if (shape?.startsWith('ascending_')) {
    const d = shape.slice(10) as HDir;
    const v = DIR_VEC[d];
    const n = get(x + v[0], y, z + v[2]);
    if (n !== undefined && (c.face(n, 'up') & RIGID) !== RIGID) return { kind: KINDS.cover, need: [x + v[0], y, z + v[2]] };
  }
  return null;
};
/** RedStoneWireBlock.canSurviveOn: sturdy top or a hopper */
const wireRule: Rule = (x, y, z, _s, get, c) => {
  const b = below(get, x, y, z);
  return b === undefined || c.face(b, 'up') === FULL || blockId(b) === 'minecraft:hopper' ? null : { kind: KINDS.cover };
};
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
  // SnowLayerBlock: Block.isFaceFull(collision shape, UP) — leaves and glass hold snow, paths do not
  return c.collisionFull(b, 'up') ? null : { kind: KINDS.cover };
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

/** FallingBlock.isFree: air, fire, liquids or replaceable blocks (snow layers, grass, vines …) */
const gravityRule: Rule = (x, y, z, _s, get, c) => {
  const b = below(get, x, y, z);
  if (b === undefined) return null;
  const free = isAir(b) || isFluidState(b) || c.tag(b, 'minecraft:fire') || c.flag(b, PF.REPLACEABLE, () => c.tag(b, 'minecraft:replaceable'));
  return free ? { kind: KINDS.gravity, warnOnly: true } : null;
};

/**
 * BellBlock.canSurvive: floor → sturdy top below, ceiling → canSupportCenter(above, DOWN),
 * single_wall → sturdy face on the facing side; double_wall never pops (updateShape skips it).
 */
const bellRule: Rule = (x, y, z, state, get, c) => {
  const a = propOf(state, 'attachment');
  if (a === 'double_wall') return null;
  if (a === 'floor') return has(c, get, x, y, z, 'down', FULL) ? null : { kind: KINDS.bell, need: [x, y - 1, z] };
  if (a === 'ceiling') return canSupportCenterAbove(c, get, x, y, z) ? null : { kind: KINDS.bell, need: [x, y + 1, z] };
  const f = propOf(state, 'facing') as Dir;
  const v = DIR_VEC[f];
  return has(c, get, x, y, z, f, FULL) ? null : { kind: KINDS.bell, need: [x + v[0], y, z + v[2]] };
};

/**
 * MushroomBlock.canSurvive: below #overrides_mushroom_light_requirement (mycelium, podzol, nylium)
 * → ok; else raw brightness < 13 and a solid-render block below. Light is approximated from sky
 * exposure only (block light from torches is ignored): the mushroom pops if its own cell or a
 * see-through cell within 2 steps has open sky above (sky light ≥ 13 there). Columns that run into
 * unknown cells before 8 known cells count as covered (assume a cave/indoors → keep).
 */
const mushroomRule: Rule = (x, y, z, _s, get, c) => {
  const b = below(get, x, y, z);
  if (b === undefined) return null;
  if (c.tag(b, 'minecraft:overrides_mushroom_light_requirement')) return null;
  if (!c.flag(b, PF.SOLID_RENDER, () => c.reg.isFullSolid(b) && !c.reg.isTransparent(b))) return { kind: KINDS.plant };
  return skyLit(c, get, x, y, z) ? { kind: KINDS.plant } : null;
};

/** does sky light ≥ 13 reach (x,y,z)? (open column at distance ≤ 2 through non-opaque cells) */
function skyLit(c: SupportCtx, get: SupportGetter, x: number, y: number, z: number): boolean {
  const passes = (s: string) => isAir(s) || !c.flag(s, PF.SOLID_RENDER, () => !c.reg.isTransparent(s));
  const open = (px: number, py: number, pz: number): boolean => {
    let known = 0;
    for (let yy = py + 1; yy <= py + 384; yy++) {
      const s = get(px, yy, pz);
      if (s === undefined) return known >= 8;
      if (!isAir(s) && !c.flag(s, PF.SKYLIGHT, () => false)) return false;
      known++;
    }
    return true;
  };
  // BFS over see-through cells, distance ≤ 2 (sky light 15 - distance ≥ 13)
  const seen = new Set<string>([`${x},${y},${z}`]);
  let frontier: Vec3[] = [[x, y, z]];
  for (let d = 0; d <= 2; d++) {
    const next: Vec3[] = [];
    for (const [px, py, pz] of frontier) {
      if (open(px, py, pz)) return true;
      if (d === 2) continue;
      for (const dir of DIRS) {
        const v = DIR_VEC[dir];
        const q: Vec3 = [px + v[0], py + v[1], pz + v[2]];
        const k = `${q[0]},${q[1]},${q[2]}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const s = get(q[0], q[1], q[2]);
        if (s === undefined || !passes(s)) continue;
        next.push(q);
      }
    }
    frontier = next;
  }
  return false;
}

/** ChorusPlantBlock.canSurvive (scheduled tick → the plant breaks) */
const chorusPlantRule: Rule = (x, y, z, _s, get, c) => {
  const isPlant = (s: string | undefined) => s !== undefined && blockId(s) === 'minecraft:chorus_plant';
  const b = below(get, x, y, z);
  const a = get(x, y + 1, z);
  if (b === undefined || a === undefined) return null;
  const aboveOrBelow = !isAir(a) && !isAir(b);
  for (const d of HDIRS) {
    const v = DIR_VEC[d];
    const n = get(x + v[0], y, z + v[2]);
    if (n === undefined) return null;
    if (!isPlant(n)) continue;
    if (aboveOrBelow) return { kind: KINDS.plant };
    const nb = get(x + v[0], y - 1, z + v[2]);
    if (nb === undefined || isPlant(nb) || c.tag(nb, 'minecraft:supports_chorus_plant')) return null;
  }
  return isPlant(b) || c.tag(b, 'minecraft:supports_chorus_plant') ? null : { kind: KINDS.plant };
};

/** ChorusFlowerBlock.canSurvive */
const chorusFlowerRule: Rule = (x, y, z, _s, get, c) => {
  const b = below(get, x, y, z);
  if (b === undefined) return null;
  if (blockId(b) === 'minecraft:chorus_plant' || c.tag(b, 'minecraft:supports_chorus_flower')) return null;
  if (!isAir(b)) return { kind: KINDS.plant };
  let one = false;
  for (const d of HDIRS) {
    const v = DIR_VEC[d];
    const n = get(x + v[0], y, z + v[2]);
    if (n === undefined) return null;
    if (blockId(n) === 'minecraft:chorus_plant') {
      if (one) return { kind: KINDS.plant };
      one = true;
    } else if (!isAir(n)) return { kind: KINDS.plant };
  }
  return one ? null : { kind: KINDS.plant };
};

/** FarmlandBlock / PathBlock.canSurvive: turn into dirt under a legacy-solid block (not fence gates; farmland keeps crops) */
const soilRule: Rule = (x, y, z, state, get, c) => {
  const a = get(x, y + 1, z);
  if (a === undefined || !solidish(c, a)) return null;
  if (c.tag(a, 'minecraft:fence_gates')) return null;
  if (blockId(state) === 'minecraft:farmland' && c.tag(a, 'minecraft:maintains_farmland')) return null;
  return { kind: KINDS.soil, trim: 'minecraft:dirt', need: [x, y + 1, z] };
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
  // WallHangingSignBlock has no canSurvive (only placement checks the sides) → never pops
  if (s.endsWith('_wall_hanging_sign')) return null;
  if (s === 'bell') return bellRule;
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
  // CandleBlock.updateShape has no survival check (only placement needs a sturdy centre) → never pops
  if (tag('candles') || s === 'candle' || s.endsWith('_candle')) return null;
  if (s.endsWith('candle_cake') || s === 'cake') return solidBelow(KINDS.floor);
  if (s.endsWith('_hanging_sign')) return ceilCenterSturdy;
  if (s.endsWith('_sign') || (s.endsWith('_banner') && !s.includes('wall'))) return solidBelow(KINDS.floor);
  if (s === 'hanging_roots') return ceilFull;
  if (s === 'spore_blossom') return ceilCenter;
  if (s === 'cave_vines' || s === 'cave_vines_plant') return stackOr(['minecraft:cave_vines', 'minecraft:cave_vines_plant'], 'up', ceilFull, KINDS.hanging);
  if (s === 'weeping_vines' || s === 'weeping_vines_plant') return stackOr(['minecraft:weeping_vines', 'minecraft:weeping_vines_plant'], 'up', ceilFull, KINDS.hanging);
  if (s === 'twisting_vines' || s === 'twisting_vines_plant') return stackOr(['minecraft:twisting_vines', 'minecraft:twisting_vines_plant'], 'down', floorFullCover, KINDS.cover);
  if (s === 'pale_hanging_moss')
    return stackOr(['minecraft:pale_hanging_moss'], 'up', (x, y, z, _st, get, c) => (attaches(c, get, x, y, z, 'up') ? null : { kind: KINDS.hanging }), KINDS.hanging);
  if (s === 'pointed_dripstone') return dripstone;
  // floor covers
  if (s.endsWith('_carpet')) return notEmptyBelow;
  if (tag('pressure_plates')) return floorCenterCover;
  if (tag('rails')) return railRule;
  if (s === 'repeater' || s === 'comparator') return floorRigid;
  if (s === 'redstone_wire') return wireRule;
  if (s === 'farmland' || s === 'dirt_path') return soilRule;
  if (s === 'snow') return snowRule;
  if (s === 'leaf_litter') return floorFullCover;
  if (tag('doors')) return doubleLowerHalf(floorFullCover);
  if (s === 'scaffolding') return scaffoldingRule;
  // water plants
  if (s === 'lily_pad') return waterBelow;
  if (s === 'seagrass') return seaFloor([], 'cannot_support_seagrass');
  if (s === 'tall_seagrass') return doubleLowerHalf(seaFloor([], 'cannot_support_seagrass'));
  if (s === 'kelp' || s === 'kelp_plant') return seaFloor(['minecraft:kelp', 'minecraft:kelp_plant'], 'cannot_support_kelp');
  // SeaPickleBlock.mayPlaceOn: non-empty collision top face or a sturdy top
  if (s === 'sea_pickle')
    return (x, y, z, _st, get, c) => {
      const b = below(get, x, y, z);
      if (b === undefined) return null;
      const ok = c.face(b, 'up') === FULL || c.flag(b, PF.COLLISION_TOP, () => c.face(b, 'up') !== NONE);
      return ok ? null : { kind: KINDS.water };
    };
  // BaseCoralPlantTypeBlock (live + dead corals and coral fans): sturdy top below
  if (tag('corals') || tag('coral_plants') || s.endsWith('_coral_fan') || s.endsWith('_coral')) return (x, y, z, st, get, c) => (has(c, get, x, y, z, 'down', FULL) ? null : { kind: KINDS.water });
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
  // SmallDripleafBlock.mayPlaceOn: #supports_small_dripleaf, or #supports_vegetation with a water source in its own cell
  if (s === 'small_dripleaf')
    return doubleLowerHalf((x, y, z, st, get, c) => {
      const b = below(get, x, y, z);
      if (b === undefined || c.tag(b, 'minecraft:supports_small_dripleaf')) return null;
      return propOf(st, 'waterlogged') === 'true' && c.tag(b, 'minecraft:supports_vegetation') ? null : { kind: KINDS.plant };
    });
  if (s === 'big_dripleaf') return stackOr(['minecraft:big_dripleaf', 'minecraft:big_dripleaf_stem'], 'down', plantOn('supports_big_dripleaf'), KINDS.plant);
  if (s === 'big_dripleaf_stem')
    return (x, y, z, st, get, c) => {
      const a = get(x, y + 1, z);
      if (a !== undefined && blockId(a) !== 'minecraft:big_dripleaf' && blockId(a) !== 'minecraft:big_dripleaf_stem') return { kind: KINDS.plant };
      return stackOr(['minecraft:big_dripleaf_stem'], 'down', plantOn('supports_big_dripleaf'), KINDS.plant)(x, y, z, st, get, c);
    };
  if (s === 'brown_mushroom' || s === 'red_mushroom') return mushroomRule;
  if (s === 'chorus_flower') return chorusFlowerRule;
  if (s === 'chorus_plant') return chorusPlantRule;
  if (s === 'mangrove_propagule')
    return (x, y, z, st, get, c) => {
      if (propOf(st, 'hanging') !== 'true') return plantOn('supports_mangrove_propagule')(x, y, z, st, get, c);
      const a = get(x, y + 1, z);
      return a === undefined || c.tag(a, 'minecraft:supports_hanging_mangrove_propagule') ? null : { kind: KINDS.hanging };
    };
  // CactusFlowerBlock.mayPlaceOn: #support_override_cactus_flower or a sturdy centre on top
  if (s === 'cactus_flower')
    return (x, y, z, _st, get, c) => {
      const b = below(get, x, y, z);
      if (b === undefined || c.tag(b, 'minecraft:support_override_cactus_flower')) return null;
      return (c.face(b, 'up') & CENTER) === CENTER ? null : { kind: KINDS.plant };
    };
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
  // re-queue neighbours of changes
  let queue: Vec3[] = [...seeds];
  const maxChanges = opts.maxChanges ?? 2_000_000;
  const warned = new Set<string>();
  const soil = (p: Vec3): number => {
    const st = g(p[0], p[1], p[2]);
    return st !== undefined && (st.startsWith('minecraft:farmland') || st.startsWith('minecraft:dirt_path')) ? 0 : 1;
  };
  for (let round = 0; round < 64 && queue.length; round++) {
    // farmland/dirt paths first (they become dirt under a solid block, which then supports it),
    // then top-down so hanging chains resolve in one pass
    queue.sort((a, b) => soil(a) - soil(b) || b[1] - a[1]);
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
    const what =
      kind === KINDS.soil
        ? `${verb === 'dropped' ? 'turned' : verb} ${l.length} ${kind.label} into dirt`
        : k.endsWith(':trim')
          ? `trimmed ${l.length} ${kind.label} (unsupported faces removed)`
          : `${verb} ${l.length} ${kind.label}`;
    out.push(`${what} — ${kind.msg}; e.g. ${samples}`);
  }
  return out;
}

/**
 * Vanilla FarmlandBlock/PathBlock: after a placement, farmland and dirt paths at or directly below
 * the given positions turn into dirt when a legacy-solid block sits on them (their updateShape
 * schedules a tick that calls turnToBaseBlock). Used by the simulation to mirror the real game;
 * EditSession applies the same rule through resolveSupport (kind `soil`, both blocks).
 * `paths: false` mirrors the mod's set_blocks shape pass, which skips blocks without properties
 * (dirt_path has none, so it is never shape-updated and keeps its id until a later vanilla update).
 */
export function soilConversions(
  get: (x: number, y: number, z: number) => string,
  positions: Iterable<Vec3>,
  reg: Registry,
  opts: { paths?: boolean } = {},
): Array<[number, number, number, string]> {
  const c = ctxFor(reg);
  const paths = opts.paths ?? true;
  const out: Array<[number, number, number, string]> = [];
  const seen = new Set<string>();
  for (const [px, py, pz] of positions) {
    for (const y of [py, py - 1]) {
      const k = `${px},${y},${pz}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const st = get(px, y, pz);
      if (!st.startsWith('minecraft:farmland') && !(paths && st.startsWith('minecraft:dirt_path'))) continue;
      const v = soilRule(px, y, pz, st, get, c);
      if (v?.trim) out.push([px, y, pz, v.trim]);
    }
  }
  return out;
}
