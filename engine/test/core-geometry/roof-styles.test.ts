import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roof, roofMaterials, validateRoofParams, roofExtent, checkRoofFits, type RoofParams } from '../../src/core/shapes.ts';
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
    [{ fill: 3 }, /roof: fill must be true, a block id, a pattern .* or a state function, got number/],
    [{ ends: false, fill: 'not_a_block' }, /roof: fill: .*Unknown block/],
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

test('cone rings: level rings (45° seam cells lifted one step), 8-fold symmetric, monotone, eave kick', () => {
  for (const r of [3, 4, 5, 7])
    for (const pitch of [1, 2]) {
      const label = `cone r=${r} p=${pitch}`;
      const m = build({ box: { min: [-r, 0, -r], max: [r, 0, r] }, style: 'cone', stairs: 'spruce_stairs', pitch, overhang: 1 });
      const top = new Map<string, number>();
      for (const k of m.keys()) { const [x, y, z] = xyz(k); top.set(`${x},${z}`, Math.max(top.get(`${x},${z}`) ?? -99, y)); }
      const ring = new Map<number, Map<number, string[]>>();
      for (const [ck, y] of top) {
        const [x, z] = ck.split(',').map(Number);
        for (const [a, b] of [[z, x], [-x, z], [x, -z]]) assert.equal(top.get(`${a},${b}`), y, `${label}: asymmetric at ${ck}`);
        const s = r + 0.5 - Math.hypot(x, z);
        if (s < 0) { assert.equal(y, 0, `${label}: eave kick slab at ${ck}`); continue; }
        const k = Math.floor(s + 1e-9);
        if (!ring.has(k)) ring.set(k, new Map());
        const ys = ring.get(k)!;
        if (!ys.has(y)) ys.set(y, []);
        ys.get(y)!.push(ck);
      }
      const ks = [...ring.keys()].sort((a, b) => a - b);
      let prev = -1;
      for (const k of ks.slice(0, -1)) {
        // the apex ring may be capped lower; every other ring is level, except diagonal seam cells lifted to the next ring
        const ys = ring.get(k)!;
        const base = Math.min(...ys.keys());
        assert.equal(base - prev, pitch, `${label}: ring ${k} rise`);
        for (const [y, cells] of ys) {
          if (y === base) continue;
          assert.equal(y, base + pitch, `${label}: ring ${k} heights ${[...ys.keys()]}`);
          assert.ok(ys.get(base)!.length > cells.length, `${label}: ring ${k} mostly level`);
          for (const ck of cells) { const [x, z] = ck.split(',').map(Number); assert.ok(x !== 0 && z !== 0, `${label}: axis cell ${ck} lifted`); }
        }
        prev = base;
      }
      // eave ring is a bottom slab ring (flare 1)
      assert.equal(m.get(key(r + 1, 0, 0)), reg.canonical('spruce_slab[type=bottom]'), label);
    }
});

test('swept_hip lift: eave rims rise smoothly (≤ 1 block per cell) into corner tips lift blocks up, stairs facing the corner', () => {
  for (const lift of [1, 2, 3]) {
    const m = build({ box: { min: [-7, 0, -5], max: [7, 0, 5] }, style: 'swept_hip', stairs: 'oak_stairs', lift });
    const z = -7; // north rim (overhang 2)
    const mid = topY(m, 0, z);
    let prev = mid;
    for (let x = -1; x >= -9; x--) {
      const y = topY(m, x, z);
      assert.ok(y >= prev && y - prev <= 1, `lift ${lift}: rim not smooth at x=${x} (${prev} → ${y})`);
      prev = y;
      const st = parseBlockState(m.get(key(x, y, z))!);
      if (y > mid && x > -9 && st.name.endsWith('_stairs')) assert.equal(st.props.facing, 'west', `lift ${lift}: upturn stairs at x=${x} face the corner`);
    }
    assert.equal(prev - mid, lift, `lift ${lift}: tip height`);
    // 4-fold symmetric tips
    for (const [x, zz] of [[9, -7], [-9, 7], [9, 7]]) assert.equal(topY(m, x, zz), prev, `lift ${lift}: tip ${x},${zz}`);
  }
  // lift 0: flat eave rim
  const m0 = build({ box: { min: [-7, 0, -5], max: [7, 0, 5] }, style: 'swept_hip', stairs: 'oak_stairs', lift: 0 });
  assert.equal(topY(m0, -9, -7), topY(m0, 0, -7));
});

