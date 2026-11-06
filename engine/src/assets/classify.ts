// Name/property based block classification: render layer, light emission, tints, fallback colors.
// (Vanilla keeps this in code, not in the data files.)
import type { RenderLayer } from './geometry.ts';

const strip = (id: string) => (id.startsWith('minecraft:') ? id.slice(10) : id);

const TRANSLUCENT_RE = /(^|_)stained_glass(_pane)?$|^(ice|frosted_ice|water|slime_block|honey_block|nether_portal|tinted_glass|bubble_column)$/;
export function renderLayer(id: string): RenderLayer {
  const n = strip(id);
  if (TRANSLUCENT_RE.test(n)) return 'translucent';
  return 'cutout'; // alpha-tested; fully opaque textures behave like 'opaque'
}

/** blocks that hide their faces against the same block (glass-like) */
const SELF_CULL_RE = /glass$|glass_pane$|^(ice|frosted_ice|packed_ice|blue_ice|slime_block|honey_block|water|lava|powder_snow|tinted_glass|bubble_column)$|_leaves$/;
export function selfCulls(id: string): boolean {
  return SELF_CULL_RE.test(strip(id));
}

export const INVISIBLE = new Set(['air', 'cave_air', 'void_air', 'barrier', 'light', 'structure_void', 'moving_piston']);
export function isInvisible(id: string): boolean {
  return INVISIBLE.has(strip(id));
}

const EMIT_FIXED: Record<string, number> = {
  glowstone: 15, sea_lantern: 15, lava: 15, jack_o_lantern: 15, lantern: 15, shroomlight: 15, beacon: 15,
  fire: 15, end_gateway: 15, end_portal: 15, conduit: 15, ochre_froglight: 15, verdant_froglight: 15,
  pearlescent_froglight: 15, glow_lichen: 7, soul_lantern: 10, soul_torch: 10, soul_wall_torch: 10, soul_fire: 10,
  torch: 14, wall_torch: 14, end_rod: 14, copper_torch: 14, copper_wall_torch: 14, crying_obsidian: 10,
  magma_block: 3, amethyst_cluster: 5, large_amethyst_bud: 4, medium_amethyst_bud: 2, small_amethyst_bud: 1,
  brewing_stand: 1, nether_portal: 11, enchanting_table: 7, ender_chest: 7, sculk_catalyst: 6, firefly_bush: 2,
  lava_cauldron: 15, respawn_anchor: 0, dragon_egg: 1, brown_mushroom: 1, end_crystal: 0, copper_lantern: 15,
  exposed_copper_lantern: 15, weathered_copper_lantern: 15, oxidized_copper_lantern: 15,
};
const LIT_EMIT: Record<string, number> = {
  furnace: 13, smoker: 13, blast_furnace: 13, redstone_lamp: 15, campfire: 15, soul_campfire: 10,
  redstone_torch: 7, redstone_wall_torch: 7, redstone_ore: 9, deepslate_redstone_ore: 9,
  copper_bulb: 15, exposed_copper_bulb: 12, weathered_copper_bulb: 8, oxidized_copper_bulb: 4,
};

export function emission(id: string, props: Record<string, string>): number {
  const n = strip(id).replace(/^waxed_/, '');
  if (n in LIT_EMIT) return props.lit === 'true' ? LIT_EMIT[n] : 0;
  if (n in EMIT_FIXED) return EMIT_FIXED[n];
  if (n === 'light') return Number(props.level ?? 15);
  if (n.endsWith('candle') || n.endsWith('candles')) return props.lit === 'true' ? 3 * Number(props.candles ?? 1) : 0;
  if (n.endsWith('candle_cake')) return props.lit === 'true' ? 3 : 0;
  if (n === 'sea_pickle') return props.waterlogged === 'true' ? 3 + 3 * Number(props.pickles ?? 1) : 0;
  if (n === 'cave_vines' || n === 'cave_vines_plant') return props.berries === 'true' ? 14 : 0;
  if (n === 'respawn_anchor') return Math.round((Number(props.charges ?? 0) * 15) / 4);
  return 0;
}

export type TintKind = 'grass' | 'foliage' | 'dry_foliage' | 'water' | 'fixed' | null;

const GRASS_TINT = new Set([
  'grass_block', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'potted_fern', 'sugar_cane', 'bush',
  'pink_petals', 'wildflowers',
]);
const FOLIAGE_TINT = new Set(['oak_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves', 'vine']);
const FIXED_TINT: Record<string, [number, number, number]> = {
  birch_leaves: [0x80, 0xa7, 0x55],
  spruce_leaves: [0x61, 0x99, 0x61],
  mangrove_leaves: [0x92, 0xc6, 0x48],
  lily_pad: [0x20, 0x80, 0x30],
  attached_melon_stem: [0xe0, 0xc7, 0x1c],
  attached_pumpkin_stem: [0xe0, 0xc7, 0x1c],
};

