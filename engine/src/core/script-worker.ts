// Child-process side of runScript() (core/script.ts). DO NOT import this from engine code.
//
// Started as: node --permission --allow-fs-read=<engine/src/core> --max-old-space-size=N script-worker.ts
// Reads one JSON request from stdin, runs the user code inside a fresh node:vm context that
// only contains the script API, and writes one JSON result to stdout.
//
// Isolation layers: (1) OS process + Node permission model (no fs write, no child processes,
// no workers, no network, no addons, no inspector; fs read only for the engine core dir),
// (2) vm context created with DONT_CONTEXTIFY (no host objects reachable via `this`),
// (3) every host function handed to the context only takes/returns primitives and is wrapped
// in a context-side closure, so no host object (and therefore no host Function constructor)
// is ever reachable from user code, (4) dangerous process methods are removed before running.

import * as vm from 'node:vm';
import type { BlockRegistry, Box, Facing, Vec3 } from './types.ts';
import { Registry } from './registry.ts';
import { Frame } from './frame.ts';
import * as shapes from './shapes.ts';
import { compilePattern, type PatternFn, type PatternSpec } from './pattern.ts';
import { createNoise } from './noise.ts';
import { PosMap } from './posmap.ts';
import { b64ToUint16, normBox, typedToB64, paletteIndex, boxContains, volIndex } from './volume.ts';
import { AIR } from './blockstate.ts';

interface WorkerRequest {
  code: string;
  registry: BlockRegistry;
  volume?: { box: Box; palette: string[]; data: string };
  readBox?: Box;
  frame?: { anchor: Vec3; facing: Facing };
  seed: number;
  timeoutMs: number;
  maxBlocks: number;
}

const ERR = '\u0000E:';
const MAX_LOG_LINES = 300;
const MAX_LOG_CHARS = 40_000;

const stdoutWrite = process.stdout.write.bind(process.stdout);
const exit = process.exit.bind(process);

