/**
 * Block identity, block states, and the "did the model hallucinate?" guard.
 *
 * LLMs confidently emit `stone_brick` (singular), `oak_wood_planks`, or
 * `spruce_stair`. Vanilla rejects those and the fill silently fails, which is
 * the single most common way an AI build ends up half-finished. So we keep a
 * generated id set plus a corrector that repairs the usual mistakes before a
 * command ever reaches the server.
 */

import { rotateFacing, type Cardinal } from './geometry.js';

const WOODS = [
  'oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove',
  'cherry', 'bamboo', 'crimson', 'warped', 'pale_oak',
];

const COLORS = [
  'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black',
];

const STONE_FAMILIES = [
  'stone', 'cobblestone', 'mossy_cobblestone', 'stone_brick', 'mossy_stone_brick',
  'smooth_stone', 'granite', 'polished_granite', 'diorite', 'polished_diorite',
  'andesite', 'polished_andesite', 'deepslate', 'cobbled_deepslate',
  'polished_deepslate', 'deepslate_brick', 'deepslate_tile', 'tuff',
  'polished_tuff', 'tuff_brick', 'brick', 'mud_brick', 'sandstone',
  'smooth_sandstone', 'cut_sandstone', 'red_sandstone', 'smooth_red_sandstone',
  'cut_red_sandstone', 'prismarine', 'prismarine_brick', 'dark_prismarine',
  'nether_brick', 'red_nether_brick', 'quartz', 'smooth_quartz', 'purpur',
  'end_stone_brick', 'blackstone', 'polished_blackstone', 'polished_blackstone_brick',
  'resin_brick',
];

/** Families whose "block" form is pluralised (`stone_bricks`, not `stone_brick`). */
const PLURAL_BASE = new Set([
  'stone_brick', 'mossy_stone_brick', 'deepslate_brick', 'deepslate_tile',
  'tuff_brick', 'brick', 'mud_brick', 'prismarine_brick', 'nether_brick',
  'red_nether_brick', 'end_stone_brick', 'polished_blackstone_brick', 'resin_brick',
]);

