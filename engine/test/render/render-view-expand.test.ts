// render_view grows a box that cuts through the build to the whole connected part (sideways/down).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { tmpHome, testConfig, FakeRunner } from '../server/helpers.ts';
import { Hub } from '../../src/server/hub.ts';
import { SimBackend } from '../../src/sim/sim-backend.ts';

tmpHome();
process.env.MCAI_NO_ASSETS = '1';

test('render_view expands a cutting box to connected build parts', async () => {
  const sim = new SimBackend({ seed: 7, players: [] });
  const runner = new FakeRunner();
  const hub = new Hub({ config: testConfig(), backend: sim, port: 0, runner, writeEngineJson: false, log: () => {} });
  await hub.start();
  try {
    const job = await hub.submitJob({ prompt: 'a hut', player: 'Builder', facing: 'north', size: '30x20x30' }, 'test' as any);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hub.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${hub.token}`, 'X-Mcai-Job': job.id } } }));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as any;
      return { ...r, text: r.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n') };
    };
    const b = await call('build', { label: 'hall', ops: [{ op: 'fill', box: { min: [-8, 1, -12], max: [8, 5, -4] }, block: 'oak_planks', mode: 'walls' }] });
    assert.ok(!b.isError, b.text);
    const box = { min: [4, 1, -10], max: [9, 6, -6] };
    const r = await call('render_view', { box, views: ['front'], width: 160, height: 128, margin: 0 });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /connected build parts/);
    const off = await call('render_view', { box, views: ['front'], width: 160, height: 128, margin: 0, expand: false });
    assert.doesNotMatch(off.text, /connected build parts/);
    await client.close();
    runner.complete(job);
  } finally {
    await hub.stop();
  }
});
