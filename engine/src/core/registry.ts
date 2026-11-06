// Block registry: validation, canonicalization, fuzzy search and shape heuristics.
// See docs/ENGINE-API.md (core-geometry) and docs/ARCHITECTURE.md §3.
//
// Heuristic decisions (documented here because connections, masks and the renderer rely on them):
//  * isFullSolid = "occupies the full 1x1x1 cube with a full (sturdy) face on every side".
//    Glass, leaves, ice, shulker boxes, spawners count as full. Stairs, slabs (except
//    type=double), fences, walls, panes, doors, trapdoors, plants, carpets, rails, chests,
//    beds, lanterns, heads, farmland/dirt path, snow (except layers=8), extended pistons,
//    liquids and air do not.
//    Vanilla fences/walls/panes do NOT connect to leaves, pumpkins, melons, barriers or
//    shulker boxes even though those are full cubes (Block.isExceptionForConnection) — that
//    exception lives in connect.ts, not here.
//  * isTransparent = "does not fully hide the faces of neighbours" (rendering / face culling):
//    every non-full block plus glass, leaves, ice, slime, spawners, beacons, grates, barriers.
import { readFileSync } from 'node:fs';
import type { BlockInfo, BlockRegistry } from './types.ts';
import { blockId, formatBlockState, normalizeId, parseBlockState, BlockStateError } from './blockstate.ts';

export class RegistryError extends Error {
  /** suggested ids / values (without namespace), if any */
  suggestions: string[];
  constructor(message: string, suggestions: string[] = []) {
    super(message);
    this.name = 'RegistryError';
    this.suggestions = suggestions;
  }
}

// ---------------------------------------------------------------------------------------
// fuzzy helpers

export function levenshtein(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  if (!la) return lb;
  if (!lb) return la;
  let prev = new Array<number>(lb + 1);
  let cur = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[lb];
}

/** quality of matching one query word against one id word, 0..1 */
function wordMatch(t: string, u: string): number {
  if (t === u) return 1;
  if (u === t + 's' || t === u + 's' || u === t + 'es' || t === u + 'es') return 0.9;
  if (t.length >= 3 && u.startsWith(t)) return 0.6 + (0.3 * t.length) / u.length;
  if (u.length >= 3 && t.startsWith(u)) return 0.5;
  if (t.length >= 4) {
    const d = levenshtein(t, u, 2);
    if (d === 1) return 0.7;
    if (d === 2 && t.length >= 6) return 0.5;
  }
  return 0;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/^minecraft:/, '')
    .split(/[\s_:\-]+/)
    .filter(Boolean);
}

/** Common names the agent may use that are not (or no longer) vanilla ids. */
const ALIASES: Record<string, string[]> = {
  grass: ['short_grass', 'grass_block'],
  grass_path: ['dirt_path'],
  path: ['dirt_path'],
  cobble: ['cobblestone'],
  mossy_cobble: ['mossy_cobblestone'],
  plank: ['oak_planks'],
  planks: ['oak_planks'],
  wood: ['oak_planks', 'oak_wood', 'oak_log'],
  wooden_planks: ['oak_planks'],
  log: ['oak_log'],
  logs: ['oak_log'],
  leaves: ['oak_leaves'],
  brick: ['bricks'],
  brick_block: ['bricks'],
  stone_brick: ['stone_bricks'],
  nether_brick: ['nether_bricks'],
  chain: ['iron_chain'],
  wool: ['white_wool'],
  concrete: ['white_concrete'],
  carpet: ['white_carpet'],
  glass_panel: ['glass_pane'],
  pane: ['glass_pane'],
  lamp: ['redstone_lamp'],
  redstone: ['redstone_wire', 'redstone_block'],
  redstone_dust: ['redstone_wire'],
  quartz: ['quartz_block'],
  sign: ['oak_sign'],
  wall_sign: ['oak_wall_sign'],
  door: ['oak_door'],
  bed: ['red_bed'],
  snow_layer: ['snow'],
  rose: ['poppy', 'rose_bush'],
  flower: ['poppy', 'dandelion'],
  stained_glass: ['white_stained_glass'],
  terracotta_block: ['terracotta'],
  hardened_clay: ['terracotta'],
  stone_slab: ['stone_slab', 'smooth_stone_slab'],
  double_slab: ['smooth_stone_slab[type=double]'],
  sea_lantern_block: ['sea_lantern'],
  web: ['cobweb'],
  workbench: ['crafting_table'],
  netherbrick: ['nether_bricks'],
  lit_pumpkin: ['jack_o_lantern'],
  jack_o_lantern: ['jack_o_lantern'],
};

