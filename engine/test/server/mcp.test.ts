import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { tmpHome, testConfig, MemBackend, FakeRunner, waitFor } from './helpers.ts';
import { Hub } from '../../src/server/hub.ts';
import type { Job } from '../../src/agent/jobs.ts';
import { paths } from '../../src/server/config.ts';

tmpHome();
process.env.MCAI_NO_ASSETS = '1';

let hub: Hub;
let mem: MemBackend;
let runner: FakeRunner;
let job: Job;
let client: Client;

const ANCHOR: [number, number, number] = [100, 64, 100];

async function connect(jobId: string, token = hub.token): Promise<Client> {
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hub.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}`, 'X-Mcai-Job': jobId } } }));
  return c;
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return { ...r, text };
}

before(async () => {
  mem = new MemBackend();
  mem.playerList = [{ name: 'Steve', uuid: 'u', pos: [92.5, 65, 100.5], yaw: -90, pitch: 10, dimension: 'minecraft:overworld' }];
  runner = new FakeRunner();
  hub = new Hub({ config: testConfig({ maxBlocksPerCall: 5000 }), backend: mem, port: 0, runner, writeEngineJson: false, log: () => {} });
  await hub.start();
  // facing east: local -z (forward) = world +x, local +x (right) = world +z
  job = await hub.submitJob({ prompt: 'a tiny tower', player: 'Steve', anchor: ANCHOR, facing: 'east', size: '16x16x16' }, 'test' as any);
  client = await connect(job.id);
});

after(async () => {
  await client?.close();
  await hub.stop();
});

test('lists all tools with descriptions and schemas', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  for (const n of ['get_context', 'scan_region', 'render_view', 'find_blocks', 'block_info', 'heightmap', 'build', 'run_script', 'terraform', 'place_prefab', 'clear', 'copy', 'paste', 'stack', 'move', 'save_structure', 'load_structure', 'list_structures', 'undo', 'say', 'progress', 'ask_player', 'finish', 'command']) {
    assert.ok(names.includes(n), `missing tool ${n}`);
  }
  for (const t of tools) {
    assert.ok(t.description && t.description.length > 40, `${t.name} needs a description`);
    assert.equal(t.inputSchema.type, 'object');
  }
  const build = tools.find((t) => t.name === 'build')!;
  assert.match(build.description!, /roof/);
  const total = tools.reduce((n, t) => n + JSON.stringify(t).length, 0);
  assert.ok(total < 60000, `tool list is ${total} chars — keep it compact`);
});

test('auth and job header are enforced', async () => {
  await assert.rejects(connect(job.id, 'wrong-token'));
  await assert.rejects(connect('no-such-job'));
});

test('get_context describes the frame, box and terrain', async () => {
  const r = await call('get_context');
  assert.ok(!r.isError, r.text);
  const ctx = JSON.parse(r.text);
  assert.equal(ctx.job.prompt, 'a tiny tower');
  assert.equal(ctx.frame.facing, 'east');
  assert.match(ctx.frame.localAxes, /forward\) = world east/);
  assert.equal(ctx.site.anchorGroundOffset, 0);
  assert.equal(ctx.site.ground.minOffset, 0);
  assert.equal(ctx.player.name, 'Steve');
  assert.equal(ctx.limits.blocksPerCall, 5000);
  assert.ok(ctx.site.heightGridLocal.rows.length > 0);
});

test('build in local space rotates positions and block states into the world', async () => {
  const r = await call('build', {
    label: 'base',
    ops: [
      { op: 'fill', box: { min: [-1, 1, -3], max: [1, 1, -1] }, block: 'stone_bricks' },
      { op: 'set', pos: [0, 2, -2], block: 'oak_stairs[facing=north]' },
    ],
  });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /changed 10 blocks/);
  // local (x,z) → world anchor + (-z, x) for east
  assert.equal(mem.at(102, 65, 100), 'minecraft:stone_bricks');
  assert.equal(mem.at(101, 65, 99), 'minecraft:stone_bricks');
  assert.match(mem.at(102, 66, 100), /oak_stairs\[facing=east/);
  assert.equal(job.state, 'building');
  assert.equal(job.undoIds.length, 1);
  assert.equal(job.blocksChanged, 10);
});

test('edits outside the allowed box are rejected with an actionable error', async () => {
  const before = mem.edits.size;
  const r = await call('build', { ops: [{ op: 'fill', box: { min: [0, 1, -40], max: [0, 1, -30] }, block: 'stone' }] });
  assert.equal(r.isError, true);
  assert.match(r.text, /outside/);
  assert.match(r.text, /clip:true/);
  assert.equal(mem.edits.size, before);
  const big = await call('build', { ops: [{ op: 'fill', box: { min: [-8, -12, -13], max: [7, 15, 2] }, block: 'stone' }] });
  assert.equal(big.isError, true);
  assert.match(big.text, /more than 5,000 blocks/);
  const bad = await call('build', { ops: [{ op: 'fill', box: { min: [0, 0, 0], max: [1, 1, 1] }, block: 'stone_brikcs' }] });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /stone_bricks/); // did-you-mean
  const badOp = await call('build', { ops: [{ op: 'sphere2' }] });
  assert.equal(badOp.isError, true);
  assert.match(badOp.text, /op #0/);
  // clip:true drops the outside part
  const clip = await call('build', { clip: true, ops: [{ op: 'fill', box: { min: [0, 1, 0], max: [0, 1, 12] }, block: 'glass' }] });
  assert.ok(!clip.isError, clip.text);
  assert.match(clip.text, /clipped/);
});

test('scan_region, heightmap, find_blocks, block_info', async () => {
  const layers = await call('scan_region', { box: { min: [-2, 0, -4], max: [2, 2, 0] }, mode: 'layers' });
  assert.ok(!layers.isError, layers.text);
  assert.match(layers.text, /y=1/);
  assert.match(layers.text, /=stone_bricks/);
  const sum = await call('scan_region', { box: { min: [-2, 1, -4], max: [2, 2, 0] } });
  assert.match(sum.text, /stone_bricks/);
  const blocks = await call('scan_region', { box: { min: [0, 2, -2], max: [0, 2, -2] }, mode: 'blocks' });
  assert.match(blocks.text, /oak_stairs\[facing=north/); // local orientation back
  const dark = await call('scan_region', { box: { min: [-3, 0, -5], max: [3, 4, 1] }, mode: 'dark', include: ['interior', 'covered', 'outdoor'] });
  assert.ok(!dark.isError, dark.text);
  assert.match(dark.text, /dark spawnable spots/);
  const surf = await call('scan_region', { box: { min: [-2, 0, -4], max: [2, 3, 0] }, mode: 'surface' });
  assert.ok(!surf.isError, surf.text);
  const hm = await call('heightmap', { box: { min: [-2, 0, -4], max: [2, 0, 0] } });
  assert.ok(!hm.isError, hm.text);
  assert.match(hm.text, /base y=64/);
  const fb = await call('find_blocks', { query: 'dark oak stairs' });
  assert.match(fb.text, /dark_oak_stairs/);
  const bi = await call('block_info', { block: 'oak_stairs[facing=east]' });
  assert.match(bi.text, /canonical: minecraft:oak_stairs\[facing=east,half=bottom,shape=straight,waterlogged=false\]/);
  const bad = await call('block_info', { block: 'oak_stairz' });
  assert.equal(bad.isError, true);
});

test('copy/paste with rotation, stack and move', async () => {
  const c = await call('copy', { box: { min: [-1, 1, -3], max: [1, 2, -1] }, name: 'base', origin: [-1, 1, -3] });
  assert.ok(!c.isError, c.text);
  const p = await call('paste', { name: 'base', at: [-1, 1, -8], rotate: 90 });
  assert.ok(!p.isError, p.text);
  assert.match(p.text, /changed/);
  const st = await call('stack', { box: { min: [-1, 1, -3], max: [1, 1, -1] }, count: 2, direction: 'up' });
  assert.ok(!st.isError, st.text);
  // local y=3 now stone bricks (stacked copy of layer y=1 at y=2 and y=3)
  assert.equal(mem.at(102, 67, 100), 'minecraft:stone_bricks');
  const mv = await call('move', { box: { min: [-1, 1, -8], max: [1, 2, -6] }, offset: [0, 0, -2] });
  assert.ok(!mv.isError, mv.text);
  const save = await call('save_structure', { name: 'test-base', clipboard: 'base', description: 'a base', tags: ['test'] });
  assert.ok(!save.isError, save.text);
  const list = await call('list_structures', {});
  assert.match(list.text, /test-base/);
  const load = await call('load_structure', { name: 'test-base', clipboard: 'b2' });
  assert.ok(!load.isError, load.text);
  assert.match(load.text, /size 3x2x3/);
});

test('run_script, terraform, clear, place_prefab, command', async () => {
  const s = await call('run_script', { code: 'for (let i = 0; i < 3; i++) set(i - 1, 1, -12, "glass"); log("hi", get(0, 1, -2));', label: 'glass row' });
  assert.ok(!s.isError, s.text);
  assert.match(s.text, /hi minecraft:stone_bricks/);
  assert.equal(mem.at(112, 65, 100), 'minecraft:glass');
  const se = await call('run_script', { code: 'set(0,1,0,"stone");\nnope();' });
  assert.equal(se.isError, true);
  assert.match(se.text, /nope/);
  const out = await call('run_script', { code: 'set(0, 1, -100, "stone")' });
  assert.equal(out.isError, true);
  assert.match(out.text, /outside/);
  const tf = await call('terraform', { action: 'raise', box: { min: [-6, 0, -13], max: [-3, 0, -10] }, amount: 2, shape: 'flat' });
  assert.ok(!tf.isError, tf.text);
  assert.match(tf.text, /16 columns changed \(16 raised/);
  const cl = await call('clear', { box: { min: [-1, 1, -12], max: [1, 1, -12] } });
  assert.ok(!cl.isError, cl.text);
  assert.equal(mem.at(112, 65, 100), 'minecraft:air');
  const pl = await call('place_prefab', { name: 'list' });
  assert.ok(!pl.isError, pl.text);
  const first = pl.text.split('\n')[0]!.split(':')[0]!;
  const pp = await call('place_prefab', { name: first, at: [4, 1, -6] });
  assert.ok(!pp.isError || /outside/.test(pp.text), pp.text);
  const cmd = await call('command', { command: 'summon armor_stand 105 65 101', space: 'world' });
  assert.ok(!cmd.isError, cmd.text);
  assert.equal(mem.commands.at(-1), 'summon armor_stand 105 65 101');
  const lc = await call('command', { command: 'summon item_frame 0.5 1 -1.5 {Facing:2b,Rotation:[0f,0f]}' });
  assert.ok(!lc.isError, lc.text);
  assert.equal(mem.commands.at(-1), 'summon item_frame 102.5 65 100.5 {Facing:5b,Rotation:[90f,0f]}');
  const bad = await call('command', { command: 'op Steve' });
  assert.equal(bad.isError, true);
});

test('undo reverts only this job, one tool call per step', async () => {
  const n = job.undoIds.length;
  const r = await call('undo', { steps: 1 });
  assert.ok(!r.isError, r.text);
  assert.equal(job.undoIds.length, n - 1);
});

test('say, progress, ask_player and finish', async () => {
  const s = await call('say', { text: 'Starting the tower!' });
  assert.ok(!s.isError, s.text);
  assert.ok(mem.notifications.some((n) => n.text === 'Starting the tower!' && n.target === 'Steve'));
  const s2 = await call('say', { text: 'again' });
  assert.equal(s2.isError, true);
  assert.match(s2.text, /rate-limited/);
  await call('progress', { stage: 'Raising the walls', percent: 40 });
  assert.equal(job.stage, 'Raising the walls');
  assert.equal(job.progress, 0.4);
  const ask = call('ask_player', { question: 'Which roof?', options: ['Flat', 'Gable'], timeoutSec: 10 });
  await waitFor(() => job.question, 3000, 'question');
  assert.ok(mem.notifications.some((n) => /Which roof\?/.test(n.text ?? '')));
  assert.equal(hub.jobs.answer(job.id, '2'), true);
  assert.match((await ask).text, /player chose: Gable/);
  const f = await call('finish', { summary: 'Built a tiny tower.', highlights: ['spiral stairs'], suggestions: ['a tool to preview a roof before placing it'] });
  assert.ok(!f.isError, f.text);
  assert.equal(job.finished?.summary, 'Built a tiny tower.');
  const files = fs.readdirSync(paths.feedback());
  assert.equal(files.length, 1);
  const line = JSON.parse(fs.readFileSync(path.join(paths.feedback(), files[0]!), 'utf8').trim());
  assert.deepEqual(line.suggestions, ['a tool to preview a roof before placing it']);
  assert.equal(line.jobId, job.id);
  // job end groups undo records into one per player
  runner.complete(job);
  await waitFor(() => !job.active, 3000, 'job end');
  assert.equal(job.state, 'done');
  assert.equal(job.undoIds.length, 1);
  assert.equal(hub.history.list('Steve').length, 1);
  const late = await call('get_context');
  assert.equal(late.isError, true);
  assert.match(late.text, /has ended/);
  // the grouped undo reverts the whole job
  const res = await fetch(`http://127.0.0.1:${hub.port}/api/undo`, { method: 'POST', headers: { authorization: `Bearer ${hub.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ player: 'Steve' }) });
  assert.equal(res.status, 200);
  assert.equal(mem.at(102, 65, 100), 'minecraft:air');
  assert.equal(mem.at(102, 64, 100), 'minecraft:grass_block[snowy=false]');
});

