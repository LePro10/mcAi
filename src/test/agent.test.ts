import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SimWorld } from '../sim/world.js';
import { SimHost, SimSiteWorld } from '../sim/host.js';
import { MockLlmServer } from '../sim/mock-llm.js';
import { Agent, TOOLS } from '../agent/agent.js';
import { LlmClient, configFromEnv, estimateCost, addUsage, ZERO_USAGE } from '../agent/llm.js';
import { buildSystemPrompt } from '../agent/prompt.js';
import { survey, sampleTerrain, place, groundLevel, buildSize, suggestOrigin, clearRadius } from '../daemon/site.js';
import { compile, getPrefab } from '../core/index.js';
import { SimWorld as _SimWorld } from '../sim/world.js';

function mkWorld(opts = {}) { return new SimWorld({ relief: 5, seaLevel: 64, seed: 7, ...opts }); }

// ── Site analysis ─────────────────────────────────────────────────────────

test('sampleTerrain reports the real height range', () => {
  const world = mkWorld();
  const site = new SimSiteWorld(world);
  const t = sampleTerrain(site, [0, 70, 0], 16);
  assert.equal(t.x1, -16);
  assert.equal(t.x2, 16);
  assert.equal(t.heights.length, 33 * 33);
  assert.ok(t.max > t.min, 'sloped terrain should show a range');
  assert.ok(t.avg >= t.min && t.avg <= t.max);
  assert.equal(t.heights[0], world.highestY(-16, -16, 94));
});

test('groundLevel is the median under a footprint, not an outlier', () => {
  const heights = [64, 64, 64, 64, 64, 64, 64, 200, 64];
  const t = { x1: 0, z1: 0, x2: 2, z2: 2, heights, min: 64, max: 200, avg: 79 };
  assert.equal(groundLevel(t, 0, 0, 2, 2), 64);
});

test('survey returns a compact, useful picture of the site', () => {
  const world = mkWorld();
  const site = new SimSiteWorld(world);
  const player = { name: 'Ada', position: [0, world.surfaceY(0, 0) + 1, 0] as [number, number, number], yaw: 0 };
  const s = survey(site, player, player.position, 24);

  assert.equal(s.player.name, 'Ada');
  assert.equal(s.player.facing, 'south');
  assert.equal(s.suggestedRotation, 0);
  assert.ok(s.ground.max >= s.ground.min);
  assert.equal(s.ground.slope, s.ground.max - s.ground.min);
  assert.ok(s.suggestedStyle.length > 0);
  assert.ok(Object.keys(s.nearby).length > 0, 'should report nearby blocks');
  assert.ok(Object.keys(s.nearby).length <= 8, 'nearby must stay compact');

  // The whole point: the survey has to be cheap to send to a model.
  const json = JSON.stringify(s);
  assert.ok(json.length < 1200, `survey is ${json.length} bytes, too verbose`);
});

test('survey suggests an origin in front of the player, on the ground', () => {
  const world = mkWorld();
  const site = new SimSiteWorld(world);
  for (const [yaw, facing, delta] of [
    [0, 'south', [0, 1]], [90, 'west', [-1, 0]], [180, 'north', [0, -1]], [270, 'east', [1, 0]],
  ] as const) {
    const player = { name: 'P', position: [0, world.surfaceY(0, 0) + 1, 0] as [number, number, number], yaw };
    const s = survey(site, player, player.position, 20);
    assert.equal(s.player.facing, facing);
    assert.equal(Math.sign(s.suggestedOrigin[0]), delta[0]);
    assert.equal(Math.sign(s.suggestedOrigin[2]), delta[1]);
    assert.equal(s.suggestedOrigin[1], world.surfaceY(s.suggestedOrigin[0], s.suggestedOrigin[2]) + 1);
  }
});

test('suggestOrigin and clearRadius stay inside the sampled area', () => {
  const world = mkWorld();
  const site = new SimSiteWorld(world);
  const player = { name: 'P', position: [0, 70, 0] as [number, number, number], yaw: 0 };
  const t = sampleTerrain(site, player.position, 32);
  const o = suggestOrigin(site, player, t, 'south');
  assert.ok(Math.abs(o[2]) <= 32);
  const r = clearRadius(site, o, t, 32);
  assert.ok(r >= 4 && r <= 32);
});

