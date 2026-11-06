// Viewer mesher / lighting / raycast (engine/src/viewer/js — plain browser ES modules, DOM-free).
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore — plain JS module shared with the browser
import { VoxelWorld, GeoTable, fallbackGeometry, QUAD_STRIDE as CLIENT_STRIDE, G_OCCLUDES } from '../../src/viewer/js/voxels.js';
// @ts-ignore
import { meshSection, raycast } from '../../src/viewer/js/mesher.js';
// @ts-ignore
import { computeLight } from '../../src/viewer/js/lighting.js';
// @ts-ignore
import { MeshCore } from '../../src/viewer/js/meshcore.js';
import { compactGeometry, QUAD_STRIDE, type AtlasLookup } from '../../src/server/viewer-assets.ts';
import { cuboid } from '../../src/assets/geometry.ts';
import type { BlockGeometry } from '../../src/assets/geometry.ts';

const STONE = 1, GLASS = 2, WATER = 3, TORCH = 4;

function table(): any {
  const g = new GeoTable();
  g.set(STONE, 'minecraft:stone', fallbackGeometry('minecraft:stone'));
  g.set(GLASS, 'minecraft:glass', fallbackGeometry('minecraft:glass'));
  g.set(WATER, 'minecraft:water[level=0]', fallbackGeometry('minecraft:water[level=0]'));
  g.set(TORCH, 'minecraft:torch', fallbackGeometry('minecraft:torch'));
  return g;
}

function world(size = 4): any {
  return new VoxelWorld({ min: [0, 0, 0], max: [size - 1, size - 1, size - 1] });
}

const quadsOf = (m: any) => ({
  o: m.opaque ? m.opaque.count / 4 : 0,
  c: m.cutout ? m.cutout.count / 4 : 0,
  t: m.translucent ? m.translucent.count / 4 : 0,
});

test('client and server agree on the quad stride', () => {
  assert.equal(CLIENT_STRIDE, QUAD_STRIDE);
});

test('a single cube has 6 faces, two adjacent cubes 10, a 3×3×3 block only its shell', () => {
  const geo = table();
  const w = world();
  w.set(1, 1, 1, STONE);
  computeLight(w, geo);
  let m = meshSection(w, geo, 0, 0, 0);
  assert.deepEqual(quadsOf(m), { o: 6, c: 0, t: 0 });
  assert.equal(m.opaque.index.length, 36);
  w.set(2, 1, 1, STONE);
  m = meshSection(w, geo, 0, 0, 0);
  assert.equal(quadsOf(m).o, 10);
  const w3 = world(5);
  for (let y = 1; y <= 3; y++) for (let z = 1; z <= 3; z++) for (let x = 1; x <= 3; x++) w3.set(x, y, z, STONE);
  computeLight(w3, geo);
  assert.equal(quadsOf(meshSection(w3, geo, 0, 0, 0)).o, 54);
});

test('glass self-culls against glass but not against stone; stone is drawn behind glass', () => {
  const geo = table();
  const w = world();
  w.set(1, 1, 1, GLASS);
  w.set(2, 1, 1, GLASS);
  w.set(1, 2, 1, STONE);
  computeLight(w, geo);
  const q = quadsOf(meshSection(w, geo, 0, 0, 0));
  // 2 glass: 12 - 2 shared - 1 under the stone (stone occludes) = 9; stone: 6 (glass does not occlude)
  assert.equal(q.t, 9);
  assert.equal(q.o, 6);
});

test('cut-away view treats blocks above the cut as air (top faces appear)', () => {
  const geo = table();
  const w = world();
  for (let y = 0; y < 3; y++) w.set(1, y, 1, STONE);
  computeLight(w, geo);
  assert.equal(quadsOf(meshSection(w, geo, 0, 0, 0)).o, 14);
  const m = meshSection(w, geo, 0, 0, 0, { cutY: 1 });
  assert.equal(quadsOf(m).o, 10);
  // the highest vertex is now y = 2 (top of the block at y = 1)
  let maxY = 0;
  for (let i = 1; i < m.opaque.position.length; i += 3) maxY = Math.max(maxY, m.opaque.position[i]);
  assert.equal(maxY, 2);
});

test('ambient occlusion darkens a floor next to a wall', () => {
  const geo = table();
  const w = world(6);
  for (let z = 0; z < 6; z++) for (let x = 0; x < 6; x++) w.set(x, 0, z, STONE);
  w.set(2, 1, 2, STONE);
  computeLight(w, geo);
  const m = meshSection(w, geo, 0, 0, 0);
  const col = m.opaque.color, pos = m.opaque.position, nrm = m.opaque.normal;
  let dark = 0, bright = 0, max = 0;
  for (let v = 0; v < m.opaque.count; v++) if (nrm[v * 3 + 1] === 127 && pos[v * 3 + 1] === 1) max = Math.max(max, col[v * 4]);
  for (let v = 0; v < m.opaque.count; v++) {
    if (nrm[v * 3 + 1] !== 127 || pos[v * 3 + 1] !== 1) continue; // floor top vertices
    if (col[v * 4] < max) dark++;
    else bright++;
  }
  assert.ok(dark >= 8, `expected darkened vertices around the pillar, got ${dark}`);
  assert.ok(bright > dark);
});

