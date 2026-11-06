// Minecraft-like light propagation for the viewer (sky light from above + block light from
// emitters), 0..15 per cell, stored in VoxelWorld.sky / .blk. No DOM.
import { G_OCCLUDES } from './voxels.js';

class Queue {
  constructor(cap) {
    this.a = new Int32Array(Math.max(1024, cap));
    this.h = 0;
    this.n = 0;
  }
  push(v) {
    if (this.n === this.a.length) {
      const b = new Int32Array(this.a.length * 2);
      for (let i = 0; i < this.n; i++) b[i] = this.a[(this.h + i) % this.a.length];
      this.a = b;
      this.h = 0;
    }
    this.a[(this.h + this.n) % this.a.length] = v;
    this.n++;
  }
  shift() {
    const v = this.a[this.h];
    this.h = (this.h + 1) % this.a.length;
    this.n--;
    return v;
  }
}

/**
 * (Re)compute light inside `region` (world coords, inclusive; default = whole world).
 * Cells outside the region keep their values and act as sources at the border, so a
 * region expanded by 15 around a change is exact for block light; sky columns are taken
 * from the cell above the region.
 * @returns {Set<number>|null} linear indices whose light changed (null when `track` is false)
 */
export function computeLight(world, geo, region = null, track = false) {
  const { sx, sy, sz, layer, data, sky, blk } = world;
  const x0 = region ? Math.max(0, region.min[0] - world.min[0]) : 0;
  const y0 = region ? Math.max(0, region.min[1] - world.min[1]) : 0;
  const z0 = region ? Math.max(0, region.min[2] - world.min[2]) : 0;
  const x1 = region ? Math.min(sx - 1, region.max[0] - world.min[0]) : sx - 1;
  const y1 = region ? Math.min(sy - 1, region.max[1] - world.min[1]) : sy - 1;
  const z1 = region ? Math.min(sz - 1, region.max[2] - world.min[2]) : sz - 1;
  if (x1 < x0 || y1 < y0 || z1 < z0) return track ? new Set() : null;
  const flags = geo.flags, dimA = geo.dim, emit = geo.emit;
  const opaque = (i) => (flags[data[i]] & G_OCCLUDES) !== 0;
  const inR = (x, y, z) => x >= x0 && x <= x1 && y >= y0 && y <= y1 && z >= z0 && z <= z1;

  let oldSky = null, oldBlk = null;
  const rsx = x1 - x0 + 1, rsz = z1 - z0 + 1, rsy = y1 - y0 + 1;
  if (track) {
    oldSky = new Uint8Array(rsx * rsy * rsz);
    oldBlk = new Uint8Array(rsx * rsy * rsz);
  }
  for (let y = y0, k = 0; y <= y1; y++)
    for (let z = z0; z <= z1; z++) {
      const base = y * layer + z * sx;
      for (let x = x0; x <= x1; x++, k++) {
        const i = base + x;
        if (track) {
          oldSky[k] = sky[i];
          oldBlk[k] = blk[i];
        }
        sky[i] = 0;
        blk[i] = 0;
      }
    }

  const q = new Queue(rsx * rsz * 8);
  // sky: straight down from the top of the region
  for (let z = z0; z <= z1; z++)
    for (let x = x0; x <= x1; x++) {
      let level = y1 === sy - 1 ? 15 : sky[(y1 + 1) * layer + z * sx + x];
      if (level < 15) continue; // not open sky → filled by spreading
      for (let y = y1; y >= y0; y--) {
        const i = y * layer + z * sx + x;
        if (opaque(i)) break;
        level -= dimA[data[i]];
        if (level <= 0) break;
        sky[i] = level;
        q.push(i);
      }
    }
  const seedBorder = (L) => {
    if (!region) return;
    const tryPush = (x, y, z) => {
      if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return;
      const i = y * layer + z * sx + x;
      if (L[i] > 1) q.push(i);
    };
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++) {
        tryPush(x0 - 1, y, z);
        tryPush(x1 + 1, y, z);
      }
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        tryPush(x, y, z0 - 1);
        tryPush(x, y, z1 + 1);
      }
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        tryPush(x, y0 - 1, z);
        tryPush(x, y1 + 1, z);
      }
  };
  const spread = (L) => {
    while (q.n > 0) {
      const i = q.shift();
      const l = L[i];
      if (l <= 1) continue;
      const x = i % sx, z = ((i / sx) | 0) % sz, y = (i / layer) | 0;
      for (let k = 0; k < 6; k++) {
        let nx = x, ny = y, nz = z;
        if (k === 0) nx--;
        else if (k === 1) nx++;
        else if (k === 2) nz--;
        else if (k === 3) nz++;
        else if (k === 4) ny--;
        else ny++;
        if (!inR(nx, ny, nz)) continue;
        const j = ny * layer + nz * sx + nx;
        if (opaque(j)) continue;
        const nl = l - 1 - dimA[data[j]];
        if (nl > L[j]) {
          L[j] = nl;
          q.push(j);
        }
      }
    }
  };
  seedBorder(sky);
  spread(sky);
  for (let y = y0; y <= y1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        const i = y * layer + z * sx + x;
        const e = emit[data[i]];
        if (e > 0) {
          blk[i] = e;
          q.push(i);
        }
      }
  seedBorder(blk);
  spread(blk);

  if (!track) return null;
  const changed = new Set();
  for (let y = y0, k = 0; y <= y1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++, k++) {
        const i = y * layer + z * sx + x;
        if (sky[i] !== oldSky[k] || blk[i] !== oldBlk[k]) changed.add(i);
      }
  return changed;
}
