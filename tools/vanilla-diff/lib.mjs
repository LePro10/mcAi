// Shared helpers for tools/vanilla-diff.mjs: RNG, typed arrays, a fake engine that drives the
// real 26.3 test server (tools/testserver.sh) through the mod's WebSocket bridge, and the
// test-server lifecycle (lock file, private MCAI_HOME, private port).
//
// Isolation (the user's real game must never notice):
//  * the test server is started with MCAI_HOME=~/.mcai-tools/vanilla-diff/home, so the mod reads
//    OUR engine.json there — ~/.mcai/engine.json and tools/testserver/config/mcai.json are never
//    touched;
//  * $MCAI_HOME/config.json carries "commandAllowlist" (read by the mod's Bridge at server start)
//    so the harness may run setblock/fill/gamerule/forceload/time on the TEST server only;
//  * port: MCAI_TESTSERVER_PORT (default 25599, never the user's 25565);
//  * /tmp/mcai-testserver.lock serialises us with other agents using the same test server;
//  * we only ever stop a server that we started ourselves.
import { WebSocketServer } from '../../engine/node_modules/ws/wrapper.mjs';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
export const TOOLS_HOME = join(homedir(), '.mcai-tools', 'vanilla-diff');
export const LOCK = '/tmp/mcai-testserver.lock';
export const OVER = 'minecraft:overworld';

// ------------------------------------------------------------------ rng

/** mulberry32 */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (n) => Math.floor(next() * n);
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  next.chance = (p) => next() < p;
  return next;
}

// ------------------------------------------------------------------ typed arrays

export const b64 = (ta) => Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength).toString('base64');
export const fromB64 = (s, Ctor) => {
  const buf = Buffer.from(s ?? '', 'base64');
  const ab = new ArrayBuffer(buf.length);
  new Uint8Array(ab).set(buf);
  return new Ctor(ab);
};

export class Batch {
  constructor() { this.palette = []; this.index = new Map(); this.pos = []; this.st = []; }
  add(x, y, z, s) {
    let i = this.index.get(s);
    if (i === undefined) { i = this.palette.length; this.palette.push(s); this.index.set(s, i); }
    this.pos.push(x, y, z); this.st.push(i);
    return this;
  }
  get size() { return this.st.length; }
  wire() { return { palette: this.palette, positions: b64(Int32Array.from(this.pos)), states: b64(Uint16Array.from(this.st)) }; }
}

// ------------------------------------------------------------------ fake engine

export class FakeEngine {
  constructor() { this.socket = null; this.hello = null; this.pending = new Map(); this.nextId = 1; this.waiters = []; this.token = randomBytes(16).toString('hex'); }

  async listen() {
    this.wss = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 512 * 1024 * 1024, path: '/mod',
      verifyClient: ({ req }) => req.headers.authorization === `Bearer ${this.token}` });
    await new Promise((r) => this.wss.once('listening', r));
    this.port = this.wss.address().port;
    this.wss.on('connection', (ws) => {
      this.socket = ws;
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.re && this.pending.has(msg.re)) {
          const p = this.pending.get(msg.re);
          this.pending.delete(msg.re);
          clearTimeout(p.timer);
          p.resolve(msg);
        } else if (msg.type === 'hello') {
          this.hello = msg;
          if (msg.id) ws.send(JSON.stringify({ re: msg.id, ok: true, engineVersion: 'vanilla-diff' }));
          this.waiters.splice(0).forEach((f) => f(msg));
        } else if (msg.id) {
          // events/requests from the mod we do not handle (build_request …)
          ws.send(JSON.stringify({ re: msg.id, ok: false, error: 'vanilla-diff harness' }));
        }
      });
      ws.on('close', () => { if (this.socket === ws) this.socket = null; });
    });
    return this.port;
  }

  waitHello(ms) {
    if (this.hello) return Promise.resolve(this.hello);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('mod did not connect')), ms);
      this.waiters.push((m) => { clearTimeout(t); resolve(m); });
    });
  }

  request(type, payload = {}, timeoutMs = 120_000) {
    const id = `v${this.nextId++}`;
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('mod not connected'));
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${type} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.socket.send(JSON.stringify({ id, type, ...payload }));
    });
  }

  async setBlocks(batch, opts = {}) {
    const r = await this.request('set_blocks', { dimension: OVER, ...batch.wire(), updateShapes: !!opts.updateShapes, animate: 'none', maxPerTick: 1_000_000 }, 300_000);
    if (!r.ok) throw new Error(`set_blocks failed: ${r.error}`);
    if (r.failed?.length) {
      const f = r.failed.slice(0, 5).map((e) => `${batch.palette[batch.st[e.index]]}: ${e.reason}`);
      throw new Error(`set_blocks: ${r.failed.length} failed, e.g. ${f.join('; ')}`);
    }
    return r;
  }

  async getBlocks(box) {
    const r = await this.request('get_blocks', { dimension: OVER, box }, 300_000);
    if (!r.ok) throw new Error(`get_blocks failed: ${r.error}`);
    return new Volume(box, r.palette, fromB64(r.data, Uint16Array));
  }

  async command(command) {
    const r = await this.request('command', { command }, 30_000);
    return { ok: r.ok === true, output: r.output ?? r.error ?? '' };
  }

  async tick() {
    const r = await this.request('status', {}, 30_000);
    return r.tick;
  }

  /** wait until the server ticked at least n times */
  async waitTicks(n) {
    const t0 = await this.tick();
    for (;;) {
      await new Promise((r) => setTimeout(r, 50));
      if ((await this.tick()) >= t0 + n) return;
    }
  }

  close() { try { this.socket?.close(); } catch {} try { this.wss?.close(); } catch {} }
}

