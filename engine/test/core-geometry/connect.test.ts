import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveConnections, stairsShapeFor, connectorFor } from '../../src/core/connect.ts';
import { expandMultiblock, expandMultiblocks, isMultiblock } from '../../src/core/multiblock.ts';
import { blockId, parseBlockState } from '../../src/core/blockstate.ts';
import type { Vec3 } from '../../src/core/types.ts';
import { MapSink, key, reg } from './helpers.ts';
import { loadFactor } from '../load.ts';

const C = (s: string) => reg.canonical(s);

/** place blocks into a world, solve, apply; returns the world */
function world(blocks: [number, number, number, string][]): MapSink {
  const w = new MapSink();
  for (const [x, y, z, s] of blocks) w.set(x, y, z, C(s));
  const changes = solveConnections((x, y, z) => w.get(x, y, z), blocks.map((b) => [b[0], b[1], b[2]] as Vec3), reg);
  for (const [x, y, z, s] of changes) w.set(x, y, z, s);
  return w;
}
const props = (w: MapSink, x: number, y: number, z: number) => parseBlockState(w.get(x, y, z)).props;
const sides = (p: Record<string, string>) => ['north', 'east', 'south', 'west'].map((d) => p[d]).join(',');

test('fences: same family, sturdy faces, gates, exceptions', () => {
  const w = world([[0, 0, 0, 'oak_fence'], [1, 0, 0, 'oak_fence'], [2, 0, 0, 'spruce_fence'], [3, 0, 0, 'nether_brick_fence']]);
  assert.equal(sides(props(w, 0, 0, 0)), 'false,true,false,false');
  assert.equal(sides(props(w, 1, 0, 0)), 'false,true,false,true');
  assert.equal(sides(props(w, 2, 0, 0)), 'false,false,false,true'); // wooden ≠ nether brick
  assert.equal(sides(props(w, 3, 0, 0)), 'false,false,false,false');
  const w2 = world([
    [0, 0, 0, 'oak_fence'],
    [0, 0, -1, 'stone'],
    [1, 0, 0, 'glass'],
    [-1, 0, 0, 'oak_leaves'],
    [0, 0, 1, 'poppy'],
  ]);
  assert.equal(sides(props(w2, 0, 0, 0)), 'true,true,false,false');
  const w3 = world([[0, 0, 0, 'oak_fence'], [1, 0, 0, 'oak_fence_gate[facing=north]'], [-1, 0, 0, 'birch_fence_gate[facing=east]']]);
  assert.equal(sides(props(w3, 0, 0, 0)), 'false,true,false,false');
  for (const ex of ['pumpkin', 'melon', 'carved_pumpkin', 'jack_o_lantern', 'barrier', 'shulker_box', 'red_shulker_box', 'spruce_leaves'])
    assert.equal(sides(props(world([[0, 0, 0, 'oak_fence'], [1, 0, 0, ex]]), 0, 0, 0)), 'false,false,false,false', ex);
  // nether brick fences connect among themselves
  const w4 = world([[0, 0, 0, 'nether_brick_fence'], [0, 0, 1, 'nether_brick_fence']]);
  assert.equal(props(w4, 0, 0, 0).south, 'true');
});

test('fences connect to the full back of stairs and to double/never half slabs', () => {
  const t = (s: string) => props(world([[0, 0, 0, 'oak_fence'], [1, 0, 0, s]]), 0, 0, 0).east;
  assert.equal(t('oak_stairs[facing=west]'), 'true'); // back faces the fence
  assert.equal(t('oak_stairs[facing=east]'), 'false');
  assert.equal(t('oak_stairs[facing=north]'), 'false');
  assert.equal(t('oak_slab[type=double]'), 'true');
  assert.equal(t('oak_slab[type=bottom]'), 'false');
  assert.equal(t('oak_door'), 'false');
  assert.equal(t('chest'), 'false');
});

