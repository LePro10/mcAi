#!/usr/bin/env node
// Integration test of the mcai mod's engine bridge against a REAL dedicated server
// (tools/testserver.sh). This script plays the engine: it listens on /mod, writes
// ~/.mcai/engine.json (an existing file is backed up and restored), waits for the mod to
// connect and then exercises every request type of ARCHITECTURE §5.
//
// Usage: node tools/mod-protocol-test.mjs [--start] [--skip-perf] [--perf-size N]
//   --start      start the test server if it is not running (tools/testserver.sh start)

import { WebSocketServer } from '../engine/node_modules/ws/wrapper.mjs';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const PERF_N = Number(args[args.indexOf('--perf-size') + 1]) || 2_000_000;
const HOME = process.env.MCAI_HOME || join(homedir(), '.mcai');
const ENGINE_JSON = join(HOME, 'engine.json');
const BACKUP = `${ENGINE_JSON}.protocol-test-backup`;
const TOKEN = randomBytes(16).toString('hex');

// ------------------------------------------------------------------ tiny test harness

const results = [];
let current = '';
function check(cond, what, detail = '') {
  results.push({ test: current, what, ok: !!cond, detail });
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
  return !!cond;
}
async function test(name, fn) {
  current = name;
  console.log(`\n# ${name}`);
  try {
    await fn();
  } catch (e) {
    check(false, 'threw', e.stack?.split('\n').slice(0, 3).join(' | ') ?? String(e));
  }
}

// ------------------------------------------------------------------ typed arrays

const b64 = (ta) => Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength).toString('base64');
const fromB64 = (s, Ctor) => {
  const buf = Buffer.from(s ?? '', 'base64');
  const ab = new ArrayBuffer(buf.length);
  new Uint8Array(ab).set(buf);
  return new Ctor(ab);
};

/** Sparse batch builder: add(x,y,z,state). */
class Batch {
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

let socket = null;
let hello = null;
let helloCount = 0;
let nextId = 1;
const pending = new Map();
const helloWaiters = [];

const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 512 * 1024 * 1024, path: '/mod',
  verifyClient: ({ req }) => req.headers.authorization === `Bearer ${TOKEN}` });
await new Promise((r) => wss.once('listening', r));
const PORT = wss.address().port;

wss.on('connection', (ws) => {
  socket = ws;
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.re && pending.has(msg.re)) {
      const p = pending.get(msg.re);
      pending.delete(msg.re);
      clearTimeout(p.timer);
      p.resolve(msg);
    } else if (msg.type === 'hello') {
      hello = msg;
      helloCount++;
      if (msg.id) ws.send(JSON.stringify({ re: msg.id, ok: true, engineVersion: 'protocol-test' }));
      helloWaiters.splice(0).forEach((f) => f(msg));
    }
  });
  ws.on('close', () => { if (socket === ws) socket = null; });
});

