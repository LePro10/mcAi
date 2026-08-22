/**
 * Voxel shape generators.
 *
 * Every op in the Blueprint DSL lands here. Shapes write through a `Painter`
 * rather than into a buffer directly, so the compiler can apply transforms,
 * material resolution and write modes without each shape knowing about them.
 *
 * A note on stair orientation, because it is the detail that separates a roof
 * that looks built from a roof that looks generated: in vanilla, a stair's
 * `facing` names the side holding the full-height half. For a slope, that means
 * stairs face *uphill*. Placing them the other way produces a jagged surface
 * with a half-block gap at every step — which is exactly what the old system
 * did by leaving `facing` unset on every roof block.
 */

import type {
  ArchPart, BattlementsPart, BoxPart, ClearPart, ConePart, CylinderPart,
  DoorPart, FoundationPart, FramePart, LinePart, Material, PyramidPart,
  RoofPart, ScatterPart, SetPart, ShellPart, SpherePart, SpiralPart,
  TerrainSample, Vec3, WallsPart, WindowsPart,
} from './types.js';
import { line3, type Cardinal } from './geometry.js';
import { noise01 } from './rng.js';
import { isAir, stairVariant, withStates } from './blocks.js';

/** Writes one voxel. `ref` is a material reference resolved by the compiler. */
export type Painter = (x: number, y: number, z: number, ref: Material, keep?: boolean) => void;

export interface ShapeCtx {
  paint: Painter;
  seed: number;
  warn(msg: string): void;
  /** Resolve a material reference to a concrete block id (for stair lookups). */
  concrete(ref: Material, x: number, y: number, z: number): string;
  /**
   * Ground height at a blueprint-local column, in blueprint-local Y, or null
   * when no terrain sample covers it. The compiler handles the transform.
   */
  heightAt(x: number, z: number): number | null;
}

const DEF: Material = '@wall';

function sizeOf(s: Vec3 | undefined, def: Vec3 = [1, 1, 1]): Vec3 {
  if (!s) return def;
  return [
    Math.max(1, Math.round(Number(s[0]) || 1)),
    Math.max(1, Math.round(Number(s[1]) || 1)),
    Math.max(1, Math.round(Number(s[2]) || 1)),
  ];
}

function atOf(a: Vec3 | undefined): Vec3 {
  if (!a) return [0, 0, 0];
  return [Math.round(Number(a[0]) || 0), Math.round(Number(a[1]) || 0), Math.round(Number(a[2]) || 0)];
}

// ── Primitives ────────────────────────────────────────────────────────────

export function box(ctx: ShapeCtx, p: BoxPart): void {
  const [ax, ay, az] = atOf(p.at);
  const [w, h, d] = sizeOf(p.size);
  const block = p.block ?? DEF;
  const keep = p.mode === 'keep';
  for (let y = 0; y < h; y++)
    for (let z = 0; z < d; z++)
      for (let x = 0; x < w; x++) ctx.paint(ax + x, ay + y, az + z, block, keep);
}

export function clear(ctx: ShapeCtx, p: ClearPart): void {
  box(ctx, { op: 'box', at: p.at, size: p.size, block: 'air', tag: p.tag });
}

export function shell(ctx: ShapeCtx, p: ShellPart): void {
  const [ax, ay, az] = atOf(p.at);
  const [w, h, d] = sizeOf(p.size);
  const t = Math.max(1, Math.min(Math.round(p.thickness ?? 1), Math.floor(Math.min(w, d) / 2) || 1));
  const open = new Set(p.open ?? []);
  const block = p.block ?? DEF;
  const keep = p.mode === 'keep';

  for (let y = 0; y < h; y++) {
    for (let z = 0; z < d; z++) {
      for (let x = 0; x < w; x++) {
        const onWest = x < t, onEast = x >= w - t;
        const onNorth = z < t, onSouth = z >= d - t;
        const onBottom = y < t, onTop = y >= h - t;
        if (!(onWest || onEast || onNorth || onSouth || onBottom || onTop)) continue;

        // A voxel survives when at least one boundary it belongs to is closed.
        const memberships: Array<[boolean, boolean]> = [
          [onWest, open.has('west')], [onEast, open.has('east')],
          [onNorth, open.has('north')], [onSouth, open.has('south')],
          [onTop, open.has('top')], [onBottom, open.has('bottom')],
        ];
        if (memberships.every(([member, isOpen]) => !member || isOpen)) continue;

        ctx.paint(ax + x, ay + y, az + z, block, keep);
      }
    }
  }
}

