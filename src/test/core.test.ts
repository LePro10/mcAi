import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  compile, mergeToBoxes, VoxelBuffer, packKey, unpackKey, splitOversized,
  MAX_FILL_VOLUME, orderBoxes, validateBlueprint, estimateBlueprintVolume,
  getPrefab, listPrefabs, matchPrefab, resolvePalette, styleForBiome,
  normalizeBlock, parseBlock, formatBlock, rotateBlockSpec, mirrorBlockSpec,
  withStates, rotateY, line3, hash3, noise01, weightedIndex, renderIsoSvg,
  renderAsciiTop, visibleVoxels,
} from '../core/index.js';
import type { Blueprint, FillBox } from '../core/types.js';

// ── Voxel keys ────────────────────────────────────────────────────────────

test('packKey round-trips coordinates including negatives', () => {
  for (const p of [[0, 0, 0], [1, 2, 3], [-1, -2, -3], [-4095, 4095, -4095], [512, -64, 999]] as const) {
    assert.deepEqual(unpackKey(packKey(p[0], p[1], p[2])), [p[0], p[1], p[2]]);
  }
});

test('packKey is collision-free across a dense sample', () => {
  const seen = new Set<number>();
  for (let x = -20; x <= 20; x++)
    for (let y = -20; y <= 20; y++)
      for (let z = -20; z <= 20; z++) {
        const k = packKey(x, y, z);
        assert.equal(seen.has(k), false, `collision at ${x},${y},${z}`);
        seen.add(k);
      }
});

test('VoxelBuffer tracks bounds and honours keep mode', () => {
  const b = new VoxelBuffer();
  b.set(0, 0, 0, 'stone');
  b.set(5, 3, -2, 'dirt');
  assert.equal(b.size, 2);
  assert.deepEqual([b.minX, b.minY, b.minZ], [0, 0, -2]);
  assert.deepEqual([b.maxX, b.maxY, b.maxZ], [5, 3, 0]);

  b.set(0, 0, 0, 'oak_planks', true);
  assert.equal(b.get(0, 0, 0), 'stone', 'keep must not overwrite');
  b.set(0, 0, 0, 'oak_planks');
  assert.equal(b.get(0, 0, 0), 'oak_planks', 'replace must overwrite');
});

test('VoxelBuffer enforces its budget', () => {
  const b = new VoxelBuffer(10);
  assert.throws(() => {
    for (let i = 0; i < 100; i++) b.set(i, 0, 0, 'stone');
  }, /voxel budget/i);
});

// ── Box merging ───────────────────────────────────────────────────────────

test('mergeToBoxes collapses a solid cuboid into one fill', () => {
  const b = new VoxelBuffer();
  for (let y = 0; y < 4; y++)
    for (let z = 0; z < 5; z++)
      for (let x = 0; x < 6; x++) b.set(x, y, z, 'stone');
  const boxes = mergeToBoxes(b);
  assert.equal(boxes.length, 1);
  assert.deepEqual(
    [boxes[0].x1, boxes[0].y1, boxes[0].z1, boxes[0].x2, boxes[0].y2, boxes[0].z2],
    [0, 0, 0, 5, 3, 4],
  );
  assert.equal(boxes[0].volume, 120);
});

test('mergeToBoxes covers every voxel exactly once', () => {
  const b = new VoxelBuffer();
  // A deliberately awkward shape: an L with a hole and two materials.
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 8; x++) b.set(x, y, 0, x < 4 ? 'stone' : 'dirt');
    for (let z = 0; z < 6; z++) b.set(0, y, z, 'stone');
  }
  b.delete(0, 1, 3);

  const boxes = mergeToBoxes(b);
  const covered = new Map<number, number>();
  for (const box of boxes) {
    for (let y = box.y1; y <= box.y2; y++)
      for (let z = box.z1; z <= box.z2; z++)
        for (let x = box.x1; x <= box.x2; x++) {
          const k = packKey(x, y, z);
          covered.set(k, (covered.get(k) ?? 0) + 1);
          assert.equal(b.get(x, y, z), box.block, `wrong block at ${x},${y},${z}`);
        }
  }
  assert.equal(covered.size, b.size, 'every voxel covered');
  for (const [, count] of covered) assert.equal(count, 1, 'no voxel covered twice');
});