// ── Placement ─────────────────────────────────────────────────────────────

test('place centres a build on the requested point', () => {
  const bp = getPrefab('cottage')!;
  const b = place(bp, [100, 70, 200], { place: 'center' });
  const { min, max } = b.stats.bounds;
  assert.ok(Math.abs(Math.round((min[0] + max[0]) / 2) - 100) <= 1, `centre x is ${(min[0] + max[0]) / 2}`);
  assert.ok(Math.abs(Math.round((min[2] + max[2]) / 2) - 200) <= 1);
});

test('place corner mode puts the origin at the min corner', () => {
  const b = place({ parts: [{ op: 'box', at: [0, 0, 0], size: [5, 3, 5], block: 'stone' }] }, [10, 70, 10], { place: 'corner' });
  assert.deepEqual(b.stats.bounds.min, [10, 70, 10]);
});

test('place sits a build on the ground under its own footprint', () => {
  const world = mkWorld({ relief: 10, seed: 21 });
  const site = new SimSiteWorld(world);
  const terrain = sampleTerrain(site, [0, 70, 0], 48);
  const b = place(getPrefab('house')!, [0, 999, 0], { terrain, place: 'center' });

  const { min, max } = b.stats.bounds;
  const ground = groundLevel(terrain, min[0], min[2], max[0], max[2]);
  // The floor sits one above the ground; foundations run below it.
  assert.ok(Math.abs(min[1] - ground) < 12, `build base ${min[1]} vs ground ${ground}`);
  assert.notEqual(min[1], 999);
});

test('place applies rotation to geometry and block facings together', () => {
  const bp = { parts: [{ op: 'set' as const, at: [4, 0, 0] as [number, number, number], block: 'oak_stairs[facing=north]' }] };
  const b = place(bp, [0, 64, 0], { place: 'corner', rotate: 90 });
  assert.match(b.voxels[0].block, /facing=east/);
});

test('buildSize reports inclusive dimensions', () => {
  const b = compile({ parts: [{ op: 'box', at: [0, 0, 0], size: [7, 3, 5], block: 'stone' }] });
  assert.deepEqual(buildSize(b), [7, 3, 5]);
});

// ── Prompt ────────────────────────────────────────────────────────────────

test('the system prompt is small enough to cache cheaply', () => {
  const p = buildSystemPrompt();
  // Roughly 4 characters per token; the budget is about 2k tokens.
  assert.ok(p.length < 8000, `system prompt is ${p.length} chars`);
  assert.ok(p.length > 1500, 'the prompt should still teach the DSL');
});

test('the system prompt is byte-identical across calls, so caching hits', () => {
  assert.equal(buildSystemPrompt(), buildSystemPrompt());
});

test('the system prompt documents every op the validator accepts', () => {
  const p = buildSystemPrompt();
  for (const op of ['box', 'shell', 'walls', 'cylinder', 'sphere', 'roof', 'arch',
    'battlements', 'spiral', 'windows', 'door', 'scatter', 'foundation',
    'group', 'repeat', 'symmetry', 'prefab']) {
    assert.ok(p.includes(op), `prompt is missing the "${op}" op`);
  }
});

test('the tool surface stays small', () => {
  assert.equal(TOOLS.length, 3);
  const schemaBytes = JSON.stringify(TOOLS).length;
  assert.ok(schemaBytes < 4000, `tool schemas are ${schemaBytes} bytes`);
});

// ── Cost accounting ───────────────────────────────────────────────────────

test('estimateCost prices cached reads far below fresh input', () => {
  const fresh = estimateCost('claude-sonnet-5', { inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  const cached = estimateCost('claude-sonnet-5', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1e6, cacheWriteTokens: 0 });
  assert.ok(cached < fresh / 5, `cached ${cached} vs fresh ${fresh}`);
  assert.ok(fresh > 0);
});

test('estimateCost falls back for unknown models rather than returning zero', () => {
  assert.ok(estimateCost('some-new-model', { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 0, cacheWriteTokens: 0 }) > 0);
});

test('addUsage accumulates every field', () => {
  const a = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 };
  assert.deepEqual(addUsage(ZERO_USAGE, a), a);
  assert.deepEqual(addUsage(a, a), { inputTokens: 2, outputTokens: 4, cacheReadTokens: 6, cacheWriteTokens: 8 });
});

