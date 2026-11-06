// Client-side voxel store + block geometry table (no DOM; used by the mesh worker and tests).

export const SECTION = 16;

// CompactGeometry flags (must match server/viewer-assets.ts)
export const G_OCCLUDES = 1, G_AO = 2, G_TRANSLUCENT = 4, G_WATER = 8, G_LAVA = 16, G_FLAT = 32, G_INVISIBLE = 64, G_CUTOUT = 128;
export const QUAD_STRIDE = 28;

export const DIRS = ['down', 'up', 'north', 'south', 'west', 'east'];
export const DIR_VEC = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];

export const TINT_NONE = 0, TINT_GRASS = 1, TINT_FOLIAGE = 2, TINT_DRY = 3, TINT_WATER = 4, TINT_FIXED = 5;
const TINT_CODE = { grass: TINT_GRASS, foliage: TINT_FOLIAGE, dry_foliage: TINT_DRY, water: TINT_WATER, fixed: TINT_FIXED };

export const srgbToLinear = (c) => Math.pow(c / 255, 2.2);

/** Dense block volume of a box (palette indices into a shared GeoTable) + light. */
export class VoxelWorld {
  /** @param {{min:number[],max:number[]}} box inclusive */
  constructor(box, data) {
    this.min = box.min.slice();
    this.max = box.max.slice();
    this.sx = box.max[0] - box.min[0] + 1;
    this.sy = box.max[1] - box.min[1] + 1;
    this.sz = box.max[2] - box.min[2] + 1;
    this.layer = this.sx * this.sz;
    const n = this.sx * this.sy * this.sz;
    this.data = data ?? new Uint16Array(n);
    if (this.data.length !== n) throw new Error('VoxelWorld: data size mismatch');
    this.sky = new Uint8Array(n);
    this.blk = new Uint8Array(n);
  }

  get box() {
    return { min: this.min.slice(), max: this.max.slice() };
  }

  contains(x, y, z) {
    return x >= this.min[0] && x <= this.max[0] && y >= this.min[1] && y <= this.max[1] && z >= this.min[2] && z <= this.max[2];
  }

  /** linear index or -1 */
  idx(x, y, z) {
    const lx = x - this.min[0], ly = y - this.min[1], lz = z - this.min[2];
    if (lx < 0 || ly < 0 || lz < 0 || lx >= this.sx || ly >= this.sy || lz >= this.sz) return -1;
    return ly * this.layer + lz * this.sx + lx;
  }

  get(x, y, z) {
    const i = this.idx(x, y, z);
    return i < 0 ? 0 : this.data[i];
  }

  set(x, y, z, p) {
    const i = this.idx(x, y, z);
    if (i >= 0) this.data[i] = p;
    return i;
  }

  /** inclusive section-coordinate range covering the box */
  sectionRange() {
    const f = (v) => Math.floor(v / SECTION);
    return { min: [f(this.min[0]), f(this.min[1]), f(this.min[2])], max: [f(this.max[0]), f(this.max[1]), f(this.max[2])] };
  }

  /** all section keys, nearest to `center` first */
  sectionsByDistance(center) {
    const r = this.sectionRange();
    const out = [];
    for (let y = r.min[1]; y <= r.max[1]; y++)
      for (let z = r.min[2]; z <= r.max[2]; z++)
        for (let x = r.min[0]; x <= r.max[0]; x++) {
          const cx = x * SECTION + 8, cy = y * SECTION + 8, cz = z * SECTION + 8;
          const d = center ? (cx - center[0]) ** 2 + ((cy - center[1]) * 1.5) ** 2 + (cz - center[2]) ** 2 : 0;
          out.push({ key: sectionKey(x, y, z), sc: [x, y, z], d });
        }
    out.sort((a, b) => a.d - b.d);
    return out;
  }
}

export const sectionKey = (x, y, z) => `${x},${y},${z}`;
export const parseSectionKey = (k) => k.split(',').map(Number);

/** Per palette index render data (filled from CompactGeometry). Index 0 = air. */
export class GeoTable {
  constructor() {
    this.cap = 0;
    this.states = [];
    this.quads = [];
    this.groupIds = new Map();
    this.grow(256);
    this.setAir(0);
  }

  grow(n) {
    if (n <= this.cap) return;
    let cap = Math.max(256, this.cap);
    while (cap < n) cap *= 2;
    const re = (C, old, k = 1) => {
      const a = new C(cap * k);
      if (old) a.set(old);
      return a;
    };
    this.flags = re(Uint16Array, this.flags);
    this.emit = re(Uint8Array, this.emit);
    this.group = re(Int32Array, this.group);
    this.tintKind = re(Uint8Array, this.tintKind);
    this.level = re(Uint8Array, this.level);
    this.dim = re(Uint8Array, this.dim);
    this.color = re(Float32Array, this.color, 4);
    this.tint = re(Float32Array, this.tint, 3);
    this.known = re(Uint8Array, this.known);
    this.cap = cap;
  }

  setAir(i) {
    this.grow(i + 1);
    this.states[i] = 'minecraft:air';
    this.flags[i] = G_INVISIBLE;
    this.quads[i] = new Float32Array(0);
    this.known[i] = 1;
  }

  has(i) {
    return i < this.cap && this.known[i] === 1;
  }