test('mergeToBoxes never merges across different blocks', () => {
  const b = new VoxelBuffer();
  for (let x = 0; x < 10; x++) b.set(x, 0, 0, x % 2 ? 'stone' : 'dirt');
  const boxes = mergeToBoxes(b);
  assert.equal(boxes.length, 10);
});

test('mergeToBoxes reports volume matching its extents', () => {
  const b = new VoxelBuffer();
  for (let y = 0; y < 7; y++)
    for (let z = 0; z < 3; z++)
      for (let x = 0; x < 11; x++) b.set(x, y, z, 'stone_bricks');
  for (const box of mergeToBoxes(b)) {
    const expected = (box.x2 - box.x1 + 1) * (box.y2 - box.y1 + 1) * (box.z2 - box.z1 + 1);
    assert.equal(box.volume, expected);
  }
});

// ── Fill limits and ordering ──────────────────────────────────────────────

test('splitOversized keeps every fill within the vanilla limit', () => {
  const huge: FillBox = { x1: 0, y1: 0, z1: 0, x2: 99, y2: 99, z2: 99, block: 'stone', volume: 1_000_000 };
  const parts = splitOversized([huge]);
  let total = 0;
  for (const p of parts) {
    assert.ok(p.volume <= MAX_FILL_VOLUME, `box of ${p.volume} exceeds the limit`);
    total += p.volume;
  }
  assert.equal(total, 1_000_000, 'splitting must preserve total volume');
});

test('splitOversized handles a single layer that is already too big', () => {
  const flat: FillBox = { x1: 0, y1: 0, z1: 0, x2: 399, y2: 0, z2: 399, block: 'stone', volume: 160_000 };
  const parts = splitOversized([flat]);
  let total = 0;
  for (const p of parts) {
    assert.ok(p.volume <= MAX_FILL_VOLUME);
    total += p.volume;
  }
  assert.equal(total, 160_000);
});

test('orderBoxes clears first and attaches last', () => {
  const boxes: FillBox[] = [
    { x1: 0, y1: 5, z1: 0, x2: 0, y2: 5, z2: 0, block: 'torch', volume: 1 },
    { x1: 0, y1: 2, z1: 0, x2: 0, y2: 2, z2: 0, block: 'stone', volume: 1 },
    { x1: 0, y1: 9, z1: 0, x2: 0, y2: 9, z2: 0, block: 'air', volume: 1 },
    { x1: 0, y1: 0, z1: 0, x2: 0, y2: 0, z2: 0, block: 'stone', volume: 1 },
  ];
  const ordered = orderBoxes(boxes).map((b) => b.block);
  assert.equal(ordered[0], 'air');
  assert.equal(ordered.at(-1), 'torch');
  assert.deepEqual(ordered.slice(1, 3), ['stone', 'stone']);
  assert.ok(ordered.indexOf('stone') < ordered.indexOf('torch'));
});

// ── Block states ──────────────────────────────────────────────────────────

test('parseBlock and formatBlock round-trip states', () => {
  const p = parseBlock('minecraft:oak_stairs[facing=east,half=bottom]');
  assert.equal(p.id, 'oak_stairs');
  assert.deepEqual(p.states, { facing: 'east', half: 'bottom' });
  assert.equal(formatBlock(p), 'oak_stairs[facing=east,half=bottom]');
});

test('rotateBlockSpec turns facings the right way', () => {
  assert.equal(rotateBlockSpec('oak_stairs[facing=north]', 90), 'oak_stairs[facing=east]');
  assert.equal(rotateBlockSpec('oak_stairs[facing=north]', 180), 'oak_stairs[facing=south]');
  assert.equal(rotateBlockSpec('oak_stairs[facing=north]', 270), 'oak_stairs[facing=west]');
  assert.equal(rotateBlockSpec('oak_stairs[facing=north]', 0), 'oak_stairs[facing=north]');
});

test('rotateBlockSpec swaps the pillar axis only on quarter turns', () => {
  assert.equal(rotateBlockSpec('oak_log[axis=x]', 90), 'oak_log[axis=z]');
  assert.equal(rotateBlockSpec('oak_log[axis=x]', 180), 'oak_log[axis=x]');
  assert.equal(rotateBlockSpec('oak_log[axis=y]', 90), 'oak_log[axis=y]');
});