test('sky light is blocked by a roof and block light spreads from a torch', () => {
  const geo = table();
  const w = world(9);
  for (let z = 0; z < 9; z++) for (let x = 0; x < 9; x++) w.set(x, 6, z, STONE); // roof
  computeLight(w, geo);
  assert.equal(w.sky[w.idx(4, 7, 4)], 15);
  assert.ok(w.sky[w.idx(4, 3, 4)] < 15, 'under the roof is darker');
  assert.equal(w.blk[w.idx(4, 3, 4)], 0);
  w.set(4, 2, 4, TORCH);
  const changed = computeLight(w, geo, { min: [0, 0, 0], max: [8, 8, 8] }, true);
  assert.equal(w.blk[w.idx(4, 2, 4)], 14);
  assert.equal(w.blk[w.idx(5, 2, 4)], 13);
  assert.ok(changed.size > 10);
});

test('a local relight (change ± 15) matches a full relight', () => {
  const geo = table();
  const w = new VoxelWorld({ min: [0, 0, 0], max: [47, 11, 47] });
  for (let z = 0; z < 48; z++) for (let x = 0; x < 48; x++) {
    w.set(x, 0, z, STONE);
    if (x > 10 && x < 30 && z > 10 && z < 30) w.set(x, 8, z, STONE); // roof
  }
  w.set(20, 1, 20, TORCH);
  computeLight(w, geo);
  // add a torch, remove the old one, punch a hole in the roof
  w.set(14, 2, 14, TORCH);
  w.set(20, 1, 20, 0);
  w.set(15, 8, 15, 0);
  const changed = computeLight(w, geo, { min: [14 - 15, 0, 14 - 15], max: [20 + 15, 11, 20 + 15] }, true);
  const sky = w.sky.slice(), blk = w.blk.slice();
  computeLight(w, geo);
  assert.ok(changed.size > 50);
  assert.deepEqual(Array.from(blk), Array.from(w.blk));
  assert.deepEqual(Array.from(sky), Array.from(w.sky));
});

test('water: source block surface sits at 8/9, faces against water are culled', () => {
  const geo = table();
  const w = world();
  w.set(1, 1, 1, WATER);
  w.set(2, 1, 1, WATER);
  computeLight(w, geo);
  const m = meshSection(w, geo, 0, 0, 0);
  assert.equal(quadsOf(m).t, 10);
  let maxY = 0;
  for (let i = 1; i < m.translucent.position.length; i += 3) maxY = Math.max(maxY, m.translucent.position[i]);
  assert.ok(Math.abs(maxY - (1 + 8 / 9)) < 2e-3, `surface at ${maxY}`);
});

test('pop-in birth times are written per vertex', () => {
  const geo = table();
  const w = world();
  w.set(1, 1, 1, STONE);
  computeLight(w, geo);
  const target = w.idx(1, 1, 1);
  const m = meshSection(w, geo, 0, 0, 0, { bornAt: (i: number) => (i === target ? 12.5 : -1e6) });
  assert.ok(Array.from(m.opaque.born as Float32Array).every((b) => b === 12.5));
});

test('raycast hits the top face of the first solid block (and respects the cut)', () => {
  const geo = table();
  const w = world(8);
  for (let y = 0; y < 4; y++) w.set(3, y, 3, STONE);
  let hit = raycast(w, geo, [3.5, 20, 3.5], [0, -1, 0]);
  assert.deepEqual(hit.pos, [3, 3, 3]);
  assert.deepEqual(hit.normal, [0, 1, 0]);
  hit = raycast(w, geo, [3.5, 20, 3.5], [0, -1, 0], 100, { cutY: 1 });
  assert.deepEqual(hit.pos, [3, 1, 3]);
  hit = raycast(w, geo, [-10, 2.5, 3.5], [1, 0, 0]);
  assert.deepEqual(hit.pos, [3, 2, 3]);
  assert.deepEqual(hit.normal, [-1, 0, 0]);
  assert.equal(raycast(w, geo, [-10, 2.5, 0.5], [1, 0, 0]), null);
});