export function walls(ctx: ShapeCtx, p: WallsPart): void {
  shell(ctx, {
    op: 'shell', at: p.at, size: p.size, thickness: p.thickness,
    open: ['top', 'bottom'], block: p.block, mode: p.mode, tag: p.tag,
  });
}

export function frame(ctx: ShapeCtx, p: FramePart): void {
  const [ax, ay, az] = atOf(p.at);
  const [w, h, d] = sizeOf(p.size);
  const t = Math.max(1, Math.round(p.thickness ?? 1));
  const block = p.block ?? DEF;
  const keep = p.mode === 'keep';
  for (let y = 0; y < h; y++)
    for (let z = 0; z < d; z++)
      for (let x = 0; x < w; x++) {
        const ex = x < t || x >= w - t ? 1 : 0;
        const ey = y < t || y >= h - t ? 1 : 0;
        const ez = z < t || z >= d - t ? 1 : 0;
        if (ex + ey + ez >= 2) ctx.paint(ax + x, ay + y, az + z, block, keep);
      }
}

export function cylinder(ctx: ShapeCtx, p: CylinderPart): void {
  const [ax, ay, az] = atOf(p.at);
  const r = Math.max(0.5, Number(p.r) || 1);
  const r2 = Math.max(0.5, Number(p.r2 ?? p.r) || r);
  const h = Math.max(1, Math.round(Number(p.h) || 1));
  const axis = p.axis ?? 'y';
  const block = p.block ?? DEF;
  const keep = p.mode === 'keep';
  const t = Math.max(1, Math.round(p.thickness ?? 1));

  const ra = r + 0.5, rb = r2 + 0.5;
  const ia = ra - t, ib = rb - t;
  const dA = Math.round(r * 2) + 1;
  const dB = Math.round(r2 * 2) + 1;

  for (let i = 0; i < h; i++) {
    for (let a = 0; a < dA; a++) {
      for (let b = 0; b < dB; b++) {
        const da = a - r, db = b - r2;
        const out = (da * da) / (ra * ra) + (db * db) / (rb * rb);
        if (out > 1) continue;
        if (p.hollow && ia > 0 && ib > 0) {
          const inn = (da * da) / (ia * ia) + (db * db) / (ib * ib);
          if (inn <= 1) continue;
        }
        if (axis === 'y') ctx.paint(ax + a, ay + i, az + b, block, keep);
        else if (axis === 'x') ctx.paint(ax + i, ay + a, az + b, block, keep);
        else ctx.paint(ax + a, ay + b, az + i, block, keep);
      }
    }
  }
}

export function sphere(ctx: ShapeCtx, p: SpherePart): void {
  const [ax, ay, az] = atOf(p.at);
  const rr: Vec3 = Array.isArray(p.r)
    ? [Number(p.r[0]) || 1, Number(p.r[1]) || 1, Number(p.r[2]) || 1]
    : [Number(p.r) || 1, Number(p.r) || 1, Number(p.r) || 1];
  const block = p.block ?? DEF;
  const keep = p.mode === 'keep';
  const t = Math.max(1, Math.round(p.thickness ?? 1));
  const R: Vec3 = [rr[0] + 0.5, rr[1] + 0.5, rr[2] + 0.5];
  const I: Vec3 = [R[0] - t, R[1] - t, R[2] - t];
  const dims: Vec3 = [Math.round(rr[0] * 2) + 1, Math.round(rr[1] * 2) + 1, Math.round(rr[2] * 2) + 1];

  for (let y = 0; y < dims[1]; y++) {
    const dy = y - rr[1];
    if (p.half === 'dome' && dy < 0) continue;
    if (p.half === 'bowl' && dy > 0) continue;
    for (let z = 0; z < dims[2]; z++) {
      for (let x = 0; x < dims[0]; x++) {
        const dx = x - rr[0], dz = z - rr[2];
        const out = (dx * dx) / (R[0] * R[0]) + (dy * dy) / (R[1] * R[1]) + (dz * dz) / (R[2] * R[2]);
        if (out > 1) continue;
        if (p.hollow && I[0] > 0 && I[1] > 0 && I[2] > 0) {
          const inn = (dx * dx) / (I[0] * I[0]) + (dy * dy) / (I[1] * I[1]) + (dz * dz) / (I[2] * I[2]);
          if (inn <= 1) continue;
        }
        const oy = p.half === 'dome' ? y - Math.round(rr[1]) : y;
        ctx.paint(ax + x, ay + oy, az + z, block, keep);
      }
    }
  }
}

