// Shape generators. Every generator emits integer positions exactly once (no duplicates).
// See docs/ENGINE-API.md (shapes.ts).
//
// Conventions
//  * Round shapes test block positions against radius + 0.5, so a radius r gives a width of
//    2r+1 blocks. Fractional centers/radii are allowed: center 10.5 with radius 3.5 → 8 wide
//    (x = 7..14). Use this for even widths.
//  * hollow = the thinnest shell that is watertight for 6-connectivity (no face-adjacent path
//    from the inside to the outside); thickness t = all blocks within Manhattan distance t of
//    the outside. Open ends: hollow cylinders are tubes (no caps unless caps: true); hollow
//    cones/pyramids/half-ellipsoids have no floor.
import type { Box, Facing, Vec3 } from './types.ts';
import type { Registry } from './registry.ts';
import { RegistryError } from './registry.ts';
import { blockId } from './blockstate.ts';
import { stairsShapeFor, type Dir4, type StairInfo } from './connect.ts';

export interface PosSink {
  (x: number, y: number, z: number): void;
}
export interface StateSink {
  (x: number, y: number, z: number, state: string): void;
}

const EPS = 1e-9;

function nb(b: Box): Box {
  return {
    min: [Math.min(b.min[0], b.max[0]), Math.min(b.min[1], b.max[1]), Math.min(b.min[2], b.max[2])],
    max: [Math.max(b.min[0], b.max[0]), Math.max(b.min[1], b.max[1]), Math.max(b.min[2], b.max[2])],
  };
}

function checkInt(v: number, what: string) {
  if (!Number.isFinite(v)) throw new Error(`${what} must be a finite number`);
}

// ---------------------------------------------------------------------------------------
// generic region emitter (solid or watertight shell)

interface Open {
  x0?: boolean; x1?: boolean; y0?: boolean; y1?: boolean; z0?: boolean; z1?: boolean;
}

const MAX_GRID = 48_000_000;

/**
 * Emit all integer points in [min,max] where inside() holds (solid) or the shell of that set.
 * Points outside [min,max] are outside, except across an `open` plane where they count as inside.
 */
export function emitRegion(
  min: Vec3,
  max: Vec3,
  inside: (x: number, y: number, z: number) => boolean,
  hollow: boolean,
  thickness: number,
  emit: PosSink,
  open: Open = {},
): void {
  const x0 = min[0] + 0, y0 = min[1] + 0, z0 = min[2] + 0; // + 0 normalizes -0
  const [x1, y1, z1] = max;
  if (x1 < x0 || y1 < y0 || z1 < z0) return;
  if (!hollow) {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if (inside(x, y, z)) emit(x, y, z);
    return;
  }
  const t = Math.max(1, Math.floor(thickness || 1));
  const inAt = (x: number, y: number, z: number): boolean => {
    if (x < x0) return !!open.x0;
    if (x > x1) return !!open.x1;
    if (y < y0) return !!open.y0;
    if (y > y1) return !!open.y1;
    if (z < z0) return !!open.z0;
    if (z > z1) return !!open.z1;
    return inside(x, y, z);
  };
  const nx = x1 - x0 + 1, ny = y1 - y0 + 1, nz = z1 - z0 + 1;
  const total = nx * ny * nz;
  if (t === 1 || total > MAX_GRID) {
    if (t === 1) {
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++)
          for (let x = x0; x <= x1; x++) {
            if (!inside(x, y, z)) continue;
            if (!inAt(x + 1, y, z) || !inAt(x - 1, y, z) || !inAt(x, y + 1, z) || !inAt(x, y - 1, z) || !inAt(x, y, z + 1) || !inAt(x, y, z - 1))
              emit(x, y, z);
          }
      return;
    }
    // huge region with thick shell: direct L1-ball test (slow path)
    const offs: Vec3[] = [];
    for (let dy = -t; dy <= t; dy++)
      for (let dz = -t; dz <= t; dz++)
        for (let dx = -t; dx <= t; dx++) {
          const d = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
          if (d >= 1 && d <= t) offs.push([dx, dy, dz]);
        }
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          if (!inside(x, y, z)) continue;
          for (const o of offs)
            if (!inAt(x + o[0], y + o[1], z + o[2])) {
              emit(x, y, z);
              break;
            }
        }
    return;
  }
  // grid + exact L1 distance transform (two-pass chamfer)
  const INF = 255;
  const d = new Uint8Array(total);
  const sxy = nx * nz; // y stride
  let i = 0;
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) d[i++] = inside(x, y, z) ? INF : 0;
  const bx0 = open.x0 ? INF : 1, bx1 = open.x1 ? INF : 1;
  const by0 = open.y0 ? INF : 1, by1 = open.y1 ? INF : 1;
  const bz0 = open.z0 ? INF : 1, bz1 = open.z1 ? INF : 1;
  i = 0;
  for (let y = 0; y < ny; y++)
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++, i++) {
        let v = d[i];
        if (v === 0) continue;
        const a = x > 0 ? d[i - 1] + 1 : bx0;
        const b = z > 0 ? d[i - nx] + 1 : bz0;
        const c = y > 0 ? d[i - sxy] + 1 : by0;
        if (a < v) v = a;
        if (b < v) v = b;
        if (c < v) v = c;
        d[i] = v > INF ? INF : v;
      }
  i = total - 1;
  for (let y = ny - 1; y >= 0; y--)
    for (let z = nz - 1; z >= 0; z--)
      for (let x = nx - 1; x >= 0; x--, i--) {
        let v = d[i];
        if (v === 0) continue;
        const a = x < nx - 1 ? d[i + 1] + 1 : bx1;
        const b = z < nz - 1 ? d[i + nx] + 1 : bz1;
        const c = y < ny - 1 ? d[i + sxy] + 1 : by1;
        if (a < v) v = a;
        if (b < v) v = b;
        if (c < v) v = c;
        d[i] = v > INF ? INF : v;
      }
  i = 0;
  for (let y = y0; y <= y1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++, i++) {
        const v = d[i];
        if (v >= 1 && v <= t) emit(x, y, z);
      }
}

