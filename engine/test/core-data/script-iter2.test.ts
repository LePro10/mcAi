import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScript } from '../../src/core/script.ts';
import { executeOps } from '../../src/core/dsl.ts';
import { Frame } from '../../src/core/frame.ts';
import { reg } from './helpers.ts';

test('define(): generators keep the top-level helpers of their defining script (also in later scripts)', async () => {
  const code1 = [
    'const lerp = (a, b, t) => a + (b - a) * t;',
    'function top(x, z) { return 5; }',
    'const STONE = "stone"; const re = /a\\/b;c/g; const tpl = `x;${1 + 2}`;',
    'set(0, 0, 0, "dirt");',
    'define("pillar", function (p) { for (let y = 0; y < p.h; y++) set(p.x, top(p.x, 0) + y, 0, STONE); return lerp(0, 10, 0.5) + re.source.length + tpl.length; });',
    'log(call("pillar", { x: 1, h: 2 }));',
  ].join('\n');
  const r1 = await runScript({ code: code1 }, reg());
  assert.equal(r1.error, undefined);
  assert.deepEqual(r1.logs, ['14']);
  const src = r1.defines!.pillar!;
  assert.match(src, /function top/);
  assert.doesNotMatch(src, /set\(0, 0, 0, "dirt"\)/, 'side-effect statements are not captured');
  const r2 = await runScript({ code: 'log(call("pillar", { x: 3, h: 1 }))', generators: r1.defines }, reg());
  assert.equal(r2.error, undefined, String(r2.error));
  assert.deepEqual(r2.entries, [[3, 5, 0, 'minecraft:stone']]);
});

test('topY: actual top block incl. own writes; includeOwn:false / solid:true', async () => {
  const r = await runScript({ code: 'set(0, 4, 0, "stone"); set(0, 5, 0, "short_grass"); log(topY(0, 0), topY(0, 0, {solid:true}), topY(0, 0, {includeOwn:false}))', readBox: { min: [-2, -2, -2], max: [2, 10, 2] } }, reg());
  assert.equal(r.error, undefined, String(r.error));
  assert.deepEqual(r.logs, ['5 4 null']);
});

test('"keep" works wherever patterns are accepted (set entries, scripts)', async () => {
  const m = new Map<string, string>();
  const sink = { get: (x: number, y: number, z: number) => m.get(`${x},${y},${z}`) ?? 'minecraft:air', set: (x: number, y: number, z: number, s: string) => void m.set(`${x},${y},${z}`, s) };
  executeOps([{ op: 'set', entries: [[0, 0, 0, 'keep'], [1, 0, 0, 'stone'], [2, 0, 0, '100%keep']] }] as any, { sink, reg: reg(), frame: Frame.identity(reg()) });
  assert.deepEqual([...m.keys()], ['1,0,0']);
  const r = await runScript({ code: 'set(0,0,0,"keep"); set(1,0,0,"stone")' }, reg());
  assert.equal(r.error, undefined);
  assert.equal(r.entries.length, 1);
});
