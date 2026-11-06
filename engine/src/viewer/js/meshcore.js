// The mesh worker's brain (DOM-free so node tests can drive it): owns the voxel copy of the
// viewed area, the geometry table, light, pop-in birth times and the dirty-section queue.
// Messages in (all objects with `t`):
//   geo     { entries: [index, state, CompactGeometry][], fluids?, waterTint?, remeshAll? }
//   volume  { box, data: Uint16Array (global palette indices), center }
//   edit    { positions: Int32Array, states: Uint16Array (global), now, animate }
//   biomes  { x0, z0, nx, nz, step, data: Uint16Array, tints: {grass,foliage,dry_foliage,water}[] (sRGB) }
//   cut     { y: number | null }
//   focus   { center }
//   raycast { id, origin, dir, maxDist? }
//   stats   { id }
// Messages out: section { key, sc, layers, quads, rev }, progress { done, total }, loaded { ms, sections, quads },
//   ray { id, hit }, edited { count, ms }, stats { id, ... }
import { VoxelWorld, GeoTable, SECTION, sectionKey, parseSectionKey, srgbToLinear, TINT_GRASS, TINT_FOLIAGE, TINT_DRY, TINT_WATER } from './voxels.js';
import { computeLight } from './lighting.js';
import { meshSection, raycast, bufferList, NO_BORN } from './mesher.js';

const POP_SECONDS = 6; // birth entries are forgotten after this

export class MeshCore {
  /** @param {(msg: any, transfer?: ArrayBuffer[]) => void} post */
  constructor(post) {
    this.post = post;
    this.geo = new GeoTable();
    this.world = null;
    this.cutY = null;
    this.center = [0, 64, 0];
    this.dirty = new Set();
    this.born = new Map();
    this.fluids = { water: null, lava: null };
    this.waterTint = [srgbToLinear(0x3f), srgbToLinear(0x76), srgbToLinear(0xe4)];
    this.biomes = null;
    this.loadStart = 0;
    this.loadTotal = 0;
    this.loading = false;
    this.totalQuads = new Map();
    this.pendingLight = null; // region box to relight
    this.rev = 0;
    this.lastNow = 0;
  }

  handle(m) {
    switch (m.t) {
      case 'geo': return this.setGeo(m);
      case 'volume': return this.loadVolume(m.box, m.data, m.center);
      case 'edit': return this.applyEdit(m.positions, m.states, m.now ?? 0, m.animate !== false);
      case 'biomes': return this.setBiomes(m);
      case 'cut': return this.setCut(m.y ?? null);
      case 'focus': this.center = m.center ?? this.center; return;
      case 'raycast': {
        const hit = this.world ? raycast(this.world, this.geo, m.origin, m.dir, m.maxDist ?? 1024, { cutY: this.cutY, ignoreFluids: m.ignoreFluids }) : null;
        const out = hit ? { ...hit, state: this.geo.states[hit.p] } : null;
        return this.post({ t: 'ray', id: m.id, hit: out });
      }
      case 'stats': return this.post({ t: 'stats', id: m.id, ...this.stats() });
      default: return;
    }
  }

  stats() {
    let quads = 0;
    for (const v of this.totalQuads.values()) quads += v;
    return { quads, sections: this.totalQuads.size, dirty: this.dirty.size, box: this.world?.box ?? null, palette: this.geo.states.length };
  }

  setGeo(m) {
    for (const [i, state, g] of m.entries ?? []) this.geo.set(i, state, g);
    if (m.fluids) this.fluids = m.fluids;
    if (m.waterTint) this.waterTint = m.waterTint.map(srgbToLinear);
    if (m.remeshAll && this.world) this.markAll();
  }

  setBiomes(m) {
    const tints = (m.tints ?? []).map((t) => ({
      [TINT_GRASS]: t.grass.map(srgbToLinear),
      [TINT_FOLIAGE]: t.foliage.map(srgbToLinear),
      [TINT_DRY]: (t.dry_foliage ?? t.foliage).map(srgbToLinear),
      [TINT_WATER]: t.water.map(srgbToLinear),
    }));
    this.biomes = { ...m, tints };
    if (this.world && !m.silent) this.markAll();
  }

