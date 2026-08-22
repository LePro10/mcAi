/**
 * Style palettes.
 *
 * A palette maps semantic slots (`wall`, `roof`, `trim`, ...) to materials, so a
 * blueprint can say `"@wall"` and stay style-agnostic. Slots may hold weighted
 * mixes, which is what makes generated walls look hand-built instead of like a
 * flat texture: 70 % stone bricks, 20 % cracked, 10 % mossy, chosen by a
 * coordinate hash so the result is identical every run.
 *
 * Palettes are built in (portability: no data files required) and can be
 * overridden by JSON in `styles/`.
 */

import type { Material, MaterialMix } from './types.js';
import { noise01, weightedIndex } from './rng.js';

export interface Palette {
  name: string;
  description: string;
  /** Slot -> material. Unknown slots fall back to `wall`. */
  slots: Record<string, Material>;
  /** Free-form guidance surfaced to the model in the style tool. */
  hints?: string[];
  /** Biomes this style suits, used for automatic selection. */
  biomes?: string[];
  /**
   * Whether the biome index may pick this style on its own. Deliberate looks
   * (modern, fantasy, steampunk) stay opt-in: nobody asking for a house in the
   * desert wants a glass cube, but someone asking for a *modern* house does.
   */
  auto?: boolean;
}

const mix = (blocks: string[], weights?: number[]): MaterialMix => ({ mix: blocks, weights });