// ---------------------------------------------------------------------------------------
// solidity heuristics (per id; state-dependent overrides in Registry)

const NOT_FULL_RE = new RegExp(
  [
    '_stairs$',
    '_slab$',
    '_fence$',
    '_fence_gate$',
    '_wall$',
    '_pane$',
    '_bars$',
    '_door$',
    '_trapdoor$',
    'sign$',
    '_banner$',
    '_button$',
    'pressure_plate$',
    '_carpet$',
    'rail$',
    'torch$',
    '(?<!sea_|jack_o_)lantern$',
    '_chain$',
    '_bed$',
    'candle',
    '^potted_',
    '_head$',
    '_skull$',
    '_bud$',
    '_coral$',
    '_coral_fan$',
    '_coral_wall_fan$',
    '_sapling$',
    '_shelf$',
    'lightning_rod$',
    'golem_statue$',
    'chest$',
    '_stem$', // melon_stem, pumpkin_stem, big_dripleaf_stem (crimson_stem/warped_stem handled below)
    '_tulip$',
    '_mushroom$',
    '_roots$', // crimson_roots, warped_roots, hanging_roots (mangrove_roots handled below)
    '_fungus$',
    '_vines$',
    '_vines_plant$',
    'cauldron$',
    'anvil$',
    'campfire$',
    'fire$',
    '_portal$',
    '_propagule$',
    'eyeblossom$',
    '_grass$',
    '_fern$',
    '_bush$',
  ].join('|'),
);

const FULL_OVERRIDE = new Set([
  'crimson_stem',
  'warped_stem',
  'stripped_crimson_stem',
  'stripped_warped_stem',
  'mushroom_stem',
  'brown_mushroom_block',
  'red_mushroom_block',
  'mangrove_roots',
  'muddy_mangrove_roots',
  'sea_lantern',
  'jack_o_lantern',
  'grass_block',
]);

const NOT_FULL_IDS = new Set([
  'air', 'cave_air', 'void_air', 'water', 'lava', 'bubble_column', 'light', 'structure_void',
  'moving_piston', 'piston_head', 'cobweb', 'cake', 'brewing_stand', 'enchanting_table', 'lectern',
  'stonecutter', 'grindstone', 'bell', 'daylight_detector', 'end_portal_frame', 'end_portal',
  'end_gateway', 'farmland', 'dirt_path', 'honey_block', 'scaffolding', 'composter', 'hopper',
  'conduit', 'bamboo', 'bamboo_sapling', 'cactus', 'cactus_flower', 'dragon_egg', 'chorus_plant',
  'spore_blossom', 'sculk_vein', 'sculk_sensor', 'calibrated_sculk_sensor', 'sculk_shrieker',
  'big_dripleaf', 'small_dripleaf', 'azalea', 'flowering_azalea', 'pale_hanging_moss', 'leaf_litter',
  'pink_petals', 'wildflowers', 'decorated_pot', 'sea_pickle', 'turtle_egg', 'sniffer_egg', 'frogspawn',
  'lily_pad', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'pointed_dripstone', 'sulfur_spike',
  'end_rod', 'ladder', 'vine', 'glow_lichen', 'resin_clump', 'tripwire', 'tripwire_hook', 'lever',
  'redstone_wire', 'repeater', 'comparator', 'snow', 'heavy_core', 'dried_ghast', 'shelf_mushroom',
  'red_shrub', 'nether_wart', 'sweet_berry_bush', 'cocoa', 'torchflower', 'torchflower_crop',
  'pitcher_crop', 'pitcher_plant', 'attached_melon_stem', 'attached_pumpkin_stem', 'nether_sprouts',
  'wheat', 'carrots', 'potatoes', 'beetroots', 'flower_pot', 'amethyst_cluster', 'sunflower', 'lilac',
  'rose_bush', 'peony', 'tall_grass', 'large_fern', 'fern', 'dead_bush', 'short_grass', 'bush',
  'poppy', 'dandelion', 'golden_dandelion', 'allium', 'azure_bluet', 'blue_orchid', 'cornflower',
  'lily_of_the_valley', 'oxeye_daisy', 'wither_rose', 'sugar_cane', 'chest', 'ender_chest',
  'trapped_chest', 'moss_carpet', 'pale_moss_carpet', 'firefly_bush', 'short_dry_grass', 'tall_dry_grass',
  'iron_chain',
]);

