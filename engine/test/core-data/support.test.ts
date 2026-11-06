import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditSession, History } from '../../src/core/session.ts';
import { AIR } from '../../src/core/blockstate.ts';
import { checkSupportAt, faceSupport, removedState, resolveSupport, FULL, CENTER, RIGID, NONE } from '../../src/core/support.ts';
import { MemBackend, reg } from './helpers.ts';

const STONE = 'minecraft:stone';

async function place(init: Array<[number, number, number, string]>, sets: Array<[number, number, number, string]>, opts: { support?: 'drop' | 'warn' | 'off'; bounds?: any } = {}) {
  const be = new MemBackend(init);
  const s = new EditSession(be, reg(), { support: opts.support, bounds: opts.bounds });
  for (const [x, y, z, st] of sets) s.set(x, y, z, st);
  const r = await s.flush();
  return { be, r, s };
}

test('face support classification', () => {
  const R = reg();
  const C = (s: string) => R.canonical(s);
  assert.equal(faceSupport(C('stone'), 'up', R), FULL);
  assert.equal(faceSupport(C('oak_slab[type=bottom]'), 'up', R), NONE);
  assert.equal(faceSupport(C('oak_slab[type=top]'), 'up', R), FULL);
  assert.equal(faceSupport(C('oak_slab[type=bottom]'), 'down', R), FULL);
  assert.equal(faceSupport(C('oak_fence'), 'up', R), CENTER);
  assert.equal(faceSupport(C('oak_fence'), 'north', R), NONE);
  assert.equal(faceSupport(C('iron_chain[axis=y]'), 'down', R), CENTER);
  assert.equal(faceSupport(C('oak_stairs[facing=north,half=bottom,shape=straight]'), 'north', R), FULL);
  assert.equal(faceSupport(C('oak_stairs[facing=north,half=bottom,shape=straight]'), 'south', R), NONE);
  // vanilla LeavesBlock: empty block-support shape → no sturdy face (torches, ladders, doors pop on leaves)
  assert.equal(faceSupport(C('oak_leaves[persistent=true]'), 'south', R), NONE);
  assert.equal(faceSupport(C('oak_leaves[persistent=true]'), 'up', R), NONE);
  assert.equal(faceSupport(C('dirt_path'), 'up', R), NONE); // 15/16 tall: no sturdy top
  assert.equal(faceSupport(C('dirt_path'), 'down', R), FULL);
  assert.equal(faceSupport(C('mud'), 'up', R), FULL);
  assert.equal(faceSupport(C('composter'), 'up', R), RIGID);
  assert.equal(faceSupport(C('honey_block'), 'up', R), NONE);
  assert.equal(faceSupport(C('honey_block'), 'down', R), CENTER);
  assert.equal(faceSupport(C('glass'), 'east', R), FULL);
  assert.equal(faceSupport(C('oak_trapdoor[open=true,facing=north]'), 'south', R), FULL);
});

test('vines: need a solid face or a vine above; chains cascade; multi-face vines are trimmed', async () => {
  const v = (props: string) => `vine[${props}]`;
  const { be, r } = await place(
    [[0, 5, -1, STONE], [10, 5, -1, STONE]],
    [
      [0, 5, 0, v('north=true')], // on the wall
      [0, 4, 0, v('north=true')], // hangs from the vine above
      [0, 3, 0, v('north=true')],
      [5, 5, 0, v('north=true')], // floating chain
      [5, 4, 0, v('north=true')],
      [5, 3, 0, v('north=true')],
      [10, 5, 0, v('north=true,east=true')], // east face has nothing behind it → trimmed
    ],
  );
  assert.match(be.at(0, 3, 0), /^minecraft:vine/);
  assert.equal(be.at(5, 5, 0), AIR);
  assert.equal(be.at(5, 3, 0), AIR, 'whole floating chain dropped');
  assert.match(be.at(10, 5, 0), /east=false.*north=true/);
  const w = r.warnings.join('\n');
  assert.match(w, /dropped 3 floating vines — vines need a solid face/);
  assert.match(w, /trimmed 1 floating vines/);
  assert.equal(r.support!.changes.length, 4);
});