test('mirrorBlockSpec flips across the requested plane only', () => {
  assert.equal(mirrorBlockSpec('oak_stairs[facing=east]', 'x'), 'oak_stairs[facing=west]');
  assert.equal(mirrorBlockSpec('oak_stairs[facing=north]', 'x'), 'oak_stairs[facing=north]');
  assert.equal(mirrorBlockSpec('oak_stairs[facing=north]', 'z'), 'oak_stairs[facing=south]');
});

test('withStates adds and overrides', () => {
  assert.equal(withStates('oak_stairs', { facing: 'north' }), 'oak_stairs[facing=north]');
  assert.equal(withStates('oak_stairs[facing=north]', { facing: 'south' }), 'oak_stairs[facing=south]');
});

test('normalizeBlock repairs the mistakes models actually make', () => {
  const cases: Array<[string, string]> = [
    ['stone_brick', 'stone_bricks'],
    ['spruce_stair', 'spruce_stairs'],
    ['minecraft:oak_planks', 'oak_planks'],
    ['wooden_door', 'oak_door'],
    ['grass', 'short_grass'],
    ['cobble', 'cobblestone'],
    ['glass_panes', 'glass_pane'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeBlock(input).spec, expected, `${input} -> ${expected}`);
  }
});

test('normalizeBlock leaves valid ids and their states alone', () => {
  const r = normalizeBlock('dark_oak_stairs[facing=west,half=bottom]');
  assert.equal(r.spec, 'dark_oak_stairs[facing=west,half=bottom]');
  assert.equal(r.fixed, false);
  assert.equal(r.known, true);
});

test('normalizeBlock flags genuinely unknown ids instead of guessing', () => {
  const r = normalizeBlock('unobtainium_block');
  assert.equal(r.known, false);
  assert.equal(r.spec, 'unobtainium_block');
});

// ── Geometry ──────────────────────────────────────────────────────────────

test('rotateY is a proper quarter turn', () => {
  assert.deepEqual(rotateY([1, 0, 0], 90), [0, 0, 1]);
  assert.deepEqual(rotateY([1, 0, 0], 180), [-1, 0, 0]);
  assert.deepEqual(rotateY([1, 0, 0], 270), [0, 0, -1]);
  assert.deepEqual(rotateY([3, 7, -2], 0), [3, 7, -2]);
});

test('rotateY four times is the identity', () => {
  let p: [number, number, number] = [5, 2, -3];
  for (let i = 0; i < 4; i++) p = rotateY(p, 90);
  assert.deepEqual(p, [5, 2, -3]);
});

test('line3 is continuous and hits both endpoints', () => {
  const pts = [...line3([0, 0, 0], [7, 3, -5])];
  assert.deepEqual(pts[0], [0, 0, 0]);
  assert.deepEqual(pts.at(-1), [7, 3, -5]);
  for (let i = 1; i < pts.length; i++) {
    const step = Math.max(
      Math.abs(pts[i][0] - pts[i - 1][0]),
      Math.abs(pts[i][1] - pts[i - 1][1]),
      Math.abs(pts[i][2] - pts[i - 1][2]),
    );
    assert.equal(step, 1, 'line must advance one block per step');
  }
});

// ── Noise ─────────────────────────────────────────────────────────────────

test('hash3 is deterministic and spreads over the range', () => {
  assert.equal(hash3(1, 2, 3, 42), hash3(1, 2, 3, 42));
  assert.notEqual(hash3(1, 2, 3, 42), hash3(1, 2, 4, 42));
  assert.notEqual(hash3(1, 2, 3, 42), hash3(1, 2, 3, 43));

  const buckets = new Array(10).fill(0);
  for (let x = 0; x < 40; x++)
    for (let z = 0; z < 40; z++) buckets[Math.floor(noise01(x, 0, z, 7) * 10)]++;
  for (const b of buckets) assert.ok(b > 100, `bucket too sparse: ${b}`);
});

test('weightedIndex respects the weights', () => {
  assert.equal(weightedIndex([1, 0, 0], 0.5), 0);
  assert.equal(weightedIndex([0, 1, 0], 0.5), 1);
  assert.equal(weightedIndex([1, 1], 0.75), 1);
  assert.equal(weightedIndex([1, 1], 0.25), 0);
});

