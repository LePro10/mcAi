import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SimWorld } from '../sim/world.js';
import { SimRconServer } from '../sim/rcon-server.js';
import { RconClient, encode } from '../daemon/rcon.js';
import { Executor, parseAffected, solidBlockCount, type WorldReader } from '../daemon/executor.js';
import { compile, getPrefab, isAir } from '../core/index.js';

// ── Simulated world ───────────────────────────────────────────────────────

test('sim executes fill and reports the affected count', () => {
  const w = new SimWorld({ relief: 0, seaLevel: 64 });
  const r = w.execute('fill 0 70 0 4 70 4 stone');
  assert.equal(r.ok, true);
  assert.equal(r.affected, 25);
  assert.equal(w.getBlock(2, 70, 2), 'stone');
});

test('sim enforces the vanilla fill volume limit', () => {
  const w = new SimWorld({ relief: 0 });
  const r = w.execute('fill 0 0 0 99 99 99 stone');
  assert.equal(r.ok, false);
  assert.match(r.message, /maximum 32768/);
});

test('sim rejects unknown block ids the way a server does', () => {
  const w = new SimWorld({ relief: 0 });
  const r = w.execute('setblock 0 70 0 stone_brick');
  assert.equal(r.ok, false);
  assert.match(r.message, /Unknown block type/);
});

test('sim refuses unloaded positions when chunk loading is enforced', () => {
  const w = new SimWorld({ relief: 0, enforceChunkLoading: true });
  assert.equal(w.execute('setblock 500 70 500 stone').ok, false);
  w.execute('forceload add 500 500 500 500');
  assert.equal(w.execute('setblock 500 70 500 stone').ok, true);
});

test('sim clone copies a region and handles overlap', () => {
  const w = new SimWorld({ relief: 0 });
  w.execute('fill 0 70 0 2 70 2 gold_block');
  const r = w.execute('clone 0 70 0 2 70 2 10 70 10');
  assert.equal(r.ok, true);
  assert.equal(w.getBlock(11, 70, 11), 'gold_block');
});

test('sim terrain is varied and blocks stack sensibly', () => {
  const w = new SimWorld({ relief: 8, seaLevel: 64, seed: 3 });
  const heights = new Set<number>();
  for (let x = 0; x < 60; x++) heights.add(w.surfaceY(x, 0));
  assert.ok(heights.size > 3, 'terrain should not be flat');
  const y = w.surfaceY(10, 10);
  assert.equal(w.getBlock(10, y, 10), 'grass_block');
  assert.equal(isAir(w.getBlock(10, y + 1, 10)), true);
  assert.equal(w.getBlock(10, y - 1, 10), 'dirt');
  assert.equal(w.highestY(10, 10), y);
});

// ── RCON over a real socket ───────────────────────────────────────────────

test('rcon authenticates, runs commands and reports latency', async () => {
  const world = new SimWorld({ relief: 0 });
  const server = new SimRconServer(world, { password: 'secret' });
  const port = await server.listen();
  const client = new RconClient({ port, password: 'secret' });
  try {
    await client.connect();
    assert.equal(client.connected, true);
    const reply = await client.send('fill 0 70 0 2 70 2 stone');
    assert.match(reply, /Successfully filled 9/);
    assert.equal(client.stats.sent, 1);
    assert.equal(client.stats.received, 1);
  } finally {
    client.close();
    await server.close();
  }
});

test('rcon rejects a wrong password instead of hanging', async () => {
  const world = new SimWorld({ relief: 0 });
  const server = new SimRconServer(world, { password: 'right' });
  const port = await server.listen();
  const client = new RconClient({ port, password: 'wrong', connectTimeout: 2000 });
  try {
    await assert.rejects(() => client.connect(), /authentication failed/i);
  } finally {
    client.close();
    await server.close();
  }
});

