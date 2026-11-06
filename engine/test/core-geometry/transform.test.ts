import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mirrorPos, mirrorState, rotatePos, rotateState, rotateDir, mirrorDir, type QuarterTurns } from '../../src/core/transform.ts';
import type { Vec3 } from '../../src/core/types.ts';
import { combos, reg, stateOf } from './helpers.ts';
import { loadFactor } from '../load.ts';

const ROT_PROPS = new Set([
  'facing', 'horizontal_facing', 'axis', 'rotation', 'north', 'east', 'south', 'west', 'up', 'down',
  'shape', 'hinge', 'type', 'orientation', 'side_chain', 'half', 'part', 'attachment', 'face',
]);

/** every block × every combination of its rotation-relevant properties (others default) */
function allStates(): string[] {
  const out: string[] = [];
  for (const id of reg.ids()) {
    const info = reg.info(id)!;
    const vary: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(info.properties)) if (ROT_PROPS.has(k)) vary[k] = v;
    for (const c of combos(vary)) out.push(reg.canonical(stateOf(id, { ...info.default, ...c })));
  }
  return out;
}
const STATES = allStates();

const rot = (s: string, t: number) => rotateState(s, (t % 4) as QuarterTurns, reg);

test(`state universe is large (${STATES.length} states)`, () => {
  assert.ok(STATES.length > 10_000);
});

test('rotate: 4 quarter turns = identity, composition, outputs are canonical & valid', () => {
  for (const s of STATES) {
    let r = s;
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      r = rot(r, 1);
      seen.push(r);
      assert.equal(reg.canonical(r), r, `non-canonical rotation of ${s}: ${r}`);
    }
    assert.equal(r, s, `rot^4 ≠ id for ${s}`);
    assert.equal(rot(s, 2), seen[1], `rot2 ≠ rot1∘rot1 for ${s}`);
    assert.equal(rot(s, 3), seen[2], `rot3 ≠ rot1^3 for ${s}`);
    assert.equal(rot(s, 0), s);
  }
});

test('mirror: involution, canonical, and consistent with rotation', () => {
  for (const s of STATES) {
    const mx = mirrorState(s, 'x', reg);
    const mz = mirrorState(s, 'z', reg);
    assert.equal(reg.canonical(mx), mx);
    assert.equal(reg.canonical(mz), mz);
    assert.equal(mirrorState(mx, 'x', reg), s, `mirror x twice ≠ id for ${s}`);
    assert.equal(mirrorState(mz, 'z', reg), s, `mirror z twice ≠ id for ${s}`);
    // mirror_x ∘ rot1 == rot3 ∘ mirror_x  (same for z)
    assert.equal(mirrorState(rot(s, 1), 'x', reg), rot(mx, 3), `mirror_x∘rot1 ≠ rot3∘mirror_x for ${s}`);
    assert.equal(mirrorState(rot(s, 1), 'z', reg), rot(mz, 3), `mirror_z∘rot1 ≠ rot3∘mirror_z for ${s}`);
    // mirror_x == rot2 ∘ mirror_z
    assert.equal(mx, rot(mz, 2), `mirror_x ≠ rot2∘mirror_z for ${s}`);
  }
});

test('position transforms match state transforms (direction vectors)', () => {
  const vec: Record<string, Vec3> = { north: [0, 0, -1], east: [1, 0, 0], south: [0, 0, 1], west: [-1, 0, 0] };
  const back = (v: Vec3) => Object.entries(vec).find(([, w]) => w[0] === v[0] && w[2] === v[2])![0];
  for (const d of Object.keys(vec)) {
    for (const t of [0, 1, 2, 3] as QuarterTurns[]) {
      assert.equal(back(rotatePos(vec[d], t)), rotateDir(d, t));
      const st = rot(`oak_stairs[facing=${d}]`, t);
      assert.match(st, new RegExp(`facing=${rotateDir(d, t)}`));
    }
    for (const a of ['x', 'z'] as const) {
      assert.equal(back(mirrorPos(vec[d], a)), mirrorDir(d, a));
      assert.match(mirrorState(`oak_stairs[facing=${d}]`, a, reg), new RegExp(`facing=${mirrorDir(d, a)}`));
    }
  }
  assert.deepEqual(rotatePos([1, 5, 0], 1), [0, 5, 1]); // east → south (clockwise from above)
  assert.deepEqual(rotatePos([3, 0, 2], 1, [1, 0, 1]), [0, 0, 3]);
  assert.deepEqual(rotatePos([0, 0, 0], 2), [0, 0, 0]);
  assert.ok(!Object.is(rotatePos([0, 0, 0], 2)[0], -0));
  assert.deepEqual(mirrorPos([3, 1, 2], 'x', [1, 0, 0]), [-1, 1, 2]);
  assert.deepEqual(mirrorPos([3, 1, 2], 'z', [0, 0, 5]), [3, 1, 8]);
});

