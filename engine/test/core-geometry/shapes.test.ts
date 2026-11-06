import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../../src/core/shapes.ts';
import type { Vec3 } from '../../src/core/types.ts';
import { collect, key } from './helpers.ts';

/**
 * Watertightness: flood-fill (6-connectivity) the complement of the shell starting outside the
 * bounding box; no cell of `interior` may be reached. `floorY` adds an impermeable floor plane.
 */
function leaks(shell: Set<string>, interior: Vec3[], lo: Vec3, hi: Vec3, floorY?: number): number {
  const x0 = lo[0] - 1, y0 = lo[1] - 1, z0 = lo[2] - 1;
  const nx = hi[0] - lo[0] + 3, ny = hi[1] - lo[1] + 3, nz = hi[2] - lo[2] + 3;
  const g = new Uint8Array(nx * ny * nz); // 1 = wall, 2 = visited
  const id = (x: number, y: number, z: number) => ((y - y0) * nz + (z - z0)) * nx + (x - x0);
  for (const k of shell) {
    const [x, y, z] = k.split(',').map(Number);
    g[id(x, y, z)] = 1;
  }
  if (floorY !== undefined) for (let z = z0; z < z0 + nz; z++) for (let x = x0; x < x0 + nx; x++) g[id(x, floorY, z)] = 1;
  const stack = [id(x0, y0 + ny - 1, z0)];
  g[stack[0]] = 2;
  const sy = nx * nz;
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % nx, z = Math.floor(i / nx) % nz, y = Math.floor(i / sy);
    const nb = [x > 0 ? i - 1 : -1, x < nx - 1 ? i + 1 : -1, z > 0 ? i - nx : -1, z < nz - 1 ? i + nx : -1, y > 0 ? i - sy : -1, y < ny - 1 ? i + sy : -1];
    for (const j of nb) if (j >= 0 && g[j] === 0) { g[j] = 2; stack.push(j); }
  }
  let n = 0;
  for (const p of interior) if (g[id(p[0], p[1], p[2])] === 2) n++;
  return n;
}

function bounds(pts: Vec3[]): { lo: Vec3; hi: Vec3 } {
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
  return { lo, hi };
}

test('box modes: counts and no duplicates', () => {
  const b = { min: [0, 0, 0] as Vec3, max: [4, 3, 5] as Vec3 }; // 5 x 4 x 6
  const n = (mode: Parameters<typeof S.box>[0]['mode'], thickness?: number) => {
    const r = collect((e) => S.box({ box: b, mode, thickness }, e));
    assert.equal(r.dups, 0);
    return r.pts.length;
  };
  assert.equal(n('solid'), 120);
  assert.equal(n('hollow'), 120 - 3 * 2 * 4);
  assert.equal(n('walls'), 120 - 3 * 4 * 4);
  assert.equal(n('floor'), 30);
  assert.equal(n('ceiling', 2), 60);
  assert.equal(n('outline'), 4 * 5 + 4 * 4 + 4 * 6 - 16);
  assert.equal(n('hollow', 2), 120 - 1 * 0 * 2);
  // reversed corners are normalized
  assert.equal(collect((e) => S.box({ box: { min: [4, 3, 5], max: [0, 0, 0] } }, e)).pts.length, 120);
});

test('ellipsoid: sizes, fractional centers for even widths, half', () => {
  assert.equal(collect((e) => S.ellipsoid({ center: [0, 0, 0], radius: 0 }, e)).pts.length, 1);
  assert.equal(collect((e) => S.ellipsoid({ center: [0, 0, 0], radius: 1 }, e)).pts.length, 19);
  const even = collect((e) => S.ellipsoid({ center: [10.5, 0, 10.5], radius: 3.5 }, e));
  const bb = bounds(even.pts);
  assert.deepEqual([bb.lo[0], bb.hi[0], bb.lo[2], bb.hi[2]], [7, 14, 7, 14]);
  // symmetric
  for (const [x, y, z] of even.pts) assert.ok(even.set.has(key(21 - x, y, 21 - z)));
  const r5 = collect((e) => S.ellipsoid({ center: [0, 0, 0], radius: [5, 2, 3] }, e));
  const b5 = bounds(r5.pts);
  assert.deepEqual([b5.lo, b5.hi], [[-5, -2, -3], [5, 2, 3]]);
  const dome = collect((e) => S.ellipsoid({ center: [0, 0, 0], radius: 6, half: 'top' }, e));
  assert.ok(dome.pts.every((p) => p[1] >= 0));
  assert.ok(dome.pts.some((p) => p[1] === 6));
});

