import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { BuildOpSchema, DSL_HELP, executeOps, OpError, type BuildOp, type BlockSink } from '../../src/core/dsl.ts';
import { Frame } from '../../src/core/frame.ts';
import { solveConnections } from '../../src/core/connect.ts';
import { AIR } from '../../src/core/blockstate.ts';
import type { Facing, Vec3 } from '../../src/core/types.ts';
import { MapSink, key, reg } from './helpers.ts';
import { loadFactor } from '../load.ts';

const C = (s: string) => reg.canonical(s);
const run = (ops: unknown[], frame = Frame.identity(reg), sink = new MapSink(), seed?: number) => {
  const res = executeOps(ops as BuildOp[], { sink, reg, frame, seed });
  return { sink, res };
};

test('schema: every op parses; discriminated on op; defaults untouched', () => {
  const ops: unknown[] = [
    { op: 'set', pos: [0, 0, 0], block: 'stone' },
    { op: 'fill', box: { min: [0, 0, 0], max: [2, 2, 2] }, block: 'stone', mode: 'walls' },
    { op: 'fill', box: [[0, 0, 0], [2, 2, 2]], block: '50%stone,50%dirt' },
    { op: 'fill', from: [0, 0, 0], to: [1, 1, 1], block: 'stone' },
    { op: 'ellipsoid', center: [0, 0, 0], radius: [3, 2, 3], block: 'glass', hollow: true },
    { op: 'sphere', center: [0, 0, 0], radius: 3, block: 'glass' },
    { op: 'cylinder', base: [0, 0, 0], radius: 2, height: 4, block: 'stone' },
    { op: 'cone', base: [0, 0, 0], radius: 2, height: 4, block: 'stone' },
    { op: 'pyramid', base: [0, 0, 0], size: 5, block: 'sandstone' },
    { op: 'torus', center: [0, 0, 0], major: 4, minor: 1, block: 'stone' },
    { op: 'line', from: [0, 0, 0], to: [5, 5, 5], block: 'stone' },
    { op: 'curve', points: [[0, 0, 0], [5, 5, 0]], block: 'stone' },
    { op: 'polygon', points: [[0, 0], [4, 0], [2, 4]], y: 0, height: 2, block: 'stone' },
    { op: 'arch', from: [0, 0, 0], to: [6, 0, 0], height: 3, block: 'stone' },
    { op: 'spiral', center: [0, 0, 0], radius: 2, height: 8, turns: 1, stairs: 'oak_stairs' },
    { op: 'roof', box: { min: [0, 4, 0], max: [6, 4, 4] }, style: 'hip', stairs: 'oak_stairs' },
    { op: 'replace', box: [[0, 0, 0], [3, 3, 3]], from: 'stone', to: 'andesite' },
    { op: 'clear', box: [[0, 0, 0], [3, 3, 3]] },
    { op: 'set', pos: [0, 0, 0], block: { type: 'gradient', axis: 'y', stops: ['stone', 'dirt'] }, mask: { not: 'air' } },
  ];
  for (const o of ops) assert.ok(BuildOpSchema.safeParse(o).success, JSON.stringify(o));
  const bad = BuildOpSchema.safeParse({ op: 'teleport' });
  assert.ok(!bad.success);
  assert.ok(!BuildOpSchema.safeParse({ op: 'line', from: [0, 0], to: [1, 1, 1], block: 'stone' }).success);
  // JSON schema for the MCP tool can be generated and stays compact
  const js = JSON.stringify(z.toJSONSchema(z.object({ ops: z.array(BuildOpSchema) }), { io: 'input', reused: 'ref' }));
  assert.ok(js.length < 30_000, `schema ${js.length} chars`);
  assert.ok(js.includes('"roof"') && js.includes('watertight'));
  // help mentions every op
  for (const name of ['set', 'fill', 'clear', 'replace', 'ellipsoid', 'sphere', 'cylinder', 'cone', 'pyramid', 'torus', 'line', 'curve', 'polygon', 'arch', 'spiral', 'roof'])
    assert.ok(DSL_HELP.includes(name), name);
  assert.ok(DSL_HELP.length < 6000);
  // every example in DSL_HELP that is a single JSON op parses and executes
  const examples = DSL_HELP.match(/\{op:"[^\n]*?\}(?=\s{2,}|\s*\||\s*$|\s*\(|\s*mode|\s*axis|\s*height|\s*kind|\s*ring|\s*$)/gm) ?? [];
  assert.ok(examples.length >= 14, `found ${examples.length} examples`);
  for (const ex of examples) {
    const json = ex.replace(/([{,]\s*)([a-zA-Z_]+):/g, '$1"$2":');
    const op = JSON.parse(json);
    assert.ok(BuildOpSchema.safeParse(op).success, ex);
    run([op]);
  }
});

test('set/fill/clear/replace with masks and change counting', () => {
  const { sink, res } = run([
    { op: 'fill', box: [[0, 0, 0], [4, 4, 4]], block: 'stone' },
    { op: 'fill', box: [[0, 0, 0], [4, 4, 4]], block: 'stone' },
    { op: 'replace', box: [[0, 0, 0], [4, 0, 4]], from: 'stone', to: 'dirt' },
    { op: 'fill', box: [[0, 0, 0], [4, 4, 4]], block: 'glass', mask: 'dirt' },
    { op: 'clear', box: [[0, 4, 0], [4, 4, 4]] },
    { op: 'set', positions: [[0, 5, 0], [1, 5, 0]], block: 'lantern' },
    { op: 'set', entries: [[2, 5, 0, 'torch'], [3, 5, 0, 'oak_stairs[facing=east]']] },
  ]);
  assert.deepEqual(res.map((r) => r.changed), [125, 0, 25, 25, 25, 2, 2]);
  assert.ok(res[1].warnings.some((w) => /nothing changed/.test(w)));
  assert.equal(sink.get(2, 0, 2), 'minecraft:glass');
  assert.equal(sink.get(2, 4, 2), AIR);
  assert.equal(sink.get(3, 5, 0), C('oak_stairs[facing=east]'));
  // replace with corners in from/to (lenient form) + mask
  const r2 = run([{ op: 'fill', box: [[0, 0, 0], [2, 0, 2]], block: 'stone' }, { op: 'replace', from: [0, 0, 0], to: [2, 0, 2], mask: 'stone', block: 'andesite' }]);
  assert.equal(r2.res[1].changed, 9);
  // replace default from = !air
  const r3 = run([{ op: 'set', pos: [0, 0, 0], block: 'stone' }, { op: 'replace', box: [[0, 0, 0], [3, 3, 3]], to: 'gold_block' }]);
  assert.equal(r3.res[1].changed, 1);
  const masked = run([{ op: 'fill', box: [[0, 0, 0], [1, 1, 1]], block: 'stone', mask: 'water' }]);
  assert.ok(masked.res[0].warnings.some((w) => /mask excluded/.test(w)));
});

test('frame: local coordinates and block states are rotated into world space', () => {
  const facings: Facing[] = ['north', 'east', 'south', 'west'];
  for (const f of facings) {
    const frame = new Frame([100, 64, 100], f, reg);
    const { sink } = run([
      { op: 'set', pos: [0, 0, -3], block: 'oak_stairs[facing=north]' },
      { op: 'set', pos: [2, 0, 0], block: 'oak_door[facing=south]' },
    ], frame);
    const w1 = frame.toWorld([0, 0, -3]);
    assert.equal(sink.get(...w1), C(`oak_stairs[facing=${f}]`));
    const w2 = frame.toWorld([2, 0, 0]);
    assert.equal(sink.get(...w2), frame.stateToWorld('oak_door[facing=south]'));
    assert.equal(sink.m.size, 2);
  }
});

test('rotated roofs stay consistent with vanilla stair shapes', () => {
  for (const f of ['east', 'south', 'west'] as Facing[]) {
    const frame = new Frame([0, 0, 0], f, reg);
    const { sink } = run([{ op: 'roof', box: { min: [-4, 5, -9], max: [4, 5, 0] }, style: 'hip', stairs: 'spruce_stairs' }], frame);
    const pos: Vec3[] = [...sink.m.keys()].map((k) => k.split(',').map(Number) as Vec3);
    assert.deepEqual(solveConnections((x, y, z) => sink.get(x, y, z), pos, reg), [], f);
  }
});

test('patterns are deterministic per seed and evaluated in local space', () => {
  const ops = [{ op: 'fill', box: [[0, 0, 0], [9, 9, 9]], block: '50%stone,50%dirt' }];
  const a = run(ops, Frame.identity(reg), new MapSink(), 5).sink;
  const b = run(ops, Frame.identity(reg), new MapSink(), 5).sink;
  const c = run(ops, Frame.identity(reg), new MapSink(), 6).sink;
  assert.deepEqual([...a.m], [...b.m]);
  assert.notDeepEqual([...a.m], [...c.m]);
  // gradient along local y over the op's bounds
  const g = run([{ op: 'fill', box: [[0, 0, 0], [0, 9, 0]], block: { type: 'gradient', axis: 'y', stops: ['stone', 'dirt'] } }]).sink;
  assert.equal(g.get(0, 0, 0), 'minecraft:stone');
  assert.equal(g.get(0, 9, 0), 'minecraft:dirt');
  // gradient along local x survives a rotated frame (west: local +x → world −z)
  const fr = new Frame([0, 0, 0], 'west', reg);
  const gw = run([{ op: 'fill', box: [[0, 0, 0], [9, 0, 0]], block: { type: 'gradient', axis: 'x', stops: ['stone', 'dirt'] } }], fr).sink;
  assert.equal(gw.get(...fr.toWorld([0, 0, 0])), 'minecraft:stone');
  assert.equal(gw.get(...fr.toWorld([9, 0, 0])), 'minecraft:dirt');
});

test('shape ops via DSL: box forms, spiral stairs + column, arch, keep', () => {
  const e = run([{ op: 'ellipsoid', box: { min: [0, 0, 0], max: [7, 3, 5] }, block: 'stone' }]).sink;
  const xs = [...e.m.keys()].map((k) => Number(k.split(',')[0]));
  assert.deepEqual([Math.min(...xs), Math.max(...xs)], [0, 7]);
  const cyl = run([{ op: 'cylinder', box: [[0, 0, 0], [5, 9, 5]], block: 'stone', hollow: true }]).sink;
  assert.ok(cyl.get(0, 0, 2) !== AIR && cyl.get(2, 5, 2) === AIR && cyl.get(5, 9, 3) !== AIR);
  const pyr = run([{ op: 'pyramid', box: { min: [0, 0, 0], max: [8, 0, 8] }, block: 'sandstone' }]).sink;
  assert.equal(pyr.m.size, 81 + 49 + 25 + 9 + 1);
  const sp = run([{ op: 'spiral', center: [0, 0, 0], radius: 2, height: 12, turns: 1.5, stairs: 'stone_brick_stairs', column: 'stone_bricks' }]).sink;
  for (let y = 0; y < 12; y++) assert.equal(sp.get(0, y, 0), 'minecraft:stone_bricks');
  assert.ok([...sp.m.values()].filter((s) => s.includes('stairs')).length > 12);
  const keep = run([{ op: 'fill', box: [[0, 0, 0], [9, 0, 9]], block: 'stone' }, { op: 'fill', box: [[0, 0, 0], [9, 0, 9]], block: '50%keep,50%mossy_cobblestone' }]);
  assert.ok(keep.res[1].changed > 20 && keep.res[1].changed < 80);
});

test('errors: OpError with index and actionable message, nothing written by the failing op', () => {
  const sink = new MapSink();
  const t = (ops: unknown[], idx: number, re: RegExp) =>
    assert.throws(
      () => run(ops, Frame.identity(reg), sink),
      (e: unknown) => {
        assert.ok(e instanceof OpError, String(e));
        assert.equal(e.index, idx);
        assert.match(e.message, re);
        return true;
      },
    );
  t([{ op: 'set', pos: [0, 0, 0], block: 'stone' }, { op: 'fill', box: [[0, 0, 0], [3, 3, 3]], block: 'oak_plank' }], 1, /oak_planks/);
  assert.equal(sink.m.size, 1); // op 0 ran, op 1 wrote nothing
  t([{ op: 'fill', block: 'stone' }], 0, /needs "box"/);
  t([{ op: 'fill', box: [[0, 0, 0], [1, 1, 1]], block: 'stone', mask: '#nope' }], 0, /mask/);
  t([{ op: 'wobble' }], 0, /invalid op/);
  t([{ op: 'roof', box: [[0, 0, 0], [3, 0, 3]], style: 'gable', stairs: 'oak_log' }], 0, /not a stairs block/);
  t([{ op: 'arch', from: [0, 0, 0], to: [3, 0, 3], height: 2, block: 'stone' }], 0, /aligned/);
  t([{ op: 'set', pos: [0, 0, 0] }], 0, /block/);
  t([{ op: 'spiral', center: [0, 0, 0], radius: 2, height: 4, turns: 1 }], 0, /block|stairs/);
  t([{ op: 'set', entries: [[0, 0, 0, 'oak_stairs[facing=up]']] }], 0, /facing/);
});

test('performance: 2M-block fill and a big sphere through executeOps', () => {
  class FastSink implements BlockSink {
    n = 0;
    get(): string { return AIR; }
    set(): void { this.n++; }
  }
  const sink = new FastSink();
  const t0 = performance.now();
  executeOps(
    [
      { op: 'fill', box: { min: [0, 0, 0], max: [199, 49, 199] }, block: '60%stone_bricks,30%cracked_stone_bricks,10%mossy_stone_bricks' },
      { op: 'sphere', center: [0, 100, 0], radius: 50, block: 'glass' },
    ] as BuildOp[],
    { sink, reg, frame: new Frame([10, 0, 10], 'east', reg) },
  );
  const ms = performance.now() - t0;
  assert.ok(sink.n > 2_000_000 + 500_000);
  assert.ok(ms < 6000 * loadFactor(), `${ms} ms`);
});