export function cone(ctx: ShapeCtx, p: ConePart): void {
  const [ax, ay, az] = atOf(p.at);
  const r = Math.max(0.5, Number(p.r) || 1);
  const h = Math.max(1, Math.round(Number(p.h) || 1));
  const block = p.block ?? DEF;
  const keep = p.mode === 'keep';
  const t = Math.max(1, Math.round(p.thickness ?? 1));
  const d = Math.round(r * 2) + 1;

  for (let y = 0; y < h; y++) {
    const frac = 1 - y / h;
    const ry = r * frac + 0.5;
    const iy = ry - t;
    for (let z = 0; z < d; z++) {
      for (let x = 0; x < d; x++) {
        const dx = x - r, dz = z - r;
        const dist2 = dx * dx + dz * dz;
        if (dist2 > ry * ry) continue;
        if (p.hollow && iy > 0 && dist2 <= iy * iy && y < h - 1) continue;
        ctx.paint(ax + x, ay + y, az + z, block, keep);
      }
    }
  }
}

export function pyramid(ctx: ShapeCtx, p: PyramidPart): void {
  const [ax, ay, az] = atOf(p.at);
  const [w, h, d] = sizeOf(p.size);
  const block = p.block ?? DEF;
  const keep = p.mode === 'keep';
  const step = Math.max(1, Math.round(p.step ?? 1));

  for (let y = 0; y < h; y++) {
    const inset = Math.floor(y / step);
    const x1 = inset, x2 = w - 1 - inset;
    const z1 = inset, z2 = d - 1 - inset;
    if (x1 > x2 || z1 > z2) break;
    for (let z = z1; z <= z2; z++)
      for (let x = x1; x <= x2; x++) {
        if (p.hollow && x > x1 && x < x2 && z > z1 && z < z2 && y < h - 1) continue;
        ctx.paint(ax + x, ay + y, az + z, block, keep);
      }
  }
}

export function line(ctx: ShapeCtx, p: LinePart): void {
  const block = p.block ?? DEF;
  const keep = p.mode === 'keep';
  const t = Math.max(1, Math.round(p.thickness ?? 1)) - 1;
  for (const [x, y, z] of line3(atOf(p.from), atOf(p.to))) {
    if (t === 0) { ctx.paint(x, y, z, block, keep); continue; }
    for (let dy = -t; dy <= t; dy++)
      for (let dz = -t; dz <= t; dz++)
        for (let dx = -t; dx <= t; dx++) ctx.paint(x + dx, y + dy, z + dz, block, keep);
  }
}

export function setOne(ctx: ShapeCtx, p: SetPart): void {
  const [x, y, z] = atOf(p.at);
  ctx.paint(x, y, z, p.block ?? DEF, p.mode === 'keep');
}

// ── Roofs ─────────────────────────────────────────────────────────────────

/** Stair spec facing `dir`, i.e. with its full-height half on the `dir` side. */
function stairAt(ctx: ShapeCtx, ref: Material, x: number, y: number, z: number, dir: Cardinal): string {
  const concrete = ctx.concrete(ref, x, y, z);
  const stair = concrete.includes('_stairs') ? concrete : stairVariant(concrete);
  if (!stair) return concrete;
  return withStates(stair, { facing: dir, half: 'bottom' });
}

