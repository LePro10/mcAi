import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SimWorld } from '../sim/world.js';
import { SimPluginServer } from '../sim/plugin-server.js';
import { PluginBridge, facingFromMinecraftYaw } from '../daemon/bridge.js';
import { Executor } from '../daemon/executor.js';
import { survey, sampleTerrain, place } from '../daemon/site.js';
import { compile, getPrefab } from '../core/index.js';

async function withPlugin(
  run: (bridge: PluginBridge, plugin: SimPluginServer, world: SimWorld) => Promise<void>,
  worldOpts = {},
  pluginOpts = {},
) {
  const world = new SimWorld({ relief: 6, seaLevel: 64, seed: 5, ...worldOpts });
  const plugin = new SimPluginServer(world, pluginOpts);
  const port = await plugin.listen();
  const bridge = new PluginBridge({ url: `http://127.0.0.1:${port}`, token: plugin.token });
  try { await run(bridge, plugin, world); }
  finally { await plugin.close(); }
}

// ── Connection ────────────────────────────────────────────────────────────

test('the bridge reports what the server is running', async () => {
  await withPlugin(async (bridge) => {
    const info = await bridge.connect();
    assert.equal(info.ok, true);
    assert.equal(bridge.connected, true);
    assert.equal(info.minecraft, '1.21.4');
    assert.deepEqual(info.players, ['Steve']);
  });
});

test('a wrong token is rejected with something actionable', async () => {
  const world = new SimWorld({ relief: 0 });
  const plugin = new SimPluginServer(world, { token: 'right' });
  const port = await plugin.listen();
  const bridge = new PluginBridge({ url: `http://127.0.0.1:${port}`, token: 'wrong' });
  try {
    const info = await bridge.connect();
    assert.equal(info.ok, false);
    assert.match(info.error!, /token/i);
    assert.match(info.error!, /config\.yml/, 'it should say where to find the right one');
  } finally { await plugin.close(); }
});

test('an unreachable plugin explains itself rather than throwing', async () => {
  const bridge = new PluginBridge({ url: 'http://127.0.0.1:1', token: 'x' });
  const info = await bridge.connect();
  assert.equal(info.ok, false);
  assert.match(info.error!, /Cannot reach the mcAI plugin/);
  assert.match(info.error!, /plugin installed/);
});

// ── Batch execution ───────────────────────────────────────────────────────

test('a whole build goes out in one request per batch', async () => {
  await withPlugin(async (bridge, plugin, world) => {
    await bridge.connect();
    const results = await bridge.exec([
      'fill 0 70 0 4 70 4 stone',
      'setblock 2 71 2 gold_block',
      'fill 0 72 0 2 72 2 oak_planks',
    ]);
    assert.equal(results.length, 3);
    assert.equal(results[0].affected, 25);
    assert.equal(world.getBlock(2, 71, 2), 'gold_block');
    assert.deepEqual(plugin.batches, [3], 'three commands, one request');
  });
});

test('batching is what makes the plugin path fast', async () => {
  // 4ms of latency per request: serial sends pay it 60 times, a batch once.
  await withPlugin(async (bridge, plugin) => {
    await bridge.connect();
    const commands = Array.from({ length: 60 }, (_, i) => `setblock ${i} 70 0 stone`);

    const t0 = Date.now();
    for (const c of commands) await bridge.send(c);
    const serialMs = Date.now() - t0;

    const t1 = Date.now();
    await bridge.exec(commands.map((c) => c.replace('70', '71')));
    const batchMs = Date.now() - t1;

    assert.equal(plugin.batches.length, 61, '60 singles plus one batch');
    assert.ok(batchMs * 4 < serialMs, `batch ${batchMs}ms vs serial ${serialMs}ms`);
  }, {}, { latencyMs: 4 });
});

test('the executor uses batch execution when the transport offers it', async () => {
  await withPlugin(async (bridge, plugin, world) => {
    await bridge.connect();
    const build = compile(getPrefab('cottage')!, { origin: [0, 65, 0] });
    const ex = new Executor(bridge, { batchSize: 128, batchPauseMs: 0 });
    const result = await ex.run(build, null);

    assert.equal(result.failures, 0, result.errors.join(' | '));
    assert.ok(result.blocksChanged > 300);
    assert.ok(plugin.batches.length < 10, `${plugin.batches.length} requests for a whole cottage`);
    // The two forceload commands bracket the build and go through the same
    // transport, so the total is the build plus those.
    const forceloads = 2;
    assert.equal(plugin.batches.reduce((a, b) => a + b, 0), build.commands.length + forceloads);
    assert.ok(world.editedCount > 300);
  });
});

