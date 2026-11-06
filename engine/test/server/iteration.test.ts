// Tool-level tests for the builder-feedback iteration: fluids-safe clearing, tree modes, support
// physics, floating/dark scans, summon checks, skipInvalid, retaining walls, bridges, script
// generators and groundY. Job faces north at anchor [0,64,0] → local = world − anchor.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { tmpHome, testConfig, MemBackend, FakeRunner } from './helpers.ts';
import { Hub } from '../../src/server/hub.ts';
import type { Job } from '../../src/agent/jobs.ts';
import { Registry } from '../../src/core/registry.ts';

tmpHome();
process.env.MCAI_NO_ASSETS = '1';

let hub: Hub;
let mem: MemBackend;
let job: Job;
let client: Client;
const reg = Registry.loadDefault();
const C = (s: string) => reg.canonical(s);
const W = (x: number, y: number, z: number): [number, number, number] => [x, 64 + y, z];

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
  return { ...r, text: r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') };
}
const put = (x: number, y: number, z: number, s: string) => mem.edits.set(...W(x, y, z), C(s));
const at = (x: number, y: number, z: number) => mem.at(...W(x, y, z));

before(async () => {
  mem = new MemBackend();
  hub = new Hub({ config: testConfig({ maxBlocksPerCall: 200_000 }), backend: mem, port: 0, runner: new FakeRunner(), writeEngineJson: false, log: () => {} });
  await hub.start();
  job = await hub.submitJob({ prompt: 'iteration', player: 'Steve', anchor: [0, 64, 0], facing: 'north', size: '40x30x40' }, 'test' as any);
  client = new Client({ name: 't', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hub.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${hub.token}`, 'X-Mcai-Job': job.id } } }));
});

after(async () => {
  await client?.close();
  await hub.stop();
});

test('clear vegetation never drains water: underwater plants become water, water stays', async () => {
  // a little river at x=10..12, z=-10..-8, water surface y=0 (bed at y=-3)
  for (let x = 10; x <= 12; x++)
    for (let z = -10; z <= -8; z++) {
      for (let y = -2; y <= 0; y++) put(x, y, z, 'water');
      put(x, -3, z, 'sand');
    }
  put(10, -2, -10, 'seagrass');
  put(11, -2, -10, 'kelp_plant');
  put(11, -1, -10, 'kelp');
  put(12, -2, -10, 'tall_seagrass[half=lower]');
  put(12, -1, -10, 'tall_seagrass[half=upper]');
  put(10, -2, -9, 'oak_stairs[waterlogged=true]'); // a built block — vegetation mode keeps it
  put(13, 1, -10, 'poppy');
  const r = await call('clear', { box: [[9, -3, -11], [14, 2, -7]], mode: 'vegetation' });
  assert.ok(!r.isError, r.text);
  for (const [x, y] of [[10, -2], [11, -2], [11, -1], [12, -2], [12, -1]]) assert.equal(at(x, y, -10), C('water'), `${x},${y} became water`);
  assert.equal(at(11, 0, -9), C('water'), 'plain water untouched');
  assert.match(at(10, -2, -9), /oak_stairs/);
  assert.equal(at(13, 1, -10), 'minecraft:air');
  // above_ground keeps water too; fluids mode drains and un-waterlogs
  const ag = await call('clear', { box: [[9, -2, -11], [13, 2, -7]], mode: 'above_ground' });
  assert.ok(!ag.isError, ag.text);
  assert.equal(at(11, 0, -9), C('water'));
  assert.equal(at(10, -2, -9), C('water'), 'above_ground removed the built stairs but left water');
  put(10, -2, -9, 'oak_stairs[waterlogged=true]');
  const fl = await call('clear', { box: [[9, -3, -11], [13, 2, -7]], mode: 'fluids' });
  assert.ok(!fl.isError, fl.text);
  assert.equal(at(11, 0, -9), 'minecraft:air');
  assert.match(at(10, -2, -9), /oak_stairs.*waterlogged=false/);
});

test('natural_trees / tree_debris / onlyUnbuilt', async () => {
  // natural tree at x=-10: trunk y=1..5, non-persistent leaves around the top
  for (let y = 1; y <= 5; y++) put(-10, y, -15, 'oak_log[axis=y]');
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let y = 4; y <= 6; y++) if (dx || dz || y === 6) put(-10 + dx, y, -15 + dz, 'oak_leaves[persistent=false,distance=1]');
  // the job builds its own log pillar right next to it (touching the leaves)
  const b = await call('build', { ops: [{ op: 'fill', box: [[-7, 1, -15], [-7, 6, -15]], block: 'oak_log' }] });
  assert.ok(!b.isError, b.text);
  const nt = await call('clear', { box: [[-14, 0, -19], [-5, 8, -11]], mode: 'natural_trees' });
  assert.ok(!nt.isError, nt.text);
  assert.equal(at(-10, 3, -15), 'minecraft:air', 'natural trunk removed');
  assert.equal(at(-10, 6, -15), 'minecraft:air', 'leaves removed');
  assert.match(at(-7, 3, -15), /oak_log/, "job's pillar kept");

  // debris: a floating log piece + far leaves; a hedge on the ground stays
  put(0, 8, -20, 'spruce_log[axis=x]');
  put(1, 8, -20, 'spruce_log[axis=x]');
  for (let x = 4; x <= 6; x++) put(x, 9, -20, 'spruce_leaves[persistent=true]');
  for (let x = 0; x <= 3; x++) put(x, 1, -24, 'oak_leaves[persistent=true]'); // hedge, rests on grass
  const td = await call('clear', { box: [[-2, 0, -26], [8, 10, -18]], mode: 'tree_debris' });
  assert.ok(!td.isError, td.text);
  assert.equal(at(0, 8, -20), 'minecraft:air');
  assert.equal(at(5, 9, -20), 'minecraft:air');
  assert.match(at(2, 1, -24), /oak_leaves/, 'hedge kept');

  // onlyUnbuilt: clear all, but keep this job's blocks
  put(-7, 7, -15, 'stone');
  const ou = await call('clear', { box: [[-7, 1, -15], [-7, 7, -15]], mode: 'all', onlyUnbuilt: true });
  assert.ok(!ou.isError, ou.text);
  assert.match(at(-7, 4, -15), /oak_log/);
  assert.equal(at(-7, 7, -15), 'minecraft:air');
  assert.match(ou.text, /kept \(onlyUnbuilt\)/);
});

test('build: support drops floating vines and reports them in local coordinates', async () => {
  const r = await call('build', {
    ops: [
      { op: 'fill', box: [[0, 1, 0], [0, 4, 0]], block: 'stone_bricks' },
      { op: 'set', positions: [[0, 3, -1], [0, 2, -1]], block: 'vine[south=true]' }, // against the wall (wall is at +z)
      { op: 'set', positions: [[3, 6, -1], [3, 5, -1]], block: 'vine[south=true]' }, // floating
    ],
  });
  assert.ok(!r.isError, r.text);
  assert.match(at(0, 2, -1), /vine/);
  assert.equal(at(3, 5, -1), 'minecraft:air');
  assert.match(r.text, /physics \(local coords\): dropped 2 floating vines — vines need a solid face/);
  assert.match(r.text, /\[3,6,-1\] vine/);
  const keep = await call('build', { support: 'warn', ops: [{ op: 'set', pos: [3, 6, -1], block: 'vine[south=true]' }] });
  assert.match(keep.text, /kept 1 floating vines/);
  assert.match(at(3, 6, -1), /vine/);
});

test('build: all invalid ops are listed at once; skipInvalid builds the valid ones', async () => {
  const ops = [
    { op: 'fill', box: [[5, 1, 5], [5, 1, 5]], block: 'stone' },
    { op: 'fill', box: [[6, 1, 5], [6, 1, 5]], block: 'stone_brikcs' },
    { op: 'sphere2' },
    { op: 'fill', box: [[7, 1, 5], [7, 1, 50]], block: 'stone' },
  ];
  const r = await call('build', { ops });
  assert.equal(r.isError, true);
  assert.match(r.text, /3 of 4 ops are invalid — nothing was built/);
  assert.match(r.text, /op #1 \(fill\)/);
  assert.match(r.text, /op #2/);
  assert.match(r.text, /op #3 \(fill\) writes \d+ blocks outside/);
  assert.equal(at(5, 1, 5), 'minecraft:air');
  const s = await call('build', { ops, skipInvalid: true });
  assert.ok(!s.isError, s.text);
  assert.equal(at(5, 1, 5), 'minecraft:stone');
  assert.match(s.text, /SKIPPED 3 invalid op/);
  assert.match(s.text, /#0 fill: 1/);
});

test('scan_region floating and classified dark spots', async () => {
  put(-15, 12, 0, 'stone'); // a stray block in the air
  put(-15, 12, 1, 'stone');
  const f = await call('scan_region', { box: [[-18, 0, -3], [-12, 14, 3]], mode: 'floating' });
  assert.ok(!f.isError, f.text);
  assert.match(f.text, /2 × stone at \[-15,12,0\]/);
  // a closed room (interior) and an open canopy (covered) side by side
  const room = await call('build', { support: 'off', ops: [
    { op: 'fill', box: [[-16, 1, -30], [-12, 5, -26]], block: 'stone_bricks', mode: 'hollow' },
    { op: 'fill', box: [[-8, 5, -30], [-4, 5, -26]], block: 'oak_planks' },
  ] });
  assert.ok(!room.isError, room.text);
  // the job's own dark interior: the floor is the room's bottom layer (y=1), spots at y=2
  const d = await call('scan_region', { box: [[-17, 0, -31], [-3, 7, -25]], mode: 'dark' });
  assert.ok(!d.isError, d.text);
  assert.match(d.text, /INTERIOR:/);
  assert.match(d.text, /COVERED:/);
  assert.doesNotMatch(d.text, /OUTDOOR:/);
  const dio = await call('scan_region', { box: [[-17, 0, -31], [-3, 7, -25]], mode: 'dark', include: ['interior'] });
  assert.doesNotMatch(dio.text, /COVERED:/);
});

test('command: summon inside a block warns with the nearest free spot', async () => {
  put(2, 1, 2, 'stone');
  put(2, 2, 2, 'stone');
  const r = await call('command', { command: 'summon armor_stand 2.5 65 2.5', space: 'world' });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /WARNING: the armor_stand at 2\.5 65 2\.5 is inside stone/);
  assert.match(r.text, /Nearest free spot: /);
  const ok = await call('command', { command: 'summon armor_stand 4.5 65 4.5', space: 'world' });
  assert.doesNotMatch(ok.text, /WARNING/);
  const frame = await call('command', { command: 'summon item_frame 2.5 65 2.5', space: 'world' });
  assert.doesNotMatch(frame.text, /WARNING/);
});

test('terraform flatten: retaining walls down to the natural ground, water is never drained', async () => {
  // a pad 4 above the flat ground with a stone-brick retaining wall
  const r = await call('terraform', { action: 'flatten', box: [[10, 0, -24], [14, 0, -20]], y: 4, retainingWall: 'stone_bricks' });
  assert.ok(!r.isError, r.text);
  assert.equal(at(12, 4, -22), 'minecraft:grass_block[snowy=false]');
  for (let y = -1; y <= 4; y++) assert.equal(at(10, y, -22), 'minecraft:stone_bricks', `wall at y=${y}`);
  assert.equal(at(9, 1, -22), 'minecraft:air', 'no slope ring outside the wall');
  assert.match(r.text, /retaining walls/);
  // flatten a pond: the water above the pad is kept
  for (let x = -14; x <= -10; x++) for (let z = -6; z <= -4; z++) for (let y = -2; y <= 0; y++) put(x, y, z, 'water');
  const w = await call('terraform', { action: 'flatten', box: [[-14, 0, -6], [-10, 0, -4]], y: -3 });
  assert.ok(!w.isError, w.text);
  assert.equal(at(-12, -1, -5), C('water'));
  assert.match(w.text, /below the water surface — the water was kept/);
});

test('bridge op: walkable deck (≤ half-block steps), rails, piers to the ground', async () => {
  const r = await call('build', { ops: [{ op: 'bridge', from: [-12, 4, 0], to: [-2, 4, 0], width: 3, profile: 'arch', rise: 2, deck: 'spruce_planks', supports: 'stone_bricks', supportEvery: 5, lantern: 'lantern', post: 'spruce_log' }] });
  assert.ok(!r.isError, r.text);
  // walking surface along the middle row
  const surf: number[] = [];
  for (let x = -12; x <= -2; x++) {
    let top = NaN;
    for (let y = 10; y >= 0; y--) {
      const s = at(x, y, 0);
      if (s === 'minecraft:air') continue;
      top = /type=bottom/.test(s) ? y + 0.5 : y + 1;
      break;
    }
    surf.push(top);
  }
  assert.equal(surf[0], 4);
  assert.equal(surf[surf.length - 1], 4);
  assert.ok(Math.max(...surf) > 4, `arched: ${surf}`);
  for (let i = 1; i < surf.length; i++) assert.ok(Math.abs(surf[i]! - surf[i - 1]!) <= 0.5, `step ${surf[i - 1]} → ${surf[i]}`);
  assert.match(at(-7, 6, -1), /spruce_fence/, 'rail on the edge');
  let py = 2;
  while (/stone_bricks/.test(at(-12, py - 1, -1))) py--;
  assert.ok(py < 2, 'pier under the deck');
  assert.match(at(-12, py - 1, -1), /grass_block|dirt|stone/, 'pier reaches the ground');
  const se = await call('build', { ops: [{ op: 'slab_edge', box: [[0, 10, -20], [4, 10, -16]], block: 'smooth_quartz', light: 'sea_lantern' }] });
  assert.ok(!se.isError, se.text);
  assert.match(at(-1, 10, -18), /smooth_quartz_slab\[type=top/);
  assert.equal(at(-1, 9, -21), 'minecraft:sea_lantern');
});

test('run_script: groundY ignores own builds, define/call persist in the job, save_generator/list_generators', async () => {
  const s1 = await call('run_script', { code: 'log(groundY(5, -5)); define("post", function(p){ for (let y = 0; y < p.h; y++) set(p.x, groundY(p.x, p.z) + 1 + y, p.z, "oak_fence"); return p.h; }); call("post", {x: 5, z: -5, h: 3});' });
  assert.ok(!s1.isError, s1.text);
  assert.match(s1.text, /logs:\n0/);
  assert.match(s1.text, /defined generator\(s\) post/);
  assert.match(at(5, 3, -5), /oak_fence/);
  // groundY still sees the natural ground under the job's own fence posts
  const s2 = await call('run_script', { code: 'log(groundY(5, -5), call("post", {x: 6, z: -5, h: 2}))' });
  assert.ok(!s2.isError, s2.text);
  assert.match(s2.text, /logs:\n0 2/);
  assert.match(at(6, 2, -5), /oak_fence/);
  const sv = await call('save_generator', { name: 'post', description: 'a fence post on the ground', params: { x: 'x', z: 'z', h: 'height' } });
  assert.ok(!sv.isError, sv.text);
  const ls = await call('list_generators', {});
  assert.match(ls.text, /post: a fence post on the ground/);
  const bad = await call('run_script', { code: 'sphere({center:[0,5,0]}, "stone")' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /sphere\(\): missing `radius`/);
  const roofFill = await call('run_script', { code: 'roof({box:{min:[0,12,-30],max:[4,12,-26]}, style:"gable", stairs:"oak_stairs", fill:true})' });
  assert.ok(!roofFill.isError, roofFill.text);
  const prot = await call('run_script', { code: 'protect({min:[0,1,-33],max:[2,3,-33]}); box({from:[0,1,-33],to:[4,1,-33]}, "stone"); log(setSoft(4,1,-33,"dirt"))' });
  assert.ok(!prot.isError, prot.text);
  assert.equal(at(1, 1, -33), 'minecraft:air');
  assert.equal(at(4, 1, -33), 'minecraft:stone');
  assert.match(prot.text, /3 sets inside protect\(\)ed boxes ignored/);
  assert.match(prot.text, /logs:\nfalse/);
});

test('terraform flatten: the slope ring widens with the height difference (no hard edge)', async () => {
  const r = await call('terraform', { action: 'flatten', box: [[-4, 0, -24], [0, 0, -20]], y: 8, blend: 4 });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /slope ring widened/);
  const top = (x: number, z: number) => {
    for (let y = 20; y >= -5; y--) if (!/air/.test(at(x, y, z))) return y;
    return NaN;
  };
  const hs: number[] = [];
  for (let x = 0; x >= -14; x--) hs.push(top(x, -22)); // from the pad edge outward (west)
  hs.reverse();
  for (let i = 1; i < hs.length; i++) assert.ok(Math.abs(hs[i]! - hs[i - 1]!) <= 2, `step ${hs[i - 1]} → ${hs[i]} in ${hs}`);
  assert.equal(hs[hs.length - 1], 8);
});
