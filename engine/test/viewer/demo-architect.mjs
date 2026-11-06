#!/usr/bin/env node
// Demo "architect": a stand-in for `claude -p` that really builds a small timber cottage through
// the engine's MCP tools, step by step, while emitting stream-json events (thoughts, tool calls,
// a subagent) — used to verify/showcase the web viewer without an API key.
//
//   MCAI_CLAUDE=test/viewer/demo-architect.mjs node src/cli.ts serve --sim --seed 7
//   (then start any build from the viewer)        DEMO_STEP_MS=1400 controls the pacing
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const argv = process.argv.slice(2);
const arg = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
await new Promise((res) => {
  process.stdin.on('data', () => {});
  process.stdin.on('end', res);
  process.stdin.resume();
});
const STEP = Number(process.env.DEMO_STEP_MS ?? 1400);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cfg = JSON.parse(fs.readFileSync(arg('--mcp-config'), 'utf8')).mcpServers.mcai;
const client = new Client({ name: 'demo-architect', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));

out({ type: 'system', subtype: 'init', model: 'demo-architect', session_id: 'demo', tools: ['Task', 'mcp__mcai__build'], mcp_servers: [{ name: 'mcai', status: 'connected' }] });
let n = 0;
const think = async (text) => {
  out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  await sleep(STEP * 0.6);
};
const call = async (name, args, parent) => {
  const id = `tu_${++n}`;
  out({ type: 'assistant', parent_tool_use_id: parent ?? null, message: { content: [{ type: 'tool_use', id, name: `mcp__mcai__${name}`, input: args }] } });
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  out({ type: 'user', parent_tool_use_id: parent ?? null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: text.slice(0, 2000), is_error: !!r.isError }] } });
  if (r.isError) process.stderr.write(`tool ${name} failed: ${text}\n`);
  await sleep(STEP);
  return text;
};
const box = (a, b) => ({ min: a, max: b });

await think('Studying the site first: where the ground is flat enough, what grows around it, and which way the entrance should face.');
await call('get_context', {});
await call('progress', { stage: 'Planning a timber cottage', percent: 6, phase: 'thinking' });
await think('Plan: a 13×11 cottage with a mossy cobblestone plinth, spruce walls in an oak-log frame, a steep dark-oak gable roof with a brick chimney, a lantern-lit porch and a small flower garden along a dirt path.');

await call('progress', { stage: 'Preparing the ground', percent: 12, phase: 'building' });
await call('build', { label: 'level the site', ops: [
  { op: 'clear', box: box([-9, 1, -19], [9, 16, 7]) },
  { op: 'fill', box: box([-9, -3, -19], [9, -1, 7]), block: 'dirt' },
  { op: 'fill', box: box([-9, 0, -19], [9, 0, 7]), block: 'grass_block' },
] });
await call('progress', { stage: 'Laying the foundation', percent: 22 });
await call('build', { label: 'foundation', ops: [
  { op: 'fill', box: box([-7, 0, -17], [7, 0, -5]), block: '75%cobblestone,25%mossy_cobblestone' },
  { op: 'fill', box: box([-6, 0, -16], [6, 0, -6]), block: 'spruce_planks' },
] });
await think('Walls next. Logs at the corners and as a ring beam, spruce planks between them, windows on every side so the interior gets light.');
await call('progress', { stage: 'Raising the timber frame', percent: 38 });
const corners = [[-6, -16], [6, -16], [-6, -6], [6, -6]];
await call('build', { label: 'walls', ops: [
  { op: 'fill', box: box([-6, 1, -16], [6, 4, -6]), block: 'spruce_planks', mode: 'walls' },
  ...corners.map(([x, z]) => ({ op: 'fill', box: box([x, 1, z], [x, 4, z]), block: 'oak_log' })),
  { op: 'fill', box: box([-6, 4, -16], [6, 4, -6]), block: 'stripped_oak_wood', mode: 'walls' },
  { op: 'set', positions: [[-4, 2, -6], [-3, 2, -6], [3, 2, -6], [4, 2, -6], [-4, 3, -6], [-3, 3, -6], [3, 3, -6], [4, 3, -6]], block: 'glass_pane' },
  { op: 'set', positions: [[-4, 2, -16], [-3, 2, -16], [3, 2, -16], [4, 2, -16], [-4, 3, -16], [-3, 3, -16], [3, 3, -16], [4, 3, -16]], block: 'glass_pane' },
  { op: 'set', positions: [[-6, 2, -12], [-6, 3, -12], [-6, 2, -10], [-6, 3, -10], [6, 2, -12], [6, 3, -12], [6, 2, -10], [6, 3, -10]], block: 'glass_pane' },
  { op: 'set', pos: [0, 1, -6], block: 'spruce_door[facing=south,half=lower,hinge=left]' },
] });
await call('progress', { stage: 'Raising the roof', percent: 55 });
await think('A gable roof along x with a one-block overhang; dark oak contrasts nicely with the spruce walls.');
await call('build', { label: 'roof', ops: [
  { op: 'roof', box: box([-6, 5, -16], [6, 5, -6]), style: 'gable', axis: 'x', stairs: 'dark_oak_stairs', slab: 'dark_oak_slab', ends: 'spruce_planks' },
  { op: 'fill', box: box([4, 5, -14], [4, 11, -14]), block: 'bricks' },
  { op: 'set', pos: [4, 12, -14], block: 'campfire[facing=north,lit=true,signal_fire=false,waterlogged=false]' },
] });