// ---------------------------------------------------------------------------------------
// box

export function box(
  p: { box: Box; mode?: 'solid' | 'hollow' | 'walls' | 'outline' | 'floor' | 'ceiling'; thickness?: number },
  emit: PosSink,
): void {
  const b = nb(p.box);
  const x0 = b.min[0] + 0, y0 = b.min[1] + 0, z0 = b.min[2] + 0;
  const [x1, y1, z1] = b.max;
  const t = Math.max(1, Math.floor(p.thickness ?? 1));
  const mode = p.mode ?? 'solid';
  const near = (v: number, lo: number, hi: number) => v - lo < t || hi - v < t;
  switch (mode) {
    case 'solid':
      for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) emit(x, y, z);
      return;
    case 'floor':
    case 'ceiling': {
      const ya = mode === 'floor' ? y0 : Math.max(y0, y1 - t + 1);
      const yb = mode === 'floor' ? Math.min(y1, y0 + t - 1) : y1;
      for (let y = ya; y <= yb; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) emit(x, y, z);
      return;
    }
    case 'hollow':
    case 'walls':
    case 'outline':
      for (let y = y0; y <= y1; y++) {
        const ny = near(y, y0, y1);
        for (let z = z0; z <= z1; z++) {
          const nz = near(z, z0, z1);
          for (let x = x0; x <= x1; x++) {
            const nx = near(x, x0, x1);
            let ok: boolean;
            if (mode === 'hollow') ok = nx || ny || nz;
            else if (mode === 'walls') ok = nx || nz;
            else ok = (nx ? 1 : 0) + (ny ? 1 : 0) + (nz ? 1 : 0) >= 2;
            if (ok) emit(x, y, z);
          }
        }
      }
      return;
    default:
      throw new Error(`box: unknown mode "${mode}" (solid|hollow|walls|outline|floor|ceiling)`);
  }
}

// ---------------------------------------------------------------------------------------
// ellipsoid / cylinder / cone / pyramid / torus

export function ellipsoid(
  p: { center: Vec3; radius: number | Vec3; hollow?: boolean; thickness?: number; half?: 'top' | 'bottom' | null },
  emit: PosSink,
): void {
  const [cx, cy, cz] = p.center;
  const r = typeof p.radius === 'number' ? [p.radius, p.radius, p.radius] : p.radius;
  if (r.some((v) => !(v >= 0))) throw new Error('ellipsoid: radius must be >= 0');
  const ax = r[0] + 0.5, ay = r[1] + 0.5, az = r[2] + 0.5;
  let ylo = Math.ceil(cy - ay - EPS), yhi = Math.floor(cy + ay + EPS);
  const open: Open = {};
  if (p.half === 'top') {
    ylo = Math.max(ylo, Math.ceil(cy - EPS));
    open.y0 = true;
  } else if (p.half === 'bottom') {
    yhi = Math.min(yhi, Math.floor(cy + EPS));
    open.y1 = true;
  }
  const ix = 1 / (ax * ax), iy = 1 / (ay * ay), iz = 1 / (az * az);
  emitRegion(
    [Math.ceil(cx - ax - EPS), ylo, Math.ceil(cz - az - EPS)],
    [Math.floor(cx + ax + EPS), yhi, Math.floor(cz + az + EPS)],
    (x, y, z) => {
      const dx = x - cx, dy = y - cy, dz = z - cz;
      return dx * dx * ix + dy * dy * iy + dz * dz * iz <= 1 + EPS;
    },
    !!p.hollow,
    p.thickness ?? 1,
    emit,
    open,
  );
}

export function cylinder(
  p: { base: Vec3; radius: number | [number, number]; height: number; axis?: 'x' | 'y' | 'z'; hollow?: boolean; thickness?: number; caps?: boolean },
  emit: PosSink,
): void {
  const axis = p.axis ?? 'y';
  const [ra, rb] = typeof p.radius === 'number' ? [p.radius, p.radius] : p.radius;
  if (!(ra >= 0) || !(rb >= 0)) throw new Error('cylinder: radius must be >= 0');
  let h = Math.round(p.height);
  if (h === 0) return;
  const ai = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  // disc axes (a, b): y-axis → (x, z); x-axis → (y, z); z-axis → (x, y)
  const [ia, ib] = ai === 0 ? [1, 2] : ai === 1 ? [0, 2] : [0, 1];
  const base = p.base;
  let s0 = Math.round(base[ai]);
  if (h < 0) {
    s0 = s0 + h + 1;
    h = -h;
  }
  const aa = ra + 0.5, bb = rb + 0.5;
  const ca = base[ia], cb = base[ib];
  const min: Vec3 = [0, 0, 0], max: Vec3 = [0, 0, 0];
  min[ai] = s0;
  max[ai] = s0 + h - 1;
  min[ia] = Math.ceil(ca - aa - EPS);
  max[ia] = Math.floor(ca + aa + EPS);
  min[ib] = Math.ceil(cb - bb - EPS);
  max[ib] = Math.floor(cb + bb + EPS);
  const iA = 1 / (aa * aa), iB = 1 / (bb * bb);
  const v: Vec3 = [0, 0, 0];
  const open: Open = {};
  if (!p.caps) {
    const k0 = (['x0', 'y0', 'z0'] as const)[ai];
    const k1 = (['x1', 'y1', 'z1'] as const)[ai];
    open[k0] = true;
    open[k1] = true;
  }
  emitRegion(
    min,
    max,
    (x, y, z) => {
      v[0] = x; v[1] = y; v[2] = z;
      const da = v[ia] - ca, db = v[ib] - cb;
      return da * da * iA + db * db * iB <= 1 + EPS;
    },
    !!p.hollow,
    p.thickness ?? 1,
    emit,
    open,
  );
}

