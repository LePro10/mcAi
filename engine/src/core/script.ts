// Sandboxed JS generator scripts (MCP tool `run_script`). See docs/ENGINE-API.md (core-data).
//
// Each script runs in its own Node child process (core/script-worker.ts) started with the
// permission model: --permission with fs-read limited to the engine core directory and no
// fs-write / child-process / worker / net / addons / wasi / inspector permission. Inside, the
// code runs in a node:vm context that only contains the script API. Hard wall-clock timeout
// (SIGKILL), V8 heap cap (--max-old-space-size) and a maxBlocks cap.

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import type { BlockRegistry, BlockVolume, Box, Facing, Vec3 } from './types.ts';
import type { Registry } from './registry.ts';
import { b64ToInt32, b64ToUint16, typedToB64 } from './volume.ts';

export interface ScriptRequest {
  code: string;
  readBox?: Box;
  /** prefetched blocks for get() (world coordinates) */
  volume?: BlockVolume;
  frame?: { anchor: Vec3; facing: Facing };
  seed?: number;
  timeoutMs?: number;
  maxBlocks?: number;
  /** V8 old-space cap for the child, MiB (default 512) */
  memoryMb?: number;
}

export interface ScriptResult {
  entries: Array<[number, number, number, string]>;
  logs: string[];
  error?: string;
  ms: number;
}

export const SCRIPT_DEFAULTS = {
  timeoutMs: 15_000,
  maxTimeoutMs: 120_000,
  maxBlocks: 500_000,
  memoryMb: 512,
  maxCodeLength: 256 * 1024,
};

const WORKER = realpathSync(fileURLToPath(new URL('./script-worker.ts', import.meta.url)));
const CORE_DIR = path.dirname(WORKER);

/** Node flags used for the child (exported for tests/diagnostics). */
export function scriptNodeArgs(memoryMb: number): string[] {
  return [
    '--permission',
    `--allow-fs-read=${CORE_DIR}`,
    `--max-old-space-size=${memoryMb}`,
    '--max-semi-space-size=16',
    '--stack-size=2048',
    '--disable-proto=delete',
    '--no-warnings',
    '--no-addons',
    WORKER,
  ];
}

const regJson = new WeakMap<Registry, BlockRegistry>();
function registryData(reg: Registry): BlockRegistry {
  let d = regJson.get(reg);
  if (!d) {
    const blocks: BlockRegistry['blocks'] = {};
    for (const id of reg.ids()) {
      const info = reg.info(id);
      if (info) blocks[id] = info;
    }
    d = { version: reg.version, blocks };
    regJson.set(reg, d);
  }
  return d;
}

function fail(error: string, ms: number, logs: string[] = []): ScriptResult {
  return { entries: [], logs, error, ms };
}

export async function runScript(req: ScriptRequest, reg: Registry): Promise<ScriptResult> {
  const t0 = performance.now();
  if (typeof req.code !== 'string' || !req.code.trim()) return fail('script code is empty', 0);
  if (req.code.length > SCRIPT_DEFAULTS.maxCodeLength) {
    return fail(`script is too long (${req.code.length} chars, max ${SCRIPT_DEFAULTS.maxCodeLength})`, 0);
  }
  const timeoutMs = Math.max(50, Math.min(SCRIPT_DEFAULTS.maxTimeoutMs, req.timeoutMs ?? SCRIPT_DEFAULTS.timeoutMs));
  const maxBlocks = Math.max(1, Math.floor(req.maxBlocks ?? SCRIPT_DEFAULTS.maxBlocks));
  const memoryMb = Math.max(64, Math.min(4096, Math.floor(req.memoryMb ?? SCRIPT_DEFAULTS.memoryMb)));
  const payload = JSON.stringify({
    code: req.code,
    registry: registryData(reg),
    volume: req.volume
      ? { box: req.volume.box, palette: req.volume.palette, data: typedToB64(req.volume.data) }
      : undefined,
    readBox: req.readBox,
    frame: req.frame,
    seed: (req.seed ?? 1) >>> 0,
    timeoutMs,
    maxBlocks,
  });

  const child = spawn(process.execPath, scriptNodeArgs(memoryMb), {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {},
    cwd: CORE_DIR,
    windowsHide: true,
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let outLen = 0;
  let errLen = 0;
  let killedFor: 'timeout' | 'output' | null = null;
  const MAX_OUT = 512 * 1024 * 1024;
  child.stdout.on('data', (d: Buffer) => {
    outLen += d.length;
    if (outLen > MAX_OUT) {
      killedFor = 'output';
      child.kill('SIGKILL');
      return;
    }
    out.push(d);
  });
  child.stderr.on('data', (d: Buffer) => {
    if (errLen < 64 * 1024) err.push(d);
    errLen += d.length;
  });
  // startup (TS stripping + registry parse) is not part of the user budget
  const hard = setTimeout(() => {
    killedFor = 'timeout';
    child.kill('SIGKILL');
  }, timeoutMs + 5000);
  child.stdin.on('error', () => {
    /* child died early; reported below */
  });
  child.stdin.end(payload);

  const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('error', (e) => {
      err.push(Buffer.from(String(e)));
      resolve({ code: -1, signal: null });
    });
    child.on('close', (c, s) => resolve({ code: c, signal: s }));
  });
  clearTimeout(hard);
  const ms = Math.round(performance.now() - t0);
  const stderr = Buffer.concat(err).toString('utf8');

  if (killedFor === 'timeout') {
    return fail(`Timeout: the script ran longer than ${timeoutMs} ms and was killed. Look for infinite loops or reduce the work.`, ms);
  }
  if (killedFor === 'output') return fail('the script produced too much output and was killed', ms);

  const text = Buffer.concat(out).toString('utf8');
  let res: { ok: boolean; palette: string[]; pos: string; st: string; logs: string[]; error?: string } | null = null;
  try {
    res = text ? JSON.parse(text) : null;
  } catch {
    res = null;
  }
  if (!res || typeof res !== 'object') {
    if (/heap out of memory|Allocation failed|Reached heap limit|invalid array length/i.test(stderr) || signal === 'SIGABRT' || code === 134) {
      return fail(
        `Out of memory: the script exceeded the ${memoryMb} MB memory limit. Avoid huge arrays/strings; generate blocks directly with set() or shape helpers.`,
        ms,
      );
    }
    const tail = stderr.split('\n').filter(Boolean).slice(-6).join('\n');
    return fail(`script process crashed (exit ${code ?? signal})${tail ? `:\n${tail}` : ''}`, ms);
  }

  const entries: Array<[number, number, number, string]> = [];
  const palette = Array.isArray(res.palette) ? res.palette.map(String) : [];
  if (res.pos && res.st) {
    const pos = b64ToInt32(res.pos);
    const st = b64ToUint16(res.st);
    const n = Math.min(st.length, Math.floor(pos.length / 3), maxBlocks);
    for (let i = 0; i < n; i++) {
      const s = palette[st[i]];
      if (s === undefined) continue;
      entries.push([pos[3 * i], pos[3 * i + 1], pos[3 * i + 2], s]);
    }
  }
  const logs = Array.isArray(res.logs) ? res.logs.map(String).slice(0, 400) : [];
  const out2: ScriptResult = { entries, logs, ms };
  if (res.error) out2.error = String(res.error);
  return out2;
}