test('server-compacted textured geometry: quads, atlas uvs, CCW winding', () => {
  const atlas: AtlasLookup = {
    width: 64, height: 32,
    rect: (n: string) => (n === 'block/a' ? { x: 16, y: 0, w: 16, h: 16, flags: 0 } : n === 'block/leaf' ? { x: 32, y: 16, w: 16, h: 16, flags: 1 } : null),
  };
  const faces: any = {};
  for (const d of ['down', 'up', 'north', 'south', 'west', 'east']) faces[d] = { texture: 'block/a', cullface: d };
  const g: BlockGeometry = {
    state: 'minecraft:test', cuboids: [cuboid([0, 0, 0], [16, 16, 16], faces)], ao: true, layer: 'cutout', fluid: null, fluidLevel: 0,
    fullCube: true, emission: 0, tint: null, tintKind: null, synthetic: false, flat: false, color: [1, 2, 3, 255], invisible: false,
  };
  const cg = compactGeometry(g, atlas);
  assert.equal(cg.q.length, 6 * QUAD_STRIDE);
  assert.ok(cg.f & G_OCCLUDES);
  for (let o = 0; o < cg.q.length; o += QUAD_STRIDE) {
    const n = [cg.q[o + 4]!, cg.q[o + 5]!, cg.q[o + 6]!];
    const P = [0, 1, 2].map((k) => [cg.q[o + 8 + k * 5]!, cg.q[o + 9 + k * 5]!, cg.q[o + 10 + k * 5]!]);
    const u = P[1]!.map((v, i) => v - P[0]![i]!), v = P[2]!.map((x, i) => x - P[0]![i]!);
    const c = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    assert.ok(c[0]! * n[0]! + c[1]! * n[1]! + c[2]! * n[2]! > 0, 'counter-clockwise seen from outside');
    for (let k = 0; k < 4; k++) {
      const uu = cg.q[o + 11 + k * 5]!, vv = cg.q[o + 12 + k * 5]!;
      assert.ok(uu > 0.25 && uu < 0.5 && vv > 0 && vv < 0.5, `uv inside the atlas rect (${uu},${vv})`);
    }
  }
  // client meshes the server format
  const geo = new GeoTable();
  geo.set(1, 'minecraft:test', cg);
  const leafFaces: any = {};
  for (const d of ['down', 'up', 'north', 'south', 'west', 'east']) leafFaces[d] = { texture: 'block/leaf', cullface: d, tint: 0 };
  const leaf = compactGeometry({ ...g, state: 'minecraft:oak_leaves', cuboids: [cuboid([0, 0, 0], [16, 16, 16], leafFaces)], fullCube: false, tint: [0, 128, 0], tintKind: 'foliage' }, atlas);
  geo.set(2, 'minecraft:oak_leaves', leaf);
  const w = new VoxelWorld({ min: [0, 0, 0], max: [3, 3, 3] });
  w.set(1, 1, 1, 1);
  w.set(2, 1, 1, 2);
  w.set(2, 2, 1, 2);
  computeLight(w, geo);
  const m = meshSection(w, geo, 0, 0, 0, { tintAt: () => [0.1, 0.5, 0.1] });
  // block: 5 faces (east face hidden? no — leaves don't occlude) = 6; leaves: 12 - 2 (self-cull) = 10, one faces the block (block occludes) = 9
  assert.equal(m.opaque.count / 4, 6);
  assert.equal(m.cutout.count / 4, 9);
  assert.ok(m.cutout.color[1] > m.cutout.color[0], 'foliage tint applied');
});

test('performance: a 128×96×128 terrain meshes in a couple of seconds', () => {
  const geo = table();
  geo.set(5, 'minecraft:oak_leaves', fallbackGeometry('minecraft:glass')); // see-through, self-culling
  const core = new MeshCore(() => {});
  core.geo = geo;
  const box = { min: [-64, 0, -64], max: [63, 95, 63] };
  const sx = 128, sy = 96, sz = 128;
  const data = new Uint16Array(sx * sy * sz);
  for (let z = 0; z < sz; z++)
    for (let x = 0; x < sx; x++) {
      const h = 40 + Math.round(8 * Math.sin(x / 9) * Math.cos(z / 11) + 4 * Math.sin((x + z) / 5));
      for (let y = 0; y <= h; y++) data[y * sx * sz + z * sx + x] = STONE;
      if (h < 38) for (let y = h + 1; y <= 38; y++) data[y * sx * sz + z * sx + x] = WATER;
      if ((x * 31 + z * 17) % 97 === 0) for (let y = h + 1; y <= h + 6; y++) data[y * sx * sz + z * sx + x] = 5;
    }
  const t0 = performance.now();
  core.handle({ t: 'volume', box, data, center: [0, 40, 0] });
  while (core.dirty.size) core.process(1e9);
  const ms = performance.now() - t0;
  const st = core.stats();
  assert.equal(st.sections, 8 * 6 * 8);
  assert.ok(st.quads > 16384, `${st.quads} quads`);
  assert.ok(ms < 6000, `meshing took ${ms.toFixed(0)} ms`);
});