test('wall-mounted blocks need support behind them (opposite to facing)', async () => {
  const { be } = await place(
    [[0, 1, 1, STONE], [3, 1, 1, STONE]],
    [
      [0, 1, 0, 'ladder[facing=north]'], // wall is south (z+1) → ok
      [1, 1, 0, 'ladder[facing=north]'], // nothing behind → dropped
      [3, 1, 0, 'wall_torch[facing=north]'],
      [4, 1, 0, 'wall_torch[facing=north]'],
      [3, 2, 0, 'stone_button[face=wall,facing=north]'],
      [6, 1, 0, 'oak_wall_sign[facing=north]'],
    ],
  );
  assert.match(be.at(0, 1, 0), /ladder/);
  assert.equal(be.at(1, 1, 0), AIR);
  assert.match(be.at(3, 1, 0), /wall_torch/);
  assert.equal(be.at(4, 1, 0), AIR);
  assert.equal(be.at(3, 2, 0), AIR, 'button: stone only at y=1');
  assert.equal(be.at(6, 1, 0), AIR);
});

test('lanterns, torches, candles: hanging needs a block above, standing a post or full block below', async () => {
  const { be } = await place(
    [[0, 5, 0, 'minecraft:oak_fence[east=false,north=false,south=false,waterlogged=false,west=false]'], [2, 0, 0, 'minecraft:oak_slab[type=bottom,waterlogged=false]'], [4, 0, 0, 'minecraft:oak_slab[type=top,waterlogged=false]'], [6, 0, 0, 'minecraft:cobblestone_wall']],
    [
      [0, 4, 0, 'lantern[hanging=true]'],
      [1, 4, 0, 'lantern[hanging=true]'],
      [2, 1, 0, 'lantern'],
      [4, 1, 0, 'lantern'],
      [6, 1, 0, 'torch'],
      [8, 1, 0, 'torch'],
      [4, 2, 0, 'candle[lit=true]'], // on the lantern: vanilla candles never pop (no survival check in updateShape)
      [8, 5, 0, 'sea_lantern'], // a full block, not a lantern
    ],
  );
  assert.match(be.at(0, 4, 0), /lantern/);
  assert.equal(be.at(1, 4, 0), AIR);
  assert.equal(be.at(2, 1, 0), AIR, 'not on a bottom slab');
  assert.match(be.at(4, 1, 0), /lantern/);
  assert.match(be.at(6, 1, 0), /torch/);
  assert.equal(be.at(8, 1, 0), AIR);
  assert.match(be.at(4, 2, 0), /candle/);
  assert.equal(be.at(8, 5, 0), 'minecraft:sea_lantern');
});

test('plants need the right ground; tall plants drop both halves; carpets/rails need a floor', async () => {
  const { be, r } = await place(
    [[0, 0, 0, 'minecraft:grass_block[snowy=false]'], [2, 0, 0, STONE], [4, 0, 0, STONE], [8, 0, 0, 'minecraft:oak_fence[east=false,north=false,south=false,waterlogged=false,west=false]']],
    [
      [0, 1, 0, 'poppy'],
      [2, 1, 0, 'poppy'],
      [4, 1, 0, 'tall_grass[half=lower]'],
      [6, 1, 0, 'white_carpet'],
      [8, 1, 0, 'rail'],
    ],
  );
  assert.match(be.at(0, 1, 0), /poppy/);
  assert.equal(be.at(2, 1, 0), AIR);
  assert.equal(be.at(4, 1, 0), AIR);
  assert.equal(be.at(4, 2, 0), AIR, 'upper half (added by multiblock expansion) dropped too');
  assert.equal(be.at(6, 1, 0), AIR);
  assert.equal(be.at(8, 1, 0), AIR);
  assert.match(r.warnings.join('\n'), /plants on wrong ground/);
});

test('cocoa needs a jungle log on its facing side; waterlogged drops leave water', async () => {
  const R = reg();
  const { be } = await place(
    [[0, 5, -1, 'minecraft:jungle_log[axis=y]']],
    [
      [0, 5, 0, 'cocoa[facing=north]'],
      [3, 5, 0, 'cocoa[facing=north]'],
      [6, 5, 0, 'glow_lichen[north=true,waterlogged=true]'],
    ],
  );
  assert.match(be.at(0, 5, 0), /cocoa/);
  assert.equal(be.at(3, 5, 0), AIR);
  assert.equal(be.at(6, 5, 0), R.canonical('water'));
  assert.equal(removedState(R.canonical('seagrass')), 'minecraft:water');
  assert.equal(removedState(R.canonical('oak_stairs[waterlogged=true]')), 'minecraft:water');
  assert.equal(removedState(R.canonical('poppy')), 'minecraft:air');
});

