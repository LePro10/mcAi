#!/usr/bin/env node
// mcai — command line entry point.
//   mcai serve [--port N] [--sim [--seed N]]
//   mcai build "<prompt>" [--seed N] [--at x,y,z] [--facing north] [--size 48x40x48] [--out dir]
//   mcai render --box x1,y1,z1,x2,y2,z2 [--view iso_se] [--out file.png] [--sim --seed N]
//   mcai doctor [--smoke] | mcai jobs | mcai feedback   (most take --json)

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import type { Box, Facing, Vec3, WorldBackend } from './core/types.ts';
import { ENGINE_VERSION, AGENT_DIR, ConfigError, isPidAlive, loadConfig, mcaiHome, paths, readEngineInfo, type Config } from './server/config.ts';
import { Hub, parseBoxParam, parseSize, readFeedback } from './server/hub.ts';
import { worldView } from './server/tools/perception.ts';
import { groundY } from './server/terrain.ts';
import { batchBounds, boxUnion, boxVolume } from './core/volume.ts';
import { renderVolume, type RenderOptions } from './render/render.ts';
import { SimBackend } from './sim/sim-backend.ts';
import { Registry } from './core/registry.ts';
import type { Job, JobSnapshot } from './agent/jobs.ts';

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  dim: (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (tty ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (tty ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (tty ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s: string) => (tty ? `\x1b[36m${s}\x1b[0m` : s),
};

const HELP = `${c.bold('mcai')} ${ENGINE_VERSION} — AI architect for Minecraft

  mcai serve [--port 7878] [--sim [--seed N]]   start the engine (waits for the mod unless --sim)
  mcai build "<prompt>" [options]              headless end-to-end build in the simulation
       --seed N  --at x,y,z  --facing north|south|east|west  --size WxHxD (default 48x40x48)
       --out DIR (default ./mcai-out/<job>)  --model opus  --effort medium  --budget USD  --timeout MIN
  mcai render --box x1,y1,z1,x2,y2,z2 [--view iso_se] [--width 800 --height 600] [--out file.png] [--sim --seed N]
  mcai doctor [--smoke]                        check node, claude, ports, ~/.mcai, mod connection
  mcai jobs [--limit 20]                       recent jobs
  mcai feedback [--limit 20]                   the agents' improvement suggestions
  common: --json (machine readable output)
`;

function fail(msg: string, code = 1): never {
  console.error(c.red(`error: ${msg}`));
  process.exit(code);
}

function parseVec(s: string | undefined, what: string): Vec3 | undefined {
  if (!s) return undefined;
  const n = s.split(',').map(Number);
  if (n.length !== 3 || n.some((v) => !Number.isInteger(v))) fail(`${what} must be x,y,z integers`);
  return n as Vec3;
}

function num(s: string | undefined, what: string): number | undefined {
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) fail(`${what} must be a number`);
  return n;
}

function loadCfg(over: Partial<Config> = {}): Config {
  try {
    return loadConfig(over);
  } catch (e) {
    if (e instanceof ConfigError) fail(e.message);
    throw e;
  }
}

async function engineFetch(p: string, init?: RequestInit): Promise<Response | null> {
  const info = readEngineInfo();
  if (!info || !isPidAlive(info.pid)) return null;
  try {
    return await fetch(`http://127.0.0.1:${info.port}${p}`, { ...init, headers: { authorization: `Bearer ${info.token}`, ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(5000) });
  } catch {
    return null;
  }
}

const YAW: Record<Facing, number> = { south: 0, west: 90, north: 180, east: -90 };

function rotLocal(v: Vec3, facing: Facing): Vec3 {
  const [x, y, z] = v;
  switch (facing) {
    case 'east': return [-z, y, x];
    case 'south': return [-x, y, -z];
    case 'west': return [z, y, -x];
    default: return [x, y, z];
  }
}

// ------------------------------------------------------------------ serve

async function cmdServe(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { port: { type: 'string' }, sim: { type: 'boolean' }, seed: { type: 'string' } } });
  const cfg = loadCfg();
  let backend: WorldBackend | undefined;
  if (values.sim) {
    const seed = num(values.seed, '--seed') ?? 1;
    const sim = new SimBackend({ seed, name: `sim-${seed}`, persistDir: path.join(mcaiHome(), 'sim', `seed-${seed}`) });
    backend = sim;
  }
  const hub = new Hub({ config: cfg, backend, port: num(values.port, '--port') });
  await hub.start();
  console.log(`${c.green('●')} mcai engine ${ENGINE_VERSION} on ${c.bold(`http://127.0.0.1:${hub.port}`)}  ${c.dim(`token in ${paths.engineJson()}`)}`);
  console.log(values.sim ? `  simulation world (seed ${values.seed ?? 1}) — open the URL for the viewer` : '  waiting for Minecraft (mcai mod) on /mod …');
  hub.jobs.on('update', (j: Job) => console.log(c.dim(`  [${j.id}] ${j.state.padEnd(9)} ${j.stage}${j.detail ? ` — ${j.detail}` : ''}`)));
  let stopping = false;
  const stop = async () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(c.dim('\nshutting down…'));
    await hub.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// ------------------------------------------------------------------ build

export interface BuildOutcome {
  job: JobSnapshot;
  outDir: string;
  renders: string[];
}

export async function headlessBuild(opts: {
  prompt: string; seed?: number; at?: Vec3; facing?: Facing; size?: { x: number; y: number; z: number }; outDir?: string;
  config: Config; json?: boolean; quiet?: boolean; model?: string; effort?: string; budgetUsd?: number; timeoutMin?: number;
}): Promise<BuildOutcome> {
  const seed = opts.seed ?? 1;
  const facing = opts.facing ?? 'north';
  const sim = new SimBackend({ seed, name: `sim-${seed}`, players: [] });
  let anchor = opts.at;
  if (!anchor) anchor = [0, await groundY(sim, Registry.loadDefault(), 0, 0), 0];
  const stand = rotLocal([0, 1, 12], facing);
  sim.addPlayer({ name: 'Builder', uuid: '00000000-0000-0000-0000-00000000b11d', pos: [anchor[0] + stand[0] + 0.5, anchor[1] + stand[1], anchor[2] + stand[2] + 0.5], yaw: YAW[facing], pitch: 20, dimension: 'minecraft:overworld' });
  const say = (s: string) => {
    if (!opts.quiet && !opts.json) console.log(s);
  };
  const hub = new Hub({ config: opts.config, backend: sim, port: 0, writeEngineJson: false, log: (l) => say(c.dim(`  engine: ${l}`)) });
  await hub.start();
  const t0 = Date.now();
  const stamp = () => c.dim(`${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s`);
  hub.jobs.on('agent', (_j: Job, ev) => {
    if (ev.kind === 'tool' || ev.kind === 'subagent_start' || ev.kind === 'subagent_end') say(`${stamp()} ${c.cyan('▸')} ${ev.line}`);
    else if (ev.kind === 'text') say(`${stamp()} ${c.dim('💭 ' + ev.line)}`);
    else if (ev.kind === 'tool_result' && ev.data?.isError) say(`${stamp()} ${c.yellow('  ! ' + ev.line)}`);
    else if (ev.kind === 'init') say(`${stamp()} ${c.green('●')} ${ev.line}`);
  });
  let lastStage = '';
  hub.jobs.on('update', (j: Job) => {
    const s = `${j.state} · ${j.stage}`;
    if (s !== lastStage) say(`${stamp()} ${c.bold(`[${j.state}]`)} ${j.stage} ${c.dim(`${Math.round(j.progress * 100)}%`)}`);
    lastStage = s;
  });
  let job: Job;
  try {
    job = await hub.submitJob({ prompt: opts.prompt, player: 'Builder', anchor, facing, size: opts.size, model: opts.model, effort: opts.effort, budgetUsd: opts.budgetUsd, timeoutMin: opts.timeoutMin }, 'cli');
  } catch (e) {
    await hub.stop();
    throw e;
  }
  say(`${c.green('●')} job ${c.bold(job.id)} — anchor ${anchor.join(',')} facing ${facing}, allowed ${job.allowedBox.min.join(',')}..${job.allowedBox.max.join(',')}`);
  const onSig = () => void hub.jobs.cancel(job.id, 'interrupted');
  process.on('SIGINT', onSig);
  await new Promise<void>((resolve) => {
    if (!job.active) return resolve();
    hub.jobs.on('end', (j: Job) => j === job && resolve());
  });
  process.off('SIGINT', onSig);

  const outDir = path.resolve(opts.outDir ?? path.join('mcai-out', job.id));
  fs.mkdirSync(outDir, { recursive: true });
  const renders: string[] = [];
  try {
    const ab = job.allowedBox;
    // frame the job's edits (merged undo record), else the allowed box
    let focus: Box = ab;
    const ids = new Set(job.undoIds);
    for (const rec of hub.history.list(job.player)) {
      if (!ids.has(rec.id)) continue;
      const b = batchBounds(rec.after);
      if (b) focus = focus === ab ? b : boxUnion(focus, b);
    }
    const m = 6;
    const rbox: Box = { min: [focus.min[0] - m, Math.max(ab.min[1], focus.min[1] - 3), focus.min[2] - m], max: [focus.max[0] + m, focus.max[1] + 2, focus.max[2] + m] };
    const vol = await sim.getBlocks(boxVolume(rbox) <= 8_000_000 ? rbox : ab);
    const assets = await hub.assets();
    const turns = { north: 0, east: 1, south: 2, west: 3 }[facing];
    for (const v of ['iso_se', 'iso_nw', 'front', 'top'] as const) {
      const ro: RenderOptions = { width: 1024, height: 768, focus: focus === ab ? undefined : focus, view: (v === 'top' ? 'top' : worldView(v, turns)) as RenderOptions['view'], shadows: true, time: 'day' };
      const png = await renderVolume(vol, assets, ro);
      const f = path.join(outDir, `${v}.png`);
      fs.writeFileSync(f, png);
      renders.push(f);
    }
  } catch (e) {
    say(c.yellow(`render failed: ${(e as Error).message}`));
  }
  try {
    fs.copyFileSync(job.logFile, path.join(outDir, 'job.jsonl'));
  } catch {}
  const snap = job.snapshot();
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ ...snap, renders, seed, version: ENGINE_VERSION }, null, 2));
  await hub.stop();
  return { job: snap, outDir, renders };
}

