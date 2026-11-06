#!/usr/bin/env node
// Fake `claude -p` for runner tests. Behaviour via FAKE_CLAUDE_MODE:
//   ok      init → text → tool_use → result(success, cost 0.0123)
//   hang    init, spawn a sleeping grandchild (pid → FAKE_CLAUDE_PIDFILE), never exit
//   budget  result subtype error_max_budget_usd
//   crash   stderr + exit 3
//   mcp     really connects to the MCP server from --mcp-config and calls tools from FAKE_CLAUDE_CALLS (JSON [[name,args],...])
// Always writes {argv, cwd, stdin, env subset} to FAKE_CLAUDE_ARGS if set.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const stdin = await new Promise((res) => {
  let s = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (s += d));
  process.stdin.on('end', () => res(s));
});
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (process.env.FAKE_CLAUDE_ARGS) {
  let mcpConfig = null;
  try { mcpConfig = JSON.parse(fs.readFileSync(arg('--mcp-config'), 'utf8')); } catch {}
  fs.writeFileSync(process.env.FAKE_CLAUDE_ARGS, JSON.stringify({ argv, cwd: process.cwd(), stdin, mcpConfig, jobId: process.env.MCAI_JOB_ID, toolTimeout: process.env.MCP_TOOL_TIMEOUT }));
}

out({ type: 'system', subtype: 'init', model: 'fake-opus', session_id: 'fake', tools: ['Read', 'Task', 'mcp__mcai__build'], mcp_servers: [{ name: 'mcai', status: 'connected' }] });

if (mode === 'hang') {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' });
  if (process.env.FAKE_CLAUDE_PIDFILE) fs.writeFileSync(process.env.FAKE_CLAUDE_PIDFILE, String(child.pid));
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Thinking very hard about this…' }] } });
  process.on('SIGTERM', () => {}); // ignore SIGTERM → runner must SIGKILL
  setInterval(() => {}, 1000);
} else if (mode === 'crash') {
  process.stderr.write('Error: authentication failed (fake)\n');
  process.exit(3);
} else if (mode === 'budget') {
  out({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 0.5, duration_ms: 10, num_turns: 3 });
  process.exit(1);
} else if (mode === 'mcp') {
  const cfg = JSON.parse(fs.readFileSync(arg('--mcp-config'), 'utf8')).mcpServers.mcai;
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'fake-claude', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
  const calls = JSON.parse(process.env.FAKE_CLAUDE_CALLS ?? '[]');
  let n = 0;
  for (const [name, args] of calls) {
    const id = `tu_${++n}`;
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: `mcp__mcai__${name}`, input: args }] } });
    const r = await client.callTool({ name, arguments: args });
    const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: !!r.isError }] } });
  }
  await client.close();
  out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.042, duration_ms: 99, num_turns: calls.length, result: 'built' });
} else {
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'I will build a hut.' }, { type: 'tool_use', id: 't1', name: 'mcp__mcai__build', input: { ops: [{ op: 'fill' }, { op: 'set' }], label: 'walls' } }] } });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Task', input: { subagent_type: 'landscaper', description: 'garden' } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'garden done' }] }] } });
  out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.0123, duration_ms: 42, num_turns: 2, result: 'done' });
}