export const PALETTES: Record<string, Palette> = {
  medieval: {
    name: 'medieval',
    description: 'Stone footings, timber walls, steep shingled roofs. The default for temperate biomes.',
    slots: {
      base: mix(['cobblestone', 'mossy_cobblestone', 'stone_bricks'], [0.6, 0.2, 0.2]),
      stone: mix(['stone_bricks', 'cracked_stone_bricks', 'mossy_stone_bricks'], [0.7, 0.18, 0.12]),
      wall: mix(['oak_planks', 'stripped_oak_log', 'spruce_planks'], [0.72, 0.2, 0.08]),
      accent: 'stripped_dark_oak_log',
      trim: 'dark_oak_log',
      roof: 'dark_oak_planks',
      roof_stairs: 'dark_oak_stairs',
      floor: mix(['spruce_planks', 'stripped_spruce_log'], [0.85, 0.15]),
      glass: 'glass_pane',
      light: 'lantern',
      door: 'oak_door',
      fence: 'oak_fence',
      path: mix(['cobblestone', 'gravel', 'andesite'], [0.55, 0.3, 0.15]),
      pillar: 'stone_bricks',
      detail: 'stone_brick_wall',
    },
    hints: ['Steep roofs (pitch 1). Overhang the roof by 1. Exposed corner beams.'],
    biomes: ['plains', 'forest', 'meadow', 'birch_forest', 'river', 'sunflower_plains'],
    auto: true,
  },

  cottage: {
    name: 'cottage',
    description: 'Small, warm, storybook. Whitewashed walls, dark timber, flowers everywhere.',
    slots: {
      base: 'cobblestone',
      stone: mix(['cobblestone', 'stone_bricks'], [0.7, 0.3]),
      wall: mix(['white_terracotta', 'bone_block', 'calcite'], [0.75, 0.15, 0.1]),
      accent: 'stripped_dark_oak_log',
      trim: 'dark_oak_log',
      roof: 'deepslate_tiles',
      roof_stairs: 'deepslate_tile_stairs',
      floor: 'oak_planks',
      glass: 'glass_pane',
      light: 'lantern',
      door: 'oak_door',
      fence: 'oak_fence',
      path: mix(['gravel', 'cobblestone'], [0.7, 0.3]),
      pillar: 'stripped_oak_log',
      detail: mix(['poppy', 'dandelion', 'cornflower', 'oxeye_daisy']),
    },
    hints: ['Half-timbered look: a lattice of dark logs over pale walls.'],
    biomes: ['plains', 'meadow', 'forest'],
    auto: true,
  },

  modern: {
    name: 'modern',
    description: 'Flat roofs, glass curtain walls, concrete slabs, no clutter.',
    slots: {
      base: 'smooth_stone',
      stone: 'smooth_stone',
      wall: mix(['white_concrete', 'light_gray_concrete'], [0.8, 0.2]),
      accent: 'polished_blackstone',
      trim: 'black_concrete',
      roof: 'smooth_quartz',
      roof_stairs: 'smooth_quartz_stairs',
      floor: 'polished_andesite',
      glass: 'glass',
      light: 'sea_lantern',
      door: 'iron_door',
      fence: 'iron_bars',
      path: 'smooth_stone',
      pillar: 'quartz_pillar',
      detail: 'light_gray_concrete',
    },
    hints: ['Flat roofs (kind "flat"). Full-height glass. Avoid decoration.'],
    biomes: ['plains', 'beach', 'desert'],
  },

  fantasy: {
    name: 'fantasy',
    description: 'Impossible geometry, purple stone, glowing crystals, tall spires.',
    slots: {
      base: 'deepslate_bricks',
      stone: mix(['deepslate_bricks', 'polished_deepslate'], [0.7, 0.3]),
      wall: mix(['purpur_block', 'quartz_bricks', 'purpur_pillar'], [0.6, 0.25, 0.15]),
      accent: 'amethyst_block',
      trim: 'purpur_pillar',
      roof: 'purple_terracotta',
      roof_stairs: 'purpur_stairs',
      floor: 'polished_deepslate',
      glass: 'purple_stained_glass_pane',
      light: 'shroomlight',
      door: 'warped_door',
      fence: 'blackstone_wall',
      path: 'polished_blackstone',
      pillar: 'purpur_pillar',
      detail: 'amethyst_cluster',
    },
    hints: ['Tall thin towers with cone roofs. Float parts of the structure.'],
    biomes: ['end_highlands', 'mushroom_fields', 'dark_forest'],
  },

  japanese: {
    name: 'japanese',
    description: 'Pagoda roofs, dark timber frames, paper walls, cherry blossom.',
    slots: {
      base: 'stone_bricks',
      stone: 'stone_bricks',
      wall: mix(['white_concrete', 'bone_block'], [0.85, 0.15]),
      accent: 'dark_oak_log',
      trim: 'stripped_dark_oak_log',
      roof: 'deepslate_tiles',
      roof_stairs: 'dark_oak_stairs',
      floor: 'stripped_birch_log',
      glass: 'white_stained_glass_pane',
      light: 'lantern',
      door: 'cherry_door',
      fence: 'dark_oak_fence',
      path: mix(['gravel', 'stone'], [0.7, 0.3]),
      pillar: 'dark_oak_log',
      detail: 'cherry_leaves',
    },
    hints: ['Use roof kind "pagoda": stacked tiers with a wide overhang.'],
    biomes: ['cherry_grove'],
    auto: true,
  },

  viking: {
    name: 'viking',
    description: 'Longhouses, turf roofs, heavy dark timber, carved posts.',
    slots: {
      base: mix(['cobblestone', 'mossy_cobblestone'], [0.6, 0.4]),
      stone: mix(['cobblestone', 'mossy_cobblestone', 'stone_bricks'], [0.45, 0.3, 0.25]),
      wall: mix(['spruce_planks', 'stripped_spruce_log', 'dark_oak_planks'], [0.6, 0.25, 0.15]),
      accent: 'stripped_spruce_log',
      trim: 'spruce_log',
      roof: mix(['moss_block', 'grass_block', 'podzol'], [0.5, 0.35, 0.15]),
      roof_stairs: 'spruce_stairs',
      floor: 'spruce_planks',
      glass: 'brown_stained_glass_pane',
      light: 'campfire',
      door: 'spruce_door',
      fence: 'spruce_fence',
      path: mix(['gravel', 'coarse_dirt'], [0.6, 0.4]),
      pillar: 'stripped_spruce_log',
      detail: 'chain',
    },
    hints: ['Long, low buildings. Roofs reach almost to the ground.'],
    biomes: ['taiga', 'snowy_taiga', 'old_growth_pine_taiga', 'grove', 'snowy_plains'],
    auto: true,
  },

  desert: {
    name: 'desert',
    description: 'Sandstone mass, flat roofs, deep arches, small windows against the sun.',
    slots: {
      base: 'smooth_sandstone',
      stone: mix(['sandstone', 'cut_sandstone', 'smooth_sandstone'], [0.6, 0.25, 0.15]),
      wall: mix(['sandstone', 'cut_sandstone', 'smooth_sandstone'], [0.6, 0.25, 0.15]),
      accent: 'chiseled_sandstone',
      trim: 'cut_sandstone',
      roof: 'smooth_sandstone',
      roof_stairs: 'sandstone_stairs',
      floor: 'cut_sandstone',
      glass: 'orange_stained_glass_pane',
      light: 'lantern',
      door: 'acacia_door',
      fence: 'sandstone_wall',
      path: mix(['sandstone', 'sand'], [0.6, 0.4]),
      pillar: 'chiseled_sandstone',
      detail: 'orange_terracotta',
    },
    hints: ['Flat roofs with battlements. Wide arched doorways.'],
    biomes: ['desert', 'badlands', 'eroded_badlands', 'wooded_badlands'],
    auto: true,
  },

  tropical: {
    name: 'tropical',
    description: 'Open stilted structures, bamboo, palm-leaf roofs, no walls where possible.',
    slots: {
      base: 'jungle_log',
      stone: mix(['stone_bricks', 'mossy_stone_bricks'], [0.6, 0.4]),
      wall: mix(['jungle_planks', 'bamboo_planks'], [0.6, 0.4]),
      accent: 'bamboo_mosaic',
      trim: 'jungle_log',
      roof: mix(['jungle_leaves', 'moss_block'], [0.7, 0.3]),
      roof_stairs: 'jungle_stairs',
      floor: 'bamboo_planks',
      glass: 'glass_pane',
      light: 'lantern',
      door: 'jungle_door',
      fence: 'bamboo_fence',
      path: mix(['sand', 'gravel'], [0.7, 0.3]),
      pillar: 'bamboo_block',
      detail: 'big_dripleaf',
    },
    hints: ['Raise the floor on stilts. Leave walls open, use fences as railings.'],
    biomes: ['jungle', 'sparse_jungle', 'bamboo_jungle', 'beach', 'mangrove_swamp'],
    auto: true,
  },

  gothic: {
    name: 'gothic',
    description: 'Cathedral verticality: dark stone, pointed arches, stained glass, flying buttresses.',
    slots: {
      base: 'polished_blackstone_bricks',
      stone: mix(['deepslate_bricks', 'cracked_deepslate_bricks', 'polished_blackstone_bricks'], [0.6, 0.2, 0.2]),
      wall: mix(['deepslate_bricks', 'cracked_deepslate_bricks', 'deepslate_tiles'], [0.65, 0.2, 0.15]),
      accent: 'polished_blackstone',
      trim: 'blackstone',
      roof: 'blackstone',
      roof_stairs: 'blackstone_stairs',
      floor: 'polished_deepslate',
      glass: mix(['red_stained_glass', 'blue_stained_glass', 'purple_stained_glass', 'yellow_stained_glass']),
      light: 'soul_lantern',
      door: 'dark_oak_door',
      fence: 'deepslate_brick_wall',
      path: 'polished_blackstone',
      pillar: 'deepslate_brick_wall',
      detail: 'chain',
    },
    hints: ['Go tall and narrow. Tall arched windows filled with mixed stained glass.'],
    biomes: ['dark_forest', 'swamp', 'windswept_hills'],
  },

  elven: {
    name: 'elven',
    description: 'Pale organic curves grown into the trees, gold trim, warm glow.',
    slots: {
      base: 'calcite',
      stone: mix(['calcite', 'smooth_quartz'], [0.7, 0.3]),
      wall: mix(['bone_block', 'calcite', 'smooth_quartz'], [0.5, 0.3, 0.2]),
      accent: 'gold_block',
      trim: 'stripped_birch_log',
      roof: 'lime_terracotta',
      roof_stairs: 'birch_stairs',
      floor: 'birch_planks',
      glass: 'light_blue_stained_glass_pane',
      light: 'end_rod',
      door: 'birch_door',
      fence: 'birch_fence',
      path: 'moss_block',
      pillar: 'quartz_pillar',
      detail: 'azalea_leaves',
    },
    hints: ['Cone and dome roofs. Thin pillars. Wrap structures around trees.'],
    biomes: ['forest', 'flower_forest', 'birch_forest', 'lush_caves'],
  },

  dwarven: {
    name: 'dwarven',
    description: 'Carved into rock. Massive blocks, iron and gold inlay, lava light.',
    slots: {
      base: 'deepslate_bricks',
      stone: mix(['stone_bricks', 'chiseled_stone_bricks', 'cracked_stone_bricks'], [0.68, 0.17, 0.15]),
      wall: mix(['stone_bricks', 'chiseled_stone_bricks', 'cracked_stone_bricks'], [0.6, 0.25, 0.15]),
      accent: 'gold_block',
      trim: 'polished_deepslate',
      roof: 'deepslate_tiles',
      roof_stairs: 'deepslate_tile_stairs',
      floor: 'polished_andesite',
      glass: 'orange_stained_glass_pane',
      light: 'lantern',
      door: 'iron_door',
      fence: 'iron_bars',
      path: 'polished_deepslate',
      pillar: 'chiseled_stone_bricks',
      detail: 'iron_block',
    },
    hints: ['Oversized square arches, heavy pillars, everything symmetrical.'],
    biomes: ['windswept_hills', 'stony_peaks', 'dripstone_caves', 'jagged_peaks'],
    auto: true,
  },

  steampunk: {
    name: 'steampunk',
    description: 'Copper, brick and brass. Pipes, gears, chimneys, riveted plate.',
    slots: {
      base: 'polished_blackstone_bricks',
      stone: mix(['bricks', 'polished_blackstone_bricks'], [0.75, 0.25]),
      wall: mix(['bricks', 'copper_block', 'exposed_copper'], [0.6, 0.25, 0.15]),
      accent: 'oxidized_copper',
      trim: 'stripped_dark_oak_log',
      roof: 'weathered_copper',
      roof_stairs: 'weathered_cut_copper_stairs',
      floor: 'polished_blackstone',
      glass: 'brown_stained_glass_pane',
      light: 'redstone_lamp',
      door: 'iron_door',
      fence: 'iron_bars',
      path: 'bricks',
      pillar: 'copper_bulb',
      detail: 'chain',
    },
    hints: ['Add chimneys and chain runs. Mix copper oxidation stages on purpose.'],
    biomes: ['plains', 'windswept_hills', 'swamp'],
  },

  futuristic: {
    name: 'futuristic',
    description: 'Sealed white shells, glowing seams, no visible joins.',
    slots: {
      base: 'polished_deepslate',
      stone: 'smooth_quartz',
      wall: mix(['white_concrete', 'smooth_quartz'], [0.7, 0.3]),
      accent: 'light_blue_concrete',
      trim: 'gray_concrete',
      roof: 'smooth_quartz',
      roof_stairs: 'smooth_quartz_stairs',
      floor: 'gray_concrete',
      glass: 'tinted_glass',
      light: 'sea_lantern',
      door: 'iron_door',
      fence: 'iron_bars',
      path: 'light_gray_concrete',
      pillar: 'quartz_pillar',
      detail: 'light_blue_stained_glass',
    },
    hints: ['Domes and cylinders. Run light strips as full glowing lines.'],
    biomes: ['desert', 'ice_spikes', 'beach'],
  },

  ruins: {
    name: 'ruins',
    description: 'Half-collapsed, overgrown, weathered. Best with the scatter op.',
    slots: {
      base: mix(['cobblestone', 'mossy_cobblestone', 'gravel'], [0.4, 0.4, 0.2]),
      stone: mix(['mossy_stone_bricks', 'cracked_stone_bricks', 'stone_bricks'], [0.4, 0.35, 0.25]),
      wall: mix(['mossy_stone_bricks', 'cracked_stone_bricks', 'stone_bricks', 'air'], [0.35, 0.3, 0.25, 0.1]),
      accent: 'mossy_cobblestone',
      trim: 'stone_brick_wall',
      roof: 'mossy_cobblestone',
      roof_stairs: 'mossy_stone_brick_stairs',
      floor: mix(['cracked_stone_bricks', 'gravel', 'moss_block'], [0.5, 0.3, 0.2]),
      glass: 'air',
      light: 'torch',
      door: 'air',
      fence: 'mossy_stone_brick_wall',
      path: mix(['gravel', 'coarse_dirt', 'moss_block'], [0.5, 0.3, 0.2]),
      pillar: 'stone_brick_wall',
      detail: mix(['vine', 'glow_lichen', 'moss_carpet']),
    },
    hints: ['Leave roofs open. Use the "air" entries in the wall mix as damage.'],
    biomes: ['jungle', 'swamp', 'dark_forest', 'savanna'],
  },

  nether: {
    name: 'nether',
    description: 'Hostile fortress architecture: dark brick, blaze light, no wood.',
    slots: {
      base: 'blackstone',
      stone: mix(['nether_bricks', 'cracked_nether_bricks'], [0.8, 0.2]),
      wall: mix(['nether_bricks', 'cracked_nether_bricks', 'chiseled_nether_bricks'], [0.7, 0.2, 0.1]),
      accent: 'red_nether_bricks',
      trim: 'polished_blackstone',
      roof: 'nether_bricks',
      roof_stairs: 'nether_brick_stairs',
      floor: 'polished_blackstone_bricks',
      glass: 'red_stained_glass_pane',
      light: 'shroomlight',
      door: 'crimson_door',
      fence: 'nether_brick_fence',
      path: 'blackstone',
      pillar: 'chiseled_polished_blackstone',
      detail: 'crimson_roots',
    },
    hints: ['Heavy battlements and arched bridges. No plants, no glass panes.'],
    biomes: ['nether_wastes', 'crimson_forest', 'warped_forest', 'basalt_deltas'],
    auto: true,
  },

  ice: {
    name: 'ice',
    description: 'Frozen palace: packed ice, snow, blue glass, cold light.',
    slots: {
      base: 'packed_ice',
      stone: mix(['packed_ice', 'blue_ice'], [0.7, 0.3]),
      wall: mix(['packed_ice', 'blue_ice', 'snow_block'], [0.55, 0.25, 0.2]),
      accent: 'blue_ice',
      trim: 'calcite',
      roof: 'snow_block',
      roof_stairs: 'quartz_stairs',
      floor: 'blue_ice',
      glass: 'light_blue_stained_glass',
      light: 'sea_lantern',
      door: 'birch_door',
      fence: 'iron_bars',
      path: 'snow_block',
      pillar: 'quartz_pillar',
      detail: 'ice',
    },
    hints: ['Tall spires and cones. Prefer sea lanterns buried behind ice.'],
    biomes: ['snowy_plains', 'ice_spikes', 'frozen_peaks', 'snowy_slopes', 'frozen_river'],
    auto: true,
  },
};