// ── Palette ───────────────────────────────────────────────────────────────

test('palette resolves slot references and literal blocks', () => {
  const p = resolvePalette('medieval');
  assert.equal(p.at('stone', 0, 0, 0), 'stone');
  assert.ok(p.at('@wall', 0, 0, 0).length > 0);
  assert.equal(p.at('@nonexistent_slot', 0, 0, 0), p.at('@wall', 0, 0, 0));
});

test('palette mixes are deterministic and honour detail level', () => {
  const p = resolvePalette('medieval', undefined, 1234, undefined, 'high');
  const a = p.at('@wall', 5, 6, 7);
  const b = p.at('@wall', 5, 6, 7);
  assert.equal(a, b);

  const flat = resolvePalette('medieval', undefined, 1234, undefined, 'off');
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) seen.add(flat.at('@wall', i, 0, 0));
  assert.equal(seen.size, 1, 'detail "off" must collapse a mix to one block');
});

test('palette overrides win over the named style', () => {
  const p = resolvePalette('medieval', { wall: 'diamond_block' });
  assert.equal(p.at('@wall', 0, 0, 0), 'diamond_block');
});

test('styleForBiome maps biomes sensibly and always returns something', () => {
  assert.equal(styleForBiome('desert'), 'desert');
  assert.equal(styleForBiome('snowy_taiga'), 'viking');
  assert.equal(styleForBiome('minecraft:cherry_grove'), 'japanese');
  assert.equal(styleForBiome('bamboo_jungle'), 'tropical');
  assert.ok(styleForBiome('some_modded_biome').length > 0);
  assert.ok(styleForBiome(undefined).length > 0);
});

// ── Validation ────────────────────────────────────────────────────────────

test('validateBlueprint accepts a well-formed blueprint', () => {
  const bp: Blueprint = { name: 't', parts: [{ op: 'box', at: [0, 0, 0], size: [3, 3, 3], block: 'stone' }] };
  const r = validateBlueprint(bp);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('validateBlueprint reports the failing path and field', () => {
  const r = validateBlueprint({ parts: [{ op: 'box', at: [0, 0, 0] }] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path === '$.parts[0].size'), JSON.stringify(r.errors));
});

test('validateBlueprint rejects unknown ops and names the alternatives', () => {
  const r = validateBlueprint({ parts: [{ op: 'megastructure', at: [0, 0, 0] }] });
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /Unknown op/);
  assert.match(r.errors[0].message, /box/);
});

test('validateBlueprint recurses into group children', () => {
  const r = validateBlueprint({
    parts: [{ op: 'group', at: [0, 0, 0], of: [{ op: 'box', at: [0, 0, 0], size: 'big' }] }],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path.includes('of[0].size')));
});

test('validateBlueprint refuses absurd volumes before compiling', () => {
  const r = validateBlueprint({ parts: [{ op: 'box', at: [0, 0, 0], size: [500, 300, 500] }] }, 100_000);
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /limit/i);
});

test('estimateBlueprintVolume scales with repeat and symmetry', () => {
  const one = estimateBlueprintVolume({ parts: [{ op: 'box', at: [0, 0, 0], size: [2, 2, 2] }] });
  const four = estimateBlueprintVolume({
    parts: [{ op: 'repeat', count: 4, step: [3, 0, 0], of: [{ op: 'box', at: [0, 0, 0], size: [2, 2, 2] }] }],
  });
  assert.equal(four, one * 4);
});

// ── Compiler ──────────────────────────────────────────────────────────────

test('compile produces one fill for a plain cuboid', () => {
  const b = compile({ parts: [{ op: 'box', at: [0, 0, 0], size: [4, 4, 4], block: 'stone' }] }, { origin: [10, 64, -20] });
  assert.equal(b.commands.length, 1);
  assert.equal(b.commands[0], 'fill 10 64 -20 13 67 -17 stone');
  assert.equal(b.stats.voxels, 64);
});

test('compile emits setblock for a lone voxel', () => {
  const b = compile({ parts: [{ op: 'set', at: [0, 0, 0], block: 'torch' }] }, { origin: [1, 2, 3] });
  assert.equal(b.commands[0], 'setblock 1 2 3 torch');
});