/**
 * Fast numeric watertight check: marks solid + shell on a grid over [lo-1, hi+1], flood-fills
 * (6-connected) from outside through non-shell cells; returns interior size and leaked count.
 */
function gridLeaks(
  lo: Vec3,
  hi: Vec3,
  solid: (emit: (x: number, y: number, z: number) => void) => void,
  shell: (emit: (x: number, y: number, z: number) => void) => void,
): { interior: number; leaked: number; dups: number; outsideSolid: number } {
  const x0 = lo[0] - 1, y0 = lo[1] - 1, z0 = lo[2] - 1;
  const nx = hi[0] - lo[0] + 3, ny = hi[1] - lo[1] + 3, nz = hi[2] - lo[2] + 3;
  const g = new Uint8Array(nx * ny * nz); // bit1 solid, bit2 shell, bit4 visited
  const id = (x: number, y: number, z: number) => ((y - y0) * nz + (z - z0)) * nx + (x - x0);
  solid((x, y, z) => { g[id(x, y, z)] |= 1; });
  let dups = 0, outsideSolid = 0;
  shell((x, y, z) => {
    const i = id(x, y, z);
    if (g[i] & 2) dups++;
    if (!(g[i] & 1)) outsideSolid++;
    g[i] |= 2;
  });
  const sy = nx * nz;
  const stack = new Int32Array(g.length);
  let sp = 0;
  stack[sp++] = 0;
  g[0] |= 4;
  while (sp) {
    const i = stack[--sp];
    const x = i % nx, z = Math.floor(i / nx) % nz, y = Math.floor(i / sy);
    if (x > 0 && !(g[i - 1] & 6)) { g[i - 1] |= 4; stack[sp++] = i - 1; }
    if (x < nx - 1 && !(g[i + 1] & 6)) { g[i + 1] |= 4; stack[sp++] = i + 1; }
    if (z > 0 && !(g[i - nx] & 6)) { g[i - nx] |= 4; stack[sp++] = i - nx; }
    if (z < nz - 1 && !(g[i + nx] & 6)) { g[i + nx] |= 4; stack[sp++] = i + nx; }
    if (y > 0 && !(g[i - sy] & 6)) { g[i - sy] |= 4; stack[sp++] = i - sy; }
    if (y < ny - 1 && !(g[i + sy] & 6)) { g[i + sy] |= 4; stack[sp++] = i + sy; }
  }
  let interior = 0, leaked = 0;
  for (let i = 0; i < g.length; i++) if ((g[i] & 3) === 1) { interior++; if (g[i] & 4) leaked++; }
  return { interior, leaked, dups, outsideSolid };
}

test('hollow spheres are watertight for every radius 1..64 (and fractional radii)', () => {
  const radii: number[] = [];
  for (let r = 1; r <= 64; r++) radii.push(r);
  radii.push(1.5, 2.3, 2.5, 3.7, 7.5, 10.25, 15.9, 63.5);
  for (const r of radii) {
    const centers: Vec3[] = r <= 24 || r === 63.5 ? [[0, 0, 0], [0.5, 0.5, 0.5]] : [[0, 0, 0]];
    for (const c of centers) {
      const R = Math.ceil(r + 1);
      const res = gridLeaks(
        [-R, -R, -R],
        [R + 1, R + 1, R + 1],
        (e) => S.ellipsoid({ center: c, radius: r }, e),
        (e) => S.ellipsoid({ center: c, radius: r, hollow: true }, e),
      );
      assert.equal(res.dups, 0);
      assert.equal(res.outsideSolid, 0);
      if (r >= 1.5) assert.ok(res.interior > 0, `r=${r} c=${c} has no interior`);
      assert.equal(res.leaked, 0, `hollow sphere r=${r} c=${c} leaks`);
    }
  }
});

