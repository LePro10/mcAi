import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roof, roofMaterials, validateRoofParams, type RoofParams } from '../../src/core/shapes.ts';
import { parseBlockState } from '../../src/core/blockstate.ts';
import { RegistryError } from '../../src/core/registry.ts';
import { executeOps, OpError, type BuildOp } from '../../src/core/dsl.ts';
import { Frame } from '../../src/core/frame.ts';
import { MapSink, key, reg } from './helpers.ts';

function build(p: RoofParams): Map<string, string> {
  const m = new Map<string, string>();
  roof(p, reg, (x, y, z, s) => {
    const k = key(x, y, z);
    assert.ok(!m.has(k), `duplicate at ${k}`);
    m.set(k, s);
  });
  return m;
}
const xyz = (k: string) => k.split(',').map(Number) as [number, number, number];
const topY = (m: Map<string, string>, x: number, z: number) =>
  Math.max(...[...m.keys()].map(xyz).filter(([a, , c]) => a === x && c === z).map(([, y]) => y));
const DIR: Record<string, [number, number]> = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };

test('cone: every roof stair faces the centre, footprint circle closed', () => {
  for (const [r, overhang, pitch, flare] of [[3, 1, undefined, undefined], [4, 0, 2, 1], [5, 1, 1, undefined], [6, 1, 3, 0], [7, 2, undefined, 2], [7, 2, 1.5, 1]] as const) {
    const label = `cone r=${r} o=${overhang} p=${pitch} f=${flare}`;
    const m = build({ box: { min: [-r, 0, -r], max: [r, 0, r] }, style: 'cone', stairs: 'oak_stairs', overhang, pitch, flare });
    let n = 0;
    for (const [k, s] of m) {
      const b = parseBlockState(s);
      if (!b.name.endsWith('_stairs') || b.props.half !== 'bottom') continue;
      const [x, , z] = xyz(k);
      const [dx, dz] = DIR[b.props.facing];
      assert.ok(-x * dx - z * dz > 0, `${label}: stair at ${k} faces ${b.props.facing}, not toward the centre`);
      n++;
    }
    assert.ok(n > 20, label);
    const cols = new Set([...m.keys()].map((k) => { const [x, , z] = xyz(k); return `${x},${z}`; }));
    for (let x = -r; x <= r; x++) for (let z = -r; z <= r; z++)
      if (Math.hypot(x, z) <= r) assert.ok(cols.has(`${x},${z}`), `${label}: hole at ${x},${z}`);
    // apex is the single highest column
    const ys = [...m.keys()].map((k) => xyz(k)[1]);
    assert.equal(topY(m, 0, 0), Math.max(...ys), label);
  }
});

test('round dome/spire: footprint is a disc (no square corners), square dome still available', () => {
  for (const style of ['dome', 'spire'] as const) {
    const m = build({ box: { min: [-5, 0, -5], max: [5, 0, 5] }, style, stairs: 'stone_brick_stairs', round: true, overhang: 0 });
    const cols = new Set([...m.keys()].map((k) => { const [x, , z] = xyz(k); return `${x},${z}`; }));
    assert.ok(!cols.has('5,5') && !cols.has('-5,-5'), `${style}: corner column filled`);
    for (let x = -5; x <= 5; x++) for (let z = -5; z <= 5; z++) if (Math.hypot(x, z) <= 5) assert.ok(cols.has(`${x},${z}`), `${style}: hole at ${x},${z}`);
  }
  const sq = build({ box: { min: [-5, 0, -5], max: [5, 0, 5] }, style: 'dome', stairs: 'stone_brick_stairs', round: false, overhang: 0 });
  assert.ok([...sq.keys()].some((k) => { const [x, , z] = xyz(k); return x === 5 && z === 5; }));
});

test('swept_hip: skipBox leaves the tier above free, corners lift with `lift`', () => {
  const box = { min: [0, 0, 0] as [number, number, number], max: [12, 0, 12] as [number, number, number] };
  const m = build({ box, style: 'swept_hip', stairs: 'dark_oak_stairs', skipBox: { min: [3, 0, 3], max: [9, 5, 9] } });
  assert.ok(m.size > 100);
  for (const k of m.keys()) {
    const [x, , z] = xyz(k);
    assert.ok(!(x >= 3 && x <= 9 && z >= 3 && z <= 9), `block inside skipBox at ${k}`);
  }
  // overhang 2 by default; the eave corner rises above the eave middle, more with a larger lift
  const flat = build({ box, style: 'swept_hip', stairs: 'dark_oak_stairs', lift: 0 });
  assert.equal(topY(flat, -2, -2), topY(flat, 6, -2));
  const l1 = build({ box, style: 'swept_hip', stairs: 'dark_oak_stairs' });
  const l2 = build({ box, style: 'swept_hip', stairs: 'dark_oak_stairs', lift: 2 });
  assert.ok(topY(l1, -2, -2) > topY(l1, 6, -2));
  assert.ok(topY(l2, -2, -2) > topY(l1, -2, -2));
  // concave: the lower half of the slope is shallower than the upper half
  const prof = [-2, -1, 0, 1, 2, 3, 4, 5, 6].map((z) => topY(l1, 6, z));
  assert.ok(prof[4] - prof[0] < prof[8] - prof[4], `profile ${prof}`);
});

