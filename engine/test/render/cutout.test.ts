import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { renderImage } from '../../src/render/render.ts';
import { shutdownPool } from '../../src/render/pool.ts';
import { keepMask } from '../../src/render/expand.ts';
import { batchFromEntries, createVolume, volSet } from '../../src/core/volume.ts';
import { PosMap } from '../../src/core/posmap.ts';
import type { BlockVolume, Box } from '../../src/core/types.ts';
import type { Img } from '../../src/render/image.ts';
import { AssetStore } from '../../src/assets/assets.ts';

after(() => shutdownPool());
const assets = await AssetStore.tryOpen();

function mean(img: Img, fx0: number, fx1: number, fy0: number, fy1: number) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = Math.floor(img.h * fy0); y < img.h * fy1; y++)
    for (let x = Math.floor(img.w * fx0); x < img.w * fx1; x++) {
      const i = (y * img.w + x) * 4;
      r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
    }
  return { r: r / n, g: g / n, b: b / n };
}
const redness = (q: { r: number; g: number; b: number }) => q.r - (q.g + q.b) / 2;

const LEAF = 'minecraft:spruce_leaves[distance=1,persistent=false,waterlogged=false]';
const PLEAF = 'minecraft:spruce_leaves[distance=1,persistent=true,waterlogged=false]';
const LOG = 'minecraft:spruce_log[axis=y]';

/** red wall at z=2 (x 0..10, y 1..7) on stone; `front` decorates the area in front (z 5..9) */
function scene(front: (v: BlockVolume) => void): BlockVolume {
  const v = createVolume({ min: [0, 0, 0], max: [10, 9, 10] });
  for (let x = 0; x <= 10; x++)
    for (let z = 0; z <= 10; z++) {
      volSet(v, x, 0, z, 'minecraft:stone');
      if (z === 2) for (let y = 1; y <= 7; y++) volSet(v, x, y, z, 'minecraft:red_wool');
    }
  front(v);
  return v;
}
/** a wall of foliage in front: natural (persistent=false) or someone's build (persistent=true) */
function forest(leaf: string) {
  return (v: BlockVolume) => {
    for (let x = 0; x <= 10; x++) {
      for (let y = 1; y <= 8; y++) volSet(v, x, y, 6, x % 4 === 1 && y <= 3 ? LOG : leaf);
    }
  };
}
const focus: Box = { min: [0, 0, 0], max: [10, 9, 3] };
const opts = { width: 160, height: 160, view: 'front' as const, focus, shadows: false, fog: false };

test('elevation cutaway removes natural trees in front, keeps persistent leaves', async () => {
  const nat = redness(mean(await renderImage(scene(forest(LEAF)), null, opts), 0.3, 0.7, 0.3, 0.7));
  const natOff = redness(mean(await renderImage(scene(forest(LEAF)), null, { ...opts, cutaway: false }), 0.3, 0.7, 0.3, 0.7));
  const built = redness(mean(await renderImage(scene(forest(PLEAF)), null, opts), 0.3, 0.7, 0.3, 0.7));
  assert.ok(nat > 60, `natural trees cut away (${nat.toFixed(0)})`);
  assert.ok(natOff < 30, `forest hides the wall without the cutaway (${natOff.toFixed(0)})`);
  assert.ok(built < 30, `persistent (built) leaves stay (${built.toFixed(0)})`);
});

test("the job's own blocks are never cut, even terrain-like materials", async () => {
  const v = scene((vv) => {
    for (let x = 0; x <= 10; x++) for (let y = 1; y <= 7; y++) volSet(vv, x, y, 7, 'minecraft:andesite');
  });
  const cut = redness(mean(await renderImage(v, null, opts), 0.3, 0.7, 0.3, 0.7));
  assert.ok(cut > 60, `natural andesite in front is cut (${cut.toFixed(0)})`);
  const keep = new PosMap<boolean>();
  for (let x = 0; x <= 10; x++) for (let y = 1; y <= 7; y++) keep.set(x, y, 7, true);
  const kept = redness(mean(await renderImage(v, null, { ...opts, keep }), 0.3, 0.7, 0.3, 0.7));
  assert.ok(kept < 30, `agent-placed andesite stays (${kept.toFixed(0)})`);
});

test('keepMask keeps placed blocks but not terraform soil', () => {
  const b = batchFromEntries([
    [0, 0, 0, 'minecraft:andesite'], [1, 0, 0, 'minecraft:sandstone'], [2, 0, 0, 'minecraft:grass_block[snowy=false]'],
    [3, 0, 0, 'minecraft:dirt'], [4, 0, 0, 'minecraft:poppy'], [5, 0, 0, 'minecraft:air'],
  ]);
  const later = batchFromEntries([[0, 0, 0, 'minecraft:air']]);
  const k = keepMask([b, later]);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((x) => k.has(x, 0, 0)), [false, true, false, false, true, false]);
});

test('cutOutside hides natural cover outside the allowed box on the camera side only', async () => {
  // iso_se camera sits at +x/+z: a natural forest beyond z=6 (outside the allowed box) hides the wall
  const v = scene(forest(LEAF));
  const allowed: Box = { min: [0, 0, 0], max: [10, 9, 4] };
  const iso = { ...opts, view: 'iso_se' as const, focus: { min: [0, 0, 0], max: [10, 9, 10] } as Box };
  const off = redness(mean(await renderImage(v, null, iso), 0.3, 0.7, 0.3, 0.7));
  const on = redness(mean(await renderImage(v, null, { ...iso, cutOutside: allowed }), 0.3, 0.7, 0.3, 0.7));
  assert.ok(on > off + 30, `wall revealed (${off.toFixed(0)} → ${on.toFixed(0)})`);
  // looking from the other side (iso_nw) nothing in front of the wall is outside → identical image
  const nw = { ...iso, view: 'iso_nw' as const };
  const a = await renderImage(v, null, nw), b = await renderImage(v, null, { ...nw, cutOutside: allowed });
  let diff = 0;
  for (let i = 0; i < a.data.length; i++) diff += Math.abs(a.data[i] - b.data[i]);
  assert.ok(diff / a.data.length < 1, `iso_nw unchanged (${(diff / a.data.length).toFixed(2)})`);
});

test('lily pads (zero-thickness planes) show their lit top face, tinted green', { skip: !assets && 'assets unavailable' }, async () => {
  const v = createVolume({ min: [0, 0, 0], max: [4, 2, 4] });
  for (let x = 0; x <= 4; x++) for (let z = 0; z <= 4; z++) { volSet(v, x, 0, z, 'minecraft:stone'); volSet(v, x, 1, z, 'minecraft:lily_pad'); }
  const q = mean(await renderImage(v, assets, { width: 120, height: 120, view: 'top', shadows: false, fog: false }), 0.35, 0.65, 0.35, 0.65);
  assert.ok(q.g > 60 && q.g > q.r + 25 && q.g > q.b + 20, `green lily pads, got ${q.r.toFixed(0)},${q.g.toFixed(0)},${q.b.toFixed(0)}`);
});