test('compile applies the origin to every command', () => {
  const b = compile({ parts: [{ op: 'box', at: [5, 1, 5], size: [2, 1, 2], block: 'dirt' }] }, { origin: [100, 70, 200] });
  assert.equal(b.stats.bounds.min[0], 105);
  assert.equal(b.stats.bounds.min[1], 71);
  assert.equal(b.stats.bounds.min[2], 205);
});

test('later parts overwrite earlier ones, keep mode does not', () => {
  const replaced = compile({
    parts: [
      { op: 'box', at: [0, 0, 0], size: [2, 1, 1], block: 'stone' },
      { op: 'box', at: [0, 0, 0], size: [2, 1, 1], block: 'dirt' },
    ],
  });
  assert.equal(replaced.voxels.every((v) => v.block === 'dirt'), true);

  const kept = compile({
    parts: [
      { op: 'box', at: [0, 0, 0], size: [2, 1, 1], block: 'stone' },
      { op: 'box', at: [0, 0, 0], size: [2, 1, 1], block: 'dirt', mode: 'keep' },
    ],
  });
  assert.equal(kept.voxels.every((v) => v.block === 'stone'), true);
});

test('shell is hollow and walls have no floor or ceiling', () => {
  const sh = compile({ parts: [{ op: 'shell', at: [0, 0, 0], size: [5, 5, 5], block: 'stone' }] });
  assert.equal(sh.stats.voxels, 5 * 5 * 5 - 3 * 3 * 3);

  const wl = compile({ parts: [{ op: 'walls', at: [0, 0, 0], size: [5, 5, 5], block: 'stone' }] });
  // Four walls one thick: the full box minus the 3×5×3 interior column.
  assert.equal(wl.stats.voxels, 5 * 5 * 5 - 3 * 5 * 3);
  const hasFloorCentre = wl.voxels.some((v) => v.x === 2 && v.y === 0 && v.z === 2);
  assert.equal(hasFloorCentre, false, 'walls must not fill the floor');
});

test('group rotation moves geometry and turns block facings together', () => {
  const b = compile({
    parts: [{ op: 'group', rotate: 90, of: [{ op: 'set', at: [2, 0, 0], block: 'oak_stairs[facing=north]' }] }],
  });
  assert.equal(b.voxels.length, 1);
  assert.deepEqual([b.voxels[0].x, b.voxels[0].y, b.voxels[0].z], [0, 0, 2]);
  assert.match(b.voxels[0].block, /facing=east/);
});

test('nested group transforms compose in the right order', () => {
  const b = compile({
    parts: [{
      op: 'group', at: [10, 0, 0], rotate: 90,
      of: [{ op: 'group', at: [3, 0, 0], of: [{ op: 'set', at: [0, 0, 0], block: 'stone' }] }],
    }],
  });
  // Inner offset [3,0,0] rotated by 90° becomes [0,0,3], then translated by [10,0,0].
  assert.deepEqual([b.voxels[0].x, b.voxels[0].y, b.voxels[0].z], [10, 0, 3]);
});

test('symmetry mirrors about the requested plane', () => {
  const b = compile({
    parts: [{ op: 'symmetry', axis: 'x', about: 5, of: [{ op: 'set', at: [1, 0, 0], block: 'stone' }] }],
  });
  const xs = b.voxels.map((v) => v.x).sort((a, c) => a - c);
  assert.deepEqual(xs, [1, 9], 'mirror of x=1 about x=5 is x=9');
});

test('symmetry xz produces all four quadrants', () => {
  const b = compile({
    parts: [{ op: 'symmetry', axis: 'xz', about: 10, of: [{ op: 'set', at: [2, 0, 3], block: 'stone' }] }],
  });
  const pts = b.voxels.map((v) => `${v.x},${v.z}`).sort();
  assert.deepEqual(pts, ['18,17', '18,3', '2,17', '2,3'].sort());
});

test('repeat steps children without stacking them', () => {
  const b = compile({
    parts: [{ op: 'repeat', count: 4, step: [3, 0, 0], of: [{ op: 'set', at: [0, 0, 0], block: 'stone' }] }],
  });
  assert.deepEqual(b.voxels.map((v) => v.x).sort((a, c) => a - c), [0, 3, 6, 9]);
});