test('swept_hip eave details: soffit, fascia, brackets, finial', () => {
  const box = { min: [0, 0, 0] as [number, number, number], max: [12, 0, 12] as [number, number, number] };
  const plain = build({ box, style: 'swept_hip', stairs: 'dark_oak_stairs' });
  const m = build({ box, style: 'swept_hip', stairs: 'dark_oak_stairs', soffit: true, fascia: true, brackets: true, finial: true });
  const vals = [...m.values()];
  assert.ok(vals.filter((s) => s.startsWith('minecraft:dark_oak_stairs') && s.includes('half=top')).length > 20, 'soffit/brackets');
  assert.ok(vals.filter((s) => s === reg.canonical('dark_oak_slab[type=top]')).length > 20, 'fascia');
  assert.ok(vals.some((s) => s.startsWith('minecraft:waxed_lightning_rod')) || vals.some((s) => s.startsWith('minecraft:end_rod')), 'finial');
  // details only add blocks below/around the eave: the roof surface itself is unchanged except the apex
  let changed = 0;
  for (const [k, s] of plain) if (m.get(k) !== s) changed++;
  assert.ok(changed <= 2, `changed ${changed}`);
  // custom materials
  const c = build({ box, style: 'swept_hip', stairs: 'dark_oak_stairs', fascia: 'red_terracotta', soffit: 'spruce_slab', brackets: false, finial: ['gold_block'] });
  assert.ok([...c.values()].includes('minecraft:red_terracotta'));
  assert.ok([...c.values()].includes(reg.canonical('spruce_slab[type=top]')));
  assert.ok([...c.values()].includes('minecraft:gold_block'));
  // no overhang: no eave details at all
  const o0 = build({ box, style: 'swept_hip', stairs: 'dark_oak_stairs', overhang: 0, fascia: true, soffit: true, brackets: true });
  assert.ok(![...o0.values()].some((s) => s.includes('half=top') || s.includes('type=top')));
});

test('cone with soffit + finial on a dome plateau', () => {
  const m = build({ box: { min: [-5, 0, -5], max: [5, 0, 5] }, style: 'cone', stairs: 'spruce_stairs', soffit: true, finial: true });
  assert.ok([...m.values()].some((s) => s.includes('half=top')));
  const d = build({ box: { min: [-5, 0, -5], max: [5, 0, 5] }, style: 'dome', stairs: 'deepslate_tile_stairs', finial: true });
  const rods = [...d].filter(([, s]) => s.startsWith('minecraft:waxed_lightning_rod'));
  assert.equal(rods.length, 1);
  assert.deepEqual([xyz(rods[0][0])[0], xyz(rods[0][0])[2]], [0, 0]);
});

test('fill: true maps every registry stairs block to its full block', () => {
  const ids = reg.tagMembers('stairs');
  assert.ok(ids.length > 50);
  for (const id of ids) {
    const full = roofMaterials(reg, id).full;
    assert.ok(reg.isFullSolid(full), `${id} → ${full}`);
    assert.ok(!/_stairs$|_slab$/.test(full), `${id} → ${full}`);
    const m = build({ box: { min: [0, 0, 0], max: [4, 0, 4] }, style: 'hip', stairs: id, overhang: 0, fill: true });
    assert.ok([...m.values()].includes(full), `${id}: fill:true did not place ${full}`);
  }
  const known: [string, string][] = [
    ['oak_stairs', 'oak_planks'], ['bamboo_stairs', 'bamboo_planks'], ['stone_brick_stairs', 'stone_bricks'],
    ['deepslate_tile_stairs', 'deepslate_tiles'], ['tuff_brick_stairs', 'tuff_bricks'], ['smooth_quartz_stairs', 'smooth_quartz'],
    ['prismarine_brick_stairs', 'prismarine_bricks'], ['end_stone_brick_stairs', 'end_stone_bricks'],
    ['nether_brick_stairs', 'nether_bricks'], ['exposed_cut_copper_stairs', 'exposed_cut_copper'],
  ];
  for (const [s, f] of known) assert.equal(roofMaterials(reg, s).full, `minecraft:${f}`, s);
  // explicit block id still works
  const m = build({ box: { min: [0, 0, 0], max: [4, 0, 4] }, style: 'hip', stairs: 'oak_stairs', overhang: 0, fill: 'cobblestone' });
  assert.ok([...m.values()].includes('minecraft:cobblestone'));
});

