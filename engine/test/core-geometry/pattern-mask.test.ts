import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compilePattern, hash3, splitTopLevel, uniformNoise3, PatternError, patternBlocks } from '../../src/core/pattern.ts';
import { compileMask, MaskError } from '../../src/core/mask.ts';
import { reg } from './helpers.ts';

const C = (s: string) => reg.canonical(s);

function histogram(fn: (x: number, y: number, z: number) => string | null, n = 40): Map<string | null, number> {
  const h = new Map<string | null, number>();
  for (let y = 0; y < n; y++) for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    const s = fn(x, y, z);
    h.set(s, (h.get(s) ?? 0) + 1);
  }
  return h;
}

test('splitTopLevel ignores commas inside [] and {}', () => {
  assert.deepEqual(splitTopLevel('50%oak_stairs[facing=east,half=top], 50%chest{Items:[{a:1,b:"x,y"}]}'), [
    '50%oak_stairs[facing=east,half=top]',
    '50%chest{Items:[{a:1,b:"x,y"}]}',
  ]);
});

test('single block, keep, states with properties', () => {
  assert.equal(compilePattern('stone', reg)(1, 2, 3), 'minecraft:stone');
  assert.equal(compilePattern('keep', reg)(0, 0, 0), null);
  assert.equal(compilePattern('oak_stairs[facing=east,half=top]', reg)(0, 0, 0), C('oak_stairs[facing=east,half=top]'));
});

test('weighted string: percent and plain numbers, distribution', () => {
  const h = histogram(compilePattern('60%stone_bricks,30%cracked_stone_bricks,10%mossy_stone_bricks', reg, { seed: 1 }));
  const n = 40 ** 3;
  assert.ok(Math.abs(h.get('minecraft:stone_bricks')! / n - 0.6) < 0.02);
  assert.ok(Math.abs(h.get('minecraft:cracked_stone_bricks')! / n - 0.3) < 0.02);
  assert.ok(Math.abs(h.get('minecraft:mossy_stone_bricks')! / n - 0.1) < 0.02);
  const h2 = histogram(compilePattern('3*stone,1*andesite', reg, { seed: 2 }));
  assert.ok(Math.abs(h2.get('minecraft:stone')! / n - 0.75) < 0.02);
  const h3 = histogram(compilePattern('stone,andesite', reg, { seed: 2 }));
  assert.ok(Math.abs(h3.get('minecraft:stone')! / n - 0.5) < 0.02);
  const h4 = histogram(compilePattern('70%keep,30%mossy_cobblestone', reg));
  assert.ok(Math.abs(h4.get(null)! / n - 0.7) < 0.02);
  const h5 = histogram(compilePattern([{ block: 'stone', weight: 1 }, { block: 'dirt', weight: 3 }], reg));
  assert.ok(Math.abs(h5.get('minecraft:dirt')! / n - 0.75) < 0.02);
});

test('deterministic: independent of evaluation order, depends on seed', () => {
  const a = compilePattern('50%stone,50%dirt', reg, { seed: 42 });
  const b = compilePattern('50%stone,50%dirt', reg, { seed: 42 });
  const c = compilePattern('50%stone,50%dirt', reg, { seed: 43 });
  const fwd: string[] = [], rev: string[] = [];
  for (let i = 0; i < 1000; i++) fwd.push(a(i, i * 7, -i)!);
  for (let i = 999; i >= 0; i--) rev.unshift(b(i, i * 7, -i)!);
  assert.deepEqual(fwd, rev);
  let diff = 0;
  for (let i = 0; i < 1000; i++) if (c(i, i * 7, -i) !== fwd[i]) diff++;
  assert.ok(diff > 300);
  // hash is in [0,1) and well spread
  let s = 0;
  for (let i = 0; i < 10000; i++) {
    const v = hash3(i, -i, i * 3, 9);
    assert.ok(v >= 0 && v < 1);
    s += v;
  }
  assert.ok(Math.abs(s / 10000 - 0.5) < 0.02);
});

