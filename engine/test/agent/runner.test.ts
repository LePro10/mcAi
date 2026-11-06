import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpHome, testConfig, waitFor } from '../server/helpers.ts';
import { ClaudeRunner, BUILTIN_TOOLS } from '../../src/agent/runner.ts';
import { JobManager, type Job, type AgentEvent } from '../../src/agent/jobs.ts';
import { StreamParser, describeToolUse } from '../../src/agent/stream.ts';
import type { Box } from '../../src/core/types.ts';

tmpHome();
const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const BOX: Box = { min: [0, 0, 0], max: [10, 10, 10] };

function setup(mode: string, over: Record<string, unknown> = {}, agentFiles: Record<string, string> = {}) {
  process.env.FAKE_CLAUDE_MODE = mode;
  const argsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-')), 'args.json');
  process.env.FAKE_CLAUDE_ARGS = argsFile;
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcai-agent-'));
  for (const [f, c] of Object.entries(agentFiles)) fs.writeFileSync(path.join(agentDir, f), c);
  const cfg = testConfig({ claudePath: FAKE, budgetUsd: 1.5, ...over });
  const runner = new ClaudeRunner({ config: cfg, endpoint: () => ({ port: 4321, token: 'secret-token' }), agentDir, killGraceMs: 300 });
  const jm = new JobManager({ config: cfg, runner, allowedBox: () => BOX });
  const events: AgentEvent[] = [];
  jm.on('agent', (_j: Job, ev: AgentEvent) => events.push(ev));
  const ended = (job: Job) => new Promise<void>((res) => {
    if (!job.active) return res();
    jm.on('end', (j: Job) => j === job && res());
  });
  return { jm, runner, argsFile, agentDir, events, ended };
}

const req = (player = 'Steve', extra: Record<string, unknown> = {}) => ({ player: { name: player }, prompt: 'build a tiny hut', anchor: [0, 64, 0] as [number, number, number], facing: 'north' as const, ...extra });

