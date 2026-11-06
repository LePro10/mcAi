// Section mesher: 16³ block section → three vertex buffers (opaque / cutout / translucent).
// Face culling against opaque full blocks and same-group blocks (glass, leaves, ice…), baked
// per-vertex ambient occlusion + smooth sky/block light, biome tints, fluids. No DOM.
import {
  SECTION, QUAD_STRIDE, DIR_VEC, G_OCCLUDES, G_AO, G_WATER, G_LAVA, G_INVISIBLE, G_TRANSLUCENT,
  TINT_NONE, TINT_FIXED, TINT_WATER,
} from './voxels.js';

const AO_CURVE = [1.0, 0.8, 0.64, 0.5];
export const LAYER_OPAQUE = 0, LAYER_CUTOUT = 1, LAYER_TRANSLUCENT = 2;
export const NO_BORN = -1e6;

/** growable vertex/index buffers for one render layer */
export class MeshBuilder {
  constructor(cap = 1024) {
    this.n = 0; // vertices
    this.ni = 0; // indices
    this.alloc(cap);
  }
  alloc(cap) {
    const re = (C, old, k) => {
      const a = new C(cap * k);
      if (old) a.set(old.subarray(0, Math.min(old.length, cap * k)));
      return a;
    };
    this.pos = re(Float32Array, this.pos, 3);
    this.nrm = re(Int8Array, this.nrm, 3);
    this.uv = re(Float32Array, this.uv, 2);
    this.col = re(Uint8Array, this.col, 4);
    this.lit = re(Uint8Array, this.lit, 4);
    this.born = re(Float32Array, this.born, 1);
    this.idx = re(Uint32Array, this.idx, 1.5);
    this.cap = cap;
  }
  ensure(nv) {
    if (this.n + nv > this.cap) this.alloc(Math.max(this.cap * 2, this.n + nv));
  }
  vertex(x, y, z, nx, ny, nz, u, v, r, g, b, a, sky, blk, emit, born) {
    const i = this.n++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.nrm[i * 3] = Math.round(nx * 127); this.nrm[i * 3 + 1] = Math.round(ny * 127); this.nrm[i * 3 + 2] = Math.round(nz * 127);
    this.uv[i * 2] = u; this.uv[i * 2 + 1] = v;
    this.col[i * 4] = r; this.col[i * 4 + 1] = g; this.col[i * 4 + 2] = b; this.col[i * 4 + 3] = a;
    this.lit[i * 4] = sky; this.lit[i * 4 + 1] = blk; this.lit[i * 4 + 2] = emit; this.lit[i * 4 + 3] = 0;
    this.born[i] = born;
  }
  /** quad from the last 4 vertices; flip = use the other diagonal (AO anisotropy fix) */
  quad(flip) {
    const b = this.n - 4;
    if (this.ni + 6 > this.idx.length) {
      const a = new Uint32Array(Math.max(this.idx.length * 2, 1536));
      a.set(this.idx.subarray(0, this.ni));
      this.idx = a;
    }
    const I = this.idx;
    if (!flip) {
      I[this.ni++] = b; I[this.ni++] = b + 1; I[this.ni++] = b + 2;
      I[this.ni++] = b; I[this.ni++] = b + 2; I[this.ni++] = b + 3;
    } else {
      I[this.ni++] = b + 1; I[this.ni++] = b + 2; I[this.ni++] = b + 3;
      I[this.ni++] = b + 1; I[this.ni++] = b + 3; I[this.ni++] = b;
    }
  }
  /** compact typed arrays (or null if empty) */
  finish() {
    if (!this.n) return null;
    const n = this.n;
    const index = n <= 65535 ? Uint16Array.from(this.idx.subarray(0, this.ni)) : this.idx.slice(0, this.ni);
    return {
      count: n,
      position: this.pos.slice(0, n * 3),
      normal: this.nrm.slice(0, n * 3),
      uv: this.uv.slice(0, n * 2),
      color: this.col.slice(0, n * 4),
      light: this.lit.slice(0, n * 4),
      born: this.born.slice(0, n),
      index,
    };
  }
}

export function bufferList(layers) {
  const out = [];
  for (const l of Object.values(layers)) if (l) for (const k of ['position', 'normal', 'uv', 'color', 'light', 'born', 'index']) out.push(l[k].buffer);
  return out;
}