export class Volume {
  constructor(box, palette, data) { this.box = box; this.palette = palette; this.data = data;
    this.sx = box.max[0] - box.min[0] + 1; this.sz = box.max[2] - box.min[2] + 1; }
  inside(x, y, z) { const { min, max } = this.box; return x >= min[0] && x <= max[0] && y >= min[1] && y <= max[1] && z >= min[2] && z <= max[2]; }
  get(x, y, z) {
    if (!this.inside(x, y, z)) return undefined;
    const { min } = this.box;
    return this.palette[this.data[(y - min[1]) * this.sx * this.sz + (z - min[2]) * this.sx + (x - min[0])]];
  }
}

// ------------------------------------------------------------------ server lifecycle

const sh = (args, env = {}) => spawnSync(join(ROOT, 'tools/testserver.sh'), args, { env: { ...process.env, ...env }, encoding: 'utf8' });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function freePort(port) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '0.0.0.0', () => s.close(() => resolve(true)));
  });
}

function takeLock() {
  if (existsSync(LOCK)) {
    let info = {};
    try { info = JSON.parse(readFileSync(LOCK, 'utf8')); } catch {}
    if (info.pid && alive(info.pid) && info.pid !== process.pid) return info;
    rmSync(LOCK, { force: true }); // stale
  }
  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, owner: 'tools/vanilla-diff.mjs', since: new Date().toISOString() }), { flag: 'wx' });
  return null;
}

const SERVER_PID = join(ROOT, 'tools/testserver/server.pid');
const KEPT = 'tools/vanilla-diff.mjs (kept server)';
const serverPid = () => { try { return Number(readFileSync(SERVER_PID, 'utf8').trim()); } catch { return 0; } };

function writeEngineHome(engine) {
  const home = join(TOOLS_HOME, 'home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'engine.json'), JSON.stringify({ port: engine.port, token: engine.token, pid: process.pid, version: 'vanilla-diff' }), { mode: 0o600 });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ commandAllowlist: ['setblock', 'fill', 'gamerule', 'forceload', 'time', 'weather', 'clone', 'place'] }, null, 2));
  return home;
}

/** lifecycle handle shared by startServer/attachServer */
function handle(engine, hello, { owned, log }) {
  let done = false;
  const release = (keep) => {
    if (done) return;
    done = true;
    engine.close();
    if (keep) {
      writeFileSync(LOCK, JSON.stringify({ pid: serverPid(), owner: KEPT, since: new Date().toISOString() }));
      log?.(`  test server kept running (pid ${serverPid()}); stop it with: node tools/vanilla-diff.mjs --stop-server`);
      return;
    }
    if (owned) sh(['stop']);
    try { const o = JSON.parse(readFileSync(LOCK, 'utf8')); if (o.pid === process.pid || o.owner === KEPT) rmSync(LOCK, { force: true }); } catch {}
  };
  process.on('exit', () => release(false));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { release(false); process.exit(130); });
  return {
    engine,
    hello,
    async stop({ keep = false } = {}) {
      if (!keep && !done) { try { await restoreWorld(engine); } catch {} }
      release(keep);
    },
  };
}

/** Re-attach to a server a previous run kept (--keep-server). Returns null if there is none. */
export async function attachServer({ log = console.log } = {}) {
  let info;
  try { info = JSON.parse(readFileSync(LOCK, 'utf8')); } catch { return null; }
  if (info.owner !== KEPT || !info.pid || !alive(info.pid) || info.pid !== serverPid()) return null;
  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, owner: 'tools/vanilla-diff.mjs', server: info.pid, since: new Date().toISOString() }));
  const engine = new FakeEngine();
  await engine.listen();
  writeEngineHome(engine);
  log(`  re-attaching to the kept test server (pid ${info.pid}) …`);
  const hello = await engine.waitHello(60_000);
  log(`  mod connected: mod ${hello.modVersion}, mc ${hello.mcVersion}, ${Object.keys(hello.registry.blocks).length} blocks`);
  return handle(engine, hello, { owned: true, log });
}

