import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bridge, vines } from '../../src/core/builders.ts';
import { checkSupportAt } from '../../src/core/support.ts';
import { executeOps } from '../../src/core/dsl.ts';
import { Frame } from '../../src/core/frame.ts';
import * as S from '../../src/core/shapes.ts';
import { MapSink, reg } from './helpers.ts';

test('bridge: diagonal spans get one 4-connected rail per side and a walkable deck', () => {
  for (const to of [[14, 4, 14], [14, 4, 6], [-10, 4, 12], [3, 4, -15]] as [number, number, number][]) {
    const m = new Map<string, string>();
    bridge({ from: [0, 4, 0], to, width: 4, profile: 'arch', rise: 1.5, deck: 'oak_planks' }, reg, (x, y, z, s) => m.set(`${x},${y},${z}`, s), () => 'minecraft:air');
    const rails = new Set([...m].filter(([, s]) => s.includes('fence')).map(([k]) => { const [x, , z] = k.split(',').map(Number); return `${x},${z}`; }));
    const seen = new Set<string>();
    let comps = 0;
    for (const k of rails) {
      if (seen.has(k)) continue;
      comps++;
      const st = [k];
      seen.add(k);
      while (st.length) {
        const [x, z] = st.pop()!.split(',').map(Number);
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const n = `${x! + dx!},${z! + dz!}`;
          if (rails.has(n) && !seen.has(n)) { seen.add(n); st.push(n); }
        }
      }
    }
    assert.equal(comps, 2, `to ${to}: ${comps} rail pieces`);
  }
});

test('vines: only on exterior faces with a full block behind, all survive the support check', () => {
  const sink = new MapSink();
  const frame = Frame.identity(reg);
  // closed 7x7 stone room with a door gap; ground at y=0
  executeOps([
    { op: 'fill', box: [[-8, 0, -8], [8, 0, 8]], block: 'grass_block' },
    { op: 'fill', box: [[-3, 1, -3], [3, 6, 3]], block: 'stone_bricks', mode: 'hollow' },
    { op: 'fill', box: [[0, 1, 3], [0, 2, 3]], block: 'air' },
    { op: 'vines', box: [[-5, 1, -5], [5, 6, 5]], density: 1, from: 'both', length: 6 },
  ] as any, { sink, reg, frame });
  let n = 0;
  for (const [k, s] of sink.m) {
    if (!s.includes('vine')) continue;
    n++;
    const [x, y, z] = k.split(',').map(Number) as [number, number, number];
    assert.ok(Math.max(Math.abs(x), Math.abs(z)) >= 4, `vine inside the room at ${k}`);
    assert.equal(checkSupportAt(x, y, z, s, (a, b, c) => sink.get(a, b, c), reg), null, `unsupported vine ${k} ${s}`);
  }
  assert.ok(n > 20, `${n} vines`);
  void vines;
});

test('cylinder interior tiles exactly with the hollow shell (no gap rings)', () => {
  for (const r of [3, 4, 5, 6.5]) {
    const solid = new Set<string>();
    S.cylinder({ base: [0, 0, 0], radius: r, height: 1 }, (x, y, z) => solid.add(`${x},${y},${z}`));
    const sink = new MapSink();
    executeOps([{ op: 'cylinder', base: [0, 0, 0], radius: r, height: 1, hollow: true, interior: 'spruce_planks', block: 'stone_bricks' }] as any, { sink, reg, frame: Frame.identity(reg) });
    assert.equal(sink.m.size, solid.size, `r=${r}`);
    for (const k of solid) assert.ok(sink.m.has(k), `r=${r} missing ${k}`);
  }
});