export function tintKindOf(id: string): TintKind {
  const n = strip(id);
  if (GRASS_TINT.has(n)) return 'grass';
  if (FOLIAGE_TINT.has(n)) return 'foliage';
  if (n === 'leaf_litter') return 'dry_foliage';
  if (n === 'water' || n === 'water_cauldron' || n === 'bubble_column') return 'water';
  if (n in FIXED_TINT || n === 'redstone_wire' || n === 'melon_stem' || n === 'pumpkin_stem') return 'fixed';
  return null;
}

export function fixedTint(id: string, props: Record<string, string>): [number, number, number] | null {
  const n = strip(id);
  if (n in FIXED_TINT) return FIXED_TINT[n];
  if (n === 'redstone_wire') {
    const f = Number(props.power ?? 0) / 15;
    const r = f * 0.6 + (f > 0 ? 0.4 : 0.3);
    const g = Math.max(0, Math.min(1, f * f * 0.7 - 0.5));
    const b = Math.max(0, Math.min(1, f * f * 0.6 - 0.7));
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }
  if (n === 'melon_stem' || n === 'pumpkin_stem') {
    const a = Number(props.age ?? 0);
    return [a * 32, 255 - a * 8, a * 4];
  }
  return null;
}

// ---------------------------------------------------------------- biome climate & colors
export interface BiomeClimate {
  temp: number;
  down: number;
  grass?: number;
  foliage?: number;
  dry?: number;
  water?: number;
}
export const BIOMES: Record<string, BiomeClimate> = {
  plains: { temp: 0.8, down: 0.4 },
  sunflower_plains: { temp: 0.8, down: 0.4 },
  meadow: { temp: 0.5, down: 0.8, water: 0x0e4ecf },
  forest: { temp: 0.7, down: 0.8 },
  flower_forest: { temp: 0.7, down: 0.8 },
  birch_forest: { temp: 0.6, down: 0.6 },
  old_growth_birch_forest: { temp: 0.6, down: 0.6 },
  dark_forest: { temp: 0.7, down: 0.8 },
  taiga: { temp: 0.25, down: 0.8 },
  old_growth_spruce_taiga: { temp: 0.25, down: 0.8 },
  snowy_taiga: { temp: -0.5, down: 0.4, water: 0x3d57d6 },
  snowy_plains: { temp: 0, down: 0.5 },
  snowy_slopes: { temp: -0.3, down: 0.9 },
  frozen_peaks: { temp: -0.7, down: 0.9 },
  stony_peaks: { temp: 1, down: 0.3 },
  windswept_hills: { temp: 0.2, down: 0.3 },
  desert: { temp: 2, down: 0 },
  savanna: { temp: 2, down: 0 },
  savanna_plateau: { temp: 2, down: 0 },
  badlands: { temp: 2, down: 0, grass: 0x90814d, foliage: 0x9e814d },
  jungle: { temp: 0.95, down: 0.9 },
  swamp: { temp: 0.8, down: 0.9, grass: 0x6a7039, foliage: 0x6a7039, water: 0x617b64 },
  mangrove_swamp: { temp: 0.8, down: 0.9, grass: 0x6a7039, foliage: 0x8db127, water: 0x3a7a6a },
  cherry_grove: { temp: 0.5, down: 0.8, grass: 0xb6db61, foliage: 0xb6db61, water: 0x5db7ef },
  beach: { temp: 0.8, down: 0.4 },
  snowy_beach: { temp: 0.05, down: 0.3, water: 0x3d57d6 },
  stony_shore: { temp: 0.2, down: 0.3 },
  river: { temp: 0.5, down: 0.5 },
  frozen_river: { temp: 0, down: 0.5, water: 0x3938c9 },
  ocean: { temp: 0.5, down: 0.5 },
  deep_ocean: { temp: 0.5, down: 0.5 },
  warm_ocean: { temp: 0.5, down: 0.5, water: 0x43d5ee },
  lukewarm_ocean: { temp: 0.5, down: 0.5, water: 0x45adf2 },
  cold_ocean: { temp: 0.5, down: 0.5, water: 0x3d57d6 },
  frozen_ocean: { temp: 0, down: 0.5, water: 0x3938c9 },
  mushroom_fields: { temp: 0.9, down: 1 },
  pale_garden: { temp: 0.7, down: 0.8, grass: 0x778272, foliage: 0x878d76, water: 0x76889d },
};
export const DEFAULT_WATER = 0x3f76e4;

export function biomeClimate(biome?: string): BiomeClimate {
  const n = biome ? strip(biome) : 'plains';
  return BIOMES[n] ?? BIOMES.plains;
}

