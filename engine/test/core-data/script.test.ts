import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { runScript, scriptNodeArgs } from '../../src/core/script.ts';
import { createVolume, volSet } from '../../src/core/volume.ts';
import { reg } from './helpers.ts';

const run = (code: string, extra: Record<string, unknown> = {}) =>
  runScript({ code, timeoutMs: 3000, memoryMb: 128, ...extra }, reg());

const toMap = (entries: Array<[number, number, number, string]>) => new Map(entries.map(([x, y, z, s]) => [`${x},${y},${z}`, s]));

test('script API: set, shapes, patterns, functions, logs, canonical output', async () => {
  const r = await run(`
    set(0, 0, 0, 'stone');
    set(1, 0, 0, 'oak_stairs[facing=east]');
    const n = sphere({ center: [0, 10, 0], radius: 2 }, 'glass');
    fill(5, 0, 5, 6, 1, 6, '50%stone,50%andesite');
    box({ from: [10, 0, 10], to: [12, 0, 12] }, (x, y, z) => (x + z) % 2 ? 'white_wool' : null);
    cylinder({ base: [20, 0, 20], radius: 2, height: 3, hollow: true }, { type: 'checker', blocks: ['stone', 'dirt'] });
    const p = pattern('oak_planks');
    set(30, 0, 30, p);
    log('sphere', n, [1, 2], { a: 1 });
    log(positions('line', { from: [0, 0, 0], to: [3, 0, 0] }).length);
  `);
  assert.equal(r.error, undefined, r.error ?? '');
  const m = toMap(r.entries);
  assert.equal(m.get('0,0,0'), 'minecraft:stone');
  assert.equal(m.get('1,0,0'), 'minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]');
  assert.equal(m.get('0,12,0'), 'minecraft:glass');
  assert.ok(['minecraft:stone', 'minecraft:andesite'].includes(m.get('5,1,6')!));
  assert.equal(m.get('11,0,10'), 'minecraft:white_wool');
  assert.equal(m.get('10,0,10'), undefined, 'null from block function = leave unchanged');
  assert.equal(m.get('30,0,30'), 'minecraft:oak_planks');
  assert.ok(m.size > 40);
  assert.match(r.logs[0], /^sphere \d+ \[1,2\] \{"a":1\}$/);
  assert.equal(r.logs[1], '4');
  for (const [, , , s] of r.entries) assert.equal(reg().canonical(s), s);
});

test('script: deterministic seeded randomness and noise', async () => {
  const code = `for (let i = 0; i < 20; i++) set(i, 0, 0, choice(['stone','dirt','andesite'])); log(rand(), randInt(1, 6), Math.random(), noise2(0.5, 0.25), fbm(3.1, 4.2), noise3(1,2,3));`;
  const a = await run(code, { seed: 42 });
  const b = await run(code, { seed: 42 });
  const c = await run(code, { seed: 43 });
  assert.equal(a.error, undefined, a.error ?? '');
  assert.deepEqual(a.entries, b.entries);
  assert.deepEqual(a.logs, b.logs);
  assert.notDeepEqual(a.logs, c.logs);
  const nums = a.logs[0].split(' ').map(Number);
  assert.ok(nums.every((n) => Number.isFinite(n)));
  assert.ok(Math.abs(nums[3]) <= 1 && Math.abs(nums[4]) <= 1);
});

test('script: frame makes coords local and rotates states to world', async () => {
  const r = await run(`set(0, 0, -1, 'oak_stairs[facing=north]'); set(2, 1, 0, 'oak_log[axis=x]'); log(get(0, 0, -1)); log(get(5, 0, 0))`, {
    frame: { anchor: [100, 64, 200], facing: 'east' },
    volume: (() => {
      const v = createVolume({ min: [100, 64, 205], max: [100, 64, 205] });
      volSet(v, 100, 64, 205, 'minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]');
      return v;
    })(),
  });
  assert.equal(r.error, undefined, r.error ?? '');
  const m = toMap(r.entries);
  // facing east: local (x,z) → world (−z, x); local −z (forward) = world +x (east)
  assert.equal(m.get('101,64,200'), 'minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]');
  assert.equal(m.get('100,65,202'), 'minecraft:oak_log[axis=z]');
  // get() sees own writes and returns local-space states
  assert.equal(r.logs[0], 'minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]');
  // local (5,0,0) → world (100, 64, 205) — prefetched world stairs facing east = local north
  assert.equal(r.logs[1], 'minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]');
});