// ── Provider configuration ────────────────────────────────────────────────

test('configFromEnv detects the common providers', () => {
  assert.equal(configFromEnv({ ANTHROPIC_API_KEY: 'k' } as NodeJS.ProcessEnv)?.provider, 'anthropic');
  assert.equal(configFromEnv({ OPENAI_API_KEY: 'k' } as NodeJS.ProcessEnv)?.provider, 'openai');
  assert.equal(configFromEnv({ DEEPSEEK_API_KEY: 'k' } as NodeJS.ProcessEnv)?.baseUrl, 'https://api.deepseek.com');
  assert.equal(configFromEnv({} as NodeJS.ProcessEnv), null);
});

test('configFromEnv builds a usable Ollama base url', () => {
  const c = configFromEnv({ OLLAMA_HOST: 'http://localhost:11434/v1/' } as NodeJS.ProcessEnv);
  assert.equal(c?.baseUrl, 'http://localhost:11434', 'must not double up the /v1 the adapter appends');
});

test('explicit MCAI_ settings win over vendor keys', () => {
  const c = configFromEnv({
    ANTHROPIC_API_KEY: 'ignored',
    MCAI_PROVIDER: 'openai', MCAI_API_KEY: 'k', MCAI_MODEL: 'my-model', MCAI_BASE_URL: 'http://x',
  } as NodeJS.ProcessEnv);
  assert.equal(c?.provider, 'openai');
  assert.equal(c?.model, 'my-model');
  assert.equal(c?.baseUrl, 'http://x');
});

// ── Full agent loop against the simulator ─────────────────────────────────

async function runAgent(script: any[], request = 'build a castle', provider: 'openai' | 'anthropic' = 'openai') {
  const world = mkWorld();
  const host = new SimHost(world);
  const server = new MockLlmServer(script);
  const port = await server.listen();
  const llm = new LlmClient({ provider, model: 'mock-model', apiKey: 'k', baseUrl: `http://127.0.0.1:${port}` });
  const agent = new Agent(llm, host, { maxTurns: 6 });
  const result = await agent.run(request, 'Ada');
  await server.close();
  return { result, host, world, server };
}

test('agent surveys then builds, and the blocks actually land', async () => {
  const { result, host, world } = await runAgent([
    { text: 'Looking around.', toolCalls: [{ name: 'survey', args: { radius: 24 } }] },
    {
      text: 'Building.',
      toolCalls: [{
        name: 'build',
        args: {
          note: 'One tower, coming up.',
          blueprint: {
            name: 'test tower', palette: 'medieval',
            parts: [
              { op: 'foundation', at: [0, 0, 0], size: [9, 9], depth: 3, block: '@base' },
              { op: 'cylinder', at: [0, 0, 0], r: 4, h: 14, block: '@wall', hollow: true, thickness: 1 },
              { op: 'cone', at: [-1, 14, -1], r: 5, h: 6, block: '@roof' },
            ],
          },
        },
      }],
    },
  ]);

  assert.equal(result.ok, true, result.error ?? '');
  assert.equal(host.builds.length, 1);
  assert.ok(result.builds[0].blocks > 400, `only ${result.builds[0].blocks} blocks`);
  assert.ok(world.editedCount > 400);
  assert.equal(result.toolCalls, 2);
  assert.ok(result.usage.inputTokens > 0);
  assert.ok(result.costUsd > 0);
});

test('agent works identically through the Anthropic wire format', async () => {
  const { result, world } = await runAgent([
    { toolCalls: [{ name: 'survey', args: {} }] },
    { toolCalls: [{ name: 'prefab', args: { name: 'well' } }] },
  ], 'build a well', 'anthropic');
  assert.equal(result.ok, true, result.error ?? '');
  assert.ok(world.editedCount > 50);
});

test('an invalid blueprint comes back with the exact field to fix', async () => {
  const { result, server } = await runAgent([
    { toolCalls: [{ name: 'build', args: { blueprint: { parts: [{ op: 'box', at: [0, 0, 0] }] } } }] },
    { toolCalls: [{ name: 'build', args: { blueprint: { parts: [{ op: 'box', at: [0, 0, 0], size: [6, 4, 6], block: 'stone' }] } } }] },
  ]);
  assert.equal(result.ok, true, result.error ?? '');

  // The repair turn must have been told precisely what was wrong.
  const repairRequest = server.requests[1];
  const toolMessage = JSON.stringify(repairRequest).match(/parts\[0\]\.size/);
  assert.ok(toolMessage, 'the model should receive the failing field path');
});

