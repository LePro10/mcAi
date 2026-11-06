// Compile a BlockVolume + AssetStore into flat (shareable) typed arrays for the tracer.
import type { BlockVolume, Box } from '../core/types.ts';
import { blockId } from '../core/blockstate.ts';
import type { AssetStore, AtlasData } from '../assets/assets.ts';
import { flatGeometry } from '../assets/fallback.ts';
import { stateProps } from '../assets/registry-lite.ts';
import { selfCulls } from '../assets/classify.ts';
import { DIRS, DIR_VEC, matInverse, matVec, type BlockGeometry } from '../assets/geometry.ts';

// element table layout (floats)
export const ES = 20 + 6 * 12; // stride
// [0..2] from, [3..5] to (block units), [6..14] Minv (block→elem), [15..17] tinv, [18] identity, [19] flags (bit0 shade, bit1 axis-aligned normals)
// faces at 20 + d*12: tex, u0, v0, u1, v1, rot(0..3), tint(0/1), cull(-1..5), uvlock, nx, ny, nz
export const FS = 12;

export const K_EMPTY = 0, K_CUBE = 1, K_GENERAL = 2;
// pFlags bits
export const F_OCC = 1, F_AO = 2, F_TRANSLUCENT = 4, F_WATER = 8, F_LAVA = 16, F_FLAT = 32, F_PLANT = 64;

export interface SceneData {
  sx: number; sy: number; sz: number;
  ox: number; oy: number; oz: number;
  grid: Uint16Array;
  sky: Uint8Array;
  blk: Uint8Array;
  pKind: Uint8Array;
  pFlags: Uint8Array;
  pGroup: Int32Array;
  pElem: Int32Array;
  pTint: Float32Array;
  pColor: Float32Array;
  pEmit: Float32Array;
  pFluidH: Float32Array;
  elems: Float32Array;
  atlas: Uint8Array;
  atlasW: number;
  texRect: Int32Array;
  waterTex: number;
  lavaTex: number;
  waterTint: number[];
  /** non-air bounds in grid coords (min x,y,z, max x,y,z exclusive) */
  bounds: number[];
  /** 4×4×4 brick occupancy (1 = has non-empty cells) for empty-space skipping */
  brick: Uint8Array;
  bsx: number;
  bsy: number;
  bsz: number;
}

function shared<T extends Uint8Array | Uint16Array | Int32Array | Float32Array>(
  C: { new (b: SharedArrayBuffer): T; BYTES_PER_ELEMENT: number },
  n: number,
): T {
  return new C(new SharedArrayBuffer(Math.max(1, n) * C.BYTES_PER_ELEMENT));
}

const lin = (c: number) => Math.pow(c / 255, 2.2);