export function roof(ctx: ShapeCtx, p: RoofPart): void {
  const [ax, ay, az] = atOf(p.at);
  const [w, , d] = sizeOf(p.size);
  const kind = p.kind ?? 'gable';
  const pitch = Math.max(0.25, Number(p.pitch ?? 1));
  const over = Math.max(0, Math.round(p.overhang ?? 0));
  const solid = p.block ?? '@roof';
  const stairs = p.stairs ?? p.block ?? '@roof_stairs';
  const keep = p.mode === 'keep';

  if (kind === 'flat') {
    const h = Math.max(1, sizeOf(p.size)[1]);
    for (let y = 0; y < h; y++)
      for (let z = -over; z < d + over; z++)
        for (let x = -over; x < w + over; x++) ctx.paint(ax + x, ay + y, az + z, solid, keep);
    return;
  }

  if (kind === 'dome') {
    const r = Math.floor(Math.max(w, d) / 2);
    sphere(ctx, {
      op: 'sphere', at: [ax + Math.floor(w / 2) - r, ay, az + Math.floor(d / 2) - r],
      r: [r, Math.round(r * pitch), r], hollow: true, thickness: 1, half: 'dome',
      block: solid, mode: p.mode,
    });
    return;
  }

  if (kind === 'cone') {
    const r = Math.floor(Math.max(w, d) / 2);
    cone(ctx, {
      op: 'cone', at: [ax + Math.floor(w / 2) - r, ay, az + Math.floor(d / 2) - r],
      r, h: Math.max(2, Math.round(r * 2 * pitch)), hollow: true, thickness: 1,
      block: solid, mode: p.mode,
    });
    return;
  }

  if (kind === 'pagoda') {
    // Stacked hip tiers, each smaller and lifted, with a pronounced overhang.
    const tiers = Math.max(2, Math.min(4, Math.round(Math.max(w, d) / 6)));
    let ty = ay;
    for (let t = 0; t < tiers; t++) {
      const inset = t * 2;
      const tw = w - inset * 2, td = d - inset * 2;
      if (tw < 3 || td < 3) break;
      roof(ctx, {
        op: 'roof', at: [ax + inset, ty, az + inset], size: [tw, 1, td],
        kind: 'hip', pitch: 0.5, overhang: t === 0 ? Math.max(1, over) : 1,
        block: solid, stairs, ridge: p.ridge, mode: p.mode,
      });
      ty += Math.max(2, Math.round(Math.min(tw, td) / 2 * 0.5)) + 1;
    }
    return;
  }

  if (kind === 'pyramid') {
    pyramid(ctx, {
      op: 'pyramid', at: [ax - over, ay, az - over],
      size: [w + over * 2, Math.ceil(Math.min(w, d) / 2 * pitch) + 1, d + over * 2],
      block: solid, mode: p.mode,
    });
    return;
  }

  if (kind === 'hip') {
    const x1 = -over, x2 = w - 1 + over;
    const z1 = -over, z2 = d - 1 + over;
    let i = 0;
    for (;;) {
      const lx = x1 + i, hx = x2 - i;
      const lz = z1 + i, hz = z2 - i;
      if (lx > hx || lz > hz) break;
      const y = Math.round(i * pitch);
      for (let x = lx; x <= hx; x++) {
        ctx.paint(ax + x, ay + y, az + lz, stairAt(ctx, stairs, ax + x, ay + y, az + lz, 'south'), keep);
        ctx.paint(ax + x, ay + y, az + hz, stairAt(ctx, stairs, ax + x, ay + y, az + hz, 'north'), keep);
      }
      for (let z = lz; z <= hz; z++) {
        ctx.paint(ax + lx, ay + y, az + z, stairAt(ctx, stairs, ax + lx, ay + y, az + z, 'east'), keep);
        ctx.paint(ax + hx, ay + y, az + z, stairAt(ctx, stairs, ax + hx, ay + y, az + z, 'west'), keep);
      }
      // Corners get solid blocks: vanilla corner stair shapes would need
      // per-neighbour `shape` states and read worse than a clean block.
      for (const [cx, cz] of [[lx, lz], [hx, lz], [lx, hz], [hx, hz]] as Array<[number, number]>)
        ctx.paint(ax + cx, ay + y, az + cz, solid, keep);
      // Close the tier below so no daylight leaks through the slope.
      if (i > 0) {
        const yb = Math.round((i - 1) * pitch);
        for (let yy = yb + 1; yy < y; yy++) {
          for (let x = lx; x <= hx; x++) {
            ctx.paint(ax + x, ay + yy, az + lz, solid, keep);
            ctx.paint(ax + x, ay + yy, az + hz, solid, keep);
          }
          for (let z = lz; z <= hz; z++) {
            ctx.paint(ax + lx, ay + yy, az + z, solid, keep);
            ctx.paint(ax + hx, ay + yy, az + z, solid, keep);
          }
        }
      }
      if (hx - lx <= 1 || hz - lz <= 1) {
        const capY = Math.round((i + 1) * pitch);
        for (let z = lz; z <= hz; z++)
          for (let x = lx; x <= hx; x++) ctx.paint(ax + x, ay + capY, az + z, p.ridge ?? solid, keep);
        break;
      }
      i++;
    }
    return;
  }

  // ── gable ──
  const axis = p.axis ?? (d >= w ? 'z' : 'x');
  const across = axis === 'z' ? w : d;         // span perpendicular to the ridge
  const along = axis === 'z' ? d : w;          // ridge length
  const lo = -over, hi = across - 1 + over;
  const alongLo = -over, alongHi = along - 1 + over;

  const put = (a: number, l: number, y: number, spec: Material, keepIt = keep) => {
    if (axis === 'z') ctx.paint(ax + a, ay + y, az + l, spec, keepIt);
    else ctx.paint(ax + l, ay + y, az + a, spec, keepIt);
  };

  let i = 0;
  let ridgeY = 0;
  for (;;) {
    const a1 = lo + i, a2 = hi - i;
    if (a1 > a2) break;
    const y = Math.round(i * pitch);
    ridgeY = y;
    // Slopes rise toward the ridge, so the stairs' full-height half faces
    // inward: +across on the low side, -across on the high side.
    const upA: Cardinal = axis === 'z' ? 'east' : 'south';
    const upB: Cardinal = axis === 'z' ? 'west' : 'north';
    const prevY = i > 0 ? Math.round((i - 1) * pitch) : y;
    for (let l = alongLo; l <= alongHi; l++) {
      const [wx1, wz1] = axis === 'z' ? [ax + a1, az + l] : [ax + l, az + a1];
      put(a1, l, y, stairAt(ctx, stairs, wx1, ay + y, wz1, upA));
      if (a2 !== a1) {
        const [wx2, wz2] = axis === 'z' ? [ax + a2, az + l] : [ax + l, az + a2];
        put(a2, l, y, stairAt(ctx, stairs, wx2, ay + y, wz2, upB));
      }
      // Fill the vertical gap when the pitch is steeper than one block.
      for (let yy = prevY + 1; yy < y; yy++) {
        put(a1, l, yy, solid);
        if (a2 !== a1) put(a2, l, yy, solid);
      }
    }
    if (a2 - a1 <= 1) {
      const capY = Math.round((i + 1) * pitch);
      ridgeY = capY;
      for (let l = alongLo; l <= alongHi; l++)
        for (let a = a1; a <= a2; a++) put(a, l, capY, p.ridge ?? solid);
      break;
    }
    i++;
  }

  // Gable ends: close the triangle under the slope at both ends of the ridge.
  const gable = p.gableBlock ?? '@wall';
  for (const l of [0, along - 1]) {
    for (let step = 0; ; step++) {
      const a1 = lo + step, a2 = hi - step;
      if (a1 > a2) break;
      const y = Math.round(step * pitch);
      for (let yy = 0; yy < y; yy++)
        for (let a = a1; a <= a2; a++) put(a, l, yy, gable, true);
      if (a2 - a1 <= 1) break;
    }
  }
  void ridgeY;
}

