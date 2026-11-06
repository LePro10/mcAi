// CPU ray tracer over a compiled SceneData. Pure computation: runs on the main thread or in
// worker_threads (all inputs are typed arrays, usually on SharedArrayBuffers).
import { ES, FS, K_CUBE, K_EMPTY, F_OCC, F_AO, F_TRANSLUCENT, F_WATER, F_LAVA, F_FLAT, F_PLANT, type SceneData } from './scene.ts';

export interface RenderParams {
  W: number;
  H: number;
  ortho: boolean;
  /** ortho: view center; perspective: eye */
  c: number[];
  f: number[];
  r: number[];
  u: number[];
  /** ortho: world units per pixel; perspective: tan(fov/2) / (H/2) */
  scale: number;
  sun: number[];
  sunCol: number[];
  ambCol: number[];
  blockCol: number[];
  skyTop: number[];
  skyHor: number[];
  shadows: boolean;
  ao: boolean;
  ground: boolean;
  groundY: number;
  /** ground grid footprint (world x0,z0,x1,z1) */
  groundBox: number[];
  fogDepth: number;
  /** ray t where the haze starts (nearest frame corner) */
  fogStart: number;
  fogCol: number[];
  night: boolean;
  /** draw natural terrain cut by the volume boundary (or the cutaway) flat, in a neutral section style */
  section?: boolean;
  /** elevation cutaway: natural terrain cells with grid coord (axis 0 = x, 2 = z) beyond clipAt on the clipSign side are skipped */
  clipAxis?: number;
  clipSign?: number;
  clipAt?: number;
  /** cut natural cells outside the allowed box on the camera side: [x0,z0,x1,z1] (grid coords, inclusive) + camera dir [dx,dz] */
  cutOut?: number[];
  /** optional sub-rectangle of the framebuffer to trace (all rows otherwise) */
}

const SRGB2LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) SRGB2LIN[i] = Math.pow(i / 255, 2.2);

// face index → normal
const NX = [0, 0, 0, 0, -1, 1], NY = [-1, 1, 0, 0, 0, 0], NZ = [0, 0, -1, 1, 0, 0];

