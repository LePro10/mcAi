import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimBackend, offlineUuid } from '../../src/sim/sim-backend.ts';
import { Registry } from '../../src/core/registry.ts';
import type { EditBatch } from '../../src/core/types.ts';

const reg = Registry.loadDefault();
const batch = (entries: [number, number, number, string][]): EditBatch => {
  const palette: string[] = [];
  const states = new Uint16Array(entries.length);
  const positions = new Int32Array(entries.length * 3);
  entries.forEach(([x, y, z, s], i) => {
    let j = palette.indexOf(s);
    if (j < 0) { j = palette.length; palette.push(s); }
    states[i] = j;
    positions.set([x, y, z], i * 3);
  });
  return { palette, positions, states };
};

test('deterministic terrain, canonical states, info', async () => {
  const a = new SimBackend({ seed: 42 }), b = new SimBackend({ seed: 42 }), c = new SimBackend({ seed: 43 });
  const box = { min: [-40, 40, -40] as [number, number, number], max: [40, 100, 40] as [number, number, number] };
  const va = await a.getBlocks(box), vb = await b.getBlocks(box), vc = await c.getBlocks(box);
  const flat = (v: typeof va) => Array.from(v.data, (i) => v.palette[i]).join('|');
  assert.equal(flat(va), flat(vb));
  assert.notEqual(flat(va), flat(vc));
  for (const s of va.palette) {
    const r = reg.tryCanonical(s);
    assert.ok(r.ok && r.state === s, `generator emits canonical states: ${s}`);
  }
  assert.ok(va.palette.some((s) => s.startsWith('minecraft:grass_block')));
  const info = await a.info();
  assert.deepEqual([info.minY, info.maxY, info.seaLevel, info.mcVersion], [-64, 319, 63, '26.3']);
  assert.equal((await a.getBlocks({ min: [0, -64, 0], max: [0, -64, 0] })).palette[1], 'minecraft:bedrock');
});

test('getBlocks layout (x fastest, then z, then y) matches point reads', async () => {
  const s = new SimBackend({ seed: 5 });
  const box = { min: [-7, 55, 3] as [number, number, number], max: [20, 80, 33] as [number, number, number] };
  const v = await s.getBlocks(box);
  const sx = 28, sz = 31;
  for (const [x, y, z] of [[-7, 55, 3], [20, 80, 33], [0, 64, 16], [15, 70, 17], [16, 63, 30]]) {
    const i = (y - 55) * sx * sz + (z - 3) * sx + (x + 7);
    assert.equal(v.palette[v.data[i]], s.world.get(x, y, z));
  }
  const above = await s.getBlocks({ min: [0, 318, 0], max: [1, 330, 1] });
  assert.ok(above.data.every((i) => i === 0), 'air above the build limit');
});

test('setBlocks: previous states, unchanged, failures, events, undo', async () => {
  const s = new SimBackend({ seed: 1 });
  const events: EditBatch[] = [];
  s.on('blocks', (b: EditBatch) => events.push(b));
  const y = 200;
  const r = await s.setBlocks(batch([[0, y, 0, 'stone'], [1, y, 0, 'minecraft:oak_planks'], [2, y, 0, 'stone[bogus=1]'], [3, y, 0, 'nope_block'], [4, 400, 0, 'stone']]));
  assert.equal(r.placed, 2);
  assert.deepEqual(r.failed.map((f) => f.index), [2, 3, 4]);
  assert.match(r.failed[0].reason, /propert/i);
  assert.equal(r.previous.positions.length, 15);
  assert.equal(r.previous.palette[r.previous.states[0]], 'minecraft:air');
  assert.equal(s.world.get(0, y, 0), 'minecraft:stone');
  assert.equal(events.length, 1);
  const again = await s.setBlocks(batch([[0, y, 0, 'stone']]));
  assert.equal(again.unchanged, 1);
  await s.setBlocks(r.previous); // undo
  assert.equal(s.world.get(0, y, 0), 'minecraft:air');
  // shape updates: neighbouring fences connect
  await s.setBlocks(batch([[10, y, 10, 'oak_fence'], [11, y, 10, 'oak_fence']]));
  assert.match(s.world.get(10, y, 10), /east=true/);
  await s.setBlocks(batch([[20, y, 10, 'oak_fence'], [21, y, 10, 'oak_fence']]), { updateShapes: false });
  assert.match(s.world.get(20, y, 10), /east=false/);
});