test('gradient: bands along axis, with bounds or from/to, optional dither', () => {
  const bounds = { min: [0, 0, 0] as [number, number, number], max: [0, 9, 0] as [number, number, number] };
  const g = compilePattern({ type: 'gradient', axis: 'y', stops: ['stone', 'andesite'] }, reg, { bounds });
  const col = Array.from({ length: 10 }, (_, y) => g(0, y, 0));
  assert.deepEqual(col, [...Array(5).fill('minecraft:stone'), ...Array(5).fill('minecraft:andesite')]);
  const g2 = compilePattern({ type: 'gradient', axis: 'x', stops: ['a_x'.replace('a_x', 'stone'), 'dirt', 'sand'], from: 0, to: 2 }, reg);
  assert.deepEqual([g2(0, 0, 0), g2(1, 0, 0), g2(2, 0, 0), g2(-5, 0, 0), g2(9, 0, 0)].map((s) => s!.slice(10)), ['stone', 'dirt', 'sand', 'stone', 'sand']);
  // dither: monotone mixing, exact ends
  const gd = compilePattern({ type: 'gradient', axis: 'y', stops: ['stone', 'dirt'], dither: true }, reg, { bounds: { min: [0, 0, 0], max: [15, 15, 15] } });
  let prev = -1;
  for (let y = 0; y <= 15; y++) {
    let d = 0;
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) if (gd(x, y, z) === 'minecraft:dirt') d++;
    assert.ok(d >= prev, 'dither fraction must not decrease');
    prev = d;
    if (y === 0) assert.equal(d, 0);
    if (y === 15) assert.equal(d, 256);
  }
  assert.throws(() => compilePattern({ type: 'gradient', axis: 'y', stops: ['stone'] }, reg), /bounds/);
  // stops may be weighted sub-patterns
  const gw = compilePattern({ type: 'gradient', axis: 'y', stops: ['50%stone,50%cobblestone', 'dirt'] }, reg, { bounds });
  assert.ok(['minecraft:stone', 'minecraft:cobblestone'].includes(gw(0, 0, 0)!));
});

test('noise: deterministic, blobby, roughly uniform over blocks', () => {
  const spec = { type: 'noise' as const, blocks: ['stone', 'andesite', 'tuff'], scale: 5 };
  const f = compilePattern(spec, reg, { seed: 7 });
  const h = histogram(f, 48);
  const n = 48 ** 3;
  for (const b of ['minecraft:stone', 'minecraft:andesite', 'minecraft:tuff']) assert.ok(Math.abs(h.get(b)! / n - 1 / 3) < 0.08, `${b} ${h.get(b)! / n}`);
  // spatial coherence: neighbours usually equal
  let same = 0, tot = 0;
  for (let x = 0; x < 47; x++) for (let z = 0; z < 47; z++) { tot++; if (f(x, 3, z) === f(x + 1, 3, z)) same++; }
  assert.ok(same / tot > 0.7);
  assert.equal(compilePattern(spec, reg, { seed: 7 })(3, 4, 5), f(3, 4, 5));
  for (let i = 0; i < 1000; i++) { const v = uniformNoise3(i * 0.37, i * 0.11, -i * 0.23, 3); assert.ok(v >= 0 && v < 1); }
});

test('checker and stripes', () => {
  const ch = compilePattern({ type: 'checker', blocks: ['white_concrete', 'black_concrete'] }, reg);
  assert.notEqual(ch(0, 0, 0), ch(1, 0, 0));
  assert.notEqual(ch(0, 0, 0), ch(0, 1, 0));
  assert.equal(ch(0, 0, 0), ch(1, 1, 0));
  assert.equal(ch(-1, 0, 0), ch(1, 0, 0));
  const ch2 = compilePattern({ type: 'checker', blocks: ['white_concrete', 'black_concrete'], size: 2, axis: 'y' }, reg);
  assert.equal(ch2(0, 0, 0), ch2(1, 5, 1));
  assert.notEqual(ch2(0, 0, 0), ch2(2, 0, 0));
  const st = compilePattern({ type: 'stripes', blocks: ['red_wool', 'white_wool'], size: 2 }, reg);
  assert.deepEqual([0, 1, 2, 3, 4, -1, -2, -3].map((y) => st(9, y, 9)!.slice(10, 13)), ['red', 'red', 'whi', 'whi', 'red', 'whi', 'whi', 'red']);
});