export function createTracer(S: SceneData, R: RenderParams) {
  const { sx, sy, sz, grid, sky, blk, pKind, pFlags, pGroup, pElem, pTint, pColor, pEmit, pFluidH, elems, atlas, atlasW, texRect } = S;
  const pGlass = S.pGlass, pTerrain = S.pTerrain;
  const SECTION = R.section !== false;
  const clipAxis = R.clipAxis ?? -1, clipSign = R.clipSign ?? 1, clipAt = R.clipAt ?? 0;
  const cutOut = R.cutOut && R.cutOut.length >= 6 ? R.cutOut : null;
  const anyClip = clipAxis >= 0 || cutOut !== null;
  // per-cell "removable natural" mask (terrain, plants, water, natural trees — never the job's own blocks);
  // without it the per-palette terrain class decides
  const cut = S.cut && S.cut.length === sx * sy * sz ? S.cut : null;
  const removable = (i: number, p: number): boolean => (cut ? cut[i] !== 0 : pTerrain[p] !== 0);
  /** cell i (palette p) removed by the elevation cutaway or the outside cut */
  const clipped = (i: number, p: number, x: number, z: number): boolean => {
    if (!anyClip || !removable(i, p)) return false;
    if (clipAxis >= 0) {
      const c = clipAxis === 0 ? x : z;
      if (clipSign > 0 ? c > clipAt : c < clipAt) return true;
    }
    if (cutOut) {
      const cdx = cutOut[4], cdz = cutOut[5];
      if ((cdx > 0 && x > cutOut[2]) || (cdx < 0 && x < cutOut[0]) || (cdz > 0 && z > cutOut[3]) || (cdz < 0 && z < cutOut[1])) return true;
    }
    return false;
  };
  /** terrain cell that may show a section face */
  const sectionable = (i: number, p: number): boolean => pTerrain[p] === 1 && (!cut || cut[i] !== 0);
  /** neighbour of (x,y,z) across world face d is outside the volume or cut away → (x,y,z) shows a section face */
  const cutFace = (x: number, y: number, z: number, d: number): boolean => {
    const nx = x + NX[d], ny = y + NY[d], nz = z + NZ[d];
    if (d === 0) return false;
    if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) return true;
    const j = (ny * sz + nz) * sx + nx;
    return anyClip && clipped(j, grid[j], nx, nz);
  };
  const layer = sx * sz;
  const { brick, bsx, bsz } = S;
  const ox = S.ox, oy = S.oy, oz = S.oz;
  const B = S.bounds;
  const [Lx, Ly, Lz] = R.sun;
  const sunR = R.sunCol[0], sunG = R.sunCol[1], sunB = R.sunCol[2];
  const ambR = R.ambCol[0], ambG = R.ambCol[1], ambB = R.ambCol[2];
  const blR = R.blockCol[0], blG = R.blockCol[1], blB = R.blockCol[2];
  const wTR = S.waterTint[0], wTG = S.waterTint[1], wTB = S.waterTint[2];
  const WABS = 0.45, WSC = 0.32;
  const SKY_CURVE = new Float32Array(16), BLK_CURVE = new Float32Array(16);
  for (let i = 0; i < 16; i++) {
    const f = i / 15;
    SKY_CURVE[i] = 0.04 + 0.96 * Math.pow(f, 2.2);
    BLK_CURVE[i] = Math.pow(f, 2.0) * 1.15;
  }

  // ---- scratch "return registers"
  let tr = 0, tg = 0, tb = 0, ta = 0; // texel
  let su = 0, sv = 0; // uv
  let lAo = 1, lSky = 15, lBlk = 0; // lighting sample
  let cr = 0, cg = 0, cb = 0; // shaded color

  // hit list for general cells
  const MAXH = 96;
  const hT = new Float64Array(MAXH), hE = new Int32Array(MAXH), hD = new Int32Array(MAXH);
  let nHits = 0;

  function texel(ti: number, u: number, v: number): void {
    if (ti < 0) {
      tr = tg = tb = 1; ta = 1;
      return;
    }
    const o = ti * 4;
    const w = texRect[o + 2], h = texRect[o + 3];
    let x = (u * w) | 0, y = (v * h) | 0;
    if (x < 0) x = 0; else if (x >= w) x = w - 1;
    if (y < 0) y = 0; else if (y >= h) y = h - 1;
    const i = ((texRect[o + 1] + y) * atlasW + texRect[o] + x) * 4;
    tr = SRGB2LIN[atlas[i]];
    tg = SRGB2LIN[atlas[i + 1]];
    tb = SRGB2LIN[atlas[i + 2]];
    ta = atlas[i + 3] / 255;
  }

  /** uv for element e, element-space face d, element-space point q (block units) */
  function faceUv(eo: number, d: number, qx: number, qy: number, qz: number, wx: number, wy: number, wz: number, wd: number): void {
    const fo = eo + 20 + d * FS;
    let fs: number, ft: number;
    if (elems[fo + 8] > 0) {
      // uvlock: world-aligned default uv from block-space position
      switch (wd) {
        case 0: fs = wx; ft = 1 - wz; break;
        case 1: fs = wx; ft = wz; break;
        case 2: fs = 1 - wx; ft = 1 - wy; break;
        case 3: fs = wx; ft = 1 - wy; break;
        case 4: fs = wz; ft = 1 - wy; break;
        default: fs = 1 - wz; ft = 1 - wy; break;
      }
      su = fs; sv = ft;
      return;
    }
    const fx0 = elems[eo], fy0 = elems[eo + 1], fz0 = elems[eo + 2];
    const dx = elems[eo + 3] - fx0, dy = elems[eo + 4] - fy0, dz = elems[eo + 5] - fz0;
    const ex = dx > 1e-6 ? (qx - fx0) / dx : 0.5;
    const ey = dy > 1e-6 ? (qy - fy0) / dy : 0.5;
    const ez = dz > 1e-6 ? (qz - fz0) / dz : 0.5;
    switch (d) {
      case 0: fs = ex; ft = 1 - ez; break; // down
      case 1: fs = ex; ft = ez; break; // up
      case 2: fs = 1 - ex; ft = 1 - ey; break; // north
      case 3: fs = ex; ft = 1 - ey; break; // south
      case 4: fs = ez; ft = 1 - ey; break; // west
      default: fs = 1 - ez; ft = 1 - ey; break; // east
    }
    const rot = elems[fo + 5];
    if (rot === 1) { const t = fs; fs = ft; ft = 1 - t; }
    else if (rot === 2) { fs = 1 - fs; ft = 1 - ft; }
    else if (rot === 3) { const t = fs; fs = 1 - ft; ft = t; }
    if (fs < 0) fs = 0; else if (fs > 0.99999) fs = 0.99999;
    if (ft < 0) ft = 0; else if (ft > 0.99999) ft = 0.99999;
    const u0 = elems[fo + 1], v0 = elems[fo + 2], u1 = elems[fo + 3], v1 = elems[fo + 4];
    su = u0 + fs * (u1 - u0);
    sv = v0 + ft * (v1 - v0);
  }

  /** fetch the face texel incl. tint/flat color → tr,tg,tb,ta */
  function faceColor(p: number, eo: number, d: number): void {
    const fo = eo + 20 + d * FS;
    const ti = elems[fo];
    if ((pFlags[p] & F_FLAT) !== 0 || ti < 0) {
      const k = p * 4;
      // subtle per-face variation so flat cubes read as 3D
      tr = pColor[k]; tg = pColor[k + 1]; tb = pColor[k + 2]; ta = pColor[k + 3];
      return;
    }
    texel(ti, su, sv);
    if (elems[fo + 6] > 0) {
      const k = p * 3;
      tr *= pTint[k]; tg *= pTint[k + 1]; tb *= pTint[k + 2];
    }
  }

  const occAt = (x: number, y: number, z: number): number => {
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return 0;
    return (pFlags[grid[(y * sz + z) * sx + x]] & F_OCC) !== 0 ? 1 : 0;
  };
  const skyAt = (x: number, y: number, z: number): number => {
    if (x < 0 || z < 0 || x >= sx || z >= sz || y >= sy) return 15;
    if (y < 0) return 0;
    return sky[(y * sz + z) * sx + x];
  };
  const blkAt = (x: number, y: number, z: number): number => {
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return 0;
    return blk[(y * sz + z) * sx + x];
  };

  /** smooth lighting + AO at grid-space point (px,py,pz) on a face with axis-aligned normal (axis a, sign s) */
  function lighting(px: number, py: number, pz: number, nx: number, ny: number, nz: number, aoOn: boolean): void {
    const cx = Math.floor(px + nx * 0.01), cy = Math.floor(py + ny * 0.01), cz = Math.floor(pz + nz * 0.01);
    const ax = Math.abs(nx), ay = Math.abs(ny);
    if (!aoOn || !R.ao || Math.max(ax, ay, Math.abs(nz)) < 0.999) {
      lAo = 1;
      lSky = skyAt(cx, cy, cz);
      lBlk = blkAt(cx, cy, cz);
      return;
    }
    // tangent axes
    let ux = 0, uy = 0, uz = 0, vx = 0, vy = 0, vz = 0, fu: number, fv: number;
    if (ay > 0.5) { ux = 1; vz = 1; fu = px - cx; fv = pz - cz; }
    else if (ax > 0.5) { uy = 1; vz = 1; fu = py - cy; fv = pz - cz; }
    else { ux = 1; vy = 1; fu = px - cx; fv = py - cy; }
    let ao = 0, skyS = 0, blkS = 0;
    const cS = skyAt(cx, cy, cz), cB = blkAt(cx, cy, cz);
    for (let k = 0; k < 4; k++) {
      const s1 = k & 1 ? 1 : -1, s2 = k & 2 ? 1 : -1;
      const ax1 = cx + ux * s1, ay1 = cy + uy * s1, az1 = cz + uz * s1;
      const ax2 = cx + vx * s2, ay2 = cy + vy * s2, az2 = cz + vz * s2;
      const o1 = occAt(ax1, ay1, az1), o2 = occAt(ax2, ay2, az2);
      const o3 = o1 && o2 ? 1 : occAt(cx + ux * s1 + vx * s2, cy + uy * s1 + vy * s2, cz + uz * s1 + vz * s2);
      const a = o1 && o2 ? 0.4 : 1 - 0.2 * (o1 + o2 + o3);
      // light: average of non-occluded cells (occluded → center value)
      const l1s = o1 ? cS : skyAt(ax1, ay1, az1), l2s = o2 ? cS : skyAt(ax2, ay2, az2);
      const l3s = o3 ? cS : skyAt(cx + ux * s1 + vx * s2, cy + uy * s1 + vy * s2, cz + uz * s1 + vz * s2);
      const l1b = o1 ? cB : blkAt(ax1, ay1, az1), l2b = o2 ? cB : blkAt(ax2, ay2, az2);
      const l3b = o3 ? cB : blkAt(cx + ux * s1 + vx * s2, cy + uy * s1 + vy * s2, cz + uz * s1 + vz * s2);
      const wu = s1 > 0 ? fu : 1 - fu, wv = s2 > 0 ? fv : 1 - fv;
      const w = wu * wv;
      ao += a * w;
      skyS += ((cS + l1s + l2s + l3s) / 4) * w;
      blkS += ((cB + l1b + l2b + l3b) / 4) * w;
    }
    lAo = ao;
    lSky = skyS;
    lBlk = blkS;
  }

  // ---------------------------------------------------------------- element intersection
  let iT = 0, iD = 0; // result of intersectElem
  /** ray (block-local origin) vs element eo; returns true on a front-face hit with t > tMin */
  function intersectElem(eo: number, lx: number, ly: number, lz: number, dx: number, dy: number, dz: number, tMin: number): boolean {
    let qx = lx, qy = ly, qz = lz, rx = dx, ry = dy, rz = dz;
    if (elems[eo + 18] === 0) {
      const m = eo + 6;
      qx = elems[m] * lx + elems[m + 1] * ly + elems[m + 2] * lz + elems[eo + 15];
      qy = elems[m + 3] * lx + elems[m + 4] * ly + elems[m + 5] * lz + elems[eo + 16];
      qz = elems[m + 6] * lx + elems[m + 7] * ly + elems[m + 8] * lz + elems[eo + 17];
      rx = elems[m] * dx + elems[m + 1] * dy + elems[m + 2] * dz;
      ry = elems[m + 3] * dx + elems[m + 4] * dy + elems[m + 5] * dz;
      rz = elems[m + 6] * dx + elems[m + 7] * dy + elems[m + 8] * dz;
    }
    let tn = -1e30, tf = 1e30, face = -1;
    // x
    const x0 = elems[eo], x1 = elems[eo + 3];
    if (rx > 1e-12 || rx < -1e-12) {
      const inv = 1 / rx;
      let a = (x0 - qx) * inv, b = (x1 - qx) * inv, fa = 4;
      // zero-thickness planes (lily pads, vines): the face toward the ray origin is the one hit
      if (a > b || (a === b && inv < 0)) { const t = a; a = b; b = t; fa = 5; }
      if (a > tn || (a === tn && x1 - x0 < 1e-6)) { tn = a; face = fa; }
      if (b < tf) tf = b;
    } else if (qx < x0 - 1e-9 || qx > x1 + 1e-9) return false;
    const y0 = elems[eo + 1], y1 = elems[eo + 4];
    if (ry > 1e-12 || ry < -1e-12) {
      const inv = 1 / ry;
      let a = (y0 - qy) * inv, b = (y1 - qy) * inv, fa = 0;
      if (a > b || (a === b && inv < 0)) { const t = a; a = b; b = t; fa = 1; }
      if (a > tn || (a === tn && y1 - y0 < 1e-6)) { tn = a; face = fa; }
      if (b < tf) tf = b;
    } else if (qy < y0 - 1e-9 || qy > y1 + 1e-9) return false;
    const z0 = elems[eo + 2], z1 = elems[eo + 5];
    if (rz > 1e-12 || rz < -1e-12) {
      const inv = 1 / rz;
      let a = (z0 - qz) * inv, b = (z1 - qz) * inv, fa = 2;
      if (a > b || (a === b && inv < 0)) { const t = a; a = b; b = t; fa = 3; }
      if (a > tn || (a === tn && z1 - z0 < 1e-6)) { tn = a; face = fa; }
      if (b < tf) tf = b;
    } else if (qz < z0 - 1e-9 || qz > z1 + 1e-9) return false;
    if (face < 0 || tf < tn - 1e-9 || tn <= tMin) return false;
    if (elems[eo + 20 + face * FS] < -1.5) return false; // no face in that direction (one-sided)
    iT = tn;
    iD = face;
    // element-space hit point for uv
    hitQx = qx + rx * tn;
    hitQy = qy + ry * tn;
    hitQz = qz + rz * tn;
    return true;
  }
  let hitQx = 0, hitQy = 0, hitQz = 0;

  /** element-space point for block-local point (for K_CUBE fast path) */
  function toElem(eo: number, lx: number, ly: number, lz: number): void {
    if (elems[eo + 18] !== 0) {
      hitQx = lx; hitQy = ly; hitQz = lz;
      return;
    }
    const m = eo + 6;
    hitQx = elems[m] * lx + elems[m + 1] * ly + elems[m + 2] * lz + elems[eo + 15];
    hitQy = elems[m + 3] * lx + elems[m + 4] * ly + elems[m + 5] * lz + elems[eo + 16];
    hitQz = elems[m + 6] * lx + elems[m + 7] * ly + elems[m + 8] * lz + elems[eo + 17];
  }
  /** element-space face index for a world face direction wd */
  function elemDir(eo: number, wd: number): number {
    if (elems[eo + 18] !== 0) return wd;
    const m = eo + 6;
    const x = NX[wd], y = NY[wd], z = NZ[wd];
    const ex = elems[m] * x + elems[m + 1] * y + elems[m + 2] * z;
    const ey = elems[m + 3] * x + elems[m + 4] * y + elems[m + 5] * z;
    const ez = elems[m + 6] * x + elems[m + 7] * y + elems[m + 8] * z;
    const ax = Math.abs(ex), ay = Math.abs(ey), az = Math.abs(ez);
    if (ay >= ax && ay >= az) return ey < 0 ? 0 : 1;
    if (az >= ax) return ez < 0 ? 2 : 3;
    return ex < 0 ? 4 : 5;
  }

  // ---------------------------------------------------------------- bounds clipping
  let cT0 = 0, cT1 = 0, cAxis = -1;
  function clip(px: number, py: number, pz: number, dx: number, dy: number, dz: number): boolean {
    if (B[3] <= B[0]) return false;
    let t0 = -1e30, t1 = 1e30, ax = -1;
    if (dx > 1e-12 || dx < -1e-12) {
      let a = (B[0] - px) / dx, b = (B[3] - px) / dx;
      if (a > b) { const t = a; a = b; b = t; }
      if (a > t0) { t0 = a; ax = 0; }
      if (b < t1) t1 = b;
    } else if (px < B[0] || px > B[3]) return false;
    if (dy > 1e-12 || dy < -1e-12) {
      let a = (B[1] - py) / dy, b = (B[4] - py) / dy;
      if (a > b) { const t = a; a = b; b = t; }
      if (a > t0) { t0 = a; ax = 1; }
      if (b < t1) t1 = b;
    } else if (py < B[1] || py > B[4]) return false;
    if (dz > 1e-12 || dz < -1e-12) {
      let a = (B[2] - pz) / dz, b = (B[5] - pz) / dz;
      if (a > b) { const t = a; a = b; b = t; }
      if (a > t0) { t0 = a; ax = 2; }
      if (b < t1) t1 = b;
    } else if (pz < B[2] || pz > B[5]) return false;
    cT0 = t0; cT1 = t1; cAxis = ax;
    return t1 > t0 && t1 > 0;
  }

  // ---------------------------------------------------------------- shadows
  /** transmittance toward the sun from grid point (px,py,pz) */
  function shadowRay(px: number, py: number, pz: number): number {
    const dx = Lx, dy = Ly, dz = Lz;
    // clip to bounds
    if (!clip(px, py, pz, dx, dy, dz)) return 1;
    let t0 = cT0 < 0 ? 0 : cT0;
    const t1 = cT1;
    if (t1 <= t0) return 1;
    let T = 1;
    let t = t0;
    let x = Math.floor(px + dx * (t + 1e-7)), y = Math.floor(py + dy * (t + 1e-7)), z = Math.floor(pz + dz * (t + 1e-7));
    const stX = dx > 0 ? 1 : -1, stY = dy > 0 ? 1 : -1, stZ = dz > 0 ? 1 : -1;
    const tdX = Math.abs(1 / dx), tdY = Math.abs(1 / dy), tdZ = Math.abs(1 / dz);
    let tmX = dx !== 0 ? ((dx > 0 ? x + 1 : x) - px) / dx : 1e30;
    let tmY = dy !== 0 ? ((dy > 0 ? y + 1 : y) - py) / dy : 1e30;
    let tmZ = dz !== 0 ? ((dz > 0 ? z + 1 : z) - pz) / dz : 1e30;
    for (let guard = 0; guard < 4096; guard++) {
      if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) break;
      if (brick[((y >> 2) * bsz + (z >> 2)) * bsx + (x >> 2)] === 0) {
        const bx = x & ~3, by = y & ~3, bz = z & ~3;
        const ex = dx > 0 ? (bx + 4 - px) / dx : dx < 0 ? (bx - px) / dx : 1e30;
        const ey = dy > 0 ? (by + 4 - py) / dy : dy < 0 ? (by - py) / dy : 1e30;
        const ez = dz > 0 ? (bz + 4 - pz) / dz : dz < 0 ? (bz - pz) / dz : 1e30;
        let ax: number;
        if (ex <= ey && ex <= ez) { t = ex; ax = 0; } else if (ey <= ez) { t = ey; ax = 1; } else { t = ez; ax = 2; }
        if (t > t1) break;
        x = ax === 0 ? (dx > 0 ? bx + 4 : bx - 1) : Math.min(bx + 3, Math.max(bx, Math.floor(px + dx * t)));
        y = ax === 1 ? (dy > 0 ? by + 4 : by - 1) : Math.min(by + 3, Math.max(by, Math.floor(py + dy * t)));
        z = ax === 2 ? (dz > 0 ? bz + 4 : bz - 1) : Math.min(bz + 3, Math.max(bz, Math.floor(pz + dz * t)));
        tmX = dx !== 0 ? ((dx > 0 ? x + 1 : x) - px) / dx : 1e30;
        tmY = dy !== 0 ? ((dy > 0 ? y + 1 : y) - py) / dy : 1e30;
        tmZ = dz !== 0 ? ((dz > 0 ? z + 1 : z) - pz) / dz : 1e30;
        continue;
      }
      const ci = (y * sz + z) * sx + x;
      const p = grid[ci];
      const k = anyClip && clipped(ci, p, x, z) ? K_EMPTY : pKind[p];
      if (k !== K_EMPTY) {
        const fl = pFlags[p];
        if (fl & F_OCC) return 0;
        if (fl & F_WATER) T *= 0.82;
        if (fl & F_LAVA) return 0;
        const e0 = pElem[p * 2], ne = pElem[p * 2 + 1];
        const lx = px - x, ly = py - y, lz = pz - z;
        for (let e = 0; e < ne; e++) {
          const eo = (e0 + e) * ES;
          if (!intersectElem(eo, lx, ly, lz, dx, dy, dz, 1e-4)) continue;
          faceUv(eo, iD, hitQx, hitQy, hitQz, lx + dx * iT, ly + dy * iT, lz + dz * iT, iD);
          faceColor(p, eo, iD);
          if (fl & F_TRANSLUCENT) T *= 1 - ta * 0.75;
          else if (ta >= 0.5) return 0;
          else if (pGlass[p]) T *= 0.85;
          if (T < 0.03) return 0;
        }
      }
      if (tmX < tmY && tmX < tmZ) { t = tmX; tmX += tdX; x += stX; }
      else if (tmY < tmZ) { t = tmY; tmY += tdY; y += stY; }
      else { t = tmZ; tmZ += tdZ; z += stZ; }
      if (t > t1) break;
    }
    return T;
  }

  // ---------------------------------------------------------------- shading
  /** shade a surface point (grid space) with normal n and albedo (tr,tg,tb) → cr,cg,cb */
  function shade(px: number, py: number, pz: number, nx: number, ny: number, nz: number, aoOn: boolean, plant: boolean, emit: number): void {
    const ar = tr, ag = tg, ab = tb;
    lighting(px, py, pz, nx, ny, nz, aoOn);
    let lnx = nx, lny = ny, lnz = nz;
    if (plant) { lnx = 0; lny = 1; lnz = 0; }
    let ndl = lnx * Lx + lny * Ly + lnz * Lz;
    if (plant) ndl = 0.35 + 0.65 * Math.max(0, ndl);
    let sun = 0;
    if (ndl > 0) {
      sun = ndl;
      if (R.shadows) sun *= shadowRay(px + nx * 2e-3, py + ny * 2e-3, pz + nz * 2e-3);
    }
    const skyF = SKY_CURVE[Math.min(15, Math.max(0, Math.round(lSky)))] * lAo;
    const hemi = 0.62 + 0.38 * (lny * 0.5 + 0.5);
    // vanilla-like directional shading keeps faces readable even in full shadow
    const faceShade = lny > 0.5 ? 1 : lny < -0.5 ? 0.55 : Math.abs(lnz) > Math.abs(lnx) ? 0.85 : 0.72;
    const amb = skyF * hemi * faceShade;
    const bl = BLK_CURVE[Math.min(15, Math.max(0, Math.round(lBlk)))] * (0.6 + 0.4 * lAo);
    const k = sun * (0.85 + 0.15 * lAo);
    cr = ar * (sunR * k + ambR * amb + blR * bl + 0.015) + ar * emit * 1.6;
    cg = ag * (sunG * k + ambG * amb + blG * bl + 0.015) + ag * emit * 1.6;
    cb = ab * (sunB * k + ambB * amb + blB * bl + 0.02) + ab * emit * 1.6;
  }

  // sky color for a direction (perspective) or screen height (ortho)
  let skR = 0, skG = 0, skB = 0;
  function skyColor(dy: number, dx: number, dz: number): void {
    const h = Math.max(-0.2, Math.min(1, dy));
    const t = Math.pow(Math.max(0, h), 0.55);
    skR = R.skyHor[0] + (R.skyTop[0] - R.skyHor[0]) * t;
    skG = R.skyHor[1] + (R.skyTop[1] - R.skyHor[1]) * t;
    skB = R.skyHor[2] + (R.skyTop[2] - R.skyHor[2]) * t;
    if (h < 0) {
      const k = Math.min(1, -h * 4);
      skR *= 1 - 0.25 * k; skG *= 1 - 0.2 * k; skB *= 1 - 0.1 * k;
    }
    const sd = dx * Lx + dy * Ly + dz * Lz;
    if (sd > 0.9 && !R.night) {
      const g = Math.pow((sd - 0.9) / 0.1, 6) * 1.2;
      skR += g * R.sunCol[0] * 0.5; skG += g * R.sunCol[1] * 0.5; skB += g * R.sunCol[2] * 0.4;
    }
  }

  // ---------------------------------------------------------------- primary ray
  let outR = 0, outG = 0, outB = 0;
  const gb = R.groundBox;
  function trace(Ox: number, Oy: number, Oz: number, dx: number, dy: number, dz: number, bgY: number): void {
    // grid space
    const px = Ox - ox, py = Oy - oy, pz = Oz - oz;
    let accR = 0, accG = 0, accB = 0, T = 1;
    let firstT = -1;
    // clip to non-air bounds (+water/fluids are inside bounds too)
    let miss = !clip(px, py, pz, dx, dy, dz);
    let t0 = cT0, t1 = cT1, entryAxis = cAxis;
    if (t0 < 0) { t0 = 0; entryAxis = -1; }
    if (t1 <= t0) miss = true;
    let inWater = false, tW = 0, waterDepthStart = 0;
    if (!miss) {
      let t = t0;
      const e = 1e-7;
      let x = Math.floor(px + dx * (t + e)), y = Math.floor(py + dy * (t + e)), z = Math.floor(pz + dz * (t + e));
      if (x < B[0]) x = B[0]; if (x >= B[3]) x = B[3] - 1;
      if (y < B[1]) y = B[1]; if (y >= B[4]) y = B[4] - 1;
      if (z < B[2]) z = B[2]; if (z >= B[5]) z = B[5] - 1;
      const stX = dx > 0 ? 1 : -1, stY = dy > 0 ? 1 : -1, stZ = dz > 0 ? 1 : -1;
      const tdX = Math.abs(1 / dx), tdY = Math.abs(1 / dy), tdZ = Math.abs(1 / dz);
      let tmX = dx !== 0 ? ((dx > 0 ? x + 1 : x) - px) / dx : 1e30;
      let tmY = dy !== 0 ? ((dy > 0 ? y + 1 : y) - py) / dy : 1e30;
      let tmZ = dz !== 0 ? ((dz > 0 ? z + 1 : z) - pz) / dz : 1e30;
      // entry face of the current cell (world dir index the ray enters through)
      let entryFace = entryAxis === 0 ? (dx > 0 ? 4 : 5) : entryAxis === 1 ? (dy > 0 ? 0 : 1) : entryAxis === 2 ? (dz > 0 ? 2 : 3) : -1;
      let prevP = 0;
      for (let guard = 0; guard < 8192; guard++) {
        const idx = (y * sz + z) * sx + x;
        const p0 = grid[idx];
        const p = anyClip && clipped(idx, p0, x, z) ? 0 : p0;
        const k = pKind[p];
        if (k === K_EMPTY && !inWater && brick[((y >> 2) * bsz + (z >> 2)) * bsx + (x >> 2)] === 0) {
          // empty 4³ brick: jump to its exit
          const bx = x & ~3, by = y & ~3, bz = z & ~3;
          const ex = dx > 0 ? (bx + 4 - px) / dx : dx < 0 ? (bx - px) / dx : 1e30;
          const ey = dy > 0 ? (by + 4 - py) / dy : dy < 0 ? (by - py) / dy : 1e30;
          const ez = dz > 0 ? (bz + 4 - pz) / dz : dz < 0 ? (bz - pz) / dz : 1e30;
          let ax: number;
          if (ex <= ey && ex <= ez) { t = ex; ax = 0; } else if (ey <= ez) { t = ey; ax = 1; } else { t = ez; ax = 2; }
          if (t > t1 + 1e-6) break;
          const qx = px + dx * t, qy = py + dy * t, qz = pz + dz * t;
          x = ax === 0 ? (dx > 0 ? bx + 4 : bx - 1) : Math.min(bx + 3, Math.max(bx, Math.floor(qx)));
          y = ax === 1 ? (dy > 0 ? by + 4 : by - 1) : Math.min(by + 3, Math.max(by, Math.floor(qy)));
          z = ax === 2 ? (dz > 0 ? bz + 4 : bz - 1) : Math.min(bz + 3, Math.max(bz, Math.floor(qz)));
          if (x < B[0] || x >= B[3] || y < B[1] || y >= B[4] || z < B[2] || z >= B[5]) break;
          tmX = dx !== 0 ? ((dx > 0 ? x + 1 : x) - px) / dx : 1e30;
          tmY = dy !== 0 ? ((dy > 0 ? y + 1 : y) - py) / dy : 1e30;
          tmZ = dz !== 0 ? ((dz > 0 ? z + 1 : z) - pz) / dz : 1e30;
          entryFace = ax === 0 ? (dx > 0 ? 4 : 5) : ax === 1 ? (dy > 0 ? 0 : 1) : (dz > 0 ? 2 : 3);
          prevP = 0;
          continue;
        }
        const tExit = tmX < tmY ? (tmX < tmZ ? tmX : tmZ) : tmY < tmZ ? tmY : tmZ;
        const fl = pFlags[p];
        if (inWater && (fl & F_WATER) === 0) {
          // leaving the water volume
          const d = t - tW;
          const a = 1 - Math.exp(-WABS * d);
          accR += T * a * wTR * WSC; accG += T * a * wTG * WSC; accB += T * a * wTB * WSC;
          T *= 1 - a;
          inWater = false;
        }
        if (k !== K_EMPTY) {
          const lx = px - x, ly = py - y, lz = pz - z; // block-local origin
          // ---------------- fluids
          if ((fl & (F_WATER | F_LAVA)) !== 0 && !inWater) {
            const above = y + 1 < sy ? grid[idx + layer] : 0;
            const covered = (pFlags[above] & (fl & (F_WATER | F_LAVA))) !== 0;
            const h = covered ? 1 : pFluidH[p];
            const ey = ly + dy * t; // entry height (local)
            let ts = -1, fnx = 0, fny = 0, fnz = 0;
            if (entryFace >= 0 && entryFace !== 1 && -ey >= -h - 1e-6 && (prevP === 0 || (pFlags[prevP] & (F_WATER | F_LAVA)) === 0) && (pFlags[prevP] & F_OCC) === 0) {
              ts = t; fnx = NX[entryFace]; fny = NY[entryFace]; fnz = NZ[entryFace];
            } else if (dy < 0 && !covered) {
              const th = (h - ly) / dy;
              if (th >= t - 1e-6 && th <= tExit + 1e-6) { ts = th; fny = 1; }
            } else if (entryFace === 1 && covered === false && ey <= h) {
              ts = t; fny = 1;
            }
            if (ts >= 0 && SECTION && fny === 0 && ts === t && cutFace(x, y, z, entryFace)) {
              // water cut by the volume boundary: flat section colour instead of an aquarium wall
              const hx = px + dx * ts, hy = py + dy * ts, hz = pz + dz * ts;
              if (firstT < 0) firstT = ts;
              tr = wTR * 0.55; tg = wTG * 0.6; tb = wTB * 0.7;
              if (fl & F_LAVA) { tr = 0.6; tg = 0.2; tb = 0.03; }
              shade(hx, hy, hz, fnx, 0, fnz, false, false, 0);
              const a = 0.9;
              accR += T * a * cr; accG += T * a * cg; accB += T * a * cb;
              T *= 1 - a;
              inWater = true;
              tW = ts;
              if (T < 0.01) break;
              ts = -1;
            }
            if (ts >= 0) {
              const hx = px + dx * ts, hy = py + dy * ts, hz = pz + dz * ts;
              if (firstT < 0) firstT = ts;
              if (fl & F_LAVA) {
                const fu = hx - Math.floor(hx), fv = hz - Math.floor(hz);
                texel(S.lavaTex, fny ? fu : fnx ? hz - Math.floor(hz) : fu, fny ? fv : 1 - (hy - Math.floor(hy)));
                if (S.lavaTex < 0) { tr = 0.8; tg = 0.25; tb = 0.02; }
                shade(hx, hy, hz, fnx, fny, fnz, true, false, 1);
                accR += T * cr; accG += T * cg; accB += T * cb;
                T = 0;
                break;
              }
              // water surface
              const fu = fny ? hx - Math.floor(hx) : fnx ? hz - Math.floor(hz) : hx - Math.floor(hx);
              const fv = fny ? hz - Math.floor(hz) : 1 - (hy - Math.floor(hy));
              texel(S.waterTex, fu, fv);
              if (S.waterTex < 0) { tr = tg = tb = 0.75; ta = 0.7; }
              tr *= wTR; tg *= wTG; tb *= wTB;
              shade(hx, hy, hz, fnx, fny, fnz, true, false, 0);
              const cosT = Math.abs(dx * fnx + dy * fny + dz * fnz);
              const fres = 0.02 + 0.98 * Math.pow(1 - cosT, 5);
              // reflection
              const dn = dx * fnx + dy * fny + dz * fnz;
              const rx = dx - 2 * dn * fnx, ry = dy - 2 * dn * fny, rz = dz - 2 * dn * fnz;
              skyColor(ry, rx, rz);
              let spec = rx * Lx + ry * Ly + rz * Lz;
              spec = spec > 0 ? Math.pow(spec, 300) * 5 : 0;
              if (spec > 0.01 && R.shadows) spec *= shadowRay(hx, hy + 1e-3, hz);
              const alpha = Math.min(0.94, 0.62 + 0.4 * fres);
              const refl = Math.min(0.7, fres * 0.85 + 0.04);
              const sr = cr * (1 - refl) + skR * refl + spec * sunR;
              const sg = cg * (1 - refl) + skG * refl + spec * sunG;
              const sb = cb * (1 - refl) + skB * refl + spec * sunB;
              accR += T * alpha * sr; accG += T * alpha * sg; accB += T * alpha * sb;
              T *= 1 - alpha;
              inWater = true;
              tW = ts;
              waterDepthStart = ts;
              if (T < 0.01) break;
            }
          }
          // ---------------- solid geometry
          if (k === K_CUBE) {
            if (entryFace >= 0 && !(pGroup[p] !== 0 && pGroup[prevP] === pGroup[p])) {
              const e0 = pElem[p * 2], ne = pElem[p * 2 + 1];
              const hx = px + dx * t, hy = py + dy * t, hz = pz + dz * t;
              const wlx = hx - x, wly = hy - y, wlz = hz - z;
              let hit = false;
              const section = SECTION && sectionable(idx, p) && (fl & F_OCC) !== 0 && cutFace(x, y, z, entryFace);
              for (let e = ne - 1; e >= 0 && !section; e--) {
                const eo = (e0 + e) * ES;
                const d = elemDir(eo, entryFace);
                if (elems[eo + 20 + d * FS] < -1.5) continue;
                toElem(eo, wlx, wly, wlz);
                faceUv(eo, d, hitQx, hitQy, hitQz, wlx, wly, wlz, entryFace);
                faceColor(p, eo, d);
                if (pGlass[p]) {
                  hit = true;
                  break;
                }
                if ((fl & F_TRANSLUCENT) !== 0) {
                  if (ta < 0.02) continue;
                  hit = true;
                  break;
                }
                if (ta >= 0.5) {
                  ta = 1;
                  hit = true;
                  break;
                }
              }
              if (hit) {
                if (firstT < 0) firstT = t;
                if (inWater) {
                  const a = 1 - Math.exp(-WABS * (t - tW));
                  accR += T * a * wTR * WSC; accG += T * a * wTG * WSC; accB += T * a * wTB * WSC;
                  T *= 1 - a;
                  tW = t;
                }
                if ((fl & F_FLAT) !== 0) flatVariation(x, y, z, entryFace);
                let alpha = ta;
                if (pGlass[p]) {
                  glass(p, hx, hy, hz, NX[entryFace], NY[entryFace], NZ[entryFace], dx, dy, dz, faceEdge(wlx, wly, wlz, entryFace));
                  alpha = gA;
                } else shade(hx, hy, hz, NX[entryFace], NY[entryFace], NZ[entryFace], (fl & F_AO) !== 0, false, pEmit[p]);
                accR += T * alpha * cr; accG += T * alpha * cg; accB += T * alpha * cb;
                T *= 1 - alpha;
                if (T < 0.01) break;
              } else if (section) {
                if (firstT < 0) firstT = t;
                if (inWater) {
                  const a = 1 - Math.exp(-WABS * (t - tW));
                  accR += T * a * wTR * WSC; accG += T * a * wTG * WSC; accB += T * a * wTB * WSC;
                  T *= 1 - a;
                  tW = t;
                }
                sectionColor(p, x, y, z, hx, hy, hz, entryFace);
                accR += T * cr; accG += T * cg; accB += T * cb;
                T = 0;
                break;
              }
            }
          } else if (SECTION && entryFace >= 0 && sectionable(idx, p) && cutFace(x, y, z, entryFace)) {
            // non-cube terrain (dirt path, farmland, …) cut by the boundary: section face
            if (firstT < 0) firstT = t;
            sectionColor(p, x, y, z, px + dx * t, py + dy * t, pz + dz * t, entryFace);
            accR += T * cr; accG += T * cg; accB += T * cb;
            T = 0;
            break;
          } else if (pElem[p * 2 + 1] > 0) {
            // general: collect element hits in this cell
            const e0 = pElem[p * 2], ne = pElem[p * 2 + 1];
            nHits = 0;
            for (let e = 0; e < ne; e++) {
              const eo = (e0 + e) * ES;
              if (!intersectElem(eo, lx, ly, lz, dx, dy, dz, t0 - 1e-6)) continue;
              if (iT > tExit + 0.5) continue;
              // insertion sort by t (later elements first on ties → overlays win)
              let j = nHits++;
              if (j >= MAXH) { nHits = MAXH; break; }
              while (j > 0 && (hT[j - 1] > iT + 1e-7 || (Math.abs(hT[j - 1] - iT) <= 1e-7 && hE[j - 1] < e))) {
                hT[j] = hT[j - 1]; hE[j] = hE[j - 1]; hD[j] = hD[j - 1];
                j--;
              }
              hT[j] = iT; hE[j] = e; hD[j] = iD;
            }
            for (let h = 0; h < nHits && T >= 0.01; h++) {
              const eo = (e0 + hE[h]) * ES;
              const tt = hT[h], d = hD[h];
              // cull faces against same glass-like neighbours
              const cull = elems[eo + 20 + d * FS + 7];
              if (cull >= 0 && pGroup[p] !== 0) {
                const nx2 = x + NX[cull], ny2 = y + NY[cull], nz2 = z + NZ[cull];
                if (nx2 >= 0 && ny2 >= 0 && nz2 >= 0 && nx2 < sx && ny2 < sy && nz2 < sz && pGroup[grid[(ny2 * sz + nz2) * sx + nx2]] === pGroup[p]) continue;
              }
              const lhx = lx + dx * tt, lhy = ly + dy * tt, lhz = lz + dz * tt;
              // recompute element-space point
              toElem(eo, lhx, lhy, lhz);
              const wd = nearestDir(eo, d);
              faceUv(eo, d, hitQx, hitQy, hitQz, lhx, lhy, lhz, wd);
              faceColor(p, eo, d);
              const transl = (fl & F_TRANSLUCENT) !== 0;
              const gk = pGlass[p];
              if (!gk && (transl ? ta < 0.02 : ta < 0.5)) continue;
              if (!transl && !gk) ta = 1;
              if (firstT < 0) firstT = tt;
              if (inWater) {
                const a = 1 - Math.exp(-WABS * (tt - tW));
                accR += T * a * wTR * WSC; accG += T * a * wTG * WSC; accB += T * a * wTB * WSC;
                T *= 1 - a;
                tW = tt;
              }
              const fo = eo + 20 + d * FS;
              const nx = elems[fo + 9], ny = elems[fo + 10], nz = elems[fo + 11];
              if ((fl & F_FLAT) !== 0) flatVariation(x, y, z, wd);
              let alpha = ta;
              const plant = (fl & F_PLANT) !== 0 && (elems[eo + 19] & 2) === 0;
              if (gk) {
                glass(p, x + lhx, y + lhy, z + lhz, nx, ny, nz, dx, dy, dz, faceEdge(lhx, lhy, lhz, wd));
                alpha = gA;
              } else shade(x + lhx, y + lhy, z + lhz, nx, ny, nz, (fl & F_AO) !== 0 && (elems[eo + 19] & 2) !== 0, plant, pEmit[p]);
              accR += T * alpha * cr; accG += T * alpha * cg; accB += T * alpha * cb;
              T *= 1 - alpha;
            }
            if (T < 0.01) break;
          }
        }
        prevP = p;
        // advance
        if (tmX < tmY && tmX < tmZ) { t = tmX; tmX += tdX; x += stX; entryFace = dx > 0 ? 4 : 5; if (x < B[0] || x >= B[3]) break; }
        else if (tmY < tmZ) { t = tmY; tmY += tdY; y += stY; entryFace = dy > 0 ? 0 : 1; if (y < B[1] || y >= B[4]) break; }
        else { t = tmZ; tmZ += tdZ; z += stZ; entryFace = dz > 0 ? 2 : 3; if (z < B[2] || z >= B[5]) break; }
        if (t > t1 + 1e-6) break;
      }
      if (inWater && T > 0.01) {
        const a = 1 - Math.exp(-WABS * Math.max(0, Math.min(t, t1) - tW));
        accR += T * a * wTR * WSC; accG += T * a * wTG * WSC; accB += T * a * wTB * WSC;
        T *= 1 - a;
      }
    }
    void waterDepthStart;
    // ---------------- background: ground grid / sky
    if (T > 0.01) {
      let done = false;
      if (R.ground && dy < -1e-6) {
        const tg2 = (R.groundY - Oy) / dy;
        if (tg2 > 0) {
          const gx = Ox + dx * tg2, gz = Oz + dz * tg2;
          const ex = Math.max(gb[0] - gx, gx - gb[2], 0), ez = Math.max(gb[1] - gz, gz - gb[3], 0);
          const edge = Math.max(ex, ez);
          const fadeLen = Math.max(6, (gb[2] - gb[0] + gb[3] - gb[1]) * 0.25);
          const vis = Math.max(0, 1 - edge / fadeLen);
          if (vis > 0) {
            // paper-like ground with block grid + chunk lines
            const fx = gx - Math.floor(gx), fz = gz - Math.floor(gz);
            const lw = Math.max(0.03, R.ortho ? R.scale * 0.6 : 0.03);
            const onLine = Math.min(fx, 1 - fx) < lw || Math.min(fz, 1 - fz) < lw;
            const cx = gx - Math.floor(gx / 16) * 16, cz = gz - Math.floor(gz / 16) * 16;
            const onChunk = Math.min(cx, 16 - cx) < lw * 1.6 || Math.min(cz, 16 - cz) < lw * 1.6;
            tr = 0.56; tg = 0.6; tb = 0.64;
            if (onLine) { tr *= 0.8; tg *= 0.8; tb *= 0.82; }
            if (onChunk) { tr *= 0.62; tg *= 0.64; tb *= 0.7; }
            shade(gx - ox, R.groundY - oy, gz - oz, 0, 1, 0, true, false, 0);
            skyColor(bgY, 0, 0);
            const a = vis;
            const gr = cr * a + skR * (1 - a), gg = cg * a + skG * (1 - a), gbb = cb * a + skB * (1 - a);
            accR += T * gr; accG += T * gg; accB += T * gbb;
            done = true;
            if (firstT < 0) firstT = tg2;
          }
        }
      }
      if (!done) {
        if (R.ortho) skyColor(bgY, dx, dz);
        else skyColor(dy, dx, dz);
        accR += T * skR; accG += T * skG; accB += T * skB;
      }
    }
    // depth haze
    if (firstT >= 0 && R.fogDepth > 0) {
      const depth = Math.max(0, firstT - R.fogStart);
      const f = 0.14 * (1 - Math.exp(-depth / R.fogDepth));
      accR = accR * (1 - f) + R.fogCol[0] * f;
      accG = accG * (1 - f) + R.fogCol[1] * f;
      accB = accB * (1 - f) + R.fogCol[2] * f;
    }
    outR = accR; outG = accG; outB = accB;
  }

  /** distance (block units) of a block-local hit point to the nearest edge of its face square */
  function faceEdge(lx: number, ly: number, lz: number, d: number): number {
    let a: number, b: number;
    if (d < 2) { a = lx; b = lz; } else if (d < 4) { a = lx; b = ly; } else { a = lz; b = ly; }
    a -= Math.floor(a); b -= Math.floor(b);
    return Math.min(a, 1 - a, b, 1 - b);
  }

  let gA = 1;
  /**
   * Glass surface (texel in tr..ta): clear glass gets a cool tint, darker frame edges and a fresnel
   * sky reflection with soft diagonal glare streaks; stained glass keeps its colour plus the reflection.
   * Result → cr,cg,cb and coverage gA.
   */
  function glass(p: number, hx: number, hy: number, hz: number, nx: number, ny: number, nz: number, dx: number, dy: number, dz: number, edge: number): void {
    const kind = pGlass[p];
    let a: number, frame = false;
    if (kind === 1) {
      if (ta >= 0.5 || edge < 0.07) {
        frame = true;
        tr = tr * 0.45 + 0.03; tg = tg * 0.47 + 0.035; tb = tb * 0.5 + 0.04;
        a = 1;
      } else {
        tr = 0.34; tg = 0.46; tb = 0.52;
        a = 0.2;
      }
    } else {
      a = Math.max(0.42, ta);
      if (edge < 0.05) { tr *= 0.6; tg *= 0.6; tb *= 0.6; a = Math.max(a, 0.85); }
    }
    shade(hx, hy, hz, nx, ny, nz, frame, false, pEmit[p]);
    if (frame) { gA = a; return; }
    const dn = dx * nx + dy * ny + dz * nz;
    const cosT = Math.min(1, Math.abs(dn));
    const fres = Math.pow(1 - cosT, 5);
    const rx = dx - 2 * dn * nx, ry = dy - 2 * dn * ny, rz = dz - 2 * dn * nz;
    skyColor(ry, rx, rz);
    // soft diagonal glare bands across the pane (world-aligned, so neighbouring panes continue them)
    const w = (hx + ox) * 0.55 + (hz + oz) * 0.55 + (hy + oy) * 0.9;
    const band = 0.5 + 0.5 * Math.sin(w * 0.9);
    const glare = 0.7 + 0.75 * band * band * band * band;
    let refl = ((kind === 1 ? 0.24 : 0.12) + 0.6 * fres) * glare;
    if (refl > 0.9) refl = 0.9;
    let spec = rx * Lx + ry * Ly + rz * Lz;
    spec = spec > 0 && !R.night ? Math.pow(spec, 220) * 3 : 0;
    cr = cr * (1 - refl) + skR * refl + spec * sunR;
    cg = cg * (1 - refl) + skG * refl + spec * sunG;
    cb = cb * (1 - refl) + skB * refl + spec * sunB;
    gA = a + (1 - a) * refl * 0.85;
  }

  /** flat, texture-free "section" colour for terrain cut by the volume boundary → cr,cg,cb */
  function sectionColor(p: number, x: number, y: number, z: number, hx: number, hy: number, hz: number, d: number): void {
    const k = p * 4;
    let r = pColor[k], g = pColor[k + 1], b = pColor[k + 2];
    const l = 0.3 * r + 0.59 * g + 0.11 * b;
    r = (0.35 * r + 0.65 * l) * 0.75 + 0.3 * 0.25;
    g = (0.35 * g + 0.65 * l) * 0.75 + 0.28 * 0.25;
    b = (0.35 * b + 0.65 * l) * 0.75 + 0.25 * 0.25;
    // ground line: bold edge where the section meets the open surface above
    const ai = ((y + 1) * sz + z) * sx + x;
    const above = y + 1 < sy ? grid[ai] : 0;
    const openAbove = pTerrain[above] !== 1 || (y + 1 < sy && anyClip && clipped(ai, above, x, z));
    const fy = hy - Math.floor(hy);
    let k2 = 1;
    if (openAbove && fy > 0.84) k2 = 0.38;
    else {
      // light 45° hatch
      const u = d >= 4 ? hz : hx;
      const hv = (u + hy) * 2;
      if (hv - Math.floor(hv) < 0.12) k2 = 0.86;
    }
    const lum = 0.55 + 0.25 * Math.max(0, NX[d] * Lx + NY[d] * Ly + NZ[d] * Lz);
    const sky = SKY_CURVE[15];
    cr = r * k2 * (sunR * 0.45 * lum + ambR * 0.75 * sky);
    cg = g * k2 * (sunG * 0.45 * lum + ambG * 0.75 * sky);
    cb = b * k2 * (sunB * 0.45 * lum + ambB * 0.75 * sky);
  }

  function nearestDir(eo: number, d: number): number {
    const fo = eo + 20 + d * FS;
    const nx = elems[fo + 9], ny = elems[fo + 10], nz = elems[fo + 11];
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    if (ay >= ax && ay >= az) return ny < 0 ? 0 : 1;
    if (az >= ax) return nz < 0 ? 2 : 3;
    return nx < 0 ? 4 : 5;
  }

  /** procedural texture-ish variation for flat fallback colors */
  function flatVariation(x: number, y: number, z: number, d: number): void {
    let h = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791) ^ (d * 2654435761);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    const v = 0.92 + ((h >>> 0) % 1000) / 1000 * 0.12;
    tr *= v; tg *= v; tb *= v;
  }

  /** render rows [y0, y1) into out (rgb float, W*H*3) */
  function renderRows(y0: number, y1: number, out: Float32Array): void {
    const W = R.W, H = R.H;
    const [cx, cy, cz] = R.c, [fx, fy, fz] = R.f, [rx, ry, rz] = R.r, [ux, uy, uz] = R.u;
    for (let j = y0; j < y1; j++) {
      const sy2 = (H / 2 - (j + 0.5));
      const bgY = 0.15 + 0.85 * (1 - (j + 0.5) / H);
      for (let i = 0; i < W; i++) {
        const sx2 = i + 0.5 - W / 2;
        let Ox: number, Oy: number, Oz: number, dx: number, dy: number, dz: number;
        if (R.ortho) {
          const s = R.scale;
          Ox = cx + rx * sx2 * s + ux * sy2 * s - fx * 1e4;
          Oy = cy + ry * sx2 * s + uy * sy2 * s - fy * 1e4;
          Oz = cz + rz * sx2 * s + uz * sy2 * s - fz * 1e4;
          dx = fx; dy = fy; dz = fz;
        } else {
          const s = R.scale;
          dx = fx + rx * sx2 * s + ux * sy2 * s;
          dy = fy + ry * sx2 * s + uy * sy2 * s;
          dz = fz + rz * sx2 * s + uz * sy2 * s;
          const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
          dx /= L; dy /= L; dz /= L;
          Ox = cx; Oy = cy; Oz = cz;
        }
        trace(Ox, Oy, Oz, dx, dy, dz, bgY);
        const o = (j * W + i) * 3;
        out[o] = outR;
        out[o + 1] = outG;
        out[o + 2] = outB;
      }
    }
  }

  return { renderRows, trace: (o: number[], d: number[]) => { trace(o[0], o[1], o[2], d[0], d[1], d[2], 0.5); return [outR, outG, outB]; } };
}

export type Tracer = ReturnType<typeof createTracer>;