test('REST API: jobs, status, cross-origin protection', async () => {
  const st = (await (await fetch(`http://127.0.0.1:${hub.port}/api/status`)).json()) as any;
  assert.equal(st.backend, 'sim');
  const jobs = (await (await fetch(`http://127.0.0.1:${hub.port}/api/jobs`)).json()) as any;
  assert.ok(jobs.jobs.some((j: any) => j.id === job.id));
  const one = (await (await fetch(`http://127.0.0.1:${hub.port}/api/jobs/${job.id}?log=500`)).json()) as any;
  assert.ok(one.log.some((l: any) => l.kind === 'tool' && l.name === 'build'));
  const noAuth = await fetch(`http://127.0.0.1:${hub.port}/api/jobs`, { method: 'POST', body: JSON.stringify({ prompt: 'x' }) });
  assert.equal(noAuth.status, 401);
  const evil = await fetch(`http://127.0.0.1:${hub.port}/api/jobs`, { method: 'POST', headers: { origin: 'http://evil.example' }, body: JSON.stringify({ prompt: 'x' }) });
  assert.equal(evil.status, 401);
  const sess = await fetch(`http://127.0.0.1:${hub.port}/api/session`, { headers: { origin: 'http://evil.example' } });
  assert.equal(sess.status, 403);
  const ok = await fetch(`http://127.0.0.1:${hub.port}/api/jobs`, { method: 'POST', headers: { origin: `http://127.0.0.1:${hub.port}`, 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'a well', player: 'Viewer', anchor: [0, 64, 0] }) });
  assert.equal(ok.status, 201);
  const created = ((await ok.json()) as any).job;
  const cancel = await fetch(`http://127.0.0.1:${hub.port}/api/jobs/${created.id}/cancel`, { method: 'POST', headers: { authorization: `Bearer ${hub.token}` } });
  assert.equal(((await cancel.json()) as any).job.state, 'cancelled');
});
