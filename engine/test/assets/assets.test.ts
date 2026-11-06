import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { AssetStore } from '../../src/assets/assets.ts';
import { JarSource } from '../../src/assets/sources.ts';
import { ZipReader } from '../../src/assets/zip.ts';
import { matchWhen, selectModels } from '../../src/assets/models.ts';
import { matVec } from '../../src/assets/geometry.ts';

/** minimal zip writer (stored + deflate) for synthetic client jars */
function makeZip(files: Record<string, Buffer | string>): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const deflate = raw.length > 64;
    const data = deflate ? deflateRawSync(raw) : raw;
    const nb = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, data);
    central.push(ch, nb);
    off += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

function solidPng(r: number, g: number, b: number, h = 16): Buffer {
  const p = new PNG({ width: 16, height: h });
  for (let i = 0; i < 16 * h; i++) p.data.set([r, g, b, 255], i * 4);
  return PNG.sync.write(p);
}

function fakeJar(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcai-jar-'));
  const p = join(dir, 'client.jar');
  writeFileSync(p, makeZip({
    'assets/minecraft/blockstates/stone.json': JSON.stringify({ variants: { '': { model: 'minecraft:block/stone' } } }),
    'assets/minecraft/blockstates/oak_stairs.json': JSON.stringify({ variants: {
      'facing=east': { model: 'minecraft:block/step' }, 'facing=south': { model: 'minecraft:block/step', y: 90, uvlock: true } } }),
    'assets/minecraft/models/block/cube_all.json': JSON.stringify({ elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: Object.fromEntries(
      ['down', 'up', 'north', 'south', 'west', 'east'].map((d) => [d, { texture: '#all', cullface: d }])) }] }),
    'assets/minecraft/models/block/stone.json': JSON.stringify({ parent: 'block/cube_all', textures: { all: 'block/stone' } }),
    'assets/minecraft/models/block/step.json': JSON.stringify({ textures: { t: 'block/stone' }, elements: [
      { from: [0, 0, 0], to: [16, 8, 16], faces: { up: { texture: '#t' }, down: { texture: '#t' } } },
      { from: [8, 8, 0], to: [16, 16, 16], faces: { up: { texture: '#t' }, east: { texture: '#t', cullface: 'east' } } }] }),
    'assets/minecraft/textures/block/stone.png': solidPng(200, 30, 30, 32), // animated strip: frame 0 used
  }));
  return p;
}

test('zip reader reads stored and deflated entries', () => {
  const z = new ZipReader(makeZip({ 'a.txt': 'hello', 'b.txt': 'x'.repeat(1000) }));
  assert.equal(z.read('a.txt')!.toString(), 'hello');
  assert.equal(z.read('b.txt')!.toString(), 'x'.repeat(1000));
  assert.equal(z.read('missing'), undefined);
});

test('jar source: models, parents, texture variables, frame 0, model rotation', () => {
  const store = new AssetStore(new JarSource(fakeJar()));
  const g = store.geometry('minecraft:stone');
  assert.equal(g.cuboids.length, 1);
  assert.equal(g.cuboids[0].faces.up!.texture, 'block/stone');
  assert.ok(g.fullCube);
  const c = store.averageColor('minecraft:stone');
  assert.deepEqual(c.slice(0, 3), [200, 30, 30]);
  const a = store.atlasData();
  const i = a.index.get('block/stone')!;
  assert.equal(a.rects[i * 4 + 3], 16, 'animated strip cropped to frame 0');
  // y=90 rotates the upper half (x 8..16, east side) to the south side (z 8..16)
  const s = store.geometry('minecraft:oak_stairs[facing=south,half=bottom,shape=straight,waterlogged=false]');
  const top = s.cuboids[1];
  const p0 = matVec(top.m, top.from).map((v, k) => v + top.t[k]), p1 = matVec(top.m, top.to).map((v, k) => v + top.t[k]);
  assert.deepEqual([Math.min(p0[2], p1[2]), Math.max(p0[2], p1[2])].map(Math.round), [8, 16]);
  assert.deepEqual([Math.min(p0[0], p1[0]), Math.max(p0[0], p1[0])].map(Math.round), [0, 16]);
  assert.equal(top.faces.east!.cullface, 'south', 'cullface rotated with the model');
  assert.ok(top.faces.up!.uvlock);
});

