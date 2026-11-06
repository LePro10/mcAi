#!/usr/bin/env node
// Fake mcAI engine for client game tests (and manual UI testing): accepts the mod on /mod like
// the real engine, records what the mod sends, answers build_request/job_control/... with canned
// replies, and exposes a small HTTP control API so a test can inspect traffic and push messages.
//
//   node tools/fake-engine.mjs [--home <MCAI_HOME>] [--control-port 8799] [--port 0]
//
// Control API (127.0.0.1:<control-port>):
//   GET  /state                → { listening, connections, hellos, received: [mod → engine messages] }
//   POST /send  {type, ...}    → sends an engine → mod request to the newest connection, returns its answer
//   POST /clear                → forget received messages
//   POST /offline | /online    → stop / resume listening on /mod (engine.json removed / rewritten)
//   POST /exit                 → remove engine.json and exit

import { WebSocketServer } from '../engine/node_modules/ws/wrapper.mjs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const HOME = opt('--home', process.env.MCAI_HOME || join(homedir(), '.mcai'));
const CONTROL_PORT = Number(opt('--control-port', 8799));
const WANT_PORT = Number(opt('--port', 0));
const TOKEN = randomBytes(16).toString('hex');
const ENGINE_JSON = join(HOME, 'engine.json');

const received = [];
let hellos = 0;
let jobN = 0;
let nextId = 1;
const sockets = [];
const pending = new Map();
let wss = null;
const log = (...m) => console.log(new Date().toISOString().slice(11, 23), ...m);

function writeEngineJson(port) {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(ENGINE_JSON, JSON.stringify({ port, token: TOKEN, pid: process.pid, version: 'fake-engine' }), { mode: 0o600 });
}

function reply(ws, msg, payload) {
  if (msg.id) ws.send(JSON.stringify({ re: msg.id, ok: true, ...payload }));
}

function onModMessage(ws, msg) {
  if (msg.re && pending.has(msg.re)) {
    const p = pending.get(msg.re);
    pending.delete(msg.re);
    clearTimeout(p.timer);
    p.resolve(msg);
    return;
  }
  if (msg.type === 'hello') {
    hellos++;
    log(`hello from mod ${msg.modVersion} (${Object.keys(msg.registry?.blocks ?? {}).length} blocks, ${msg.serverType})`);
    received.push({ type: 'hello', serverType: msg.serverType, world: msg.world, mcVersion: msg.mcVersion });
    reply(ws, msg, { engineVersion: 'fake-engine' });
    return;
  }
  received.push(msg);
  log(`mod → ${msg.type} ${JSON.stringify(msg).slice(0, 300)}`);
  switch (msg.type) {
    case 'build_request': {
      // like the real engine: selection + 8 blocks margin, 2 below, ≥ 32 above the floor
      const s = msg.selection;
      const allowedBox = s ? { min: [s.min[0] - 8, s.min[1] - 2, s.min[2] - 8], max: [s.max[0] + 8, Math.max(s.max[1], s.min[1] + 32), s.max[2] + 8] } : null;
      reply(ws, msg, { jobId: `job-${++jobN}`, allowedBox, selection: s ?? null });
      break;
    }
    case 'job_control':
      reply(ws, msg, { message: `fake engine: ${msg.action} ok` });
      break;
    case 'player_reply':
      reply(ws, msg, { message: 'answer delivered' });
      break;
    case 'tool_request':
      reply(ws, msg, { message: `fake engine: ${msg.tool} ok` });
      break;
    default:
      if (msg.id) ws.send(JSON.stringify({ re: msg.id, ok: false, error: `fake engine: unknown type ${msg.type}` }));
  }
}

function startListening() {
  return new Promise((resolve) => {
    wss = new WebSocketServer({ host: '127.0.0.1', port: WANT_PORT, path: '/mod', maxPayload: 512 * 1024 * 1024,
      verifyClient: ({ req }) => req.headers.authorization === `Bearer ${TOKEN}` });
    wss.on('connection', (ws) => {
      sockets.push(ws);
      log(`mod connected (${sockets.length} open)`);
      ws.on('message', (d) => { try { onModMessage(ws, JSON.parse(d.toString())); } catch (e) { log('bad message', e.message); } });
      ws.on('close', () => { const i = sockets.indexOf(ws); if (i >= 0) sockets.splice(i, 1); log(`mod disconnected (${sockets.length} open)`); });
    });
    wss.once('listening', () => { writeEngineJson(wss.address().port); log(`listening on ws://127.0.0.1:${wss.address().port}/mod, engine.json in ${HOME}`); resolve(); });
  });
}

function stopListening() {
  rmSync(ENGINE_JSON, { force: true });
  for (const ws of [...sockets]) ws.terminate();
  sockets.length = 0;
  return new Promise((r) => (wss ? wss.close(() => { wss = null; r(); }) : r()));
}

function sendToMod(msg, timeoutMs = 30_000) {
  const ws = sockets[sockets.length - 1];
  if (!ws) return Promise.reject(new Error('mod not connected'));
  const id = `fe${nextId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${msg.type} timed out`)); }, timeoutMs);
    pending.set(id, { resolve, timer });
    ws.send(JSON.stringify({ ...msg, id }));
  });
}

const body = (req) => new Promise((r) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => r(s ? JSON.parse(s) : {})); });

createServer(async (req, res) => {
  const out = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  try {
    if (req.method === 'GET' && req.url === '/state') return out(200, { listening: !!wss, connections: sockets.length, hellos, received });
    if (req.method !== 'POST') return out(404, { error: 'not found' });
    if (req.url === '/send') return out(200, await sendToMod(await body(req)));
    if (req.url === '/clear') { received.length = 0; return out(200, { ok: true }); }
    if (req.url === '/offline') { await stopListening(); return out(200, { ok: true }); }
    if (req.url === '/online') { if (!wss) await startListening(); return out(200, { ok: true }); }
    if (req.url === '/exit') { out(200, { ok: true }); await stopListening(); setTimeout(() => process.exit(0), 50); return; }
    return out(404, { error: 'not found' });
  } catch (e) {
    return out(500, { error: e.message });
  }
}).listen(CONTROL_PORT, '127.0.0.1', () => log(`control API on http://127.0.0.1:${CONTROL_PORT}`));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { rmSync(ENGINE_JSON, { force: true }); process.exit(0); });
await startListening();