// ── Composite building elements ───────────────────────────────────────────

export function battlements(ctx: ShapeCtx, p: BattlementsPart): void {
  const [ax, ay, az] = atOf(p.at);
  const [w, , d] = sizeOf(p.size);
  const h = Math.max(1, Math.round(p.height ?? 1));
  const mw = Math.max(1, Math.round(p.width ?? 1));
  const gap = Math.max(1, Math.round(p.gap ?? 1));
  const period = mw + gap;
  const block = p.block ?? '@wall';
  const keep = p.mode === 'keep';

  const onMerlon = (t: number) => ((t % period) + period) % period < mw;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (onMerlon(x)) {
        ctx.paint(ax + x, ay + y, az, block, keep);
        ctx.paint(ax + x, ay + y, az + d - 1, block, keep);
      }
    }
    for (let z = 0; z < d; z++) {
      if (onMerlon(z)) {
        ctx.paint(ax, ay + y, az + z, block, keep);
        ctx.paint(ax + w - 1, ay + y, az + z, block, keep);
      }
    }
  }
}

export function arch(ctx: ShapeCtx, p: ArchPart): void {
  const [ax, ay, az] = atOf(p.at);
  const span = Math.max(2, Math.round(Number(p.span) || 3));
  const h = Math.max(2, Math.round(Number(p.h) || 4));
  const depth = Math.max(1, Math.round(p.depth ?? 1));
  const axis = p.axis ?? 'x';
  const block = p.cut ? 'air' : (p.block ?? '@wall');
  const keep = !p.cut && p.mode === 'keep';

  const r = (span - 1) / 2;
  const cx = r;
  const straight = Math.max(0, h - Math.ceil(r) - 1);

  const put = (a: number, y: number, dpt: number) => {
    if (axis === 'x') ctx.paint(ax + a, ay + y, az + dpt, block, keep);
    else ctx.paint(ax + dpt, ay + y, az + a, block, keep);
  };

  for (let dpt = 0; dpt < depth; dpt++) {
    for (let a = 0; a < span; a++) {
      const da = a - cx;
      const arcTop = straight + Math.round(Math.sqrt(Math.max(0, (r + 0.5) * (r + 0.5) - da * da)));
      const top = Math.min(h - 1, arcTop);
      if (p.cut) {
        for (let y = 0; y <= top; y++) put(a, y, dpt);
      } else {
        // Draw the ring: the arc line plus the two jambs.
        put(a, top, dpt);
        if (a === 0 || a === span - 1) for (let y = 0; y <= top; y++) put(a, y, dpt);
      }
    }
  }
}

