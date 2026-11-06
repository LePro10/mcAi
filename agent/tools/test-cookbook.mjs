#!/usr/bin/env node
// Runs every recipe of knowledge/script-cookbook.md (prelude + recipe, exactly as an agent would paste them)
// through the REAL run_script sandbox (engine/src/core/script.ts) on a flat test world
// (local y <= 0 is ground: grass at y=0, dirt below, air above). Reports block counts, logs and errors.
// If the engine sandbox cannot start yet (modules still missing), falls back to a faithful mock of its API
// (node:vm, same globals, get() sees own writes, states validated against the registry).
//   node agent/tools/test-cookbook.mjs [recipe-number]
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const { runScript } = await import(join(root, 'engine/src/core/script.ts'));
const { Registry } = await import(join(root, 'engine/src/core/registry.ts'));
const { createVolume, volSet } = await import(join(root, 'engine/src/core/volume.ts'));
const reg = Registry.loadDefault();

const md = readFileSync(join(here, '../knowledge/script-cookbook.md'), 'utf8');
const blocks = [];
let heading = '';
for (const m of md.matchAll(/^## (.*)$|```js\n([\s\S]*?)```/gm)) {
  if (m[1]) heading = m[1];
  else blocks.push({ heading, code: m[2] });
}
const prelude = blocks.shift();
const only = process.argv[2] ? Number(process.argv[2]) : null;

// flat test world: x -64..64, y -24..48, z -110..24
const box = { min: [-64, -24, -110], max: [64, 48, 24] };
const vol = createVolume(box);
const grass = reg.canonical('grass_block'), dirt = reg.canonical('dirt');
for (let y = box.min[1]; y <= 0; y++) for (let z = box.min[2]; z <= box.max[2]; z++) for (let x = box.min[0]; x <= box.max[0]; x++) volSet(vol, x, y, z, y === 0 ? grass : dirt);

// ---- mock sandbox (fallback) ----
const { createNoise } = await import(join(root, 'engine/src/core/noise.ts'));
function mockRun(code, seed) {
  const t0 = performance.now();
  const entries = new Map(), logs = [];
  let a = seed >>> 0;
  const rand = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const noise = createNoise(seed);
  const pat = (spec) => {
    if (typeof spec === 'function') return spec;
    if (typeof spec === 'string') {
      const parts = spec.split(/,(?![^\[]*\])/).map((p) => { const w = /^(\d+(?:\.\d+)?)%(.*)$/.exec(p); return w ? [Number(w[1]), w[2]] : [1, p]; });
      const total = parts.reduce((s2, p) => s2 + p[0], 0);
      return () => { let r = rand() * total; for (const [w, b2] of parts) if ((r -= w) <= 0) return b2; return parts.at(-1)[1]; };
    }
    if (spec.type === 'gradient') return (x, y, z) => spec.stops[Math.min(spec.stops.length - 1, Math.abs({ x, y, z }[spec.axis]) % spec.stops.length)];
    if (Array.isArray(spec)) return pat(spec.map((e) => `${e.weight ?? 1}%${e.block}`).join(','));
    return (x, y, z) => spec.blocks[Math.abs(x + y + z) % spec.blocks.length];
  };
  const set = (x, y, z, b) => {
    if (![x, y, z].every(Number.isFinite)) throw new Error(`set(): coordinates must be finite numbers, got (${x}, ${y}, ${z})`);
    x = Math.round(x); y = Math.round(y); z = Math.round(z);
    if (typeof b === 'function' || (b && typeof b === 'object')) b = pat(b)(x, y, z);
    if (b === null || b === undefined) return;
    if (String(b).includes('%')) b = pat(b)(x, y, z);
    entries.set(`${x},${y},${z}`, reg.canonical(String(b)));   // throws on invalid ids / properties
  };
  const get = (x, y, z) => {
    x = Math.round(x); y = Math.round(y); z = Math.round(z);
    return entries.get(`${x},${y},${z}`) ?? (y === 0 ? grass : y < 0 ? dirt : 'minecraft:air');
  };
  const api = {
    set, get, pattern: (spec) => { const f = pat(spec); return (x, y, z) => f(x, y, z) ?? null; },
    isAir: (s2) => /^(minecraft:)?(air|cave_air|void_air)(\[|\{|$)/.test(String(s2)),
    noise2: (x, z) => noise.noise2(x, z), noise3: (x, y, z) => noise.noise3(x, y, z),
    fbm2: (x, z) => noise.fbm2(x, z), fbm3: (x, y, z) => noise.fbm3(x, y, z),
    rand, randInt: (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1)), chance: (p) => rand() < p,
    choice: (arr) => arr[Math.floor(rand() * arr.length)], log: (...x) => logs.push(x.map(String).join(' ')),
    block: (id, props) => props ? `${id}[${Object.entries(props).map(([k, v]) => `${k}=${v}`).join(',')}]` : id,
  };
  try { vm.runInNewContext(`(function () {\n${code}\n})()`, api, { timeout: 60000 }); }
  catch (e) { return { entries: [...entries], logs, error: String(e.message), ms: performance.now() - t0 }; }
  return { entries: [...entries], logs, ms: performance.now() - t0 };
}

const probe = await runScript({ code: 'set(0,1,0,"stone")', seed: 1, timeoutMs: 10000 }, reg).catch((e) => ({ error: String(e) }));
const real = !probe.error;
console.log(real ? 'using the real engine sandbox' : `engine sandbox unavailable (${probe.error.split('\n')[0].slice(0, 80)}…) — using the mock`);

let failed = 0;
for (const [i, b] of blocks.entries()) {
  if (only !== null && !b.heading.startsWith(`${only}.`)) continue;
  const code = prelude.code + '\n' + b.code;
  const res = real ? await runScript({ code, readBox: box, volume: vol, seed: 7 + i, timeoutMs: 60000 }, reg) : mockRun(code, 7 + i);
  const ok = !res.error && res.entries.length > 0;
  if (!ok) failed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${b.heading} — ${res.entries.length} blocks, ${Math.round(res.ms)} ms${res.logs.length ? ' | ' + res.logs.join(' | ').slice(0, 110) : ''}`);
  if (res.error) console.log('      ' + res.error.split('\n').join('\n      '));
}
console.log(failed ? `${failed} recipe(s) failed` : 'all recipes passed');
process.exit(failed ? 1 : 0);