async function cmdBuild(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      sim: { type: 'boolean' }, seed: { type: 'string' }, at: { type: 'string' }, facing: { type: 'string' }, size: { type: 'string' },
      out: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, budget: { type: 'string' }, timeout: { type: 'string' }, json: { type: 'boolean' },
    },
  });
  const prompt = positionals.join(' ').trim();
  if (!prompt) fail('usage: mcai build "<prompt>" [--seed N] [--at x,y,z] [--facing north] [--size 48x40x48] [--out dir]');
  const facing = (values.facing ?? 'north') as Facing;
  if (!['north', 'south', 'east', 'west'].includes(facing)) fail('--facing must be north|south|east|west');
  const size = values.size ? parseSize(values.size) ?? fail('--size must be WxHxD, e.g. 48x40x48') : undefined;
  const cfg = loadCfg();
  const r = await headlessBuild({
    prompt, seed: num(values.seed, '--seed'), at: parseVec(values.at, '--at'), facing, size, outDir: values.out, config: cfg, json: values.json,
    model: values.model, effort: values.effort, budgetUsd: num(values.budget, '--budget'), timeoutMin: num(values.timeout, '--timeout'),
  });
  if (values.json) {
    console.log(JSON.stringify({ ...r.job, outDir: r.outDir, renders: r.renders }, null, 2));
  } else {
    const j = r.job;
    const ok = j.state === 'done';
    console.log(`\n${ok ? c.green('✔ done') : c.red(`✘ ${j.state}`)} ${c.dim(j.id)}  ${j.blocksChanged} blocks · ${j.toolCalls} tool calls · ${Math.round(j.durationMs / 1000)}s · $${j.costUsd.toFixed(3)}`);
    if (j.error) console.log(c.red(`  ${j.error}`));
    if (j.finished) {
      console.log(`  ${j.finished.summary}`);
      for (const h of j.finished.highlights) console.log(c.dim(`   • ${h}`));
      if (j.finished.suggestions.length) console.log(c.yellow(`  agent suggestions: ${j.finished.suggestions.length} (mcai feedback)`));
    }
    console.log(`  output: ${r.outDir}`);
  }
  process.exit(r.job.state === 'done' ? 0 : 2);
}