/** cone along +y (height < 0 → pointing down from base) */
export function cone(p: { base: Vec3; radius: number; height: number; hollow?: boolean; thickness?: number }, emit: PosSink): void {
  const [cx, by, cz] = p.base;
  const r = p.radius;
  if (!(r >= 0)) throw new Error('cone: radius must be >= 0');
  const hRaw = Math.round(p.height);
  if (hRaw === 0) return;
  const down = hRaw < 0;
  const h = Math.abs(hRaw);
  const yb = Math.round(by);
  const radAt = (layer: number) => (h === 1 ? r : (r * (h - 1 - layer)) / (h - 1));
  const a = r + 0.5;
  emitRegion(
    [Math.ceil(cx - a - EPS), down ? yb - h + 1 : yb, Math.ceil(cz - a - EPS)],
    [Math.floor(cx + a + EPS), down ? yb : yb + h - 1, Math.floor(cz + a + EPS)],
    (x, y, z) => {
      const layer = down ? yb - y : y - yb;
      const rr = radAt(layer) + 0.5;
      const dx = x - cx, dz = z - cz;
      return dx * dx + dz * dz <= rr * rr + EPS;
    },
    !!p.hollow,
    p.thickness ?? 1,
    emit,
    down ? { y1: true } : { y0: true },
  );
}

/**
 * Stepped pyramid. base = center of the bottom layer (use .5 for even sizes, e.g. size 8 at
 * x=10.5 covers x=7..14), size = footprint width (number or [sx, sz]). height default: until
 * the top is 1–2 wide (ceil(min(size)/2)); a different height stretches/compresses the steps.
 */
export function pyramid(p: { base: Vec3; size: number | [number, number]; height?: number; hollow?: boolean; thickness?: number }, emit: PosSink): void {
  const [sx, sz] = typeof p.size === 'number' ? [p.size, p.size] : p.size;
  if (!(sx >= 1) || !(sz >= 1)) throw new Error('pyramid: size must be >= 1');
  const SX = Math.round(sx), SZ = Math.round(sz);
  const x0 = Math.ceil(p.base[0] - (SX - 1) / 2 - EPS);
  const z0 = Math.ceil(p.base[2] - (SZ - 1) / 2 - EPS);
  const x1 = x0 + SX - 1, z1 = z0 + SZ - 1;
  const y0 = Math.round(p.base[1]);
  const H0 = Math.ceil(Math.min(SX, SZ) / 2);
  const H = Math.max(1, Math.round(p.height ?? H0));
  const insetAt = (layer: number) => Math.floor((layer * H0) / H + EPS);
  emitRegion(
    [x0, y0, z0],
    [x1, y0 + H - 1, z1],
    (x, y, z) => {
      const k = insetAt(y - y0);
      return x >= x0 + k && x <= x1 - k && z >= z0 + k && z <= z1 - k;
    },
    !!p.hollow,
    p.thickness ?? 1,
    emit,
    { y0: true },
  );
}

export function torus(p: { center: Vec3; major: number; minor: number; axis?: 'x' | 'y' | 'z' }, emit: PosSink): void {
  const [cx, cy, cz] = p.center;
  const R = p.major, r = p.minor + 0.5;
  if (!(R >= 0) || !(p.minor >= 0)) throw new Error('torus: radii must be >= 0');
  const axis = p.axis ?? 'y';
  const ext = R + r;
  const ea = axis === 'x' ? r : ext, eb = axis === 'y' ? r : ext, ec = axis === 'z' ? r : ext;
  const r2 = r * r;
  emitRegion(
    [Math.ceil(cx - ea - EPS), Math.ceil(cy - eb - EPS), Math.ceil(cz - ec - EPS)],
    [Math.floor(cx + ea + EPS), Math.floor(cy + eb + EPS), Math.floor(cz + ec + EPS)],
    (x, y, z) => {
      const dx = x - cx, dy = y - cy, dz = z - cz;
      let u: number, w: number;
      if (axis === 'y') { u = Math.sqrt(dx * dx + dz * dz); w = dy; }
      else if (axis === 'x') { u = Math.sqrt(dy * dy + dz * dz); w = dx; }
      else { u = Math.sqrt(dx * dx + dy * dy); w = dz; }
      const q = u - R;
      return q * q + w * w <= r2 + EPS;
    },
    false,
    1,
    emit,
  );
}

// ---------------------------------------------------------------------------------------
// lines & curves

/** 3D Bresenham between integer points (26-connected), inclusive, no duplicates */
export function bresenham3(a: Vec3, b: Vec3, emit: PosSink): void {
  let x = Math.round(a[0]) + 0, y = Math.round(a[1]) + 0, z = Math.round(a[2]) + 0;
  const x2 = Math.round(b[0]), y2 = Math.round(b[1]), z2 = Math.round(b[2]);
  const dx = Math.abs(x2 - x), dy = Math.abs(y2 - y), dz = Math.abs(z2 - z);
  const sx = x2 > x ? 1 : -1, sy = y2 > y ? 1 : -1, sz = z2 > z ? 1 : -1;
  emit(x, y, z);
  if (dx >= dy && dx >= dz) {
    let p1 = 2 * dy - dx, p2 = 2 * dz - dx;
    while (x !== x2) {
      x += sx;
      if (p1 >= 0) { y += sy; p1 -= 2 * dx; }
      if (p2 >= 0) { z += sz; p2 -= 2 * dx; }
      p1 += 2 * dy; p2 += 2 * dz;
      emit(x, y, z);
    }
  } else if (dy >= dx && dy >= dz) {
    let p1 = 2 * dx - dy, p2 = 2 * dz - dy;
    while (y !== y2) {
      y += sy;
      if (p1 >= 0) { x += sx; p1 -= 2 * dy; }
      if (p2 >= 0) { z += sz; p2 -= 2 * dy; }
      p1 += 2 * dx; p2 += 2 * dz;
      emit(x, y, z);
    }
  } else {
    let p1 = 2 * dy - dz, p2 = 2 * dx - dz;
    while (z !== z2) {
      z += sz;
      if (p1 >= 0) { y += sy; p1 -= 2 * dz; }
      if (p2 >= 0) { x += sx; p2 -= 2 * dz; }
      p1 += 2 * dy; p2 += 2 * dx;
      emit(x, y, z);
    }
  }
}

