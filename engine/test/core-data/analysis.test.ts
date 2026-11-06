import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, layerAscii, surfaceMap, findDarkSpots, lightEmission, computeBlockLight, diffVolumes } from '../../src/core/analysis.ts';
import { createVolume, volSet, volIndex, cloneVolume } from '../../src/core/volume.ts';
import type { BlockVolume, Box } from '../../src/core/types.ts';
import { reg } from './helpers.ts';

function fillBox(v: BlockVolume, b: Box, s: string): void {
  for (let y = b.min[1]; y <= b.max[1]; y++)
    for (let z = b.min[2]; z <= b.max[2]; z++) for (let x = b.min[0]; x <= b.max[0]; x++) volSet(v, x, y, z, s);
}

/** closed 9x5x9 stone room (interior 7x3x7) at origin offset */
function room(o = 100): BlockVolume {
  const v = createVolume({ min: [o, 60, o], max: [o + 8, 64, o + 8] });
  fillBox(v, v.box, 'minecraft:stone');
  fillBox(v, { min: [o + 1, 61, o + 1], max: [o + 7, 63, o + 7] }, 'minecraft:air');
  return v;
}

test('summarize counts by block id, nonAir and bounds', () => {
  const v = createVolume({ min: [10, 0, 10], max: [19, 9, 19] });
  volSet(v, 12, 3, 14, 'minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]');
  volSet(v, 13, 3, 14, 'minecraft:oak_stairs[facing=west,half=bottom,shape=straight,waterlogged=false]');
  volSet(v, 15, 5, 11, 'minecraft:stone');
  const s = summarize(v, reg());
  assert.deepEqual(s.counts, { 'minecraft:oak_stairs': 2, 'minecraft:stone': 1 });
  assert.equal(s.nonAir, 3);
  assert.deepEqual(s.bounds, { min: [12, 3, 11], max: [15, 5, 14] });
  assert.equal(Object.keys(summarize(v, reg(), { byState: true }).counts).length, 3);
  assert.equal(summarize(createVolume({ min: [0, 0, 0], max: [1, 1, 1] }), reg()).bounds, null);
});

test('layerAscii: rows = z (north on top), memorable chars, legend', () => {
  const v = createVolume({ min: [0, 0, 0], max: [4, 0, 2] });
  volSet(v, 0, 0, 0, 'minecraft:stone_bricks');
  volSet(v, 1, 0, 0, 'minecraft:water');
  volSet(v, 2, 0, 0, 'minecraft:oak_log[axis=y]');
  volSet(v, 3, 0, 1, 'minecraft:glass');
  volSet(v, 4, 0, 2, 'minecraft:stone');
  volSet(v, 0, 0, 2, 'minecraft:spruce_log[axis=y]');
  const { grid, legend } = layerAscii(v, 0);
  assert.equal(grid.length, 3);
  assert.equal(grid[0], 'B~#..');
  assert.equal(grid[1], '...g.');
  assert.equal(grid[2][0] !== '#', true, 'second log type gets its own char');
  assert.equal(legend.B, 'stone_bricks');
  assert.equal(legend['~'], 'water');
  assert.equal(legend.g, 'glass');
  assert.equal(legend[grid[2][4]], 'stone');
  assert.equal(legend[grid[2][0]], 'spruce_log');
  assert.equal(new Set(Object.keys(legend)).size, Object.keys(legend).length);
  assert.deepEqual(layerAscii(v, 5).grid, ['     ', '     ', '     ']);
});

test('surfaceMap: highest non-air (or solid) block per column', () => {
  const v = createVolume({ min: [0, 60, 0], max: [2, 70, 1] });
  fillBox(v, { min: [0, 60, 0], max: [2, 63, 1] }, 'minecraft:dirt');
  volSet(v, 0, 64, 0, 'minecraft:grass_block[snowy=false]');
  volSet(v, 1, 65, 0, 'minecraft:short_grass');
  const s = surfaceMap(v, reg());
  assert.equal(s.w, 3);
  assert.equal(s.d, 2);
  assert.deepEqual([...s.heights], [64, 65, 63, 63, 63, 63]);
  assert.equal(s.tops[0], 'minecraft:grass_block[snowy=false]');
  const solid = surfaceMap(v, reg(), { solidOnly: true });
  assert.equal(solid.heights[1], 63);
  const empty = surfaceMap(createVolume({ min: [0, 5, 0], max: [0, 6, 0] }), reg());
  assert.equal(empty.heights[0], 4);
  assert.equal(empty.tops[0], '');
});

