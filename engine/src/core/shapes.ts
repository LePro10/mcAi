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


export type RoofStyle =
  | 'gable' | 'hip' | 'pyramid' | 'shed' | 'dome' | 'spire' | 'mansard' | 'gambrel' | 'flat' | 'cone' | 'swept_hip';
export const ROOF_STYLES: readonly RoofStyle[] = ['gable', 'hip', 'pyramid', 'shed', 'dome', 'spire', 'mansard', 'gambrel', 'flat', 'cone', 'swept_hip'];

export interface RoofParams {
  /** footprint x/z (usually the outer wall footprint); base y = box.min.y = first roof layer on top of the walls */
  box: Box;
  style: RoofStyle;
  /** ridge direction for gable/gambrel/shed (default: the longer side) */
  axis?: 'x' | 'z';
  stairs: string;
  slab?: string;
  /** solid fill under the roof surface (inside the footprint): a block id, or true = the full block matching the stairs */
  fill?: string | boolean;
  /** gable/gambrel/shed: block for the two end walls (gable triangles) under the roof */
  ends?: string;
  /** eaves beyond the footprint on every side (default 1; dome 0; swept_hip 2). The slope continues downward. */
  overhang?: number;
  /** rise per horizontal block (default 1; shed 0.5; spire 3; cone 1.6; dome 1 = hemisphere) */
  pitch?: number;
  /** shed only: direction the roof rises toward (default north for axis x, west for axis z) */
  facing?: Facing;
  /** round footprint (ellipse inscribed in the box): dome (default true), spire (default false); cone is always round */
  round?: boolean;
  /** cone / round spire: number of eave (overhang) rings laid at a shallower kick slope (default cone 1, spire 0; at most overhang) */
  flare?: number;
  /** swept_hip: concavity exponent of the slope profile (steep at the ridge, flat at the eaves), default 1.8 */
  sweep?: number;
  /** swept_hip: how many blocks the eave corners curl up (default 1, 0 = none) */
  lift?: number;
  /** x/z region left open (no roof inside) — stack tiers: the lower tier's roof skips the upper tier's walls */
  skipBox?: Box;
  /** continuous ring under the eaves along the walls: true = upside-down roof stairs facing the wall, or a block id */
  soffit?: string | boolean;
  /** rim board under the outer eave edge: true = matching top slab, or a block id (stairs → upside-down, facing in) */
  fascia?: string | boolean;
  /** brackets under the eaves at the wall line every `bracketEvery` blocks: true = upside-down roof stairs, or a block id */
  brackets?: string | boolean;
  /** spacing of brackets along the walls (default 2) */
  bracketEvery?: number;
  /** ornament on the apex/ridge ends: true = matching wall/fence post + lightning rod, a block id, or a list (bottom → top) */
  finial?: string | string[] | boolean;
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
const BIT_OF: Record<Dir4, number> = { north: DN, east: DE, south: DS, west: DW };

function bitDir(b: number): Dir4 {
  return b === DN ? 'north' : b === DE ? 'east' : b === DS ? 'south' : 'west';
}
const popcount4 = (u: number) => (u & 1) + ((u >> 1) & 1) + ((u >> 2) & 1) + ((u >> 3) & 1);

function typeName(v: unknown): string {
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
}
function roofError(msg: string): never {
  throw new RegistryError(`roof: ${msg}`);
}

/** derive the full block / slab that match a stairs block */
export function roofMaterials(reg: Registry, stairs: string, slab?: string): { stairs: string; slab: string | null; full: string } {
  if (typeof stairs !== 'string' || !stairs.trim()) roofError(`stairs must be a stairs block id (e.g. "spruce_stairs"), got ${typeName(stairs)}`);
  if (slab !== undefined && typeof slab !== 'string') roofError(`slab must be a slab block id, got ${typeName(slab)}`);
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
    base + '_planks',
    base + 's',
    base + '_block',
    base.replace(/_brick$/, '_bricks'),
    base.replace(/_tile$/, '_tiles'),
    base.replace(/^(.*)_(\w+)$/, '$1_$2s'),
  ];
  let full: string | null = null;
  for (const c of cands) {
    if (!reg.has(c) || /_(stairs|slab)$/.test(c)) continue;
    const cs = reg.canonical(c);
    if (reg.isFullSolid(cs)) { full = cs; break; }
  }
  if (!full) full = slabId ? reg.canonical(`${slabId}[type=double]`) : reg.canonical(`${sid}[half=top]`);
  return { stairs: sid, slab: slabId, full };
}

