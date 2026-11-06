import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { AssetStore } from '../../src/assets/assets.ts';
import { renderImage, cutawayParams } from '../../src/render/render.ts';
import { shutdownPool } from '../../src/render/pool.ts';
import { glassKind, terrainClass } from '../../src/render/scene.ts';
import { builtMask, expandToComponents } from '../../src/render/expand.ts';
import { batchFromEntries, createVolume, volSet } from '../../src/core/volume.ts';
import { Registry } from '../../src/core/registry.ts';
import type { BlockVolume, Box } from '../../src/core/types.ts';
import type { Img } from '../../src/render/image.ts';

after(() => shutdownPool());
const assets = await AssetStore.tryOpen();
const reg = Registry.loadDefault();

function region(img: Img, fx0: number, fx1: number, fy0: number, fy1: number): { r: number; g: number; b: number; sat: number; n: number } {
  let r = 0, g = 0, b = 0, sat = 0, n = 0;
  for (let y = Math.floor(img.h * fy0); y < img.h * fy1; y++)
    for (let x = Math.floor(img.w * fx0); x < img.w * fx1; x++) {
      const i = (y * img.w + x) * 4;
      const R = img.data[i], G = img.data[i + 1], B = img.data[i + 2];
      r += R; g += G; b += B;
      sat += Math.max(R, G, B) - Math.min(R, G, B);
      n++;
    }
  return { r: r / n, g: g / n, b: b / n, sat: sat / n, n };
}

/** dark room (deepslate) behind a 5x5 window filled with `win` */
function windowScene(win: string | null): BlockVolume {
  const v = createVolume({ min: [0, 0, 0], max: [8, 8, 6] });
  for (let x = 0; x <= 8; x++)
    for (let y = 0; y <= 8; y++)
      for (let z = 0; z <= 6; z++) {
        const shell = x === 0 || x === 8 || y === 0 || y === 8 || z === 0 || z === 6;
        if (!shell) continue;
        const hole = z === 6 && x >= 2 && x <= 6 && y >= 2 && y <= 6;
        if (hole) {
          if (win) volSet(v, x, y, z, reg.canonical(win));
        } else volSet(v, x, y, z, 'minecraft:polished_deepslate');
      }
  return v;
}

test('glass classification', () => {
  assert.equal(glassKind('minecraft:glass'), 1);
  assert.equal(glassKind('minecraft:glass_pane'), 1);
  assert.equal(glassKind('minecraft:red_stained_glass_pane'), 2);
  assert.equal(glassKind('minecraft:tinted_glass'), 2);
  assert.equal(glassKind('minecraft:spyglass'), 0);
  assert.equal(terrainClass('minecraft:grass_block'), 1);
  assert.equal(terrainClass('minecraft:deepslate_iron_ore'), 1);
  assert.equal(terrainClass('minecraft:water'), 3);
  assert.equal(terrainClass('minecraft:short_grass'), 2);
  assert.equal(terrainClass('minecraft:stone_bricks'), 0);
  assert.equal(terrainClass('minecraft:grass_block'.replace('grass_block', 'oak_planks')), 0);
});

for (const [label, a] of [['flat fallback', null], ['textured', assets]] as const) {
  test(`clear glass and panes read as glazed, interior still visible (${label})`, { skip: label === 'textured' && !assets && 'assets unavailable' }, async () => {
    const opts = { width: 160, height: 160, view: 'front' as const, shadows: false, fog: false };
    const open = region(await renderImage(windowScene(null), a, opts), 0.42, 0.58, 0.42, 0.58);
    for (const win of ['glass', 'glass_pane[east=true,west=true]']) {
      const glazed = region(await renderImage(windowScene(win), a, opts), 0.42, 0.58, 0.42, 0.58);
      const diff = Math.abs(glazed.r - open.r) + Math.abs(glazed.g - open.g) + Math.abs(glazed.b - open.b);
      assert.ok(diff > 30, `${win}: glass changes the window pixels (diff ${diff.toFixed(1)})`);
      assert.ok(glazed.b >= glazed.r, `${win}: cool tint/sky reflection (r ${glazed.r.toFixed(0)} b ${glazed.b.toFixed(0)})`);
      // still see-through: much darker than a solid white wall would be
      assert.ok(glazed.r + glazed.g + glazed.b < 3 * 215, `${win}: not opaque white`);
    }
    // stained glass keeps its colour
    const red = region(await renderImage(windowScene('red_stained_glass'), a, opts), 0.42, 0.58, 0.42, 0.58);
    assert.ok(red.r > red.b + 20, `stained glass stays red (r ${red.r.toFixed(0)} b ${red.b.toFixed(0)})`);
  });
}

/** solid dirt slab (terrain) cut by the volume on all sides, with grass on top */
function terrainSlab(): BlockVolume {
  const v = createVolume({ min: [0, 0, 0], max: [11, 5, 11] });
  for (let x = 0; x <= 11; x++) for (let z = 0; z <= 11; z++) for (let y = 0; y <= 4; y++) volSet(v, x, y, z, y === 4 ? 'minecraft:grass_block[snowy=false]' : 'minecraft:dirt');
  return v;
}