function buildBlockSet(): Set<string> {
  const s = new Set<string>();
  const add = (...ids: string[]) => { for (const i of ids) s.add(i); };

  for (const w of WOODS) {
    const isNether = w === 'crimson' || w === 'warped';
    const logWord = isNether ? 'stem' : 'log';
    const plankWord = w === 'bamboo' ? 'bamboo_planks' : `${w}_planks`;
    add(plankWord, `${w}_${logWord}`, `stripped_${w}_${logWord}`,
      `${w}_${isNether ? 'hyphae' : 'wood'}`, `stripped_${w}_${isNether ? 'hyphae' : 'wood'}`,
      `${w}_stairs`, `${w}_slab`, `${w}_fence`, `${w}_fence_gate`, `${w}_door`,
      `${w}_trapdoor`, `${w}_button`, `${w}_pressure_plate`, `${w}_sign`,
      `${w}_hanging_sign`, `${w}_leaves`, `${w}_sapling`);
    if (w === 'bamboo') { add('bamboo_mosaic', 'bamboo_mosaic_stairs', 'bamboo_mosaic_slab', 'bamboo_block', 'stripped_bamboo_block'); s.delete('bamboo_leaves'); }
    if (isNether) { s.delete(`${w}_leaves`); s.delete(`${w}_sapling`); add(`${w}_fungus`, `${w}_roots`, `${w}_nylium`); }
  }

  for (const f of STONE_FAMILIES) {
    const base = PLURAL_BASE.has(f) ? `${f}s` : f;
    add(base, `${f}_stairs`, `${f}_slab`, `${f}_wall`);
  }
  // Families without a wall or with irregular names.
  add('quartz_block', 'quartz_pillar', 'chiseled_quartz_block', 'quartz_bricks',
    'purpur_block', 'purpur_pillar', 'chiseled_stone_bricks', 'cracked_stone_bricks',
    'chiseled_sandstone', 'chiseled_red_sandstone', 'chiseled_deepslate',
    'cracked_deepslate_bricks', 'cracked_deepslate_tiles', 'chiseled_tuff',
    'chiseled_tuff_bricks', 'chiseled_polished_blackstone', 'gilded_blackstone',
    'cracked_nether_bricks', 'chiseled_nether_bricks', 'chiseled_resin_bricks',
    'smooth_stone_slab', 'petrified_oak_slab', 'end_stone', 'calcite', 'dripstone_block',
    'basalt', 'smooth_basalt', 'polished_basalt', 'obsidian', 'crying_obsidian',
    'netherrack', 'soul_sand', 'soul_soil', 'magma_block', 'bedrock', 'amethyst_block',
    'budding_amethyst', 'copper_block', 'exposed_copper', 'weathered_copper',
    'oxidized_copper', 'cut_copper', 'exposed_cut_copper', 'weathered_cut_copper',
    'oxidized_cut_copper', 'cut_copper_stairs', 'cut_copper_slab', 'chiseled_copper',
    'copper_grate', 'copper_bulb', 'waxed_copper_block', 'waxed_cut_copper',
    'waxed_cut_copper_stairs', 'waxed_cut_copper_slab', 'waxed_oxidized_copper',
    'waxed_weathered_copper', 'waxed_exposed_copper');

  for (const c of COLORS) {
    add(`${c}_wool`, `${c}_carpet`, `${c}_concrete`, `${c}_concrete_powder`,
      `${c}_terracotta`, `${c}_glazed_terracotta`, `${c}_stained_glass`,
      `${c}_stained_glass_pane`, `${c}_bed`, `${c}_banner`, `${c}_shulker_box`,
      `${c}_candle`);
  }

  add('air', 'cave_air', 'void_air', 'water', 'lava', 'glass', 'glass_pane',
    'tinted_glass', 'iron_bars', 'iron_block', 'gold_block', 'diamond_block',
    'emerald_block', 'lapis_block', 'redstone_block', 'netherite_block',
    'coal_block', 'raw_iron_block', 'raw_copper_block', 'raw_gold_block',
    'bricks', 'bookshelf', 'chiseled_bookshelf', 'crafting_table', 'furnace',
    'blast_furnace', 'smoker', 'barrel', 'chest', 'trapped_chest', 'ender_chest',
    'anvil', 'enchanting_table', 'brewing_stand', 'cauldron', 'lectern',
    'grindstone', 'stonecutter', 'smithing_table', 'cartography_table',
    'fletching_table', 'loom', 'composter', 'bell', 'beacon', 'conduit',
    'jukebox', 'note_block', 'torch', 'wall_torch', 'soul_torch', 'lantern',
    'soul_lantern', 'sea_lantern', 'glowstone', 'shroomlight', 'redstone_lamp',
    'campfire', 'soul_campfire', 'end_rod', 'chain', 'scaffolding', 'ladder',
    'flower_pot', 'hay_block', 'dried_kelp_block', 'sponge', 'wet_sponge',
    'dirt', 'coarse_dirt', 'rooted_dirt', 'grass_block', 'podzol', 'mycelium',
    'farmland', 'dirt_path', 'mud', 'packed_mud', 'clay', 'gravel', 'sand',
    'red_sand', 'suspicious_sand', 'snow', 'snow_block', 'powder_snow', 'ice',
    'packed_ice', 'blue_ice', 'moss_block', 'moss_carpet', 'pale_moss_block',
    'sculk', 'sculk_catalyst', 'mangrove_roots', 'muddy_mangrove_roots',
    'melon', 'pumpkin', 'carved_pumpkin', 'jack_o_lantern', 'bamboo',
    'sugar_cane', 'cactus', 'vine', 'glow_lichen', 'lily_pad', 'sea_pickle',
    'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip',
    'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower',
    'lily_of_the_valley', 'torchflower', 'wither_rose', 'sunflower', 'lilac',
    'rose_bush', 'peony', 'pink_petals', 'short_grass', 'tall_grass', 'fern',
    'large_fern', 'dead_bush', 'brown_mushroom', 'red_mushroom',
    'azalea', 'flowering_azalea', 'azalea_leaves', 'flowering_azalea_leaves',
    'spore_blossom', 'big_dripleaf', 'small_dripleaf', 'hanging_roots',
    'cobweb', 'sculk_vein', 'amethyst_cluster', 'pointed_dripstone',
    'rail', 'powered_rail', 'detector_rail', 'activator_rail', 'redstone_wire',
    'repeater', 'comparator', 'observer', 'piston', 'sticky_piston', 'dispenser',
    'dropper', 'hopper', 'lever', 'tripwire_hook', 'target', 'lightning_rod',
    'daylight_detector', 'sculk_sensor', 'calibrated_sculk_sensor',
    'nether_portal', 'end_portal_frame', 'dragon_egg', 'respawn_anchor',
    'nether_wart_block', 'warped_wart_block', 'bone_block', 'infested_stone',
    'decorated_pot', 'armor_stand', 'item_frame', 'painting', 'structure_void',
    'light', 'barrier', 'iron_door', 'iron_trapdoor', 'polished_blackstone_button',
    'stone_button', 'stone_pressure_plate', 'creaking_heart', 'heavy_core');

  return s;
}