/** full cubes that you can see through (render) */
const SEE_THROUGH_RE = /(^|_)glass$|_leaves$|^ice$|^frosted_ice$|^slime_block$|^honey_block$|^spawner$|^trial_spawner$|^vault$|^beacon$|^barrier$|copper_grate$|^mangrove_roots$|^structure_void$|^light$|^chorus_flower$/;

function idFull(id: string): boolean {
  const n = id.startsWith('minecraft:') ? id.slice(10) : id;
  if (FULL_OVERRIDE.has(n)) return true;
  if (NOT_FULL_IDS.has(n)) return false;
  if (NOT_FULL_RE.test(n)) return false;
  return true;
}

// ---------------------------------------------------------------------------------------

interface Entry {
  id: string; // namespaced
  short: string; // without 'minecraft:'
  info: BlockInfo;
  propNames: string[]; // sorted
  tags: Set<string>;
  tokens: string[];
  full: boolean;
  seeThrough: boolean;
}

const MAX_CACHE = 200_000;
let defaultRegistry: Registry | null = null;

export class Registry {
  readonly version: string;
  readonly data: BlockRegistry;
  private entries = new Map<string, Entry>();
  private canonCache = new Map<string, string>();
  private fullCache = new Map<string, boolean>();
  private transCache = new Map<string, boolean>();
  private idList: string[];

