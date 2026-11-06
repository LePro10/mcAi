import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import WebSocket from 'ws';
import { tmpHome, testConfig, FakeRunner, waitFor } from './helpers.ts';
import { Hub } from '../../src/server/hub.ts';
import { Registry } from '../../src/core/registry.ts';
import { b64encode, b64ToInt32, b64ToUint16 } from '../../src/server/protocol.ts';
import { paths } from '../../src/server/config.ts';

tmpHome();

interface FakeMod {
  ws: WebSocket;
  received: any[];
  handlers: Record<string, (m: any) => any>;
  request(type: string, payload: Record<string, unknown>): Promise<any>;
  close(): void;
}

let reqN = 0;
async function connectMod(hub: Hub, opts: { token?: string; hello?: boolean } = {}): Promise<FakeMod> {
  const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/mod`, { headers: { authorization: `Bearer ${opts.token ?? hub.token}` } });
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
    ws.once('unexpected-response', (_r, resp) => rej(new Error(`HTTP ${resp.statusCode}`)));
  });
  const mod: FakeMod = {
    ws,
    received: [],
    handlers: {},
    request(type, payload) {
      const id = `m${++reqN}`;
      ws.send(JSON.stringify({ id, type, ...payload }));
      return new Promise((resolve) => {
        const h = (d: WebSocket.RawData) => {
          const m = JSON.parse(d.toString());
          if (m.re === id) {
            ws.off('message', h);
            resolve(m);
          }
        };
        ws.on('message', h);
      });
    },
    close: () => ws.close(),
  };
  ws.on('message', async (d) => {
    const m = JSON.parse(d.toString());
    if (m.re) return;
    mod.received.push(m);
    const h = mod.handlers[m.type];
    if (h) {
      try {
        const r = await h(m);
        if (r !== undefined) ws.send(JSON.stringify({ re: m.id, ok: true, ...r }));
      } catch (e) {
        ws.send(JSON.stringify({ re: m.id, ok: false, error: (e as Error).message }));
      }
    } else if (m.type === 'job_update' || m.type === 'notify') ws.send(JSON.stringify({ re: m.id, ok: true }));
  });
  if (opts.hello !== false) {
    const r = await mod.request('hello', {
      modVersion: '0.1.0', mcVersion: '26.3', world: 'TestWorld', serverType: 'integrated',
      registry: Registry.loadDefault().data, dimensions: [{ id: 'minecraft:overworld', minY: -64, maxY: 319, seaLevel: 63 }],
    });
    assert.equal(r.ok, true);
    await waitFor(() => hub.mod.connected, 2000, 'hello');
  }
  return mod;
}

let hub: Hub;
let runner: FakeRunner;

before(async () => {
  runner = new FakeRunner();
  hub = new Hub({ config: testConfig(), port: 0, runner, log: () => {}, modOptions: { maxSetBlocksPerMessage: 1000, timeoutScale: 0.01 } });
  await hub.start();
});

after(async () => {
  await hub.stop();
});

test('engine.json is written with 0600 and removed on stop', async () => {
  const st = fs.statSync(paths.engineJson());
  assert.equal(st.mode & 0o777, 0o600);
  const j = JSON.parse(fs.readFileSync(paths.engineJson(), 'utf8'));
  assert.equal(j.port, hub.port);
  assert.equal(j.token, hub.token);
  assert.equal(j.pid, process.pid);
  const res = await fetch(`http://127.0.0.1:${hub.port}/api/status`);
  const s = (await res.json()) as any;
  assert.equal(s.backend, 'minecraft');
  assert.equal(s.mod.connected, false);
  // static viewer
  const html = await (await fetch(`http://127.0.0.1:${hub.port}/`)).text();
  assert.match(html, /mcAI/);
  const bad = await fetch(`http://127.0.0.1:${hub.port}/..%2f..%2fpackage.json`);
  assert.ok(bad.status === 403 || bad.status === 404);
});

test('rejects mod connections without the token', async () => {
  await assert.rejects(connectMod(hub, { token: 'nope', hello: false }), /401/);
});

