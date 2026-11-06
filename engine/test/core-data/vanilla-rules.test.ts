// Rules fixed against the real 26.3 game (tools/vanilla-diff.mjs, docs/VANILLA-DIFF.md):
// registry physics, data-driven faces, wall coverage, snowy soil, farmland/path → dirt, bells,
// mushrooms, rails, vines, candles, chorus, wire dots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EditSession } from '../../src/core/session.ts';
import { AIR, parseBlockState } from '../../src/core/blockstate.ts';
import { checkSupportAt, soilConversions } from '../../src/core/support.ts';
import { solveConnections } from '../../src/core/connect.ts';
import { Registry } from '../../src/core/registry.ts';
import { buildPhysicsTable, PhysicsIndex, PF, type PhysClass } from '../../src/core/physics.ts';
import type { BlockRegistry, Vec3 } from '../../src/core/types.ts';
import { MemBackend, reg } from './helpers.ts';

const R = reg();
const C = (s: string) => R.canonical(s);
const STONE = 'minecraft:stone';

/** scene getter: listed cells, everything else air */
function scene(cells: Array<[number, number, number, string]>) {
  const m = new Map(cells.map(([x, y, z, s]) => [`${x},${y},${z}`, C(s)]));
  return (x: number, y: number, z: number) => m.get(`${x},${y},${z}`) ?? AIR;
}
const survives = (state: string, cells: Array<[number, number, number, string]>, r: Registry = R) =>
  checkSupportAt(0, 0, 0, C(state), scene([[0, 0, 0, state], ...cells]), r) === null;

function solve(cells: Array<[number, number, number, string]>, r: Registry = R) {
  const m = new Map(cells.map(([x, y, z, s]) => [`${x},${y},${z}`, r.canonical(s)]));
  const get = (x: number, y: number, z: number) => m.get(`${x},${y},${z}`) ?? AIR;
  for (const [x, y, z, s] of solveConnections(get, cells.map((c) => [c[0], c[1], c[2]] as Vec3), r)) m.set(`${x},${y},${z}`, s);
  return (x: number, y: number, z: number) => parseBlockState(get(x, y, z)).props;
}

test('physics table: build/lookup round trip, irrelevant properties dropped', () => {
  const cls = (n: number): PhysClass => [n, n, n, n, n, 0];
  const t = buildPhysicsTable([
    { id: 'x:a', props: [], states: [{ props: {}, cls: cls(63) }] },
    {
      id: 'x:b',
      props: [['half', ['top', 'bottom']], ['wet', ['true', 'false']]],
      states: [
        { props: { half: 'top', wet: 'true' }, cls: cls(2) },
        { props: { half: 'top', wet: 'false' }, cls: cls(2) },
        { props: { half: 'bottom', wet: 'true' }, cls: cls(1) },
        { props: { half: 'bottom', wet: 'false' }, cls: cls(1) },
      ],
    },
  ]);
  assert.equal(typeof t.blocks['x:a'], 'number');
  const b = t.blocks['x:b'] as { p: [string, string[]][]; c: number[] };
  assert.deepEqual(b.p.map((p) => p[0]), ['half'], 'wet does not change the facts');
  const idx = new PhysicsIndex(t);
  assert.deepEqual(idx.get('x:b', { half: 'bottom', wet: 'true' }), cls(1));
  assert.deepEqual(idx.get('x:b', { half: 'top', wet: 'false' }), cls(2));
  assert.equal(idx.get('x:b', { half: 'middle' }), null);
  assert.equal(idx.get('x:nope', {}), null);
});

