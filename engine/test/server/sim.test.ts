// Tools against the real SimBackend + the headless `mcai build` pipeline with a fake claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { tmpHome, testConfig, FakeRunner } from './helpers.ts';
import { Hub } from '../../src/server/hub.ts';
import { SimBackend } from '../../src/sim/sim-backend.ts';
import { headlessBuild } from '../../src/cli.ts';

tmpHome();
process.env.MCAI_NO_ASSETS = '1';
const FAKE = fileURLToPath(new URL('../agent/fake-claude.mjs', import.meta.url));

test('MCP tools on the simulation: context, terraform, build, render', async () => {
  const sim = new SimBackend({ seed: 7, players: [] });
  const runner = new FakeRunner();
  const hub = new Hub({ config: testConfig(), backend: sim, port: 0, runner, writeEngineJson: false, log: () => {} });
  await hub.start();
  try {
    const job = await hub.submitJob({ prompt: 'a hut', player: 'Builder', facing: 'west', size: '24x20x24' }, 'test' as any);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hub.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${hub.token}`, 'X-Mcai-Job': job.id } } }));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as any;
      return { ...r, text: r.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n') };
    };
    const ctx = JSON.parse((await call('get_context')).text);
    assert.equal(ctx.world.kind, 'sim');
    assert.ok(typeof ctx.site.biome === 'string');
    const tf = await call('terraform', { action: 'flatten', box: { min: [-5, 0, -12], max: [5, 0, -2] }, y: 0, blend: 3 });
    assert.ok(!tf.isError, tf.text);
    const b = await call('build', { label: 'hut', ops: [
      { op: 'fill', box: { min: [-3, 1, -10], max: [3, 4, -4] }, block: 'oak_planks', mode: 'walls' },
      { op: 'roof', box: { min: [-3, 5, -10], max: [3, 5, -4] }, style: 'gable', stairs: 'spruce_stairs' },
      { op: 'set', pos: [0, 1, -4], block: 'oak_door[facing=south]' },
    ] });
    assert.ok(!b.isError, b.text);
    const hm = await call('heightmap', { box: { min: [-5, 0, -12], max: [5, 0, -2] }, kind: 'ground' });
    assert.ok(!hm.isError, hm.text);
    const r = await call('render_view', { views: ['iso_se', 'front'], width: 200, height: 150 });
    assert.ok(!r.isError, r.text);
    const imgs = r.content.filter((c: any) => c.type === 'image');
    assert.equal(imgs.length, 2);
    assert.equal(imgs[0].mimeType, 'image/png');
    assert.equal(Buffer.from(imgs[0].data, 'base64').subarray(1, 4).toString(), 'PNG');
    assert.equal(job.state, 'reviewing');
    await client.close();
    runner.complete(job);
  } finally {
    await hub.stop();
  }
});

test('headless build writes renders, job log and summary', async () => {
  process.env.FAKE_CLAUDE_MODE = 'mcp';
  process.env.FAKE_CLAUDE_CALLS = JSON.stringify([
    ['get_context', {}],
    ['build', { label: 'tower', ops: [{ op: 'cylinder', base: [0, 1, -8], radius: 3, height: 10, hollow: true, block: 'stone_bricks' }] }],
    ['finish', { summary: 'A small tower.', highlights: [], suggestions: ['x'] }],
  ]);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mcai-out-'));
  const r = await headlessBuild({ prompt: 'a small tower', seed: 3, facing: 'south', outDir: out, config: testConfig({ claudePath: FAKE }), quiet: true });
  assert.equal(r.job.state, 'done', r.job.error ?? '');
  assert.ok(r.job.blocksChanged > 50);
  assert.equal(r.renders.length, 4);
  for (const f of ['iso_se.png', 'iso_nw.png', 'front.png', 'top.png', 'job.jsonl', 'summary.json']) assert.ok(fs.existsSync(path.join(out, f)), f);
  const s = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'));
  assert.equal(s.finished.summary, 'A small tower.');
});