test('panes and bars: connect to panes, bars, walls, full blocks; not to fences', () => {
  const w = world([
    [0, 0, 0, 'glass_pane'],
    [1, 0, 0, 'iron_bars'],
    [-1, 0, 0, 'cobblestone_wall'],
    [0, 0, -1, 'glass'],
    [0, 0, 1, 'oak_fence'],
  ]);
  assert.equal(sides(props(w, 0, 0, 0)), 'true,true,false,true');
  assert.equal(props(w, 1, 0, 0).west, 'true');
  assert.equal(props(w, -1, 0, 0).east, 'low'); // wall → pane
  assert.equal(sides(props(world([[0, 0, 0, 'red_stained_glass_pane']]), 0, 0, 0)), 'false,false,false,false');
  assert.equal(props(world([[0, 0, 0, 'copper_bars'], [0, 0, 1, 'white_stained_glass_pane']]), 0, 0, 0).south, 'true');
});

test('walls: low/tall sides and post rules (vanilla WallBlock)', () => {
  // straight line, nothing above → middle has no post
  let w = world([[0, 0, 0, 'cobblestone_wall'], [1, 0, 0, 'cobblestone_wall'], [2, 0, 0, 'cobblestone_wall']]);
  assert.equal(sides(props(w, 1, 0, 0)), 'none,low,none,low');
  assert.equal(props(w, 1, 0, 0).up, 'false');
  assert.equal(props(w, 0, 0, 0).up, 'true'); // end piece
  // corner → post
  w = world([[0, 0, 0, 'cobblestone_wall'], [1, 0, 0, 'cobblestone_wall'], [0, 0, 1, 'cobblestone_wall']]);
  assert.equal(props(w, 0, 0, 0).up, 'true');
  // full block above → tall sides, straight tall → no post
  w = world([[0, 0, 0, 'stone_brick_wall'], [1, 0, 0, 'stone_brick_wall'], [2, 0, 0, 'stone_brick_wall'], [1, 1, 0, 'stone']]);
  assert.equal(sides(props(w, 1, 0, 0)), 'none,tall,none,tall');
  assert.equal(props(w, 1, 0, 0).up, 'false');
  // torch above (wall_post_override) or lantern (covers post) → post on a straight low wall
  for (const top of ['torch', 'lantern', 'oak_fence']) {
    w = world([[0, 0, 0, 'brick_wall'], [1, 0, 0, 'brick_wall'], [2, 0, 0, 'brick_wall'], [1, 1, 0, top]]);
    assert.equal(props(w, 1, 0, 0).up, 'true', top);
    assert.equal(props(w, 1, 0, 0).east, 'low', top);
  }
  // stacked walls: lower wall tall on sides where the upper wall connects, post if the upper has a post
  w = world([
    [0, 0, 0, 'andesite_wall'], [1, 0, 0, 'andesite_wall'], [2, 0, 0, 'andesite_wall'],
    [0, 1, 0, 'andesite_wall'], [1, 1, 0, 'andesite_wall'], [2, 1, 0, 'andesite_wall'],
  ]);
  assert.equal(sides(props(w, 1, 0, 0)), 'none,tall,none,tall');
  assert.equal(props(w, 0, 0, 0).up, 'true'); // the upper end piece has a post
  assert.equal(props(w, 1, 0, 0).up, 'false');
  // all four connected (cross), nothing above → no post (vanilla)
  w = world([[0, 0, 0, 'mud_brick_wall'], [1, 0, 0, 'stone'], [-1, 0, 0, 'stone'], [0, 0, 1, 'stone'], [0, 0, -1, 'stone']]);
  assert.equal(sides(props(w, 0, 0, 0)), 'low,low,low,low');
  assert.equal(props(w, 0, 0, 0).up, 'false');
  // isolated wall → post, no sides
  assert.equal(props(world([[0, 0, 0, 'tuff_wall']]), 0, 0, 0).up, 'true');
});

test('fence gates: in_wall, and walls/fences connect to gates along their span', () => {
  const w = world([[0, 0, 0, 'oak_fence_gate[facing=south]'], [1, 0, 0, 'cobblestone_wall'], [-1, 0, 0, 'cobblestone_wall']]);
  assert.equal(props(w, 0, 0, 0).in_wall, 'true');
  assert.equal(props(w, 1, 0, 0).west, 'low');
  const w2 = world([[0, 0, 0, 'oak_fence_gate[facing=east]'], [1, 0, 0, 'cobblestone_wall']]);
  assert.equal(props(w2, 0, 0, 0).in_wall, 'false');
  assert.equal(props(w2, 1, 0, 0).west, 'none');
});