export const BLOCK_IDS: ReadonlySet<string> = buildBlockSet();

/** Blocks that carry a `facing` state we should rotate. */
const FACING_SUFFIXES = [
  '_stairs', '_door', '_trapdoor', '_fence_gate', '_button', '_glazed_terracotta',
  '_bed', '_wall_sign', '_hanging_sign', '_anvil',
];
const FACING_EXACT = new Set([
  'furnace', 'blast_furnace', 'smoker', 'chest', 'trapped_chest', 'ender_chest',
  'barrel', 'lectern', 'grindstone', 'stonecutter', 'loom', 'observer', 'piston',
  'sticky_piston', 'dispenser', 'dropper', 'hopper', 'campfire', 'soul_campfire',
  'wall_torch', 'ladder', 'end_rod', 'jack_o_lantern', 'carved_pumpkin', 'anvil',
]);

export function hasFacing(id: string): boolean {
  if (FACING_EXACT.has(id)) return true;
  return FACING_SUFFIXES.some((s) => id.endsWith(s));
}

export interface ParsedBlock {
  id: string;
  states: Record<string, string>;
  /** NBT / component tail, e.g. `{Items:[...]}`. Preserved verbatim. */
  data?: string;
}

const BLOCK_RE = /^([a-z0-9_:.\-]+)(\[[^\]]*\])?(\{.*\})?$/i;

export function parseBlock(spec: string): ParsedBlock {
  const trimmed = spec.trim();
  const m = BLOCK_RE.exec(trimmed);
  if (!m) return { id: trimmed.toLowerCase(), states: {} };
  const id = m[1].toLowerCase().replace(/^minecraft:/, '');
  const states: Record<string, string> = {};
  if (m[2]) {
    const inner = m[2].slice(1, -1);
    for (const pair of inner.split(',')) {
      const [k, v] = pair.split('=');
      if (k && v !== undefined) states[k.trim()] = v.trim();
    }
  }
  return { id, states, data: m[3] };
}

export function formatBlock(b: ParsedBlock): string {
  const keys = Object.keys(b.states).sort();
  const st = keys.length ? `[${keys.map((k) => `${k}=${b.states[k]}`).join(',')}]` : '';
  return `${b.id}${st}${b.data ?? ''}`;
}

/** Attach or override block states on a spec string. */
export function withStates(spec: string, states: Record<string, string | number>): string {
  const b = parseBlock(spec);
  for (const [k, v] of Object.entries(states)) b.states[k] = String(v);
  return formatBlock(b);
}

/** Rotate a block spec's `facing`/`axis`/`rotation` states about Y. */
export function rotateBlockSpec(spec: string, deg: 0 | 90 | 180 | 270): string {
  if (deg === 0) return spec;
  const b = parseBlock(spec);
  let changed = false;
  if (b.states.facing && ['north', 'east', 'south', 'west'].includes(b.states.facing)) {
    b.states.facing = rotateFacing(b.states.facing as Cardinal, deg);
    changed = true;
  }
  if (b.states.axis === 'x' || b.states.axis === 'z') {
    if (deg === 90 || deg === 270) { b.states.axis = b.states.axis === 'x' ? 'z' : 'x'; changed = true; }
  }
  if (b.states.rotation !== undefined) {
    const r = Number(b.states.rotation);
    if (Number.isFinite(r)) { b.states.rotation = String((r + (deg / 90) * 4) & 15); changed = true; }
  }
  return changed ? formatBlock(b) : spec;
}

