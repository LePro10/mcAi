import type { Vec3 } from './types.js';

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const floorV = (a: Vec3): Vec3 => [Math.floor(a[0]), Math.floor(a[1]), Math.floor(a[2])];

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Rotate a horizontal offset about the Y axis. Angles are multiples of 90°.
 * The `+ 0` normalises negative zero, which would otherwise leak into
 * coordinates and comparisons.
 */
export function rotateY(p: Vec3, deg: 0 | 90 | 180 | 270): Vec3 {
  const [x, y, z] = p;
  switch (deg) {
    case 90: return [-z + 0, y, x];
    case 180: return [-x + 0, y, -z + 0];
    case 270: return [z, y, -x + 0];
    default: return [x, y, z];
  }
}

export const CARDINALS = ['north', 'east', 'south', 'west'] as const;
export type Cardinal = (typeof CARDINALS)[number];

/** Minecraft facings: north = -Z, south = +Z, east = +X, west = -X. */
export const FACING_VEC: Record<Cardinal, Vec3> = {
  north: [0, 0, -1],
  south: [0, 0, 1],
  east: [1, 0, 0],
  west: [-1, 0, 0],
};

export function rotateFacing(f: Cardinal, deg: 0 | 90 | 180 | 270): Cardinal {
  const i = CARDINALS.indexOf(f);
  if (i < 0) return f;
  return CARDINALS[(i + deg / 90) & 3];
}

export function oppositeFacing(f: Cardinal): Cardinal {
  return rotateFacing(f, 180);
}

/** Facing from a yaw in degrees, matching Minecraft's player rotation. */
export function facingFromYaw(yaw: number): Cardinal {
  const y = ((yaw % 360) + 360) % 360;
  if (y >= 315 || y < 45) return 'south';
  if (y < 135) return 'west';
  if (y < 225) return 'north';
  return 'east';
}

/** Rotation (deg) that turns a blueprint's default +Z front towards `facing`. */
export function rotationForFacing(f: Cardinal): 0 | 90 | 180 | 270 {
  switch (f) {
    case 'south': return 0;
    case 'west': return 90;
    case 'north': return 180;
    case 'east': return 270;
  }
}

export interface Bounds { min: Vec3; max: Vec3 }

export function boundsOf(points: Iterable<Vec3>): Bounds | null {
  let min: Vec3 | null = null;
  let max: Vec3 | null = null;
  for (const p of points) {
    if (!min || !max) { min = [...p] as Vec3; max = [...p] as Vec3; continue; }
    for (let i = 0; i < 3; i++) {
      if (p[i] < min[i]) min[i] = p[i];
      if (p[i] > max[i]) max[i] = p[i];
    }
  }
  return min && max ? { min, max } : null;
}

export function boundsVolume(b: Bounds): number {
  return (b.max[0] - b.min[0] + 1) * (b.max[1] - b.min[1] + 1) * (b.max[2] - b.min[2] + 1);
}

/** Normalise a size vector: at least 1 on every axis, integers. */
export function normSize(s: Vec3 | undefined, fallback: Vec3 = [1, 1, 1]): Vec3 {
  if (!s) return fallback;
  return [
    Math.max(1, Math.round(s[0] ?? 1)),
    Math.max(1, Math.round(s[1] ?? 1)),
    Math.max(1, Math.round(s[2] ?? 1)),
  ];
}

/** 3D Bresenham. Yields every voxel on the line from `a` to `b`. */
export function* line3(a: Vec3, b: Vec3): Generator<Vec3> {
  let [x, y, z] = [Math.round(a[0]), Math.round(a[1]), Math.round(a[2])];
  const [x2, y2, z2] = [Math.round(b[0]), Math.round(b[1]), Math.round(b[2])];
  const dx = Math.abs(x2 - x), dy = Math.abs(y2 - y), dz = Math.abs(z2 - z);
  const sx = x2 > x ? 1 : -1, sy = y2 > y ? 1 : -1, sz = z2 > z ? 1 : -1;

  if (dx >= dy && dx >= dz) {
    let ey = 2 * dy - dx, ez = 2 * dz - dx;
    for (let i = 0; i <= dx; i++) {
      yield [x, y, z];
      if (ey >= 0) { y += sy; ey -= 2 * dx; }
      if (ez >= 0) { z += sz; ez -= 2 * dx; }
      ey += 2 * dy; ez += 2 * dz; x += sx;
    }
  } else if (dy >= dx && dy >= dz) {
    let ex = 2 * dx - dy, ez = 2 * dz - dy;
    for (let i = 0; i <= dy; i++) {
      yield [x, y, z];
      if (ex >= 0) { x += sx; ex -= 2 * dy; }
      if (ez >= 0) { z += sz; ez -= 2 * dy; }
      ex += 2 * dx; ez += 2 * dz; y += sy;
    }
  } else {
    let ex = 2 * dx - dz, ey = 2 * dy - dz;
    for (let i = 0; i <= dz; i++) {
      yield [x, y, z];
      if (ex >= 0) { x += sx; ex -= 2 * dz; }
      if (ey >= 0) { y += sy; ey -= 2 * dz; }
      ex += 2 * dx; ey += 2 * dy; z += sz;
    }
  }
}