test('agent reports failure honestly when it never builds', async () => {
  const { result } = await runAgent([{ text: 'I would rather not.' }]);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /without building/);
});

test('agent retries a transient provider error', async () => {
  const { result, server } = await runAgent([
    { status: 503 },
    { toolCalls: [{ name: 'prefab', args: { name: 'gazebo' } }] },
  ], 'build a gazebo');
  assert.equal(result.ok, true, result.error ?? '');
  assert.ok(server.requests.length >= 2, 'the failed call should have been retried');
});

test('agent gives up on a non-retryable provider error', async () => {
  const { result } = await runAgent([{ status: 401 }]);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /401/);
});

test('agent stops after a clean build instead of chatting on', async () => {
  const { result } = await runAgent([
    { toolCalls: [{ name: 'survey', args: {} }] },
    { toolCalls: [{ name: 'prefab', args: { name: 'watchtower' } }] },
    { text: 'this turn should never be requested' },
  ], 'build a watchtower');
  assert.equal(result.ok, true);
  assert.equal(result.turns, 2, 'a clean build must end the run');
});

test('an unknown prefab is reported, not silently ignored', async () => {
  const { result } = await runAgent([
    { toolCalls: [{ name: 'prefab', args: { name: 'space_elevator' } }] },
    { text: 'Could not build that.' },
  ]);
  assert.equal(result.ok, false);
});

test('the model is sent the cacheable system prompt every call', async () => {
  const { server } = await runAgent([
    { toolCalls: [{ name: 'survey', args: {} }] },
    { toolCalls: [{ name: 'prefab', args: { name: 'well' } }] },
  ], 'a well', 'anthropic');
  for (const req of server.requests) {
    assert.equal(req.system[0].cache_control.type, 'ephemeral');
    assert.equal(req.system[0].text, buildSystemPrompt());
  }
});

test('a whole build costs a sane number of tokens', async () => {
  const { result } = await runAgent([
    { toolCalls: [{ name: 'survey', args: {} }], usage: { input: 2400, output: 40 } },
    { toolCalls: [{ name: 'prefab', args: { name: 'castle' } }], usage: { input: 2900, output: 90 } },
  ], 'build a castle');
  const total = result.usage.inputTokens + result.usage.outputTokens;
  assert.ok(total < 12_000, `a castle should not cost ${total} tokens`);
  assert.ok(result.builds[0].blocks > 8000, 'and it should still be a real castle');
});

// ── Sitting on the ground ─────────────────────────────────────────────────

test('a building floor sits exactly one block above flat ground', () => {
  // Offsetting the origin by the build's own minimum raises the floor by the
  // depth of its foundation — every building on a plinth as tall as the
  // footings meant to be buried. A distinct floor material makes it checkable.
  const world = new SimWorld({ relief: 0, seaLevel: 64 });
  const terrain = sampleTerrain(new SimSiteWorld(world), [0, 70, 0], 40);

  const b = place({
    parts: [
      { op: 'foundation', at: [0, 0, 0], size: [7, 7], depth: 4, block: 'cobblestone' },
      { op: 'box', at: [0, 0, 0], size: [7, 1, 7], block: 'gold_block' },
      { op: 'walls', at: [0, 1, 0], size: [7, 4, 7], block: 'stone_bricks' },
    ],
  }, [0, 70, 0], { terrain, clearSite: false });

  const floorYs = new Set(b.voxels.filter((v) => v.block === 'gold_block').map((v) => v.y));
  assert.deepEqual([...floorYs], [65], `floor sits at ${[...floorYs]}, expected 65 on ground 64`);

  const wallYs = b.voxels.filter((v) => v.block.startsWith('stone_bricks')).map((v) => v.y);
  assert.equal(Math.min(...wallYs), 66, 'walls start directly on the floor');
});