test('rcon strips a leading slash from commands', async () => {
  const world = new SimWorld({ relief: 0 });
  const server = new SimRconServer(world, { password: 'p' });
  const port = await server.listen();
  const client = new RconClient({ port, password: 'p' });
  try {
    await client.connect();
    const reply = await client.send('/setblock 0 70 0 stone');
    assert.match(reply, /Changed the block/);
  } finally {
    client.close();
    await server.close();
  }
});

test('rcon preserves order and completes every pipelined command', async () => {
  const world = new SimWorld({ relief: 0 });
  const server = new SimRconServer(world, { password: 'p', latencyMs: 2 });
  const port = await server.listen();
  const client = new RconClient({ port, password: 'p', window: 16 });
  try {
    await client.connect();
    const commands = Array.from({ length: 60 }, (_, i) => `setblock ${i} 70 0 stone`);
    const replies = await client.sendAll(commands);
    assert.equal(replies.length, 60);
    assert.ok(replies.every((r) => /Changed the block/.test(r)));
    assert.equal(world.stats.blocksChanged, 60);
  } finally {
    client.close();
    await server.close();
  }
});

test('pipelining is materially faster than serial round trips', async () => {
  const world = new SimWorld({ relief: 0 });
  const server = new SimRconServer(world, { password: 'p', latencyMs: 4 });
  const port = await server.listen();
  const n = 40;

  const serialClient = new RconClient({ port, password: 'p', window: 1 });
  await serialClient.connect();
  const t0 = Date.now();
  for (let i = 0; i < n; i++) await serialClient.send(`setblock ${i} 70 0 stone`);
  const serialMs = Date.now() - t0;
  serialClient.close();

  const pipedClient = new RconClient({ port, password: 'p', window: 20 });
  await pipedClient.connect();
  const t1 = Date.now();
  await pipedClient.sendAll(Array.from({ length: n }, (_, i) => `setblock ${i} 71 0 stone`));
  const pipedMs = Date.now() - t1;
  pipedClient.close();
  await server.close();

  assert.ok(pipedMs * 2 < serialMs, `pipelined ${pipedMs}ms vs serial ${serialMs}ms`);
});

test('rcon reassembles fragmented replies', async () => {
  const world = new SimWorld({ relief: 0 });
  // Force fragmentation at a size our replies exceed.
  const server = new SimRconServer(world, { password: 'p', fragmentAt: 8 });
  const port = await server.listen();
  const client = new RconClient({ port, password: 'p' });
  try {
    await client.connect();
    const reply = await client.send('fill 0 70 0 3 70 3 stone');
    assert.match(reply, /Successfully filled 16 block\(s\)/);
  } finally {
    client.close();
    await server.close();
  }
});

test('rcon fails in-flight commands when the server disappears', async () => {
  const world = new SimWorld({ relief: 0 });
  const server = new SimRconServer(world, { password: 'p', latencyMs: 200 });
  const port = await server.listen();
  const client = new RconClient({ port, password: 'p' });
  await client.connect();
  const pending = client.send('setblock 0 70 0 stone');
  setTimeout(() => { void server.close(); }, 20);
  await assert.rejects(() => pending, /closed|not connected|ECONNRESET/i);
  client.close();
});

test('encode produces a well-formed packet', () => {
  const buf = encode(7, 2, 'hi');
  assert.equal(buf.readInt32LE(0), 12);
  assert.equal(buf.readInt32LE(4), 7);
  assert.equal(buf.readInt32LE(8), 2);
  assert.equal(buf.subarray(12, 14).toString(), 'hi');
  assert.equal(buf.length, 16);
});

// ── Executor ──────────────────────────────────────────────────────────────

function simRunner(world: SimWorld) {
  return {
    connected: true,
    async send(command: string): Promise<string> {
      return world.execute(command).message;
    },
  };
}

function simReader(world: SimWorld): WorldReader {
  return { getBlock: (x, y, z) => world.getBlock(x, y, z) };
}