test('root rotation rotates the whole blueprint', () => {
  const b = compile({ parts: [{ op: 'set', at: [4, 0, 0], block: 'stone' }] }, { rotate: 180 });
  assert.deepEqual([b.voxels[0].x, b.voxels[0].z], [-4, 0]);
});

test('roof stairs face uphill toward the ridge', () => {
  const b = compile({
    parts: [{ op: 'roof', at: [0, 0, 0], size: [7, 1, 5], kind: 'gable', axis: 'z', pitch: 1, block: 'oak_planks', stairs: 'oak_stairs' }],
  });
  const stairs = b.voxels.filter((v) => v.block.includes('oak_stairs'));
  assert.ok(stairs.length > 0, 'a gable roof must place stairs');
  const west = stairs.filter((v) => v.x === 0);
  const east = stairs.filter((v) => v.x === 6);
  assert.ok(west.every((v) => v.block.includes('facing=east')), 'west slope rises east');
  assert.ok(east.every((v) => v.block.includes('facing=west')), 'east slope rises west');
});

test('a roof closes over its footprint', () => {
  const b = compile({
    parts: [{ op: 'roof', at: [0, 0, 0], size: [9, 1, 9], kind: 'hip', pitch: 1, block: 'stone', stairs: 'stone_stairs' }],
  });
  const covered = new Set<string>();
  for (const v of b.voxels) covered.add(`${v.x},${v.z}`);
  for (let x = 0; x < 9; x++)
    for (let z = 0; z < 9; z++) assert.ok(covered.has(`${x},${z}`), `roof gap at ${x},${z}`);
});

test('cylinder is round and hollow when asked', () => {
  const solid = compile({ parts: [{ op: 'cylinder', at: [0, 0, 0], r: 5, h: 1, block: 'stone' }] });
  const hollow = compile({ parts: [{ op: 'cylinder', at: [0, 0, 0], r: 5, h: 1, block: 'stone', hollow: true, thickness: 1 }] });
  assert.ok(hollow.stats.voxels < solid.stats.voxels / 2);
  // Corners of the bounding box must be outside the disc.
  const corner = solid.voxels.some((v) => v.x === 0 && v.z === 0);
  assert.equal(corner, false, 'a circle must not fill its bounding corners');
  // Area should be within 15 % of pi r^2.
  const expected = Math.PI * 5.5 * 5.5;
  assert.ok(Math.abs(solid.stats.voxels - expected) / expected < 0.15, `area ${solid.stats.voxels} vs ${expected}`);
});

test('sphere half dome keeps only the upper half', () => {
  const dome = compile({ parts: [{ op: 'sphere', at: [0, 0, 0], r: 6, block: 'stone', half: 'dome' }] });
  assert.ok(dome.voxels.every((v) => v.y >= 0), 'dome must not dip below its base');
});

test('scatter is deterministic for a given seed and varies across seeds', () => {
  const mk = (seed: number) => compile(
    { seed, parts: [{ op: 'scatter', at: [0, 0, 0], size: [20, 1, 20], density: 0.3, block: 'poppy' }] },
  ).stats.voxels;
  assert.equal(mk(1), mk(1));
  assert.notEqual(mk(1), mk(2));
});

test('compile never emits a fill over the vanilla volume limit', () => {
  const b = compile({ parts: [{ op: 'box', at: [0, 0, 0], size: [80, 60, 80], block: 'stone' }] });
  for (const box of b.boxes) assert.ok(box.volume <= MAX_FILL_VOLUME);
  const total = b.boxes.reduce((s, x) => s + x.volume, 0);
  assert.equal(total, 80 * 60 * 80);
});

test('compile records warnings instead of throwing on bad input', () => {
  const b = compile({ parts: [{ op: 'nonsense' } as never] });
  assert.equal(b.commands.length, 0);
  assert.ok(b.stats.warnings.some((w) => w.includes('nonsense')));
});

