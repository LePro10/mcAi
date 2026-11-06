// Resolved block geometry (output of AssetStore.geometry, input of the renderer).
// Units: 0..16 per block (vanilla model units).

export type Dir = 'down' | 'up' | 'north' | 'south' | 'west' | 'east';
export const DIRS: Dir[] = ['down', 'up', 'north', 'south', 'west', 'east'];
export const DIR_INDEX: Record<Dir, number> = { down: 0, up: 1, north: 2, south: 3, west: 4, east: 5 };
export const DIR_VEC: [number, number, number][] = [
  [0, -1, 0],
  [0, 1, 0],
  [0, 0, -1],
  [0, 0, 1],
  [-1, 0, 0],
  [1, 0, 0],
];

export function dirFromVec(x: number, y: number, z: number): Dir {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  if (ay >= ax && ay >= az) return y < 0 ? 'down' : 'up';
  if (az >= ax) return z < 0 ? 'north' : 'south';
  return x < 0 ? 'west' : 'east';
}

export interface GeoFace {
  /** resolved texture name, e.g. 'block/oak_planks', '' = untextured (flat color) */
  texture: string;
  /** texture rectangle in 0..16 units of the texture (u0,v0,u1,v1; may be flipped) */
  uv: [number, number, number, number];
  rotation: 0 | 90 | 180 | 270;
  /** -1 = no tint */
  tint: number;
  /** block-space direction of the neighbour that culls this face (after model rotation) */
  cullface: Dir | null;
  uvlock: boolean;
}

export interface GeoCuboid {
  /** element space, 0..16 */
  from: [number, number, number];
  to: [number, number, number];
  /** element space → block space: p' = m·p + t (row-major 3×3, units 0..16) */
  m: number[];
  t: number[];
  /** true when m is the identity and t = 0 */
  identity: boolean;
  /** faces keyed by element-space direction */
  faces: Partial<Record<Dir, GeoFace>>;
  shade: boolean;
}

export type RenderLayer = 'opaque' | 'cutout' | 'translucent';

export interface BlockGeometry {
  state: string;
  cuboids: GeoCuboid[];
  /** ambient occlusion enabled (model "ambientocclusion") */
  ao: boolean;
  layer: RenderLayer;
  /** fluid occupying the cell: water/lava blocks and waterlogged blocks */
  fluid: 'water' | 'lava' | null;
  /** 0 = source (vanilla "level" property), 8+ = falling */
  fluidLevel: number;
  /** a single full 0..16 opaque cube → occludes neighbours / AO */
  fullCube: boolean;
  /** light emission 0..15 */
  emission: number;
  /** tint color for faces with tintindex >= 0 (default biome) */
  tint: [number, number, number] | null;
  /** which colormap the tint comes from (for biome-dependent re-tinting) */
  tintKind: 'grass' | 'foliage' | 'dry_foliage' | 'water' | 'fixed' | null;
  /** synthesized geometry (block-entity renderer / fluid), not a vanilla model */
  synthetic: boolean;
  /** no assets available: flat colored geometry */
  flat: boolean;
  /** flat rgba color used when a face has no texture (fallback) */
  color: [number, number, number, number];
  /** invisible block (barrier, light, structure_void, air) */
  invisible: boolean;
}

export const IDENTITY_M = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function defaultUv(dir: Dir, from: number[], to: number[]): [number, number, number, number] {
  switch (dir) {
    case 'down':
      return [from[0], 16 - to[2], to[0], 16 - from[2]];
    case 'up':
      return [from[0], from[2], to[0], to[2]];
    case 'north':
      return [16 - to[0], 16 - to[1], 16 - from[0], 16 - from[1]];
    case 'south':
      return [from[0], 16 - to[1], to[0], 16 - from[1]];
    case 'west':
      return [from[2], 16 - to[1], to[2], 16 - from[1]];
    case 'east':
      return [16 - to[2], 16 - to[1], 16 - from[2], 16 - from[1]];
  }
}

/** simple axis-aligned cuboid helper (identity transform) */
export function cuboid(
  from: [number, number, number],
  to: [number, number, number],
  faces: Partial<Record<Dir, Partial<GeoFace> & { texture: string }>>,
  shade = true,
): GeoCuboid {
  const out: Partial<Record<Dir, GeoFace>> = {};
  for (const d of DIRS) {
    const f = faces[d];
    if (!f) continue;
    out[d] = {
      texture: f.texture,
      uv: f.uv ?? defaultUv(d, from, to),
      rotation: f.rotation ?? 0,
      tint: f.tint ?? -1,
      cullface: f.cullface ?? null,
      uvlock: f.uvlock ?? false,
    };
  }
  return { from, to, m: IDENTITY_M.slice(), t: [0, 0, 0], identity: true, faces: out, shade };
}

// ---- 3×3 matrix helpers (row-major) -------------------------------------------------
export function matMul(a: number[], b: number[]): number[] {
  const o = new Array(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}
export function matVec(m: number[], v: number[]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}
/** right-handed rotation matrix around a principal axis, angle in degrees */
export function rotMat(axis: 'x' | 'y' | 'z', deg: number): number[] {
  const a = (deg * Math.PI) / 180;
  let c = Math.cos(a), s = Math.sin(a);
  if (Math.abs(c) < 1e-9) c = 0;
  if (Math.abs(s) < 1e-9) s = 0;
  if (Math.abs(c - 1) < 1e-12) c = 1;
  if (axis === 'x') return [1, 0, 0, 0, c, -s, 0, s, c];
  if (axis === 'y') return [c, 0, s, 0, 1, 0, -s, 0, c];
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}
export function matInverse(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return IDENTITY_M.slice();
  const k = 1 / det;
  return [
    A * k, -(b * i - c * h) * k, (b * f - c * e) * k,
    B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
    C * k, -(a * h - b * g) * k, (a * e - b * d) * k,
  ];
}