test('parseAffected reads server replies and flags real errors', () => {
  assert.equal(parseAffected('Successfully filled 42 block(s)'), 42);
  assert.equal(parseAffected('Changed the block at 1, 2, 3'), 1);
  assert.equal(parseAffected('12 block(s) cloned'), 12);
  assert.equal(parseAffected('No blocks were filled'), 0);
  assert.equal(parseAffected('Marked 4 chunk(s) for force loading'), 0);
  assert.equal(parseAffected(''), 0);
  assert.equal(parseAffected("Unknown block type 'stone_brick'"), null);
  assert.equal(parseAffected('That position is not loaded'), null);
});

test('executor builds a prefab into the simulated world', async () => {
  const world = new SimWorld({ relief: 0, seaLevel: 64 });
  const build = compile(getPrefab('cottage')!, { origin: [0, 65, 0] });
  const ex = new Executor(simRunner(world), { batchPauseMs: 0 });

  const result = await ex.run(build, simReader(world));
  assert.equal(result.ok, true, `errors: ${result.errors.join(' | ')}`);
  assert.equal(result.failures, 0);
  assert.ok(result.blocksChanged > 300, `only ${result.blocksChanged} blocks changed`);
  assert.equal(result.commands, build.commands.length);
});

test('executor forceloads the footprint and releases it afterwards', async () => {
  const world = new SimWorld({ relief: 0, enforceChunkLoading: true });
  // Far from spawn: without forceload every command would be rejected.
  const build = compile(getPrefab('well')!, { origin: [4000, 65, 4000] });
  const ex = new Executor(simRunner(world), { batchPauseMs: 0 });
  const result = await ex.run(build, null);
  assert.equal(result.failures, 0, `errors: ${result.errors.join(' | ')}`);
  assert.ok(result.blocksChanged > 0);

  const releases = world.log.filter((l) => l.command.startsWith('forceload remove'));
  assert.ok(releases.length > 0, 'chunks must be released after the build');
});

test('a build without forceload fails far from spawn — the bug this fixes', async () => {
  const world = new SimWorld({ relief: 0, enforceChunkLoading: true });
  const build = compile(getPrefab('well')!, { origin: [4000, 65, 4000] });
  const ex = new Executor(simRunner(world), { batchPauseMs: 0, forceload: false });
  const result = await ex.run(build, null);
  assert.ok(result.failures > 0, 'the old behaviour silently lost every command');
});

test('undo restores the world exactly', async () => {
  const world = new SimWorld({ relief: 4, seaLevel: 64, seed: 9 });
  const build = compile(getPrefab('tower', { r: 4, h: 12 })!, { origin: [10, 66, 10] });
  const { min, max } = build.stats.bounds;

  const before: string[] = [];
  for (let y = min[1]; y <= max[1]; y++)
    for (let z = min[2]; z <= max[2]; z++)
      for (let x = min[0]; x <= max[0]; x++) before.push(world.getBlock(x, y, z));

  const ex = new Executor(simRunner(world), { batchPauseMs: 0 });
  const result = await ex.run(build, simReader(world));
  assert.ok(result.snapshot, 'a snapshot must be captured');
  assert.ok(result.blocksChanged > 500);

  const undone = await ex.undo(result.snapshot!);
  assert.equal(undone.failures, 0, `undo errors: ${undone.errors.join(' | ')}`);

  let i = 0, mismatches = 0;
  for (let y = min[1]; y <= max[1]; y++)
    for (let z = min[2]; z <= max[2]; z++)
      for (let x = min[0]; x <= max[0]; x++) {
        if (world.getBlock(x, y, z) !== before[i]) mismatches++;
        i++;
      }
  assert.equal(mismatches, 0, `${mismatches} blocks differ after undo`);
});

test('snapshot round-trips through its palette encoding', () => {
  const world = new SimWorld({ relief: 3, seed: 5 });
  const ex = new Executor(simRunner(world), {});
  const snap = ex.snapshot(simReader(world), [0, 60, 0], [7, 70, 7], 'test');
  assert.ok(snap);
  assert.ok(snap!.palette.length > 1, 'terrain should contain several block types');

  let i = 0;
  for (let y = 60; y <= 70; y++)
    for (let z = 0; z <= 7; z++)
      for (let x = 0; x <= 7; x++) {
        assert.equal(snap!.palette[snap!.data[i++]], world.getBlock(x, y, z));
      }
});