/** Style chosen when a biome has no better match. */
export const DEFAULT_STYLE = 'medieval';

let biomeIndex: Map<string, string> | null = null;

function getBiomeIndex(): Map<string, string> {
  if (biomeIndex) return biomeIndex;
  biomeIndex = new Map();
  for (const p of Object.values(PALETTES)) {
    if (!p.auto) continue;
    for (const b of p.biomes ?? []) if (!biomeIndex.has(b)) biomeIndex.set(b, p.name);
  }
  return biomeIndex;
}

/** Pick the style that best suits a biome id. */
export function styleForBiome(biome: string | undefined | null): string {
  if (!biome) return DEFAULT_STYLE;
  const b = biome.replace(/^minecraft:/, '').toLowerCase();
  const idx = getBiomeIndex();
  const direct = idx.get(b);
  if (direct) return direct;
  // Substring fallbacks for biome variants we did not enumerate.
  for (const [key, style] of idx) {
    if (b.includes(key) || key.includes(b)) return style;
  }
  if (b.includes('ocean')) return 'tropical';
  if (b.includes('snow') || b.includes('frozen') || b.includes('ice')) return 'ice';
  if (b.includes('desert') || b.includes('badlands')) return 'desert';
  if (b.includes('taiga')) return 'viking';
  if (b.includes('jungle')) return 'tropical';
  if (b.includes('nether') || b.includes('crimson') || b.includes('warped')) return 'nether';
  if (b.includes('cave')) return 'dwarven';
  return DEFAULT_STYLE;
}

