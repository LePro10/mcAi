import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVolume, volSet } from '../../src/core/volume.ts';
import { cropBelow, undergroundCropY } from '../../src/render/crop.ts';

test('render auto-crop removes solid underground below the terrain surface / lowest built block', () => {
  const v = createVolume({ min: [0, 0, 0], max: [9, 40, 9] });
  for (let x = 0; x <= 9; x++) for (let z = 0; z <= 9; z++) for (let y = 0; y <= 20; y++) volSet(v, x, y, z, y === 20 ? 'minecraft:grass_block[snowy=false]' : 'minecraft:stone');
  for (let y = 21; y <= 25; y++) volSet(v, 4, y, 4, 'minecraft:oak_planks');
  assert.equal(undergroundCropY(v), 17);
  // a basement (built block deep down) keeps more
  volSet(v, 2, 12, 2, 'minecraft:stone_bricks');
  assert.equal(undergroundCropY(v), 9);
  const c = cropBelow(v, 9);
  assert.equal(c.box.min[1], 9);
  assert.equal(c.data.length, 10 * 10 * 32);
  assert.equal(c.palette[c.data[(12 - 9) * 100 + 2 * 10 + 2]!], 'minecraft:stone_bricks');
});