test('lightEmission table', () => {
  assert.equal(lightEmission('minecraft:torch'), 14);
  assert.equal(lightEmission('minecraft:wall_torch[facing=north]'), 14);
  assert.equal(lightEmission('minecraft:lantern[hanging=false,waterlogged=false]'), 15);
  assert.equal(lightEmission('minecraft:glowstone'), 15);
  assert.equal(lightEmission('minecraft:sea_lantern'), 15);
  assert.equal(lightEmission('minecraft:soul_lantern[hanging=true,waterlogged=false]'), 10);
  assert.equal(lightEmission('minecraft:campfire[facing=north,lit=false,signal_fire=false,waterlogged=false]'), 0);
  assert.equal(lightEmission('minecraft:campfire[facing=north,lit=true,signal_fire=false,waterlogged=false]'), 15);
  assert.equal(lightEmission('minecraft:candle[candles=3,lit=true,waterlogged=false]'), 9);
  assert.equal(lightEmission('minecraft:redstone_lamp[lit=false]'), 0);
  assert.equal(lightEmission('minecraft:stone'), 0);
});

test('block light propagates −1 per step and is blocked by opaque blocks', () => {
  const v = room();
  volSet(v, 104, 61, 104, 'minecraft:torch');
  const l = computeBlockLight(v, reg());
  const at = (x: number, y: number, z: number) => l[volIndex(v.box, x, y, z)];
  assert.equal(at(104, 61, 104), 14);
  assert.equal(at(105, 61, 104), 13);
  assert.equal(at(107, 63, 107), 14 - 3 - 2 - 3);
  assert.equal(at(108, 61, 104), 0, 'inside the stone wall');
  // glass lets light through
  const g = room();
  fillBox(g, { min: [104, 61, 101], max: [104, 63, 107] }, 'minecraft:glass');
  volSet(g, 102, 61, 104, 'minecraft:torch');
  const gl = computeBlockLight(g, reg());
  assert.equal(gl[volIndex(g.box, 105, 61, 104)], 14 - 3);
});

test('findDarkSpots: dark room has spawnable spots, a lit room has none', () => {
  const dark = room();
  const spots = findDarkSpots(dark, reg());
  // interior floor at y=61 (stone at 60 below), 7x7 cells, y=62 above is air → 49 spots on the floor
  const floor = spots.filter(([, y]) => y === 61);
  assert.equal(floor.length, 49);
  assert.ok(spots.every(([, y]) => y >= 61 && y <= 63));
  // only the floor layer has a solid block below
  assert.equal(spots.length, 49);

  const lit = room();
  volSet(lit, 104, 62, 104, 'minecraft:glowstone');
  assert.equal(findDarkSpots(lit, reg()).length, 0, 'one glowstone lights a 7x7 room completely');

  const corner = room();
  volSet(corner, 101, 63, 101, 'minecraft:torch');
  const cs = findDarkSpots(corner, reg());
  // torch light 14, the opposite floor corner is 6+6+2 = 14 steps away → light 0 → the only dark spot
  assert.deepEqual(cs, [[107, 61, 107]]);

  // slabs / glass are not valid floors
  const glassFloor = room();
  fillBox(glassFloor, { min: [101, 60, 101], max: [107, 60, 107] }, 'minecraft:glass');
  assert.equal(findDarkSpots(glassFloor, reg()).length, 0);
  assert.equal(findDarkSpots(dark, reg(), { maxResults: 5 }).length, 5);
});

test('diffVolumes reports added / removed / replaced over the union box', () => {
  const a = createVolume({ min: [0, 0, 0], max: [2, 0, 0] });
  volSet(a, 0, 0, 0, 'minecraft:stone');
  volSet(a, 1, 0, 0, 'minecraft:dirt');
  const b = cloneVolume(a);
  volSet(b, 0, 0, 0, 'minecraft:air');
  volSet(b, 1, 0, 0, 'minecraft:glass');
  volSet(b, 2, 0, 0, 'minecraft:oak_planks');
  const extra = createVolume({ min: [3, 0, 0], max: [3, 0, 0] });
  volSet(extra, 3, 0, 0, 'minecraft:stone');
  const d = diffVolumes(a, b);
  assert.deepEqual(
    { added: d.added, removed: d.removed, replaced: d.replaced },
    { added: 1, removed: 1, replaced: 1 },
  );
  assert.deepEqual(d.changes[0], [0, 0, 0, 'minecraft:stone', 'minecraft:air']);
  const d2 = diffVolumes(a, extra);
  assert.equal(d2.added, 1);
  assert.equal(d2.removed, 2);
  assert.equal(diffVolumes(a, cloneVolume(a)).changes.length, 0);
  assert.equal(diffVolumes(a, b, { maxChanges: 1 }).truncated, true);
});
