import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { AssetStore } from '../../src/assets/assets.ts';
import { renderVolume, renderImage, contactSheet, renderLayers } from '../../src/render/render.ts';
import { shutdownPool, poolStats } from '../../src/render/pool.ts';
import { createVolume, volSet } from '../../src/core/volume.ts';
import { redCube, cottage } from '../../scripts/sample-builds.ts';

after(() => shutdownPool());
const assets = await AssetStore.tryOpen();

function decode(buf: Buffer) {
  return PNG.sync.read(buf);
}
function stats(png: PNG) {
  const set = new Set<number>();
  for (let i = 0; i < png.data.length; i += 4 * 7) set.add((png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2]);
  return set.size;
}
/** fraction of "red" pixels in the central region */
function redFraction(png: PNG, fx0 = 0.4, fx1 = 0.6, fy0 = 0.35, fy1 = 0.6): number {
  let red = 0, n = 0;
  for (let y = Math.floor(png.height * fy0); y < png.height * fy1; y++)
    for (let x = Math.floor(png.width * fx0); x < png.width * fx1; x++) {
      const i = (y * png.width + x) * 4;
      const [r, g, b] = [png.data[i], png.data[i + 1], png.data[i + 2]];
      if (r > g + 40 && r > b + 40) red++;
      n++;
    }
  return red / n;
}

for (const [label, a] of [['flat fallback', null], ['textured', assets]] as const) {
  test(`red wool cube appears red in the centre (${label})`, { skip: label === 'textured' && !assets && 'assets unavailable' }, async () => {
    const png = decode(await renderVolume(redCube(), a, { width: 320, height: 240, view: 'iso_se' }));
    assert.equal(png.width, 320);
    assert.equal(png.height, 240);
    assert.ok(stats(png) > 50, 'image is not uniform');
    const f = redFraction(png);
    assert.ok(f > 0.5, `expected mostly red centre, got ${f}`);
    // corners show sky / ground, not red
    assert.ok(redFraction(png, 0, 0.1, 0, 0.1) < 0.05);
  });
}

test('all camera presets render with the requested size', async () => {
  const v = redCube();
  for (const view of ['iso_ne', 'iso_nw', 'iso_se', 'iso_sw', 'front', 'back', 'left', 'right', 'top', 'orbit'] as const) {
    const png = decode(await renderVolume(v, null, { width: 96, height: 64, view, shadows: view !== 'top' }));
    assert.equal(png.width, 96);
    assert.equal(png.height, 64);
    assert.ok(redFraction(png, 0.35, 0.65, 0.3, 0.7) > 0.2, `${view}: cube visible`);
  }
});

test('supersampling, labels, highlight, night and empty volume', async () => {
  const v = redCube();
  const a = decode(await renderVolume(v, null, { width: 120, height: 90, supersample: 2, labels: true, highlight: { min: [3, 1, 3], max: [5, 3, 5] }, time: 'night' }));
  assert.equal(a.width, 120);
  const empty = decode(await renderVolume(createVolume({ min: [0, 0, 0], max: [3, 3, 3] }), null, { width: 64, height: 48 }));
  assert.equal(empty.width, 64);
});

test('parallel (worker) render matches the single-threaded render', async () => {
  const v = cottage();
  const opts = { width: 420, height: 400, view: 'iso_sw' as const };
  const s = await renderImage(v, assets, { ...opts, parallel: false });
  const before = poolStats.parallelRenders;
  const p = await renderImage(v, assets, { ...opts, parallel: true });
  assert.equal(poolStats.parallelRenders, before + 1, 'workers were used');
  let diff = 0;
  for (let i = 0; i < s.data.length; i++) diff += Math.abs(s.data[i] - p.data[i]);
  assert.ok(diff / s.data.length < 0.01, `mean abs diff ${diff / s.data.length}`);
});

test('contact sheet and blueprint layers', async () => {
  const v = cottage();
  const sheet = decode(await contactSheet(v, null, { width: 400, height: 300 }));
  assert.equal(sheet.width, 400);
  assert.equal(sheet.height, 300);
  assert.ok(stats(sheet) > 100);
  const layers = decode(await renderLayers(v, assets, [63, 64], { cell: 6 }));
  assert.ok(layers.width > 32 * 6 * 2 && layers.height > 32 * 6);
  const one = decode(await renderLayers(v, null, [64]));
  assert.ok(one.width > 100);
});

test('waterlogged/translucent/fluids and odd palettes do not crash', async () => {
  const v = createVolume({ min: [0, 0, 0], max: [5, 3, 5] });
  const states = ['minecraft:water[level=0]', 'minecraft:lava[level=0]', 'minecraft:glass', 'minecraft:red_stained_glass',
    'minecraft:oak_stairs[facing=east,half=top,shape=outer_left,waterlogged=true]', 'minecraft:chest[facing=west,type=left,waterlogged=false]',
    'minecraft:not_a_block', 'minecraft:torch', 'minecraft:poppy', 'minecraft:oak_leaves[distance=1,persistent=true,waterlogged=false]'];
  states.forEach((s, i) => volSet(v, i % 6, 1 + Math.floor(i / 6), (i * 2) % 6, s));
  const png = decode(await renderVolume(v, assets, { width: 160, height: 120 }));
  assert.equal(png.width, 160);
});