// ------------------------------------------------------------------ render

async function cmdRender(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { box: { type: 'string' }, view: { type: 'string' }, width: { type: 'string' }, height: { type: 'string' }, out: { type: 'string' }, sim: { type: 'boolean' }, seed: { type: 'string' }, time: { type: 'string' } },
  });
  let box: Box;
  try {
    box = parseBoxParam(values.box ?? null);
  } catch {
    fail('--box x1,y1,z1,x2,y2,z2 is required');
  }
  const view = values.view ?? 'iso_se';
  const out = path.resolve(values.out ?? `render-${view}.png`);
  const w = num(values.width, '--width') ?? 800, h = num(values.height, '--height') ?? 600;
  let png: Buffer;
  if (!values.sim) {
    const r = await engineFetch(`/api/render?box=${box.min.join(',')},${box.max.join(',')}&view=${view}&width=${w}&height=${h}&time=${values.time ?? 'day'}`);
    if (!r) fail('no running engine (start `mcai serve`) — or pass --sim to render a fresh simulation world');
    if (!r.ok) fail(`engine: ${(await r.text()).slice(0, 300)}`);
    png = Buffer.from(await r.arrayBuffer());
  } else {
    const sim = new SimBackend({ seed: num(values.seed, '--seed') ?? 1 });
    const vol = await sim.getBlocks(box);
    const { AssetStore } = await import('./assets/assets.ts');
    const assets = await AssetStore.open().catch(() => null);
    png = await renderVolume(vol, assets, { view: view as RenderOptions['view'], width: w, height: h, time: (values.time ?? 'day') as RenderOptions['time'] });
  }
  fs.writeFileSync(out, png);
  console.log(`${c.green('✔')} ${out} (${Math.round(png.length / 1024)} KB)`);
}

