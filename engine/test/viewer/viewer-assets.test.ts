// Viewer server helpers (server/viewer-assets.ts) through a real Hub, plus the browser protocol
// client (viewer/js/protocol.js) talking to /viewer like the page does.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { tmpHome, testConfig, MemBackend, FakeRunner, waitFor } from '../server/helpers.ts';
import { Hub } from '../../src/server/hub.ts';
import { ViewerAssets, QUAD_STRIDE, G_OCCLUDES } from '../../src/server/viewer-assets.ts';
// @ts-ignore — browser ES modules (plain JS)
import { EngineClient, agentIcon } from '../../src/viewer/js/protocol.js';
// @ts-ignore
import { decodeVolume, decodeBlocks, defaultAllowedBox as clientAllowedBox, plainText } from '../../src/viewer/js/codec.js';
// @ts-ignore
import { MeshCore } from '../../src/viewer/js/meshcore.js';
import { defaultAllowedBox } from '../../src/server/hub.ts';

process.env.MCAI_NO_ASSETS = '1';
tmpHome();
const mem = new MemBackend();
const runner = new FakeRunner();
let hub: Hub;
let base = '';

before(async () => {
  hub = new Hub({ config: testConfig(), backend: mem, port: 0, runner, writeEngineJson: false, log: () => {} });
  await hub.start();
  base = `http://127.0.0.1:${hub.port}`;
});
after(async () => {
  await hub.stop();
});

test('every viewer URL is served with the right content type', async () => {
  const expect: [string, number, RegExp][] = [
    ['/', 200, /^text\/html/],
    ['/css/viewer.css', 200, /^text\/css/],
    ['/js/app.js', 200, /^text\/javascript/],
    ['/js/scene.js', 200, /^text\/javascript/],
    ['/js/mesh-worker.js', 200, /^text\/javascript/],
    ['/js/meshcore.js', 200, /^text\/javascript/],
    ['/js/mesher.js', 200, /^text\/javascript/],
    ['/js/protocol.js', 200, /^text\/javascript/],
    ['/vendor/three/build/three.module.js', 200, /^text\/javascript/],
    ['/vendor/three/build/three.core.js', 200, /^text\/javascript/],
    ['/vendor/three/examples/jsm/controls/OrbitControls.js', 200, /^text\/javascript/],
    ['/api/viewer/info', 200, /^application\/json/],
    ['/api/viewer/biomes?box=-8,60,-8,8,70,8&step=4', 200, /^application\/json/],
    ['/api/viewer/atlas.png', 404, /^application\/json/], // MCAI_NO_ASSETS → flat colors
    ['/vendor/three/package.json', 403, /^text\/plain/],
    ['/vendor/three/src/Three.js', 403, /^text\/plain/],
    ['/vendor/three/build/nope.js', 404, /^text\/plain/],
  ];
  for (const [url, status, type] of expect) {
    const r = await fetch(base + url);
    assert.equal(r.status, status, url);
    assert.match(r.headers.get('content-type') ?? '', type, url);
    await r.arrayBuffer();
  }
  // traversal with encoded slashes (fetch would normalise plain ../)
  const raw = await new Promise<number>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: hub.port, path: '/vendor/three/build/..%2f..%2f..%2fpackage.json' }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on('error', reject);
  });
  assert.equal(raw, 403);
  // every module the page imports exists (static import graph of js/*.js)
  const dir = path.resolve(import.meta.dirname, '../../src/viewer/js');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/from '(\.\/[^']+)'/g)) assert.ok(fs.existsSync(path.join(dir, m[1]!)), `${f} imports ${m[1]}`);
  }
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /"three": "\/vendor\/three\/build\/three\.module\.js"/);
});

