import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roof, roofMaterials, type RoofParams, type RoofStyle } from '../../src/core/shapes.ts';
import { solveConnections } from '../../src/core/connect.ts';
import { parseBlockState, AIR } from '../../src/core/blockstate.ts';
import type { Vec3 } from '../../src/core/types.ts';
import { key, reg } from './helpers.ts';

const STYLES: RoofStyle[] = ['gable', 'hip', 'pyramid', 'shed', 'dome', 'spire', 'mansard', 'gambrel', 'flat', 'cone', 'swept_hip'];

function build(p: RoofParams): Map<string, string> {
  const m = new Map<string, string>();
  roof(p, reg, (x, y, z, s) => {
    const k = key(x, y, z);
    assert.ok(!m.has(k), `duplicate at ${k}`);
    m.set(k, s);
  });
  return m;
}

/** top surface (half-blocks) and lowest solid half per column */
function columns(m: Map<string, string>) {
  const cols = new Map<string, { top: number; bottom: number }>();
  for (const [k, s] of m) {
    const [x, y, z] = k.split(',').map(Number);
    const p = parseBlockState(s);
    const slab = p.name.endsWith('_slab') && p.props.type === 'bottom';
    const top = 2 * y + (slab ? 1 : 2);
    const c = cols.get(`${x},${z}`);
    if (!c) cols.set(`${x},${z}`, { top, bottom: 2 * y });
    else {
      c.top = Math.max(c.top, top);
      c.bottom = Math.min(c.bottom, 2 * y);
    }
  }
  return cols;
}

test('roof invariants for every style, many sizes, overhangs and pitches', () => {
  let n = 0;
  for (const style of STYLES)
    for (let w = 1; w <= 11; w++)
      for (let d = 1; d <= 11; d += w % 3 === 0 ? 1 : 2)
        for (const overhang of [0, 1, 2])
          for (const pitch of style === 'flat' ? [undefined] : [undefined, 0.5, 1, 2]) {
            const p: RoofParams = { box: { min: [0, 10, 0], max: [w - 1, 10, d - 1] }, style, stairs: 'spruce_stairs', overhang, pitch };
            const label = `${style} ${w}x${d} o=${overhang} p=${pitch}`;
            const m = build(p);
            n++;
            assert.ok(m.size > 0, label);
            for (const s of m.values()) assert.equal(reg.canonical(s), s, label);
            // every footprint column is covered (no hole from above)
            const cols = columns(m);
            if (style !== 'dome' && style !== 'cone')
              for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) assert.ok(cols.has(`${x},${z}`), `${label}: hole at ${x},${z}`);
            // no see-through gaps between neighbouring columns
            for (const [ck, c] of cols) {
              const [x, z] = ck.split(',').map(Number);
              for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const nb = cols.get(`${x + dx},${z + dz}`);
                if (nb && nb.top < c.top) assert.ok(c.bottom <= nb.top, `${label}: gap between ${ck} and ${x + dx},${z + dz}`);
              }
            }
            // stairs shapes are exactly what vanilla's neighbour update computes (stable in the real game)
            const get = (x: number, y: number, z: number) => m.get(key(x, y, z)) ?? AIR;
            const pos: Vec3[] = [...m.keys()].map((k) => k.split(',').map(Number) as Vec3);
            const changes = solveConnections(get, pos, reg);
            assert.deepEqual(changes, [], `${label}: vanilla shape update would change ${changes.length} blocks`);
            // nothing below the eaves line: min y ≥ base − overhang·pitch − 1
            for (const k of m.keys()) assert.ok(Number(k.split(',')[1]) >= 10 - Math.ceil(overhang * (pitch ?? 1) * 3) - 1, label);
          }
  assert.ok(n > 1000);
});

test('gable: stairs face the ridge, slab cap on odd spans, eaves continue the slope', () => {
  const m = build({ box: { min: [0, 5, 0], max: [8, 5, 4] }, style: 'gable', stairs: 'oak_stairs' }); // axis x (longer), span z = 5
  const st = (x: number, y: number, z: number) => m.get(key(x, y, z));
  assert.equal(st(3, 4, -1), reg.canonical('oak_stairs[facing=south]')); // eave below wall top, outside
  assert.equal(st(3, 5, 0), reg.canonical('oak_stairs[facing=south]'));
  assert.equal(st(3, 6, 1), reg.canonical('oak_stairs[facing=south]'));
  assert.equal(st(3, 7, 2), reg.canonical('oak_slab[type=bottom]')); // 1-wide ridge
  assert.equal(st(3, 6, 3), reg.canonical('oak_stairs[facing=north]'));
  assert.equal(st(3, 4, 5), reg.canonical('oak_stairs[facing=north]'));
  assert.equal(st(-1, 5, 0), reg.canonical('oak_stairs[facing=south]')); // overhang along the ridge too
  // even span: two stairs back to back
  const e = build({ box: { min: [0, 0, 0], max: [5, 0, 3] }, style: 'gable', stairs: 'oak_stairs', overhang: 0 });
  assert.equal(e.get(key(2, 1, 1)), reg.canonical('oak_stairs[facing=south]'));
  assert.equal(e.get(key(2, 1, 2)), reg.canonical('oak_stairs[facing=north]'));
  assert.ok(![...e.values()].some((s) => s.includes('slab')));
});