test('variant and multipart selection with OR/AND conditions', () => {
  const def = { multipart: [
    { apply: { model: 'post' } },
    { when: { north: 'true' }, apply: { model: 'n' } },
    { when: { OR: [{ east: 'true' }, { west: 'low|tall' }] }, apply: [{ model: 'ew' }, { model: 'ew2' }] },
    { when: { AND: [{ up: 'true' }, { north: 'false' }] }, apply: { model: 'up' } },
  ] };
  const names = (p: Record<string, string>) => selectModels(def, p).map((m) => m.model);
  assert.deepEqual(names({ north: 'true', east: 'false', west: 'none', up: 'true' }), ['post', 'n']);
  assert.deepEqual(names({ north: 'false', east: 'false', west: 'tall', up: 'true' }), ['post', 'ew', 'up']);
  assert.ok(matchWhen({ facing: 'east|west' }, { facing: 'west' }));
  assert.ok(!matchWhen({ facing: 'east|west' }, { facing: 'north' }));
  const v = { variants: { 'facing=east,half=top': { model: 'a', y: 90 }, '': { model: 'b' } } };
  assert.deepEqual(selectModels(v, { facing: 'east', half: 'top' })[0], { model: 'a', x: 0, y: 90, uvlock: false });
  assert.equal(selectModels(v, { facing: 'north', half: 'top' })[0].model, 'b');
});

// ---- tests against the real (cached / downloaded) 26.3 assets; skipped when unavailable
const real = await AssetStore.tryOpen();

test('real assets: core geometry, tints, fluids, block entities', { skip: !real && 'assets unavailable (offline)' }, () => {
  const s = real!;
  const stone = s.geometry('minecraft:stone');
  assert.ok(stone.fullCube && stone.cuboids.length === 1);
  const grass = s.geometry('minecraft:grass_block[snowy=false]');
  assert.equal(grass.tintKind, 'grass');
  assert.ok(grass.tint && grass.tint[1] > grass.tint[0]);
  // explicit BlockColors table: cherry/azalea/pale oak leaves are NOT tinted
  for (const id of ['cherry_leaves', 'azalea_leaves', 'flowering_azalea_leaves', 'pale_oak_leaves']) {
    const g = s.geometry(`minecraft:${id}[distance=7,persistent=true,waterlogged=false]`);
    assert.equal(g.tint, null, id);
  }
  const cherry = s.averageColor('minecraft:cherry_leaves[distance=7,persistent=true,waterlogged=false]');
  assert.ok(cherry[0] > cherry[1] + 20, `cherry leaves should be pink, got ${cherry}`);
  assert.equal(s.geometry('minecraft:oak_leaves[distance=7,persistent=true,waterlogged=false]').tintKind, 'foliage');
  assert.deepEqual(s.geometry('minecraft:birch_leaves[distance=7,persistent=true,waterlogged=false]').tint, [0x80, 0xa7, 0x55]);
  const red = s.averageColor('minecraft:red_wool');
  assert.ok(red[0] > 120 && red[1] < 80 && red[2] < 80, `red wool ${red}`);
  const water = s.geometry('minecraft:water[level=0]');
  assert.equal(water.fluid, 'water');
  assert.equal(water.layer, 'translucent');
  assert.equal(s.geometry('minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=true]').fluid, 'water');
  for (const st of ['minecraft:chest[facing=east,type=single,waterlogged=false]', 'minecraft:red_shulker_box[facing=up]',
    'minecraft:white_banner[rotation=4]', 'minecraft:skeleton_skull[powered=false,rotation=0]', 'minecraft:decorated_pot[cracked=false,facing=north,waterlogged=false]']) {
    const g = s.geometry(st);
    assert.ok(g.synthetic && g.cuboids.length > 0, st);
    for (const c of g.cuboids) for (const f of Object.values(c.faces)) assert.ok(s.atlasData().index.has(f!.texture), `${st}: ${f!.texture} in atlas`);
  }
  assert.ok(s.geometry('minecraft:barrier').invisible);
  assert.ok(s.geometry('minecraft:torch').emission >= 14);
  const poppy = s.geometry('minecraft:poppy');
  assert.ok(poppy.cuboids.length === 2 && !poppy.cuboids[0].identity, 'cross model with rotated elements');
  const at = s.textureAtlas();
  const uv = at.uv('block/stone');
  assert.ok(uv[2] > uv[0] && uv[3] > uv[1] && uv[2] <= 1);
  assert.ok(at.png.length > 1000);
});