test('a failing command inside a batch is reported, and the rest still land', async () => {
  await withPlugin(async (bridge, world) => {
    await bridge.connect();
    const ex = new Executor(bridge, { batchPauseMs: 0, forceload: false });
    const build = compile({
      parts: [
        { op: 'box', at: [0, 0, 0], size: [3, 1, 3], block: 'stone' },
        { op: 'set', at: [1, 1, 1], block: 'definitely_not_a_block' },
      ],
    }, { origin: [0, 70, 0] });

    const result = await ex.run(build, null);
    assert.equal(result.ok, false);
    assert.equal(result.failures, 1, 'exactly the one bad command');
    assert.ok(result.blocksChanged >= 9, 'the good commands still ran');
    assert.ok(result.errors.some((e) => /Unknown block type/.test(e)));
  });
});

test('a plugin that dies mid-build fails the batch instead of hanging', async () => {
  const world = new SimWorld({ relief: 0 });
  const plugin = new SimPluginServer(world);
  const port = await plugin.listen();
  const bridge = new PluginBridge({ url: `http://127.0.0.1:${port}`, token: plugin.token, timeoutMs: 2000 });
  await bridge.connect();
  await plugin.close();

  const ex = new Executor(bridge, { batchPauseMs: 0, forceload: false });
  const build = compile({ parts: [{ op: 'box', at: [0, 0, 0], size: [3, 1, 3], block: 'stone' }] }, { origin: [0, 70, 0] });
  const result = await ex.run(build, null);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /Cannot reach/.test(e)), result.errors.join('|'));
});

// ── Bulk world reads ──────────────────────────────────────────────────────

test('one request loads a whole heightmap', async () => {
  await withPlugin(async (bridge, plugin, world) => {
    await bridge.connect();
    const before = bridge.stats.requests;
    const stats = await bridge.loadHeights([0, 70, 0], 20);
    assert.equal(bridge.stats.requests - before, 1, '41x41 columns in a single request');

    assert.ok(stats.max > stats.min, 'the sample should show relief');
    for (const [x, z] of [[0, 0], [-20, -20], [20, 20], [7, -13]] as Array<[number, number]>) {
      assert.equal(bridge.highestY(x, z), world.highestY(x, z), `height at ${x},${z}`);
    }
    void plugin;
  });
});

test('one request loads a whole region for the snapshot', async () => {
  await withPlugin(async (bridge, _plugin, world) => {
    await bridge.connect();
    const before = bridge.stats.requests;
    const count = await bridge.loadRegion([0, 60, 0], [7, 70, 7]);
    assert.equal(bridge.stats.requests - before, 1);
    assert.equal(count, 8 * 11 * 8);

    for (let y = 60; y <= 70; y += 5)
      for (const [x, z] of [[0, 0], [7, 7], [3, 5]] as Array<[number, number]>) {
        assert.equal(bridge.getBlock(x, y, z), world.getBlock(x, y, z), `block at ${x},${y},${z}`);
      }
  });
});

test('the cache is cleared between builds so it cannot go stale', async () => {
  await withPlugin(async (bridge, _plugin, world) => {
    await bridge.connect();
    await bridge.loadRegion([0, 64, 0], [3, 66, 3]);
    assert.ok(bridge.cacheSize > 0);
    const was = bridge.getBlock(1, 65, 1);

    world.execute('setblock 1 65 1 gold_block');
    assert.equal(bridge.getBlock(1, 65, 1), was, 'the cache still holds the old value');

    bridge.clearCache();
    assert.equal(bridge.cacheSize, 0);
    await bridge.loadRegion([0, 64, 0], [3, 66, 3]);
    assert.equal(bridge.getBlock(1, 65, 1), 'gold_block', 'and reloads the new one');
  });
});

// ── Undo through the bridge ───────────────────────────────────────────────