test('script: get() reads the prefetched volume (air outside)', async () => {
  const v = createVolume({ min: [0, 0, 0], max: [3, 3, 3] });
  volSet(v, 1, 1, 1, 'minecraft:gold_block');
  const r = await run(`log(get(1,1,1)); log(get(2,2,2)); log(get(100,100,100)); log(isAir(get(2,2,2)), JSON.stringify(info.readBox))`, { volume: v });
  assert.equal(r.error, undefined, r.error ?? '');
  assert.deepEqual(r.logs.slice(0, 3), ['minecraft:gold_block', 'minecraft:air', 'minecraft:air']);
  assert.match(r.logs[3], /^true /);
});

test('script errors are formatted with line numbers and code excerpt', async () => {
  const r = await run(`const a = 1;\nconst b = 2;\nnotAFunction(a + b);\nset(0,0,0,'stone');`);
  assert.match(r.error!, /^ReferenceError: notAFunction is not defined/);
  assert.match(r.error!, /at line 3, column 1/);
  assert.match(r.error!, />\s*3 \| notAFunction\(a \+ b\);/);
  assert.match(r.error!, /hint: available globals/);

  const s = await run(`let x = 1;\nlet y = ;\n`);
  assert.match(s.error!, /^SyntaxError: /);
  assert.match(s.error!, /at line 2/);

  const b = await run(`\n\nset(0, 0, 0, 'stone_brikcs');`);
  assert.match(b.error!, /stone_brikcs/);
  assert.match(b.error!, /stone_bricks/, 'did-you-mean suggestion');
  assert.match(b.error!, /at line 3/);

  const t = await run(`function inner() { throw new TypeError('bad thing'); }\nfunction outer() { inner(); }\nouter();`);
  assert.match(t.error!, /^TypeError: bad thing\n  at line 1/);
  assert.match(t.error!, /call stack: inner:1 ← outer:2/);

  const nan = await run(`set(NaN, 0, 0, 'stone')`);
  assert.match(nan.error!, /finite numbers/);

  const thrown = await run(`throw 'just a string'`);
  assert.match(thrown.error!, /thrown value: just a string/);

  const sh = await run(`sphere('nope', 'stone')`);
  assert.match(sh.error!, /parameter object/);
});

test('script: maxBlocks cap', async () => {
  const r = await run(`for (let i = 0; i < 1000; i++) set(i, 0, 0, 'stone')`, { maxBlocks: 100 });
  assert.match(r.error!, /block limit exceeded: a script may set at most 100 blocks/);
  assert.ok(r.entries.length <= 100);
  const ok = await run(`for (let k = 0; k < 3; k++) for (let i = 0; i < 100; i++) set(i, 0, 0, 'stone')`, { maxBlocks: 100 });
  assert.equal(ok.error, undefined, 're-setting the same positions does not count');
});