/** set of integer positions with fast numeric keys inside a known bounding box */
class PosSet {
  private x0: number; private y0: number; private z0: number;
  private sy: number; private sz: number;
  private set = new Set<number>();
  constructor(min: Vec3, max: Vec3) {
    this.x0 = min[0] - 1; this.y0 = min[1] - 1; this.z0 = min[2] - 1;
    this.sy = max[1] - min[1] + 3;
    this.sz = max[2] - min[2] + 3;
  }
  add(x: number, y: number, z: number): boolean {
    const k = ((x - this.x0) * this.sy + (y - this.y0)) * this.sz + (z - this.z0);
    if (this.set.has(k)) return false;
    this.set.add(k);
    return true;
  }
}

function ballOffsets(radius: number): Vec3[] {
  const a = radius + 0.5;
  const R = Math.ceil(a);
  const out: Vec3[] = [];
  for (let dy = -R; dy <= R; dy++)
    for (let dz = -R; dz <= R; dz++)
      for (let dx = -R; dx <= R; dx++) if (dx * dx + dy * dy + dz * dz <= a * a + EPS) out.push([dx, dy, dz]);
  return out;
}

/** distance from point to segment ab */
function segDist2(px: number, py: number, pz: number, a: Vec3, b: Vec3): number {
  const vx = b[0] - a[0], vy = b[1] - a[1], vz = b[2] - a[2];
  const wx = px - a[0], wy = py - a[1], wz = pz - a[2];
  const L = vx * vx + vy * vy + vz * vz;
  let t = L > 0 ? (wx * vx + wy * vy + wz * vz) / L : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const dx = wx - t * vx, dy = wy - t * vy, dz = wz - t * vz;
  return dx * dx + dy * dy + dz * dz;
}

/** straight line; thickness = brush diameter in blocks (1 = Bresenham line) */
export function line(p: { from: Vec3; to: Vec3; thickness?: number }, emit: PosSink): void {
  const t = p.thickness ?? 1;
  if (t <= 1) return bresenham3(p.from, p.to, emit);
  const r = t / 2;
  const a = p.from, b = p.to;
  const lo: Vec3 = [Math.floor(Math.min(a[0], b[0]) - r), Math.floor(Math.min(a[1], b[1]) - r), Math.floor(Math.min(a[2], b[2]) - r)];
  const hi: Vec3 = [Math.ceil(Math.max(a[0], b[0]) + r), Math.ceil(Math.max(a[1], b[1]) + r), Math.ceil(Math.max(a[2], b[2]) + r)];
  const r2 = r * r + EPS;
  emitRegion(lo, hi, (x, y, z) => segDist2(x, y, z, a, b) <= r2, false, 1, emit);
}

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** sample a curve densely (spacing <= 0.25 blocks) */
export function sampleCurve(points: Vec3[], kind: 'bezier' | 'catmull' = 'catmull'): Vec3[] {
  if (points.length < 2) throw new Error('curve: needs at least 2 points');
  let len = 0;
  for (let i = 1; i < points.length; i++) len += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1], points[i][2] - points[i - 1][2]);
  const out: Vec3[] = [];
  if (kind === 'bezier') {
    const n = points.length - 1;
    const steps = Math.max(2, Math.ceil(len * 4));
    // de Casteljau
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const tmp = points.map((q) => [q[0], q[1], q[2]] as Vec3);
      for (let k = n; k > 0; k--)
        for (let i = 0; i < k; i++)
          for (let c = 0; c < 3; c++) tmp[i][c] = tmp[i][c] * (1 - t) + tmp[i + 1][c] * t;
      out.push(tmp[0]);
    }
    return out;
  }
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)], p1 = points[i], p2 = points[i + 1], p3 = points[Math.min(points.length - 1, i + 2)];
    const seg = Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]);
    const steps = Math.max(2, Math.ceil(seg * 4));
    for (let s = i === 0 ? 0 : 1; s <= steps; s++) {
      const t = s / steps;
      out.push([catmull(p0[0], p1[0], p2[0], p3[0], t), catmull(p0[1], p1[1], p2[1], p3[1], t), catmull(p0[2], p1[2], p2[2], p3[2], t)]);
    }
  }
  return out;
}

/** smooth curve through (catmull) or controlled by (bezier) points; radius = brush radius (0 = 1 block) */
export function curve(p: { points: Vec3[]; kind?: 'bezier' | 'catmull'; radius?: number }, emit: PosSink): void {
  const samples = sampleCurve(p.points, p.kind ?? 'catmull');
  const radius = Math.max(0, p.radius ?? 0);
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const s of samples) for (let c = 0; c < 3; c++) {
    lo[c] = Math.min(lo[c], Math.floor(s[c]));
    hi[c] = Math.max(hi[c], Math.ceil(s[c]));
  }
  const R = Math.ceil(radius + 0.5);
  const set = new PosSet([lo[0] - R, lo[1] - R, lo[2] - R], [hi[0] + R, hi[1] + R, hi[2] + R]);
  const ball = radius > 0 ? ballOffsets(radius) : null;
  const put = (x: number, y: number, z: number) => {
    if (!ball) {
      if (set.add(x, y, z)) emit(x, y, z);
      return;
    }
    for (const o of ball) {
      const a = x + o[0], b = y + o[1], c = z + o[2];
      if (set.add(a, b, c)) emit(a, b, c);
    }
  };
  let prev: Vec3 | null = null;
  for (const s of samples) {
    const r: Vec3 = [Math.round(s[0]) + 0, Math.round(s[1]) + 0, Math.round(s[2]) + 0];
    if (prev && prev[0] === r[0] && prev[1] === r[1] && prev[2] === r[2]) continue;
    if (prev) {
      let first = true;
      bresenham3(prev, r, (x, y, z) => {
        if (first) { first = false; return; }
        put(x, y, z);
      });
    } else put(r[0], r[1], r[2]);
    prev = r;
  }
}

// ---------------------------------------------------------------------------------------
// polygon prism

function bresenham2(a: [number, number], b: [number, number], cb: (x: number, z: number) => void): void {
  bresenham3([a[0], 0, a[1]], [b[0], 0, b[1]], (x, _y, z) => cb(x, z));
}