  constructor(data: BlockRegistry) {
    this.data = data;
    this.version = data.version;
    for (const [rawId, info] of Object.entries(data.blocks)) {
      const id = normalizeId(rawId);
      const short = id.startsWith('minecraft:') ? id.slice(10) : id;
      const tags = new Set<string>();
      for (const t of info.tags ?? []) tags.add(normalizeId(t.replace(/^#/, '')));
      this.entries.set(id, {
        id,
        short,
        info,
        propNames: Object.keys(info.properties).sort(),
        tags,
        tokens: tokenize(short),
        full: info.solid === false ? false : idFull(id),
        seeThrough: SEE_THROUGH_RE.test(short),
      });
    }
    this.idList = [...this.entries.keys()].sort();
  }

  static loadDefault(): Registry {
    if (!defaultRegistry) {
      const url = new URL('../../data/registry-26.3.json', import.meta.url);
      defaultRegistry = new Registry(JSON.parse(readFileSync(url, 'utf8')) as BlockRegistry);
    }
    return defaultRegistry;
  }

  has(id: string): boolean {
    return this.entries.has(normalizeId(stripState(id)));
  }

  info(id: string): BlockInfo | undefined {
    return this.entries.get(normalizeId(stripState(id)))?.info;
  }

  ids(): string[] {
    return this.idList.slice();
  }

  /** Validate + canonicalize (namespace, all properties, sorted). Keeps SNBT verbatim. */
  canonical(state: string): string {
    const hit = this.canonCache.get(state);
    if (hit !== undefined) return hit;
    const brace = state.indexOf('{');
    let out: string;
    if (brace >= 0) {
      const head = state.slice(0, brace);
      const nbt = state.slice(brace).trim();
      if (!nbt.endsWith('}')) throw new RegistryError(`Bad block state "${state}": SNBT must end with "}"`);
      if (!head.trim()) throw new RegistryError(`Bad block state "${state}": missing block id before SNBT`);
      out = this.canonical(head) + nbt;
      return out; // do not cache potentially huge SNBT strings
    }
    out = this.canonicalHead(state);
    if (this.canonCache.size >= MAX_CACHE) this.canonCache.clear();
    this.canonCache.set(state, out);
    return out;
  }

  tryCanonical(state: string): { ok: true; state: string } | { ok: false; error: string } {
    try {
      return { ok: true, state: this.canonical(state) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  private canonicalHead(state: string): string {
    let parsed;
    try {
      parsed = parseBlockState(state);
    } catch (e) {
      if (e instanceof BlockStateError) throw new RegistryError(`Bad block state syntax: ${e.message}. Expected e.g. "oak_stairs[facing=east,half=top]"`);
      throw e;
    }
    const entry = this.entries.get(parsed.name);
    if (!entry) {
      const sugg = this.suggest(parsed.name, 5);
      throw new RegistryError(
        `Unknown block "${parsed.name}"` + (sugg.length ? `. Did you mean: ${sugg.join(', ')}?` : '. Use block search to find valid ids.'),
        sugg,
      );
    }
    const props: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.props)) {
      const allowed = entry.info.properties[k];
      if (!allowed) {
        if (!entry.propNames.length)
          throw new RegistryError(`Block ${entry.id} has no properties (got "${k}=${v}"). Use just "${entry.short}".`);
        throw new RegistryError(
          `Block ${entry.id} has no property "${k}". Valid properties: ${this.describeProps(entry)}`,
          entry.propNames,
        );
      }
      if (!allowed.includes(v)) {
        throw new RegistryError(
          `Invalid value "${v}" for property "${k}" of ${entry.id}. Valid values: ${allowed.join(', ')}`,
          allowed,
        );
      }
      props[k] = v;
    }
    for (const k of entry.propNames) if (!(k in props)) props[k] = entry.info.default[k];
    return formatBlockState({ name: entry.id, props });
  }

  private describeProps(e: Entry): string {
    return e.propNames.map((k) => `${k}=${e.info.properties[k].join('|')}`).join(', ');
  }

  /** Did-you-mean suggestions for an unknown id (short ids, best first). */
  suggest(query: string, limit = 5): string[] {
    const q = normalizeId(stripState(query)).replace(/^minecraft:/, '').replace(/\s+/g, '_');
    const out: string[] = [];
    for (const a of ALIASES[q] ?? []) if (this.has(a) && !out.includes(a)) out.push(a);
    const qt = tokenize(q);
    const scored: [number, string][] = [];
    for (const e of this.entries.values()) {
      const s = scoreCandidate(q, qt, e.short, e.tokens);
      if (s > 0.3) scored.push([s, e.short]);
    }
    scored.sort((a, b) => b[0] - a[0] || a[1].length - b[1].length || (a[1] < b[1] ? -1 : 1));
    for (const [, id] of scored) {
      if (out.length >= limit) break;
      if (!out.includes(id)) out.push(id);
    }
    return out.slice(0, limit);
  }

  hasTag(id: string, tag: string): boolean {
    const e = this.entries.get(normalizeId(stripState(id)));
    if (!e) return false;
    return e.tags.has(normalizeId(tag.replace(/^#/, '')));
  }

  /** all ids carrying a tag (namespaced) */
  tagMembers(tag: string): string[] {
    const t = normalizeId(tag.replace(/^#/, ''));
    return this.idList.filter((id) => this.entries.get(id)!.tags.has(t));
  }

  /** Fuzzy search by id words: 'red wool' -> minecraft:red_wool, … Returns namespaced ids. */
  search(query: string, opts: { tag?: string; limit?: number } = {}): string[] {
    const limit = opts.limit ?? 20;
    const tag = opts.tag ? normalizeId(opts.tag.replace(/^#/, '')) : null;
    const qt = tokenize(query);
    const cands = [...this.entries.values()].filter((e) => !tag || e.tags.has(tag));
    if (!qt.length) return cands.slice(0, limit).map((e) => e.id);
    const scored: [number, number, Entry][] = [];
    for (const e of cands) {
      let sum = 0;
      let ok = true;
      for (const t of qt) {
        let best = 0;
        for (const u of e.tokens) best = Math.max(best, wordMatch(t, u));
        if (best < 0.5 && e.short.includes(t)) best = 0.5;
        if (best < 0.5) {
          ok = false;
          break;
        }
        sum += best;
      }
      if (!ok) continue;
      let covered = 0;
      for (const u of e.tokens) if (qt.some((t) => wordMatch(t, u) >= 0.5)) covered++;
      scored.push([(0.7 * sum) / qt.length + (0.3 * covered) / e.tokens.length, covered / e.tokens.length, e]);
    }
    if (!scored.length && !tag) return this.suggest(query, limit).map((s) => normalizeId(stripState(s)));
    scored.sort((a, b) => b[0] - a[0] || b[1] - a[1] || a[2].short.length - b[2].short.length || (a[2].id < b[2].id ? -1 : 1));
    return scored.slice(0, limit).map((s) => s[2].id);
  }

  /** Heuristic: occupies the full cube with sturdy faces (see header comment). */
  isFullSolid(state: string): boolean {
    let v = this.fullCache.get(state);
    if (v === undefined) {
      v = this.computeFull(state);
      if (this.fullCache.size >= MAX_CACHE) this.fullCache.clear();
      this.fullCache.set(state, v);
    }
    return v;
  }

  /** Heuristic: neighbours' faces stay visible (glass, leaves, panes, air, plants, partial blocks …). */
  isTransparent(state: string): boolean {
    let v = this.transCache.get(state);
    if (v === undefined) {
      const e = this.entries.get(blockId(state));
      v = !e ? true : e.seeThrough || !this.isFullSolid(state);
      if (this.transCache.size >= MAX_CACHE) this.transCache.clear();
      this.transCache.set(state, v);
    }
    return v;
  }

  private computeFull(state: string): boolean {
    const id = blockId(state);
    const e = this.entries.get(id);
    if (!e) return false;
    const short = e.short;
    if (short.endsWith('_slab')) return propOf(state, 'type') === 'double';
    if (short === 'snow') return propOf(state, 'layers') === '8';
    if (short === 'piston' || short === 'sticky_piston') return propOf(state, 'extended') !== 'true';
    return e.full;
  }
}

/** value of a property in a state string (fast path, no validation); undefined if absent */
export function propOf(state: string, prop: string): string | undefined {
  const b = state.indexOf('[');
  const brace = state.indexOf('{');
  if (b < 0 || (brace >= 0 && brace < b)) return undefined;
  const e = state.indexOf(']', b);
  const body = state.slice(b + 1, e < 0 ? undefined : e);
  for (const part of body.split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === prop) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function stripState(s: string): string {
  let i = 0;
  while (i < s.length && s[i] !== '[' && s[i] !== '{') i++;
  return s.slice(0, i).trim();
}

function scoreCandidate(q: string, qt: string[], cand: string, ct: string[]): number {
  if (!qt.length) return 0;
  let sum = 0;
  for (const t of qt) {
    let best = 0;
    for (const u of ct) {
      const m = wordMatch(t, u);
      if (m > best) best = m;
    }
    sum += best;
  }
  const tokenScore = sum / qt.length;
  let covered = 0;
  for (const u of ct) if (qt.some((t) => wordMatch(t, u) >= 0.5)) covered++;
  const coverage = covered / ct.length;
  const maxLen = Math.max(q.length, cand.length);
  const whole = 1 - levenshtein(q, cand, maxLen) / maxLen;
  let s = 0.5 * tokenScore + 0.25 * coverage + 0.25 * whole;
  if (cand.includes(q) && q.length >= 3) s += 0.1;
  return s;
}