// ------------------------------------------------------------------ doctor

interface Check { name: string; ok: boolean | 'warn'; detail: string }

async function cmdDoctor(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { smoke: { type: 'boolean' }, json: { type: 'boolean' } } });
  const checks: Check[] = [];
  const add = (name: string, ok: boolean | 'warn', detail: string) => checks.push({ name, ok, detail });
  const [maj, min] = process.versions.node.split('.').map(Number);
  add('node', maj! > 22 || (maj === 22 && min! >= 18) ? true : false, `v${process.versions.node} (need ≥ 22.18)`);
  let cfg: Config | null = null;
  try {
    cfg = loadConfig();
    add('config', true, fs.existsSync(paths.config()) ? paths.config() : 'defaults (no ~/.mcai/config.json)');
  } catch (e) {
    add('config', false, (e as Error).message);
  }
  const claude = cfg?.claudePath ?? 'claude';
  const v = spawnSync(claude, ['--version'], { encoding: 'utf8', timeout: 15000 });
  add('claude', v.status === 0, v.status === 0 ? `${claude}: ${v.stdout.trim()}` : `'${claude}' not runnable: ${v.error?.message ?? v.stderr}`);
  try {
    const st = fs.statSync(mcaiHome());
    add('~/.mcai perms', (st.mode & 0o077) === 0 ? true : 'warn', `${mcaiHome()} mode ${(st.mode & 0o777).toString(8)}${(st.mode & 0o077) ? ' (should be 700: chmod 700 ~/.mcai)' : ''}`);
  } catch {
    add('~/.mcai', 'warn', `${mcaiHome()} does not exist yet (created on first start)`);
  }
  const info = readEngineInfo();
  if (info && isPidAlive(info.pid)) {
    const r = await engineFetch('/api/status');
    if (r?.ok) {
      const s = (await r.json()) as any;
      add('engine', true, `running pid ${info.pid} on port ${info.port}, backend ${s.backend}`);
      add('minecraft', s.mod?.connected ? true : s.backend === 'sim' ? 'warn' : 'warn', s.mod?.connected ? `mod ${s.mod.modVersion} · MC ${s.mod.mcVersion} · world ${s.mod.world}` : 'no mod connected');
    } else add('engine', false, `engine.json says pid ${info.pid} port ${info.port} but it does not answer`);
  } else {
    const port = cfg?.port ?? 7878;
    const free = await new Promise<boolean>((res) => {
      const s = net.createServer();
      s.once('error', () => res(false));
      s.listen(port, '127.0.0.1', () => s.close(() => res(true)));
    });
    add('engine', 'warn', 'not running (mcai serve)');
    add('port', free ? true : 'warn', free ? `${port} free` : `${port} busy (engine will pick the next free port)`);
  }
  const sys = path.join(AGENT_DIR, 'SYSTEM.md');
  add('agent prompt', fs.existsSync(sys) ? true : 'warn', fs.existsSync(sys) ? sys : `${sys} missing (a placeholder is written on first job)`);
  const agents = path.join(AGENT_DIR, 'agents.json');
  if (fs.existsSync(agents)) {
    try {
      const n = Object.keys(JSON.parse(fs.readFileSync(agents, 'utf8'))).length;
      add('subagents', true, `${n} defined in agents.json`);
    } catch (e) {
      add('subagents', false, `agents.json invalid: ${(e as Error).message}`);
    }
  }
  try {
    const reg = Registry.loadDefault();
    add('registry', true, `${reg.ids().length} blocks (${reg.version})`);
  } catch (e) {
    add('registry', false, (e as Error).message);
  }
  if (values.smoke && v.status === 0) {
    const t0 = Date.now();
    const r = spawnSync(claude, ['-p', 'Reply with exactly: ok', '--model', cfg?.model ?? 'opus', '--effort', 'low', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--setting-sources', 'user', '--no-session-persistence'], { encoding: 'utf8', timeout: 120000 });
    try {
      const j = JSON.parse(r.stdout);
      add('claude auth', !j.is_error, `${String(j.result).trim().slice(0, 40)} · $${Number(j.total_cost_usd ?? 0).toFixed(4)} · ${Date.now() - t0} ms`);
    } catch {
      add('claude auth', false, (r.stderr || r.stdout || 'no output').slice(0, 300));
    }
  }
  if (values.json) {
    console.log(JSON.stringify(checks, null, 2));
  } else {
    for (const ch of checks) console.log(`${ch.ok === true ? c.green('✔') : ch.ok === 'warn' ? c.yellow('!') : c.red('✘')} ${ch.name.padEnd(14)} ${ch.detail}`);
  }
  process.exit(checks.some((x) => x.ok === false) ? 1 : 0);
}

// ------------------------------------------------------------------ jobs / feedback

async function cmdJobs(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { json: { type: 'boolean' }, limit: { type: 'string' } } });
  const limit = num(values.limit, '--limit') ?? 20;
  let jobs: JobSnapshot[] = [];
  const r = await engineFetch('/api/jobs');
  if (r?.ok) jobs = ((await r.json()) as { jobs: JobSnapshot[] }).jobs;
  const seen = new Set(jobs.map((j) => j.id));
  try {
    for (const f of fs.readdirSync(paths.jobs()).filter((f) => f.endsWith('.json'))) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(paths.jobs(), f), 'utf8')) as JobSnapshot;
        if (!seen.has(j.id)) jobs.push(j);
      } catch {}
    }
  } catch {}
  jobs.sort((a, b) => b.createdAt - a.createdAt);
  jobs = jobs.slice(0, limit);
  if (values.json) return void console.log(JSON.stringify(jobs, null, 2));
  if (!jobs.length) return void console.log('no jobs yet');
  for (const j of jobs) {
    const st = j.state === 'done' ? c.green(j.state) : j.state === 'failed' ? c.red(j.state) : c.yellow(j.state);
    console.log(`${c.dim(j.id)} ${st.padEnd(tty ? 18 : 9)} ${String(j.player).padEnd(12)} $${(j.costUsd ?? 0).toFixed(2).padStart(6)} ${String(j.blocksChanged ?? 0).padStart(8)} blk  ${j.prompt.slice(0, 60)}`);
  }
}