test('ModBackend maps WorldBackend calls to protocol messages', async () => {
  const mod = await connectMod(hub);
  mod.handlers.get_blocks = (m) => {
    const b = m.box;
    const n = (b.max[0] - b.min[0] + 1) * (b.max[1] - b.min[1] + 1) * (b.max[2] - b.min[2] + 1);
    const data = new Uint16Array(n).fill(1);
    return { palette: ['minecraft:air', 'minecraft:stone'], data: b64encode(data) };
  };
  const placed: any[] = [];
  mod.handlers.set_blocks = (m) => {
    const pos = b64ToInt32(m.positions);
    const st = b64ToUint16(m.states);
    placed.push({ n: st.length, palette: m.palette, animate: m.animate, first: [pos[0], pos[1], pos[2]] });
    return { placed: st.length, unchanged: 0, failed: st.length > 600 ? [{ index: 1, reason: 'test' }] : [], previous: { palette: ['minecraft:air'], states: b64encode(new Uint16Array(st.length)) } };
  };
  mod.handlers.heightmap = (m) => {
    const n = (m.x1 - m.x0 + 1) * (m.z1 - m.z0 + 1);
    return { data: b64encode(new Int16Array(n).fill(70)) };
  };
  mod.handlers.players = () => ({ players: [{ name: 'Steve', uuid: 'u', pos: [1, 65, 2], yaw: 0, pitch: 0, dimension: 'minecraft:overworld' }] });
  mod.handlers.command = (m) => (m.command.startsWith('bad') ? { ok: false, output: 'Unknown command' } : { ok: true, output: 'done' });

  const be = hub.mod;
  const info = await be.info();
  assert.equal(info.name, 'TestWorld');
  assert.equal(info.maxY, 319);
  assert.ok(hub.registry().has('stone'));

  const v = await be.getBlocks({ min: [0, 0, 0], max: [2, 1, 2] });
  assert.equal(v.data.length, 18);
  assert.equal(v.palette[v.data[5]!], 'minecraft:stone');

  // 2500 blocks → 3 set_blocks messages of ≤ 1000
  const n = 2500;
  const positions = new Int32Array(n * 3);
  for (let i = 0; i < n; i++) positions.set([i, 64, 0], i * 3);
  const r = await be.setBlocks({ palette: ['minecraft:stone'], positions, states: new Uint16Array(n) }, { animate: 'layers' });
  assert.deepEqual(placed.map((p) => p.n), [1000, 1000, 500]);
  assert.equal(placed[1].first[0], 1000);
  assert.equal(placed[0].animate, 'layers');
  assert.equal(r.placed, 2500);
  assert.deepEqual(r.failed.map((f) => f.index), [1, 1001]);
  assert.equal(r.previous.states.length, 2500);
  assert.equal(r.previous.positions.length, 7500);

  const hm = await be.heightmap(0, 0, 3, 1);
  assert.equal(hm.data.length, 8);
  assert.equal(hm.data[7], 70);
  assert.equal((await be.players())[0]!.name, 'Steve');
  assert.deepEqual(await be.runCommand('say hi'), { ok: true, output: 'done' });
  assert.deepEqual(await be.runCommand('bad'), { ok: false, output: 'Unknown command' });

  // a request the mod never answers times out (timeoutScale 0.01 → 200 ms for entities)
  await assert.rejects(be.entities({ min: [0, 0, 0], max: [1, 1, 1] }), /did not answer/);
  mod.close();
  await waitFor(() => !hub.mod.connected, 2000, 'disconnect');
});

test('mod errors are surfaced; newer connection replaces older', async () => {
  const a = await connectMod(hub);
  a.handlers.players = () => {
    throw new Error('server busy');
  };
  await assert.rejects(hub.mod.players(), /server busy/);
  const closed = new Promise<number>((res) => a.ws.once('close', (code) => res(code)));
  const b = await connectMod(hub);
  assert.equal(await closed, 4001);
  b.handlers.players = () => ({ players: [] });
  assert.deepEqual(await hub.mod.players(), []);
  b.close();
  await waitFor(() => !hub.mod.connected, 2000, 'disconnect');
});

test('build_request creates a job, job_update flows back, cancel via job_control', async () => {
  const mod = await connectMod(hub);
  mod.handlers.players = () => ({ players: [] });
  const res = await mod.request('build_request', {
    player: { name: 'Alex', uuid: 'u2', pos: [10, 65, 10], yaw: 180, pitch: 0, dimension: 'minecraft:overworld' },
    prompt: 'a small hut', anchor: [10, 64, 0], facing: 'north', options: { mode: 'build' },
  });
  assert.equal(res.ok, true);
  assert.ok(res.jobId);
  const job = hub.jobs.get(res.jobId)!;
  assert.equal(job.player, 'Alex');
  await waitFor(() => mod.received.find((m) => m.type === 'job_update' && m.state === 'thinking'), 2000, 'job_update thinking');
  // second request for the same player is rejected while the first is active
  const dup = await mod.request('build_request', { player: { name: 'Alex', uuid: 'u2', pos: [0, 0, 0], yaw: 0, pitch: 0, dimension: 'minecraft:overworld' }, prompt: 'x', anchor: [0, 64, 0], facing: 'north' });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /already has an active job/);
  const c = await mod.request('job_control', { action: 'cancel', player: 'Alex' });
  assert.equal(c.ok, true);
  assert.equal(job.state, 'cancelled');
  await waitFor(() => mod.received.find((m) => m.type === 'job_update' && m.state === 'cancelled'), 2000, 'job_update cancelled');
  await waitFor(() => mod.received.find((m) => m.type === 'notify' && /cancelled/.test(m.text)), 2000, 'cancel chat');
  // player_reply without question
  const pr = await mod.request('player_reply', { player: 'Alex', jobId: job.id, text: 'yes' });
  assert.equal(pr.ok, true);
  assert.match(pr.message, /no question/);
  // unknown types are answered with an error
  const u = await mod.request('bogus', {});
  assert.equal(u.ok, false);
  mod.close();
  await waitFor(() => !hub.mod.connected, 2000, 'disconnect');
});