test('removing a wall drops the torch that hung on it; undo restores both', async () => {
  const be = new MemBackend([[0, 1, 1, STONE], [0, 1, 0, 'minecraft:wall_torch[facing=north]']]);
  const s = new EditSession(be, reg());
  s.set(0, 1, 1, 'air');
  const r = await s.flush();
  assert.equal(be.at(0, 1, 0), AIR);
  assert.match(r.warnings.join('\n'), /wall-mounted.*support cell \[0,1,1\]: air/);
  const h = new History();
  h.push(r.record!);
  await h.undo('system', be);
  assert.equal(be.at(0, 1, 1), STONE);
  assert.equal(be.at(0, 1, 0), 'minecraft:wall_torch[facing=north]');
});

test("support:'warn' keeps blocks, 'off' skips; gravity blocks only warn; outside bounds only warn", async () => {
  const w = await place([], [[0, 5, 0, 'torch']], { support: 'warn' });
  assert.match(w.be.at(0, 5, 0), /torch/);
  assert.match(w.r.warnings.join('\n'), /found 1 unsupported torches/);
  const o = await place([], [[0, 5, 0, 'torch']], { support: 'off' });
  assert.match(o.be.at(0, 5, 0), /torch/);
  assert.equal(o.r.support, null);
  const g = await place([], [[0, 5, 0, 'sand']]);
  assert.equal(g.be.at(0, 5, 0), 'minecraft:sand');
  assert.match(g.r.warnings.join('\n'), /falling blocks over air/);
  // the torch at x=11 sits outside the bounds: its support is removed but it may not be touched
  const be = new MemBackend([[11, 1, 1, STONE], [11, 1, 0, 'minecraft:wall_torch[facing=north]'], [10, 1, 1, STONE]]);
  const s = new EditSession(be, reg(), { bounds: { min: [0, 0, 0], max: [10, 10, 10] } });
  s.set(10, 1, 1, 'air');
  await s.flush();
  assert.match(be.at(11, 1, 0), /wall_torch/);
});

test('resolveSupport: unknown neighbours count as support', () => {
  const R = reg();
  const rep = resolveSupport([[0, 0, 0]], (x, y, z) => (x === 0 && y === 0 && z === 0 ? R.canonical('torch') : undefined), R, { mode: 'drop' });
  assert.equal(rep.changes.length, 0);
  assert.equal(checkSupportAt(0, 0, 0, R.canonical('torch'), (x, y, z) => (y < 0 ? AIR : undefined), R)?.kind.key, 'floor');
});

test('vanilla SupportType semantics (verified against decompiled 26.3): hopper rim, fence gates, slabs/stairs bottom faces', () => {
  const R = reg();
  const on = (below: string, above: string) => checkSupportAt(0, 1, 0, R.canonical(above), (x, y) => (y === 0 ? R.canonical(below) : y === 2 ? 'minecraft:air' : 'minecraft:air'), R);
  const under = (above: string, st: string) => checkSupportAt(0, 0, 0, R.canonical(st), (x, y) => (y === 1 ? R.canonical(above) : 'minecraft:air'), R);
  assert.notEqual(on('hopper', 'torch'), null, 'no torch on a hopper (rim only)');
  assert.equal(on('hopper', 'rail'), null, 'rails sit on the rigid rim');
  assert.equal(on('hopper', 'stone_pressure_plate'), null);
  assert.equal(on('oak_fence_gate', 'lantern'), null);
  assert.notEqual(under('oak_fence_gate', 'lantern[hanging=true]'), null, '#unstable_bottom_center');
  assert.notEqual(under('oak_slab[type=top]', 'lantern[hanging=true]'), null, 'a top slab has no bottom face');
  assert.notEqual(under('oak_stairs[half=top,facing=north]', 'lantern[hanging=true]'), null, 'upside-down stairs do not cover the center');
  assert.equal(under('oak_stairs[half=bottom,facing=north]', 'lantern[hanging=true]'), null);
  assert.equal(under('iron_chain[axis=y]', 'lantern[hanging=true]'), null);
  assert.notEqual(on('oak_slab[type=bottom]', 'torch'), null);
  assert.equal(on('oak_slab[type=top]', 'torch'), null);
});