test('pattern errors are raised at compile time and mention the bad entry', () => {
  assert.throws(() => compilePattern('50%stone,50%oak_plank', reg), (e: unknown) => {
    assert.ok(e instanceof PatternError);
    assert.match((e as Error).message, /"oak_plank"/);
    assert.match((e as Error).message, /oak_planks/);
    return true;
  });
  assert.throws(() => compilePattern({ type: 'noise', blocks: ['stone', 'oak_stairs[facing=up]'] }, reg), /noise.blocks\[1\].*facing/);
  assert.throws(() => compilePattern({ type: 'wobble' } as never, reg), /unknown type/);
  assert.throws(() => compilePattern([], reg), /empty/);
  assert.throws(() => compilePattern('0%stone', reg), /weights/);
  assert.deepEqual(patternBlocks('60%stone,40%keep', reg), ['minecraft:stone']);
});

test('mask keywords, ids, partial props, tags, negation, combinators', () => {
  const m = (spec: Parameters<typeof compileMask>[0], s: string) => compileMask(spec, reg)(0, 0, 0, C(s));
  assert.ok(m('air', 'air') && m('air', 'cave_air') && !m('air', 'stone'));
  assert.ok(m('!air', 'stone') && !m('!air', 'void_air'));
  assert.ok(m('solid', 'stone') && m('solid', 'glass') && !m('solid', 'oak_stairs'));
  assert.ok(m('liquid', 'water') && m('liquid', 'lava') && !m('liquid', 'oak_stairs[waterlogged=true]'));
  assert.ok(m('transparent', 'glass') && !m('transparent', 'stone') && m('opaque', 'stone'));
  assert.ok(m('replaceable', 'short_grass') && m('replaceable', 'air') && !m('replaceable', 'stone'));
  assert.ok(m('*', 'stone') && m('any', 'air'));
  assert.ok(m('stone', 'stone') && !m('stone', 'stone_bricks'));
  assert.ok(m('oak_stairs[half=top]', 'oak_stairs[half=top,facing=east]') && !m('oak_stairs[half=top]', 'oak_stairs'));
  assert.ok(m('#minecraft:logs', 'oak_log[axis=x]') && m('#logs', 'birch_wood') && !m('#logs', 'oak_planks'));
  assert.ok(m('stone,dirt', 'dirt') && m(['stone', 'dirt'], 'stone') && !m('stone,dirt', 'sand'));
  assert.ok(m({ not: 'stone' }, 'dirt') && !m({ not: 'stone' }, 'stone'));
  assert.ok(m({ all: ['solid', '!stone'] }, 'dirt') && !m({ all: ['solid', '!stone'] }, 'stone'));
  assert.ok(m({ any: ['#logs', { not: 'solid' }] }, 'air'));
  assert.ok(m('oak_stairs[facing=north]', 'oak_stairs')); // defaults count
});

test('mask errors', () => {
  assert.throws(() => compileMask('oak_plank', reg), (e: unknown) => e instanceof MaskError && /oak_planks/.test((e as Error).message));
  assert.throws(() => compileMask('#nonexistent_tag', reg), /tag/);
  assert.throws(() => compileMask('oak_stairs[facin=north]', reg), /no property/);
  assert.throws(() => compileMask('oak_stairs[facing=up]', reg), /invalid value/);
  assert.throws(() => compileMask([], reg), /empty/);
  assert.throws(() => compileMask({ all: [] } as never, reg), /non-empty/);
});