// --------------------------------------------------------------------- fallback palette
const DYES: Record<string, number> = {
  white: 0xe9ecec, orange: 0xf07613, magenta: 0xbd44b3, light_blue: 0x3aafd9, yellow: 0xf8c627, lime: 0x70b919,
  pink: 0xed8dac, gray: 0x3e4447, light_gray: 0x8e8e86, cyan: 0x158991, purple: 0x792aac, blue: 0x35399d,
  brown: 0x724728, green: 0x546d1b, red: 0xa12722, black: 0x141519,
};
const WOODS: Record<string, number> = {
  oak: 0xa2834f, spruce: 0x735531, birch: 0xc0af79, jungle: 0xa0734d, acacia: 0xa85a32, dark_oak: 0x432b14,
  mangrove: 0x763331, cherry: 0xe3b3ad, bamboo: 0xc4af52, crimson: 0x653147, warped: 0x2b6963, pale_oak: 0xe4d9d8,
};
const KEYWORDS: [RegExp, number, number?][] = [
  [/water/, 0x3f76e4, 150], [/lava/, 0xcf5b13], [/tinted_glass/, 0x2c2731, 160], [/glass/, 0xc8dcf0, 70],
  [/ice/, 0x91b7fd, 200], [/snow/, 0xf9fefe], [/leaves/, 0x4a8f2a], [/grass_block/, 0x7cb04a],
  [/short_grass|tall_grass|fern|bush|sapling|vine|kelp|seagrass|lily_pad|moss/, 0x5e9a35],
  [/dandelion|sunflower/, 0xf1d22a], [/poppy|rose|tulip/, 0xd23a2a], [/cornflower|orchid/, 0x4664d8],
  [/deepslate/, 0x505055], [/cobblestone/, 0x7a7a7a], [/mossy/, 0x6e7d5a], [/stone_brick/, 0x7b7b7b],
  [/smooth_stone/, 0x9e9e9e], [/granite/, 0x956755], [/diorite/, 0xbdbdbd], [/andesite/, 0x888888],
  [/red_sand/, 0xbe6621], [/sandstone/, 0xd8cb9b], [/sand/, 0xdbd3a0], [/gravel/, 0x847f7e], [/clay/, 0xa0a6b3],
  [/mud_brick/, 0x8b6a4f], [/mud/, 0x3c393d], [/podzol/, 0x5c3d18], [/mycelium/, 0x6f6265], [/dirt|farmland|path/, 0x866043],
  [/nether_brick/, 0x2c1519], [/netherrack/, 0x6f3535], [/basalt/, 0x4f4f55], [/blackstone/, 0x2a2328],
  [/end_stone/, 0xdbde9e], [/purpur/, 0xa97ca9], [/obsidian/, 0x14121d], [/prismarine/, 0x63a098],
  [/brick/, 0x966253], [/quartz/, 0xece6df], [/calcite/, 0xdfe0dc], [/tuff/, 0x6c6d66], [/terracotta/, 0x985e43],
  [/gold/, 0xf8d23d], [/iron/, 0xdcdcdc], [/diamond/, 0x62dbd6], [/emerald/, 0x2adb5e], [/lapis/, 0x2251a6],
  [/redstone/, 0xa11b0a], [/copper/, 0xc06b4f], [/amethyst/, 0x8561bf], [/glowstone|lantern|torch|lamp|froglight/, 0xf9d49c],
  [/bookshelf/, 0x6e5434], [/hay/, 0xa88e0a], [/pumpkin/, 0xc57418], [/melon/, 0x6f9123], [/cactus/, 0x587d2e],
  [/bedrock/, 0x555555], [/stone/, 0x7d7d7d], [/log|wood|stem|hyphae/, 0x6b5233],
];

/** deterministic flat color for a block id (renderer fallback when no textures are available) */
export function paletteColor(id: string): [number, number, number, number] {
  const n = strip(id);
  for (const [dye, c] of Object.entries(DYES))
    if (n.startsWith(dye + '_')) {
      if (/(wool|carpet|concrete|terracotta|stained_glass|bed|banner|candle|shulker)/.test(n)) {
        const a = n.includes('glass') ? 140 : 255;
        const k = n.includes('terracotta') && !n.includes('glazed') ? 0.75 : 1;
        return [((c >> 16) & 255) * k, ((c >> 8) & 255) * k, (c & 255) * k, a].map(Math.round) as any;
      }
    }
  for (const [w, c] of Object.entries(WOODS))
    if (n.startsWith(w + '_') && !/leaves|sapling/.test(n)) {
      const k = /log|wood|stem|hyphae/.test(n) ? 0.7 : 1;
      return [Math.round(((c >> 16) & 255) * k), Math.round(((c >> 8) & 255) * k), Math.round((c & 255) * k), 255];
    }
  for (const [re, c, a] of KEYWORDS) if (re.test(n)) return [(c >> 16) & 255, (c >> 8) & 255, c & 255, a ?? 255];
  // hash-based neutral color
  let h = 2166136261;
  for (let i = 0; i < n.length; i++) h = Math.imul(h ^ n.charCodeAt(i), 16777619);
  const v = 110 + ((h >>> 0) % 90);
  return [v, v - 5 + ((h >>> 8) % 10), v - 10 + ((h >>> 16) % 20), 255];
}