/** Mirror a block spec's facing across an axis plane. */
export function mirrorBlockSpec(spec: string, axis: 'x' | 'z'): string {
  const b = parseBlock(spec);
  const f = b.states.facing;
  if (!f) return spec;
  if (axis === 'x' && (f === 'east' || f === 'west')) b.states.facing = f === 'east' ? 'west' : 'east';
  else if (axis === 'z' && (f === 'north' || f === 'south')) b.states.facing = f === 'north' ? 'south' : 'north';
  else return spec;
  return formatBlock(b);
}

// ── Hallucination repair ──────────────────────────────────────────────────

/** Rewrites that fix the mistakes models actually make, in priority order. */
const REWRITES: Array<[RegExp, string]> = [
  [/^minecraft:/, ''],
  [/_stair$/, '_stairs'],
  [/_slabs$/, '_slab'],
  [/_fences$/, '_fence'],
  [/_doors$/, '_door'],
  [/_planks?$/, '_planks'],
  [/_wood_planks$/, '_planks'],
  [/^wooden_/, 'oak_'],
  [/^wood_/, 'oak_'],
  [/_logs$/, '_log'],
  [/_leaf$/, '_leaves'],
  [/^grass$/, 'short_grass'],
  [/^stone_brick$/, 'stone_bricks'],
  [/^brick$/, 'bricks'],
  [/^cobble$/, 'cobblestone'],
  [/^glass_panes$/, 'glass_pane'],
  [/_glass_panes$/, '_glass_pane'],
  [/^quartz$/, 'quartz_block'],
  [/^purpur$/, 'purpur_block'],
  [/^concrete$/, 'white_concrete'],
  [/^wool$/, 'white_wool'],
  [/^terracotta_(\w+)$/, '$1_terracotta'],
  [/^(\w+)_stone_brick$/, '$1_stone_bricks'],
  [/^lamp$/, 'redstone_lamp'],
  [/^light_block$/, 'light'],
  [/^torch_wall$/, 'wall_torch'],
];

const cache = new Map<string, string>();

/**
 * Repair a block spec so vanilla accepts it. Returns the original id when we
 * cannot do better — the executor reports what the server rejected rather than
 * guessing wildly.
 */
export function normalizeBlock(spec: string): { spec: string; fixed: boolean; known: boolean } {
  const cached = cache.get(spec);
  if (cached !== undefined) {
    const b0 = parseBlock(spec);
    const b1 = parseBlock(cached);
    return { spec: cached, fixed: cached !== spec, known: BLOCK_IDS.has(b1.id) || b0.id === b1.id };
  }

  const parsed = parseBlock(spec);
  let id = parsed.id;

  if (!BLOCK_IDS.has(id)) {
    for (const [re, to] of REWRITES) {
      const next = id.replace(re, to);
      if (next !== id) { id = next; if (BLOCK_IDS.has(id)) break; }
    }
  }

  // Last resort: a family suffix the model attached to a valid base.
  if (!BLOCK_IDS.has(id)) {
    for (const suffix of ['_stairs', '_slab', '_wall', '_fence']) {
      if (id.endsWith(suffix)) {
        const base = id.slice(0, -suffix.length);
        if (BLOCK_IDS.has(base) || BLOCK_IDS.has(`${base}s`)) break;
      }
    }
  }

  const out = formatBlock({ ...parsed, id });
  cache.set(spec, out);
  return { spec: out, fixed: out !== spec, known: BLOCK_IDS.has(id) };
}

export function isAir(spec: string): boolean {
  const id = parseBlock(spec).id;
  return id === 'air' || id === 'cave_air' || id === 'void_air';
}

/** Swap a solid block for its stair variant when one plausibly exists. */
export function stairVariant(spec: string): string | null {
  const { id } = parseBlock(spec);
  if (id.endsWith('_stairs')) return id;
  const candidates = [
    id.replace(/s$/, '') + '_stairs',
    `${id}_stairs`,
    id.replace(/_block$/, '') + '_stairs',
  ];
  for (const c of candidates) if (BLOCK_IDS.has(c)) return c;
  return null;
}

/** Swap a solid block for its slab variant when one plausibly exists. */
export function slabVariant(spec: string): string | null {
  const { id } = parseBlock(spec);
  if (id.endsWith('_slab')) return id;
  const candidates = [id.replace(/s$/, '') + '_slab', `${id}_slab`];
  for (const c of candidates) if (BLOCK_IDS.has(c)) return c;
  return null;
}