test('stairs shapes follow vanilla getStairsShape', () => {
  const sa = (m: Record<string, { facing: 'north' | 'east' | 'south' | 'west'; half: string }>) => (x: number, y: number, z: number) => m[key(x, y, z)] ?? null;
  // behind (in facing direction) is a perpendicular stair → outer; left = CCW of facing
  assert.equal(stairsShapeFor(0, 0, 0, 'north', 'bottom', sa({ [key(0, 0, -1)]: { facing: 'west', half: 'bottom' } })), 'outer_left');
  assert.equal(stairsShapeFor(0, 0, 0, 'north', 'bottom', sa({ [key(0, 0, -1)]: { facing: 'east', half: 'bottom' } })), 'outer_right');
  // front is perpendicular → inner
  assert.equal(stairsShapeFor(0, 0, 0, 'north', 'bottom', sa({ [key(0, 0, 1)]: { facing: 'west', half: 'bottom' } })), 'inner_left');
  assert.equal(stairsShapeFor(0, 0, 0, 'north', 'bottom', sa({ [key(0, 0, 1)]: { facing: 'east', half: 'bottom' } })), 'inner_right');
  // different half → straight; same-facing stair on the side blocks the shape (canTakeShape)
  assert.equal(stairsShapeFor(0, 0, 0, 'north', 'top', sa({ [key(0, 0, -1)]: { facing: 'west', half: 'bottom' } })), 'straight');
  assert.equal(
    stairsShapeFor(0, 0, 0, 'north', 'bottom', sa({ [key(0, 0, -1)]: { facing: 'west', half: 'bottom' }, [key(1, 0, 0)]: { facing: 'north', half: 'bottom' } })),
    'straight',
  );
  // through solveConnections: an L of stairs
  const w = world([[0, 0, 0, 'oak_stairs[facing=north]'], [0, 0, -1, 'oak_stairs[facing=west]'], [1, 0, 0, 'oak_stairs[facing=north]']]);
  assert.equal(props(w, 0, 0, 0).shape, 'straight'); // blocked by same-facing neighbour at +x
  const w2 = world([[0, 0, 0, 'stone_stairs[facing=north]'], [0, 0, -1, 'stone_stairs[facing=west]']]);
  assert.equal(props(w2, 0, 0, 0).shape, 'outer_left');
  assert.equal(props(w2, 0, 0, -1).shape, 'straight');
});

test('redstone wire (basic) and chorus plants', () => {
  assert.equal(sides(props(world([[0, 0, 0, 'redstone_wire']]), 0, 0, 0)), 'side,side,side,side'); // isolated → cross
  let w = world([[0, 0, 0, 'redstone_wire'], [1, 0, 0, 'redstone_wire'], [2, 0, 0, 'redstone_wire']]);
  assert.equal(sides(props(w, 1, 0, 0)), 'none,side,none,side');
  assert.equal(sides(props(w, 0, 0, 0)), 'none,side,none,side'); // one-sided line extends
  w = world([[0, 0, 0, 'redstone_wire'], [0, 0, -1, 'lever'], [0, 0, 1, 'stone']]);
  assert.equal(props(w, 0, 0, 0).north, 'side');
  // climbing: wire on top of the neighbouring block → up
  w = world([[0, 0, 0, 'redstone_wire'], [1, 0, 0, 'stone'], [1, 1, 0, 'redstone_wire']]);
  assert.equal(props(w, 0, 0, 0).east, 'up');
  w = world([[0, 0, 0, 'redstone_wire'], [1, 0, 0, 'repeater[facing=north]']]);
  assert.equal(props(w, 0, 0, 0).east, 'side'); // only connected along axis? (repeater faces north → not east)
  // ^ isolated/only-other-axis → cross rule turns east on; check repeater axis explicitly:
  w = world([[0, 0, 0, 'redstone_wire'], [0, 0, -1, 'repeater[facing=north]'], [5, 0, 5, 'stone']]);
  assert.equal(sides(props(w, 0, 0, 0)), 'side,none,side,none');
  w = world([[0, 0, 0, 'redstone_wire'], [1, 0, 0, 'repeater[facing=north]'], [0, 0, -1, 'redstone_wire']]);
  assert.equal(props(w, 0, 0, 0).east, 'none');
  const ch = world([[0, 0, 0, 'end_stone'], [0, 1, 0, 'chorus_plant'], [0, 2, 0, 'chorus_plant'], [1, 2, 0, 'chorus_flower']]);
  const p1 = props(ch, 0, 1, 0), p2 = props(ch, 0, 2, 0);
  assert.equal(p1.down + p1.up, 'truetrue');
  assert.equal(p2.east + p2.down + p2.up, 'truetruefalse');
});