/**
 * Acquire the lock, start the test server pointed at a fresh fake engine, wait for the mod.
 * Returns { engine, hello, stop({keep}) }.
 */
export async function startServer({ port = Number(process.env.MCAI_TESTSERVER_PORT) || 25599, lockWaitMs = 20 * 60_000, log = console.log } = {}) {
  const t0 = Date.now();
  for (;;) {
    const holder = takeLock();
    if (!holder) break;
    if (Date.now() - t0 > lockWaitMs) throw new Error(`test server lock held by ${JSON.stringify(holder)} (${LOCK})`);
    log(`  waiting for ${LOCK} (held by pid ${holder.pid}, ${holder.owner ?? '?'}) …`);
    await new Promise((r) => setTimeout(r, 15_000));
  }
  let started = false;
  const bail = () => {
    if (started) sh(['stop']);
    try { if (JSON.parse(readFileSync(LOCK, 'utf8')).pid === process.pid) rmSync(LOCK, { force: true }); } catch {}
  };
  try {
    // a server we did not start: wait until its owner stops it (we cannot re-point it)
    while (sh(['status']).status === 0) {
      if (Date.now() - t0 > lockWaitMs) throw new Error('the test server is running (started by someone else); not touching it');
      log('  test server is running (not ours) — waiting until it stops …');
      await new Promise((r) => setTimeout(r, 15_000));
    }
    if (!(await freePort(port))) throw new Error(`port ${port} is busy; set MCAI_TESTSERVER_PORT`);
    const engine = new FakeEngine();
    await engine.listen();
    const home = writeEngineHome(engine);
    log(`  starting tools/testserver.sh (port ${port}, MCAI_HOME=${home}, fake engine :${engine.port}) …`);
    started = true;
    const r = sh(['start'], { MCAI_HOME: home, MCAI_TESTSERVER_PORT: String(port), MCAI_TESTSERVER_XMX: process.env.MCAI_TESTSERVER_XMX || '2G' });
    if (r.status !== 0) {
      // testserver.sh gives up after 120 s; on a loaded machine the boot can take longer
      if (sh(['status']).status !== 0) throw new Error(`testserver start failed: ${r.stderr || r.stdout}`);
      log('  (boot slower than testserver.sh waits — still waiting for the mod)');
    }
    const hello = await engine.waitHello(10 * 60_000);
    log(`  mod connected: mod ${hello.modVersion}, mc ${hello.mcVersion}, ${Object.keys(hello.registry.blocks).length} blocks`);
    return handle(engine, hello, { owned: true, log });
  } catch (e) {
    bail();
    throw e;
  }
}

let forceloaded = null;
const savedRules = new Map();
// [rule, test value, vanilla default] — restored to the value found (or the default if the value
// found is our own test value, e.g. after an interrupted run)
const RULES = [
  ['minecraft:block_drops', 'false', 'true'],
  ['minecraft:random_tick_speed', '0', '3'], // no vine/grass spread, crop growth, leaf decay
  ['minecraft:advance_time', 'false', 'true'], // mushrooms depend on light: keep it noon
  ['minecraft:spawn_mobs', 'false', 'true'],
  ['minecraft:advance_weather', 'false', 'true'],
  ['minecraft:fire_spread_radius_around_player', '128', '128'],
];

/** undo prepareWorld (game rules back to the values found, forceload removed) */
export async function restoreWorld(engine) {
  for (const [rule, value] of savedRules) await engine.command(`gamerule ${rule} ${value}`);
  savedRules.clear();
  if (forceloaded) await engine.command(`forceload remove ${forceloaded.x0} ${forceloaded.z0} ${forceloaded.x1} ${forceloaded.z1}`);
  forceloaded = null;
}

/** world setup for deterministic survival tests (26.3 game-rule ids) */
export async function prepareWorld(engine, area) {
  const out = [];
  for (const [rule, value, def] of RULES) {
    const q = await engine.command(`gamerule ${rule}`);
    const m = /:\s*(\S+)\s*$/.exec(q.output ?? '');
    if (!savedRules.has(rule)) savedRules.set(rule, m && m[1] !== value ? m[1] : def);
    const res = await engine.command(`gamerule ${rule} ${value}`);
    out.push(`${rule} ${value}${res.ok ? '' : ` FAILED: ${res.output}`} (was ${m?.[1] ?? '?'})`);
  }
  for (const c of ['time set noon', 'weather clear']) { const res = await engine.command(c); if (!res.ok) out.push(`${c} FAILED: ${res.output}`); }
  if (area) {
    forceloaded = area;
    const res = await engine.command(`forceload add ${area.x0} ${area.z0} ${area.x1} ${area.z1}`);
    out.push(`forceload ${area.x0} ${area.z0} ${area.x1} ${area.z1}: ${res.ok ? 'ok' : res.output}`);
  }
  return out;
}
