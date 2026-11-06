// Suite "connect": randomized small scenes placed in the REAL 26.3 world through the mod's
// set_blocks (updateShapes = vanilla Block.updateFromNeighbourShapes for every placed block, then
// for adjacent existing blocks), read back with get_blocks and compared with engine connect.ts
// solveConnections over the same scene.
//
// Notes on faithfulness:
//  * input order is top-down (the mod's shape pass follows input order; a wall's tall/low/up
//    depends on the final state of the block above, so top-down = the vanilla fixed point);
//  * the mod only accepts shape results that keep the block id, so every scene block that needs
//    support gets it (redstone wire only on vanilla canSurviveOn blocks, doors as two halves …);
//  * no fluids, no gravity blocks, leaves persistent, waterlogged=false (no scheduled-tick noise);
//  * blocks vanilla re-shapes that the engine does not model at all (snowy grass, chests, …) are
//    reported separately ("unmodelled").
import { solveConnections } from '../../engine/src/core/connect.ts';
import { parseBlockState } from '../../engine/src/core/blockstate.ts';
import { Batch, rng } from './lib.mjs';
import { bit } from './probe.mjs';

const H = ['north', 'east', 'south', 'west'];
const OFF = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] };
export const AREA = { x0: 3000, z0: 3000, y0: -60, pitch: 8, cols: 16 };
const GROUND = 'minecraft:grass_block[snowy=false]';

// ------------------------------------------------------------------ pools

const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'bamboo', 'crimson', 'warped', 'poplar'];
const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];

function families(reg) {
  const ids = reg.ids().map((i) => i.slice(10));
  const f = (re) => ids.filter((i) => re.test(i));
  return {
    fences: f(/_fence$/),
    walls: f(/_wall$/).filter((i) => reg.hasTag(`minecraft:${i}`, 'minecraft:walls')),
    panes: f(/_pane$|_bars$/),
    stairs: f(/_stairs$/),
    slabs: f(/_slab$/).filter((i) => !i.includes('petrified')),
    gates: f(/_fence_gate$/),
    trapdoors: f(/_trapdoor$/),
    doors: f(/_door$/),
    chains: f(/_chain$/),
    leaves: f(/_leaves$/),
    carpets: f(/_carpet$/),
    plates: f(/_pressure_plate$/),
    lanterns: f(/^(.*_)?lantern$/).filter((i) => i !== 'sea_lantern' && i !== 'jack_o_lantern'),
    shulkers: f(/shulker_box$/),
    rods: f(/lightning_rod$/),
  };
}