  /** biome tint (bilinear between biome samples), linear rgb */
  tintAt = (x, z, kind) => {
    const b = this.biomes;
    if (!b || !b.tints.length) {
      if (kind === TINT_WATER) return this.waterTint;
      return kind === TINT_FOLIAGE ? FOLIAGE : kind === TINT_DRY ? DRY : GRASS;
    }
    const fx = (x - b.x0) / b.step - 0.5, fz = (z - b.z0) / b.step - 0.5;
    const i0 = Math.max(0, Math.min(b.nx - 1, Math.floor(fx))), k0 = Math.max(0, Math.min(b.nz - 1, Math.floor(fz)));
    const i1 = Math.min(b.nx - 1, i0 + 1), k1 = Math.min(b.nz - 1, k0 + 1);
    const tx = Math.max(0, Math.min(1, fx - i0)), tz = Math.max(0, Math.min(1, fz - k0));
    const s = (i, k) => b.tints[b.data[k * b.nx + i]]?.[kind] ?? GRASS;
    const a = s(i0, k0), c = s(i1, k0), d = s(i0, k1), e = s(i1, k1);
    const out = [0, 0, 0];
    for (let j = 0; j < 3; j++) out[j] = (a[j] * (1 - tx) + c[j] * tx) * (1 - tz) + (d[j] * (1 - tx) + e[j] * tx) * tz;
    return out;
  };

  loadVolume(box, data, center) {
    const t0 = Date.now();
    this.world = new VoxelWorld(box, data instanceof Uint16Array ? data : new Uint16Array(data));
    if (center) this.center = center;
    this.born.clear();
    this.totalQuads.clear();
    computeLight(this.world, this.geo);
    this.dirty.clear();
    this.rev++;
    this.markAll();
    this.loading = true;
    this.loadStart = t0;
    this.loadTotal = this.dirty.size;
    this.post({ t: 'progress', done: 0, total: this.loadTotal, lightMs: Date.now() - t0, rev: this.rev });
  }

  markAll() {
    if (!this.world) return;
    for (const s of this.world.sectionsByDistance(null)) this.dirty.add(s.key);
  }

  /** mark the section of world cell (x,y,z) dirty, plus neighbours when the cell is on a section border */
  markCell(x, y, z) {
    const sx = Math.floor(x / SECTION), sy = Math.floor(y / SECTION), sz = Math.floor(z / SECTION);
    const lx = x - sx * SECTION, ly = y - sy * SECTION, lz = z - sz * SECTION;
    const ax = lx === 0 ? -1 : lx === SECTION - 1 ? 1 : 0;
    const ay = ly === 0 ? -1 : ly === SECTION - 1 ? 1 : 0;
    const az = lz === 0 ? -1 : lz === SECTION - 1 ? 1 : 0;
    for (const dx of ax ? [0, ax] : [0])
      for (const dy of ay ? [0, ay] : [0])
        for (const dz of az ? [0, az] : [0]) this.dirty.add(sectionKey(sx + dx, sy + dy, sz + dz));
  }