export function compileScene(v: BlockVolume, assets: AssetStore | null, biome?: string): SceneData {
  const [sx, sy, sz] = [v.box.max[0] - v.box.min[0] + 1, v.box.max[1] - v.box.min[1] + 1, v.box.max[2] - v.box.min[2] + 1];
  const P = v.palette.length;
  const geos: BlockGeometry[] = v.palette.map((s) => {
    if (assets) return assets.geometry(s);
    const { id, props } = (() => {
      try {
        return stateProps(s);
      } catch {
        return { id: blockId(s), props: {} as Record<string, string> };
      }
    })();
    return flatGeometry(s, id, props);
  });
  const atlas: AtlasData | null = assets ? assets.atlasData() : null;
  const texIndex = (name: string) => (atlas && name ? (atlas.index.get(name) ?? -1) : -1);

  const pKind = shared(Uint8Array, P), pFlags = shared(Uint8Array, P), pGroup = shared(Int32Array, P);
  const pElem = shared(Int32Array, 2 * P), pTint = shared(Float32Array, 3 * P), pColor = shared(Float32Array, 4 * P);
  const pEmit = shared(Float32Array, P), pFluidH = shared(Float32Array, P);
  let E = 0;
  for (const g of geos) E += g.cuboids.length;
  const elems = shared(Float32Array, E * ES);
  const groups = new Map<string, number>();
  let e = 0;
  for (let p = 0; p < P; p++) {
    const g = geos[p];
    const id = blockId(g.state);
    const tint = (assets ? assets.tintFor(g, biome) : null) ?? [255, 255, 255];
    pTint.set([lin(tint[0]), lin(tint[1]), lin(tint[2])], p * 3);
    pColor.set([lin(g.color[0]), lin(g.color[1]), lin(g.color[2]), g.color[3] / 255], p * 4);
    pEmit[p] = g.emission / 15;
    let flags = 0;
    if (g.fullCube) flags |= F_OCC;
    if (g.ao) flags |= F_AO;
    if (g.layer === 'translucent') flags |= F_TRANSLUCENT;
    if (g.fluid === 'water') flags |= F_WATER;
    if (g.fluid === 'lava') flags |= F_LAVA;
    if (g.flat) flags |= F_FLAT;
    if (!g.ao) flags |= F_PLANT;
    pFlags[p] = flags;
    pFluidH[p] = g.fluidLevel >= 8 ? 1 : g.fluidLevel === 0 ? 8 / 9 : (8 - (g.fluidLevel & 7)) / 9;
    if (selfCulls(id)) {
      if (!groups.has(id)) groups.set(id, groups.size + 1);
      pGroup[p] = groups.get(id)!;
    }
    pElem[p * 2] = e;
    pElem[p * 2 + 1] = g.cuboids.length;
    let allFull = g.cuboids.length > 0;
    for (const c of g.cuboids) {
      const o = e * ES;
      const Minv = matInverse(c.m);
      const tinv = matVec(Minv, c.t).map((x) => -x);
      elems.set([c.from[0] / 16, c.from[1] / 16, c.from[2] / 16, c.to[0] / 16, c.to[1] / 16, c.to[2] / 16], o);
      elems.set(Minv, o + 6);
      elems.set([tinv[0] / 16, tinv[1] / 16, tinv[2] / 16], o + 15);
      elems[o + 18] = c.identity ? 1 : 0;
      // normals: inverse-transpose of M = Minv^T
      let axisAligned = true;
      for (let d = 0; d < 6; d++) {
        const f = c.faces[DIRS[d]];
        const fo = o + 20 + d * FS;
        if (!f) {
          elems[fo] = -2; // no face
          continue;
        }
        const n = DIR_VEC[d];
        let nx = Minv[0] * n[0] + Minv[3] * n[1] + Minv[6] * n[2];
        let ny = Minv[1] * n[0] + Minv[4] * n[1] + Minv[7] * n[2];
        let nz = Minv[2] * n[0] + Minv[5] * n[1] + Minv[8] * n[2];
        const L = Math.hypot(nx, ny, nz) || 1;
        nx /= L; ny /= L; nz /= L;
        if (Math.max(Math.abs(nx), Math.abs(ny), Math.abs(nz)) < 0.999) axisAligned = false;
        const ti = texIndex(f.texture);
        elems.set([ti, f.uv[0] / 16, f.uv[1] / 16, f.uv[2] / 16, f.uv[3] / 16, f.rotation / 90, f.tint >= 0 ? 1 : 0,
          f.cullface ? DIRS.indexOf(f.cullface) : -1, f.uvlock ? 1 : 0, nx, ny, nz], fo);
      }
      elems[o + 19] = (c.shade ? 1 : 0) | (axisAligned ? 2 : 0);
      const full = c.identity || isFullAfterTransform(c);
      if (!(full && c.from.every((x) => x === 0) && c.to.every((x) => x === 16))) allFull = false;
      e++;
    }
    if (g.invisible || (g.cuboids.length === 0 && !g.fluid)) pKind[p] = K_EMPTY;
    else if (g.cuboids.length === 0) pKind[p] = K_GENERAL; // fluid only
    else if (allFull && (g.fullCube || g.layer === 'translucent' || g.flat)) pKind[p] = K_CUBE;
    else pKind[p] = K_GENERAL;
    if (g.flat && g.fullCube && g.cuboids.length === 1) pKind[p] = K_CUBE;
  }
  pKind[0] = K_EMPTY;

  const N = sx * sy * sz;
  const grid = shared(Uint16Array, N);
  grid.set(v.data.subarray(0, N));
  // non-air bounds
  let bx0 = sx, by0 = sy, bz0 = sz, bx1 = -1, by1 = -1, bz1 = -1;
  for (let y = 0, i = 0; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++, i++) {
        if (pKind[grid[i]] === K_EMPTY) continue;
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
        if (y < by0) by0 = y; if (y > by1) by1 = y;
        if (z < bz0) bz0 = z; if (z > bz1) bz1 = z;
      }
  const bounds = bx1 < 0 ? [0, 0, 0, 0, 0, 0] : [bx0, by0, bz0, bx1 + 1, by1 + 1, bz1 + 1];
  const bsx = (sx + 3) >> 2, bsy = (sy + 3) >> 2, bsz = (sz + 3) >> 2;
  const brick = shared(Uint8Array, bsx * bsy * bsz);
  for (let y = 0, i = 0; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++, i++) if (pKind[grid[i]] !== K_EMPTY) brick[((y >> 2) * bsz + (z >> 2)) * bsx + (x >> 2)] = 1;
  const { sky, blk } = computeLight(sx, sy, sz, grid, pFlags, pKind, pEmit);

  let atlasArr: Uint8Array, texRect: Int32Array;
  if (atlas) {
    atlasArr = shared(Uint8Array, atlas.rgba.length);
    atlasArr.set(atlas.rgba);
    texRect = shared(Int32Array, atlas.rects.length);
    texRect.set(atlas.rects);
  } else {
    atlasArr = shared(Uint8Array, 4);
    texRect = shared(Int32Array, 4);
  }
  const wt = assets ? assets.tint('water', biome) : [0x3f, 0x76, 0xe4];
  return {
    sx, sy, sz, ox: v.box.min[0], oy: v.box.min[1], oz: v.box.min[2],
    grid, sky, blk, pKind, pFlags, pGroup, pElem, pTint, pColor, pEmit, pFluidH, elems,
    atlas: atlasArr, atlasW: atlas ? atlas.width : 1, texRect,
    waterTex: texIndex('block/water_still'), lavaTex: texIndex('block/lava_still'),
    waterTint: [lin(wt[0]), lin(wt[1]), lin(wt[2])],
    bounds, brick, bsx, bsy, bsz,
  };
}