const DEFAULT_PITCH: Record<RoofStyle, number> = {
  gable: 1, hip: 1, pyramid: 1, shed: 0.5, dome: 1, spire: 3, mansard: 1, gambrel: 1, flat: 0, cone: 2, swept_hip: 1,
};

// ------------------------------------------------------------------ parameter validation

function vNum(p: Record<string, unknown>, k: string, lo: number, hi: number): number | undefined {
  const v = p[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) roofError(`${k} must be a number, got ${typeName(v)}`);
  if (v < lo || v > hi) roofError(`${k} must be between ${lo} and ${hi}, got ${v}`);
  return v;
}
function vBool(p: Record<string, unknown>, k: string): boolean | undefined {
  const v = p[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') roofError(`${k} must be true or false, got ${typeName(v)}`);
  return v;
}
function vBlockOrTrue(p: Record<string, unknown>, k: string): string | true | undefined {
  const v = p[k];
  if (v === undefined || v === null || v === false) return undefined;
  if (v === true) return true;
  if (typeof v !== 'string' || !v.trim()) roofError(`${k} must be true or a block id, got ${typeName(v)}`);
  return v;
}
function vVec(v: unknown, what: string): Vec3 {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => typeof n === 'number' && Number.isFinite(n)))
    roofError(`${what} must be [x,y,z] with 3 numbers, got ${JSON.stringify(v)?.slice(0, 60) ?? typeName(v)}`);
  return [Math.round(v[0]), Math.round(v[1]), Math.round(v[2])];
}
function vBox(v: unknown, k: string): Box {
  if (Array.isArray(v) && v.length === 2) return nb({ min: vVec(v[0], `${k}[0]`), max: vVec(v[1], `${k}[1]`) });
  if (!v || typeof v !== 'object') roofError(`${k} must be {min:[x,y,z],max:[x,y,z]}, got ${typeName(v)}`);
  const o = v as { min?: unknown; max?: unknown };
  return nb({ min: vVec(o.min, `${k}.min`), max: vVec(o.max, `${k}.max`) });
}

/** Validate roof params (types, ranges, style-specific combinations) with agent-readable errors. */
export function validateRoofParams(p: RoofParams): void {
  if (!p || typeof p !== 'object') roofError(`parameters must be an object, got ${typeName(p)}`);
  const r = p as unknown as Record<string, unknown>;
  if (typeof r.style !== 'string' || !(ROOF_STYLES as readonly string[]).includes(r.style))
    roofError(`unknown style "${String(r.style)}" (${ROOF_STYLES.join('|')})`);
  if (r.box === undefined) roofError('needs "box" (the wall footprint; min.y = first roof layer)');
  vBox(r.box, 'box');
  if (r.skipBox !== undefined) vBox(r.skipBox, 'skipBox');
  for (const k of ['stairs', 'slab', 'ends', 'axis', 'facing'] as const) {
    if (r[k] !== undefined && typeof r[k] !== 'string') roofError(`${k} must be a string, got ${typeName(r[k])}`);
  }
  if (r.stairs === undefined) roofError('needs "stairs" (e.g. "dark_oak_stairs")');
  if (r.axis !== undefined && r.axis !== 'x' && r.axis !== 'z') roofError(`axis must be "x" or "z", got "${r.axis}"`);
  if (r.facing !== undefined && !['north', 'south', 'east', 'west'].includes(r.facing as string)) roofError(`facing must be north|south|east|west, got "${r.facing}"`);
  vNum(r, 'overhang', 0, 16);
  vNum(r, 'pitch', 0, 16);
  vNum(r, 'flare', 0, 16);
  vNum(r, 'sweep', 0.2, 6);
  vNum(r, 'lift', 0, 6);
  vNum(r, 'bracketEvery', 1, 64);
  vBool(r, 'round');
  for (const k of ['fill', 'soffit', 'fascia', 'brackets']) vBlockOrTrue(r, k);
  const f = r.finial;
  if (f !== undefined && f !== null && f !== false && f !== true && typeof f !== 'string' && !(Array.isArray(f) && f.length > 0 && f.every((s) => typeof s === 'string')))
    roofError(`finial must be true, a block id or a list of block ids, got ${typeName(f)}`);
  if (r.round === true && !['dome', 'spire', 'cone'].includes(r.style as string)) roofError(`round is only supported for dome, spire and cone (got style "${r.style}")`);
  if (r.round === false && r.style === 'cone') roofError('cone is always round (use spire or pyramid for a square footprint)');
}