  /** @param {number} i @param {string} state @param {any} g CompactGeometry */
  set(i, state, g) {
    this.grow(i + 1);
    this.states[i] = state;
    if (/^minecraft:(air|cave_air|void_air)$/.test(state)) return this.setAir(i);
    this.flags[i] = g.f | 0;
    this.emit[i] = g.e | 0;
    this.level[i] = g.l | 0;
    let gid = 0;
    if (g.g) {
      gid = this.groupIds.get(g.g) ?? 0;
      if (!gid) this.groupIds.set(g.g, (gid = this.groupIds.size + 1));
    }
    this.group[i] = gid;
    this.tintKind[i] = TINT_CODE[g.k] ?? TINT_NONE;
    const c = g.c ?? [200, 200, 200, 255];
    this.color.set([srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]), (c[3] ?? 255) / 255], i * 4);
    const t = g.t ?? [255, 255, 255];
    this.tint.set([srgbToLinear(t[0]), srgbToLinear(t[1]), srgbToLinear(t[2])], i * 3);
    // light: leaves and water dim sky/block light by one extra level
    this.dim[i] = (g.f & G_WATER) !== 0 || /_leaves$/.test(g.g ?? '') ? 1 : 0;
    this.quads[i] = g.q instanceof Float32Array ? g.q : new Float32Array(g.q ?? []);
    this.known[i] = 1;
  }

  occludes(i) {
    return (this.flags[i] & G_OCCLUDES) !== 0;
  }
}

/** Client-side fallback geometry (unit cube, flat color) when the engine cannot provide geometry. */
export function fallbackGeometry(state) {
  const id = String(state).replace(/^minecraft:/, '').replace(/[[{].*$/, '');
  if (/^(air|cave_air|void_air|barrier|light|structure_void)$/.test(id)) return { f: G_INVISIBLE, c: [0, 0, 0, 0], t: null, k: null, e: 0, l: 0, g: '', q: [] };
  const water = id === 'water' || id === 'bubble_column';
  const lava = id === 'lava';
  const c = fallbackColor(id);
  const glassy = /glass|ice/.test(id);
  const plant = /grass$|fern|flower|tulip|poppy|dandelion|sapling|bush|torch|rose|daisy|orchid|allium|bluet|cornflower|lily|kelp|seagrass|vine/.test(id) && !/block/.test(id);
  if (water || lava) return { f: (water ? G_WATER | G_TRANSLUCENT : G_LAVA) | G_FLAT, c, t: null, k: null, e: lava ? 15 : 0, l: 0, g: '', q: [] };
  const q = [];
  const s = plant ? [0.3, 0, 0.3, 0.7, 0.6, 0.7] : [0, 0, 0, 1, 1, 1];
  const layer = glassy ? 2 : 0;
  const faces = [
    [0, [0, -1, 0], [[s[0], s[1], s[2]], [s[3], s[1], s[2]], [s[3], s[1], s[5]], [s[0], s[1], s[5]]]],
    [1, [0, 1, 0], [[s[0], s[4], s[2]], [s[0], s[4], s[5]], [s[3], s[4], s[5]], [s[3], s[4], s[2]]]],
    [2, [0, 0, -1], [[s[0], s[1], s[2]], [s[0], s[4], s[2]], [s[3], s[4], s[2]], [s[3], s[1], s[2]]]],
    [3, [0, 0, 1], [[s[0], s[1], s[5]], [s[3], s[1], s[5]], [s[3], s[4], s[5]], [s[0], s[4], s[5]]]],
    [4, [-1, 0, 0], [[s[0], s[1], s[2]], [s[0], s[1], s[5]], [s[0], s[4], s[5]], [s[0], s[4], s[2]]]],
    [5, [1, 0, 0], [[s[3], s[1], s[2]], [s[3], s[4], s[2]], [s[3], s[4], s[5]], [s[3], s[1], s[5]]]],
  ];
  for (const [d, n, pts] of faces) {
    q.push(plant ? -1 : d, 0, 1, layer, n[0], n[1], n[2], d);
    for (const p of pts) q.push(p[0], p[1], p[2], -1, -1);
  }
  return { f: (plant || glassy ? 0 : G_OCCLUDES) | G_AO | G_FLAT | (glassy ? G_TRANSLUCENT : 0), c, t: null, k: null, e: /torch|lantern|glowstone|lamp/.test(id) ? 14 : 0, l: 0, g: glassy ? id : '', q };
}

const FALLBACK_COLORS = [
  [/grass_block/, [124, 176, 74]], [/leaves/, [74, 143, 42]], [/water/, [63, 118, 228, 160]], [/lava/, [207, 91, 19]],
  [/sand/, [219, 211, 160]], [/glass/, [200, 220, 240, 90]], [/dirt|path|farmland/, [134, 96, 67]], [/log|wood/, [107, 82, 51]],
  [/planks|stairs|slab|fence|door/, [162, 131, 79]], [/brick/, [150, 98, 83]], [/snow/, [249, 254, 254]], [/gravel/, [132, 127, 126]],
  [/deepslate/, [80, 80, 85]], [/cobble/, [122, 122, 122]], [/stone/, [125, 125, 125]], [/grass|fern|bush/, [94, 154, 53]],
];

export function fallbackColor(id) {
  for (const [re, c] of FALLBACK_COLORS) if (re.test(id)) return [c[0], c[1], c[2], c[3] ?? 255];
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  const v = 110 + ((h >>> 0) % 90);
  return [v, v - 5 + ((h >>> 8) % 10), v - 10 + ((h >>> 16) % 20), 255];
}