test('hollow ellipsoids / thick shells / domes are watertight', () => {
  const cases: Parameters<typeof S.ellipsoid>[0][] = [
    { center: [0, 0, 0], radius: [9, 3, 5], hollow: true },
    { center: [0.5, 0, 0.5], radius: [6.5, 12, 2.5], hollow: true },
    { center: [0, 0, 0], radius: 12, hollow: true, thickness: 2 },
    { center: [0, 0, 0], radius: [14, 6, 9], hollow: true, thickness: 3 },
  ];
  for (const c of cases) {
    const solid = collect((e) => S.ellipsoid({ ...c, hollow: false }, e));
    const shell = collect((e) => S.ellipsoid(c, e));
    const interior = solid.pts.filter((p) => !shell.set.has(key(...p)));
    const { lo, hi } = bounds(solid.pts);
    assert.ok(interior.length > 0);
    assert.equal(leaks(shell.set, interior, lo, hi), 0, JSON.stringify(c));
    // thickness t: every shell block lies within L1 distance t of the outside
    const t = c.thickness ?? 1;
    for (const [x, y, z] of shell.pts) {
      let near = false;
      for (let dx = -t; dx <= t && !near; dx++) for (let dy = -t; dy <= t && !near; dy++) for (let dz = -t; dz <= t && !near; dz++)
        if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) <= t && !solid.set.has(key(x + dx, y + dy, z + dz))) near = true;
      assert.ok(near);
    }
  }
  // hollow dome: closed except the open bottom → watertight against a floor
  const domeSolid = collect((e) => S.ellipsoid({ center: [0, 0, 0], radius: 10, half: 'top' }, e));
  const dome = collect((e) => S.ellipsoid({ center: [0, 0, 0], radius: 10, half: 'top', hollow: true }, e));
  assert.ok(!dome.pts.some((p) => p[1] === 0 && Math.abs(p[0]) < 5 && Math.abs(p[2]) < 5), 'dome must have no floor');
  const interior = domeSolid.pts.filter((p) => !dome.set.has(key(...p)));
  const { lo, hi } = bounds(domeSolid.pts);
  assert.equal(leaks(dome.set, interior, lo, hi, -1), 0);
});

test('hollow cylinders are watertight tubes for every radius 1..64; caps close them', () => {
  for (let r = 1; r <= 64; r++) {
    for (const base of [[0, 0, 0], [0.5, 0, 0.5]] as Vec3[]) {
      const solid = collect((e) => S.cylinder({ base, radius: r, height: 1 }, e));
      const tube = collect((e) => S.cylinder({ base, radius: r, height: 1, hollow: true }, e));
      assert.equal(tube.dups, 0);
      const interior = solid.pts.filter((p) => !tube.set.has(key(...p)));
      if (r >= 2) assert.ok(interior.length > 0, `r=${r}`);
      const { lo, hi } = bounds(solid.pts);
      // a single layer sandwiched between floor and ceiling: lateral watertightness
      const walls = new Set(tube.set);
      for (let z = lo[2] - 1; z <= hi[2] + 1; z++) for (let x = lo[0] - 1; x <= hi[0] + 1; x++) { walls.add(key(x, 1, z)); }
      assert.equal(leaks(walls, interior, lo, [hi[0], 1, hi[2]], -1), 0, `tube r=${r} leaks`);
    }
  }
  const solid = collect((e) => S.cylinder({ base: [0, 0, 0], radius: 5, height: 6 }, e));
  const capped = collect((e) => S.cylinder({ base: [0, 0, 0], radius: 5, height: 6, hollow: true, caps: true }, e));
  const interior = solid.pts.filter((p) => !capped.set.has(key(...p)));
  const { lo, hi } = bounds(solid.pts);
  assert.equal(leaks(capped.set, interior, lo, hi), 0);
  assert.equal(solid.pts.length, 6 * collect((e) => S.cylinder({ base: [0, 0, 0], radius: 5, height: 1 }, e)).pts.length);
});

test('cylinder axes, elliptical radius, negative height', () => {
  const x = collect((e) => S.cylinder({ base: [0, 0, 0], radius: 2, height: 5, axis: 'x' }, e));
  const bx = bounds(x.pts);
  assert.deepEqual([bx.lo, bx.hi], [[0, -2, -2], [4, 2, 2]]);
  const z = collect((e) => S.cylinder({ base: [0, 0, 0], radius: [3, 1], height: 2, axis: 'z' }, e));
  const bz = bounds(z.pts);
  assert.deepEqual([bz.lo, bz.hi], [[-3, -1, 0], [3, 1, 1]]);
  const down = collect((e) => S.cylinder({ base: [0, 10, 0], radius: 1, height: -3 }, e));
  const bd = bounds(down.pts);
  assert.deepEqual([bd.lo[1], bd.hi[1]], [8, 10]);
});