test('hip and pyramid: outer corner stairs on the hips', () => {
  const m = build({ box: { min: [0, 0, 0], max: [6, 0, 6] }, style: 'hip', stairs: 'stone_brick_stairs', overhang: 0 });
  const corner = parseBlockState(m.get(key(0, 0, 0))!).props;
  assert.ok(corner.shape.startsWith('outer'), JSON.stringify(corner));
  const ring2 = parseBlockState(m.get(key(1, 1, 1))!).props;
  assert.ok(ring2.shape.startsWith('outer'));
  assert.equal(m.get(key(3, 3, 3)), reg.canonical('stone_brick_slab[type=bottom]')); // apex cap
  // even pyramid: four outer corners meet at the top
  const e = build({ box: { min: [0, 0, 0], max: [5, 0, 5] }, style: 'pyramid', stairs: 'stone_brick_stairs', overhang: 0 });
  for (const [x, z] of [[2, 2], [3, 2], [2, 3], [3, 3]]) assert.match(e.get(key(x, 2, z))!, /shape=outer_/);
});

test('ends, fill, explicit slab, shed facing, materials', () => {
  const plain = build({ box: { min: [0, 0, 0], max: [6, 0, 4] }, style: 'gable', stairs: 'oak_stairs', overhang: 0 });
  const ends = build({ box: { min: [0, 0, 0], max: [6, 0, 4] }, style: 'gable', stairs: 'oak_stairs', overhang: 0, ends: 'white_terracotta' });
  const endBlocks = [...ends].filter(([, s]) => s === 'minecraft:white_terracotta');
  assert.ok(endBlocks.length >= 2 && endBlocks.every(([k]) => k.startsWith('0,') || k.startsWith('6,')));
  assert.equal(ends.size, plain.size + endBlocks.length);
  const filled = build({ box: { min: [0, 0, 0], max: [6, 0, 4] }, style: 'hip', stairs: 'oak_stairs', overhang: 0, fill: 'oak_planks' });
  assert.ok([...filled.values()].includes('minecraft:oak_planks'));
  const slab = build({ box: { min: [0, 0, 0], max: [4, 0, 4] }, style: 'hip', stairs: 'oak_stairs', slab: 'spruce_slab', overhang: 0 });
  assert.ok([...slab.values()].includes(reg.canonical('spruce_slab[type=bottom]')));
  const shed = build({ box: { min: [0, 0, 0], max: [4, 0, 6] }, style: 'shed', axis: 'x', facing: 'south', stairs: 'oak_stairs', overhang: 0, pitch: 1 });
  assert.equal(shed.get(key(2, 0, 0)), reg.canonical('oak_stairs[facing=south]'));
  assert.equal(shed.get(key(2, 6, 6)), reg.canonical('oak_stairs[facing=south]'));
  assert.throws(() => build({ box: { min: [0, 0, 0], max: [4, 0, 6] }, style: 'shed', axis: 'x', facing: 'east', stairs: 'oak_stairs' }), /facing/);
  assert.throws(() => build({ box: { min: [0, 0, 0], max: [4, 0, 6] }, style: 'gable', stairs: 'oak_planks' }), /not a stairs block/);
  assert.throws(() => build({ box: { min: [0, 0, 0], max: [4, 0, 6] }, style: 'nope' as RoofStyle, stairs: 'oak_stairs' }), /unknown style/);
  const mats: [string, string, string | null][] = [
    ['oak_stairs', 'minecraft:oak_planks', 'minecraft:oak_slab'],
    ['stone_brick_stairs', 'minecraft:stone_bricks', 'minecraft:stone_brick_slab'],
    ['deepslate_tile_stairs', 'minecraft:deepslate_tiles', 'minecraft:deepslate_tile_slab'],
    ['brick_stairs', 'minecraft:bricks', 'minecraft:brick_slab'],
    ['quartz_stairs', 'minecraft:quartz_block', 'minecraft:quartz_slab'],
    ['purpur_stairs', 'minecraft:purpur_block', 'minecraft:purpur_slab'],
    ['cobblestone_stairs', 'minecraft:cobblestone', 'minecraft:cobblestone_slab'],
    ['mud_brick_stairs', 'minecraft:mud_bricks', 'minecraft:mud_brick_slab'],
    ['dark_prismarine_stairs', 'minecraft:dark_prismarine', 'minecraft:dark_prismarine_slab'],
    ['waxed_cut_copper_stairs', 'minecraft:waxed_cut_copper', 'minecraft:waxed_cut_copper_slab'],
    ['red_wool_stairs', 'minecraft:red_wool', 'minecraft:red_wool_slab'],
    ['bamboo_mosaic_stairs', 'minecraft:bamboo_mosaic', 'minecraft:bamboo_mosaic_slab'],
  ];
  for (const [s, full, sl] of mats) {
    const r = roofMaterials(reg, s);
    assert.equal(r.full, full, s);
    assert.equal(r.slab, sl, s);
  }
  // every stairs block in the registry resolves to some full block and slab
  for (const id of reg.tagMembers('stairs')) {
    const r = roofMaterials(reg, id);
    assert.ok(reg.isFullSolid(r.full), `${id} → ${r.full}`);
  }
});