// a "subagent" handles the garden
const sub = `tu_${++n}`;
out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: sub, name: 'Task', input: { subagent_type: 'landscaper', description: 'path, garden and lanterns', prompt: 'Lay a dirt path to the door, a flower garden and two lantern posts.' } }] } });
await sleep(STEP * 0.5);
await call('progress', { stage: 'Landscaping the garden', percent: 72 }, sub);
const flowers = ['poppy', 'dandelion', 'cornflower', 'oxeye_daisy', 'allium', 'azure_bluet'];
const garden = [];
for (let z = -4; z <= 6; z++) for (const x of [-3, -2, 2, 3]) if ((x * 7 + z * 13) % 3 !== 0) garden.push([x, 1, z, flowers[Math.abs(x * 5 + z * 3) % flowers.length]]);
await call('build', { label: 'path & garden', ops: [
  { op: 'fill', box: box([-1, 0, -5], [1, 0, 7]), block: 'dirt_path' },
  { op: 'set', entries: garden },
  { op: 'fill', box: box([-8, 1, -4], [-5, 1, 3]), block: 'oak_fence', mode: 'walls' },
  { op: 'fill', box: box([-7, 0, -3], [-6, 0, 2]), block: 'farmland[moisture=7]' },
  { op: 'fill', box: box([-7, 1, -3], [-6, 1, 2]), block: 'wheat[age=7]' },
  { op: 'fill', box: box([2, 1, 5], [2, 2, 5]), block: 'oak_fence' },
  { op: 'fill', box: box([-2, 1, 5], [-2, 2, 5]), block: 'oak_fence' },
  { op: 'set', entries: [[2, 3, 5, 'lantern'], [-2, 3, 5, 'lantern'], [-1, 3, -5, 'lantern'], [1, 3, -5, 'lantern']] },
  { op: 'set', entries: [[-1, 2, -5, 'oak_fence'], [1, 2, -5, 'oak_fence'], [-1, 1, -5, 'oak_fence'], [1, 1, -5, 'oak_fence']] },
] }, sub);
out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: sub, content: [{ type: 'text', text: 'Garden, path and lantern posts done.' }] }] } });
await sleep(STEP * 0.5);

await call('progress', { stage: 'Furnishing the interior', percent: 86 });
await call('build', { label: 'interior', ops: [
  { op: 'set', entries: [[-4, 1, -15, 'crafting_table'], [-3, 1, -15, 'furnace[facing=south,lit=true]'], [4, 1, -15, 'red_bed[facing=north,part=foot,occupied=false]'],
    [0, 3, -15, 'wall_torch[facing=south]'], [-5, 3, -11, 'wall_torch[facing=east]'], [5, 3, -11, 'wall_torch[facing=west]'], [-4, 1, -8, 'barrel[facing=up,open=false]'], [-5, 1, -8, 'barrel[facing=up,open=false]'],
    [2, 1, -11, 'oak_fence'], [2, 2, -11, 'oak_pressure_plate'], [1, 1, -11, 'oak_stairs[facing=east]'], [3, 1, -11, 'oak_stairs[facing=west]']] },
] });
await think('Looking at it from the path: proportions work, the chimney breaks the roof line nicely, and the garden frames the entrance.');
await call('progress', { stage: 'Final review', percent: 96, phase: 'reviewing' });
await call('say', { text: 'Your cottage is ready — come on in!' });
await call('finish', {
  summary: 'Built a cozy timber cottage: mossy cobblestone plinth, spruce walls in an oak-log frame, dark-oak gable roof with a smoking brick chimney, plus a flower garden, wheat patch and lantern-lit path.',
  highlights: ['Smoking brick chimney (lit campfire)', 'Windows on all four sides', 'Lantern posts along the dirt path', 'Fenced wheat patch next to the flower garden'],
  suggestions: ['A "frame" op that draws log edges of a box would save four separate fills for corner posts.', 'render_view could return a quick low-res preview first to speed up the review loop.'],
});
await client.close();
out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.4213, duration_ms: 1000, num_turns: n, result: 'built a cottage' });