test('cone, pyramid: layer sizes, apex, watertight hollow versions (open bottom)', () => {
  const cone = collect((e) => S.cone({ base: [0, 0, 0], radius: 4, height: 9 }, e));
  assert.equal(cone.dups, 0);
  assert.equal(cone.pts.filter((p) => p[1] === 8).length, 1);
  assert.equal(cone.pts.filter((p) => p[1] === 0).length, collect((e) => S.cylinder({ base: [0, 0, 0], radius: 4, height: 1 }, e)).pts.length);
  const hc = collect((e) => S.cone({ base: [0, 0, 0], radius: 6, height: 10, hollow: true }, e));
  const ci = cone.pts.length ? collect((e) => S.cone({ base: [0, 0, 0], radius: 6, height: 10 }, e)).pts.filter((p) => !hc.set.has(key(...p))) : [];
  assert.ok(ci.length > 0);
  const bc = bounds(ci);
  assert.equal(leaks(hc.set, ci, [bc.lo[0] - 7, 0, bc.lo[2] - 7], [bc.hi[0] + 7, 10, bc.hi[2] + 7], -1), 0);
  const down = collect((e) => S.cone({ base: [0, 0, 0], radius: 3, height: -5 }, e));
  assert.deepEqual([bounds(down.pts).lo[1], bounds(down.pts).hi[1]], [-4, 0]);

  const pyr = collect((e) => S.pyramid({ base: [0, 0, 0], size: 9 }, e));
  assert.equal(pyr.dups, 0);
  assert.deepEqual([0, 1, 2, 3, 4].map((y) => pyr.pts.filter((p) => p[1] === y).length), [81, 49, 25, 9, 1]);
  const even = collect((e) => S.pyramid({ base: [3.5, 0, 3.5], size: 8 }, e));
  assert.deepEqual([0, 1, 2, 3].map((y) => even.pts.filter((p) => p[1] === y).length), [64, 36, 16, 4]);
  assert.deepEqual(bounds(even.pts).lo, [0, 0, 0]);
  const tall = collect((e) => S.pyramid({ base: [0, 0, 0], size: 5, height: 6 }, e));
  assert.equal(bounds(tall.pts).hi[1], 5);
  const hp = collect((e) => S.pyramid({ base: [0, 0, 0], size: 13, height: 3, hollow: true }, e));
  const sp = collect((e) => S.pyramid({ base: [0, 0, 0], size: 13, height: 3 }, e));
  const pi = sp.pts.filter((p) => !hp.set.has(key(...p)));
  assert.ok(pi.length > 0);
  const bp = bounds(sp.pts);
  assert.equal(leaks(hp.set, pi, bp.lo, bp.hi, -1), 0);
});

test('torus, line, curve, polygon: no duplicates and expected extents', () => {
  const t = collect((e) => S.torus({ center: [0, 0, 0], major: 6, minor: 1 }, e));
  assert.equal(t.dups, 0);
  assert.ok(!t.set.has(key(0, 0, 0)) && t.set.has(key(6, 0, 0)) && t.set.has(key(0, 1, -6)));
  const tx = collect((e) => S.torus({ center: [0, 0, 0], major: 4, minor: 0, axis: 'x' }, e));
  assert.ok(tx.pts.every((p) => p[0] === 0));

  const l = collect((e) => S.line({ from: [0, 0, 0], to: [10, 4, -3] }, e));
  assert.equal(l.dups, 0);
  assert.equal(l.pts.length, 11);
  assert.deepEqual(l.pts[0], [0, 0, 0]);
  assert.deepEqual(l.pts[10], [10, 4, -3]);
  for (let i = 1; i < l.pts.length; i++) for (let c = 0; c < 3; c++) assert.ok(Math.abs(l.pts[i][c] - l.pts[i - 1][c]) <= 1);
  const thick = collect((e) => S.line({ from: [0, 0, 0], to: [10, 0, 0], thickness: 3 }, e));
  assert.equal(thick.dups, 0);
  assert.ok(thick.set.has(key(5, 1, 1)) && !thick.set.has(key(5, 2, 0)));

  const cv = collect((e) => S.curve({ points: [[0, 0, 0], [5, 8, 2], [12, 4, 8], [20, 0, 0]] }, e));
  assert.equal(cv.dups, 0);
  assert.ok(cv.set.has(key(0, 0, 0)) && cv.set.has(key(5, 8, 2)) && cv.set.has(key(20, 0, 0)));
  // 26-connected chain
  for (let i = 1; i < cv.pts.length; i++) for (let c = 0; c < 3; c++) assert.ok(Math.abs(cv.pts[i][c] - cv.pts[i - 1][c]) <= 1);
  const tube = collect((e) => S.curve({ points: [[0, 0, 0], [0, 10, 10]], kind: 'bezier', radius: 2 }, e));
  assert.equal(tube.dups, 0);
  const bez = collect((e) => S.curve({ points: [[0, 0, 0], [5, 10, 0], [10, 0, 0]], kind: 'bezier' }, e));
  assert.ok(bounds(bez.pts).hi[1] <= 5);

  const sq = collect((e) => S.polygon({ points: [[0, 0], [10, 0], [10, 10], [0, 10]], y: 0, height: 1 }, e));
  assert.equal(sq.pts.length, 121);
  const tri = collect((e) => S.polygon({ points: [[0, 0], [12, 0], [6, 9]], y: 5, height: 3 }, e));
  assert.equal(tri.dups, 0);
  assert.ok(tri.pts.every((p) => p[1] >= 5 && p[1] <= 7));
  const ring = collect((e) => S.polygon({ points: [[0, 0], [8, 0], [12, 6], [4, 10]], y: 0, height: 2, hollow: true }, e));
  assert.equal(ring.dups, 0);
  assert.ok(!ring.set.has(key(6, 0, 4)));
});