function harden(): void {
  const p = process as unknown as Record<string, unknown>;
  for (const k of [
    'kill',
    '_kill',
    'binding',
    '_linkedBinding',
    'dlopen',
    'chdir',
    'setuid',
    'setgid',
    'seteuid',
    'setegid',
    'setgroups',
    'initgroups',
    'umask',
    'send',
    'openStdin',
    'loadEnvFile',
  ]) {
    try {
      Object.defineProperty(p, k, { value: undefined, writable: false, configurable: false });
    } catch {
      /* ignore */
    }
  }
  try {
    process.env = {};
  } catch {
    /* ignore */
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function reply(obj: unknown): void {
  stdoutWrite(JSON.stringify(obj), () => exit(0));
}

// --------------------------------------------------------------------- error formatting

export function formatScriptError(e: unknown, code: string, timeoutMs: number): string {
  let name = 'Error';
  let message = '';
  let stack = '';
  try {
    if (e !== null && (typeof e === 'object' || typeof e === 'function')) {
      const o = e as { name?: unknown; message?: unknown; stack?: unknown; code?: unknown };
      if (o.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        return `Timeout: the script ran longer than ${timeoutMs} ms and was stopped. Look for infinite loops or reduce the work (e.g. fewer nested loops, use shape helpers like box()/sphere() instead of per-block loops).`;
      }
      name = String(o.name ?? 'Error');
      message = String(o.message ?? '');
      stack = typeof o.stack === 'string' ? o.stack : '';
    } else {
      name = 'Error';
      message = `thrown value: ${String(e)}`;
    }
  } catch {
    message = 'unprintable error';
  }
  const lines = code.split('\n');
  const frames: { line: number; col: number; fn: string }[] = [];
  // stack frames "at fn (script.js:L:C)" / "at script.js:L:C"; syntax errors only have a
  // "script.js:L" header line (Node's arrow message)
  const re = /\bat (?:(\S+) \()?script\.js:(\d+):(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stack)) && frames.length < 8) {
    const line = Number(m[2]);
    if (line < 1 || line > lines.length) continue;
    const fr = { line, col: Number(m[3]), fn: m[1] ?? '' };
    const prev = frames[frames.length - 1];
    if (prev && prev.line === fr.line && prev.fn === fr.fn) continue;
    frames.push(fr);
  }
  if (!frames.length) {
    const h = /script\.js:(\d+)/.exec(stack);
    if (h && Number(h[1]) >= 1 && Number(h[1]) <= lines.length) frames.push({ line: Number(h[1]), col: 0, fn: '' });
  }
  let out = `${name}: ${message}`;
  if (frames.length) {
    const f = frames[0];
    out += `\n  at line ${f.line}${f.col ? `, column ${f.col}` : ''}:`;
    const from = Math.max(1, f.line - 2);
    const to = Math.min(lines.length, f.line + 1);
    const w = String(to).length;
    for (let i = from; i <= to; i++) {
      out += `\n  ${i === f.line ? '>' : ' '} ${String(i).padStart(w)} | ${lines[i - 1].slice(0, 160)}`;
      if (i === f.line && f.col) out += `\n    ${' '.repeat(w)} | ${' '.repeat(Math.max(0, f.col - 1))}^`;
    }
    if (frames.length > 1) {
      out += '\n  call stack: ' + frames.map((fr) => `${fr.fn || '<script>'}:${fr.line}`).join(' ← ');
    }
  }
  if (name === 'ReferenceError') {
    out +=
      '\n  hint: available globals are set, get, fill, box, sphere, ellipsoid, cylinder, cone, pyramid, torus, line, curve, polygon, arch, spiral, roof, positions, pattern, block, isAir, noise2, noise3, fbm, fbm2, fbm3, rand, randInt, chance, choice, shuffle, vec, log, info, Math';
  }
  return out;
}

// --------------------------------------------------------------------- context-side prelude

const PRELUDE = String.raw`'use strict';
(function install(H, SEED, INFO_JSON) {
  const g = globalThis;
  const ERR = '\u0000E:';
  // Host functions are captured here and only ever called directly (never via apply/call/spread),
  // so user code cannot intercept them. Any host-realm exception is converted to a context Error.
  const hostMsg = (e) => { let m = 'internal error'; try { m = String(e && e.message); } catch (x) {} return m; };
  const wrapHost = (f) => function (a, b, c, d, e, f2) {
    let r;
    try { r = f(a, b, c, d, e, f2); } catch (err) { throw new Error(hostMsg(err)); }
    return r;
  };
  const HH = {};
  for (const k of ['set', 'setP', 'get', 'shape', 'shapePos', 'roof', 'patCompile', 'pat', 'noise2', 'noise3', 'fbm2', 'fbm3', 'log']) HH[k] = wrapHost(H[k]);
  H = HH;
  const chk = (r) => {
    if (typeof r === 'string' && r.length >= 3 && r.charCodeAt(0) === 0 && r.startsWith(ERR)) throw new Error(r.slice(3));
    return r;
  };
  const num = (v) => +v;
  // ---- seeded rng (mulberry32), Math.random is replaced so scripts are deterministic
  let a = SEED >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  Math.random = rand;
  const randInt = (lo, hi) => { lo = Math.ceil(Math.min(lo, hi)); hi = Math.floor(Math.max(lo, hi)); return lo + Math.floor(rand() * (hi - lo + 1)); };
  const chance = (p) => rand() < p;
  const choice = (arr) => { if (!arr || !arr.length) throw new Error('choice(): empty array'); return arr[Math.floor(rand() * arr.length)]; };
  const shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; } return arr; };

  const isFn = (b) => typeof b === 'function';
  function blockKind(b, fname) {
    if (typeof b === 'string') return ['s', b];
    if (b && typeof b === 'object') return ['p', JSON.stringify(b)];
    throw new TypeError(fname + '(): block must be a block state string ("stone_bricks", "oak_stairs[facing=east]", "70%stone,30%andesite"), a pattern spec object, or a function (x,y,z) => block');
  }
  function set(x, y, z, block) {
    if (isFn(block)) block = block(x, y, z);
    if (block === null || block === undefined) return;
    if (typeof block === 'object') { chk(H.setP(num(x), num(y), num(z), JSON.stringify(block))); return; }
    chk(H.set(num(x), num(y), num(z), String(block)));
  }
  function get(x, y, z) { return chk(H.get(num(x), num(y), num(z))); }
  function paramsJson(p, fname) {
    if (!p || typeof p !== 'object') throw new TypeError(fname + '(): first argument must be a parameter object, e.g. ' + fname + '({ ... }, "stone")');
    return JSON.stringify(p);
  }
  function shapeFn(name) {
    const f = function (params, block) {
      const pj = paramsJson(params, name);
      if (isFn(block)) {
        const pos = JSON.parse(chk(H.shapePos(name, pj)));
        let n = 0;
        for (let i = 0; i < pos.length; i += 3) {
          const s = block(pos[i], pos[i + 1], pos[i + 2]);
          if (s === null || s === undefined) continue;
          set(pos[i], pos[i + 1], pos[i + 2], s);
          n++;
        }
        return n;
      }
      if (block === undefined) throw new TypeError(name + '(): missing block argument, e.g. ' + name + '({ ... }, "stone_bricks")');
      const k = blockKind(block, name);
      return chk(H.shape(name, pj, k[0], k[1]));
    };
    Object.defineProperty(f, 'name', { value: name });
    return f;
  }
  const SHAPES = ['box', 'ellipsoid', 'sphere', 'cylinder', 'cone', 'pyramid', 'torus', 'line', 'curve', 'polygon', 'arch', 'spiral'];
  for (const s of SHAPES) g[s] = shapeFn(s);
  g.cuboid = g.box;
  function fill(x1, y1, z1, x2, y2, z2, block) {
    return g.box({ from: [x1, y1, z1], to: [x2, y2, z2] }, block);
  }
  function positions(name, params) {
    if (SHAPES.indexOf(name) < 0) throw new Error('positions(): unknown shape "' + name + '" (known: ' + SHAPES.join(', ') + ')');
    const pos = JSON.parse(chk(H.shapePos(name, paramsJson(params, 'positions'))));
    const out = [];
    for (let i = 0; i < pos.length; i += 3) out.push([pos[i], pos[i + 1], pos[i + 2]]);
    return out;
  }
  function roof(params) { return chk(H.roof(paramsJson(params, 'roof'))); }
  function pattern(spec) {
    const h = chk(H.patCompile(typeof spec === 'string' ? spec : JSON.stringify(spec), typeof spec === 'string' ? 1 : 0));
    const f = function (x, y, z) { const r = chk(H.pat(h, num(x), num(y), num(z))); return r === '' ? null : r; };
    return f;
  }
  function block(id, props) {
    if (!props) return String(id);
    const keys = Object.keys(props);
    if (!keys.length) return String(id);
    return String(id) + '[' + keys.map((k) => k + '=' + props[k]).join(',') + ']';
  }
  const isAir = (s) => /^(minecraft:)?(air|cave_air|void_air)(\[|\{|$)/.test(String(s));
  const noise2 = (x, z) => H.noise2(num(x), num(z));
  const noise3 = (x, y, z) => H.noise3(num(x), num(y), num(z));
  const fbm2 = (x, z, o, l, gn) => H.fbm2(num(x), num(z), o === undefined ? 4 : num(o), l === undefined ? 2 : num(l), gn === undefined ? 0.5 : num(gn));
  const fbm3 = (x, y, z, o, l, gn) => H.fbm3(num(x), num(y), num(z), o === undefined ? 4 : num(o), l === undefined ? 2 : num(l), gn === undefined ? 0.5 : num(gn));
  function fmt(v, depth) {
    if (typeof v === 'string') return v;
    if (typeof v === 'function') return '[function ' + (v.name || 'anonymous') + ']';
    if (v instanceof Error) return v.name + ': ' + v.message;
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }
  function log() {
    const parts = [];
    for (let i = 0; i < arguments.length; i++) parts.push(fmt(arguments[i]));
    H.log(parts.join(' '));
  }
  const vec = Object.freeze({
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    len: (a) => Math.hypot(a[0], a[1], a[2]),
    dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
    norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
    lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
    round: (a) => [Math.round(a[0]), Math.round(a[1]), Math.round(a[2])],
    floor: (a) => [Math.floor(a[0]), Math.floor(a[1]), Math.floor(a[2])],
    eq: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2],
    rotY: (a, turns) => { let x = a[0], z = a[2]; for (let i = 0; i < ((turns % 4) + 4) % 4; i++) { const t = x; x = -z; z = t; } return [x, a[1], z]; },
  });
  const info = Object.freeze(JSON.parse(INFO_JSON));
  const api = { set, get, fill, positions, roof, pattern, block, isAir, noise2, noise3, fbm: fbm2, fbm2, fbm3, rand, randInt, chance, choice, shuffle, vec, log, info, SEED };
  for (const k of Object.keys(api)) g[k] = api[k];
  g.console = Object.freeze({ log, info: log, warn: log, error: log, debug: log });
  // memory hardening: off-heap buffers could bypass --max-old-space-size
  for (const k of ['ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float16Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'WebAssembly', 'Atomics', 'FinalizationRegistry', 'WeakRef']) {
    try { delete g[k]; } catch (e) {}
  }
})`;

// --------------------------------------------------------------------- main

async function main(): Promise<void> {
  const req = JSON.parse(await readStdin()) as WorkerRequest;
  const t0 = performance.now();
  const reg = new Registry(req.registry);
  const frame = req.frame ? new Frame(req.frame.anchor, req.frame.facing, reg) : null;
  // default bounds for gradient patterns without from/to: the readable box, in script space
  const patternBounds: Box | undefined = req.readBox
    ? frame ? normBox(frame.toLocal(req.readBox.min), frame.toLocal(req.readBox.max)) : req.readBox
    : undefined;
  const noise = createNoise(req.seed);
  const vol = req.volume ? { box: req.volume.box, palette: req.volume.palette, data: b64ToUint16(req.volume.data) } : null;
  const maxBlocks = req.maxBlocks;

  const palette: string[] = [];
  const entries = new PosMap<number>();
  const logs: string[] = [];
  let logChars = 0;
  let logDropped = 0;

  const canon = new Map<string, string>();
  const toWorldState = new Map<string, string>();
  const toLocalState = new Map<string, string>();
  const canonical = (s: string): string => {
    let c = canon.get(s);
    if (c === undefined) {
      c = reg.canonical(s);
      canon.set(s, c);
    }
    return c;
  };

  const coord = (v: number, fname: string, x: number, y: number, z: number): number => {
    if (!Number.isFinite(v)) throw new Error(`${fname}(): coordinates must be finite numbers, got (${x}, ${y}, ${z})`);
    return Math.round(v);
  };

  function put(lx: number, ly: number, lz: number, state: string): void {
    let s = canonical(state);
    let wx = lx;
    let wy = ly;
    let wz = lz;
    if (frame) {
      [wx, wy, wz] = frame.toWorld([lx, ly, lz]);
      let w = toWorldState.get(s);
      if (w === undefined) {
        w = frame.stateToWorld(s);
        toWorldState.set(s, w);
      }
      s = w;
    }
    const idx = paletteIndex(palette, s);
    if (!entries.has(wx, wy, wz) && entries.size >= maxBlocks) {
      throw new Error(`block limit exceeded: a script may set at most ${maxBlocks} blocks — build hollow shapes or split the work into several scripts`);
    }
    entries.set(wx, wy, wz, idx);
  }

  const patternCache = new Map<string, PatternFn>();
  const patterns: PatternFn[] = [];
  function stringBlock(str: string): PatternFn {
    let f = patternCache.get(str);
    if (f) return f;
    const r = reg.tryCanonical(str);
    if (r.ok) {
      const st = r.state;
      f = () => st;
    } else {
      try {
        f = compilePattern(str, reg, { seed: req.seed, bounds: patternBounds });
      } catch {
        throw new Error(r.error);
      }
    }
    patternCache.set(str, f);
    return f;
  }
  function specBlock(json: string): PatternFn {
    let f = patternCache.get('\u0001' + json);
    if (f) return f;
    f = compilePattern(JSON.parse(json) as PatternSpec, reg, { seed: req.seed, bounds: patternBounds });
    patternCache.set('\u0001' + json, f);
    return f;
  }

  const shapeTable: Record<string, (p: never, emit: shapes.PosSink) => void> = {
    box: shapes.box as never,
    ellipsoid: shapes.ellipsoid as never,
    sphere: shapes.ellipsoid as never,
    cylinder: shapes.cylinder as never,
    cone: shapes.cone as never,
    pyramid: shapes.pyramid as never,
    torus: shapes.torus as never,
    line: shapes.line as never,
    curve: shapes.curve as never,
    polygon: shapes.polygon as never,
    arch: shapes.arch as never,
    spiral: shapes.spiral as never,
  };
  function normParams(name: string, json: string): Record<string, unknown> {
    const p = JSON.parse(json) as Record<string, unknown>;
    if (name === 'box' && !p.box) {
      if (p.from && p.to) p.box = normBox(p.from as Vec3, p.to as Vec3);
      else if (p.min && p.max) p.box = normBox(p.min as Vec3, p.max as Vec3);
    }
    if (name === 'box' && p.box && typeof p.box === 'object') {
      const b = p.box as Box;
      p.box = normBox(b.min, b.max);
    }
    return p;
  }
  function runShape(name: string, json: string, emit: shapes.PosSink): void {
    const fn = shapeTable[name];
    if (!fn) throw new Error(`unknown shape ${name}`);
    const budget = Math.max(maxBlocks * 8, 1_000_000);
    let emitted = 0;
    fn(normParams(name, json) as never, (x, y, z) => {
      if (++emitted > budget) throw new Error(`${name}(): shape is too large (more than ${budget} positions)`);
      emit(x, y, z);
    });
  }

  const wrap =
    <A extends unknown[], R>(f: (...a: A) => R) =>
    (...a: A): R | string => {
      try {
        return f(...a);
      } catch (e) {
        return ERR + (e instanceof Error ? e.message : String(e));
      }
    };

  const H = Object.freeze({
    set: wrap((x: number, y: number, z: number, str: string) => {
      const ix = coord(x, 'set', x, y, z);
      const iy = coord(y, 'set', x, y, z);
      const iz = coord(z, 'set', x, y, z);
      const s = stringBlock(str)(ix, iy, iz);
      if (s !== null) put(ix, iy, iz, s);
      return '';
    }),
    setP: wrap((x: number, y: number, z: number, json: string) => {
      const ix = coord(x, 'set', x, y, z);
      const iy = coord(y, 'set', x, y, z);
      const iz = coord(z, 'set', x, y, z);
      const s = specBlock(json)(ix, iy, iz);
      if (s !== null) put(ix, iy, iz, s);
      return '';
    }),
    get: wrap((x: number, y: number, z: number): string => {
      let p: Vec3 = [coord(x, 'get', x, y, z), coord(y, 'get', x, y, z), coord(z, 'get', x, y, z)];
      if (frame) p = frame.toWorld(p);
      // own writes are visible to get()
      const own = entries.get(p[0], p[1], p[2]);
      let s: string = AIR;
      if (own !== undefined) s = palette[own];
      else if (vol && boxContains(vol.box, p[0], p[1], p[2])) s = vol.palette[vol.data[volIndex(vol.box, p[0], p[1], p[2])]] ?? AIR;
      if (frame) {
        let l = toLocalState.get(s);
        if (l === undefined) {
          l = frame.stateToLocal(s);
          toLocalState.set(s, l);
        }
        s = l;
      }
      return s;
    }),
    shape: wrap((name: string, json: string, kind: string, blk: string): number => {
      const f = kind === 's' ? stringBlock(blk) : specBlock(blk);
      let n = 0;
      runShape(name, json, (x, y, z) => {
        const s = f(x, y, z);
        if (s === null) return;
        put(x, y, z, s);
        n++;
      });
      return n;
    }),
    shapePos: wrap((name: string, json: string): string => {
      const out: number[] = [];
      runShape(name, json, (x, y, z) => {
        out.push(x, y, z);
      });
      return JSON.stringify(out);
    }),
    roof: wrap((json: string): number => {
      const p = JSON.parse(json) as Record<string, unknown>;
      if (p.box && typeof p.box === 'object') {
        const b = p.box as Box;
        p.box = normBox(b.min, b.max);
      } else if (p.from && p.to) p.box = normBox(p.from as Vec3, p.to as Vec3);
      let n = 0;
      shapes.roof(p as never, reg, (x, y, z, s) => {
        put(x, y, z, s);
        n++;
      });
      return n;
    }),
    patCompile: wrap((spec: string, isString: number): number => {
      const f = isString ? stringBlock(spec) : specBlock(spec);
      patterns.push(f);
      return patterns.length - 1;
    }),
    pat: wrap((h: number, x: number, y: number, z: number): string => {
      const f = patterns[h];
      if (!f) throw new Error('invalid pattern');
      const s = f(Math.round(x), Math.round(y), Math.round(z));
      return s === null ? '' : s;
    }),
    noise2: (x: number, z: number): number => noise.noise2(x, z),
    noise3: (x: number, y: number, z: number): number => noise.noise3(x, y, z),
    fbm2: (x: number, z: number, o: number, l: number, g: number): number => noise.fbm2(x, z, o, l, g),
    fbm3: (x: number, y: number, z: number, o: number, l: number, g: number): number => noise.fbm3(x, y, z, o, l, g),
    log: (s: string): void => {
      const str = String(s);
      if (logs.length >= MAX_LOG_LINES || logChars + str.length > MAX_LOG_CHARS) {
        logDropped++;
        return;
      }
      logs.push(str.length > 2000 ? str.slice(0, 2000) + '…' : str);
      logChars += str.length;
    },
  });

  const info = {
    space: frame ? 'local' : 'world',
    frame: req.frame ?? null,
    readBox: req.readBox ?? (vol ? vol.box : null),
    maxBlocks,
    seed: req.seed,
  };

  const ctx = vm.createContext(vm.constants.DONT_CONTEXTIFY, {
    name: 'mcai-script',
    codeGeneration: { strings: true, wasm: false },
    microtaskMode: 'afterEvaluate',
  });
  const install = new vm.Script(PRELUDE, { filename: 'mcai-api.js' }).runInContext(ctx) as (
    h: unknown,
    seed: number,
    info: string,
  ) => void;
  install(H, req.seed >>> 0, JSON.stringify(info));

  harden();

  let error: string | undefined;
  try {
    const script = new vm.Script(`(function () {\n${req.code}\n})()`, { filename: 'script.js', lineOffset: -1 });
    script.runInContext(ctx, { timeout: req.timeoutMs, breakOnSigint: false });
  } catch (e) {
    error = formatScriptError(e, req.code, req.timeoutMs);
  }
  if (logDropped) logs.push(`… ${logDropped} more log lines dropped`);

  const n = entries.size;
  const pos = new Int32Array(n * 3);
  const st = new Uint16Array(n);
  let i = 0;
  for (const [x, y, z, s] of entries.entries()) {
    pos[3 * i] = x;
    pos[3 * i + 1] = y;
    pos[3 * i + 2] = z;
    st[i++] = s;
  }
  reply({ ok: !error, palette, pos: typedToB64(pos), st: typedToB64(st), logs, error, ms: Math.round(performance.now() - t0) });
}

main().catch((e) => {
  reply({ ok: false, palette: [], pos: '', st: '', logs: [], error: `internal script runner error: ${(e as Error)?.stack ?? e}`, ms: 0 });
});