test('snapshot declines regions above its volume guard', () => {
  const world = new SimWorld({ relief: 0 });
  const ex = new Executor(simRunner(world), { maxSnapshotVolume: 100 });
  assert.equal(ex.snapshot(simReader(world), [0, 0, 0], [50, 50, 50], 'x'), null);
});

test('executor reports progress as it goes', async () => {
  const world = new SimWorld({ relief: 0 });
  const build = compile(getPrefab('house')!, { origin: [0, 65, 0] });
  const ex = new Executor(simRunner(world), { batchSize: 32, batchPauseMs: 0 });
  const seen: number[] = [];
  ex.on('progress', (p) => { if (p.phase === 'building') seen.push(p.done); });
  await ex.run(build, null);
  assert.ok(seen.length > 1, 'progress should be reported more than once');
  assert.equal(seen.at(-1), build.commands.length);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] > seen[i - 1], 'progress must advance');
});

test('cancelling stops the build partway', async () => {
  const world = new SimWorld({ relief: 0 });
  const build = compile(getPrefab('castle')!, { origin: [0, 65, 0] });
  const ex = new Executor(simRunner(world), { batchSize: 16, batchPauseMs: 1 });
  ex.on('progress', (p) => { if (p.done > 32) ex.cancel(); });
  const result = await ex.run(build, null);
  assert.equal(result.cancelled, true);
  assert.equal(result.ok, false);
  assert.ok(world.stats.commands < build.commands.length, 'cancel must stop early');
});

test('executor surfaces server errors instead of claiming success', async () => {
  const world = new SimWorld({ relief: 0 });
  const build = compile({ parts: [{ op: 'box', at: [0, 0, 0], size: [2, 1, 2], block: 'definitely_not_a_block' }] }, { origin: [0, 70, 0] });
  const ex = new Executor(simRunner(world), { batchPauseMs: 0 });
  const result = await ex.run(build, null);
  assert.equal(result.ok, false);
  assert.ok(result.failures > 0);
  assert.ok(result.errors.some((e) => /Unknown block type/.test(e)), result.errors.join('|'));
});

test('forceloadCommands tiles regions beyond the 256-chunk cap', () => {
  const one = Executor.forceloadCommands([0, 0, 0], [100, 10, 100], true);
  assert.equal(one.length, 1);
  const many = Executor.forceloadCommands([0, 0, 0], [2000, 10, 2000], true);
  assert.ok(many.length > 1, 'a huge region must be split');
  for (const cmd of many) {
    const [, , x1, z1, x2, z2] = cmd.split(' ').map((v, i) => (i >= 2 ? Number(v) : v)) as [string, string, number, number, number, number];
    const chunks = (Math.floor(x2 / 16) - Math.floor(x1 / 16) + 1) * (Math.floor(z2 / 16) - Math.floor(z1 / 16) + 1);
    assert.ok(chunks <= 256, `command covers ${chunks} chunks`);
  }
});

test('solidBlockCount ignores carved air', () => {
  const build = compile({
    parts: [
      { op: 'box', at: [0, 0, 0], size: [4, 4, 4], block: 'stone' },
      { op: 'clear', at: [1, 1, 1], size: [2, 2, 2] },
    ],
  });
  assert.equal(solidBlockCount(build), 64 - 8);
});

test('a full castle lands in the simulator without a single failure', async () => {
  const world = new SimWorld({ relief: 5, seaLevel: 64, seed: 11, enforceChunkLoading: true });
  const build = compile(getPrefab('castle')!, { origin: [0, 70, 0] });
  const ex = new Executor(simRunner(world), { batchPauseMs: 0 });
  const result = await ex.run(build, null);
  assert.equal(result.failures, 0, `errors: ${result.errors.join(' | ')}`);
  assert.ok(result.blocksChanged > 8000, `only ${result.blocksChanged} blocks placed`);
  assert.ok(result.commands < 2000, `${result.commands} commands is too many`);
});