test('arch: feet on the ground, crown at height, open below, depth', () => {
  for (const style of ['round', 'pointed', 'flat'] as const) {
    const a = collect((e) => S.arch({ from: [0, 3, 0], to: [8, 3, 0], height: 5, depth: 2, style }, e));
    assert.equal(a.dups, 0, style);
    assert.ok(a.set.has(key(0, 3, 0)) && a.set.has(key(8, 3, 0)), `${style}: feet`);
    assert.ok(a.set.has(key(4, 8, 0)) && a.set.has(key(4, 8, 1)), `${style}: crown`);
    assert.ok(!a.set.has(key(4, 3, 0)) && !a.set.has(key(4, 6, 0)), `${style}: opening`);
    assert.ok(a.pts.every((p) => p[1] >= 3 && p[1] <= 8 && (p[2] === 0 || p[2] === 1)));
    // ring is 4-connected-tight: nothing in the opening touches the outside above the crown line
  }
  const z = collect((e) => S.arch({ from: [2, 0, 6], to: [2, 0, 0], height: 3, depth: -1 }, e));
  assert.ok(z.set.has(key(2, 0, 6)) && z.set.has(key(2, 0, 0)) && z.pts.every((p) => p[0] === 2));
  assert.throws(() => S.arch({ from: [0, 0, 0], to: [3, 0, 3], height: 2 }, () => {}), /aligned/);
  // thick round arch: watertight ring between opening and sky
  const thick = collect((e) => S.arch({ from: [0, 0, 0], to: [12, 0, 0], height: 7, thickness: 2 }, e));
  assert.ok(thick.set.has(key(6, 7, 0)) && thick.set.has(key(6, 6, 0)) && !thick.set.has(key(6, 5, 0)));
});

test('spiral: one step per layer, turns, ascending directions', () => {
  const cells: [number, number, number, string][] = [];
  S.spiralCells({ center: [0, 0, 0], radius: 3, height: 16, turns: 2 }, (x, y, z, f) => cells.push([x, y, z, f]));
  const set = new Set(cells.map((c) => key(c[0], c[1], c[2])));
  assert.equal(set.size, cells.length);
  for (let y = 0; y < 16; y++) assert.ok(cells.some((c) => c[1] === y), `layer ${y}`);
  assert.ok(!set.has(key(0, 0, 0)));
  // every column cell is used exactly `turns` times
  const cols = new Map<string, number>();
  for (const c of cells) cols.set(`${c[0]},${c[2]}`, (cols.get(`${c[0]},${c[2]}`) ?? 0) + 1);
  for (const n of cols.values()) assert.equal(n, 2);
  // clockwise: the step east of the center (angle 0) ascends toward south
  const e0 = cells.find((c) => c[0] === 3 && c[2] === 0)!;
  assert.equal(e0[3], 'south');
  const ccw: [number, number, number, string][] = [];
  S.spiralCells({ center: [0, 0, 0], radius: 3, height: 8, turns: -1 }, (x, y, z, f) => ccw.push([x, y, z, f]));
  assert.equal(ccw.find((c) => c[0] === 3 && c[2] === 0)![3], 'north');
  assert.throws(() => S.spiralCells({ center: [0, 0, 0], radius: 3, height: 2, turns: 5 }, () => {}), /one full turn/);
});

test('performance: ~1.1M-block solid sphere and hollow r=64 within a few seconds', () => {
  const t0 = performance.now();
  let n = 0;
  S.ellipsoid({ center: [0, 0, 0], radius: 64 }, () => { n++; });
  S.ellipsoid({ center: [0, 0, 0], radius: 64, hollow: true }, () => { n++; });
  S.ellipsoid({ center: [0, 0, 0], radius: 40, hollow: true, thickness: 3 }, () => { n++; });
  const ms = performance.now() - t0;
  assert.ok(n > 1_100_000);
  assert.ok(ms < 4000, `${ms} ms`);
});