test('undo restores the world exactly through the plugin', async () => {
  await withPlugin(async (bridge, _plugin, world) => {
    await bridge.connect();
    const build = compile(getPrefab('tower', { r: 4, h: 12 })!, { origin: [10, 66, 10] });
    const { min, max } = build.stats.bounds;

    const before: string[] = [];
    for (let y = min[1]; y <= max[1]; y++)
      for (let z = min[2]; z <= max[2]; z++)
        for (let x = min[0]; x <= max[0]; x++) before.push(world.getBlock(x, y, z));

    // The snapshot reads through the bridge's cache, so the region has to be
    // pulled first — exactly what the daemon's prepare hook does.
    await bridge.loadRegion(min, max);

    const ex = new Executor(bridge, { batchPauseMs: 0 });
    const result = await ex.run(build, bridge);
    assert.ok(result.snapshot, 'a snapshot must be captured');
    assert.ok(result.blocksChanged > 400);

    const undone = await ex.undo(result.snapshot!);
    assert.equal(undone.failures, 0, undone.errors.join(' | '));

    let i = 0, mismatches = 0;
    for (let y = min[1]; y <= max[1]; y++)
      for (let z = min[2]; z <= max[2]; z++)
        for (let x = min[0]; x <= max[0]; x++) {
          if (world.getBlock(x, y, z) !== before[i]) mismatches++;
          i++;
        }
    assert.equal(mismatches, 0, `${mismatches} blocks differ after undo`);
  });
});

// ── Players, chat, siting ─────────────────────────────────────────────────

test('player lookup returns position and facing', async () => {
  await withPlugin(async (bridge, plugin) => {
    await bridge.connect();
    plugin.player = { name: 'Ada', position: [12, 70, -4], yaw: 90 };
    const p = await bridge.player('Ada');
    assert.equal(p?.name, 'Ada');
    assert.deepEqual(p?.position, [12, 70, -4]);
    assert.equal(p?.facing, 'west', 'yaw 90 faces west in the wire protocol');
    assert.equal(await bridge.player('Nobody'), null);
  });
});

test('minecraft yaw maps to the right cardinal direction', () => {
  // Wire protocol: 0 is south (+Z), increasing clockwise.
  assert.equal(facingFromMinecraftYaw(0), 'south');
  assert.equal(facingFromMinecraftYaw(90), 'west');
  assert.equal(facingFromMinecraftYaw(180), 'north');
  assert.equal(facingFromMinecraftYaw(270), 'east');
  assert.equal(facingFromMinecraftYaw(-90), 'east');
  assert.equal(facingFromMinecraftYaw(359), 'south');
});

test('chat can be aimed at one player or at everyone', async () => {
  await withPlugin(async (bridge, plugin) => {
    await bridge.connect();
    await bridge.say('to everyone');
    await bridge.say('just you', 'Steve');
    // An absent recipient means everyone; JSON drops the undefined field.
    assert.deepEqual(plugin.chat, [
      { message: 'to everyone' },
      { message: 'just you', player: 'Steve' },
    ]);
  });
});

test('the site analyser works off bridge data and sites a build correctly', async () => {
  await withPlugin(async (bridge, plugin, world) => {
    await bridge.connect();
    plugin.player = { name: 'Ada', position: [0, world.highestY(0, 0) + 1, 0], yaw: 0 };
    const player = (await bridge.player('Ada'))!;

    await bridge.loadHeights(player.position, 48);
    await bridge.loadRegion([-24, player.position[1] - 2, -24], [24, player.position[1] + 2, 24]);

    const site = survey(bridge, player, player.position, 24);
    assert.equal(site.player.facing, 'south');
    assert.ok(site.ground.max >= site.ground.min);
    assert.ok(Object.keys(site.nearby).length > 0, 'nearby blocks come from the region load');

    const terrain = sampleTerrain(bridge, player.position, 40);
    const build = place(getPrefab('cottage')!, site.suggestedOrigin, {
      terrain, rotate: site.suggestedRotation, clearSite: false,
    });

    // The floor sits one above the ground the plugin reported.
    const solid = build.voxels.filter((v) => v.block !== 'air');
    const lowest = Math.min(...solid.map((v) => v.y));
    const groundHere = world.highestY(build.stats.bounds.min[0], build.stats.bounds.min[2]);
    assert.ok(Math.abs(lowest - groundHere) < 10, `base ${lowest} vs ground ${groundHere}`);
  });
});

test('a full build lands through the plugin with no failures', async () => {
  await withPlugin(async (bridge, plugin, world) => {
    await bridge.connect();
    const build = compile(getPrefab('castle')!, { origin: [0, 70, 0] });
    const ex = new Executor(bridge, { batchSize: 512, batchPauseMs: 0 });
    const result = await ex.run(build, null);

    assert.equal(result.failures, 0, result.errors.join(' | '));
    assert.ok(result.blocksChanged > 8000, `only ${result.blocksChanged} blocks`);
    assert.ok(plugin.batches.length <= 5, `${plugin.batches.length} requests for a whole castle`);
    assert.ok(world.stats.failures === 0);
  }, { enforceChunkLoading: true });
});
