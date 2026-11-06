#!/usr/bin/env node
// Manual viewer check in a real (headless) Chromium via the DevTools protocol — no npm deps
// beyond `ws`. Opens the viewer, collects console errors/exceptions, waits until the world is
// meshed, optionally runs JS steps, and saves a PNG screenshot.
//
//   node test/viewer/browser-check.mjs --url http://127.0.0.1:7878/ --out ../docs/renders/viewer.png \
//        [--browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] [--width 1600 --height 900]
//        [--wait 60000] [--eval "<js run after load>"] [--settle 2500]
// Exit code 1 on page errors or timeout.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';

const { values: a } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://127.0.0.1:7878/' },
    out: { type: 'string', default: 'viewer.png' },
    browser: { type: 'string' },
    width: { type: 'string', default: '1600' },
    height: { type: 'string', default: '900' },
    wait: { type: 'string', default: '60000' },
    settle: { type: 'string', default: '2500' },
    eval: { type: 'string', multiple: true },
    port: { type: 'string', default: '9339' },
  },
});

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Opera GX.app/Contents/MacOS/Opera',
  '/Applications/Opera.app/Contents/MacOS/Opera',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];
const browser = a.browser ?? CANDIDATES.find((p) => fs.existsSync(p));
if (!browser) {
  console.error('no Chromium-based browser found (pass --browser)');
  process.exit(2);
}
const W = Number(a.width), H = Number(a.height);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mcai-cdp-'));
const proc = spawn(browser, [
  '--headless=new', `--remote-debugging-port=${a.port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  `--window-size=${W},${H}`, '--hide-scrollbars', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
proc.stderr.on('data', (d) => (stderr += d));
const cleanup = () => {
  try {
    proc.kill('SIGKILL');
  } catch {}
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {}
};
process.on('exit', cleanup);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function json(p) {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${a.port}${p}`, { method: p.startsWith('/json/new') ? 'PUT' : 'GET' });
      if (r.ok) return await r.json();
    } catch {}
    await sleep(150);
  }
  throw new Error(`devtools endpoint ${p} not reachable`);
}

await json('/json/version');
const target = await json(`/json/new?about:blank`);
const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
await new Promise((r, j) => {
  ws.once('open', r);
  ws.once('error', j);
});
let seq = 0;
const pending = new Map();
const problems = [];
const logs = [];
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.j(new Error(`${m.error.message}`));
    else p.r(m.result);
    return;
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = m.params.args.map((x) => x.value ?? x.description ?? '').join(' ');
    logs.push(`[${m.params.type}] ${text}`);
    if (m.params.type === 'error') problems.push(`console.error: ${text}`);
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const e = m.params.exceptionDetails;
    problems.push(`exception: ${e.exception?.description ?? e.text} @ ${e.url ?? ''}:${e.lineNumber}`);
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    const t = m.params.entry.text;
    if (!/favicon/.test(t)) problems.push(`log: ${t} ${m.params.entry.url ?? ''}`);
  }
});
const send = (method, params = {}) =>
  new Promise((r, j) => {
    const id = ++seq;
    pending.set(id, { r, j });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: a.url });

const t0 = Date.now();
let state = null;
while (Date.now() - t0 < Number(a.wait)) {
  await sleep(500);
  try {
    state = await evaluate(`(() => { const m = window.mcai; if (!m) return null;
      const st = m.view.meshStats(); return { sections: st.sections, tris: st.tris, loading: !document.getElementById('loading').classList.contains('done'),
      connected: m.S.connected, jobs: m.S.jobs.size, gl: (() => { const g = m.view.renderer.getContext(); const e = g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER); })() }; })()`);
  } catch {
    state = null;
  }
  if (state && !state.loading && state.sections > 0) break;
}
console.log('state', JSON.stringify(state));
for (const e of a.eval ?? []) {
  const v = await evaluate(e);
  if (v !== undefined) console.log('eval →', JSON.stringify(v).slice(0, 2000));
}
await sleep(Number(a.settle));
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
fs.mkdirSync(path.dirname(path.resolve(a.out)), { recursive: true });
fs.writeFileSync(a.out, Buffer.from(shot.data, 'base64'));
console.log(`screenshot → ${path.resolve(a.out)} (${Math.round(shot.data.length * 0.75 / 1024)} KiB)`);
const perf = await evaluate(`(() => { const m = window.mcai; return m ? m.view.meshStats() : null; })()`).catch(() => null);
console.log('mesh', JSON.stringify(perf));
if (logs.length) console.log(logs.slice(-15).join('\n'));
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n` + problems.join('\n'));
}
ws.close();
cleanup();
process.exit(problems.length || !state || state.loading ? 1 : 0);