test('info, geometry (POST + GET) and biomes', async () => {
  const info = await (await fetch(base + '/api/viewer/info')).json();
  assert.equal(info.assets, false);
  assert.equal(info.quadStride, QUAD_STRIDE);
  assert.deepEqual(info.defaultSize, { x: 48, y: 40, z: 48 });
  // POST needs the token or a same-origin Origin
  const unauth = await fetch(base + '/api/viewer/geometry', { method: 'POST', body: '{"states":[]}' });
  assert.equal(unauth.status, 401);
  const r = await fetch(base + '/api/viewer/geometry', {
    method: 'POST',
    headers: { authorization: `Bearer ${hub.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ states: ['minecraft:stone', 'minecraft:air', 'minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]', 'minecraft:glass'] }),
  });
  assert.equal(r.status, 200);
  const g = (await r.json()).geometry;
  assert.ok(g['minecraft:stone'].f & G_OCCLUDES);
  assert.equal(g['minecraft:stone'].q.length, 6 * QUAD_STRIDE);
  assert.equal(g['minecraft:air'].q.length, 0);
  assert.equal(g['minecraft:glass'].g, 'minecraft:glass', 'glass self-culls');
  assert.ok(g['minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]'].q.length >= 6 * QUAD_STRIDE);
  const viaGet = await (await fetch(base + '/api/viewer/geometry?s=minecraft:stone')).json();
  assert.deepEqual(viaGet.geometry['minecraft:stone'], g['minecraft:stone']);
  const bio = await (await fetch(base + '/api/viewer/biomes?box=-8,60,-8,7,70,7&step=4')).json();
  assert.equal(bio.nx, 4);
  assert.equal(bio.nz, 4);
  assert.deepEqual(bio.palette, ['minecraft:plains']);
  assert.ok(Array.isArray(bio.tints['minecraft:plains'].grass));
  assert.equal((await fetch(base + '/api/viewer/biomes?box=1,2')).status, 400);
});

test('protocol client: hello, get_blocks decode + mesh, live blocks, start_job, reply, reconnect', async () => {
  const client = new EngineClient({ base, reconnect: true });
  // always release the client (it reconnects on its own) and any job, even when an assertion fails —
  // otherwise the open socket / reconnect timer keeps the test process alive
  let jobId: string | undefined;
  try {
    const hello = new Promise<any>((r) => client.on('hello', r));
    await client.connect();
    const h = await hello;
    assert.equal(h.status.backend, 'sim');
    // get_blocks like the page: decode, remap to a global palette, mesh in the worker core
    const box = { min: [0, 64, 0], max: [15, 79, 15] }; // exactly one section
    const vol = decodeVolume(await client.request('get_blocks', { box }));
    assert.equal(vol.data.length, 16 * 16 * 16);
    const geoRes = await client.api('/api/viewer/geometry', { body: { states: vol.palette } });
    const posted: any[] = [];
    const core = new MeshCore((m: any) => posted.push(m));
    core.handle({ t: 'geo', entries: vol.palette.map((s: string, i: number) => [i, s, geoRes.geometry[s]]) });
    core.handle({ t: 'volume', box, data: vol.data, center: [0, 64, 0] });
    while (core.dirty.size) core.process(1e9);
    const sections = posted.filter((m) => m.t === 'section');
    assert.equal(sections.length, 1);
    // flat grass layer at y=64: its top + the four diorama sides (+ bottom) are visible
    assert.ok(sections[0].layers.opaque.count > 0);
    assert.ok(posted.some((m) => m.t === 'loaded'));

    // live edits arrive as {type:'blocks'} and re-mesh only the touched section
    const blocks = new Promise<any>((r) => client.on('blocks', r));
    const res = await hub.worldEdit.handle('Viewer', 'set', { selection: { min: [0, 65, 0], max: [1, 65, 0] }, block: 'gold_block' });
    assert.ok(res);
    const ev = decodeBlocks(await blocks);
    assert.equal(ev.count, 2);
    assert.ok(ev.palette.includes('minecraft:gold_block'));
    const gi = vol.palette.length;
    core.handle({ t: 'geo', entries: [[gi, 'minecraft:gold_block', (await client.api('/api/viewer/geometry', { body: { states: ['minecraft:gold_block'] } })).geometry['minecraft:gold_block']]] });
    posted.length = 0;
    core.handle({ t: 'edit', positions: ev.positions, states: Uint16Array.from(ev.states, (s: number) => (ev.palette[s] === 'minecraft:gold_block' ? gi : 0)), now: 5, animate: true });
    while (core.dirty.size || core.pendingLight) core.process(1e9);
    const re = posted.filter((m) => m.t === 'section');
    assert.equal(re.length, 1, 'only the touched section is re-meshed');
    assert.ok(Array.from(re[0].layers.opaque.born as Float32Array).some((b) => b >= 5), 'new blocks carry a birth time');

    // start a job like the wand does
    const jobEv = new Promise<any>((r) => client.on('job', r));
    const started = await client.request('start_job', { prompt: 'a tiny tower', anchor: [0, 64, 0], facing: 'east', size: '16x16x16', player: 'Viewer', style: 'medieval' });
    assert.equal(started.job.facing, 'east');
    assert.deepEqual(started.job.allowedBox, defaultAllowedBox([0, 64, 0], 'east', { x: 16, y: 16, z: 16 }, 12, { minY: -64, maxY: 319 }));
    assert.deepEqual(started.job.allowedBox, clientAllowedBox([0, 64, 0], 'east', { x: 16, y: 16, z: 16 }, 12), 'client preview box = engine box');
    assert.equal((await jobEv).job.id, started.job.id);
    const job = hub.jobs.get(started.job.id)!;
    jobId = job.id;
    const agent = new Promise<any>((r) => client.on('agent', r));
    await waitFor(() => runner.events.get(job.id), 2000, 'runner start');
    runner.events.get(job.id)!({ kind: 'tool', line: 'Building 3 ops: walls' });
    const a = await agent;
    assert.equal(a.jobId, job.id);
    assert.equal(agentIcon(a.ev), 'cube');
    // ask_player → reply
    const asked = hub.jobs.ask(job, 'Which roof?', ['gable', 'dome'], 5000);
    await waitFor(() => job.question, 1000, 'question');
    const r = await client.request('reply', { jobId: job.id, text: 'dome' });
    assert.equal(r.ok, true);
    assert.equal(await asked, 'dome');
    await client.request('cancel_job', { jobId: job.id });
    await waitFor(() => !job.active, 2000, 'cancel');
    assert.equal(job.state, 'cancelled');

    // errors come back as rejections
    await assert.rejects(client.request('get_blocks', {}), /box required/);

    // reconnect after the socket drops
    const reopened = new Promise<any>((r) => client.on('open', r));
    client.ws.close(4000, 'test');
    await reopened;
    assert.equal(client.state, 'open');
  } finally {
    client.close();
    const j = jobId ? hub.jobs.get(jobId) : undefined;
    if (j?.active) await hub.jobs.cancel(j.id).catch(() => {});
  }
});

test('codec helpers', () => {
  assert.equal(plainText('{"text":"[mcAI] ","extra":[{"text":"Done","color":"green"}]}'), '[mcAI] Done');
  assert.equal(plainText('§aHello'), 'Hello');
  assert.equal(agentIcon({ kind: 'text', line: 'hmm' }), 'thought');
  assert.equal(agentIcon({ kind: 'tool', line: '[landscaper] Shaping terrain (raise)' }), 'terrain');
});

test('real assets (if cached): stairs, plants and water compact correctly', async (t) => {
  const cache = path.join(os.homedir(), '.mcai', 'cache');
  if (!fs.existsSync(path.join(cache, 'mcmeta')) && !fs.existsSync(path.join(cache, '26.3'))) return t.skip('no asset cache');
  const { AssetStore } = await import('../../src/assets/assets.ts');
  const assets = await AssetStore.tryOpen('26.3', cache);
  if (!assets) return t.skip('assets unavailable');
  const va = new ViewerAssets({ assets: async () => assets, backend: () => mem, config: testConfig() });
  const stairs = 'minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]';
  const g = await va.geometry([stairs, 'minecraft:short_grass', 'minecraft:water[level=0]', 'minecraft:grass_block[snowy=false]', 'minecraft:oak_leaves[distance=7,persistent=false,waterlogged=false]']);
  assert.ok(g[stairs]!.q.length >= 10 * QUAD_STRIDE, 'two cuboids');
  const grass = g['minecraft:short_grass']!;
  assert.equal(grass.k, 'grass');
  // crossed quads: normals are diagonal
  assert.ok(Math.abs(grass.q[4]!) > 0.5 && Math.abs(grass.q[6]!) > 0.5);
  assert.equal(g['minecraft:water[level=0]']!.q.length, 0);
  assert.ok(g['minecraft:water[level=0]']!.f & 8);
  assert.ok(g['minecraft:grass_block[snowy=false]']!.f & G_OCCLUDES);
  assert.equal(g['minecraft:oak_leaves[distance=7,persistent=false,waterlogged=false]']!.g, 'minecraft:oak_leaves');
  for (const cg of Object.values(g))
    for (let o = 0; o < cg.q.length; o += QUAD_STRIDE)
      for (let k = 0; k < 4; k++) {
        const u = cg.q[o + 11 + k * 5]!, v = cg.q[o + 12 + k * 5]!;
        assert.ok(u === -1 || (u >= 0 && u <= 1 && v >= 0 && v <= 1));
      }
  const info = await va.info();
  assert.ok(info.fluids.water && info.fluids.water.length === 4);
});
