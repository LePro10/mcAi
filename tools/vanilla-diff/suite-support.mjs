// Suite "support": survival of attachable / support-dependent blocks in the REAL 26.3 world vs
// engine support.ts (checkSupportAt).
//
// Method (no mod changes needed): the mod's set_blocks places without neighbour updates and its
// shape pass never deletes blocks, so it cannot show survival. Vanilla `setblock` (allowlisted
// for the harness only, via $MCAI_HOME/config.json on the private test-server home) places with
// UPDATE_CLIENTS and then updates neighbours (updateNeighbourShapes + updateNeighboursOnBlockSet),
// exactly what happens when a player places a block next to an existing one. So per case:
//   1. set_blocks (no updates): target T at P (+ its partner half / context), P+d = air
//      (or stone when the candidate support is air), a stone pedestal at P+2d (and under P+d for
//      side supports, so the support itself does not pop);
//   2. `setblock P+d <S>`  (S = candidate support; for S = air: replace the stone with air) →
//      vanilla runs T.updateShape(d, S) / neighborChanged → T pops if it cannot survive;
//   3. wait a few ticks (scheduled-tick rules: cactus, cane, chorus, dripstone, gravity …),
//      read P back. Engine verdict = checkSupportAt(P, T) over the same scene (S at P+d).
// d is always the direction vanilla's updateShape checks for that block (decompiled 26.3 code).
// Water-dependent plants (lily pad, cane-by-water, seagrass, kelp, coral in water) are not tested
// dynamically (flowing water would leak between cases) — see docs/VANILLA-DIFF.md.
import { checkSupportAt } from '../../engine/src/core/support.ts';
import { parseBlockState, formatBlockState } from '../../engine/src/core/blockstate.ts';
import { Batch, rng } from './lib.mjs';

export const AREA = { x0: 3000, z0: 3144, y: -57, pitch: 4, cols: 32, rows: 32 };
export const BOUNDS = { x0: AREA.x0 - 4, z0: AREA.z0 - 4, x1: AREA.x0 + AREA.cols * AREA.pitch + 4, z1: AREA.z0 + AREA.rows * AREA.pitch + 4 };
const H = ['north', 'east', 'south', 'west'];
const D6 = ['north', 'east', 'south', 'west', 'up', 'down'];
const VEC = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0] };
const OPP = { north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up' };
const CW = { north: 'east', east: 'south', south: 'west', west: 'north' };
const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'bamboo', 'crimson', 'warped'];