export function makePools(reg, F) {
  const P = (s) => s.includes(':') ? s : `minecraft:${s}`;
  const one = (r, list) => P(r.pick(list));
  const H4 = () => H;
  const anyDir6 = ['north', 'east', 'south', 'west', 'up', 'down'];
  // "neighbour" blocks: everything a fence/pane/wall/stairs/wire may see next to it
  const nei = [
    () => 'stone', () => 'oak_planks', () => 'glass', (r) => `${r.pick(COLORS)}_stained_glass`, () => 'bookshelf', () => 'crafting_table',
    (r) => `${r.pick(F.leaves)}[persistent=true,waterlogged=false]`, () => 'pumpkin', (r) => `carved_pumpkin[facing=${r.pick(H)}]`, () => 'melon',
    (r) => `jack_o_lantern[facing=${r.pick(H)}]`, () => 'barrier[waterlogged=false]', (r) => `${r.pick(F.shulkers)}[facing=${r.pick(anyDir6)}]`,
    () => 'ice', () => 'packed_ice', () => 'glowstone', () => 'sea_lantern', () => 'redstone_block', () => 'slime_block', () => 'honey_block', () => 'tnt',
    () => 'spawner', () => 'beacon', () => 'mud', () => 'soul_sand', () => 'copper_grate[waterlogged=false]', () => 'mangrove_roots[waterlogged=false]',
    (r) => `chest[facing=${r.pick(H)},type=single,waterlogged=false]`, (r) => `ender_chest[facing=${r.pick(H)},waterlogged=false]`, (r) => `barrel[facing=${r.pick(anyDir6)},open=false]`,
    (r) => `${r.pick(F.slabs)}[type=${r.pick(['bottom', 'top', 'double'])},waterlogged=false]`,
    (r) => `${r.pick(F.stairs)}[facing=${r.pick(H)},half=${r.pick(['bottom', 'top'])},shape=straight,waterlogged=false]`,
    (r) => `${r.pick(F.trapdoors)}[facing=${r.pick(H)},half=${r.pick(['bottom', 'top'])},open=${r.pick(['true', 'false'])},powered=false,waterlogged=false]`,
    (r) => `ladder[facing=${r.pick(H)},waterlogged=false]`, (r) => `${r.pick(F.lanterns)}[hanging=false,waterlogged=false]`, () => 'torch',
    (r) => `${r.pick(F.chains)}[axis=${r.pick(['x', 'y', 'z'])},waterlogged=false]`, (r) => `end_rod[facing=${r.pick(anyDir6)}]`,
    (r) => `${r.pick(F.rods)}[facing=${r.pick(anyDir6)},powered=false,waterlogged=false]`,
    (r) => `hopper[enabled=true,facing=${r.pick(['down', ...H])}]`, () => 'composter[level=0]', () => 'cauldron', () => 'water_cauldron[level=3]', () => 'farmland[moisture=0]', () => 'dirt_path',
    (r) => `snow[layers=${1 + r.int(8)}]`, (r) => `anvil[facing=${r.pick(H)}]`, (r) => `bell[attachment=floor,facing=${r.pick(H)},powered=false]`,
    (r) => `grindstone[face=floor,facing=${r.pick(H)}]`, (r) => `lectern[facing=${r.pick(H)},has_book=false,powered=false]`, (r) => `stonecutter[facing=${r.pick(H)}]`,
    () => 'enchanting_table', () => 'daylight_detector[inverted=false,power=0]', (r) => `${r.pick(F.carpets)}`, (r) => `${r.pick(F.plates)}`,
    () => 'flower_pot', (r) => `player_head[powered=false,rotation=${r.int(16)}]`, (r) => `campfire[facing=${r.pick(H)},lit=false,signal_fire=false,waterlogged=false]`,
    (r) => `piston[extended=false,facing=${r.pick(anyDir6)}]`, (r) => `observer[facing=${r.pick(anyDir6)},powered=false]`, (r) => `dispenser[facing=${r.pick(anyDir6)},triggered=false]`,
    () => 'vault', () => 'trial_spawner', (r) => `decorated_pot[cracked=false,facing=${r.pick(H)},waterlogged=false]`, () => 'heavy_core[waterlogged=false]', () => 'azalea',
    (r) => `oak_shelf[facing=${r.pick(H)},powered=false,side_chain=unconnected,waterlogged=false]`, () => 'scaffolding[bottom=false,distance=0,waterlogged=false]',
    (r) => `${r.pick(F.fences)}`, (r) => `${r.pick(F.walls)}`, (r) => `${r.pick(F.panes)}`,
    (r) => `${r.pick(F.gates)}[facing=${r.pick(H)},in_wall=false,open=${r.pick(['true', 'false'])},powered=false]`,
    () => 'moss_carpet', () => 'pale_moss_carpet[bottom=true,east=none,north=none,south=none,west=none]', () => 'brewing_stand', () => 'cake[bites=0]',
    () => 'conduit[waterlogged=false]', () => 'dried_kelp_block', () => 'target[power=0]', () => 'redstone_lamp[lit=false]', () => 'note_block',
    (r) => `${r.pick(WOODS.filter((w) => w !== 'bamboo' && w !== 'crimson' && w !== 'warped'))}_log[axis=y]`, () => 'cobblestone', () => 'bricks', () => 'white_wool',
    () => 'white_concrete', () => 'terracotta', () => 'sandstone', () => 'glass_pane', () => 'iron_bars', () => 'cactus[age=0]', () => 'chorus_flower[age=0]', () => 'powder_snow',
    () => 'sculk_sensor[power=0,sculk_sensor_phase=inactive,waterlogged=false]', (r) => `repeater[delay=1,facing=${r.pick(H)},locked=false,powered=false]`,
    (r) => `comparator[facing=${r.pick(H)},mode=compare,powered=false]`, () => 'end_portal_frame[eye=false,facing=north]', (r) => `${r.pick(COLORS)}_bed[facing=${r.pick(H)},occupied=false,part=foot]`,
    () => 'iron_block', () => 'smooth_stone', () => 'stripped_oak_wood[axis=y]', () => 'mushroom_stem[down=true,east=true,north=true,south=true,up=true,west=true]',
  ];
  // what sits on top of walls (tall/low/up decisions) — the neighbour pool plus small decorations
  const above = [
    ...nei,
    () => 'torch', () => 'soul_torch', () => 'redstone_torch[lit=true]', () => 'copper_torch', (r) => `${r.pick(F.lanterns)}[hanging=false,waterlogged=false]`,
    () => 'candle[candles=1,lit=false,waterlogged=false]', (r) => `${r.pick(WOODS)}_sign[rotation=${r.int(16)},waterlogged=false]`, (r) => `${r.pick(COLORS)}_banner[rotation=${r.int(16)}]`,
    (r) => `${r.pick(F.plates)}`, (r) => `${r.pick(F.carpets)}`, () => 'flower_pot', () => 'potted_poppy', () => 'skeleton_skull[powered=false,rotation=0]',
    () => 'sea_pickle[pickles=1,waterlogged=false]', () => 'end_rod[facing=up]', (r) => `${r.pick(F.chains)}[axis=y,waterlogged=false]`, () => 'lightning_rod[facing=up,powered=false,waterlogged=false]',
    () => 'brewing_stand', () => 'cake[bites=0]', (r) => `${r.pick(F.slabs)}[type=bottom,waterlogged=false]`, (r) => `${r.pick(F.slabs)}[type=top,waterlogged=false]`,
    (r) => `${r.pick(F.trapdoors)}[facing=${r.pick(H)},half=bottom,open=false,powered=false,waterlogged=false]`, () => 'snow[layers=1]', () => 'moss_carpet',
    () => 'turtle_egg[eggs=1,hatch=0]', () => 'amethyst_cluster[facing=up,waterlogged=false]', () => 'stone_button[face=floor,facing=north,powered=false]', () => 'lever[face=floor,facing=north,powered=false]',
    () => 'redstone_wire[east=none,north=none,power=0,south=none,west=none]', () => 'rail[shape=north_south,waterlogged=false]',
  ];
  return { nei, above, one };
}