/** vertical prism over a polygon (points in x,z, closed automatically). hollow = only the outline walls */
export function polygon(p: { points: [number, number][]; y: number; height: number; hollow?: boolean }, emit: PosSink): void {
  const pts = p.points.map(([x, z]) => [Math.round(x) + 0, Math.round(z) + 0] as [number, number]);
  if (pts.length < 2) throw new Error('polygon: needs at least 2 points');
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const w = x1 - x0 + 1, d = z1 - z0 + 1;
  const grid = new Uint8Array(w * d);
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if (pts.length === 2 && i === 1) break;
    bresenham2(a, b, (x, z) => { grid[(z - z0) * w + (x - x0)] = 1; });
  }
  if (!p.hollow && pts.length >= 3) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        // even-odd test at the block position
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [xi, zi] = pts[i], [xj, zj] = pts[j];
          if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
        }
        if (inside) grid[(z - z0) * w + (x - x0)] = 1;
      }
    }
  }
  let h = Math.round(p.height);
  let y0 = Math.round(p.y) + 0;
  if (h < 0) { y0 = y0 + h + 1; h = -h; }
  for (let y = y0; y < y0 + h; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) if (grid[(z - z0) * w + (x - x0)]) emit(x, y, z);
}

// ---------------------------------------------------------------------------------------
// arch

/**
 * Arch in the vertical plane through from→to (must differ along x or z only; base y = from.y).
 * The arch ring (thickness t) spans from the foot at `from` to the foot at `to` and rises
 * `height` blocks above base y (crown at from.y + height). depth extrudes along the other
 * horizontal axis (+ direction; negative depth → − direction).
 * style: round (half ellipse), pointed (gothic, two arcs), flat (two legs + lintel).
 */
export function arch(
  p: { from: Vec3; to: Vec3; height: number; thickness?: number; depth?: number; style?: 'round' | 'pointed' | 'flat' },
  emit: PosSink,
): void {
  const f = p.from.map((v) => Math.round(v) + 0) as Vec3;
  const t2 = p.to.map((v) => Math.round(v) + 0) as Vec3;
  const dxa = t2[0] - f[0], dza = t2[2] - f[2];
  if (dxa !== 0 && dza !== 0) throw new Error('arch: "from" and "to" must be aligned along x or along z (same other horizontal coordinate)');
  const alongX = dza === 0;
  const W = Math.abs(alongX ? dxa : dza);
  const sgn = (alongX ? dxa : dza) >= 0 ? 1 : -1;
  const H = Math.max(0, Math.round(p.height));
  const t = Math.max(1, Math.round(p.thickness ?? 1));
  const depth = Math.round(p.depth ?? 1) || 1;
  const style = p.style ?? 'round';
  // 2D mask in (u, v), u ∈ [0, W], v ∈ [0, H]
  const nu = W + 1, nv = H + 1;
  const mask = new Uint8Array(nu * nv);
  if (style === 'flat') {
    for (let v = 0; v <= H; v++) for (let u = 0; u <= W; u++) if (u < t || W - u < t || H - v < t) mask[v * nu + u] = 1;
  } else {
    let inside: (u: number, v: number) => boolean;
    const cu = W / 2;
    if (style === 'round') {
      const a = W / 2 + 0.5, b = H + 0.5;
      inside = (u, v) => ((u - cu) * (u - cu)) / (a * a) + (v * v) / (b * b) <= 1 + EPS;
    } else if (style === 'pointed') {
      const R = W + 0.5;
      const k = Math.sqrt(Math.max(R * R - cu * cu, 0.25));
      const sc = k / (H + 0.5);
      inside = (u, v) => {
        const vv = v * sc;
        return (u - W) * (u - W) + vv * vv <= R * R + EPS && u * u + vv * vv <= R * R + EPS;
      };
    } else throw new Error(`arch: unknown style "${style}" (round|pointed|flat)`);
    const cells: [number, number][] = [];
    emitRegion([0, 0, 0], [W, H, 0], (u, v) => inside(u, v), true, t, (u, v) => { cells.push([u, v]); }, { y0: true, z0: true, z1: true });
    for (const [u, v] of cells) mask[v * nu + u] = 1;
  }
  const dsg = depth > 0 ? 1 : -1;
  const nd = Math.abs(depth);
  for (let v = 0; v <= H; v++)
    for (let k = 0; k < nd; k++)
      for (let u = 0; u <= W; u++) {
        if (!mask[v * nu + u]) continue;
        const along = f[alongX ? 0 : 2] + sgn * u;
        const across = f[alongX ? 2 : 0] + dsg * k;
        if (alongX) emit(along, f[1] + v, across);
        else emit(across, f[1] + v, along);
      }
}

// ---------------------------------------------------------------------------------------
// spiral

/**
 * Helical band: one layer per y (height layers), `turns` full revolutions (positive = clockwise
 * seen from above, negative = counter-clockwise), outer radius `radius`, radial `width`
 * (default = radius: the band reaches the center axis but never includes the center column).
 * cb receives each cell with the tangential ascending direction (for stairs).
 */