const C = (s: string) => reg.canonical(s);

test('hand-checked against vanilla: stairs', () => {
  assert.equal(rot('oak_stairs[facing=north,shape=outer_left]', 1), C('oak_stairs[facing=east,shape=outer_left]'));
  // vanilla StairBlock.mirror(LEFT_RIGHT = flip z) for a Z-facing stair: rotate 180 + swap left/right
  assert.equal(mirrorState('oak_stairs[facing=north,shape=inner_left]', 'z', reg), C('oak_stairs[facing=south,shape=inner_right]'));
  assert.equal(mirrorState('oak_stairs[facing=east,shape=outer_left,half=top]', 'x', reg), C('oak_stairs[facing=west,shape=outer_right,half=top]'));
  // deliberate deviation (geometrically correct): a stair facing across the mirror plane swaps handedness too
  assert.equal(mirrorState('oak_stairs[facing=east,shape=outer_left]', 'z', reg), C('oak_stairs[facing=east,shape=outer_right]'));
  assert.equal(mirrorState('oak_stairs[facing=east,shape=straight]', 'z', reg), C('oak_stairs[facing=east]'));
});

test('hand-checked against vanilla: doors, chests, beds, rails', () => {
  // DoorBlock.mirror: rotate by mirror.getRotation(facing) and always cycle hinge
  assert.equal(mirrorState('oak_door[facing=east,hinge=left]', 'z', reg), C('oak_door[facing=east,hinge=right]'));
  assert.equal(mirrorState('oak_door[facing=east,hinge=left,half=upper,open=true]', 'x', reg), C('oak_door[facing=west,hinge=right,half=upper,open=true]'));
  assert.equal(rot('oak_door[facing=east,hinge=left]', 1), C('oak_door[facing=south,hinge=left]'));
  // ChestBlock.mirror: type left <-> right
  assert.equal(mirrorState('chest[facing=north,type=left]', 'x', reg), C('chest[facing=north,type=right]'));
  assert.equal(mirrorState('trapped_chest[facing=north,type=single]', 'x', reg), C('trapped_chest[facing=north,type=single]'));
  assert.equal(rot('copper_chest[facing=north,type=left]', 1), C('copper_chest[facing=east,type=left]'));
  // slabs: type=top/bottom untouched
  assert.equal(mirrorState('oak_slab[type=top]', 'x', reg), C('oak_slab[type=top]'));
  // beds: part stays
  assert.equal(rot('red_bed[facing=north,part=head]', 3), C('red_bed[facing=west,part=head]'));
  // RailBlock.rotate CLOCKWISE_90
  const r1: [string, string][] = [
    ['north_south', 'east_west'], ['east_west', 'north_south'],
    ['ascending_east', 'ascending_south'], ['ascending_west', 'ascending_north'],
    ['ascending_north', 'ascending_east'], ['ascending_south', 'ascending_west'],
    ['south_east', 'south_west'], ['south_west', 'north_west'], ['north_west', 'north_east'], ['north_east', 'south_east'],
  ];
  for (const [a, b] of r1) assert.equal(rot(`rail[shape=${a}]`, 1), C(`rail[shape=${b}]`), a);
  // RailBlock.mirror FRONT_BACK (flip x)
  assert.equal(mirrorState('rail[shape=south_east]', 'x', reg), C('rail[shape=south_west]'));
  assert.equal(mirrorState('rail[shape=ascending_east]', 'x', reg), C('rail[shape=ascending_west]'));
  assert.equal(mirrorState('rail[shape=ascending_east]', 'z', reg), C('rail[shape=ascending_east]'));
  assert.equal(mirrorState('powered_rail[shape=ascending_north]', 'z', reg), C('powered_rail[shape=ascending_south]'));
  assert.equal(rot('powered_rail[shape=north_south]', 1), C('powered_rail[shape=east_west]'));
});