test('runs claude with the right flags and parses stream-json', async () => {
  const s = setup('ok');
  const job = s.jm.submit(req());
  await s.ended(job);
  assert.equal(job.state, 'done', job.error);
  assert.equal(job.costUsd, 0.0123);
  assert.equal(job.numTurns, 2);
  const a = JSON.parse(fs.readFileSync(s.argsFile, 'utf8'));
  const argv: string[] = a.argv;
  const flag = (f: string) => argv[argv.indexOf(f) + 1];
  assert.ok(argv.includes('-p'));
  assert.equal(flag('--model'), 'opus');
  assert.equal(flag('--effort'), 'medium');
  assert.equal(flag('--output-format'), 'stream-json');
  assert.ok(argv.includes('--verbose'));
  assert.ok(argv.includes('--strict-mcp-config'));
  assert.equal(flag('--setting-sources'), 'user');
  assert.equal(flag('--permission-mode'), 'dontAsk');
  assert.equal(flag('--max-budget-usd'), '1.5');
  assert.equal(flag('--tools'), BUILTIN_TOOLS.join(','));
  assert.match(flag('--allowedTools')!, /^mcp__mcai,/);
  assert.match(flag('--append-system-prompt')!, /Current job/);
  assert.equal(a.cwd, fs.realpathSync(s.agentDir));
  assert.match(a.stdin, /build a tiny hut/);
  assert.equal(a.jobId, job.id);
  assert.ok(Number(a.toolTimeout) >= 600000);
  assert.deepEqual(a.mcpConfig.mcpServers.mcai, { type: 'http', url: 'http://127.0.0.1:4321/mcp', headers: { Authorization: 'Bearer secret-token', 'X-Mcai-Job': job.id } });
  assert.equal(fs.existsSync(flag('--mcp-config')!), false, 'temp mcp config removed');
  // placeholder system prompt was created
  assert.ok(fs.existsSync(path.join(s.agentDir, 'SYSTEM.md')));
  const kinds = s.events.map((e) => e.kind);
  for (const k of ['init', 'text', 'tool', 'subagent_start', 'subagent_end', 'result', 'exit']) assert.ok(kinds.includes(k as any), k);
  assert.equal(s.events.find((e) => e.kind === 'tool')!.line, 'Building 2 ops: walls');
  const log = fs.readFileSync(job.logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(log.some((l) => l.kind === 'spawn'));
  assert.ok(log.some((l) => l.kind === 'end' && l.state === 'done'));
  assert.ok(fs.existsSync(job.logFile.replace(/\.jsonl$/, '.json')));
});

test('uses agents.json and SYSTEM.md from the agent dir', async () => {
  const s = setup('ok', {}, { 'SYSTEM.md': 'SYS-MARK architect rules', 'agents.json': JSON.stringify({ critic: { description: 'reviews', prompt: 'be critical' } }) });
  const job = s.jm.submit(req('Ann', { budgetUsd: 0.25, model: 'sonnet', effort: 'low' }));
  await s.ended(job);
  const argv: string[] = JSON.parse(fs.readFileSync(s.argsFile, 'utf8')).argv;
  const flag = (f: string) => argv[argv.indexOf(f) + 1];
  assert.match(flag('--append-system-prompt')!, /^SYS-MARK architect rules/);
  assert.equal(JSON.parse(flag('--agents')!).critic.prompt, 'be critical');
  assert.equal(flag('--max-budget-usd'), '0.25');
  assert.equal(flag('--model'), 'sonnet');
  assert.equal(flag('--effort'), 'low');
});

test('cancel kills the whole process group (SIGTERM ignored → SIGKILL)', async () => {
  const pidFile = path.join(os.tmpdir(), `fc-pid-${process.pid}-${Date.now()}`);
  process.env.FAKE_CLAUDE_PIDFILE = pidFile;
  const s = setup('hang');
  const job = s.jm.submit(req('Bob'));
  const gpid = Number(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8'), 5000, 'grandchild pid'));
  await waitFor(() => s.events.find((e) => e.kind === 'text'), 5000, 'thinking text');
  assert.equal(job.detail, 'Thinking very hard about this…');
  const t0 = Date.now();
  await s.jm.cancel(job.id, 'player cancelled');
  assert.equal(job.state, 'cancelled');
  assert.ok(Date.now() - t0 < 4000);
  await waitFor(() => {
    try {
      process.kill(gpid, 0);
      return false;
    } catch {
      return true;
    }
  }, 3000, 'grandchild dead');
  delete process.env.FAKE_CLAUDE_PIDFILE;
});

test('timeout fails the job', async () => {
  const s = setup('hang');
  const job = s.jm.submit(req('Tim', { timeoutMin: 0.005 }));
  await s.ended(job);
  assert.equal(job.state, 'failed');
  assert.match(job.error, /timed out/);
});

test('budget exhaustion and crashes are reported', async () => {
  const s1 = setup('budget');
  const j1 = s1.jm.submit(req('Bud'));
  await s1.ended(j1);
  assert.equal(j1.state, 'failed');
  assert.match(j1.error, /budget of \$1.5 exhausted/);
  assert.equal(j1.costUsd, 0.5);
  const s2 = setup('crash');
  const j2 = s2.jm.submit(req('Cra'));
  await s2.ended(j2);
  assert.equal(j2.state, 'failed');
  assert.match(j2.error, /authentication failed/);
  const s3 = setup('ok', { claudePath: '/nonexistent/claude' });
  const j3 = s3.jm.submit(req('Mis'));
  await s3.ended(j3);
  assert.equal(j3.state, 'failed');
  assert.match(j3.error, /not found/);
});

test('global concurrency queues jobs; per-player single active job', async () => {
  const s = setup('ok', { concurrency: 1 });
  const a = s.jm.submit(req('P1'));
  const b = s.jm.submit(req('P2'));
  assert.equal(b.state, 'queued');
  assert.match(b.stage, /Queued/);
  assert.throws(() => s.jm.submit(req('P1')), /already has an active job/);
  await s.ended(a);
  await s.ended(b);
  assert.equal(a.state, 'done');
  assert.equal(b.state, 'done');
  assert.ok(b.startedAt >= a.endedAt);
  // queued job can be cancelled before it starts
  process.env.FAKE_CLAUDE_MODE = 'hang';
  const c = s.jm.submit(req('P3'));
  const d = s.jm.submit(req('P4'));
  await s.jm.cancel(d.id);
  assert.equal(d.state, 'cancelled');
  assert.equal(d.startedAt, 0);
  await s.jm.cancel(c.id);
});

test('stream parser handles partial lines, subagent attribution and garbage', () => {
  const evs: AgentEvent[] = [];
  const p = new StreamParser((e) => evs.push(e));
  const lines = [
    { type: 'system', subtype: 'init', model: 'm', tools: [] },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'A', name: 'Task', input: { subagent_type: 'interior', description: 'furnish' } }] } },
    { type: 'assistant', parent_tool_use_id: 'A', message: { content: [{ type: 'tool_use', id: 'B', name: 'mcp__mcai__place_prefab', input: { name: 'table' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'A', content: 'ok' }] } },
  ].map((l) => JSON.stringify(l) + '\n').join('');
  p.push(lines.slice(0, 50));
  p.push(lines.slice(50) + 'not json\n');
  p.end();
  assert.deepEqual(evs.map((e) => e.kind), ['init', 'subagent_start', 'tool', 'subagent_end', 'raw']);
  assert.equal(evs[2]!.line, '[interior] Placing table');
  assert.equal(describeToolUse('mcp__mcai__terraform', { action: 'flatten' }), 'Shaping terrain (flatten)');
});