test('compile stays under its voxel budget and warns', () => {
  const b = compile({ parts: [{ op: 'box', at: [0, 0, 0], size: [100, 100, 100], block: 'stone' }] }, { limit: 5000 });
  assert.ok(b.stats.voxels <= 5000);
  assert.ok(b.stats.warnings.some((w) => /budget/i.test(w)));
});

test('foundation follows a sloped terrain sample', () => {
  const w = 8, d = 8;
  const heights: number[] = [];
  for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) heights.push(60 + x);
  const b = compile(
    { parts: [{ op: 'foundation', at: [0, 0, 0], size: [w, d], depth: 2, block: 'stone' }] },
    { origin: [0, 67, 0], terrain: { x1: 0, z1: 0, x2: w - 1, z2: d - 1, heights, min: 60, max: 67, avg: 63 } },
  );
  // The column above low ground must be filled up to the pad; nothing above it.
  const col = b.voxels.filter((v) => v.x === 0 && v.z === 0).map((v) => v.y).sort((a, c) => a - c);
  assert.equal(Math.max(...col), 67, 'foundation tops out at the pad level');
  assert.ok(Math.min(...col) <= 59, 'foundation reaches below the ground');
});

// ── Prefabs ───────────────────────────────────────────────────────────────

test('every prefab compiles without errors and produces geometry', () => {
  for (const { name } of listPrefabs()) {
    const bp = getPrefab(name);
    assert.ok(bp, `${name} must resolve`);
    const v = validateBlueprint(bp!);
    assert.equal(v.ok, true, `${name} invalid: ${JSON.stringify(v.errors)}`);
    const b = compile(bp!, { origin: [0, 64, 0] });
    assert.ok(b.stats.voxels > 50, `${name} produced only ${b.stats.voxels} blocks`);
    assert.ok(b.commands.length > 0);
    const bad = b.stats.warnings.filter((w) => /Unrecognised block/.test(w));
    assert.deepEqual(bad, [], `${name} uses unknown blocks: ${bad.join()}`);
  }
});

test('prefabs compress well: a castle stays under 2000 commands', () => {
  const b = compile(getPrefab('castle')!, { origin: [0, 64, 0] });
  assert.ok(b.stats.voxels > 10_000, `castle should be substantial, got ${b.stats.voxels}`);
  assert.ok(b.commands.length < 2000, `castle used ${b.commands.length} commands`);
  assert.ok(b.stats.ratio > 8, `compression ratio only ${b.stats.ratio}`);
});

test('prefab parameters actually change the build', () => {
  const small = compile(getPrefab('tower', { r: 3, h: 10 })!);
  const large = compile(getPrefab('tower', { r: 6, h: 30 })!);
  assert.ok(large.stats.voxels > small.stats.voxels * 2);
});

test('matchPrefab resolves plain-language and German names', () => {
  assert.equal(matchPrefab('build me a huge castle'), 'castle');
  assert.equal(matchPrefab('bau mir eine riesige Burg'), 'castle');
  assert.equal(matchPrefab('ein kleiner Turm bitte'), 'tower');
  assert.equal(matchPrefab('leuchtturm am strand'), 'lighthouse');
  assert.equal(matchPrefab('something entirely unrelated'), null);
});

// ── Rendering ─────────────────────────────────────────────────────────────

test('visibleVoxels removes fully enclosed blocks', () => {
  const b = compile({ parts: [{ op: 'box', at: [0, 0, 0], size: [10, 10, 10], block: 'stone' }] });
  const visible = visibleVoxels(b.voxels);
  assert.ok(visible.length < b.voxels.length / 2, `culled ${visible.length} of ${b.voxels.length}`);
  assert.ok(visible.length > 0);
});

test('renderIsoSvg produces valid standalone SVG', () => {
  const b = compile(getPrefab('cottage')!, { origin: [0, 64, 0] });
  const svg = renderIsoSvg(b, { scale: 4 });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<\/svg>$/);
  assert.ok(!svg.includes('undefined'), 'no undefined values in output');
  assert.ok(!svg.includes('NaN'), 'no NaN coordinates in output');
});

test('renderAsciiTop draws something for a real build', () => {
  const b = compile(getPrefab('castle')!, { origin: [0, 64, 0] });
  const art = renderAsciiTop(b, 60);
  assert.ok(art.split('\n').length > 5);
  assert.ok(/[#%@*+=]/.test(art));
});