/** Wood family that reads as "local" for a biome — used to tint any palette. */
export function woodForBiome(biome: string | undefined | null): string {
  const b = (biome ?? '').replace(/^minecraft:/, '').toLowerCase();
  if (b.includes('taiga') || b.includes('grove') || b.includes('snow')) return 'spruce';
  if (b.includes('birch')) return 'birch';
  if (b.includes('jungle')) return 'jungle';
  if (b.includes('savanna')) return 'acacia';
  if (b.includes('dark_forest') || b.includes('swamp')) return 'dark_oak';
  if (b.includes('mangrove')) return 'mangrove';
  if (b.includes('cherry')) return 'cherry';
  if (b.includes('desert') || b.includes('badlands')) return 'acacia';
  if (b.includes('crimson')) return 'crimson';
  if (b.includes('warped')) return 'warped';
  return 'oak';
}

export interface ResolvedPalette {
  name: string;
  slots: Record<string, Material>;
  /** Resolve a material reference to a concrete block id at a coordinate. */
  at(ref: Material, x: number, y: number, z: number): string;
  /** True when the reference names a slot this palette knows. */
  hasSlot(slot: string): boolean;
}

/**
 * Texture granularity.
 *
 * Per-block noise looks great and is ruinously expensive: every neighbouring
 * voxel differs, so the compiler's box merger cannot merge anything and a
 * castle balloons from 650 commands to 7,200. Quantising the noise into blobs
 * keeps the hand-laid look — arguably improves it, since real masonry comes in
 * patches, not per-brick static — while letting whole runs merge again.
 *
 *   off  — always the dominant block, one flat colour, cheapest
 *   low  — 4×2×4 blobs
 *   med  — 2×1×2 blobs (default)
 *   high — per block, most detailed, most commands
 */