test('a foundation reaches into the ground rather than resting on it', () => {
  const world = new SimWorld({ relief: 0, seaLevel: 64 });
  const terrain = sampleTerrain(new SimSiteWorld(world), [0, 70, 0], 40);
  const b = place(getPrefab('cottage')!, [0, 70, 0], { terrain, clearSite: false });
  const lowest = Math.min(...b.voxels.filter((v) => v.block !== 'air').map((v) => v.y));
  assert.ok(lowest < 64, `foundation stops at ${lowest}, never entering the ground at 64`);
});

test('foundation columns reach the ground on a slope', () => {
  const world = new SimWorld({ relief: 10, seaLevel: 64, seed: 17 });
  const terrain = sampleTerrain(new SimSiteWorld(world), [0, 70, 0], 48);

  // A bare pad, so every column tested is one the foundation is responsible
  // for — a roof overhang legitimately hangs, and would muddy the result.
  const b = place({
    parts: [{ op: 'foundation', at: [0, 0, 0], size: [15, 15], depth: 4, block: 'cobblestone' }],
  }, [0, 70, 0], { terrain, clearSite: false });

  const lowest = new Map<string, number>();
  for (const v of b.voxels) {
    if (v.block === 'air') continue;
    const k = `${v.x},${v.z}`;
    const cur = lowest.get(k);
    if (cur === undefined || v.y < cur) lowest.set(k, v.y);
  }
  assert.ok(lowest.size >= 15 * 15, 'the whole pad should be covered');

  let floating = 0;
  for (const [k, y] of lowest) {
    const [x, z] = k.split(',').map(Number);
    if (y > world.surfaceY(x, z)) floating++;
  }
  assert.equal(floating, 0, `${floating} of ${lowest.size} columns never reach the terrain`);
});

test('clearing the site removes what was standing there', () => {
  const world = new SimWorld({ relief: 0, seaLevel: 64 });
  const site = new SimSiteWorld(world);
  const terrain = sampleTerrain(site, [0, 70, 0], 40);

  const withClear = place(getPrefab('cottage')!, [0, 70, 0], { terrain, clearSite: true });
  const without = place(getPrefab('cottage')!, [0, 70, 0], { terrain, clearSite: false });

  const airOf = (b: typeof withClear) => b.voxels.filter((v) => v.block === 'air').length;
  assert.ok(airOf(withClear) > airOf(without) + 500, 'clearing must claim the airspace');

  // Everything inside the footprint above the floor is either the building or
  // air — nothing foreign can survive between them.
  const { min, max } = withClear.stats.bounds;
  const known = new Set<string>();
  for (const v of withClear.voxels) known.add(`${v.x},${v.y},${v.z}`);
  let uncovered = 0;
  for (let y = 65; y <= max[1]; y++)
    for (let z = min[2] + 1; z <= max[2] - 1; z++)
      for (let x = min[0] + 1; x <= max[0] - 1; x++) {
        if (!known.has(`${x},${y},${z}`)) uncovered++;
      }
  assert.equal(uncovered, 0, `${uncovered} positions left untouched inside the build`);
});

test('clearing does not dig out the ground under the build', () => {
  const world = new SimWorld({ relief: 0, seaLevel: 64 });
  const terrain = sampleTerrain(new SimSiteWorld(world), [0, 70, 0], 40);
  const b = place(getPrefab('cottage')!, [0, 70, 0], { terrain, clearSite: true });
  const airBelowFloor = b.voxels.filter((v) => v.block === 'air' && v.y < 65);
  assert.equal(airBelowFloor.length, 0, 'clearing must stay above the floor');
});

test('clearing does not change the texture detail of a small build', () => {
  // Air voxels are numerous and cheap; letting them drive the detail heuristic
  // would coarsen a cottage just because it stands in a tall clearing.
  const world = new SimWorld({ relief: 0, seaLevel: 64 });
  const terrain = sampleTerrain(new SimSiteWorld(world), [0, 70, 0], 40);
  const withClear = place(getPrefab('cottage')!, [0, 70, 0], { terrain, clearSite: true });
  const without = place(getPrefab('cottage')!, [0, 70, 0], { terrain, clearSite: false });

  const solids = (b: typeof withClear) =>
    Object.entries(b.stats.blockCounts).filter(([k]) => k !== 'air').sort();
  assert.deepEqual(solids(withClear), solids(without), 'the building itself must be identical');
});