test('registry physics: bundled table, hello physics wins, older mods fall back to bundled data', () => {
  assert.ok(R.hasPhysics());
  // leaves: full-cube collision, no sturdy faces
  const leaf = R.physics(C('oak_leaves[persistent=true]'))!;
  assert.equal(leaf[0], 0);
  assert.equal(leaf[3], 63);
  assert.equal(R.isFullSolid(C('oak_leaves')), true, 'still a full cube for masks/terrain');
  assert.equal(R.isFullSolid(C('mud')), true);
  assert.equal(R.isFullSolid(C('soul_sand')), true);
  assert.equal(R.isFullSolid(C('powder_snow')), false);
  assert.equal(R.isTransparent(C('shulker_box')), true, 'shulker boxes are not solid-render');
  assert.equal(R.isTransparent(C('mud')), false);
  // an older mod: registry without physics, with the misleading solid=false hint for mud
  const data = JSON.parse(readFileSync(new URL('../../data/registry-26.3.json', import.meta.url), 'utf8')) as BlockRegistry;
  data.blocks['minecraft:mud'] = { ...data.blocks['minecraft:mud']!, solid: false };
  const old = new Registry(data);
  assert.equal(old.isFullSolid('minecraft:mud'), true, 'bundled physics beats the solid hint');
  // a newer mod: its own table is used (here: a fake that says stone has no sturdy faces)
  const fake = { ...data, physics: { format: 1, classes: [[0, 0, 0, 0, 0, 0] as PhysClass], blocks: { 'minecraft:stone': 0 } } };
  const live = new Registry(fake);
  assert.equal(live.isFullSolid(STONE), false);
  assert.equal(live.physics('minecraft:glass'), null, 'blocks missing from the hello table have no data (heuristics)');
  assert.equal(live.isFullSolid('minecraft:glass'), true, 'heuristic fallback');
});

test('leaves, dirt paths, farmland and honey have no sturdy top: torches, lanterns, doors, rails pop', () => {
  for (const ground of ['oak_leaves[persistent=true]', 'dirt_path', 'farmland', 'honey_block']) {
    assert.equal(survives('torch', [[0, -1, 0, ground]]), false, `torch on ${ground}`);
    assert.equal(survives('rail', [[0, -1, 0, ground]]), false, `rail on ${ground}`);
  }
  assert.equal(survives('lantern[hanging=true]', [[0, 1, 0, 'oak_leaves[persistent=true]']]), false, 'tree lanterns pop');
  assert.equal(survives('wall_torch[facing=north]', [[0, 0, 1, 'oak_leaves[persistent=true]']]), false);
  assert.equal(survives('ladder[facing=north]', [[0, 0, 1, 'oak_leaves[persistent=true]']]), false);
  assert.equal(survives('torch', [[0, -1, 0, 'mud']]), true);
  // multiface / snow / carpets do stay on leaves (collision face is full)
  assert.equal(survives('vine[north=true]', [[0, 0, -1, 'oak_leaves[persistent=true]']]), true);
  assert.equal(survives('snow[layers=1]', [[0, -1, 0, 'oak_leaves[persistent=true]']]), true);
  assert.equal(survives('white_carpet', [[0, -1, 0, 'oak_leaves[persistent=true]']]), true);
  assert.equal(survives('snow[layers=1]', [[0, -1, 0, 'dirt_path']]), false);
});

test('walls: tall/low and the post come from the bottom collision face of the block above', () => {
  const line = (above: string) =>
    solve([[0, 0, 0, 'cobblestone_wall'], [1, 0, 0, 'cobblestone_wall'], [2, 0, 0, 'cobblestone_wall'], [1, 1, 0, above]])(1, 0, 0);
  const carpet = line('white_carpet');
  assert.equal(carpet.east + carpet.west + carpet.up, 'talltallfalse');
  const pot = line('flower_pot');
  assert.equal(pot.east + pot.west + pot.up, 'lowlowtrue', 'a flower pot covers the centre column');
  const air = line('air');
  assert.equal(air.east + air.west + air.up, 'lowlowfalse');
  const stone = line('stone');
  assert.equal(stone.east + stone.up, 'tallfalse');
});