test('sandbox: escapes to process/require/import/fs are contained', async () => {
  const r = await run(`
    const probes = {
      thisCtor: () => this.constructor.constructor('return typeof process')(),
      fnCtor: () => set.constructor('return typeof process')(),
      protoCtor: () => Object.getPrototypeOf(get).constructor('return typeof require')(),
      errCtor: () => { try { set(0, 0, 0, 'definitely_not_a_block'); } catch (e) { return e.constructor.constructor('return typeof process')(); } },
      stackOverflow: () => { let e; const f = () => { try { return noise2(1, 2) + f(); } catch (x) { e = x; return 0; } }; f(); return e && e.constructor.constructor('return typeof process')(); },
      globals: () => [typeof process, typeof require, typeof module, typeof globalThis.fetch, typeof setTimeout, typeof ArrayBuffer, typeof WebAssembly, typeof SharedArrayBuffer].join(','),
      evalProc: () => eval('typeof process'),
      fnProc: () => Function('return typeof process')(),
    };
    for (const k of Object.keys(probes)) { try { log(k + '=' + probes[k]()); } catch (e) { log(k + '!' + e.message); } }
    try { import('node:fs').then(() => log('IMPORTED')); log('import returned'); } catch (e) { log('import!' + e.message); }
  `);
  assert.equal(r.error, undefined, r.error ?? '');
  const out = r.logs.join('\n');
  assert.doesNotMatch(out, /=object|=function|IMPORTED/, out);
  assert.match(out, /globals=undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined/);
  assert.match(out, /thisCtor(=undefined|!process is not defined)/);
  assert.match(out, /fnCtor(=undefined|!process is not defined)/);
});

test('sandbox: infinite loops time out', async () => {
  const t0 = Date.now();
  const r = await run(`while (true) {}`, { timeoutMs: 500 });
  assert.match(r.error!, /^Timeout/);
  assert.ok(Date.now() - t0 < 8000);
  const cb = await run(`box({ from: [0,0,0], to: [1,1,1] }, () => { for (;;) {} })`, { timeoutMs: 500 });
  assert.match(cb.error!, /^Timeout/);
});

test('sandbox: giant allocations hit the memory cap', async () => {
  const r = await run(`const a = []; for (;;) a.push(new Array(1e6).fill(7));`, { memoryMb: 64, timeoutMs: 20000 });
  assert.match(r.error!, /Out of memory|block limit|RangeError|Invalid array length/i);
  const s = await run(`let s = 'x'; for (;;) s += s;`, { memoryMb: 64 });
  assert.ok(s.error, 'string doubling must fail');
});

test('sandbox: child process runs with the permission model (no fs write, child_process, net, worker)', () => {
  const args = scriptNodeArgs(64);
  assert.ok(args.includes('--permission'));
  assert.ok(!args.some((a) => /allow-(fs-write|child-process|worker|net|addons|wasi|ffi|inspector)/.test(a)));
  const flags = args.slice(0, -1); // without the worker path
  const probe = `
    const out = {};
    const t = (k, f) => { try { f(); out[k] = 'allowed'; } catch (e) { out[k] = e.code || e.message; } };
    const fs = require('node:fs');
    t('write', () => fs.writeFileSync(require('node:os').tmpdir() + '/mcai-sandbox-probe.txt', 'x'));
    t('readEtc', () => fs.readFileSync('/etc/hosts'));
    t('child', () => require('node:child_process').execSync('echo hi'));
    t('worker', () => new (require('node:worker_threads').Worker)('1', { eval: true }));
    const sock = require('node:net').connect(9, '127.0.0.1');
    sock.on('connect', () => { out.net = 'allowed'; console.log(JSON.stringify(out)); });
    sock.on('error', (e) => { out.net = e.code; console.log(JSON.stringify(out)); });
  `;
  const p = spawnSync(process.execPath, [...flags, '-e', probe], { encoding: 'utf8', env: {} });
  const out = JSON.parse(p.stdout.trim().split('\n').pop()!);
  for (const k of ['write', 'readEtc', 'child', 'worker', 'net']) assert.equal(out[k], 'ERR_ACCESS_DENIED', `${k}: ${out[k]}`);
});

test('script: empty / huge code is rejected without spawning', async () => {
  assert.match((await run('   ')).error!, /empty/);
  assert.match((await run('x'.repeat(300 * 1024))).error!, /too long/);
});

test('script: roof helper and local frame', async () => {
  const r = await run(`roof({ box: { min: [0, 5, 0], max: [4, 5, 6] }, style: 'gable', stairs: 'oak_stairs' })`, {
    frame: { anchor: [0, 0, 0], facing: 'south' },
  });
  assert.equal(r.error, undefined, r.error ?? '');
  assert.ok(r.entries.length > 10);
  assert.ok(r.entries.some(([, , , s]) => s.startsWith('minecraft:oak_stairs')));
});
