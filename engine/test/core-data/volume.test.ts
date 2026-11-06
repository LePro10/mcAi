import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  b64ToInt32,
  b64ToUint16,
  batchBounds,
  batchEntries,
  batchFromEntries,
  boxContains,
  boxIntersect,
  boxSize,
  boxUnion,
  boxVolume,
  compactVolume,
  createVolume,
  normBox,
  paletteIndex,
  splitBatch,
  typedToB64,
  volForEach,
  volGet,
  volIndex,
  volPaste,
  volSet,
} from '../../src/core/volume.ts';
import { PosMap, packXZ, unpackXZ, checkCoord } from '../../src/core/posmap.ts';

test('box helpers', () => {
  const b = normBox([5, 10, -3], [1, 2, 3]);
  assert.deepEqual(b, { min: [1, 2, -3], max: [5, 10, 3] });
  assert.deepEqual(boxSize(b), [5, 9, 7]);
  assert.equal(boxVolume(b), 315);
  assert.ok(boxContains(b, 1, 2, -3) && boxContains(b, 5, 10, 3));
  assert.ok(!boxContains(b, 0, 2, 0) && !boxContains(b, 1, 11, 0));
  assert.deepEqual(boxUnion(b, { min: [0, 0, 0], max: [1, 1, 1] }), { min: [0, 0, -3], max: [5, 10, 3] });
  assert.deepEqual(boxIntersect(b, { min: [4, 0, 0], max: [9, 3, 9] }), { min: [4, 2, 0], max: [5, 3, 3] });
  assert.equal(boxIntersect(b, { min: [6, 0, 0], max: [9, 3, 9] }), null);
});

test('volume layout is x fastest, then z, then y', () => {
  const box = { min: [10, 20, 30] as [number, number, number], max: [12, 21, 33] as [number, number, number] };
  assert.equal(volIndex(box, 10, 20, 30), 0);
  assert.equal(volIndex(box, 11, 20, 30), 1);
  assert.equal(volIndex(box, 10, 20, 31), 3);
  assert.equal(volIndex(box, 10, 21, 30), 12);
  const v = createVolume(box);
  assert.equal(v.palette[0], 'minecraft:air');
  assert.equal(v.data.length, 24);
  volSet(v, 11, 21, 32, 'minecraft:stone');
  volSet(v, 12, 20, 30, 'minecraft:stone');
  volSet(v, 10, 20, 30, 'minecraft:dirt');
  assert.deepEqual(v.palette, ['minecraft:air', 'minecraft:stone', 'minecraft:dirt']);
  assert.equal(volGet(v, 11, 21, 32), 'minecraft:stone');
  assert.equal(volGet(v, 99, 99, 99), 'minecraft:air', 'outside = air');
  assert.throws(() => volSet(v, 99, 0, 0, 'minecraft:stone'), /outside the volume/);
  const seen: string[] = [];
  volForEach(v, (x, y, z, s) => seen.push(`${x},${y},${z}=${s}`), { skipAir: true });
  assert.deepEqual(seen, ['10,20,30=minecraft:dirt', '12,20,30=minecraft:stone', '11,21,32=minecraft:stone']);
});

test('palette dedupe survives external palette edits', () => {
  const pal = ['minecraft:air'];
  assert.equal(paletteIndex(pal, 'a'), 1);
  assert.equal(paletteIndex(pal, 'a'), 1);
  pal.push('b');
  assert.equal(paletteIndex(pal, 'b'), 2);
  assert.equal(paletteIndex(pal, 'c'), 3);
  assert.equal(pal.length, 4);
});

test('volPaste and compactVolume', () => {
  const a = createVolume({ min: [0, 0, 0], max: [3, 3, 3] });
  const b = createVolume({ min: [2, 2, 2], max: [5, 5, 5] });
  volSet(b, 2, 2, 2, 'x:1');
  volSet(b, 3, 3, 3, 'x:2');
  volSet(b, 5, 5, 5, 'x:3');
  volPaste(a, b);
  assert.equal(volGet(a, 2, 2, 2), 'x:1');
  assert.equal(volGet(a, 3, 3, 3), 'x:2');
  volSet(a, 2, 2, 2, 'minecraft:air');
  const c = compactVolume(a);
  assert.deepEqual(c.palette, ['minecraft:air', 'x:2']);
  assert.equal(volGet(c, 3, 3, 3), 'x:2');
});

test('batches: build, iterate, split, bounds', () => {
  const entries: Array<[number, number, number, string]> = [];
  for (let i = 0; i < 120; i++) entries.push([i, -i | 0, i * 2, i % 3 ? 'minecraft:stone' : 'minecraft:dirt']);
  const b = batchFromEntries(entries);
  assert.equal(b.palette.length, 2);
  assert.equal(b.states.length, 120);
  assert.deepEqual([...batchEntries(b)], entries);
  const parts = splitBatch(b, 50);
  assert.deepEqual(parts.map((p) => p.states.length), [50, 50, 20]);
  assert.deepEqual([...batchEntries(parts[2])][0], entries[100]);
  assert.deepEqual(batchBounds(b), { min: [0, -119, 0], max: [119, 0, 238] });
});

test('base64 typed array round trip', () => {
  const a = Int32Array.from([1, -2, 30_000_000, -30_000_000]);
  assert.deepEqual([...b64ToInt32(typedToB64(a))], [...a]);
  const u = Uint16Array.from([0, 1, 65535]);
  assert.deepEqual([...b64ToUint16(typedToB64(u))], [...u]);
  // subarray views keep their offset
  assert.deepEqual([...b64ToInt32(typedToB64(a.subarray(2)))], [30_000_000, -30_000_000]);
});

test('posmap packs ±30M x/z exactly with any y', () => {
  for (const [x, z] of [
    [0, 0],
    [-30_000_000, 30_000_000],
    [30_000_000, -30_000_000],
    [33_554_431, -33_554_431],
    [-1, -1],
  ]) {
    assert.deepEqual(unpackXZ(packXZ(x, z)), [x, z]);
    assert.ok(Number.isSafeInteger(packXZ(x, z)));
  }
  const m = new PosMap<string>();
  m.set(-30_000_000, -64, 30_000_000, 'a');
  m.set(-30_000_000, 320, 30_000_000, 'b');
  m.set(30_000_000, -64, -30_000_000, 'c');
  m.set(0, 5000, 0, 'd');
  m.set(0, 5000, 0, 'd2');
  assert.equal(m.size, 4);
  assert.equal(m.get(-30_000_000, -64, 30_000_000), 'a');
  assert.equal(m.get(-30_000_000, 320, 30_000_000), 'b');
  assert.equal(m.get(30_000_000, -64, -30_000_000), 'c');
  assert.equal(m.get(-30_000_000, -63, 30_000_000), undefined);
  assert.equal(m.get(0, 5000, 0), 'd2');
  const all = [...m.entries()].map((e) => e.join(',')).sort();
  assert.deepEqual(all, ['-30000000,-64,30000000,a', '-30000000,320,30000000,b', '0,5000,0,d2', '30000000,-64,-30000000,c']);
  assert.ok(m.delete(0, 5000, 0));
  assert.equal(m.size, 3);
  assert.ok(!m.has(0, 5000, 0));
  assert.throws(() => checkCoord(0.5, 0, 0), /integers/);
  assert.throws(() => checkCoord(40_000_000, 0, 0), /outside the world/);
});