// ------------------------------------------------------------------ scene generators

/** scene = Map "dx,dy,dz" → state ; generators may also return `notes` */
function cell() {
  const m = new Map();
  return {
    m,
    set(x, y, z, s) { m.set(`${x},${y},${z}`, s.includes(':') ? s : `minecraft:${s}`); },
    get(x, y, z) { return m.get(`${x},${y},${z}`); },
  };
}

function randomFence(r, F) { return r.pick(F.fences); }

export function generators(reg, F, pools, probe) {
  const nb = (r) => r.pick(pools.nei)(r);
  const ab = (r) => r.pick(pools.above)(r);
  const rndConn = (r, kind) => H.map((d) => `${d}=${kind === 'wall' ? r.pick(['none', 'low', 'tall']) : r.pick(['true', 'false'])}`).join(',');
  const wallSt = (r, id) => `${id}[${rndConn(r, 'wall')},up=${r.pick(['true', 'false'])},waterlogged=false]`;
  const fenceSt = (r, id) => `${id}[${rndConn(r, 'fence')},waterlogged=false]`;
  const door = (c, r, x, y, z) => {
    const id = r.pick(F.doors);
    const p = `facing=${r.pick(H)},hinge=${r.pick(['left', 'right'])},open=${r.pick(['true', 'false'])},powered=false`;
    c.set(x, y, z, `${id}[${p},half=lower]`);
    c.set(x, y + 1, z, `${id}[${p},half=upper]`);
  };
  const focusMix = (kind) => (r) => {
    const c = cell();
    const fam = kind === 'fence' ? [r.pick(F.fences), r.pick(F.fences)] : kind === 'pane' ? [r.pick(F.panes), r.pick(F.panes)] : [r.pick(F.walls), r.pick(F.walls)];
    const h = 1 + r.int(2);
    for (let y = 0; y < h; y++) for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) {
      if (c.get(x, y, z)) continue;
      const u = r();
      if (u < 0.45) {
        const id = r.pick(fam);
        c.set(x, y, z, kind === 'wall' ? wallSt(r, id) : fenceSt(r, id));
      } else if (u < 0.75) {
        if (r.chance(0.06) && y + 1 < 3) door(c, r, x, y, z);
        else c.set(x, y, z, nb(r));
      }
    }
    return c;
  };
  return {
    fence: focusMix('fence'),
    pane: focusMix('pane'),
    wall: focusMix('wall'),
    // walls (lines, corners, crosses) with random things on top and walls stacked
    wall_above: (r) => {
      const c = cell();
      const id = r.pick(F.walls);
      const shape = r.pick(['line_x', 'line_z', 'corner', 'cross', 'tee', 'random']);
      const on = (x, z) => {
        if (shape === 'line_x') return z === 2;
        if (shape === 'line_z') return x === 2;
        if (shape === 'corner') return (z === 2 && x >= 2) || (x === 2 && z >= 2);
        if (shape === 'cross') return x === 2 || z === 2;
        if (shape === 'tee') return z === 2 || (x === 2 && z > 2);
        return r.chance(0.5);
      };
      for (let z = 0; z < 5; z++) for (let x = 0; x < 5; x++) {
        if (!on(x, z)) { if (r.chance(0.1)) c.set(x, 0, z, nb(r)); continue; }
        c.set(x, 0, z, wallSt(r, r.chance(0.8) ? id : r.pick(F.walls)));
        const t = r();
        if (t < 0.25) c.set(x, 1, z, wallSt(r, r.chance(0.7) ? id : r.pick(F.walls)));
        else if (t < 0.75) c.set(x, 1, z, ab(r));
        if (t < 0.25 && r.chance(0.5)) c.set(x, 2, z, ab(r));
      }
      return c;
    },
    // stairs corners: dense random stairs (mixed materials / halves)
    stairs: (r) => {
      const c = cell();
      const ids = [r.pick(F.stairs), r.pick(F.stairs)];
      const halves = r.chance(0.5) ? ['bottom'] : ['bottom', 'top'];
      const h = r.chance(0.3) ? 2 : 1;
      for (let y = 0; y < h; y++) for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) {
        const u = r();
        if (u < 0.7) c.set(x, y, z, `${r.pick(ids)}[facing=${r.pick(H)},half=${r.pick(halves)},shape=${r.pick(['straight', 'inner_left', 'inner_right', 'outer_left', 'outer_right'])},waterlogged=false]`);
        else if (u < 0.8) c.set(x, y, z, nb(r));
      }
      return c;
    },
    // fence gates between walls / fences (in_wall + gate connections)
    gate: (r) => {
      const c = cell();
      const along = r.pick(['x', 'z']);
      const gf = along === 'x' ? r.pick(['north', 'south']) : r.pick(['east', 'west']);
      for (let i = 0; i < 5; i++) {
        const [x, z] = along === 'x' ? [i, 2] : [2, i];
        const u = r();
        if (i === 2 || u < 0.25) c.set(x, 0, z, `${r.pick(F.gates)}[facing=${r.chance(0.8) ? gf : r.pick(H)},in_wall=${r.pick(['true', 'false'])},open=${r.pick(['true', 'false'])},powered=false]`);
        else if (u < 0.55) c.set(x, 0, z, wallSt(r, r.pick(F.walls)));
        else if (u < 0.85) c.set(x, 0, z, fenceSt(r, r.pick(F.fences)));
        else c.set(x, 0, z, nb(r));
        if (r.chance(0.2)) c.set(x, 1, z, ab(r));
      }
      // side neighbours perpendicular to the line
      for (let k = 0; k < 3; k++) {
        const i = r.int(5);
        const [x, z] = along === 'x' ? [i, r.pick([1, 3])] : [r.pick([1, 3]), i];
        c.set(x, 0, z, r.chance(0.5) ? fenceSt(r, r.pick(F.fences)) : wallSt(r, r.pick(F.walls)));
      }
      return c;
    },
    // redstone wire: floors / steps / components; every wire stands on a vanilla canSurviveOn block
    redstone: (r) => {
      const c = cell();
      const floorPool = ['stone', 'glass', 'oak_planks', 'glowstone', 'redstone_lamp[lit=false]', 'slime_block', 'smooth_stone_slab[type=top,waterlogged=false]',
        'smooth_stone_slab[type=bottom,waterlogged=false]', 'hopper[enabled=true,facing=down]', 'oak_leaves[persistent=true,waterlogged=false]', 'white_stained_glass', 'observer[facing=up,powered=false]',
        'oak_stairs[facing=north,half=top,shape=straight,waterlogged=false]', 'oak_trapdoor[facing=north,half=top,open=false,powered=false,waterlogged=false]', 'piston[extended=false,facing=up]', 'tnt', 'redstone_block', 'ice', 'soul_sand'];
      const comps = [
        () => 'redstone_torch[lit=true]', (r2) => `redstone_wall_torch[facing=${r2.pick(H)},lit=true]`, (r2) => `repeater[delay=1,facing=${r2.pick(H)},locked=false,powered=false]`,
        (r2) => `comparator[facing=${r2.pick(H)},mode=compare,powered=false]`, (r2) => `observer[facing=${r2.pick(['north', 'east', 'south', 'west', 'up', 'down'])},powered=false]`,
        (r2) => `lever[face=floor,facing=${r2.pick(H)},powered=false]`, (r2) => `stone_button[face=floor,facing=${r2.pick(H)},powered=false]`, () => 'target[power=0]',
        () => 'redstone_block', () => 'stone_pressure_plate[powered=false]', () => 'daylight_detector[inverted=false,power=0]', (r2) => `trapped_chest[facing=${r2.pick(H)},type=single,waterlogged=false]`,
        (r2) => `tripwire_hook[attached=false,facing=${r2.pick(H)},powered=false]`, () => 'lectern[facing=north,has_book=false,powered=false]', () => 'sculk_sensor[power=0,sculk_sensor_phase=inactive,waterlogged=false]',
        () => 'redstone_lamp[lit=false]', () => 'note_block', () => 'stone', () => 'glass', () => 'oak_slab[type=bottom,waterlogged=false]', (r2) => `oak_trapdoor[facing=${r2.pick(H)},half=bottom,open=false,powered=false,waterlogged=false]`,
      ];
      const wireInit = (r2) => {
        const k = r2();
        const sides = k < 0.34 ? ['none', 'none', 'none', 'none'] : k < 0.67 ? ['side', 'side', 'side', 'side'] : H.map(() => r2.pick(['none', 'side', 'up']));
        return `redstone_wire[east=${sides[1]},north=${sides[0]},power=0,south=${sides[2]},west=${sides[3]}]`;
      };
      const canHoldWire = (s) => {
        const st = reg.canonical(s.includes(':') ? s : `minecraft:${s}`);
        const v = probe.get(st);
        return v ? bit(v.full, 'up') || st.startsWith('minecraft:hopper[') : false;
      };
      for (let z = 0; z < 5; z++) for (let x = 0; x < 5; x++) c.set(x, 0, z, r.chance(0.85) ? r.pick(floorPool) : r.pick(floorPool));
      for (let z = 0; z < 5; z++) for (let x = 0; x < 5; x++) {
        const u = r();
        if (u < 0.5) { if (canHoldWire(c.get(x, 0, z))) c.set(x, 1, z, wireInit(r)); }
        else if (u < 0.72) c.set(x, 1, z, r.pick(['stone', 'glass', 'oak_planks', 'smooth_stone_slab[type=top,waterlogged=false]', 'white_stained_glass', 'glowstone', 'oak_stairs[facing=north,half=top,shape=straight,waterlogged=false]']));
        else if (u < 0.85) {
          const s = r.pick(comps)(r);
          // components that need support: only on solid floors
          if (canHoldWire(c.get(x, 0, z)) || !/torch|repeater|comparator|lever|button|plate|tripwire/.test(s)) c.set(x, 1, z, s);
        }
      }
      // second level: wire on top of blocks placed on level 1 (slopes); sometimes a block above a wire
      for (let z = 0; z < 5; z++) for (let x = 0; x < 5; x++) {
        const b = c.get(x, 1, z);
        if (b && !b.includes('redstone_wire') && canHoldWire(b) && r.chance(0.5)) c.set(x, 2, z, wireInit(r));
        else if (b && b.includes('redstone_wire') && r.chance(0.12)) c.set(x, 2, z, r.pick(['stone', 'glass', 'glowstone', 'smooth_stone_slab[type=bottom,waterlogged=false]']));
      }
      return c;
    },
    // blocks vanilla re-shapes on neighbour updates that connect.ts does not model at all
    misc: (r) => {
      const c = cell();
      const groundy = r.pick(['grass_block[snowy=false]', 'podzol[snowy=false]', 'mycelium[snowy=false]']);
      for (let x = 0; x < 4; x++) {
        c.set(x, 0, 0, groundy);
        if (r.chance(0.6)) c.set(x, 1, 0, r.pick(['snow[layers=1]', 'snow_block', 'powder_snow', 'stone', 'moss_carpet']));
      }
      const f = r.pick(H);
      c.set(0, 0, 2, `chest[facing=${f},type=single,waterlogged=false]`);
      c.set(1, 0, 2, `chest[facing=${r.chance(0.7) ? f : r.pick(H)},type=single,waterlogged=false]`);
      door(c, r, 3, 0, 2);
      if (r.chance(0.5)) door(c, r, 3, 0, 3);
      c.set(0, 0, 4, r.pick(['sunflower[half=lower]', 'tall_grass[half=lower]', 'lilac[half=lower]']));
      c.set(0, 1, 4, r.pick(['sunflower[half=upper]', 'tall_grass[half=upper]', 'lilac[half=upper]']));
      c.set(2, 0, 4, `tripwire_hook[attached=false,facing=${r.pick(['east', 'west'])},powered=false]`);
      c.set(3, 0, 4, 'tripwire[attached=false,disarmed=false,east=false,north=false,powered=false,south=false,west=false]');
      c.set(4, 0, 4, 'tripwire[attached=false,disarmed=false,east=false,north=false,powered=false,south=false,west=false]');
      c.set(1, 0, 4, 'chorus_plant[down=false,east=false,north=false,south=false,up=false,west=false]');
      c.set(1, 1, 4, 'chorus_flower[age=0]');
      return c;
    },
  };
}