function request(type, payload = {}, timeoutMs = 60_000) {
  const id = `t${nextId++}`;
  return new Promise((resolve, reject) => {
    if (!socket) return reject(new Error('mod not connected'));
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${type} timed out`)); }, timeoutMs);
    pending.set(id, { resolve, timer });
    socket.send(JSON.stringify({ id, type, ...payload }));
  });
}
const waitHello = (ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('mod did not connect')), ms);
  helloWaiters.push((m) => { clearTimeout(t); resolve(m); });
});

async function getBlocks(box, extra = {}) {
  const r = await request('get_blocks', { dimension: 'minecraft:overworld', box, ...extra }, 120_000);
  if (!r.ok) throw new Error(`get_blocks failed: ${r.error}`);
  return { palette: r.palette, data: fromB64(r.data, Uint16Array), box };
}
const volIndex = (box, x, y, z) => {
  const sx = box.max[0] - box.min[0] + 1, sz = box.max[2] - box.min[2] + 1;
  return (y - box.min[1]) * sx * sz + (z - box.min[2]) * sx + (x - box.min[0]);
};
const stateAt = (vol, x, y, z) => vol.palette[vol.data[volIndex(vol.box, x, y, z)]];

// ------------------------------------------------------------------ engine.json

mkdirSync(HOME, { recursive: true, mode: 0o700 });
let restored = false;
if (existsSync(ENGINE_JSON)) renameSync(ENGINE_JSON, BACKUP);
function restore() {
  if (restored) return;
  restored = true;
  try { rmSync(ENGINE_JSON, { force: true }); } catch {}
  if (existsSync(BACKUP)) renameSync(BACKUP, ENGINE_JSON);
}
process.on('exit', restore);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { restore(); process.exit(130); });
writeFileSync(ENGINE_JSON, JSON.stringify({ port: PORT, token: TOKEN, pid: process.pid, version: 'protocol-test' }), { mode: 0o600 });
console.log(`fake engine on ws://127.0.0.1:${PORT}/mod (engine.json written; original backed up: ${existsSync(BACKUP)})`);

if (args.includes('--start')) execFileSync(join(ROOT, 'tools/testserver.sh'), ['start'], { stdio: 'inherit' });

// ------------------------------------------------------------------ tests

const OVER = 'minecraft:overworld';
const X0 = 1000, Z0 = 1000, Y0 = -60; // flat world: grass at y=-61, air above
const W = 100, H = 10;

await test('handshake: hello + registry dump', async () => {
  const t0 = Date.now();
  const h = hello ?? await waitHello(90_000);
  check(true, `mod connected after ${Date.now() - t0} ms`);
  const blocks = h.registry?.blocks ?? {};
  const n = Object.keys(blocks).length;
  check(n > 1000, `registry has ${n} blocks (> 1000)`);
  check(h.mcVersion === '26.3', `mcVersion ${h.mcVersion}`);
  check(h.serverType === 'dedicated', `serverType ${h.serverType}`);
  check(typeof h.modVersion === 'string' && typeof h.world === 'string', `modVersion ${h.modVersion}, world '${h.world}'`);
  const stairs = blocks['minecraft:oak_stairs'];
  check(JSON.stringify(stairs?.properties?.facing) === '["north","south","west","east"]', 'oak_stairs facing values in registry order');
  check(stairs?.default?.half === 'bottom' && stairs?.tags?.includes('minecraft:stairs'), 'oak_stairs defaults + tags');
  check(/^#[0-9a-f]{6}$/.test(blocks['minecraft:stone']?.mapColor ?? ''), `stone mapColor ${blocks['minecraft:stone']?.mapColor}`);
  check(blocks['minecraft:stone']?.solid === true && blocks['minecraft:oak_fence']?.solid === false, 'solid hints');
  // registry physics (ARCHITECTURE §5): computed from the real classes; must equal the bundled
  // engine/data/physics-26.3.json for vanilla (generated from the same 26.3 server by Probe.java)
  const ph = h.registry?.physics;
  const size = JSON.stringify(h.registry ?? {}).length, phSize = JSON.stringify(ph ?? {}).length;
  check(ph?.format === 1 && Array.isArray(ph.classes) && Object.keys(ph.blocks ?? {}).length === n,
    `physics format ${ph?.format}: ${ph?.classes?.length} classes for ${Object.keys(ph?.blocks ?? {}).length} blocks (${(phSize / 1024).toFixed(0)} kB of a ${(size / 1024).toFixed(0)} kB registry)`);
  if (ph) {
    const { Registry } = await import('../engine/src/core/registry.ts');
    const live = new Registry(h.registry);
    const bundled = new Registry({ version: h.registry.version, blocks: h.registry.blocks });
    let states = 0, diff = 0, example = '';
    for (const [id, info] of Object.entries(blocks)) {
      const names = Object.keys(info.properties).sort();
      const combos = names.reduce((acc, k) => acc.flatMap((a) => info.properties[k].map((v) => [...a, `${k}=${v}`])), [[]]);
      for (const c of combos) {
        const st = c.length ? `${id}[${c.join(',')}]` : id;
        states++;
        const a = live.physics(st)?.join(','), b = bundled.physics(st)?.join(',');
        if (a !== b) { diff++; example ||= `${st}: mod ${a} vs bundled ${b}`; }
      }
    }
    check(diff === 0, `hello physics = bundled physics for all ${states} states${diff ? ` — ${diff} differ, e.g. ${example}` : ''}`);
    check(live.physics('minecraft:oak_leaves[distance=7,persistent=true,waterlogged=false]')?.[0] === 0 && live.isFullSolid('minecraft:mud'), 'leaves: no sturdy faces; mud: full');
  }
  const ow = h.dimensions?.find((d) => d.id === OVER);
  check(ow && ow.minY === -64 && ow.maxY === 319 && ow.seaLevel != null, `overworld ${JSON.stringify(ow)}`);
  check(h.dimensions?.length === 3, `${h.dimensions?.length} dimensions`);
});

let firstPrev;   // previous of the 100k build
let built;       // volume read after the build

function build100k() {
  const b = new Batch();
  for (let y = 0; y < H; y++) for (let z = 0; z < W; z++) for (let x = 0; x < W; x++) {
    const X = X0 + x, Y = Y0 + y, Z = Z0 + z;
    let s = 'minecraft:air';
    if (y === 0) s = (x + z) % 7 === 0 ? 'minecraft:andesite' : 'minecraft:stone';
    else if (y === 1 && z % 10 === 0 && x < 90) s = 'minecraft:oak_fence';
    else if (y === 1 && x === 95) s = 'minecraft:cobblestone_wall';
    else if (y === 2 && z % 10 === 3) s = 'minecraft:glass_pane';
    else if (y === 1 && z % 10 === 5 && x % 10 === 5) s = 'minecraft:oak_stairs[facing=north,half=bottom,shape=outer_left,waterlogged=false]';
    else if (y === 3 && z === 50 && x >= 20 && x < 30) s = 'minecraft:spruce_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]';
    else if (y === 3 && z === 50 && x === 19) s = 'minecraft:spruce_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]';
    b.add(X, Y, Z, s);
  }
  // block entities: signs with text, a chest with items
  b.add(X0 + 2, Y0 + 5, Z0 + 2, 'minecraft:oak_sign[rotation=0,waterlogged=false]{front_text:{messages:["Hello","from mcAI","",""]}}');
  b.add(X0 + 3, Y0 + 5, Z0 + 2, 'minecraft:oak_sign[rotation=4]{front_text:{messages:[{text:"Red",color:"red"},"","",""],has_glowing_text:1b}}');
  b.add(X0 + 4, Y0 + 5, Z0 + 2, 'minecraft:chest[facing=south]{Items:[{Slot:0b,id:"minecraft:diamond",count:3}]}');
  return b;
}

await test('set_blocks: ~100k blocks incl. stairs/fences/walls/panes + block entities', async () => {
  const b = build100k();
  // reset the area first (the world persists between runs), so `previous` must be all air
  const clear = new Batch();
  for (let i = 0; i < b.size; i++) clear.add(b.pos[i * 3], b.pos[i * 3 + 1], b.pos[i * 3 + 2], 'minecraft:air');
  const c = await request('set_blocks', { dimension: OVER, ...clear.wire(), updateShapes: false }, 300_000);
  check(c.ok, `area cleared (${c.placed} blocks removed)`, c.error);
  const t0 = Date.now();
  const r = await request('set_blocks', { dimension: OVER, ...b.wire(), updateShapes: true, animate: 'layers' }, 300_000);
  const ms = Date.now() - t0;
  check(r.ok, `ok (${b.size} blocks in ${ms} ms, mod-side ${r.ms?.toFixed?.(0)} ms over ${r.ticks} ticks, ${r.shapeUpdates} shape updates)`, r.error);
  check(r.failed?.length === 0, `no failures`, JSON.stringify(r.failed?.slice(0, 3)));
  check(r.placed + r.unchanged === b.size, `placed ${r.placed} + unchanged ${r.unchanged} = ${b.size}`);
  const prev = { palette: r.previous.palette, states: fromB64(r.previous.states, Uint16Array) };
  check(prev.states.length === b.size, `previous has ${prev.states.length} entries`);
  check(prev.palette.length === 1 && prev.palette[0] === 'minecraft:air', `previous was all air: ${JSON.stringify(prev.palette.slice(0, 4))}`);
  firstPrev = { batch: b, prev };
});

await test('shape updates: fences/walls/panes connected, stairs reshaped', async () => {
  const box = { min: [X0, Y0, Z0], max: [X0 + W - 1, Y0 + H - 1, Z0 + W - 1] };
  built = await getBlocks(box);
  const fMid = stateAt(built, X0 + 5, Y0 + 1, Z0);
  check(fMid === 'minecraft:oak_fence[east=true,north=false,south=false,waterlogged=false,west=true]', 'middle fence connects east+west', fMid);
  const fEnd = stateAt(built, X0, Y0 + 1, Z0 + 10);
  check(fEnd === 'minecraft:oak_fence[east=true,north=false,south=false,waterlogged=false,west=false]', 'end fence connects east only', fEnd);
  const pane = stateAt(built, X0 + 50, Y0 + 2, Z0 + 3);
  check(/glass_pane\[east=true,north=false,south=false,waterlogged=false,west=true\]/.test(pane), 'glass pane connects', pane);
  const wall = stateAt(built, X0 + 95, Y0 + 1, Z0 + 50);
  check(/cobblestone_wall\[east=none,north=low,south=low,up=false,waterlogged=false,west=none\]/.test(wall), 'wall connects north/south (straight wall: no post)', wall);
  const lone = stateAt(built, X0 + 5, Y0 + 1, Z0 + 5);
  check(lone === 'minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]', 'lone stairs outer_left → straight', lone);
  const corner = stateAt(built, X0 + 20, Y0 + 3, Z0 + 50);
  check(/spruce_stairs\[facing=east,half=bottom,shape=(inner|outer)_(left|right)/.test(corner), 'stairs corner shape', corner);
  check(stateAt(built, X0 + 7, Y0, Z0) === 'minecraft:andesite' && stateAt(built, X0 + 1, Y0, Z0) === 'minecraft:stone', 'floor pattern');
  check(built.palette[0] === 'minecraft:air', 'palette[0] is air');
});

await test('block entities: sign text + chest items via get_blocks {blockEntities:true}', async () => {
  const box = { min: [X0 + 2, Y0 + 5, Z0 + 2], max: [X0 + 4, Y0 + 5, Z0 + 2] };
  const v = await getBlocks(box, { blockEntities: true });
  const s1 = stateAt(v, X0 + 2, Y0 + 5, Z0 + 2), s2 = stateAt(v, X0 + 3, Y0 + 5, Z0 + 2), c = stateAt(v, X0 + 4, Y0 + 5, Z0 + 2);
  check(/^minecraft:oak_sign\[rotation=0,waterlogged=false\]\{.*Hello.*from mcAI/.test(s1), 'sign 1 text', s1);
  check(/red/.test(s2) && /has_glowing_text:1b/.test(s2), 'sign 2 styled + glowing', s2);
  check(/^minecraft:chest\[facing=south,type=single,waterlogged=false\]\{.*minecraft:diamond/.test(c), 'chest items', c);
});

await test('get_blocks round-trip: copy the read volume elsewhere and read it back', async () => {
  const b = new Batch();
  const off = 300;
  const box = built.box;
  for (let y = box.min[1]; y <= box.max[1]; y++) for (let z = box.min[2]; z <= box.max[2]; z++) for (let x = box.min[0]; x <= box.max[0]; x++) {
    b.add(x + off, y, z, stateAt(built, x, y, z));
  }
  const r = await request('set_blocks', { dimension: OVER, ...b.wire(), updateShapes: false }, 300_000);
  check(r.ok && r.failed.length === 0, `copied ${b.size} blocks`, r.error);
  const copy = await getBlocks({ min: [box.min[0] + off, box.min[1], box.min[2]], max: [box.max[0] + off, box.max[1], box.max[2]] });
  let diff = 0, first = '';
  for (let i = 0; i < copy.data.length; i++) {
    if (copy.palette[copy.data[i]] !== built.palette[built.data[i]]) { if (!diff) first = `#${i}: ${built.palette[built.data[i]]} vs ${copy.palette[copy.data[i]]}`; diff++; }
  }
  check(diff === 0, `identical (${copy.data.length} blocks compared)`, first);
});

await test('previous states → undo restores the world exactly (incl. sign NBT)', async () => {
  const box = { min: [X0, Y0, Z0], max: [X0 + 9, Y0 + 5, Z0 + 9] };
  const before = await getBlocks(box, { blockEntities: true });
  const b = new Batch();
  for (let y = box.min[1]; y <= box.max[1]; y++) for (let z = box.min[2]; z <= box.max[2]; z++) for (let x = box.min[0]; x <= box.max[0]; x++) b.add(x, y, z, 'minecraft:oak_planks');
  const r = await request('set_blocks', { dimension: OVER, ...b.wire() }, 60_000);
  check(r.ok && r.placed === b.size, `overwrote ${r.placed} blocks`);
  const prevStates = fromB64(r.previous.states, Uint16Array);
  let mismatch = 0;
  let k = 0;
  for (let y = box.min[1]; y <= box.max[1]; y++) for (let z = box.min[2]; z <= box.max[2]; z++) for (let x = box.min[0]; x <= box.max[0]; x++) {
    if (r.previous.palette[prevStates[k++]] !== stateAt(before, x, y, z)) mismatch++;
  }
  check(mismatch === 0, `previous matches the pre-edit world (${k} entries)`);
  check(r.previous.palette.some((s) => s.includes('Hello')), 'previous carries the sign NBT');
  // undo = set previous at the same positions, no shape updates (states are already final)
  const u = await request('set_blocks', { dimension: OVER, palette: r.previous.palette, positions: b.wire().positions, states: r.previous.states, updateShapes: false }, 60_000);
  check(u.ok && u.failed.length === 0, `undo applied (${u.placed} placed)`);
  const after = await getBlocks(box, { blockEntities: true });
  let d = 0;
  for (let i = 0; i < after.data.length; i++) if (after.palette[after.data[i]] !== before.palette[before.data[i]]) d++;
  check(d === 0, 'world after undo == world before edit (block entities included)');
});

await test('heightmap', async () => {
  const r = await request('heightmap', { dimension: OVER, x0: X0 - 2, z0: Z0, x1: X0 + 2, z1: Z0 + 1, kind: 'surface' });
  const h = fromB64(r.data, Int16Array);
  check(r.ok && h.length === 10, `${h.length} columns`, r.error);
  check(h[0] === -61 && h[1] === -61, `outside the build: grass at y=-61 (${h[0]}, ${h[1]})`);
  check(h[2] === Y0 + 1, `fence column at x0: top y=${h[2]} (expected ${Y0 + 1})`);
  check(h[8] === Y0, `floor-only column: top y=${h[8]} (expected ${Y0})`);
  const o = await request('heightmap', { dimension: OVER, x0: X0 + 1, z0: Z0 + 1, x1: X0 + 1, z1: Z0 + 1, kind: 'ocean_floor' });
  check(o.ok && fromB64(o.data, Int16Array)[0] === Y0, 'ocean_floor kind');
});

await test('biomes', async () => {
  const r = await request('biomes', { dimension: OVER, box: { min: [X0, -64, Z0], max: [X0 + 31, 0, Z0 + 31] }, step: 8 });
  const d = fromB64(r.data, Uint16Array);
  check(r.ok && d.length === 4 * 9 * 4, `${d.length} samples, size ${JSON.stringify(r.size)}`, r.error);
  check(r.palette?.includes('minecraft:plains'), `palette ${JSON.stringify(r.palette)}`);
});

await test('players + entities + command allowlist', async () => {
  const p = await request('players');
  check(p.ok && Array.isArray(p.players), `players: ${p.players?.length} online`);
  const cases = [
    ['op Steve', false], ['stop', false], ['execute run say hi', false], ['summon minecraft:tnt 1000 -50 1000', false],
    ['kill @e', false], ['give @p diamond', false], ['say hello @a', false], ['time set day', false],
    [`summon armor_stand ${X0 + 52} ${Y0 + 1} ${Z0 + 50} {Passengers:[{id:"minecraft:tnt",fuse:80}]}`, false],
    [`summon minecart ${X0 + 52} ${Y0 + 1} ${Z0 + 50} {Passengers:[{id:'creeper'}]}`, false],
    [`summon item_frame ${X0 + 53} ${Y0 + 1} ${Z0 + 50} {Item:{id:"minecraft:diamond_sword",count:1}}`, true],
    [`summon armor_stand ${X0 + 51} ${Y0 + 1} ${Z0 + 50}`, true],
    [`particle minecraft:flame ${X0} ${Y0 + 2} ${Z0}`, true],
  ];
  // keep the test area loaded (no players online): console forceload — not an engine command
  execFileSync(join(ROOT, 'tools/testserver.sh'), ['cmd', `forceload add ${X0} ${Z0} ${X0 + W} ${Z0 + W}`]);
  await new Promise((r) => setTimeout(r, 1500));
  const stand0 = await request('command', { command: `summon armor_stand ${X0 + 50} ${Y0 + 1} ${Z0 + 50} {CustomName:"mcAI test"}` });
  for (const [cmd, allowed] of cases) {
    const r = await request('command', { command: cmd });
    // allowed = not rejected by the mod (the command itself may still fail, e.g. particles with no players online)
    if (allowed) check(!/rejected by the mcai mod/.test(r.output ?? '') && typeof r.ok === 'boolean', `allowed: ${cmd} (ok=${r.ok})`, r.output);
    else check(r.ok === false && /rejected/.test(r.output ?? ''), `rejected: ${cmd}`, r.output);
  }
  const bad = await request('command', { command: `summon armor_stand ${X0} ${Y0} ${Z0} {Invalid:` });
  check(bad.ok === false && bad.output.length > 0, 'failing command reports ok:false with output', bad.output?.slice(0, 80));
  check(stand0.ok, 'summon succeeded', stand0.output);
  const e = await request('entities', { dimension: OVER, box: { min: [X0 + 45, Y0, Z0 + 45], max: [X0 + 55, Y0 + 5, Z0 + 55] } });
  const stand = e.entities?.find((x) => x.id === 'minecraft:armor_stand' && x.name);
  check(stand && stand.name === 'mcAI test' && stand.pos.length === 3, `entities: ${JSON.stringify(stand)}`, e.error);
});

await test('invalid input handling (no crash, per-index failures)', async () => {
  const b = new Batch()
    .add(X0, Y0 + 8, Z0, 'minecraft:stone')
    .add(X0 + 1, Y0 + 8, Z0, 'minecraft:not_a_block')
    .add(X0 + 2, Y0 + 8, Z0, 'minecraft:oak_stairs[facing=up]')
    .add(X0 + 3, Y0 + 8, Z0, 'minecraft:stone[foo=bar]')
    .add(X0 + 4, Y0 + 8, Z0, 'minecraft:chest{Items:[broken')
    .add(X0 + 5, 400, Z0, 'minecraft:stone')
    .add(X0 + 6, Y0 + 8, Z0, 'minecraft:gold_block');
  const r = await request('set_blocks', { dimension: OVER, ...b.wire() });
  const idx = (r.failed ?? []).map((f) => f.index).sort();
  check(r.ok && JSON.stringify(idx) === '[1,2,3,4,5]', `failed indices ${JSON.stringify(idx)}`, r.error);
  check(r.placed === 2, `valid blocks still placed (${r.placed})`);
  console.log(`    reasons: ${(r.failed ?? []).map((f) => `${f.index}: ${f.reason}`).join(' | ').slice(0, 400)}`);
  const m = await request('set_blocks', { dimension: OVER, palette: ['minecraft:stone'], positions: b64(Int32Array.from([1, 2])), states: b64(Uint16Array.from([0])) });
  check(m.ok === false && /positions/.test(m.error), `malformed batch → error: ${m.error}`);
  const u = await request('no_such_request');
  check(u.ok === false && /unknown/.test(u.error), `unknown type → ${u.error}`);
  const d = await request('get_blocks', { dimension: 'minecraft:nowhere', box: { min: [0, 0, 0], max: [1, 1, 1] } });
  check(d.ok === false && /dimension/.test(d.error), `unknown dimension → ${d.error}`);
  const far = await request('get_blocks', { dimension: OVER, box: { min: [-2147483648, 0, 0], max: [2147483647, 0, 0] } });
  check(far.ok === false && /within/.test(far.error), `box beyond the world limit → ${far.error}`);
  const edge = await request('set_blocks', { dimension: OVER, ...new Batch().add(40_000_000, Y0 + 8, 0, 'minecraft:stone').wire() });
  check(edge.ok && edge.failed?.length === 1 && /outside the world/.test(edge.failed[0].reason), `position beyond the world border → per-index failure (no chunk load)`, edge.error ?? JSON.stringify(edge.failed));
  const hm = await request('heightmap', { dimension: OVER, x0: 40_000_000, z0: 0, x1: 40_000_001, z1: 0 });
  check(hm.ok === false && /within/.test(hm.error), `heightmap beyond the world limit → ${hm.error}`);
  // malformed envelopes must not stall the bridge
  socket.send(JSON.stringify({ re: { x: 1 }, ok: true }));
  socket.send(JSON.stringify({ type: { nested: true }, id: 'weird-type' }));
  socket.send('[1,2,3]');
  socket.send('not json');
  const s = await request('status');
  check(s.ok && s.tick > 0, `server still healthy (tick ${s.tick}, mspt ${s.mspt?.toFixed(2)})`);
});

await test('guarded blocks: command blocks / run_command signs only as exact copies (undo)', async () => {
  const Y = Y0 + 9;
  const cmdBlock = 'minecraft:repeating_command_block[conditional=false,facing=up]{Command:"say pwned",auto:1b}';
  const evilSign = 'minecraft:oak_sign[rotation=0,waterlogged=false]{front_text:{messages:[{text:"Click",click_event:{action:"run_command",command:"/op Steve"}},"","",""]}}';
  const b = new Batch()
    .add(X0 + 10, Y, Z0 + 10, cmdBlock)
    .add(X0 + 11, Y, Z0 + 10, evilSign)
    .add(X0 + 12, Y, Z0 + 10, 'minecraft:command_block[conditional=false,facing=up]')
    .add(X0 + 13, Y, Z0 + 10, 'minecraft:oak_sign[rotation=0,waterlogged=false]{front_text:{messages:["plain","","",""]}}');
  const r = await request('set_blocks', { dimension: OVER, ...b.wire(), updateShapes: false });
  const idx = (r.failed ?? []).map((f) => f.index).sort();
  check(r.ok && JSON.stringify(idx) === '[0,1]', `command block with data + run_command sign refused, empty command block + plain sign placed (failed ${JSON.stringify(idx)})`, r.error ?? r.failed?.[0]?.reason);
  // a guarded block that exists in the world (here: placed by the console) can be put back by undo
  const at = [X0 + 14, Y, Z0 + 10];
  execFileSync(join(ROOT, 'tools/testserver.sh'), ['cmd', `setblock ${at.join(' ')} minecraft:command_block{Command:"say from the operator"}`]);
  await new Promise((res) => setTimeout(res, 1500));
  const over = await request('set_blocks', { dimension: OVER, ...new Batch().add(...at, 'minecraft:stone').wire(), updateShapes: false });
  const prev = over.previous?.palette?.[fromB64(over.previous.states, Uint16Array)[0]] ?? '';
  check(over.ok && /command_block.*say from the operator/.test(prev), 'previous carries the operator\'s command block', prev);
  const undo = await request('set_blocks', { dimension: OVER, palette: over.previous.palette, positions: b64(Int32Array.from(at)), states: over.previous.states, updateShapes: false });
  check(undo.ok && undo.failed.length === 0 && undo.placed === 1, 'undo restores it (exact copy of a block mcAI saw)', JSON.stringify(undo.failed ?? undo.error));
  const v = await getBlocks({ min: at, max: at }, { blockEntities: true });
  check(/say from the operator/.test(v.palette[v.data[0]]), 'command block back in the world with its command');
});

await test('notify + job_update boss bar lifecycle', async () => {
  const n = await request('notify', { target: '@a', kind: 'chat', text: '{"text":"mcAI test","color":"gold"}' });
  check(n.ok && n.delivered === 0, `notify ok (delivered to ${n.delivered} players)`);
  const t = await request('notify', { target: 'Nobody', kind: 'title', text: 'Hi' });
  check(t.ok, 'notify title to offline player is harmless');
  const bad = await request('notify', { target: '@a', kind: 'hologram', text: 'x' });
  check(bad.ok === true || bad.ok === false, 'unknown kind does not break the bridge');
  const j = await request('job_update', { jobId: 'job-1', player: 'Steve', state: 'building', progress: 0.4, stage: 'walls', detail: '', costUsd: 0.12 });
  check(j.ok, 'job_update building');
  check((await request('status')).jobBars === 1, 'boss bar exists while building');
  await request('job_update', { jobId: 'job-1', player: 'Steve', state: 'done', progress: 1, stage: 'finished', detail: '', costUsd: 0.2 });
  await new Promise((r) => setTimeout(r, 4000));
  check((await request('status')).jobBars === 0, 'boss bar removed after done');
});

if (!args.includes('--skip-perf')) {
  await test(`performance: ${PERF_N.toLocaleString('en')} blocks in one set_blocks message`, async () => {
    const side = Math.ceil(Math.sqrt(PERF_N / 40));
    const b = new Batch();
    // fresh area each run (world files persist between runs)
    const PX = 4000 + (Math.floor(Date.now() / 1000) % 200) * 512, PZ = 4000;
    outer: for (let y = 0; y < 40; y++) for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) {
      if (b.size >= PERF_N) break outer;
      const s = y % 10 === 9 && (x % 4 === 0) ? 'minecraft:oak_fence' : ((x ^ z ^ y) & 3) === 0 ? 'minecraft:stone_bricks' : ((x + y) % 5 === 0 ? 'minecraft:glass' : 'minecraft:smooth_stone');
      b.add(PX + x, Y0 + y, PZ + z, s);
    }
    const wire = b.wire();
    const bytes = wire.positions.length + wire.states.length;
    const samples = [];
    let polling = true;
    const poll = (async () => {
      while (polling) {
        try { const s = await request('status', {}, 10_000); samples.push({ t: Date.now(), tick: s.tick, mspt: s.mspt }); } catch {}
        await new Promise((r) => setTimeout(r, 250));
      }
    })();
    // generate/load the chunks first so the timing below is pure placement
    const g0 = Date.now();
    await getBlocks({ min: [PX, Y0, PZ], max: [PX + side - 1, Y0 + 39, PZ + side - 1] });
    console.log(`    chunk generation + first read of the area: ${Date.now() - g0} ms`);
    await new Promise((r) => setTimeout(r, 600));
    const t0 = Date.now();
    const r = await request('set_blocks', { dimension: OVER, ...wire, updateShapes: true }, 600_000);
    const ms = Date.now() - t0;
    await new Promise((r) => setTimeout(r, 500));
    polling = false;
    await poll;
    check(r.ok && r.failed.length === 0, `placed ${r.placed?.toLocaleString('en')} (${(bytes / 1e6).toFixed(1)} MB message) in ${ms} ms round-trip; mod ${r.ms?.toFixed(0)} ms over ${r.ticks} ticks (place ${r.placeMs?.toFixed(0)} ms, shapes ${r.shapeMs?.toFixed(0)} ms, chunk waits ${r.chunkWaitTicks} ticks); ${r.shapeUpdates} shape updates`, r.error);
    const during = samples.filter((s) => s.t >= t0 && s.t <= t0 + ms);
    if (during.length >= 2) {
      const a = during[0], z = during[during.length - 1];
      const tps = (z.tick - a.tick) / ((z.t - a.t) / 1000);
      const maxMspt = Math.max(...during.map((s) => s.mspt));
      check(tps >= 18, `TPS during the build ${tps.toFixed(1)} (avg-mspt samples max ${maxMspt.toFixed(1)} ms)`);
      console.log(`    PERF: ${PERF_N} blocks, ${ms} ms, ${(PERF_N / (ms / 1000)).toFixed(0)} blocks/s, TPS ${tps.toFixed(1)}, max avg-mspt ${maxMspt.toFixed(1)}`);
    } else {
      check(false, 'not enough status samples during the build');
    }
    const v = await getBlocks({ min: [PX, Y0, PZ], max: [PX + side - 1, Y0 + 39, PZ + side - 1] });
    check(v.data.length >= PERF_N, `read back ${v.data.length.toLocaleString('en')} blocks`);
    const prevStates = fromB64(r.previous.states, Uint16Array);
    check(prevStates.length === PERF_N, `previous has ${prevStates.length.toLocaleString('en')} entries`);
  });
}

await test('engine disconnect mid-job: server survives, mod reconnects', async () => {
  const b = new Batch();
  for (let y = 0; y < 20; y++) for (let z = 0; z < 100; z++) for (let x = 0; x < 100; x++) b.add(6000 + x, Y0 + y, 6000 + z, 'minecraft:sandstone');
  const before = helloCount;
  socket.send(JSON.stringify({ id: 'abandoned', type: 'set_blocks', dimension: OVER, ...b.wire() }));
  await new Promise((r) => setTimeout(r, 300));
  socket.terminate();
  const h = await waitHello(90_000);
  check(h && helloCount === before + 1, 'mod reconnected and sent a new hello');
  const s = await request('status');
  check(s.ok && s.tick > 0, `server healthy after disconnect (queued tasks ${s.queuedTasks})`);
  await new Promise((r) => setTimeout(r, 3000));
  const v = await getBlocks({ min: [6099, Y0 + 19, 6099], max: [6099, Y0 + 19, 6099] });
  check(v.palette[v.data[0]] === 'minecraft:sandstone', 'abandoned job still completed consistently');
});

// ------------------------------------------------------------------ summary

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL [${f.test}] ${f.what} ${f.detail}`);
for (const ws of wss.clients) ws.close(1001, 'test finished');
wss.close();
restore();
process.exit(failed.length ? 1 : 0);