for (const [label, a] of [['flat fallback', null], ['textured', assets]] as const) {
  test(`terrain cut by the volume boundary is drawn as a neutral section (${label})`, { skip: label === 'textured' && !assets && 'assets unavailable' }, async () => {
    const opts = { width: 200, height: 160, view: 'front' as const, shadows: false, fog: false, ground: false };
    // front elevation of the slab: the visible face is entirely the +z cut face
    const on = region(await renderImage(terrainSlab(), a, { ...opts, section: true }), 0.3, 0.7, 0.55, 0.7);
    const off = region(await renderImage(terrainSlab(), a, { ...opts, section: false }), 0.3, 0.7, 0.55, 0.7);
    assert.ok(on.sat < off.sat * 0.75, `section is desaturated (sat ${on.sat.toFixed(1)} vs ${off.sat.toFixed(1)})`);
  });
}

test('elevation cutaway removes natural terrain in front of the focus box', async () => {
  // red wall at z=2, a dirt hill in front of it (z 5..9) that hides the wall's lower part
  const v = createVolume({ min: [0, 0, 0], max: [10, 8, 10] });
  for (let x = 0; x <= 10; x++)
    for (let z = 0; z <= 10; z++) {
      volSet(v, x, 0, z, 'minecraft:stone');
      if (z === 2) for (let y = 1; y <= 7; y++) volSet(v, x, y, z, 'minecraft:red_wool');
      if (z >= 5 && z <= 9) for (let y = 1; y <= 6; y++) volSet(v, x, y, z, y === 6 ? 'minecraft:grass_block[snowy=false]' : 'minecraft:andesite');
      if (z === 10) volSet(v, x, 1, z, 'minecraft:short_grass');
    }
  const focus: Box = { min: [0, 0, 0], max: [10, 8, 3] };
  const opts = { width: 160, height: 160, view: 'front' as const, focus, shadows: false, fog: false };
  const redness = (img: Img) => {
    const q = region(img, 0.3, 0.7, 0.45, 0.75);
    return q.r - (q.g + q.b) / 2;
  };
  const cut = redness(await renderImage(v, null, opts));
  const uncut = redness(await renderImage(v, null, { ...opts, cutaway: false }));
  assert.ok(cut > 60, `wall visible with the cutaway (${cut.toFixed(0)})`);
  assert.ok(uncut < 20, `hill hides the wall without it (${uncut.toFixed(0)})`);
  // params: only elevations with a focus
  assert.deepEqual(cutawayParams({ view: 'iso_se', focus }, { ox: 0, oz: 0 }), {});
  assert.deepEqual(cutawayParams({ view: 'front' }, { ox: 0, oz: 0 }), {});
  assert.deepEqual(cutawayParams({ view: 'front', focus }, { ox: 0, oz: 0 }), { clipAxis: 2, clipSign: 1, clipAt: 3 });
  assert.deepEqual(cutawayParams({ view: 'left', focus }, { ox: -5, oz: 0 }), { clipAxis: 0, clipSign: -1, clipAt: 5 });
  // parallel workers get the same params
  const big = { ...opts, width: 420, height: 400 };
  const s = await renderImage(v, null, { ...big, parallel: false });
  const p = await renderImage(v, null, { ...big, parallel: true });
  let diff = 0;
  for (let i = 0; i < s.data.length; i++) diff += Math.abs(s.data[i] - p.data[i]);
  assert.ok(diff / s.data.length < 0.01);
});

test('render box expansion follows connected build parts, not terrain', () => {
  const E: [number, number, number, string][] = [];
  // a house 0..9 x, 0..5 y, 0..5 z ; a separate shed at x 30 ; terraformed dirt everywhere
  for (let x = 0; x <= 9; x++) for (let z = 0; z <= 5; z++) for (let y = 0; y <= 5; y++) if (y === 0 || x === 0 || x === 9 || z === 0 || z === 5) E.push([x, y, z, 'minecraft:stone_bricks']);
  for (let x = -20; x <= 40; x++) for (let z = -5; z <= 10; z++) E.push([x, -1, z, 'minecraft:dirt']);
  E.push([30, 0, 0, 'minecraft:oak_planks']);
  // a block that was built and later removed must not count
  const later = batchFromEntries([[12, 0, 0, 'minecraft:air']]);
  E.push([10, 0, 0, 'minecraft:oak_planks'], [11, 0, 0, 'minecraft:oak_planks'], [12, 0, 0, 'minecraft:oak_planks']);
  const built = builtMask([batchFromEntries(E), later]);
  assert.equal(built.has(5, -1, 2), false, 'terrain is not the build');
  assert.equal(built.has(12, 0, 0), false, 'later removal wins');
  const box: Box = { min: [6, 0, 0], max: [9, 5, 5] };
  const g = expandToComponents(box, built);
  assert.deepEqual(g, { min: [0, 0, 0], max: [11, 5, 5] });
  // y limit: no growth above the box (interiors stay visible)
  const low: Box = { min: [6, 0, 0], max: [9, 2, 5] };
  assert.deepEqual(expandToComponents(low, built, { limit: { min: [-1e9, -1e9, -1e9], max: [1e9, 2, 1e9] } }), { min: [0, 0, 0], max: [11, 2, 5] });
  // bounded growth
  assert.deepEqual(expandToComponents(box, built, { maxExtra: 3 }), { min: [3, 0, 0], max: [11, 5, 5] });
  // nothing built in the box → unchanged
  assert.deepEqual(expandToComponents({ min: [20, 3, 0], max: [22, 4, 2] }, built), { min: [20, 3, 0], max: [22, 4, 2] });
});