async function cmdFeedback(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { json: { type: 'boolean' }, limit: { type: 'string' } } });
  const fb = readFeedback(num(values.limit, '--limit') ?? 20) as any[];
  if (values.json) return void console.log(JSON.stringify(fb, null, 2));
  if (!fb.length) return void console.log('no feedback yet');
  for (const f of fb) {
    console.log(`${c.dim(f.time)} ${c.bold(f.jobId)} ${c.dim(String(f.prompt ?? '').slice(0, 60))}`);
    for (const s of f.suggestions ?? []) console.log(`  • ${s}`);
  }
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'serve': return cmdServe(rest);
    case 'sim': return cmdServe(['--sim', ...rest]);
    case 'build': return cmdBuild(rest);
    case 'render': return cmdRender(rest);
    case 'doctor': return cmdDoctor(rest);
    case 'jobs': return cmdJobs(rest);
    case 'feedback': return cmdFeedback(rest);
    case 'version':
    case '--version':
      return void console.log(ENGINE_VERSION);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return void console.log(HELP);
    default:
      fail(`unknown command '${cmd}'\n${HELP}`);
  }
}

function isMain(): boolean {
  if ((import.meta as { main?: boolean }).main !== undefined) return !!(import.meta as { main?: boolean }).main;
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch((e: Error) => fail(e.stack ?? e.message));
}