/**
 * Roof generator producing proper stairs states. Heights are computed on a half-block grid:
 * odd half-heights become bottom slabs, even ones stairs facing uphill (toward the ridge) with
 * vanilla-consistent inner/outer corner shapes; steep parts are backed by full blocks so the
 * surface has no see-through gaps; 1-wide ridges and apexes get a slab cap.
 * Round styles (cone, round spire, dome) derive each stair's facing from its higher neighbours
 * so rings read as smooth circles with inner/outer corners at the steps.
 */
export function roof(p: RoofParams, reg: Registry, emit: StateSink): void {
  validateRoofParams(p);
  const style = p.style;
  const round = style === 'cone' || (p.round ?? style === 'dome');
  const mats = roofMaterials(reg, p.stairs, p.slab);
  const fillState = p.fill === true ? mats.full : typeof p.fill === 'string' ? reg.canonical(p.fill) : null;
  const endsState = p.ends ? reg.canonical(p.ends) : null;
  const b = vBox(p.box, 'box');
  const [fx0, y0, fz0] = b.min;
  const [fx1, , fz1] = b.max;
  const o = Math.max(0, Math.round(p.overhang ?? (style === 'dome' ? 0 : style === 'swept_hip' ? 2 : 1)));
  const pitch = p.pitch ?? DEFAULT_PITCH[style];
  const X0 = fx0 - o, X1 = fx1 + o, Z0 = fz0 - o, Z1 = fz1 + o;
  const NX = X1 - X0 + 1, NZ = Z1 - Z0 + 1;
  if (NX * NZ > 4_000_000) roofError(`footprint ${NX}x${NZ} is too large (max 2000x2000)`);
  const W = fx1 - fx0 + 1, D = fz1 - fz0 + 1;
  const axis = p.axis ?? (W >= D ? 'x' : 'z');
  const idx = (x: number, z: number) => (z - Z0) * NX + (x - X0);
  const NONE = -0x7fffffff;
  const T = new Int32Array(NX * NZ).fill(NONE); // half-block top surface, relative to y0
  const U = new Uint8Array(NX * NZ); // uphill direction bits
  const cx = (fx0 + fx1) / 2, cz = (fz0 + fz1) / 2;
  const hx = (W - 1) / 2, hz = (D - 1) / 2;
  const inRect = (x: number, z: number) => x >= fx0 && x <= fx1 && z >= fz0 && z <= fz1;
  // wall footprint: the rectangle, or the inscribed ellipse for round roofs (= a cylinder of the same box)
  const inFoot = round
    ? (x: number, z: number) => {
        const nx = (x - cx) / (hx + 0.5), nz = (z - cz) / (hz + 0.5);
        return nx * nx + nz * nz <= 1 + EPS;
      }
    : inRect;
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
  let closedAll = false; // outside neighbours in every direction count as ground (round roofs)
  let neighbourFacing = false; // facings from the actual height field (round roofs)

  if (style === 'flat') {
    for (let z = Z0; z <= Z1; z++)
      for (let x = X0; x <= X1; x++) {
        const i = idx(x, z);
        if (inRect(x, z)) { T[i] = 2; U[i] = 0; }
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
  } else if (round && style !== 'dome') {
    // cone / round spire, built like a circle chart: integer rings m = 0 (on the wall) … centre, each
    // a clean rasterized annulus of the same circle family as cylinder(); every cell of a ring has the
    // same height, rings never get lower or wider going up. pitch ≥ 1: ring m tops out at layer
    // ceil((m+1)·pitch) − 1 (2 = every ring a stair on a full block); pitch < 1: half-block (slab) rings.
    closedAll = true;
    neighbourFacing = true;
    const ex = hx + 0.5, ez = hz + 0.5, Rt = Math.min(ex, ez);
    const sOf = (x: number, z: number) => Rt * (1 - Math.hypot((x - cx) / ex, (z - cz) / ez));
    const ringTop = (m: number) => (pitch >= 1 ? 2 + 2 * (Math.ceil((m + 1) * pitch - EPS) - 1) : 2 + Math.floor(2 * pitch * m + EPS));
    // eave rings: the first `flare` overhang rings kick out at a shallower slope (half a block per ring)
    const F = Math.min(o, Math.round(p.flare ?? (style === 'cone' ? 1 : 0)));
    // (further overhang rings step down one block each, also under steep spires: no hanging skirts)
    const kick = 1, drop = 2;
    for (let z = Z0; z <= Z1; z++)
      for (let x = X0; x <= X1; x++) {
        const s = sOf(x, z);
        if (s >= -EPS) T[idx(x, z)] = ringTop(Math.floor(s + EPS));
        else {
          const j = Math.ceil(-s - EPS);
          if (j > o) continue;
          T[idx(x, z)] = 2 - (j <= F ? kick * j : kick * F + drop * (j - F));
        }
      }
  } else if (round) {
    // round dome: radial profile over the ellipse inscribed in box + overhang
    closedAll = true;
    neighbourFacing = true;
    const ax = hx + 0.5 + o, az = hz + 0.5 + o;
    const amin = Math.min(ax, az);
    const Hc = pitch * amin;
    const prof = (rho: number) => Math.sqrt(Math.max(0, 1 - rho * rho));
    const rhoOf = (x: number, z: number) => Math.hypot((x - cx) / ax, (z - cz) / az);
    // Quantize into concentric rings (like a builder stacking circles): every cell of a ring gets the
    // same height, so a ring never mixes slabs and stairs. ring 0 = outer rim.
    const ringOf = (rho: number) => Math.max(0, Math.floor((1 - rho) * amin + EPS));
    const kMax = ringOf(0);
    const ringT = new Int32Array(kMax + 1);
    const rimH = Hc * prof(Math.max(0, 1 - 0.5 / amin));
    for (let k = 0; k <= kMax; k++) ringT[k] = halves(Hc * prof(Math.max(0, 1 - (k + 0.5) / amin)) - rimH);
    for (let k = 1; k <= kMax; k++) {
      if (ringT[k] < ringT[k - 1]) ringT[k] = ringT[k - 1];
      // slab rings only on gentle parts (half-block steps); steeper rings are whole stairs steps
      if (ringT[k] - ringT[k - 1] >= 2 && ringT[k] & 1) ringT[k] -= 1;
    }
    // the tip rises at most one block above the ring below it (no needle columns)
    if (kMax >= 1) ringT[kMax] = Math.min(ringT[kMax], ringT[kMax - 1] + 2);
    // the lowest footprint ring sits on the wall top (T = 2); each overhang ring drops at most one block
    let lowFoot = Infinity;
    for (let z = fz0; z <= fz1; z++) for (let x = fx0; x <= fx1; x++) if (inFoot(x, z)) lowFoot = Math.min(lowFoot, ringT[ringOf(rhoOf(x, z))]);
    const base = 2 - (Number.isFinite(lowFoot) ? lowFoot : 0);
    for (let z = Z0; z <= Z1; z++)
      for (let x = X0; x <= X1; x++) {
        const rho = rhoOf(x, z);
        if (rho > 1 + EPS) continue;
        T[idx(x, z)] = Math.max(2 - 2 * o, base + ringT[ringOf(rho)]);
      }
  } else if (style === 'dome') {
    // square dome (round: false): super-ellipse profile that covers the whole rectangle
    closedAll = true;
    neighbourFacing = true;
    const ax = hx + 0.5 + o, az = hz + 0.5 + o;
    const Hd = pitch * Math.min(ax, az);
    const se = (x: number, z: number) => Math.min(1, Math.pow(Math.pow(Math.abs((x - cx) / ax), 4) + Math.pow(Math.abs((z - cz) / az), 4), 0.25));
    const hd = (x: number, z: number) => halves(Hd * Math.sqrt(Math.max(0, 1 - se(x, z) ** 2)));
    const base = 2 - Math.min(hd(fx0, fz0), hd(fx0, cz), hd(cx, fz0));
    for (let z = Z0; z <= Z1; z++) for (let x = X0; x <= X1; x++) T[idx(x, z)] = Math.max(2 - 2 * o, base + hd(x, z));
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
  } else if (style === 'swept_hip') {
    // concave hip: gentle (≥ half a block per block) at the eaves, steep at the ridge; eave corners curl up
    const Ex = (NX - 1) / 2, Ez = (NZ - 1) / 2, Emax = Math.min(Ex, Ez);
    const sweep = p.sweep ?? 1.8, lift = p.lift ?? 1;
    const H = pitch * (Emax + 0.5);
    const minSlope = Emax > 0 ? Math.min(0.5, H / Emax) : 0;
    const hOf = (e: number) => (Emax > 0 ? minSlope * e + (H - minSlope * Emax) * Math.pow(e / Emax, sweep) : H);
    // lift (half blocks) by distance s from the hip line, fading out toward the ridge: changes ≤ 1 half block
    // per cell, so the eave corners curl up in slab/stairs flicks (no hanging columns)
    const span = Math.max(3, 4 * lift);
    const liftH = (s: number, e: number) =>
      Math.round(2 * lift * Math.pow(Math.max(0, 1 - s / span), 2) * (Emax > 0 ? Math.pow(Math.max(0, 1 - e / (Emax + 0.5)), 3) : 0));
    // one height per hip ring (e = rings from the eave rim); slab rings only where the slope is gentle
    const eMax = Math.floor(Emax + EPS);
    const ringT = new Int32Array(eMax + 2);
    for (let e = 1; e <= eMax + 1; e++) {
      let t = Math.max(ringT[e - 1], halves(hOf(e) - hOf(0)));
      if (t - ringT[e - 1] >= 2 && t & 1) t -= 1;
      ringT[e] = t;
    }
    const base = 2 - ringT[Math.min(o, eMax)];
    const cap = new Uint8Array(NX * NZ);
    for (let z = Z0; z <= Z1; z++)
      for (let x = X0; x <= X1; x++) {
        const i = idx(x, z);
        const exd = Math.min(x - X0, X1 - x), ezd = Math.min(z - Z0, Z1 - z);
        const e = Math.min(exd, ezd);
        const s = Math.abs(exd - ezd);
        let u = 0;
        if (Math.abs(exd - ezd) < 1e-6) {
          const a = xBit(x), c = zBit(z);
          if (a && c) u = a | c;
          else cap[i] = 1;
        } else if (exd < ezd) {
          u = xBit(x);
          if (!u) cap[i] = 1;
        } else {
          u = zBit(z);
          if (!u) cap[i] = 1;
        }
        T[i] = base + ringT[Math.min(e, eMax + 1)] + liftH(s, e);
        U[i] = u;
      }
    // ridge caps: half a block above the highest slope next to them (no full-block ridge walls)
    for (let z = Z0; z <= Z1; z++)
      for (let x = X0; x <= X1; x++) {
        const i = idx(x, z);
        if (!cap[i]) continue;
        let m = NONE;
        for (const [, , dx, dz] of DIR_BITS) {
          const xx = x + dx, zz = z + dz;
          if (xx < X0 || xx > X1 || zz < Z0 || zz > Z1) continue;
          const j = idx(xx, zz);
          if (!cap[j] && T[j] > m) m = T[j];
        }
        if (m !== NONE && T[i] > m + 1) T[i] = m + 1;
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
  }

  const inGrid = (x: number, z: number) => x >= X0 && x <= X1 && z >= Z0 && z <= Z1;
  const has = (x: number, z: number) => inGrid(x, z) && T[idx(x, z)] !== NONE;

  // --- facings from the height field (round roofs) -------------------------------------
  if (neighbourFacing) {
    const ax = hx + 0.5 + o, az = hz + 0.5 + o;
    const apex = new Uint8Array(NX * NZ);
    const concave: number[] = [];
    for (let z = Z0; z <= Z1; z++)
      for (let x = X0; x <= X1; x++) {
        const i = idx(x, z);
        const t = T[i];
        if (t === NONE) continue;
        const gx = (cx - x) / ax, gz = (cz - z) / az;
        const score = (bit: number) => (bit === DE ? gx : bit === DW ? -gx : bit === DS ? gz : -gz);
        let geo = 0;
        const agx = Math.abs(gx), agz = Math.abs(gz);
        if (agx > agz * 0.4142 + EPS) geo |= gx > 0 ? DE : DW;
        if (agz > agx * 0.4142 + EPS) geo |= gz > 0 ? DS : DN;
        let hb = 0;
        for (const [bit, , dx, dz] of DIR_BITS) if (has(x + dx, z + dz) && T[idx(x + dx, z + dz)] > t) hb |= bit;
        let u = 0;
        if (!hb) {
          let diag = false;
          for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) if (has(x + dx, z + dz) && T[idx(x + dx, z + dz)] > t) diag = true;
          if (diag) u = geo;
          else apex[i] = 1;
        } else if (popcount4(hb) === 1) u = hb;
        else {
          const c = hb & geo;
          if (popcount4(c) === 1) u = c;
          else {
            // concave notch (two higher sides): one facing; vanilla turns it into an inner corner
            const pool = c || hb;
            let best = 0, bs = -Infinity;
            for (const [bit] of DIR_BITS) if (pool & bit && score(bit) > bs) { bs = score(bit); best = bit; }
            u = best;
          }
        }
        U[i] = u;
        if (popcount4(hb) >= 2) concave.push(i, hb);
      }
    // concave corners (two higher sides): vanilla only gives an inner stair if the cell in front (downhill)
    // is a same-level stairs facing across; otherwise a straight stair would leave a notch → full block
    for (let n = 0; n < concave.length; n += 2) {
      const i = concave[n], hb = concave[n + 1];
      const x = X0 + (i % NX), z = Z0 + Math.floor(i / NX);
      let pick = -1;
      for (const [bit, , dx, dz] of DIR_BITS) {
        if (!(hb & bit) || !has(x - dx, z - dz)) continue;
        const f = idx(x - dx, z - dz);
        if (T[f] !== T[i] || !U[f]) continue;
        const ff = BIT_OF[pickFacing(U[f])];
        if (ff !== bit && ff !== OPP_BIT[bit] && (pick < 0 || bit === U[i])) pick = bit;
      }
      U[i] = pick > 0 ? pick : 0;
    }
    // apexes end in a slab cap at most one block above the ring below (no full-block spike) unless a
    // finial sits on them
    for (let i = 0; i < T.length; i++) {
      if (!apex[i]) continue;
      const x = X0 + (i % NX), z = Z0 + Math.floor(i / NX);
      let nb = NONE;
      for (const [, , dx, dz] of DIR_BITS) if (has(x + dx, z + dz) && T[idx(x + dx, z + dz)] < T[i]) nb = Math.max(nb, T[idx(x + dx, z + dz)]);
      if (nb !== NONE && T[i] > nb + 2) T[i] = nb + 2 + (T[i] & 1);
      if (mats.slab && !p.finial && !(T[i] & 1)) T[i] -= 1;
    }
  }

  // --- skipBox: leave the inner footprint open (stacked tiers) ---------------------------
  let skipped: (x: number, z: number) => boolean = () => false;
  if (p.skipBox !== undefined) {
    const sb = vBox(p.skipBox, 'skipBox');
    skipped = (x, z) => x >= sb.min[0] && x <= sb.max[0] && z >= sb.min[2] && z <= sb.max[2];
    for (let z = Math.max(Z0, sb.min[2]); z <= Math.min(Z1, sb.max[2]); z++)
      for (let x = Math.max(X0, sb.min[0]); x <= Math.min(X1, sb.max[0]); x++) T[idx(x, z)] = NONE;
  }

  // --- pieces --------------------------------------------------------------------------
  type Piece = { kind: 'stairs'; facing: Dir4; half: 'bottom' | 'top'; mat?: string } | { kind: 'slab' } | { kind: 'full' };
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
      const u = U[i];
      piece[i] = u ? { kind: 'stairs', facing: pickFacing(u), half: 'bottom' } : { kind: 'full' };
    }

  // --- assemble states --------------------------------------------------------------------
  const out = new Map<number, { x: number; y: number; z: number; st: string | Piece }>();
  const yKey = (x: number, y: number, z: number) => ((y + 4096) * (NZ + 4) + (z - Z0 + 2)) * (NX + 4) + (x - X0 + 2);
  const put = (x: number, y: number, z: number, st: string | Piece) => out.set(yKey(x, y, z), { x, y, z, st });
  const yTopOf = (t: number) => Math.floor((t - 1) / 2);
  const colBottom = new Int32Array(NX * NZ).fill(NONE);
  // pass 1: top pieces, so the backing pass knows the final stairs shapes of the neighbours
  for (let z = Z0; z <= Z1; z++)
    for (let x = X0; x <= X1; x++) {
      const i = idx(x, z);
      if (T[i] !== NONE && piece[i]) put(x, y0 + yTopOf(T[i]), z, piece[i]!);
    }
  const stairAt = (x: number, y: number, z: number): StairInfo | null => {
    if (x < X0 - 2 || x > X1 + 2 || z < Z0 - 2 || z > Z1 + 2) return null;
    const e = out.get(yKey(x, y, z));
    if (!e || typeof e.st === 'string' || e.st.kind !== 'stairs') return null;
    return { facing: e.st.facing, half: e.st.half };
  };
  /** does the top piece of column (nx,nz) close its whole face toward (x,z)? (else air under (x,z) would show through) */
  const closesToward = (nx: number, nz: number, bitToMe: number): boolean => {
    const pc = piece[idx(nx, nz)];
    if (!pc || pc.kind !== 'stairs' || pc.half !== 'bottom') return true;
    if (pc.facing !== bitDir(bitToMe)) return false;
    const y = y0 + yTopOf(T[idx(nx, nz)]);
    return !stairsShapeFor(nx, y, nz, pc.facing, pc.half, stairAt).startsWith('outer');
  };
  // pass 2: backing, end walls, fill
  for (let z = Z0; z <= Z1; z++)
    for (let x = X0; x <= X1; x++) {
      const i = idx(x, z);
      const t = T[i];
      const pc = piece[i];
      if (t === NONE || !pc) continue;
      const yTop = yTopOf(t);
      // backing: solid from the lowest lower neighbour's surface up to the top piece; inside the walls one
      // block deeper beside a lower stair that does not face this column (its open top quarter would let
      // you see into the attic)
      let low = t;
      let yLowExtra = Infinity;
      for (const [bit, , dx, dz] of DIR_BITS) {
        if (has(x + dx, z + dz)) {
          const tn = T[idx(x + dx, z + dz)];
          if (tn < low) low = tn;
          if (tn < t && !(tn & 1) && inFoot(x, z) && !closesToward(x + dx, z + dz, OPP_BIT[bit])) yLowExtra = Math.min(yLowExtra, Math.max(0, yTopOf(tn)));
        } else if (style !== 'flat' && inFoot(x, z) && !skipped(x + dx, z + dz) && (closedAll || U[i] & OPP_BIT[bit])) {
          // footprint edge without overhang: the downhill side rests on the wall top (T = 0)
          if (0 < low) low = 0;
        }
      }
      const yLow = Math.min(Math.floor(low / 2), yLowExtra);
      for (let y = yLow; y < yTop; y++) put(x, y0 + y, z, { kind: 'full' });
      let bottom = Math.min(yLow, yTop);
      colBottom[i] = y0 + bottom;
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

  // --- eave details: fascia (outer rim), soffit (ring along the walls), brackets ----------
  const underState = (spec: string | true, dflt: () => string, facingBits: number): string | Piece => {
    const s = spec === true ? dflt() : spec;
    const id = blockId(reg.canonical(s));
    const inf = reg.info(id)!;
    const explicit = s.includes('[');
    if (inf.properties.facing && inf.properties.half && inf.properties.shape && !explicit)
      return { kind: 'stairs', facing: pickFacing(facingBits || DN), half: 'top', mat: id };
    if (!explicit && inf.properties.type?.includes('top') && id.endsWith('_slab')) return reg.canonical(`${id}[type=top]`);
    if (!explicit && inf.properties.half?.includes('top') && id.endsWith('_trapdoor')) return reg.canonical(`${id}[half=top]`);
    return reg.canonical(s);
  };
  const outerRim = (x: number, z: number) => {
    for (const [, , dx, dz] of DIR_BITS) {
      const xx = x + dx, zz = z + dz;
      if (!inGrid(xx, zz)) return true;
      if (T[idx(xx, zz)] === NONE && !skipped(xx, zz)) return true;
    }
    return false;
  };
  const towardWall = (x: number, z: number) => {
    let u = 0;
    for (const [bit, , dx, dz] of DIR_BITS) if (inFoot(x + dx, z + dz)) u |= bit;
    return u;
  };
  const taken = (x: number, y: number, z: number) => out.has(yKey(x, y, z));
  if (o > 0 && (p.fascia || p.soffit || p.brackets)) {
    const fascia = p.fascia ? p.fascia : null;
    const soffit = p.soffit ? p.soffit : null;
    const brackets = p.brackets ? p.brackets : null;
    const every = Math.max(1, Math.round(p.bracketEvery ?? 2));
    const ring: [number, number, number][] = []; // overhang cells next to the wall: x, z, angle
    for (let z = Z0; z <= Z1; z++)
      for (let x = X0; x <= X1; x++) {
        const i = idx(x, z);
        if (T[i] === NONE || inFoot(x, z) || colBottom[i] === NONE) continue;
        const tw = towardWall(x, z);
        if (fascia && outerRim(x, z)) {
          const y = colBottom[i] - 1;
          if (!taken(x, y, z)) put(x, y, z, underState(fascia, () => (mats.slab ?? mats.stairs), U[i] || tw));
        }
        if (tw) ring.push([x, z, Math.atan2(z - cz, x - cx)]);
      }
    for (const [x, z] of ring) {
      const i = idx(x, z);
      const y = colBottom[i] - 1;
      if (soffit && !taken(x, y, z)) put(x, y, z, underState(soffit, () => mats.stairs, towardWall(x, z)));
    }
    if (brackets) {
      let pick: [number, number, number][];
      if (round) {
        ring.sort((a, c) => a[2] - c[2]);
        pick = ring.filter((_, k) => k % every === 0);
      } else {
        pick = ring.filter(([x, z]) => {
          const tw = towardWall(x, z);
          if (popcount4(tw) !== 1) return false;
          const along = tw & (DN | DS) ? x : z;
          const a0 = tw & (DN | DS) ? fx0 : fz0, a1 = tw & (DN | DS) ? fx1 : fz1;
          return (along - a0) % every === 0 || along === a1;
        });
      }
      for (const [x, z] of pick) {
        const i = idx(x, z);
        let y = colBottom[i] - 1;
        while (taken(x, y, z)) y--;
        put(x, y, z, underState(brackets, () => mats.stairs, towardWall(x, z)));
      }
    }
  }

  // --- finial on the apex / both ridge ends ----------------------------------------------
  if (p.finial) {
    // apex/ridge cells = cells without an uphill direction; the highest of them carry the finial
    let maxT = NONE;
    for (let i = 0; i < T.length; i++) if (T[i] !== NONE && !U[i] && T[i] > maxT) maxT = T[i];
    const tops: [number, number][] = [];
    for (let z = Z0; z <= Z1; z++) for (let x = X0; x <= X1; x++) if (maxT !== NONE && T[idx(x, z)] === maxT && !U[idx(x, z)]) tops.push([x, z]);
    let ax0 = Infinity, ax1 = -Infinity, az0 = Infinity, az1 = -Infinity;
    for (const [x, z] of tops) { ax0 = Math.min(ax0, x); ax1 = Math.max(ax1, x); az0 = Math.min(az0, z); az1 = Math.max(az1, z); }
    let spots: [number, number][] = [];
    if (tops.length === 1) spots = tops;
    else if (tops.length > 1 && (ax0 === ax1 || az0 === az1) && tops.length === ax1 - ax0 + az1 - az0 + 1) spots = [[ax0, az0], [ax1, az1]];
    else if (tops.length > 1) {
      // plateau (flat dome top): one finial on the cell nearest the plateau centre
      const mx = (ax0 + ax1) / 2, mz = (az0 + az1) / 2;
      spots = [tops.reduce((b, c) => (Math.hypot(c[0] - mx, c[1] - mz) < Math.hypot(b[0] - mx, b[1] - mz) ? c : b))];
    }
    let stack: string[];
    if (p.finial === true) {
      const base = mats.stairs.replace(/_stairs$/, '');
      const post = [base + '_wall', base.replace(/_tile$/, '_brick') + '_wall', base + '_fence', base.replace(/_planks$/, '') + '_fence'].find((c) => reg.has(c));
      stack = [...(post ? [post] : []), reg.has('minecraft:waxed_lightning_rod') ? 'minecraft:waxed_lightning_rod' : 'minecraft:end_rod'];
    } else stack = typeof p.finial === 'string' ? [p.finial] : p.finial;
    const states = stack.map((s) => reg.canonical(s));
    for (const [x, z] of spots) {
      const i = idx(x, z);
      const yTop = y0 + yTopOf(T[i]);
      // the apex piece becomes a full block so the finial does not float on a slab
      put(x, yTop, z, { kind: 'full' });
      states.forEach((s, k) => put(x, yTop + 1 + k, z, s));
    }
  }

  // stairs shapes (vanilla getStairsShape on the generated pieces)
  const stairsCache = new Map<string, string>();
  const stairsState = (mat: string, facing: Dir4, half: string, shape: string) => {
    const k = mat + facing + half + shape;
    let s = stairsCache.get(k);
    if (!s) {
      s = reg.canonical(`${mat}[facing=${facing},half=${half},shape=${shape}]`);
      stairsCache.set(k, s);
    }
    return s;
  };
  const slabState = mats.slab ? reg.canonical(`${mats.slab}[type=bottom]`) : mats.full;
  const entries = [...out.values()].sort((a, c) => a.y - c.y || a.z - c.z || a.x - c.x);
  for (const e of entries) {
    const st = e.st;
    if (typeof st === 'string') emit(e.x, e.y, e.z, st);
    else if (st.kind === 'full') emit(e.x, e.y, e.z, mats.full);
    else if (st.kind === 'slab') emit(e.x, e.y, e.z, slabState);
    else emit(e.x, e.y, e.z, stairsState(st.mat ?? mats.stairs, st.facing, st.half, stairsShapeFor(e.x, e.y, e.z, st.facing, st.half, stairAt)));
  }
}

/** pinwheel corner rule: of two uphill bits pick the one whose CCW neighbour is the other (→ outer_left) */
function pickFacing(u: number): Dir4 {
  const bits = [DN, DE, DS, DW].filter((b) => u & b);
  if (bits.length === 1) return bitDir(bits[0]);
  for (const b of bits) if (u & CCW_BIT[b]) return bitDir(b);
  return bitDir(bits[0]);
}