export type DetailLevel = 'off' | 'low' | 'med' | 'high';

const BLOB: Record<DetailLevel, [number, number, number]> = {
  off: [0, 0, 0],
  low: [4, 2, 4],
  med: [2, 1, 2],
  high: [1, 1, 1],
};

/**
 * Build a resolver from a palette name plus optional per-blueprint overrides.
 * Unknown palettes fall back to medieval rather than failing a build.
 */
export function resolvePalette(
  paletteRef: string | Record<string, Material> | undefined,
  overrides?: Record<string, Material>,
  seed = 0,
  extra?: Record<string, Palette>,
  detail: DetailLevel = 'med',
): ResolvedPalette {
  let base: Palette;
  let slots: Record<string, Material>;

  if (typeof paletteRef === 'object' && paletteRef !== null) {
    base = PALETTES[DEFAULT_STYLE];
    slots = { ...base.slots, ...paletteRef };
  } else {
    const key = (paletteRef ?? DEFAULT_STYLE).toLowerCase();
    base = extra?.[key] ?? PALETTES[key] ?? PALETTES[DEFAULT_STYLE];
    slots = { ...base.slots };
  }
  if (overrides) slots = { ...slots, ...overrides };

  const [bx, by, bz] = BLOB[detail] ?? BLOB.med;

  const resolve = (ref: Material, x: number, y: number, z: number, depth = 0): string => {
    if (depth > 6) return 'stone';
    if (typeof ref === 'object' && ref !== null && Array.isArray(ref.mix)) {
      const list = ref.mix;
      if (list.length === 0) return 'stone';
      const weights = ref.weights && ref.weights.length === list.length
        ? ref.weights
        : new Array(list.length).fill(1);
      if (detail === 'off') {
        let best = 0;
        for (let i = 1; i < weights.length; i++) if (weights[i] > weights[best]) best = i;
        return resolve(list[best], x, y, z, depth + 1);
      }
      // Quantise the sample point so neighbouring voxels share a draw.
      const r = noise01(
        Math.floor(x / bx), Math.floor(y / by), Math.floor(z / bz),
        seed ^ 0x5bf03635,
      );
      const picked = list[weightedIndex(weights, r)];
      return resolve(picked, x, y, z, depth + 1);
    }
    const s = String(ref);
    if (s.startsWith('@')) {
      const slot = s.slice(1);
      const target = slots[slot];
      if (target === undefined) {
        const fallback = slots.wall ?? 'stone';
        return resolve(fallback, x, y, z, depth + 1);
      }
      return resolve(target, x, y, z, depth + 1);
    }
    return s;
  };

  return {
    name: base.name,
    slots,
    at: (ref, x, y, z) => resolve(ref, x, y, z),
    hasSlot: (slot) => slot in slots,
  };
}

/** Compact listing for the model: name + one-line description. */
export function listStyles(extra?: Record<string, Palette>): Array<{ name: string; description: string }> {
  const all = { ...PALETTES, ...(extra ?? {}) };
  return Object.values(all).map((p) => ({ name: p.name, description: p.description }));
}
