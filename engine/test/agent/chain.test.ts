// Full chain with a fake claude: JobManager → ClaudeRunner → (fake claude) → MCP over HTTP → tools → backend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpHome, testConfig, MemBackend } from '../server/helpers.ts';
import { Hub } from '../../src/server/hub.ts';
import { ClaudeRunner } from '../../src/agent/runner.ts';
import type { Job } from '../../src/agent/jobs.ts';

tmpHome();
process.env.MCAI_NO_ASSETS = '1';
const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));

test('fake claude drives the MCP tools end to end', async () => {
  process.env.FAKE_CLAUDE_MODE = 'mcp';
  process.env.FAKE_CLAUDE_CALLS = JSON.stringify([
    ['get_context', {}],
    ['progress', { stage: 'Laying the platform', percent: 30 }],
    ['build', { label: 'platform', ops: [{ op: 'fill', box: { min: [-1, 0, -3], max: [1, 0, -1] }, block: 'stone' }] }],
    ['build', { ops: [{ op: 'set', pos: [0, 1, -50], block: 'stone' }] }], // out of bounds → tool error, chain continues
    ['finish', { summary: 'A 3x3 stone platform.', highlights: ['flat'], suggestions: ['more prefabs'] }],
  ]);
  const mem = new MemBackend();
  const cfg = testConfig({ claudePath: FAKE });
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcai-agent-'));
  let hub!: Hub;
  const runner = new ClaudeRunner({ config: cfg, endpoint: () => ({ port: hub.port, token: hub.token }), agentDir });
  hub = new Hub({ config: cfg, backend: mem, port: 0, runner, writeEngineJson: false, log: () => {} });
  await hub.start();
  try {
    const lines: string[] = [];
    hub.jobs.on('agent', (_j: Job, ev) => ev.line && lines.push(`${ev.kind}: ${ev.line}`));
    const job = await hub.submitJob({ prompt: 'a 3x3 stone platform', player: 'Steve', anchor: [0, 64, 0], facing: 'south' }, 'test' as any);
    await new Promise<void>((res) => hub.jobs.on('end', (j: Job) => j === job && res()));
    assert.equal(job.state, 'done', job.error);
    assert.equal(job.costUsd, 0.042);
    assert.equal(job.finished?.summary, 'A 3x3 stone platform.');
    // facing south: local (x,z) → world (-x,-z); local y=0 = anchor level (replaces the grass)
    for (const [x, z] of [[0, 2], [1, 1], [-1, 3]]) assert.equal(mem.at(x!, 64, z!), 'minecraft:stone');
    assert.equal(job.blocksChanged, 9);
    assert.ok(lines.some((l) => l === 'tool: Building 1 op: platform'), lines.join('\n'));
    assert.ok(lines.some((l) => /tool_result: Error: op #0 \(set\) writes 1 blocks outside/.test(l)), lines.join('\n'));
    const log = fs.readFileSync(job.logFile.replace('.jsonl', '.json'), 'utf8');
    assert.match(log, /"state": "done"/);
    assert.ok(mem.notifications.some((n) => /Done: 9 blocks/.test(n.text ?? '')));
  } finally {
    await hub.stop();
  }
});