test('hand-checked: rotation 0-15, axis, nsew families, orientation, attachments', () => {
  assert.equal(rot('oak_sign[rotation=0]', 1), C('oak_sign[rotation=4]'));
  assert.equal(rot('oak_sign[rotation=14]', 1), C('oak_sign[rotation=2]'));
  assert.equal(mirrorState('white_banner[rotation=4]', 'x', reg), C('white_banner[rotation=12]')); // west <-> east
  assert.equal(mirrorState('white_banner[rotation=0]', 'x', reg), C('white_banner[rotation=0]'));
  assert.equal(mirrorState('skeleton_skull[rotation=0]', 'z', reg), C('skeleton_skull[rotation=8]')); // south <-> north
  assert.equal(mirrorState('skeleton_skull[rotation=3]', 'z', reg), C('skeleton_skull[rotation=5]'));
  assert.equal(rot('oak_log[axis=x]', 1), C('oak_log[axis=z]'));
  assert.equal(rot('oak_log[axis=y]', 1), C('oak_log[axis=y]'));
  assert.equal(rot('oak_log[axis=x]', 2), C('oak_log[axis=x]'));
  assert.equal(mirrorState('oak_log[axis=x]', 'x', reg), C('oak_log[axis=x]'));
  assert.equal(rot('nether_portal[axis=x]', 3), C('nether_portal[axis=z]'));
  assert.equal(rot('oak_fence[north=true,west=true]', 1), C('oak_fence[east=true,north=true]'));
  assert.equal(rot('cobblestone_wall[north=tall,east=low]', 1), C('cobblestone_wall[east=tall,south=low]'));
  assert.equal(rot('redstone_wire[north=up,east=side,power=7]', 2), C('redstone_wire[south=up,west=side,power=7]'));
  assert.equal(mirrorState('glass_pane[east=true]', 'x', reg), C('glass_pane[west=true]'));
  assert.equal(rot('glow_lichen[down=true,north=true]', 1), C('glow_lichen[down=true,east=true]'));
  assert.equal(rot('vine[up=true,west=true]', 2), C('vine[up=true,east=true]'));
  assert.equal(rot('jigsaw[orientation=north_up]', 1), C('jigsaw[orientation=east_up]'));
  assert.equal(rot('jigsaw[orientation=up_north]', 1), C('jigsaw[orientation=up_east]'));
  assert.equal(mirrorState('crafter[orientation=down_east]', 'x', reg), C('crafter[orientation=down_west]'));
  assert.equal(rot('bell[attachment=single_wall,facing=north]', 1), C('bell[attachment=single_wall,facing=east]'));
  assert.equal(rot('stone_button[face=ceiling,facing=west]', 1), C('stone_button[face=ceiling,facing=north]'));
  assert.equal(rot('hopper[facing=down]', 1), C('hopper[facing=down]'));
  assert.equal(rot('hopper[facing=west]', 1), C('hopper[facing=north]'));
  assert.equal(rot('piston[facing=up]', 3), C('piston[facing=up]'));
  assert.equal(mirrorState('oak_shelf[side_chain=left]', 'x', reg), C('oak_shelf[side_chain=right]'));
  assert.equal(rot('oak_shelf[side_chain=left,facing=north]', 1), C('oak_shelf[side_chain=left,facing=east]'));
  assert.equal(rot('pale_moss_carpet[north=tall]', 1), C('pale_moss_carpet[east=tall]'));
});

test('SNBT is preserved through rotate/mirror', () => {
  const nbt = '{Items:[{Slot:0b,id:"minecraft:apple",count:1}]}';
  assert.equal(rot('chest[facing=north]' + nbt, 1), C('chest[facing=east]') + nbt);
  assert.equal(mirrorState('chest[facing=north,type=left]' + nbt, 'x', reg), C('chest[facing=north,type=right]') + nbt);
});

test('rotation is fast (cached)', () => {
  const t0 = performance.now();
  for (let i = 0; i < 500_000; i++) rotateState('minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]', 1, reg);
  assert.ok(performance.now() - t0 < 1500 * loadFactor());
});