test('solveConnections: neighbour updates, only property changes, only changed states returned', () => {
  const w = new MapSink();
  w.set(0, 0, 0, C('oak_fence'));
  w.set(2, 0, 0, C('oak_fence'));
  // place a fence between → both neighbours update
  w.set(1, 0, 0, C('oak_fence'));
  const ch = solveConnections((x, y, z) => w.get(x, y, z), [[1, 0, 0]], reg);
  const ks = ch.map((c) => key(c[0], c[1], c[2])).sort();
  assert.deepEqual(ks, ['0,0,0', '1,0,0', '2,0,0']);
  for (const c of ch) assert.equal(blockId(c[3]), 'minecraft:oak_fence');
  for (const c of ch) w.set(c[0], c[1], c[2], c[3]);
  assert.equal(solveConnections((x, y, z) => w.get(x, y, z), [[1, 0, 0]], reg).length, 0);
  // random soup: ids never change, results are canonical, solving twice is stable
  const ids = ['oak_fence', 'nether_brick_fence', 'glass_pane', 'iron_bars', 'cobblestone_wall', 'oak_stairs', 'stone_stairs[facing=east]', 'oak_fence_gate', 'stone', 'glass', 'air', 'redstone_wire', 'oak_leaves', 'oak_slab'];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const soup = new MapSink();
  const pos: Vec3[] = [];
  for (let x = 0; x < 12; x++) for (let y = 0; y < 4; y++) for (let z = 0; z < 12; z++) {
    soup.set(x, y, z, C(ids[Math.floor(rnd() * ids.length)]));
    pos.push([x, y, z]);
  }
  const first = solveConnections((x, y, z) => soup.get(x, y, z), pos, reg);
  for (const [x, y, z, s] of first) {
    assert.equal(blockId(s), blockId(soup.get(x, y, z)));
    assert.equal(reg.canonical(s), s);
    soup.set(x, y, z, s);
  }
  assert.ok(first.length > 50);
  assert.equal(solveConnections((x, y, z) => soup.get(x, y, z), pos, reg).length, 0, 'second pass must be a fixed point');
  // sturdy-face helper
  const cn = connectorFor(reg);
  assert.ok(cn.sturdyFace(C('oak_stairs[facing=north,shape=inner_left]'), 'west'));
  assert.ok(!cn.sturdyFace(C('oak_stairs[facing=north,shape=outer_left]'), 'north'));
  assert.ok(cn.sturdyFace(C('oak_slab[type=top]'), 'up') && !cn.sturdyFace(C('oak_slab[type=top]'), 'down'));
});