function isFullAfterTransform(c: { m: number[]; t: number[]; from: number[]; to: number[] }): boolean {
  // axis permutation / 90° rotations of a full cube stay a full cube
  const a = matVec(c.m, c.from), b = matVec(c.m, c.to);
  for (let i = 0; i < 3; i++) {
    const lo = Math.min(a[i], b[i]) + c.t[i], hi = Math.max(a[i], b[i]) + c.t[i];
    if (Math.abs(lo) > 1e-6 || Math.abs(hi - 16) > 1e-6) return false;
  }
  return true;
}

/** Minecraft-like light propagation: sky light (open top) and block light (emitters), 0..15. */
function computeLight(sx: number, sy: number, sz: number, grid: Uint16Array, pFlags: Uint8Array, pKind: Uint8Array, pEmit: Float32Array) {
  const N = sx * sy * sz;
  const sky = shared(Uint8Array, N);
  const blk = shared(Uint8Array, N);
  const layer = sx * sz;
  const opaque = (i: number) => (pFlags[grid[i]] & F_OCC) !== 0;
  const dim = (i: number) => {
    const p = grid[i];
    return pKind[p] !== K_EMPTY && (pFlags[p] & (F_WATER | F_PLANT)) !== 0 ? 1 : 0; // leaves/water/plants dim light a bit
  };
  // ring-buffer BFS queue
  const cap = Math.max(1024, N);
  const queue = new Int32Array(cap);
  let qh = 0, qn = 0;
  const push = (i: number) => {
    if (qn >= cap) return;
    queue[(qh + qn) % cap] = i;
    qn++;
  };
  // sky: straight down from the top
  for (let z = 0; z < sz; z++)
    for (let x = 0; x < sx; x++) {
      let level = 15;
      for (let y = sy - 1; y >= 0; y--) {
        const i = y * layer + z * sx + x;
        if (opaque(i)) break;
        level -= dim(i);
        if (level <= 0) break;
        sky[i] = level;
        push(i);
      }
    }
  const spread = (L: Uint8Array) => {
    while (qn > 0) {
      const i = queue[qh];
      qh = (qh + 1) % cap;
      qn--;
      const l = L[i];
      if (l <= 1) continue;
      const x = i % sx, z = ((i / sx) | 0) % sz, y = (i / layer) | 0;
      for (let k = 0; k < 6; k++) {
        let j: number;
        if (k === 0) { if (x === 0) continue; j = i - 1; }
        else if (k === 1) { if (x === sx - 1) continue; j = i + 1; }
        else if (k === 2) { if (z === 0) continue; j = i - sx; }
        else if (k === 3) { if (z === sz - 1) continue; j = i + sx; }
        else if (k === 4) { if (y === 0) continue; j = i - layer; }
        else { if (y === sy - 1) continue; j = i + layer; }
        if (opaque(j)) continue;
        const nl = l - 1 - dim(j);
        if (nl > L[j]) {
          L[j] = nl;
          push(j);
        }
      }
    }
  };
  spread(sky);
  qh = qn = 0;
  for (let i = 0; i < N; i++) {
    const e = pEmit[grid[i]];
    if (e > 0) {
      blk[i] = Math.round(e * 15);
      push(i);
    }
  }
  spread(blk);
  return { sky, blk };
}

export function sceneBoundsBox(s: SceneData): Box | null {
  const b = s.bounds;
  if (b[3] <= b[0]) return null;
  return { min: [s.ox + b[0], s.oy + b[1], s.oz + b[2]], max: [s.ox + b[3] - 1, s.oy + b[4] - 1, s.oz + b[5] - 1] };
}
