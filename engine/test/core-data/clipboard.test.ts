import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyRegion, copyFromSink, pasteInto, pasteBox, transformClipboard, stackRegion, moveRegion, clipboardBlockCount, type Clipboard } from '../../src/core/clipboard.ts';
import { createVolume, volGet, volSet, boxSize } from '../../src/core/volume.ts';
import { compileMask } from '../../src/core/mask.ts';
import { MemBackend, RecordingSink, reg } from './helpers.ts';

const STAIRS_N = 'minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]';
const STAIRS_E = 'minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]';
const STAIRS_S = 'minecraft:oak_stairs[facing=south,half=bottom,shape=straight,waterlogged=false]';

function sample(): Clipboard {
  // 3 wide (x), 1 high, 2 deep (z); copy point at the volume min
  const v = createVolume({ min: [10, 64, 20], max: [12, 64, 21] });
  volSet(v, 10, 64, 20, 'minecraft:stone');
  volSet(v, 12, 64, 20, STAIRS_N);
  volSet(v, 10, 64, 21, 'minecraft:oak_log[axis=x]');
  return { volume: v, origin: [0, 0, 0] };
}

test('copyRegion + pasteInto round trip (origin = copy point)', async () => {
  const be = new MemBackend([
    [0, 0, 0, 'minecraft:stone'],
    [2, 1, 3, 'minecraft:dirt'],
  ]);
  const c = await copyRegion(be, { min: [0, 0, 0], max: [2, 1, 3] }, [1, 0, 1]);
  assert.deepEqual(c.origin, [1, 0, 1]);
  assert.equal(clipboardBlockCount(c), 2);
  const sink = new RecordingSink();
  const n = pasteInto(sink, c, [101, 50, 101]);
  assert.equal(n, 24, 'air is pasted by default');
  assert.equal(sink.get(100, 50, 100), 'minecraft:stone');
  assert.equal(sink.get(102, 51, 103), 'minecraft:dirt');
  assert.deepEqual(pasteBox(c, [101, 50, 101]), { min: [100, 50, 100], max: [102, 51, 103] });
  const sink2 = new RecordingSink();
  assert.equal(pasteInto(sink2, c, [1, 0, 1], { ignoreAir: true }), 2);
});

test('pasteInto with mask only replaces matching blocks; structure_void is never pasted', () => {
  const c = sample();
  volSet(c.volume, 11, 64, 21, 'minecraft:structure_void');
  const sink = new RecordingSink((x) => (x === 0 ? 'minecraft:grass_block' : 'minecraft:air'));
  const n = pasteInto(sink, c, [0, 0, 0], { mask: compileMask('air', reg()) });
  assert.equal(sink.get(0, 0, 0), 'minecraft:grass_block', 'masked out');
  assert.equal(sink.get(2, 0, 0), STAIRS_N);
  assert.ok(!sink.map.has('1,0,1'), 'structure void skipped');
  assert.equal(n, 3);
});

test('transformClipboard rotates positions and states clockwise around the copy point', () => {
  const c = sample();
  const r = transformClipboard(c, { rotate: 1 }, reg());
  assert.deepEqual(boxSize(r.volume.box), [2, 1, 3]);
  // copy point keeps its world position
  const W = [r.volume.box.min[0] + r.origin[0], r.volume.box.min[1] + r.origin[1], r.volume.box.min[2] + r.origin[2]];
  assert.deepEqual(W, [10, 64, 20]);
  // relative (2,0) → (−0, 2) = (0, 2) ; stairs facing north → east
  assert.equal(volGet(r.volume, 10, 64, 22), STAIRS_E);
  // relative (0,1) → (−1, 0): log axis x → z
  assert.equal(volGet(r.volume, 9, 64, 20), 'minecraft:oak_log[axis=z]');
  assert.equal(volGet(r.volume, 10, 64, 20), 'minecraft:stone');
  // 4 quarter turns = identity
  let t = c;
  for (let i = 0; i < 4; i++) t = transformClipboard(t, { rotate: 1 }, reg());
  assert.deepEqual(t.volume.box, c.volume.box);
  for (const [x, z] of [
    [10, 20],
    [12, 20],
    [10, 21],
    [11, 21],
  ])
    assert.equal(volGet(t.volume, x, 64, z), volGet(c.volume, x, 64, z));
  // 180°
  const h = transformClipboard(c, { rotate: 2 }, reg());
  assert.equal(volGet(h.volume, 8, 64, 20), STAIRS_S);
});

test('transformClipboard mirror flips positions and states', () => {
  const c = sample();
  const m = transformClipboard(c, { mirror: 'z' }, reg());
  // z mirror: relative (2,0) stays, stairs facing north → south; (0,1) → (0,−1)
  assert.equal(volGet(m.volume, 12, 64, 20), STAIRS_S);
  assert.equal(volGet(m.volume, 10, 64, 19), 'minecraft:oak_log[axis=x]');
  const mx = transformClipboard(c, { mirror: 'x' }, reg());
  assert.equal(volGet(mx.volume, 8, 64, 20), STAIRS_N, 'x mirror keeps a north-facing stair facing north');
  const pasted = new RecordingSink();
  pasteInto(pasted, m, [0, 0, 0]);
  assert.equal(pasted.get(2, 0, 0), STAIRS_S);
});

test('stackRegion and moveRegion', () => {
  const sink = new RecordingSink();
  sink.set(0, 0, 0, 'minecraft:stone');
  sink.set(1, 0, 0, 'minecraft:dirt');
  const n = stackRegion(sink, { min: [0, 0, 0], max: [1, 0, 0] }, 3, [1, 0, 0], { gap: 1 });
  assert.equal(n, 6);
  assert.equal(sink.get(3, 0, 0), 'minecraft:stone');
  assert.equal(sink.get(4, 0, 0), 'minecraft:dirt');
  assert.equal(sink.get(9, 0, 0), 'minecraft:stone');
  assert.equal(sink.get(2, 0, 0), 'minecraft:air', 'gap');
  const up = stackRegion(sink, { min: [0, 0, 0], max: [0, 0, 0] }, 2, [0, 1, 0]);
  assert.equal(up, 2);
  assert.equal(sink.get(0, 2, 0), 'minecraft:stone');

  const s2 = new RecordingSink();
  s2.set(0, 0, 0, 'minecraft:stone');
  s2.set(1, 0, 0, 'minecraft:dirt');
  moveRegion(s2, { min: [0, 0, 0], max: [1, 0, 0] }, [1, 0, 0]);
  assert.equal(s2.get(0, 0, 0), 'minecraft:air');
  assert.equal(s2.get(1, 0, 0), 'minecraft:stone');
  assert.equal(s2.get(2, 0, 0), 'minecraft:dirt');
});

test('copyFromSink copies through any BlockSink', () => {
  const sink = new RecordingSink((x, y, z) => (y === 0 ? 'minecraft:grass_block' : 'minecraft:air'));
  const c = copyFromSink(sink, { min: [0, 0, 0], max: [1, 1, 1] }, [0, 0, 0]);
  assert.equal(clipboardBlockCount(c), 4);
});