test('fences, panes and walls connect to every sturdy face (doors, composters, trapdoors, mud)', () => {
  const door = solve([[0, 0, 0, 'oak_fence'], [1, 0, 0, 'oak_door[facing=east,half=lower]'], [1, 1, 0, 'oak_door[facing=east,half=upper]']]);
  assert.equal(door(0, 0, 0).east, 'true', 'closed east-facing door: panel on its west side');
  assert.equal(solve([[0, 0, 0, 'glass_pane'], [1, 0, 0, 'composter']])(0, 0, 0).east, 'true');
  assert.equal(solve([[0, 0, 0, 'oak_fence'], [1, 0, 0, 'mud']])(0, 0, 0).east, 'true');
  assert.equal(solve([[0, 0, 0, 'oak_fence'], [1, 0, 0, 'oak_leaves[persistent=true]']])(0, 0, 0).east, 'false', 'connection exception');
});

test('snowy grass/podzol/mycelium follow the block above', () => {
  const p = solve([[0, 0, 0, 'grass_block'], [0, 1, 0, 'snow'], [1, 0, 0, 'podzol[snowy=true]'], [2, 0, 0, 'mycelium'], [2, 1, 0, 'snow_block']]);
  assert.equal(p(0, 0, 0).snowy, 'true');
  assert.equal(p(1, 0, 0).snowy, 'false');
  assert.equal(p(2, 0, 0).snowy, 'true');
});

test('redstone: isolated dots stay dots, wire survives on hoppers, conductors from vanilla', () => {
  assert.equal(solve([[0, 0, 0, 'redstone_wire']])(0, 0, 0).north, 'none');
  assert.equal(survives('redstone_wire', [[0, -1, 0, 'hopper']]), true);
  assert.equal(survives('redstone_wire', [[0, -1, 0, 'oak_leaves[persistent=true]']]), false);
  // glowstone is not a conductor → the wire connects down past it (stone blocks the diagonal)
  const step = (block: string) => solve([[0, 0, 0, 'redstone_wire'], [0, -1, 0, 'stone'], [1, 0, 0, block], [1, -1, 0, 'redstone_wire'], [1, -2, 0, 'stone']])(0, 0, 0).east;
  assert.equal(step('glowstone'), 'side');
  assert.equal(step('stone'), 'none');
});

test('farmland and dirt paths under solid blocks turn into dirt (session + simulation pipeline)', async () => {
  const be = new MemBackend([[0, 0, 0, C('dirt_path')], [2, 0, 0, C('farmland')], [4, 0, 0, C('farmland')], [6, 0, 0, C('dirt_path')]]);
  const s = new EditSession(be, R, {});
  s.set(0, 1, 0, 'oak_door[half=lower]');
  s.set(0, 2, 0, 'oak_door[half=upper]');
  s.set(2, 1, 0, 'stone');
  s.set(4, 1, 0, 'wheat');
  s.set(6, 1, 0, 'oak_fence_gate');
  const r = await s.flush();
  assert.equal(be.at(0, 0, 0), 'minecraft:dirt');
  assert.match(be.at(0, 1, 0), /oak_door/, 'the door then stands on dirt (what the real game ends with)');
  assert.equal(be.at(2, 0, 0), 'minecraft:dirt');
  assert.match(be.at(4, 0, 0), /farmland/, 'crops keep farmland');
  assert.match(be.at(6, 0, 0), /dirt_path/, 'fence gates keep paths');
  assert.match(r.warnings.join('\n'), /turned 2 farmland\/dirt path under solid blocks into dirt/);
  const get = scene([[0, 0, 0, 'farmland'], [0, 1, 0, 'oak_planks']]);
  assert.deepEqual(soilConversions(get, [[0, 1, 0]], R), [[0, 0, 0, 'minecraft:dirt']]);
});