// ------------------------------------------------------------------ comparison helpers

function propsOf(s) { try { return parseBlockState(s.replace(/\{.*$/, '')).props; } catch { return {}; } }
const short = (s) => s?.replace(/^minecraft:/, '') ?? '?';
const idOf = (s) => s.replace(/\[.*$/, '').replace(/\{.*$/, '');

function kindOf(conn, s) { return conn.classify(s).kind; }

/** a compact signature for grouping: block family + differing props + the relevant neighbour */
function signature(conn, state, eng, van, nbr) {
  const kind = kindOf(conn, state);
  const pe = propsOf(eng), pv = propsOf(van);
  const diff = Object.keys({ ...pe, ...pv }).filter((k) => pe[k] !== pv[k]).sort();
  const parts = [];
  for (const k of diff) {
    let rel = '';
    if (H.includes(k)) rel = ` vs ${famName(nbr[k])}`;
    else if (k === 'up' || k === 'tall') rel = ` under ${famName(nbr.up)}`;
    parts.push(`${k}: engine=${pe[k]} vanilla=${pv[k]}${rel}`);
  }
  return { kind, diff, sig: `${kind === 'other' ? idOf(state).slice(10) : kind} | ${parts.join('; ')}` };
}

/** collapse a neighbour state into a family name (for grouping) */
function famName(s) {
  if (!s) return '?';
  const id = idOf(s).slice(10);
  const p = propsOf(s);
  let base = id
    .replace(/^(waxed_)?(exposed_|weathered_|oxidized_)?/, '')
    .replace(new RegExp(`^(${WOODS.join('|')}|${COLORS.join('|')})_`), '*_');
  if (/_slab$/.test(id)) base = `slab[type=${p.type}]`;
  else if (/_stairs$/.test(id)) base = `stairs[${p.facing},${p.half},${p.shape}]`;
  else if (/_trapdoor$/.test(id)) base = `trapdoor[${p.facing},${p.half},open=${p.open}]`;
  else if (/_door$/.test(id)) base = `door[${p.facing},${p.half},open=${p.open},hinge=${p.hinge}]`;
  else if (/_wall$/.test(id)) base = `wall`;
  else if (/_fence$/.test(id)) base = id === 'nether_brick_fence' ? 'nether_brick_fence' : 'wooden_fence';
  else if (/_fence_gate$/.test(id)) base = `fence_gate[${p.facing}]`;
  else if (p.facing && !/head|skull|banner|sign/.test(id)) base += `[${p.facing}]`;
  else if (id === 'snow') base = `snow[layers=${p.layers}]`;
  else if (p.axis) base += `[axis=${p.axis}]`;
  else if (p.hanging) base += `[hanging=${p.hanging}]`;
  return base;
}

// ------------------------------------------------------------------ suite

export async function runConnect({ engine, reg, probe, seed = 1, scenes = 240, log = console.log }) {
  const { connectorFor } = await import('../../engine/src/core/connect.ts');
  const conn = connectorFor(reg);
  const F = families(reg);
  const pools = makePools(reg, F);
  const gens = generators(reg, F, pools, probe);
  const names = Object.keys(gens);
  const weights = { fence: 3, pane: 2, wall: 3, wall_above: 4, stairs: 3, gate: 2, redstone: 3, misc: 1 };
  const bag = names.flatMap((n) => Array(weights[n] ?? 1).fill(n));
  const { x0, z0, y0, pitch, cols } = AREA;
  const H_MAX = 4;

  // build scenes
  const list = [];
  let invalid = 0;
  for (let i = 0; i < scenes; i++) {
    const r = rng(seed * 1_000_003 + i * 7919);
    const fam = bag[i % bag.length];
    const c = gens[fam](r);
    const ox = x0 + (i % cols) * pitch, oz = z0 + Math.floor(i / cols) * pitch;
    const blocks = [];
    for (const [k, s] of c.m) {
      const [dx, dy, dz] = k.split(',').map(Number);
      if (dy >= H_MAX) continue;
      let st;
      try { st = reg.canonical(s); } catch (e) { invalid++; if (invalid < 5) log(`    (pool) invalid state ${s}: ${e.message.split('.')[0]}`); continue; }
      blocks.push([ox + dx, y0 + dy, oz + dz, st]);
    }
    list.push({ i, fam, ox, oz, blocks });
  }
  const rows = Math.ceil(scenes / cols);
  const box = { min: [x0 - 1, y0 - 1, z0 - 1], max: [x0 + cols * pitch, y0 + H_MAX + 1, z0 + rows * pitch] };

  // 1. clear the whole area (no shape updates), ground = grass
  const clear = new Batch();
  for (let y = box.min[1]; y <= box.max[1]; y++) for (let z = box.min[2]; z <= box.max[2]; z++) for (let x = box.min[0]; x <= box.max[0]; x++)
    clear.add(x, y, z, y === y0 - 1 ? GROUND : 'minecraft:air');
  await engine.setBlocks(clear, { updateShapes: false });

  // 2. place all scenes, top-down, with vanilla shape updates
  const b = new Batch();
  const all = list.flatMap((sc) => sc.blocks).sort((a, bb) => bb[1] - a[1]);
  for (const [x, y, z, s] of all) b.add(x, y, z, s);
  const res = await engine.setBlocks(b, { updateShapes: true });
  await engine.waitTicks(3);
  const vol = await engine.getBlocks(box);

  // 3. engine prediction
  const scene = new Map(all.map(([x, y, z, s]) => [`${x},${y},${z}`, s]));
  const get = (x, y, z) => scene.get(`${x},${y},${z}`) ?? (y === y0 - 1 ? GROUND : y < y0 - 1 ? 'minecraft:dirt' : 'minecraft:air');
  const changes = solveConnections(get, all.map(([x, y, z]) => [x, y, z]), reg);
  const eng = new Map(scene);
  for (const [x, y, z, s] of changes) eng.set(`${x},${y},${z}`, s);

  // 4. compare every scene position + the ground under each scene
  const groups = new Map();
  let compared = 0, mismatches = 0, unmodelled = 0, connectables = 0;
  const sceneOf = (x, z) => list[Math.floor((z - z0) / pitch) * cols + Math.floor((x - x0) / pitch)];
  const check = new Set([...scene.keys()]);
  for (const k of scene.keys()) { const [x, y, z] = k.split(',').map(Number); if (y === y0) check.add(`${x},${y0 - 1},${z}`); }
  for (const k of check) {
    const [x, y, z] = k.split(',').map(Number);
    const input = get(x, y, z);
    const e = eng.get(k) ?? input;
    const v = vol.get(x, y, z);
    compared++;
    const kind = kindOf(conn, input);
    if (kind !== 'other') connectables++;
    if (v === e) continue;
    const nbr = {};
    for (const d of H) nbr[d] = (eng.get(`${x + OFF[d][0]},${y},${z + OFF[d][1]}`) ?? get(x + OFF[d][0], y, z + OFF[d][1]));
    nbr.up = eng.get(`${x},${y + 1},${z}`) ?? get(x, y + 1, z);
    nbr.down = eng.get(`${x},${y - 1},${z}`) ?? get(x, y - 1, z);
    const vanillaNbr = {};
    for (const d of H) vanillaNbr[d] = vol.get(x + OFF[d][0], y, z + OFF[d][1]);
    vanillaNbr.up = vol.get(x, y + 1, z);
    vanillaNbr.down = vol.get(x, y - 1, z);
    const idChanged = idOf(v) !== idOf(e);
    const { sig } = idChanged ? { sig: `${idOf(input).slice(10)} | block changed to ${short(idOf(v))}` } : signature(conn, input, e, v, nbr);
    const cat = kind === 'other' ? 'unmodelled' : 'connect';
    if (cat === 'unmodelled') unmodelled++; else mismatches++;
    let g = groups.get(sig);
    if (!g) groups.set(sig, (g = { sig, cat, kind, count: 0, examples: [] }));
    g.count++;
    const sc = sceneOf(x, z);
    if (g.examples.length < 3) g.examples.push({ scene: sc?.i, family: sc?.fam, pos: [x, y, z], input: short(input), engine: short(e), vanilla: short(v),
      neighbours: Object.fromEntries(Object.entries(nbr).map(([d, s]) => [d, short(s)])), vanillaNeighbours: Object.fromEntries(Object.entries(vanillaNbr).map(([d, s]) => [d, short(s)])) });
  }
  const out = [...groups.values()].sort((a, b) => (a.cat === b.cat ? b.count - a.count : a.cat === 'connect' ? -1 : 1));
  log(`  connect: ${scenes} scenes (${all.length} blocks, ${res.shapeUpdates} vanilla shape updates), ${compared} positions compared (${connectables} connectable)`);
  log(`    ${mismatches} connect mismatches in ${out.filter((g) => g.cat === 'connect').length} groups, ${unmodelled} vanilla shape changes of unmodelled blocks in ${out.filter((g) => g.cat === 'unmodelled').length} groups`);
  for (const g of out.slice(0, 40)) log(`    [${g.cat}] ×${g.count} ${g.sig}`);
  return { scenes, blocks: all.length, compared, connectables, mismatches, unmodelled, invalidPoolStates: invalid, groups: out, sceneFamilies: Object.fromEntries(names.map((n) => [n, list.filter((s) => s.fam === n).length])) };
}