test('roof fill/ends: patterns, PatternSpecs and state functions', () => {
  const box = { min: [0, 5, 0] as [number, number, number], max: [8, 5, 6] as [number, number, number] };
  const m = build({ box: { min: [0, 5, 0], max: [8, 5, 14] }, style: 'gable', axis: 'x', stairs: 'spruce_stairs', ends: '50%white_terracotta,50%calcite', seed: 3 });
  const endIds = new Set([...m].filter(([k]) => xyz(k)[0] === 0 && xyz(k)[2] >= 0 && xyz(k)[2] <= 14).map(([, s]) => s));
  assert.ok(endIds.has('minecraft:white_terracotta') && endIds.has('minecraft:calcite'), [...endIds].join());
  // function: only even layers, null leaves holes
  const f = build({ box, style: 'gable', axis: 'x', stairs: 'spruce_stairs', fill: (_x, y) => (y % 2 === 0 ? 'stone' : null) });
  const fillYs = new Set([...f].filter(([, s]) => s === 'minecraft:stone').map(([k]) => xyz(k)[1]));
  assert.ok(fillYs.size > 0 && [...fillYs].every((y) => y % 2 === 0), [...fillYs].join());
  // gradient PatternSpec spans the roof height
  const g = build({ box: { min: [0, 5, 0], max: [8, 5, 14] }, style: 'gable', axis: 'x', stairs: 'spruce_stairs', fill: { type: 'gradient', axis: 'y', stops: ['stone', 'andesite'] } });
  const gv = new Set(g.values());
  assert.ok(gv.has('minecraft:stone') && gv.has('minecraft:andesite'));
  // DSL: PatternSpec ends pass through, same seed → same result
  const run = () => {
    const sink = new MapSink();
    executeOps([{ op: 'roof', box: [[0, 5, 0], [8, 5, 6]], style: 'gable', axis: 'x', stairs: 'spruce_stairs', ends: [{ block: 'white_terracotta', weight: 3 }, { block: 'calcite' }], seed: 7 }] as BuildOp[], { sink, reg, frame: Frame.identity(reg) });
    return [...sink.m].sort().join();
  };
  assert.equal(run(), run());
  assert.match(run(), /calcite/);
  // errors name the parameter
  assert.throws(() => build({ box, style: 'gable', stairs: 'spruce_stairs', ends: '50%nope_block,50%calcite' }), (e: unknown) => e instanceof RegistryError && /ends:/.test((e as Error).message));
  assert.throws(() => build({ box, style: 'gable', stairs: 'spruce_stairs', ends: true as never }), (e: unknown) => e instanceof RegistryError && /ends must be/.test((e as Error).message));
  assert.throws(() => build({ box, style: 'gable', stairs: 'spruce_stairs', fill: () => 'nope_block' }), (e: unknown) => e instanceof RegistryError && /fill:/.test((e as Error).message));
});