export function spiral(ctx: ShapeCtx, p: SpiralPart): void {
  const [ax, ay, az] = atOf(p.at);
  const r = Math.max(1, Math.round(Number(p.r) || 2));
  const h = Math.max(1, Math.round(Number(p.h) || 8));
  const turn = Math.max(4, Math.round(p.turn ?? 8));
  const cw = p.cw !== false;
  const block = p.block ?? '@floor';
  const keep = p.mode === 'keep';
  const useStairs = p.stairs;

  const cx = ax + r, cz = az + r;
  for (let y = 0; y < h; y++) {
    const frac = (y / turn) * Math.PI * 2 * (cw ? 1 : -1);
    for (let rr = 1; rr <= r; rr++) {
      const x = Math.round(cx + Math.cos(frac) * rr);
      const z = Math.round(cz + Math.sin(frac) * rr);
      if (useStairs) {
        // Face the direction of travel so the steps are walkable.
        const nf = ((y + 1) / turn) * Math.PI * 2 * (cw ? 1 : -1);
        const nx = Math.round(cx + Math.cos(nf) * rr);
        const nz = Math.round(cz + Math.sin(nf) * rr);
        const dx = nx - x, dz = nz - z;
        const dir: Cardinal = Math.abs(dx) >= Math.abs(dz)
          ? (dx >= 0 ? 'east' : 'west')
          : (dz >= 0 ? 'south' : 'north');
        ctx.paint(x, ay + y, z, stairAt(ctx, useStairs, x, ay + y, z, dir), keep);
      } else {
        ctx.paint(x, ay + y, z, block, keep);
      }
    }
  }
}