const clampByte = (v) => (v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0);

/**
 * Mesh one section.
 * @param {import('./voxels.js').VoxelWorld} world
 * @param {import('./voxels.js').GeoTable} geo
 * @param {number} scx @param {number} scy @param {number} scz section coords
 * @param {{ cutY?: number|null, tintAt?: (x:number,z:number,kind:number)=>number[], bornAt?: (i:number)=>number,
 *           fluids?: { water?: number[]|null, lava?: number[]|null }, waterTint?: number[] }} [opts]
 * @returns {{ opaque: any, cutout: any, translucent: any, quads: number }}
 */
export function meshSection(world, geo, scx, scy, scz, opts = {}) {
  const cutY = opts.cutY ?? null;
  const tintAt = opts.tintAt ?? null;
  const bornAt = opts.bornAt ?? null;
  const fluids = opts.fluids ?? {};
  const defaultWater = opts.waterTint ?? [0.05, 0.18, 0.78];
  const ox = scx * SECTION, oy = scy * SECTION, oz = scz * SECTION;
  const builders = [new MeshBuilder(2048), new MeshBuilder(512), new MeshBuilder(256)];
  const { data, sky, blk, sx, sy, sz, layer } = world;
  const wx0 = world.min[0], wy0 = world.min[1], wz0 = world.min[2];
  const flags = geo.flags, group = geo.group;
  let quads = 0;

  const xs = Math.max(ox, world.min[0]), xe = Math.min(ox + SECTION - 1, world.max[0]);
  const ys = Math.max(oy, world.min[1]), ye0 = Math.min(oy + SECTION - 1, world.max[1]);
  const zs = Math.max(oz, world.min[2]), ze = Math.min(oz + SECTION - 1, world.max[2]);
  const ye = cutY === null ? ye0 : Math.min(ye0, cutY);
  if (xs > xe || ys > ye || zs > ze) return { opaque: null, cutout: null, translucent: null, quads: 0 };

  // palette index at world coords (0 outside the loaded box or above the cut)
  const P = (x, y, z) => {
    if (cutY !== null && y > cutY) return 0;
    const lx = x - wx0, ly = y - wy0, lz = z - wz0;
    if (lx < 0 || ly < 0 || lz < 0 || lx >= sx || ly >= sy || lz >= sz) return 0;
    return data[ly * layer + lz * sx + lx];
  };
  const occ = (x, y, z) => (flags[P(x, y, z)] & G_OCCLUDES) !== 0;
  // light at a cell (outside = open sky)
  const skyAt = (x, y, z) => {
    const lx = x - wx0, ly = y - wy0, lz = z - wz0;
    if (lx < 0 || lz < 0 || lx >= sx || lz >= sz || ly >= sy) return 15;
    if (ly < 0) return 0;
    if (cutY !== null && y > cutY) return 15;
    return sky[ly * layer + lz * sx + lx];
  };
  const blkAt = (x, y, z) => {
    const lx = x - wx0, ly = y - wy0, lz = z - wz0;
    if (lx < 0 || ly < 0 || lz < 0 || lx >= sx || ly >= sy || lz >= sz) return 0;
    return blk[ly * layer + lz * sx + lx];
  };

  // per-vertex scratch
  const vAo = [0, 0, 0, 0], vSky = [0, 0, 0, 0], vBlk = [0, 0, 0, 0];

  /** AO + smooth light for a vertex at block-local p of an axis-aligned face (axis a, sign s) of cell (x,y,z) */
  function sampleVertex(k, x, y, z, px, py, pz, a, s, doAo) {
    const p = [px, py, pz];
    const f = [0, 0, 0];
    f[a] = Math.floor(p[a] + s * 0.01);
    const t1 = a === 0 ? 1 : 0, t2 = a === 2 ? 1 : 2;
    const s1 = p[t1] <= 0.01 ? -1 : p[t1] >= 0.99 ? 1 : 0;
    const s2 = p[t2] <= 0.01 ? -1 : p[t2] >= 0.99 ? 1 : 0;
    const fx = x + f[0], fy = y + f[1], fz = z + f[2];
    let side1 = false, side2 = false, corner = false;
    let c1x = fx, c1y = fy, c1z = fz, c2x = fx, c2y = fy, c2z = fz;
    if (s1) {
      if (t1 === 0) c1x += s1; else c1y += s1;
      side1 = occ(c1x, c1y, c1z);
    }
    if (s2) {
      if (t2 === 1) c2y += s2; else c2z += s2;
      side2 = occ(c2x, c2y, c2z);
    }
    let ccx = c1x + (c2x - fx), ccy = c1y + (c2y - fy), ccz = c1z + (c2z - fz);
    if (s1 && s2) corner = occ(ccx, ccy, ccz);
    vAo[k] = doAo ? AO_CURVE[side1 && side2 ? 3 : (side1 ? 1 : 0) + (side2 ? 1 : 0) + (corner ? 1 : 0)] : 1;
    // smooth light: average over the non-opaque cells of the vertex neighbourhood
    let ls = 0, lb = 0, n = 0;
    const frontOpaque = occ(fx, fy, fz);
    if (!frontOpaque) {
      ls += skyAt(fx, fy, fz); lb += blkAt(fx, fy, fz); n++;
    }
    if (s1 && !side1) {
      ls += skyAt(c1x, c1y, c1z); lb += blkAt(c1x, c1y, c1z); n++;
    }
    if (s2 && !side2) {
      ls += skyAt(c2x, c2y, c2z); lb += blkAt(c2x, c2y, c2z); n++;
    }
    if (s1 && s2 && !corner && !(side1 && side2)) {
      ls += skyAt(ccx, ccy, ccz); lb += blkAt(ccx, ccy, ccz); n++;
    }
    if (!n) {
      ls = skyAt(x, y, z); lb = blkAt(x, y, z); n = 1;
    }
    vSky[k] = ls / n / 15;
    vBlk[k] = lb / n / 15;
  }

  for (let y = ys; y <= ye; y++)
    for (let z = zs; z <= ze; z++)
      for (let x = xs; x <= xe; x++) {
        const li = (y - wy0) * layer + (z - wz0) * sx + (x - wx0);
        const p = data[li];
        if (p === 0) continue;
        const fl = flags[p];
        if (fl & G_INVISIBLE) continue;
        const q = geo.quads[p];
        const born = bornAt ? bornAt(li) : NO_BORN;
        const emitB = clampByte(geo.emit[p] / 15);
        const doAo = (fl & G_AO) !== 0;
        const gid = group[p];
        const lx = x - ox, ly = y - oy, lz = z - oz;
        // tint for this block
        let tr = 1, tg = 1, tb = 1;
        const tk = geo.tintKind[p];
        if (tk !== TINT_NONE) {
          if (tk === TINT_FIXED || !tintAt) {
            tr = geo.tint[p * 3]; tg = geo.tint[p * 3 + 1]; tb = geo.tint[p * 3 + 2];
          } else {
            const t = tintAt(x, z, tk);
            tr = t[0]; tg = t[1]; tb = t[2];
          }
        }
        const cr = geo.color[p * 4], cg = geo.color[p * 4 + 1], cb = geo.color[p * 4 + 2], ca = geo.color[p * 4 + 3];
        for (let o = 0; o + QUAD_STRIDE <= q.length; o += QUAD_STRIDE) {
          const cull = q[o];
          if (cull >= 0) {
            const d = DIR_VEC[cull];
            const np = P(x + d[0], y + d[1], z + d[2]);
            const nf = flags[np];
            if (nf & G_OCCLUDES) continue;
            if (gid && group[np] === gid) continue;
          }
          const tinted = q[o + 1] > 0;
          const lay = q[o + 3];
          const nx = q[o + 4], ny = q[o + 5], nz = q[o + 6];
          const axis = Math.abs(nx) > 0.99 ? 0 : Math.abs(ny) > 0.99 ? 1 : Math.abs(nz) > 0.99 ? 2 : -1;
          const sgn = axis === 0 ? Math.sign(nx) : axis === 1 ? Math.sign(ny) : axis === 2 ? Math.sign(nz) : 0;
          for (let k = 0; k < 4; k++) {
            const c = o + 8 + k * 5;
            if (axis >= 0) sampleVertex(k, x, y, z, q[c], q[c + 1], q[c + 2], axis, sgn, doAo);
            else {
              vAo[k] = 1;
              vSky[k] = skyAt(x, y, z) / 15;
              vBlk[k] = blkAt(x, y, z) / 15;
            }
          }
          const b = builders[lay] ?? builders[0];
          b.ensure(4);
          const flat = q[o + 8 + 3] < 0;
          for (let k = 0; k < 4; k++) {
            const c = o + 8 + k * 5;
            let r = 1, g = 1, bl = 1, al = 1;
            if (flat) {
              r = cr; g = cg; bl = cb; al = ca;
            } else if (tinted) {
              r = tr; g = tg; bl = tb;
            }
            const ao = vAo[k];
            b.vertex(lx + q[c], ly + q[c + 1], lz + q[c + 2], nx, ny, nz, q[c + 3], q[c + 4],
              clampByte(r * ao), clampByte(g * ao), clampByte(bl * ao), clampByte(al),
              clampByte(vSky[k]), clampByte(vBlk[k]), emitB, born);
          }
          b.quad(vAo[0] + vAo[2] < vAo[1] + vAo[3]);
          quads++;
        }
        // fluids
        if (fl & (G_WATER | G_LAVA)) quads += meshFluid(x, y, z, p, fl, li, born);
      }

  function meshFluid(x, y, z, p, fl, li, born) {
    const water = (fl & G_WATER) !== 0;
    const same = (np) => (flags[np] & (water ? G_WATER : G_LAVA)) !== 0;
    const rect = water ? fluids.water : fluids.lava;
    const lvl = geo.level[p];
    const above = P(x, y + 1, z);
    const h = same(above) ? 1 : lvl >= 8 ? 1 : lvl === 0 ? 8 / 9 : (8 - (lvl & 7)) / 9;
    let r = 1, g = 1, b = 1;
    if (water) {
      const t = tintAt ? tintAt(x, z, TINT_WATER) : defaultWater;
      r = t[0]; g = t[1]; b = t[2];
    }
    if (!rect && !water) {
      r = geo.color[p * 4]; g = geo.color[p * 4 + 1]; b = geo.color[p * 4 + 2];
    }
    const lay = water ? LAYER_TRANSLUCENT : LAYER_OPAQUE;
    const B = builders[lay];
    const emitB = water ? 0 : 255;
    const alpha = water ? (rect ? 1 : 0.7) : 1;
    const lx = x - ox, ly = y - oy, lz = z - oz;
    const u0 = rect ? rect[0] : -1, v0 = rect ? rect[1] : -1, u1 = rect ? rect[2] : -1;
    const vh = rect ? rect[1] + (rect[3] - rect[1]) * Math.min(1, h) : -1, v1 = rect ? rect[3] : -1;
    let n = 0;
    const face = (pts, nx, ny, nz, uvs) => {
      B.ensure(4);
      const sk = skyAt(x + (nx > 0.5 ? 1 : nx < -0.5 ? -1 : 0), y + (ny > 0.5 ? 1 : ny < -0.5 ? -1 : 0), z + (nz > 0.5 ? 1 : nz < -0.5 ? -1 : 0));
      const bk = blkAt(x, y, z);
      const own = skyAt(x, y, z);
      const s = clampByte(Math.max(sk, own) / 15), bb = clampByte(bk / 15);
      for (let k = 0; k < 4; k++)
        B.vertex(lx + pts[k][0], ly + pts[k][1], lz + pts[k][2], nx, ny, nz, uvs[k][0], uvs[k][1],
          clampByte(r), clampByte(g), clampByte(b), clampByte(alpha), s, bb, emitB, born);
      B.quad(false);
      n++;
    };
    const ins = 0.001;
    // top
    if (!same(above) && !(flags[above] & G_OCCLUDES)) {
      const t = h - ins;
      face([[0, t, 0], [0, t, 1], [1, t, 1], [1, t, 0]], 0, 1, 0, [[u0, v0], [u0, v1], [u1, v1], [u1, v0]]);
    }
    // bottom
    const below = P(x, y - 1, z);
    if (!same(below) && !(flags[below] & G_OCCLUDES)) face([[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], 0, -1, 0, [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]);
    // sides
    const sides = [
      [0, 0, -1, [[1, 0, 0], [0, 0, 0], [0, h, 0], [1, h, 0]]],
      [0, 0, 1, [[0, 0, 1], [1, 0, 1], [1, h, 1], [0, h, 1]]],
      [-1, 0, 0, [[0, 0, 0], [0, 0, 1], [0, h, 1], [0, h, 0]]],
      [1, 0, 0, [[1, 0, 1], [1, 0, 0], [1, h, 0], [1, h, 1]]],
    ];
    for (const [dx, , dz, pts] of sides) {
      const np = P(x + dx, y, z + dz);
      if (same(np) || (flags[np] & G_OCCLUDES)) continue;
      face(pts, dx, 0, dz, [[u0, v1], [u1, v1], [u1, vh], [u0, vh]]);
    }
    return n;
  }

  return {
    opaque: builders[0].finish(),
    cutout: builders[1].finish(),
    translucent: builders[2].finish(),
    quads,
  };
}

/** Is the palette index rendered at all (used by the raycaster) */
export function isSolidForPick(geo, p) {
  if (p === 0) return false;
  const f = geo.flags[p];
  if (f & G_INVISIBLE) return false;
  return geo.quads[p].length > 0 || (f & (G_WATER | G_LAVA)) !== 0;
}

/**
 * Voxel DDA raycast. Returns { pos:[x,y,z], normal:[nx,ny,nz], p } or null.
 * @param {{ cutY?: number|null, ignoreFluids?: boolean }} [opts]
 */
export function raycast(world, geo, origin, dir, maxDist = 1024, opts = {}) {
  const cutY = opts.cutY ?? null;
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const d = [dir[0] / len, dir[1] / len, dir[2] / len];
  // clip the ray against the world box (slab test)
  let t0 = 0, t1 = maxDist;
  for (let a = 0; a < 3; a++) {
    const lo = world.min[a], hi = world.max[a] + 1;
    if (Math.abs(d[a]) < 1e-12) {
      if (origin[a] < lo || origin[a] >= hi) return null;
      continue;
    }
    let ta = (lo - origin[a]) / d[a], tb = (hi - origin[a]) / d[a];
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  const o = [origin[0] + d[0] * (t0 + 1e-6), origin[1] + d[1] * (t0 + 1e-6), origin[2] + d[2] * (t0 + 1e-6)];
  let x = Math.floor(o[0]), y = Math.floor(o[1]), z = Math.floor(o[2]);
  const step = d.map((v) => (v > 0 ? 1 : v < 0 ? -1 : 0));
  const tDelta = d.map((v) => (v !== 0 ? Math.abs(1 / v) : Infinity));
  const pos = [x, y, z];
  const tMax = d.map((v, a) => (v === 0 ? Infinity : (v > 0 ? pos[a] + 1 - o[a] : o[a] - pos[a]) / Math.abs(v)));
  // entry face normal
  let normal = [0, 0, 0];
  if (t0 > 0) {
    let best = 0, bv = -1;
    for (let a = 0; a < 3; a++) {
      const lo = world.min[a], hi = world.max[a] + 1;
      const dist = Math.min(Math.abs(o[a] - lo), Math.abs(o[a] - hi));
      if (bv < 0 || dist < bv) { bv = dist; best = a; }
    }
    normal[best] = -step[best];
  }
  let t = 0;
  const maxSteps = world.sx + world.sy + world.sz + 3;
  for (let i = 0; i < maxSteps; i++) {
    if (!world.contains(x, y, z) || t > t1 - t0 + 1e-6) return null;
    if (!(cutY !== null && y > cutY)) {
      const p = world.get(x, y, z);
      const f = geo.flags[p];
      if (isSolidForPick(geo, p) && !(opts.ignoreFluids && (f & (G_WATER | G_LAVA)) && geo.quads[p].length === 0)) {
        return { pos: [x, y, z], normal, p, t: t0 + t };
      }
    }
    let a = 0;
    if (tMax[1] < tMax[a]) a = 1;
    if (tMax[2] < tMax[a]) a = 2;
    t = tMax[a];
    tMax[a] += tDelta[a];
    if (a === 0) x += step[0];
    else if (a === 1) y += step[1];
    else z += step[2];
    normal = [0, 0, 0];
    normal[a] = -step[a];
  }
  return null;
}

export { G_TRANSLUCENT };