test('roofExtent / checkRoofFits / DSL "roof top at y=N"', () => {
  const p: RoofParams = { box: { min: [0, 10, 0], max: [8, 10, 6] }, style: 'hip', stairs: 'oak_stairs' };
  const m = build(p);
  const ys = [...m.keys()].map((k) => xyz(k)[1]), xs = [...m.keys()].map((k) => xyz(k)[0]);
  const ext = roofExtent(p, reg);
  assert.equal(ext.blocks, m.size);
  assert.equal(ext.topY, Math.max(...ys));
  assert.equal(ext.ridgeY, ext.topY);
  assert.deepEqual([ext.min[0], ext.max[0], ext.min[1]], [Math.min(...xs), Math.max(...xs), Math.min(...ys)]);
  assert.deepEqual(roof(p, reg, () => {}), ext);
  assert.equal(checkRoofFits(p, reg, { min: [-5, 0, -5], max: [20, ext.topY, 20] }), null);
  const msg = checkRoofFits(p, reg, { min: [-5, 0, -5], max: [20, ext.topY - 2, 20] });
  assert.match(msg!, new RegExp(`roof reaches y=${ext.topY} .*allowed box ends at y=${ext.topY - 2} — lower pitch`));
  assert.match(checkRoofFits(p, reg, { min: [0, 0, 0], max: [20, 99, 20] })!, /overhang reaches x=-1 .*starts at x=0 — reduce overhang/);
  // finial counts for topY but not for ridgeY
  const fe = roofExtent({ ...p, finial: true }, reg);
  assert.equal(fe.ridgeY, ext.ridgeY);
  assert.ok(fe.topY >= ext.topY + 2);
  // DSL reports world y (frame offset applied)
  const sink = new MapSink();
  const res = executeOps([{ op: 'roof', box: [[0, 10, 0], [8, 10, 6]], style: 'hip', stairs: 'oak_stairs', finial: true }] as BuildOp[], { sink, reg, frame: Frame.identity(reg) });
  assert.ok(res[0].warnings.includes(`roof top at y=${fe.topY} (ridge y=${fe.ridgeY})`), res[0].warnings.join('|'));
});

test('roofs are one 6-connected (face-connected) piece standing on the wall top', () => {
  const components = (m: Map<string, string>) => {
    const seen = new Set<string>();
    let n = 0;
    for (const k0 of m.keys()) {
      if (seen.has(k0)) continue;
      n++;
      const stack = [k0];
      seen.add(k0);
      while (stack.length) {
        const [x, y, z] = xyz(stack.pop()!);
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const q = key(x + dx, y + dy, z + dz);
          if (m.has(q) && !seen.has(q)) { seen.add(q); stack.push(q); }
        }
      }
    }
    return n;
  };
  const cases: RoofParams[] = [];
  for (const style of ['cone', 'spire', 'dome'] as const)
    for (const r of [2, 3, 4, 5, 7, 9])
      for (const pitch of [undefined, 0.5, 1, 2, 3])
        for (const overhang of [0, 1, 2]) cases.push({ box: { min: [-r, 4, -r], max: [r, 4, r] }, style, stairs: 'oak_stairs', pitch, overhang, round: true });
  for (const style of ['gable', 'hip', 'pyramid', 'shed', 'mansard', 'gambrel', 'swept_hip', 'flat', 'spire'] as const)
    for (const pitch of [undefined, 0.5, 1, 2]) for (const overhang of [0, 1]) cases.push({ box: { min: [0, 4, 0], max: [8, 4, 6] }, style, stairs: 'oak_stairs', pitch, overhang });
  for (const style of ['cone', 'dome', 'hip', 'swept_hip'] as const) cases.push({ box: { min: [-5, 4, -5], max: [5, 4, 5] }, style, stairs: 'oak_stairs', soffit: true, fascia: true, brackets: true, finial: true, lift: style === 'swept_hip' ? 3 : undefined });
  for (const p of cases) {
    const m = build(p);
    const label = JSON.stringify({ ...p, box: undefined, stairs: undefined, r: (p.box as { max: number[] }).max[0] });
    assert.equal(components(m), 1, `${label}: not one face-connected piece`);
    // rests on the wall top: something at the base layer inside the footprint (y = box.min.y)
    assert.ok([...m.keys()].some((k) => { const [x, y, z] = xyz(k); const b = p.box as { min: number[]; max: number[] }; return y === 4 && x >= b.min[0] && x <= b.max[0] && z >= b.min[2] && z <= b.max[2]; }), `${label}: touches the wall top`);
  }
});