test('heightmaps, biomes, players, entities, commands, notify', async () => {
  const s = new SimBackend({ seed: 7 });
  const [p] = await s.players();
  assert.equal(p.name, 'Steve');
  assert.equal(p.uuid, offlineUuid('Steve'));
  const hm = await s.heightmap(Math.floor(p.pos[0]), Math.floor(p.pos[2]), Math.floor(p.pos[0]), Math.floor(p.pos[2]));
  assert.equal(hm.data[0], Math.floor(p.pos[1]) - 1, 'Steve stands on the surface');
  // find water somewhere and check ocean_floor < surface
  let found = false;
  for (let x = -600; x < 600 && !found; x += 16) {
    const c = s.world.gen.column(x, 0);
    if (c.h < 60) {
      const sf = await s.heightmap(x, 0, x, 0, 'surface'), of = await s.heightmap(x, 0, x, 0, 'ocean_floor');
      assert.ok(of.data[0] < sf.data[0], 'ocean floor below the water surface');
      found = true;
    }
  }
  const b = await s.biomes({ min: [-256, 64, -256], max: [255, 64, 255] }, 16);
  assert.equal(b.data.length, 32 * 32);
  assert.ok(b.palette.every((n) => n.startsWith('minecraft:')));
  assert.equal((await s.runCommand('fillbiome 0 60 0 3 70 3 minecraft:desert')).ok, true);
  assert.equal((await s.biomes({ min: [1, 64, 1], max: [1, 64, 1] }, 1)).palette[0], 'minecraft:desert');

  const cmds: unknown[] = [];
  s.on('command', (c: unknown) => cmds.push(c));
  assert.equal((await s.runCommand('/time set night')).ok, true);
  assert.equal(s.state.time, 13000);
  assert.equal((await s.runCommand('weather rain')).ok, true);
  const sum = await s.runCommand('summon minecraft:armor_stand ~1 ~ ~ {CustomName:\'"Guide"\'}', { as: 'Steve' });
  assert.ok(sum.ok);
  const ents = await s.entities({ min: [-1000, -64, -1000], max: [1000, 319, 1000] });
  assert.equal(ents.length, 1);
  assert.equal(ents[0].name, 'Guide');
  assert.ok(Math.abs(ents[0].pos[0] - (p.pos[0] + 1)) < 1e-9);
  assert.ok((await s.runCommand('setblock 0 250 0 gold_block')).ok);
  assert.equal(s.world.get(0, 250, 0), 'minecraft:gold_block');
  assert.ok((await s.runCommand('fill 0 250 0 2 252 2 glass hollow')).ok);
  assert.equal(s.world.get(1, 251, 1), 'minecraft:air');
  assert.ok((await s.runCommand('particle minecraft:flame 0 0 0')).ok);
  const bad = await s.runCommand('op Steve');
  assert.equal(bad.ok, false);
  assert.match(bad.output, /Unsupported/);
  assert.equal((await s.runCommand('setblock 0 250 0 not_a_block')).ok, false);
  assert.equal(cmds.length, 8);
  const notes: unknown[] = [];
  s.on('notify', (n: unknown) => notes.push(n));
  await s.notify({ target: '@a', kind: 'chat', text: 'hi' });
  assert.equal(notes.length, 1);
  await assert.rejects(s.getBlocks({ min: [0, 0, 0], max: [1, 1, 1] }, 'minecraft:the_nether'));
});

test('persistence: save and load modified sections + state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcai-sim-'));
  const a = new SimBackend({ seed: 9, persistDir: dir });
  await a.setBlocks(batch([[5, 120, 5, 'diamond_block'], [-30, 70, 44, 'oak_stairs[facing=east]'], [5, 60, 5, 'air']]));
  await a.runCommand('summon pig 1 2 3');
  await a.runCommand('time set 5000');
  await a.save();
  const b = new SimBackend({ seed: 9, persistDir: dir });
  assert.equal(b.world.get(5, 120, 5), 'minecraft:diamond_block');
  assert.equal(b.world.get(-30, 70, 44), reg.canonical('oak_stairs[facing=east]'));
  assert.equal(b.world.get(5, 60, 5), 'minecraft:air');
  assert.equal(b.state.time, 5000);
  assert.equal(b.state.entities.length, 1);
  assert.equal((await b.players())[0].name, 'Steve');
  // untouched terrain still identical
  assert.equal(b.world.get(100, 50, 100), a.world.get(100, 50, 100));
});

test('performance: 1M setBlocks and 128³ getBlocks', async () => {
  const s = new SimBackend({ seed: 3 });
  const N = 100;
  const positions = new Int32Array(N * N * N * 3), states = new Uint16Array(N * N * N);
  let i = 0;
  for (let y = 0; y < N; y++) for (let z = 0; z < N; z++) for (let x = 0; x < N; x++, i++) {
    positions[i * 3] = x; positions[i * 3 + 1] = 70 + y; positions[i * 3 + 2] = z;
    states[i] = (x + y + z) % 3;
  }
  let t = performance.now();
  const r = await s.setBlocks({ palette: ['stone', 'oak_planks', 'glass'], positions, states });
  const tSet = performance.now() - t;
  assert.equal(r.placed + r.unchanged, 1_000_000);
  t = performance.now();
  await s.getBlocks({ min: [-64, 0, -64], max: [63, 127, 63] });
  const tGet = performance.now() - t;
  console.log(`# sim perf: setBlocks 1M ${tSet.toFixed(0)} ms, getBlocks 128^3 ${tGet.toFixed(0)} ms`);
  // targets are 1.5 s / 1 s on an idle machine; generous bounds for loaded CI runners
  assert.ok(tSet < 6000, `setBlocks took ${tSet} ms`);
  assert.ok(tGet < 4000, `getBlocks took ${tGet} ms`);
});