export function spiralCells(
  p: { center: Vec3; radius: number; height: number; turns: number; width?: number; startAngle?: number },
  cb: (x: number, y: number, z: number, ascend: Facing) => void,
): void {
  const [cx, cy, cz] = p.center;
  const H = Math.round(p.height);
  if (H < 1) return;
  const R = p.radius;
  if (!(R > 0)) throw new Error('spiral: radius must be > 0');
  const width = p.width ?? R;
  const turns = p.turns;
  if (!turns) throw new Error('spiral: turns must be non-zero');
  const q = Math.abs(turns) / H; // fraction of a revolution per layer
  if (q > 1) throw new Error('spiral: at most one full turn per layer (increase height or reduce turns)');
  const cw = turns > 0;
  const outer = R + 0.5;
  const inner = Math.max(0, R - width + 0.5);
  const start = ((p.startAngle ?? 0) * Math.PI) / 180;
  const cells: { x: number; z: number; f: number; face: Facing }[] = [];
  for (let z = Math.ceil(cz - outer - EPS) + 0; z <= Math.floor(cz + outer + EPS); z++)
    for (let x = Math.ceil(cx - outer - EPS) + 0; x <= Math.floor(cx + outer + EPS); x++) {
      const dx = x - cx, dz = z - cz;
      const dist = Math.hypot(dx, dz);
      if (dist > outer + EPS || dist < inner - EPS || dist < 1e-6) continue;
      let a = Math.atan2(dz, dx) - start; // 0 = +x (east), increasing toward +z (south) = clockwise from above
      a = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      let f = a / (2 * Math.PI);
      if (!cw) f = (1 - f) % 1;
      // ascending tangent
      const tx = (cw ? -1 : 1) * Math.sin(a + start), tz = (cw ? 1 : -1) * Math.cos(a + start);
      const face: Facing = Math.abs(tx) >= Math.abs(tz) ? (tx > 0 ? 'east' : 'west') : tz > 0 ? 'south' : 'north';
      cells.push({ x, z, f, face });
    }
  const y0 = Math.round(cy) + 0;
  for (let layer = 0; layer < H; layer++) {
    const s = (layer * q) % 1;
    for (const c of cells) {
      let rel = c.f - s;
      if (rel < 0) rel += 1;
      if (rel < q - EPS || (q >= 1 - EPS)) cb(c.x, y0 + layer, c.z, c.face);
    }
  }
}

export function spiral(p: { center: Vec3; radius: number; height: number; turns: number; width?: number }, emit: PosSink): void {
  spiralCells(p, (x, y, z) => emit(x, y, z));
}

// ---------------------------------------------------------------------------------------
// roof

export type RoofStyle = 'gable' | 'hip' | 'pyramid' | 'shed' | 'dome' | 'spire' | 'mansard' | 'gambrel' | 'flat';
export interface RoofParams {
  /** footprint x/z (usually the outer wall footprint); base y = box.min.y = first roof layer on top of the walls */
  box: Box;
  style: RoofStyle;
  /** ridge direction for gable/gambrel/shed (default: the longer side) */
  axis?: 'x' | 'z';
  stairs: string;
  slab?: string;
  /** solid fill under the roof surface (inside the footprint) */
  fill?: string;
  /** gable/gambrel/shed: block for the two end walls (gable triangles) under the roof */
  ends?: string;
  /** eaves beyond the footprint on every side (default 1; dome 0). The slope continues downward. */
  overhang?: number;
  /** rise per horizontal block (default gable/hip/pyramid/mansard/gambrel 1, shed 0.5, spire 3, dome 1 = hemisphere) */
  pitch?: number;
  /** shed only: direction the roof rises toward (default north for axis x, west for axis z) */
  facing?: Facing;
}

const DN = 1, DE = 2, DS = 4, DW = 8;
const DIR_BITS: [number, Dir4, number, number][] = [
  [DN, 'north', 0, -1],
  [DE, 'east', 1, 0],
  [DS, 'south', 0, 1],
  [DW, 'west', -1, 0],
];
const OPP_BIT: Record<number, number> = { [DN]: DS, [DS]: DN, [DE]: DW, [DW]: DE };
const CCW_BIT: Record<number, number> = { [DN]: DW, [DW]: DS, [DS]: DE, [DE]: DN };

function bitDir(b: number): Dir4 {
  return b === DN ? 'north' : b === DE ? 'east' : b === DS ? 'south' : 'west';
}

/** derive the full block / slab that match a stairs block */
export function roofMaterials(reg: Registry, stairs: string, slab?: string): { stairs: string; slab: string | null; full: string } {
  const sid = blockId(reg.canonical(stairs));
  const info = reg.info(sid)!;
  if (!info.properties.facing || !info.properties.half || !info.properties.shape)
    throw new RegistryError(`roof: "${stairs}" is not a stairs block (e.g. spruce_stairs, deepslate_tile_stairs)`);
  const base = sid.replace(/_stairs$/, '');
  let slabId: string | null = null;
  if (slab) {
    slabId = blockId(reg.canonical(slab));
    if (!reg.info(slabId)!.properties.type?.includes('bottom')) throw new RegistryError(`roof: "${slab}" is not a slab block`);
  } else {
    for (const c of [base + '_slab', base.replace(/_bricks?$/, '_brick') + '_slab']) if (reg.has(c)) { slabId = c; break; }
  }
  const cands = [
    base,
    base + 's',
    base + '_block',
    base + '_planks',
    base.replace(/_brick$/, '_bricks'),
    base.replace(/_tile$/, '_tiles'),
    base.replace(/^(.*)_(\w+)$/, '$1_$2s'),
  ];
  let full: string | null = null;
  for (const c of cands) if (reg.has(c) && reg.isFullSolid(reg.canonical(c))) { full = reg.canonical(c); break; }
  if (!full) full = slabId ? reg.canonical(`${slabId}[type=double]`) : reg.canonical(`${sid}[half=top]`);
  return { stairs: sid, slab: slabId, full };
}

const DEFAULT_PITCH: Record<RoofStyle, number> = {
  gable: 1, hip: 1, pyramid: 1, shed: 0.5, dome: 1, spire: 3, mansard: 1, gambrel: 1, flat: 0,
};

/**
 * Roof generator producing proper stairs states. Heights are computed on a half-block grid:
 * odd half-heights become bottom slabs, even ones stairs facing uphill (toward the ridge) with
 * vanilla-consistent inner/outer corner shapes; steep parts are backed by full blocks so the
 * surface has no see-through gaps; 1-wide ridges and apexes get a slab cap.
 */