test('roof params are validated with clear RegistryErrors', () => {
  const base: RoofParams = { box: { min: [0, 0, 0], max: [6, 0, 6] }, style: 'hip', stairs: 'oak_stairs' };
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ fill: 3 }, /roof: fill must be true or a block id, got number/],
    [{ fill: 'not_a_block' }, /Unknown block/],
    [{ style: 'nope' }, /unknown style/],
    [{ round: true }, /round is only supported for dome, spire and cone/],
    [{ style: 'cone', round: false }, /cone is always round/],
    [{ overhang: -1 }, /overhang must be between 0 and 16, got -1/],
    [{ pitch: Number.NaN }, /pitch must be a number, got NaN/],
    [{ flare: 'x' }, /flare must be a number, got string/],
    [{ sweep: 99 }, /sweep must be between/],
    [{ lift: -1 }, /lift must be between/],
    [{ bracketEvery: 0 }, /bracketEvery must be between 1 and 64/],
    [{ skipBox: { min: [0, 0] } }, /skipBox\.min must be \[x,y,z\]/],
    [{ skipBox: 5 }, /skipBox/],
    [{ finial: 5 }, /finial must be true, a block id or a list of block ids, got number/],
    [{ brackets: 2 }, /brackets must be true or a block id, got number/],
    [{ soffit: {} }, /soffit must be true or a block id, got object/],
    [{ stairs: 7 }, /stairs/],
    [{ box: null }, /box/],
  ];
  for (const [extra, re] of bad) {
    const p = { ...base, ...extra } as RoofParams;
    assert.throws(() => roof(p, reg, () => {}), (e: unknown) => e instanceof RegistryError && re.test((e as Error).message), JSON.stringify(extra));
  }
  assert.doesNotThrow(() => validateRoofParams({ ...base, style: 'swept_hip', sweep: 2, lift: 1.5, fascia: true, soffit: 'spruce_slab', brackets: true, bracketEvery: 3, finial: ['stone_brick_wall', 'lantern'] }));
});

test('dsl roof op passes the new params through (skipBox, finial, fill:true)', () => {
  const sink = new MapSink();
  const ops = [
    { op: 'roof', box: [[0, 6, 0], [12, 6, 12]], style: 'swept_hip', stairs: 'dark_oak_stairs', skipBox: [[3, 6, 3], [9, 12, 9]], fascia: true, brackets: 'spruce_stairs', bracketEvery: 3 },
    { op: 'roof', box: { min: [20, 6, 0], max: [28, 6, 8] }, style: 'cone', stairs: 'spruce_stairs', flare: 2, finial: ['lantern'], fill: true, soffit: true },
    { op: 'roof', box: { min: [40, 6, 0], max: [48, 6, 8] }, style: 'spire', round: true, stairs: 'deepslate_tile_stairs' },
  ];
  executeOps(ops as BuildOp[], { sink, reg, frame: Frame.identity(reg) });
  const ks = [...sink.m.keys()];
  assert.ok(!ks.some((k) => { const [x, , z] = xyz(k); return x >= 3 && x <= 9 && z >= 3 && z <= 9; }), 'skipBox');
  const vals = [...sink.m.values()];
  assert.ok(vals.some((s) => s.startsWith('minecraft:lantern')));
  assert.ok(vals.includes('minecraft:spruce_planks'));
  assert.throws(() => executeOps([{ op: 'roof', box: [[0, 0, 0], [4, 0, 4]], style: 'hip', stairs: 'oak_stairs', round: true }] as BuildOp[], { sink, reg, frame: Frame.identity(reg) }), (e: unknown) => e instanceof OpError && /round is only supported/.test((e as Error).message));
});

test('cone rings: one height per ring, 8-fold symmetric, monotone, 2-high rings at pitch 2, eave kick', () => {
  for (const r of [3, 4, 5, 7])
    for (const pitch of [1, 2]) {
      const label = `cone r=${r} p=${pitch}`;
      const m = build({ box: { min: [-r, 0, -r], max: [r, 0, r] }, style: 'cone', stairs: 'spruce_stairs', pitch, overhang: 1 });
      const top = new Map<string, number>();
      for (const k of m.keys()) { const [x, y, z] = xyz(k); top.set(`${x},${z}`, Math.max(top.get(`${x},${z}`) ?? -99, y)); }
      const ring = new Map<number, Set<number>>();
      for (const [ck, y] of top) {
        const [x, z] = ck.split(',').map(Number);
        for (const [a, b] of [[z, x], [-x, z], [x, -z]]) assert.equal(top.get(`${a},${b}`), y, `${label}: asymmetric at ${ck}`);
        const s = r + 0.5 - Math.hypot(x, z);
        if (s < 0) { assert.equal(y, 0, `${label}: eave kick slab at ${ck}`); continue; }
        const k = Math.floor(s + 1e-9);
        if (!ring.has(k)) ring.set(k, new Set());
        ring.get(k)!.add(y);
      }
      const ks = [...ring.keys()].sort((a, b) => a - b);
      let prev = -1;
      for (const k of ks.slice(0, -1)) {
        // the apex ring may be capped lower; every other ring is level all the way round
        assert.equal(ring.get(k)!.size, 1, `${label}: ring ${k} heights ${[...ring.get(k)!]}`);
        const y = [...ring.get(k)!][0];
        assert.equal(y - prev, pitch, `${label}: ring ${k} rise`);
        prev = y;
      }
      // eave ring is a bottom slab ring (flare 1)
      assert.equal(m.get(key(r + 1, 0, 0)), reg.canonical('spruce_slab[type=bottom]'), label);
    }
});