test('bells, candles, wall hanging signs, rails, vines, mushrooms, chorus, dripleaf', () => {
  // bells
  assert.equal(survives('bell[attachment=floor]', []), false);
  assert.equal(survives('bell[attachment=floor]', [[0, -1, 0, STONE]]), true);
  assert.equal(survives('bell[attachment=ceiling]', [[0, 1, 0, 'oak_fence']]), true);
  assert.equal(survives('bell[attachment=ceiling]', [[0, 1, 0, 'oak_fence_gate']]), false, '#unstable_bottom_center');
  assert.equal(survives('bell[attachment=single_wall,facing=north]', [[0, 0, -1, STONE]]), true);
  assert.equal(survives('bell[attachment=single_wall,facing=north]', [[0, 0, 1, STONE]]), false);
  assert.equal(survives('bell[attachment=double_wall,facing=north]', []), true);
  // vanilla never pops these
  assert.equal(survives('candle', []), true);
  assert.equal(survives('oak_wall_hanging_sign[facing=north]', []), true);
  // ascending rails need the high side
  assert.equal(survives('rail[shape=ascending_north]', [[0, -1, 0, STONE]]), false);
  assert.equal(survives('rail[shape=ascending_north]', [[0, -1, 0, STONE], [0, 0, -1, STONE]]), true);
  // ceiling vines check the TOP face of the block above
  assert.equal(survives('vine[up=true]', [[0, 1, 0, 'oak_slab[type=top]']]), true);
  assert.equal(survives('vine[up=true]', [[0, 1, 0, 'oak_slab[type=bottom]']]), false);
  // mushrooms: sky-exposed only on mycelium/podzol/nylium; under a roof on opaque blocks
  assert.equal(survives('red_mushroom', [[0, -1, 0, STONE]]), false);
  assert.equal(survives('red_mushroom', [[0, -1, 0, 'mycelium']]), true);
  const roof: Array<[number, number, number, string]> = [[0, -1, 0, STONE]];
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) for (let y = 1; y <= 9; y++) roof.push([x, y, z, STONE]);
  assert.equal(survives('red_mushroom', roof), true, 'in a cave');
  assert.equal(survives('red_mushroom', [...roof.slice(1), [0, -1, 0, 'glass']]), false, 'glass is not solid-render');
  // chorus
  assert.equal(survives('chorus_flower', [[0, -1, 0, 'end_stone']]), true);
  assert.equal(survives('chorus_flower', [[0, -1, 0, STONE]]), false);
  assert.equal(survives('chorus_plant', [[0, -1, 0, 'dirt']]), false);
  // big dripleaf
  assert.equal(survives('big_dripleaf', [[0, -1, 0, 'clay']]), true);
  assert.equal(survives('big_dripleaf', [[0, -1, 0, STONE]]), false);
  // spore blossoms hang from fences (sturdy centre), hanging propagules only from mangrove leaves
  assert.equal(survives('spore_blossom', [[0, 1, 0, 'oak_fence']]), true);
  assert.equal(survives('mangrove_propagule[hanging=true]', [[0, 1, 0, STONE]]), false);
  assert.equal(survives('mangrove_propagule[hanging=true]', [[0, 1, 0, 'mangrove_leaves']]), true);
  // gravity: replaceable blocks do not hold sand
  const v = checkSupportAt(0, 0, 0, C('sand'), scene([[0, -1, 0, 'snow[layers=1]']]), R);
  assert.equal(v?.kind.key, 'gravity');
});

test('physics flags used by the rules are present', () => {
  const f = (s: string) => R.physics(C(s))![5];
  assert.ok(f('stone') & PF.CONDUCTOR);
  assert.equal(f('glowstone') & PF.CONDUCTOR, 0);
  assert.ok(f('lever') & PF.SIGNAL_SOURCE);
  assert.ok(f('oak_sign') & PF.LEGACY_SOLID);
  assert.equal(f('white_carpet') & PF.LEGACY_SOLID, 0);
  assert.ok(f('flower_pot') & PF.WALL_POST);
});

test('bundled physics covers every state of the bundled registry', () => {
  let states = 0;
  const missing: string[] = [];
  for (const id of R.ids()) {
    const info = R.info(id)!;
    const names = Object.keys(info.properties).sort();
    let combos: string[][] = [[]];
    for (const k of names) combos = combos.flatMap((a) => info.properties[k]!.map((v) => [...a, `${k}=${v}`]));
    for (const c of combos) {
      states++;
      const st = c.length ? `${id}[${c.join(',')}]` : id;
      if (!R.physics(st) && missing.length < 5) missing.push(st);
    }
  }
  assert.ok(states > 30_000, `${states} states`);
  assert.deepEqual(missing, []);
});