export function roof(p: RoofParams, reg: Registry, emit: StateSink): void {
  const style = p.style;
  if (!(style in DEFAULT_PITCH)) throw new Error(`roof: unknown style "${style}" (gable|hip|pyramid|shed|dome|spire|mansard|gambrel|flat)`);
  const mats = roofMaterials(reg, p.stairs, p.slab);
  const fillState = p.fill ? reg.canonical(p.fill) : null;
  const endsState = p.ends ? reg.canonical(p.ends) : null;
  const b = nb(p.box);
  const [fx0, y0, fz0] = b.min;
  const [fx1, , fz1] = b.max;
  const o = Math.max(0, Math.round(p.overhang ?? (style === 'dome' ? 0 : 1)));
  const pitch = p.pitch ?? DEFAULT_PITCH[style];
  if (!(pitch >= 0)) throw new Error('roof: pitch must be >= 0');
  const X0 = fx0 - o, X1 = fx1 + o, Z0 = fz0 - o, Z1 = fz1 + o;
  const NX = X1 - X0 + 1, NZ = Z1 - Z0 + 1;
  const W = fx1 - fx0 + 1, D = fz1 - fz0 + 1;
  const axis = p.axis ?? (W >= D ? 'x' : 'z');
  const idx = (x: number, z: number) => (z - Z0) * NX + (x - X0);
  const NONE = -0x7fffffff;
  const T = new Int32Array(NX * NZ).fill(NONE); // half-block top surface, relative to y0
  const U = new Uint8Array(NX * NZ); // uphill direction bits
  const inFoot = (x: number, z: number) => x >= fx0 && x <= fx1 && z >= fz0 && z <= fz1;
  const cx = (fx0 + fx1) / 2, cz = (fz0 + fz1) / 2;
  const hx = (W - 1) / 2, hz = (D - 1) / 2;
  const sgnBit = (v: number, pos: number, neg: number) => (v > EPS ? pos : v < -EPS ? neg : 0);
  const xBit = (x: number) => sgnBit(cx - x, DE, DW);
  const zBit = (z: number) => sgnBit(cz - z, DS, DN);
  const halves = (h: number) => Math.round(2 * h + EPS);

  // profile: surface height (blocks) of a cell at distance d from the footprint edge (d=0 on the edge row)
  const halfSpan = axis === 'x' ? hz : hx;
  const profile = (d: number, half: number): number => {
    const s = d + 1;
    if (style === 'gambrel') {
      const knee = Math.max(1, Math.round(half * 0.4));
      return s <= knee ? 2 * pitch * s : 2 * pitch * knee + 0.5 * pitch * (s - knee);
    }
    if (style === 'mansard') {
      const knee = Math.max(1, Math.round(half * 0.35));
      return s <= knee ? 3 * pitch * s : 3 * pitch * knee + 0.5 * pitch * (s - knee);
    }
    return pitch * s;
  };
  let closedAll = false; // outside neighbours in every direction count as ground (dome)

  if (style === 'flat') {
    for (let z = Z0; z <= Z1; z++)
      for (let x = X0; x <= X1; x++) {
        const i = idx(x, z);
        if (inFoot(x, z)) { T[i] = 2; U[i] = 0; }
        else {
          // cornice ring: top-half stairs facing the building
          const dxe = Math.min(x - fx0, fx1 - x), dze = Math.min(z - fz0, fz1 - z);
          let u = 0;
          if (dxe <= dze) u |= xBit(x);
          if (dze <= dxe) u |= zBit(z);
          T[i] = 2;
          U[i] = u;
        }
      }
  } else if (style === 'gable' || style === 'gambrel' || style === 'shed') {
    for (let z = Z0; z <= Z1; z++)
      for (let x = X0; x <= X1; x++) {
        const i = idx(x, z);
        let d: number, u: number;
        if (style === 'shed') {
          const asc = p.facing ?? (axis === 'x' ? 'north' : 'west');
          if (axis === 'x' && asc !== 'north' && asc !== 'south') throw new Error('roof: shed facing must be north/south for axis x');
          if (axis === 'z' && asc !== 'east' && asc !== 'west') throw new Error('roof: shed facing must be east/west for axis z');
          d = asc === 'north' ? fz1 - z : asc === 'south' ? z - fz0 : asc === 'east' ? x - fx0 : fx1 - x;
          u = asc === 'north' ? DN : asc === 'south' ? DS : asc === 'east' ? DE : DW;
          T[i] = halves(profile(d, halfSpan));
          U[i] = u;
          continue;
        }
        if (axis === 'x') { d = Math.min(z - fz0, fz1 - z); u = zBit(z); }
        else { d = Math.min(x - fx0, fx1 - x); u = xBit(x); }
        T[i] = u ? halves(profile(d, halfSpan)) : halves(profile(d - 1, halfSpan)) + 1;
        U[i] = u;
      }
  } else if (style === 'hip' || style === 'mansard' || style === 'pyramid' || style === 'spire') {
    const scaled = style === 'pyramid' || style === 'spire';
    const hmin = Math.min(hx, hz);
    for (let z = Z0; z <= Z1; z++)
      for (let x = X0; x <= X1; x++) {
        const i = idx(x, z);
        let dxe = Math.min(x - fx0, fx1 - x), dze = Math.min(z - fz0, fz1 - z);
        if (scaled && hmin > 0) {
          // stretch the shorter axis so all four slopes meet in one apex
          dxe = hx > 0 ? ((dxe + 0.5) * (hmin + 0.5)) / (hx + 0.5) - 0.5 : dxe;
          dze = hz > 0 ? ((dze + 0.5) * (hmin + 0.5)) / (hz + 0.5) - 0.5 : dze;
        }
        const d = Math.min(dxe, dze);
        let u = 0;
        let cap = false;
        if (Math.abs(dxe - dze) < 1e-6) {
          const a = xBit(x), c = zBit(z);
          if (a && c) u = a | c;
          else cap = true;
        } else if (dxe < dze) {
          u = xBit(x);
          cap = !u;
        } else {
          u = zBit(z);
          cap = !u;
        }
        T[i] = cap ? halves(profile(d - 1, hmin)) + 1 : halves(profile(d, hmin));
        U[i] = u;
      }
  } else if (style === 'dome') {
    closedAll = true;
    const ax = hx + 0.5 + o, az = hz + 0.5 + o;
    const Hd = pitch * Math.min(ax, az);
    for (let z = Z0; z <= Z1; z++)
      for (let x = X0; x <= X1; x++) {
        const nx = (x - cx) / ax, nz = (z - cz) / az;
        const rho2 = nx * nx + nz * nz;
        if (rho2 > 1 + EPS) continue;
        const i = idx(x, z);
        // whole-block steps read cleaner on curved surfaces than a slab/stairs mix
        T[i] = 2 * Math.max(1, Math.round(Hd * Math.sqrt(Math.max(0, 1 - rho2)) + 0.5));
        const anx = Math.abs(nx), anz = Math.abs(nz);
        let u = 0;
        if (anx >= anz - 1e-6) u |= xBit(x);
        if (anz >= anx - 1e-6) u |= zBit(z);
        U[i] = u;
      }
  }

  // --- pieces --------------------------------------------------------------------------
  const has = (x: number, z: number) => x >= X0 && x <= X1 && z >= Z0 && z <= Z1 && T[idx(x, z)] !== NONE;
  type Piece = { kind: 'stairs'; facing: Dir4; half: 'bottom' | 'top' } | { kind: 'slab' } | { kind: 'full' };
  const piece = new Array<Piece | null>(NX * NZ).fill(null);
  for (let z = Z0; z <= Z1; z++)
    for (let x = X0; x <= X1; x++) {
      const i = idx(x, z);
      const t = T[i];
      if (t === NONE) continue;
      if (style === 'flat') {
        piece[i] = U[i] ? { kind: 'stairs', facing: pickFacing(U[i]), half: 'top' } : { kind: 'full' };
        continue;
      }
      if (t & 1) {
        piece[i] = mats.slab ? { kind: 'slab' } : { kind: 'full' };
        continue;
      }
      let u = U[i];
      if (style === 'dome' && u) {
        // dome directions are snapped from a radial gradient: only face uphill where the neighbour really is higher
        let ok = 0;
        for (const [bit, , dx, dz] of DIR_BITS) if (u & bit && has(x + dx, z + dz) && T[idx(x + dx, z + dz)] > t) ok |= bit;
        if (!ok && (u & (DN | DS)) && (u & (DE | DW))) {
          const ddx = u & DE ? 1 : -1, ddz = u & DS ? 1 : -1;
          if (has(x + ddx, z + ddz) && T[idx(x + ddx, z + ddz)] > t) ok = u;
        }
        u = ok;
      }
      piece[i] = u ? { kind: 'stairs', facing: pickFacing(u), half: 'bottom' } : { kind: 'full' };
    }

  // --- assemble states --------------------------------------------------------------------
  const out = new Map<number, { x: number; y: number; z: number; st: string | Piece }>();
  const yKey = (x: number, y: number, z: number) => ((y + 4096) * (NZ + 2) + (z - Z0 + 1)) * (NX + 2) + (x - X0 + 1);
  const put = (x: number, y: number, z: number, st: string | Piece) => out.set(yKey(x, y, z), { x, y, z, st });
  const yTopOf = (t: number) => Math.floor((t - 1) / 2);
  for (let z = Z0; z <= Z1; z++)
    for (let x = X0; x <= X1; x++) {
      const i = idx(x, z);
      const t = T[i];
      const pc = piece[i];
      if (t === NONE || !pc) continue;
      const yTop = yTopOf(t);
      put(x, y0 + yTop, z, pc);
      // backing: solid from the lowest lower neighbour's surface up to the top piece
      let low = t;
      for (const [bit, , dx, dz] of DIR_BITS) {
        if (has(x + dx, z + dz)) {
          const tn = T[idx(x + dx, z + dz)];
          if (tn < low) low = tn;
        } else if (style !== 'flat' && inFoot(x, z) && (closedAll || U[i] & OPP_BIT[bit])) {
          // footprint edge without overhang: the downhill side rests on the wall top (T = 0)
          if (0 < low) low = 0;
        }
      }
      const yLow = Math.floor(low / 2);
      for (let y = yLow; y < yTop; y++) put(x, y0 + y, z, { kind: 'full' });
      let bottom = Math.min(yLow, yTop);
      // gable end walls
      if (endsState && inFoot(x, z) && (style === 'gable' || style === 'gambrel' || style === 'shed')) {
        const isEnd = axis === 'x' ? x === fx0 || x === fx1 : z === fz0 || z === fz1;
        if (isEnd) {
          for (let y = 0; y < bottom; y++) put(x, y0 + y, z, endsState);
          bottom = 0;
        }
      }
      if (fillState && inFoot(x, z)) for (let y = 0; y < bottom; y++) put(x, y0 + y, z, fillState);
    }

  // stairs shapes (vanilla getStairsShape on the generated pieces)
  const stairAt = (x: number, y: number, z: number): StairInfo | null => {
    if (x < X0 - 1 || x > X1 + 1 || z < Z0 - 1 || z > Z1 + 1) return null;
    const e = out.get(yKey(x, y, z));
    if (!e || typeof e.st === 'string' || e.st.kind !== 'stairs') return null;
    return { facing: e.st.facing, half: e.st.half };
  };
  const stairsCache = new Map<string, string>();
  const stairsState = (facing: Dir4, half: string, shape: string) => {
    const k = facing + half + shape;
    let s = stairsCache.get(k);
    if (!s) {
      s = reg.canonical(`${mats.stairs}[facing=${facing},half=${half},shape=${shape}]`);
      stairsCache.set(k, s);
    }
    return s;
  };
  const slabState = mats.slab ? reg.canonical(`${mats.slab}[type=bottom]`) : mats.full;
  const entries = [...out.values()].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
  for (const e of entries) {
    const st = e.st;
    if (typeof st === 'string') emit(e.x, e.y, e.z, st);
    else if (st.kind === 'full') emit(e.x, e.y, e.z, mats.full);
    else if (st.kind === 'slab') emit(e.x, e.y, e.z, slabState);
    else emit(e.x, e.y, e.z, stairsState(st.facing, st.half, stairsShapeFor(e.x, e.y, e.z, st.facing, st.half, stairAt)));
  }
}

/** pinwheel corner rule: of two uphill bits pick the one whose CCW neighbour is the other (→ outer_left) */
function pickFacing(u: number): Dir4 {
  const bits = [DN, DE, DS, DW].filter((b) => u & b);
  if (bits.length === 1) return bitDir(bits[0]);
  for (const b of bits) if (u & CCW_BIT[b]) return bitDir(b);
  return bitDir(bits[0]);
}