export function windows(ctx: ShapeCtx, p: WindowsPart): void {
  const [ax, ay, az] = atOf(p.at);
  const [w, h, d] = sizeOf(p.size);
  const sides = new Set(p.sides ?? ['north', 'south', 'east', 'west']);
  const [ww, wh] = p.win ?? [1, 2];
  const spacing = Math.max(ww + 1, Math.round(p.spacing ?? ww + 2));
  const glass = p.glass;
  const keep = false;

  const sillY = Math.max(1, Math.floor((h - wh) / 2));

  const run = (len: number, place: (t: number, y: number) => void) => {
    // Centre the window run so openings sit symmetrically on the wall.
    const count = Math.max(1, Math.floor((len - 2) / spacing));
    const used = count * ww + (count - 1) * (spacing - ww);
    let start = Math.floor((len - used) / 2);
    if (start < 1) start = 1;
    for (let i = 0; i < count; i++) {
      const t0 = start + i * spacing;
      if (t0 + ww > len - 1) break;
      for (let t = t0; t < t0 + ww; t++)
        for (let y = sillY; y < sillY + wh && y < h; y++) place(t, y);
    }
  };

  const put = (x: number, y: number, z: number) => {
    ctx.paint(x, y, z, 'air');
    if (glass) ctx.paint(x, y, z, glass, keep);
  };

  if (sides.has('north')) run(w, (t, y) => put(ax + t, ay + y, az));
  if (sides.has('south')) run(w, (t, y) => put(ax + t, ay + y, az + d - 1));
  if (sides.has('west')) run(d, (t, y) => put(ax, ay + y, az + t));
  if (sides.has('east')) run(d, (t, y) => put(ax + w - 1, ay + y, az + t));
}

export function door(ctx: ShapeCtx, p: DoorPart): void {
  const [ax, ay, az] = atOf(p.at);
  const w = Math.max(1, Math.round(p.width ?? 1));
  const h = Math.max(2, Math.round(p.height ?? 2));
  const facing = p.facing ?? 'south';

  for (let y = 0; y < h; y++)
    for (let i = 0; i < w; i++) {
      const dx = facing === 'north' || facing === 'south' ? i : 0;
      const dz = facing === 'east' || facing === 'west' ? i : 0;
      ctx.paint(ax + dx, ay + y, az + dz, 'air');
    }

  if (p.door) {
    ctx.paint(ax, ay, az, withStates(p.door, { facing, half: 'lower', hinge: 'left', open: 'false' }));
    ctx.paint(ax, ay + 1, az, withStates(p.door, { facing, half: 'upper', hinge: 'left', open: 'false' }));
  }
}

export function scatter(ctx: ShapeCtx, p: ScatterPart): void {
  const [ax, ay, az] = atOf(p.at);
  const [w, h, d] = sizeOf(p.size);
  const density = Math.max(0, Math.min(1, Number(p.density ?? 0.15)));
  const block = p.block ?? '@detail';

  for (let y = 0; y < h; y++)
    for (let z = 0; z < d; z++)
      for (let x = 0; x < w; x++) {
        const wx = ax + x, wy = ay + y, wz = az + z;
        if (noise01(wx, wy, wz, ctx.seed ^ 0x1f83d9ab) >= density) continue;
        ctx.paint(wx, wy, wz, block, true);
      }
}

export function foundation(ctx: ShapeCtx, p: FoundationPart): void {
  const [ax, ay, az] = atOf(p.at);
  const w = Math.max(1, Math.round(p.size?.[0] ?? 1));
  const d = Math.max(1, Math.round(p.size?.[1] ?? 1));
  const depth = Math.max(1, Math.round(p.depth ?? 3));
  const block = p.block ?? '@base';
  const keep = p.mode === 'keep';
  const clearAbove = Math.max(0, Math.round(p.clearAbove ?? 0));

  for (let z = 0; z < d; z++) {
    for (let x = 0; x < w; x++) {
      const wx = ax + x, wz = az + z;
      // Never rise above the pad: a foundation fills down to the ground and
      // bridges any dip, but the floor level stays where the blueprint put it.
      const ground = ctx.heightAt(wx, wz);
      const top = ground === null ? ay : Math.min(ay, ground);
      for (let y = top; y > top - depth; y--) ctx.paint(wx, y, wz, block, keep);
      for (let y = ay + 1; y <= ay + clearAbove; y++) ctx.paint(wx, y, wz, 'air');
      // Bridge the gap when the terrain sits below the pad.
      for (let y = top + 1; y <= ay; y++) ctx.paint(wx, y, wz, block, keep);
    }
  }
}

/** Terrain height at a blueprint-local column, or null when out of sample. */
export function sampleHeight(t: TerrainSample, x: number, z: number): number | null {
  if (x < t.x1 || x > t.x2 || z < t.z1 || z > t.z2) return null;
  const w = t.x2 - t.x1 + 1;
  const idx = (z - t.z1) * w + (x - t.x1);
  const v = t.heights[idx];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export { isAir };