test('multiblock: doors, beds, double plants, tall seagrass, dripleaf, pitcher crop', () => {
  assert.deepEqual(expandMultiblock(0, 5, 0, C('oak_door[facing=east,hinge=right,open=true]'), reg), [
    [0, 5, 0, C('oak_door[facing=east,hinge=right,open=true]')],
    [0, 6, 0, C('oak_door[facing=east,hinge=right,open=true,half=upper]')],
  ]);
  assert.deepEqual(expandMultiblock(0, 6, 0, C('iron_door[half=upper,facing=west]'), reg)[1], [0, 5, 0, C('iron_door[half=lower,facing=west]')]);
  assert.deepEqual(expandMultiblock(3, 0, 3, C('red_bed[facing=east]'), reg)[1], [4, 0, 3, C('red_bed[facing=east,part=head]')]);
  assert.deepEqual(expandMultiblock(3, 0, 3, C('red_bed[facing=north,part=head]'), reg)[1], [3, 0, 4, C('red_bed[facing=north,part=foot]')]);
  for (const id of ['sunflower', 'lilac', 'rose_bush', 'peony', 'tall_grass', 'large_fern', 'pitcher_plant', 'tall_seagrass'])
    assert.deepEqual(expandMultiblock(0, 0, 0, C(id), reg)[1], [0, 1, 0, C(`${id}[half=upper]`)], id);
  assert.deepEqual(expandMultiblock(0, 0, 0, C('small_dripleaf[facing=south]'), reg)[1], [0, 1, 0, C('small_dripleaf[facing=south,half=upper]')]);
  assert.equal(expandMultiblock(0, 0, 0, C('pitcher_crop[age=1]'), reg).length, 1);
  assert.equal(expandMultiblock(0, 0, 0, C('pitcher_crop[age=4]'), reg).length, 2);
  assert.equal(expandMultiblock(0, 0, 0, C('stone'), reg).length, 1);
  assert.equal(expandMultiblock(0, 0, 0, C('big_dripleaf'), reg).length, 1);
  // every half/part block: the partner's partner is the original
  for (const id of reg.ids()) {
    const s = C(id);
    if (!isMultiblock(s, reg)) continue;
    const [, p] = expandMultiblock(10, 10, 10, s, reg);
    const [, back] = expandMultiblock(p[0], p[1], p[2], p[3], reg);
    assert.deepEqual(back, [10, 10, 10, s], id);
  }
});

test('expandMultiblocks never duplicates or overrides explicit placements', () => {
  const lower = C('oak_door[facing=north,hinge=left]');
  const upperRight = C('oak_door[facing=north,hinge=right,half=upper]');
  assert.deepEqual(expandMultiblocks([[0, 0, 0, lower], [0, 1, 0, upperRight]], reg), []);
  assert.deepEqual(expandMultiblocks([[0, 0, 0, lower]], reg), [[0, 1, 0, C('oak_door[facing=north,hinge=left,half=upper]')]]);
  const beds = expandMultiblocks([[0, 0, 0, C('red_bed[facing=south]')], [1, 0, 0, C('red_bed[facing=south]')]], reg);
  assert.equal(beds.length, 2);
});

test('solveConnections: sparse inputs far apart (packed-key fallback) give the same results', () => {
  const w = new MapSink();
  const far = 5_000_000;
  for (const [x, z] of [[0, 0], [far, far]]) {
    w.set(x, 0, z, C('oak_fence'));
    w.set(x + 1, 0, z, C('oak_fence'));
  }
  const ch = solveConnections((x, y, z) => w.get(x, y, z), [[0, 0, 0], [far, 0, far]], reg);
  assert.equal(ch.length, 4);
  assert.ok(ch.some(([x, , , s]) => x === far + 1 && s.includes('west=true')));
});

test('performance: 500k mixed blocks (20% connectable) solve in < 1.5 s', () => {
  const ids = ['stone_bricks', 'oak_planks', 'glass', 'stone', 'oak_log', 'air', 'oak_fence', 'cobblestone_wall', 'glass_pane', 'oak_stairs[facing=east]', 'spruce_stairs[facing=north]', 'iron_bars'].map(C);
  const W = 100, H = 50, D = 100;
  const grid: string[] = new Array(W * H * D);
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < grid.length; i++) grid[i] = rnd() < 0.8 ? ids[Math.floor(rnd() * 6)] : ids[6 + Math.floor(rnd() * 6)];
  const get = (x: number, y: number, z: number) => (x < 0 || y < 0 || z < 0 || x >= W || y >= H || z >= D ? AIR_ : grid[(y * D + z) * W + x]);
  const pos: Vec3[] = [];
  for (let y = 0; y < H; y++) for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) pos.push([x, y, z]);
  const t0 = performance.now();
  const ch = solveConnections(get, pos, reg);
  const ms = performance.now() - t0;
  assert.ok(ch.length > 10_000);
  assert.ok(ms < 1500 * loadFactor(), `${ms} ms`);
  for (const [x, y, z, s] of ch) grid[(y * D + z) * W + x] = s;
  assert.equal(solveConnections(get, pos, reg).length, 0);
});
const AIR_ = 'minecraft:air';