  applyEdit(positions, states, now, animate) {
    const w = this.world;
    if (!w) return;
    const t0 = Date.now();
    this.lastNow = now;
    const n = Math.min(states.length, Math.floor(positions.length / 3));
    let minY = Infinity, maxY = -Infinity;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    let changed = 0;
    const placed = [];
    for (let i = 0; i < n; i++) {
      const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
      const li = w.idx(x, y, z);
      if (li < 0) continue;
      const p = states[i];
      if (w.data[li] === p) continue;
      w.data[li] = p;
      changed++;
      if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
      if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
      if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
      this.markCell(x, y, z);
      if (p !== 0 && animate) {
        placed.push(li, y);
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    // pop-in: stagger by layer so big batches rise bottom-up (≤ ~1.6 s in total)
    if (placed.length && placed.length / 2 <= 60000) {
      const layers = maxY - minY + 1;
      const stagger = Math.min(0.07, 1.6 / Math.max(1, layers));
      for (let k = 0; k < placed.length; k += 2) this.born.set(placed[k], now + (placed[k + 1] - minY) * stagger);
    }
    if (this.born.size > 200000 || (this.born.size && Math.random() < 0.1)) {
      for (const [k, v] of this.born) if (v < now - POP_SECONDS) this.born.delete(k);
    }
    if (changed) {
      const r = { min: [min[0] - 15, w.min[1], min[2] - 15], max: [max[0] + 15, max[1] + 15, max[2] + 15] };
      this.pendingLight = this.pendingLight ? unionBox(this.pendingLight, r) : r;
    }
    this.post({ t: 'edited', count: changed, ms: Date.now() - t0 });
  }

  flushLight() {
    if (!this.pendingLight || !this.world) return;
    const r = this.pendingLight;
    this.pendingLight = null;
    const w = this.world;
    const ch = computeLight(w, this.geo, r, true);
    for (const li of ch) {
      const x = li % w.sx, z = ((li / w.sx) | 0) % w.sz, y = (li / w.layer) | 0;
      // light at a cell is sampled by faces of all 26 neighbours
      this.markLightCell(x + w.min[0], y + w.min[1], z + w.min[2]);
    }
  }

  markLightCell(x, y, z) {
    const sx = Math.floor(x / SECTION), sy = Math.floor(y / SECTION), sz = Math.floor(z / SECTION);
    const lx = x - sx * SECTION, ly = y - sy * SECTION, lz = z - sz * SECTION;
    if (lx > 0 && lx < SECTION - 1 && ly > 0 && ly < SECTION - 1 && lz > 0 && lz < SECTION - 1) {
      this.dirty.add(sectionKey(sx, sy, sz));
      return;
    }
    this.markCell(x, y, z);
  }

  setCut(y) {
    const old = this.cutY;
    this.cutY = y === null || y === undefined ? null : Math.floor(y);
    if (!this.world || old === this.cutY) return;
    const r = this.world.sectionRange();
    const layerOf = (c) => (c === null ? null : Math.floor(c / SECTION));
    for (const c of [layerOf(old), layerOf(this.cutY)]) {
      if (c === null) continue;
      for (let z = r.min[2]; z <= r.max[2]; z++) for (let x = r.min[0]; x <= r.max[0]; x++) this.dirty.add(sectionKey(x, c, z));
    }
  }

  /** cut value relevant for a section (null when the cut does not intersect it) */
  cutFor(sy) {
    const c = this.cutY;
    if (c === null) return null;
    const oy = sy * SECTION;
    return c >= oy && c <= oy + SECTION - 1 ? c : null;
  }

  /** mesh dirty sections (nearest first) for up to `budgetMs`; returns sections meshed */
  process(budgetMs = 12) {
    if (this.pendingLight) this.flushLight();
    if (!this.world || !this.dirty.size) return 0;
    const t0 = Date.now();
    const c = this.center;
    const keys = [...this.dirty].map((k) => {
      const [x, y, z] = parseSectionKey(k);
      return { k, x, y, z, d: (x * 16 + 8 - c[0]) ** 2 + ((y * 16 + 8 - c[1]) * 1.5) ** 2 + (z * 16 + 8 - c[2]) ** 2 };
    });
    keys.sort((a, b) => a.d - b.d);
    let n = 0;
    const r = this.world.sectionRange();
    const bornAt = this.born.size ? (li) => this.born.get(li) ?? NO_BORN : null;
    for (const s of keys) {
      this.dirty.delete(s.k);
      if (s.x < r.min[0] || s.x > r.max[0] || s.y < r.min[1] || s.y > r.max[1] || s.z < r.min[2] || s.z > r.max[2]) continue;
      const m = meshSection(this.world, this.geo, s.x, s.y, s.z, {
        cutY: this.cutFor(s.y), tintAt: this.tintAt, bornAt, fluids: this.fluids, waterTint: this.waterTint,
      });
      this.totalQuads.set(s.k, m.quads);
      const layers = { opaque: m.opaque, cutout: m.cutout, translucent: m.translucent };
      this.post({ t: 'section', key: s.k, sc: [s.x, s.y, s.z], layers, quads: m.quads, rev: this.rev }, bufferList(layers));
      n++;
      if (Date.now() - t0 > budgetMs) break;
    }
    if (this.loading) {
      const done = this.loadTotal - Math.min(this.loadTotal, this.dirty.size);
      this.post({ t: 'progress', done, total: this.loadTotal, rev: this.rev });
      if (!this.dirty.size) {
        this.loading = false;
        this.post({ t: 'loaded', ms: Date.now() - this.loadStart, rev: this.rev, ...this.stats() });
      }
    }
    return n;
  }
}

const GRASS = [0x91, 0xbd, 0x59].map(srgbToLinear);
const FOLIAGE = [0x77, 0xab, 0x2f].map(srgbToLinear);
const DRY = [0xa0, 0x8a, 0x5a].map(srgbToLinear);

function unionBox(a, b) {
  return { min: a.min.map((v, i) => Math.min(v, b.min[i])), max: a.max.map((v, i) => Math.max(v, b.max[i])) };
}
