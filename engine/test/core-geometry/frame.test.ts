import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Frame } from '../../src/core/frame.ts';
import type { Facing, Vec3 } from '../../src/core/types.ts';
import { reg } from './helpers.ts';

const FACINGS: Facing[] = ['north', 'east', 'south', 'west'];
const FWD: Record<Facing, Vec3> = { north: [0, 0, -1], east: [1, 0, 0], south: [0, 0, 1], west: [-1, 0, 0] };
// the player's right hand when looking in that direction
const RIGHT: Record<Facing, Vec3> = { north: [1, 0, 0], east: [0, 0, 1], south: [-1, 0, 0], west: [0, 0, -1] };

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

test('turns per facing and identity', () => {
  assert.deepEqual(FACINGS.map((f) => new Frame([0, 0, 0], f, reg).turns), [0, 1, 2, 3]);
  const id = Frame.identity(reg);
  assert.equal(id.turns, 0);
  assert.deepEqual(id.toWorld([3, 4, 5]), [3, 4, 5]);
  assert.ok(id.isIdentity);
  assert.throws(() => new Frame([0, 0, 0], 'up' as Facing, reg));
});

test('toWorld follows the documented formula for all 4 facings', () => {
  const a: Vec3 = [100, 64, -200];
  const exp: Record<Facing, (x: number, z: number) => [number, number]> = {
    north: (x, z) => [x, z],
    east: (x, z) => [-z, x],
    south: (x, z) => [-x, -z],
    west: (x, z) => [z, -x],
  };
  for (const f of FACINGS) {
    const fr = new Frame(a, f, reg);
    for (const v of [[0, 0, 0], [1, 2, 3], [-4, 0, 7], [5, -1, -5]] as Vec3[]) {
      const [ex, ez] = exp[f](v[0], v[2]);
      assert.deepEqual(fr.toWorld(v), [a[0] + ex, a[1] + v[1], a[2] + ez], `${f} ${v}`);
      assert.deepEqual(fr.toLocal(fr.toWorld(v)), v);
      const out: Vec3 = [0, 0, 0];
      assert.deepEqual(fr.toWorldInto(v[0], v[1], v[2], out), fr.toWorld(v));
    }
  }
});

test('local −z is the player forward, +x the player right, +z toward the player', () => {
  for (const f of FACINGS) {
    const fr = new Frame([10, 0, 10], f, reg);
    assert.deepEqual(sub(fr.toWorld([0, 0, -1]), [10, 0, 10]), FWD[f], f);
    assert.deepEqual(sub(fr.toWorld([1, 0, 0]), [10, 0, 10]), RIGHT[f], f);
    const back = sub(fr.toWorld([0, 0, 1]), [10, 0, 10]);
    assert.deepEqual(back, FWD[f].map((v) => -v + 0));
    assert.deepEqual(sub(fr.toWorld([0, 3, 0]), [10, 0, 10]), [0, 3, 0]);
  }
});

test('stateToWorld rotates states consistently with positions', () => {
  for (const f of FACINGS) {
    const fr = new Frame([0, 0, 0], f, reg);
    // a stair that ascends away from the player (local north) ascends in the player's look direction
    assert.equal(fr.stateToWorld('oak_stairs[facing=north]'), reg.canonical(`oak_stairs[facing=${f}]`));
    // a door facing the player (local south) faces back toward the player in world space
    const opp = { north: 'south', south: 'north', east: 'west', west: 'east' }[f];
    assert.equal(fr.stateToWorld('oak_door[facing=south]'), reg.canonical(`oak_door[facing=${opp}]`));
    // fence connected to the player's right
    const right = Object.entries(RIGHT).find(([k]) => k === f)![1];
    const rightName = Object.entries(FWD).find(([, v]) => v[0] === right[0] && v[2] === right[2])![0];
    assert.equal(fr.stateToWorld('oak_fence[east=true]'), reg.canonical(`oak_fence[${rightName}=true]`));
    for (const s of ['oak_stairs[facing=east,shape=inner_left]', 'oak_log[axis=x]', 'oak_sign[rotation=3]', 'rail[shape=north_east]'])
      assert.equal(fr.stateToLocal(fr.stateToWorld(s)), reg.canonical(s));
  }
});

test('boxToWorld is normalized', () => {
  const fr = new Frame([5, 60, 5], 'south', reg);
  const b = fr.boxToWorld({ min: [0, 0, -10], max: [4, 3, 0] });
  assert.deepEqual(b, { min: [1, 60, 5], max: [5, 63, 15] });
  assert.deepEqual(fr.boxToLocal(b), { min: [0, 0, -10], max: [4, 3, 0] });
  for (const f of FACINGS) {
    const w = new Frame([0, 0, 0], f, reg).boxToWorld({ min: [-2, 0, -3], max: [4, 5, 6] });
    for (let i = 0; i < 3; i++) assert.ok(w.min[i] <= w.max[i]);
  }
});