const idOf = (s) => s.replace(/[[{].*$/, '');
const short = (s) => (s ?? '?').replace(/^minecraft:/, '');
const M = (s) => (s.includes(':') ? s : `minecraft:${s}`);
function setProps(s, kv) {
  const p = parseBlockState(s);
  return formatBlockState({ name: p.name, props: { ...p.props, ...kv } });
}

// ------------------------------------------------------------------ candidate supports

const GENERAL = [
  'air', 'stone', 'glass', 'white_stained_glass', 'oak_leaves[persistent=true,waterlogged=false]', 'azalea_leaves[persistent=true,waterlogged=false]', 'mangrove_leaves[persistent=true,waterlogged=false]',
  'smooth_stone_slab[type=bottom,waterlogged=false]', 'smooth_stone_slab[type=top,waterlogged=false]', 'smooth_stone_slab[type=double,waterlogged=false]',
  ...H.flatMap((f) => [`oak_stairs[facing=${f},half=bottom,shape=straight,waterlogged=false]`, `oak_stairs[facing=${f},half=top,shape=straight,waterlogged=false]`]),
  'oak_fence[east=false,north=false,south=false,waterlogged=false,west=false]', 'nether_brick_fence[east=false,north=false,south=false,waterlogged=false,west=false]',
  'cobblestone_wall[east=none,north=none,south=none,up=true,waterlogged=false,west=none]', 'glass_pane[east=false,north=false,south=false,waterlogged=false,west=false]',
  'iron_bars[east=false,north=false,south=false,waterlogged=false,west=false]', 'iron_chain[axis=y,waterlogged=false]', 'iron_chain[axis=x,waterlogged=false]',
  'end_rod[facing=up]', 'end_rod[facing=north]', 'lightning_rod[facing=up,powered=false,waterlogged=false]', 'hopper[enabled=true,facing=down]', 'hopper[enabled=true,facing=north]',
  'chest[facing=north,type=single,waterlogged=false]', 'ender_chest[facing=north,waterlogged=false]', 'barrel[facing=up,open=false]', 'white_carpet', 'moss_carpet',
  ...H.slice(0, 2).flatMap((f) => [`oak_trapdoor[facing=${f},half=bottom,open=false,powered=false,waterlogged=false]`, `oak_trapdoor[facing=${f},half=top,open=false,powered=false,waterlogged=false]`, `oak_trapdoor[facing=${f},half=bottom,open=true,powered=false,waterlogged=false]`]),
  'oak_trapdoor[facing=south,half=bottom,open=true,powered=false,waterlogged=false]', 'oak_trapdoor[facing=west,half=bottom,open=true,powered=false,waterlogged=false]',
  'snow[layers=1]', 'snow[layers=4]', 'snow[layers=7]', 'snow[layers=8]', 'snow_block', 'farmland[moisture=0]', 'dirt_path', 'soul_sand', 'mud', 'honey_block', 'slime_block',
  'scaffolding[bottom=false,distance=0,waterlogged=false]', 'composter[level=0]', 'cauldron', 'lantern[hanging=false,waterlogged=false]', 'torch',
  'oak_fence_gate[facing=north,in_wall=false,open=false,powered=false]', 'oak_fence_gate[facing=east,in_wall=false,open=true,powered=false]', 'anvil[facing=north]',
  'bell[attachment=floor,facing=north,powered=false]', 'grindstone[face=floor,facing=north]', 'lectern[facing=north,has_book=false,powered=false]', 'stonecutter[facing=north]',
  'enchanting_table', 'daylight_detector[inverted=false,power=0]', 'red_bed[facing=north,occupied=false,part=foot]', 'piston[extended=false,facing=up]', 'piston[extended=false,facing=north]',
  'observer[facing=north,powered=false]', 'campfire[facing=north,lit=false,signal_fire=false,waterlogged=false]', 'oak_sign[rotation=0,waterlogged=false]', 'flower_pot',
  'player_head[powered=false,rotation=0]', 'jungle_log[axis=y]', 'jungle_log[axis=x]', 'stripped_jungle_log[axis=y]', 'jungle_wood[axis=y]', 'oak_log[axis=y]', 'oak_planks',
  'grass_block[snowy=false]', 'dirt', 'sand', 'gravel', 'terracotta', 'netherrack', 'end_stone', 'mangrove_roots[waterlogged=false]', 'ice', 'packed_ice', 'glowstone', 'sea_lantern',
  'redstone_block', 'tnt[unstable=false]', 'barrier[waterlogged=false]', 'shulker_box[facing=up]', 'pumpkin', 'melon', 'bookshelf', 'cactus[age=0]', 'bamboo[age=0,leaves=none,stage=0]',
  'pointed_dripstone[thickness=tip,vertical_direction=up,waterlogged=false]', 'pointed_dripstone[thickness=tip,vertical_direction=down,waterlogged=false]', 'spawner', 'beacon',
  'copper_grate[waterlogged=false]', 'decorated_pot[cracked=false,facing=north,waterlogged=false]', 'heavy_core[waterlogged=false]', 'azalea', 'oak_shelf[facing=north,powered=false,side_chain=unconnected,waterlogged=false]',
  'oak_shelf[facing=south,powered=false,side_chain=unconnected,waterlogged=false]', 'sculk_sensor[power=0,sculk_sensor_phase=inactive,waterlogged=false]',
  'repeater[delay=1,facing=north,locked=false,powered=false]', 'cobweb', 'brewing_stand', 'cake[bites=0]', 'conduit[waterlogged=false]', 'oak_pressure_plate[powered=false]',
  'stone_button[face=floor,facing=north,powered=false]', 'glow_lichen[down=true,east=false,north=false,south=false,up=false,waterlogged=false,west=false]',
  'vine[east=false,north=true,south=false,up=false,west=false]', 'big_dripleaf[facing=north,tilt=none,waterlogged=false]', 'dried_kelp_block', 'mushroom_stem[down=true,east=true,north=true,south=true,up=true,west=true]',
  'trial_spawner[ominous=false,trial_spawner_state=inactive]', 'vault[facing=north,ominous=false,vault_state=inactive]', 'crafter[crafting=false,orientation=north_up,triggered=false]',
];
const GROUND = [
  'air', 'stone', 'glass', 'grass_block[snowy=false]', 'dirt', 'coarse_dirt', 'rooted_dirt', 'podzol[snowy=false]', 'mycelium[snowy=false]', 'moss_block', 'pale_moss_block', 'mud', 'muddy_mangrove_roots[axis=y]',
  'farmland[moisture=7]', 'sand', 'red_sand', 'suspicious_sand[dusted=0]', 'gravel', 'clay', 'terracotta', 'white_terracotta', 'soul_sand', 'soul_soil', 'netherrack', 'crimson_nylium', 'warped_nylium',
  'end_stone', 'dirt_path', 'packed_mud', 'snow_block', 'snow[layers=1]', 'ice', 'oak_leaves[persistent=true,waterlogged=false]', 'oak_planks', 'smooth_stone_slab[type=bottom,waterlogged=false]',
  'smooth_stone_slab[type=top,waterlogged=false]', 'jungle_log[axis=y]', 'magma_block', 'glowstone', 'mangrove_roots[waterlogged=false]', 'white_carpet', 'moss_carpet', 'cactus[age=0]', 'sugar_cane[age=0]',
  'bamboo[age=0,leaves=none,stage=0]', 'chorus_plant[down=false,east=false,north=false,south=false,up=false,west=false]', 'big_dripleaf_stem[facing=north,waterlogged=false]', 'mycelium[snowy=false]', 'pale_moss_carpet[bottom=true,east=none,north=none,south=none,west=none]',
];

// ------------------------------------------------------------------ targets

/** spec: fam, states[], dir(T) → trigger direction, sup = candidate list, partner(T) → [[dx,dy,dz,s]], ctx(T,r) → extra blocks, multiface: compare full state */
function targets(reg) {
  const ids = reg.ids().map((i) => i.slice(10));
  const f = (re) => ids.filter((i) => re.test(i));
  const lanterns = f(/^(.*_)?lantern$/).filter((i) => i !== 'sea_lantern' && i !== 'jack_o_lantern');
  const T = [];
  const add = (fam, states, dir, sup = GENERAL, extra = {}) => T.push({ fam, states: states.map(M), dir, sup, ...extra });
  const facingOpp = (t) => OPP[parseBlockState(t).props.facing];
  const upper = (t) => [[0, 1, 0, setProps(t, { half: 'upper' })]];
  // light sources & small attachables
  add('torch', ['torch', 'soul_torch', 'redstone_torch[lit=true]', 'copper_torch'], () => 'down');
  add('wall_torch', H.map((d) => `wall_torch[facing=${d}]`).concat(['soul_wall_torch[facing=east]', 'redstone_wall_torch[facing=north,lit=true]']), facingOpp);
  add('lantern(standing)', lanterns.slice(0, 3).map((l) => `${l}[hanging=false,waterlogged=false]`), () => 'down');
  add('lantern(hanging)', lanterns.slice(0, 3).map((l) => `${l}[hanging=true,waterlogged=false]`), () => 'up');
  add('candle', ['candle[candles=1,lit=false,waterlogged=false]', 'red_candle[candles=4,lit=false,waterlogged=false]'], () => 'down');
  add('candle_cake/cake', ['candle_cake[lit=false]', 'cake[bites=0]'], () => 'down');
  add('ladder', H.map((d) => `ladder[facing=${d},waterlogged=false]`), facingOpp);
  // signs & banners
  add('sign(standing)', ['oak_sign[rotation=0,waterlogged=false]', 'spruce_sign[rotation=6,waterlogged=false]'], () => 'down');
  add('wall_sign', ['oak_wall_sign[facing=north,waterlogged=false]', 'birch_wall_sign[facing=east,waterlogged=false]'], facingOpp);
  add('hanging_sign(ceiling)', ['oak_hanging_sign[attached=false,rotation=0,waterlogged=false]', 'spruce_hanging_sign[attached=true,rotation=4,waterlogged=false]'], () => 'up');
  add('wall_hanging_sign', ['oak_wall_hanging_sign[facing=north,waterlogged=false]', 'oak_wall_hanging_sign[facing=east,waterlogged=false]'], (t) => CW[parseBlockState(t).props.facing]);
  add('banner(standing)', ['white_banner[rotation=0]', 'red_banner[rotation=8]'], () => 'down');
  add('wall_banner', ['white_wall_banner[facing=north]', 'blue_wall_banner[facing=west]'], facingOpp);
  // face-attached
  add('button/lever(floor)', ['stone_button[face=floor,facing=north,powered=false]', 'oak_button[face=floor,facing=east,powered=false]', 'lever[face=floor,facing=north,powered=false]'], () => 'down');
  add('button/lever(ceiling)', ['stone_button[face=ceiling,facing=north,powered=false]', 'lever[face=ceiling,facing=west,powered=false]'], () => 'up');
  add('button/lever(wall)', ['stone_button[face=wall,facing=north,powered=false]', 'oak_button[face=wall,facing=east,powered=false]', 'lever[face=wall,facing=south,powered=false]'], facingOpp);
  add('tripwire_hook', ['tripwire_hook[attached=false,facing=north,powered=false]', 'tripwire_hook[attached=false,facing=west,powered=false]'], facingOpp);
  add('bell', ['bell[attachment=floor,facing=north,powered=false]'], () => 'down');
  add('bell(ceiling)', ['bell[attachment=ceiling,facing=north,powered=false]'], () => 'up');
  add('bell(single_wall)', ['bell[attachment=single_wall,facing=north,powered=false]', 'bell[attachment=single_wall,facing=east,powered=false]'], (t) => parseBlockState(t).props.facing);
  add('amethyst_bud', D6.map((d) => `amethyst_cluster[facing=${d},waterlogged=false]`).concat(['small_amethyst_bud[facing=up,waterlogged=false]']), facingOpp);
  add('cocoa', H.map((d) => `cocoa[age=0,facing=${d}]`), (t) => parseBlockState(t).props.facing);
  add('dead_coral_wall_fan', ['dead_brain_coral_wall_fan[facing=north,waterlogged=false]', 'dead_tube_coral_wall_fan[facing=east,waterlogged=false]'], facingOpp);
  add('dead_coral(floor)', ['dead_brain_coral[waterlogged=false]', 'dead_horn_coral_fan[waterlogged=false]'], () => 'down');
  // floor covers
  add('carpet', ['white_carpet', 'moss_carpet', 'pale_moss_carpet[bottom=true,east=none,north=none,south=none,west=none]'], () => 'down');
  add('pressure_plate', ['stone_pressure_plate[powered=false]', 'oak_pressure_plate[powered=false]', 'light_weighted_pressure_plate[power=0]'], () => 'down');
  add('rail(flat)', ['rail[shape=north_south,waterlogged=false]', 'powered_rail[powered=false,shape=east_west,waterlogged=false]', 'detector_rail[powered=false,shape=north_south,waterlogged=false]', 'rail[shape=north_east,waterlogged=false]'], () => 'down');
  add('rail(ascending, slope side)', ['rail[shape=ascending_north,waterlogged=false]', 'activator_rail[powered=false,shape=ascending_east,waterlogged=false]'], (t) => parseBlockState(t).props.shape.slice(10), GENERAL,
    { ctx: () => [[0, -1, 0, 'minecraft:stone']] });
  add('redstone_wire', ['redstone_wire[east=none,north=none,power=0,south=none,west=none]', 'redstone_wire[east=side,north=side,power=0,south=side,west=side]'], () => 'down');
  add('repeater/comparator', ['repeater[delay=1,facing=north,locked=false,powered=false]', 'comparator[facing=east,mode=compare,powered=false]'], () => 'down');
  add('snow_layer', ['snow[layers=1]', 'snow[layers=3]', 'snow[layers=7]'], () => 'down');
  add('door', ['oak_door[facing=north,half=lower,hinge=left,open=false,powered=false]', 'iron_door[facing=east,half=lower,hinge=right,open=true,powered=false]'], () => 'down', GENERAL, { partner: upper });
  add('leaf_litter/petals', ['leaf_litter[facing=north,segment_amount=1]', 'pink_petals[facing=north,flower_amount=2]', 'wildflowers[facing=north,flower_amount=1]'], () => 'down', GROUND);
  // hanging plants
  add('hanging_roots/spore_blossom', ['hanging_roots[waterlogged=false]', 'spore_blossom'], () => 'up');
  add('cave/weeping vines', ['cave_vines[age=0,berries=false]', 'weeping_vines[age=0]', 'cave_vines_plant[berries=false]'], () => 'up');
  add('twisting_vines', ['twisting_vines[age=0]'], () => 'down');
  add('pale_hanging_moss', ['pale_hanging_moss[tip=true]'], () => 'up');
  add('pointed_dripstone', ['pointed_dripstone[thickness=tip,vertical_direction=up,waterlogged=false]'], () => 'down');
  add('pointed_dripstone(hanging)', ['pointed_dripstone[thickness=tip,vertical_direction=down,waterlogged=false]'], () => 'up');
  add('mangrove_propagule(hanging)', ['mangrove_propagule[age=4,hanging=true,stage=0,waterlogged=false]'], () => 'up');
  // ground plants (vanilla mayPlaceOn)
  add('flower/grass/sapling', ['poppy', 'dandelion', 'short_grass', 'fern', 'oak_sapling[stage=0]', 'bush', 'firefly_bush', 'sweet_berry_bush[age=0]'], () => 'down', GROUND);
  add('tall_plant(lower)', ['sunflower[half=lower]', 'tall_grass[half=lower]', 'rose_bush[half=lower]'], () => 'down', GROUND, { partner: upper });
  add('crops', ['wheat[age=0]', 'carrots[age=0]', 'beetroots[age=0]', 'pumpkin_stem[age=0]', 'torchflower_crop[age=0]'], () => 'down', GROUND);
  add('dry vegetation', ['dead_bush', 'short_dry_grass', 'tall_dry_grass'], () => 'down', GROUND);
  add('nether plants', ['nether_wart[age=0]', 'crimson_fungus', 'warped_roots', 'nether_sprouts', 'wither_rose'], () => 'down', GROUND);
  add('mushroom', ['brown_mushroom', 'red_mushroom'], () => 'down', GROUND);
  add('azalea/dripleaf', ['azalea', 'flowering_azalea', 'big_dripleaf[facing=north,tilt=none,waterlogged=false]'], () => 'down', GROUND);
  add('small_dripleaf(lower)', ['small_dripleaf[facing=north,half=lower,waterlogged=false]'], () => 'down', GROUND, { partner: upper });
  add('mangrove_propagule', ['mangrove_propagule[age=0,hanging=false,stage=0,waterlogged=false]'], () => 'down', GROUND);
  add('cactus', ['cactus[age=0]'], () => 'down', GROUND);
  add('cactus(side neighbour)', ['cactus[age=0]'], () => 'north', GENERAL, { ctx: () => [[0, -1, 0, 'minecraft:sand']] });
  add('cactus_flower', ['cactus_flower'], () => 'down', GROUND);
  add('bamboo', ['bamboo[age=0,leaves=none,stage=0]', 'bamboo_sapling'], () => 'down', GROUND);
  add('sugar_cane(no water)', ['sugar_cane[age=0]'], () => 'down', GROUND);
  add('sea_pickle(dry)', ['sea_pickle[pickles=1,waterlogged=false]'], () => 'down');
  add('chorus', ['chorus_flower[age=0]', 'chorus_plant[down=false,east=false,north=false,south=false,up=false,west=false]'], () => 'down', GROUND);
  add('scaffolding', ['scaffolding[bottom=false,distance=0,waterlogged=false]'], () => 'down');
  add('gravity', ['sand', 'gravel', 'red_concrete_powder', 'anvil[facing=north]'], () => 'down', GENERAL.filter((s) => s !== 'sand' && s !== 'gravel'));
  // multiface: vines (all horizontal faces + up evaluated) and glow lichen (face of the trigger direction)
  add('vine', ['vine[east=false,north=true,south=false,up=false,west=false]', 'vine[east=true,north=false,south=false,up=true,west=false]', 'vine[east=false,north=false,south=false,up=true,west=false]'],
    (t) => (parseBlockState(t).props.north === 'true' ? 'north' : parseBlockState(t).props.east === 'true' ? 'east' : 'up'), GENERAL, { multiface: true });
  add('glow_lichen', ['glow_lichen[down=false,east=false,north=true,south=false,up=false,waterlogged=false,west=false]', 'glow_lichen[down=true,east=false,north=false,south=false,up=false,waterlogged=false,west=false]',
    'sculk_vein[down=false,east=false,north=false,south=false,up=true,waterlogged=false,west=false]', 'resin_clump[down=false,east=true,north=false,south=false,up=false,waterlogged=false,west=false]'],
  (t) => D6.find((d) => parseBlockState(t).props[d] === 'true'), GENERAL, { multiface: true });
  // controls: vanilla has no survival rule (must stay everywhere)
  add('no-rule controls', ['flower_pot', 'player_head[powered=false,rotation=0]', 'iron_chain[axis=y,waterlogged=false]', 'end_rod[facing=up]', 'lightning_rod[facing=up,powered=false,waterlogged=false]',
    'red_bed[facing=north,occupied=false,part=foot]', 'decorated_pot[cracked=false,facing=north,waterlogged=false]', 'brewing_stand', 'turtle_egg[eggs=1,hatch=0]', 'heavy_core[waterlogged=false]'], () => 'down');
  return T;
}

// ------------------------------------------------------------------ suite

function famName(s) {
  const id = idOf(s).slice(10);
  let p = {};
  try { p = parseBlockState(s).props; } catch {}
  if (/_slab$/.test(id)) return `${id}[type=${p.type}]`;
  if (/_stairs$/.test(id)) return `${id}[facing=${p.facing},half=${p.half}]`;
  if (/_trapdoor$/.test(id)) return `${id}[facing=${p.facing},half=${p.half},open=${p.open}]`;
  if (id === 'snow') return `snow[layers=${p.layers}]`;
  if (p.axis) return `${id}[axis=${p.axis}]`;
  if (p.facing && !/head|skull|sign|banner/.test(id)) return `${id}[facing=${p.facing}]`;
  if (p.vertical_direction) return `${id}[${p.vertical_direction}]`;
  if (p.hanging) return `${id}[hanging=${p.hanging}]`;
  return id;
}

export async function runSupport({ engine, reg, seed = 1, cases: maxCases, log = console.log }) {
  // build the case list
  const r = rng(seed);
  const all = [];
  let invalid = 0;
  const canon = (s) => { try { return reg.canonical(M(s)); } catch (e) { invalid++; if (invalid <= 8) log(`    (pool) invalid state ${s}: ${e.message.split('.')[0]}`); return null; } };
  for (const spec of targets(reg)) {
    const sups = [...new Set(spec.sup.map(canon).filter(Boolean))];
    for (const t0 of spec.states) {
      const t = canon(t0);
      if (!t) continue;
      const d = spec.dir(t);
      for (const s of sups) all.push({ fam: spec.fam, t, d, s, partner: spec.partner?.(t) ?? [], ctx: spec.ctx?.(t, r) ?? [], multiface: !!spec.multiface });
    }
  }
  // optional sampling (deterministic shuffle)
  let list = all;
  if (maxCases && maxCases < all.length) {
    list = all.slice();
    for (let i = list.length - 1; i > 0; i--) { const j = r.int(i + 1); [list[i], list[j]] = [list[j], list[i]]; }
    list = list.slice(0, maxCases);
  }
  log(`  support: ${list.length} cases (${all.length} possible) over ${new Set(list.map((c) => c.fam)).size} families`);

  const per = AREA.cols * AREA.rows;
  const results = [];
  for (let start = 0; start < list.length; start += per) {
    const round = list.slice(start, start + per);
    const placed = [];
    const clear = new Batch();
    const { x0, z0, y, pitch, cols, rows } = AREA;
    const box = { min: [x0 - 2, y - 3, z0 - 2], max: [x0 + cols * pitch + 1, y + 3, z0 + rows * pitch + 1] };
    for (let yy = box.min[1]; yy <= box.max[1]; yy++) for (let zz = box.min[2]; zz <= box.max[2]; zz++) for (let xx = box.min[0]; xx <= box.max[0]; xx++) clear.add(xx, yy, zz, 'minecraft:air');
    await engine.setBlocks(clear, { updateShapes: false });
    const b = new Batch();
    round.forEach((c, k) => {
      const P = [x0 + (k % cols) * pitch + 1, y, z0 + Math.floor(k / cols) * pitch + 1];
      const v = VEC[c.d];
      const S = [P[0] + v[0], P[1] + v[1], P[2] + v[2]];
      const ped = [P[0] + 2 * v[0], P[1] + 2 * v[1], P[2] + 2 * v[2]];
      c.P = P; c.S = S;
      const scene = new Map();
      const put = (q, s) => scene.set(q.join(','), s);
      put(ped, 'minecraft:stone');
      // keep the candidate support itself stable: for side supports a stone under it (diagonal to T)
      if (v[1] === 0) put([S[0], S[1] - 1, S[2]], 'minecraft:stone');
      for (const [dx, dy, dz, s] of c.ctx) put([P[0] + dx, P[1] + dy, P[2] + dz], s);
      for (const [dx, dy, dz, s] of c.partner) put([P[0] + dx, P[1] + dy, P[2] + dz], s);
      put(P, c.t);
      put(S, c.s === 'minecraft:air' ? 'minecraft:stone' : 'minecraft:air');
      for (const [k2, s] of scene) { const [a, bb, cc] = k2.split(',').map(Number); b.add(a, bb, cc, s); }
      // the scene the engine judges: S in place
      scene.set(S.join(','), c.s);
      c.scene = scene;
      placed.push(c);
    });
    await engine.setBlocks(b, { updateShapes: false });
    // trigger: vanilla setblock at the support cell (neighbour updates)
    let cmdFail = 0;
    const queue = placed.slice();
    const worker = async () => {
      for (let c; (c = queue.shift()); ) {
        const res = await engine.command(`setblock ${c.S[0]} ${c.S[1]} ${c.S[2]} ${c.s}`);
        if (!res.ok) { cmdFail++; c.cmdError = res.output; }
      }
    };
    await Promise.all(Array.from({ length: 48 }, worker));
    await engine.waitTicks(8);
    const vol = await engine.getBlocks(box);
    for (const c of placed) {
      const v = vol.get(...c.P);
      const sNow = vol.get(...c.S);
      const get = (x, yy, z) => c.scene.get(`${x},${yy},${z}`) ?? 'minecraft:air';
      const verdict = checkSupportAt(c.P[0], c.P[1], c.P[2], c.t, get, reg);
      const eng = !verdict ? 'stays' : verdict.trim ? 'trimmed' : verdict.warnOnly ? 'pops(warn-only)' : 'pops';
      const engState = !verdict ? c.t : verdict.trim ?? null;
      let van;
      if (idOf(v) !== idOf(c.t)) van = 'pops';
      else if (c.multiface && v !== c.t) van = 'trimmed';
      else van = 'stays';
      let match = eng.startsWith('pops') ? van === 'pops' : eng === van;
      if (match && eng === 'trimmed' && engState !== v) match = false;
      // the candidate support broke by itself (cactus on stone, bamboo …) → no verdict possible
      const unstable = c.s !== 'minecraft:air' && idOf(sNow ?? 'minecraft:air') !== idOf(c.s);
      if (unstable) match = true;
      results.push({ ...c, vanilla: van, vanillaState: v, supportNow: sNow, engine: eng, engineState: engState, match, unstable });
    }
    if (cmdFail) log(`    round ${start / per + 1}: ${cmdFail} setblock commands failed (e.g. ${placed.find((c) => c.cmdError)?.cmdError})`);
    log(`    round ${start / per + 1}: ${round.length} cases, ${results.slice(start).filter((x) => !x.match).length} mismatches`);
  }

  // phase 2 — "mod placement": the same scenes placed in ONE set_blocks with updateShapes=true
  // (exactly how mcAI builds) and nothing else. The mod's shape pass rejects id changes, but
  // updateShape still schedules ticks (cactus, cane, chorus, dripstone, gravity …), so some
  // unsupported blocks still break right after an mcAI build.
  for (let start = 0; start < results.length; start += per) {
    const round = results.slice(start, start + per);
    const { x0, z0, y, pitch, cols, rows } = AREA;
    const box = { min: [x0 - 2, y - 3, z0 - 2], max: [x0 + cols * pitch + 1, y + 3, z0 + rows * pitch + 1] };
    const clear = new Batch();
    for (let yy = box.min[1]; yy <= box.max[1]; yy++) for (let zz = box.min[2]; zz <= box.max[2]; zz++) for (let xx = box.min[0]; xx <= box.max[0]; xx++) clear.add(xx, yy, zz, 'minecraft:air');
    await engine.setBlocks(clear, { updateShapes: false });
    const b = new Batch();
    for (const c of round) for (const [k2, st] of c.scene) { if (st === 'minecraft:air') continue; const [a, bb, cc] = k2.split(',').map(Number); b.add(a, bb, cc, st); }
    await engine.setBlocks(b, { updateShapes: true });
    await engine.waitTicks(8);
    const vol = await engine.getBlocks(box);
    for (const c of round) {
      const v = vol.get(...c.P);
      c.modPlace = c.s !== 'minecraft:air' && idOf(vol.get(...c.S) ?? 'minecraft:air') !== idOf(c.s) ? 'support-broke' : idOf(v) !== idOf(c.t) ? 'pops' : v !== c.t ? 'changed' : 'stays';
      c.modPlaceState = v;
    }
  }
  const modPops = new Map();
  for (const x of results) {
    if (x.modPlace !== 'pops') continue;
    const k = x.fam + ' | ' + idOf(x.t).slice(10);
    let g = modPops.get(k);
    if (!g) modPops.set(k, (g = { fam: x.fam, target: idOf(x.t).slice(10), count: 0, of: results.filter((y) => y.t === x.t && y.fam === x.fam && y.modPlace !== 'support-broke').length, engineDrops: 0, vanillaPopsOnUpdate: 0, supports: [] }));
    g.count++;
    if (x.engine.startsWith('pops')) g.engineDrops++;
    if (x.vanilla === 'pops') g.vanillaPopsOnUpdate++;
    if (g.supports.length < 6) g.supports.push(famName(x.s));
  }
  const modPlacePops = [...modPops.values()].sort((a, b) => b.count - a.count);
  log(`  mod placement (set_blocks updateShapes=true only): ${results.filter((x) => x.modPlace === 'pops').length} of ${results.length} targets broke by themselves`);
  for (const g of modPlacePops) log(`    ${g.fam} ${g.target}: ${g.count}/${g.of} broke (engine drops ${g.engineDrops} of them), e.g. on ${g.supports.join(', ')}`);

  // group
  const groups = new Map();
  const famStats = {};
  for (const x of results) {
    const fs = (famStats[x.fam] ??= { cases: 0, mismatches: 0, unstableSupport: 0 });
    fs.cases++;
    if (x.unstable) fs.unstableSupport++;
    if (x.match) continue;
    fs.mismatches++;
    const target = idOf(x.t).slice(10);
    const sig = `${x.fam} ${target} | ${x.d}: ${famName(x.s)} | engine ${x.engine}, vanilla ${x.vanilla}`;
    let g = groups.get(sig);
    if (!g) groups.set(sig, (g = { sig, fam: x.fam, target, dir: x.d, support: famName(x.s), engine: x.engine, vanilla: x.vanilla, count: 0, examples: [] }));
    g.count++;
    if (g.examples.length < 1) g.examples.push({ target: short(x.t), support: short(x.s), dir: x.d, pos: x.P, vanillaResult: short(x.vanillaState), supportAfter: short(x.supportNow), engineState: x.engineState && short(x.engineState),
      scene: Object.fromEntries([...x.scene].map(([k, s]) => { const q = k.split(',').map(Number); return [`${q[0] - x.P[0]},${q[1] - x.P[1]},${q[2] - x.P[2]}`, short(s)]; })) });
  }
  const out = [...groups.values()].sort((a, b) => a.fam.localeCompare(b.fam) || b.count - a.count);
  // compact per-target view: which supports the engine gets wrong in each direction
  const byTarget = {};
  for (const g of out) {
    const t = (byTarget[`${g.fam}: ${g.target}`] ??= { engineKeepsVanillaPops: [], engineDropsVanillaKeeps: [], other: [] });
    const list = g.engine === 'stays' && g.vanilla === 'pops' ? t.engineKeepsVanillaPops : g.engine.startsWith('pops') && g.vanilla === 'stays' ? t.engineDropsVanillaKeeps : t.other;
    const label = list === t.other ? `${g.support} (engine ${g.engine}, vanilla ${g.vanilla})` : g.support;
    if (!list.includes(label)) list.push(label);
  }
  const mism = results.filter((x) => !x.match).length;
  log(`  support: ${results.length} cases, ${mism} mismatches in ${out.length} groups`);
  for (const [fam, s] of Object.entries(famStats)) if (s.mismatches) log(`    ${fam.padEnd(32)} ${String(s.mismatches).padStart(4)}/${s.cases}`);
  for (const [t, v] of Object.entries(byTarget)) {
    const cut = (l) => (l.length > 8 ? `${l.slice(0, 8).join(', ')} … (+${l.length - 8})` : l.join(', '));
    if (v.engineKeepsVanillaPops.length) log(`    ${t}: engine keeps / vanilla pops on ${cut(v.engineKeepsVanillaPops)}`);
    if (v.engineDropsVanillaKeeps.length) log(`    ${t}: engine drops / vanilla keeps on ${cut(v.engineDropsVanillaKeeps)}`);
  }
  return { cases: results.length, mismatches: mism, invalidPoolStates: invalid, families: famStats, byTarget, modPlacePops, groups: out };
}
