// Seeded randomness: PRNG (mulberry32), simplex noise 2D/3D and fBm.

export function hashSeed(seed: number | string | undefined): number {
  if (seed === undefined) return 0x9e3779b9;
  if (typeof seed === 'number') {
    // mix numbers so nearby seeds give unrelated streams
    let h = Math.floor(seed) ^ 0x5bd1e995;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
  }
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** mulberry32: fast 32-bit seeded PRNG → [0, 1) */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  /** [0, 1) */
  rand(): number;
  /** integer in [a, b] inclusive */
  randInt(a: number, b: number): number;
  /** float in [a, b) */
  range(a: number, b: number): number;
  chance(p: number): boolean;
  choice<T>(arr: readonly T[]): T;
  /** weighted choice: [[item, weight], ...] */
  weighted<T>(items: readonly (readonly [T, number])[]): T;
  shuffle<T>(arr: T[]): T[];
  /** child generator with an independent stream */
  fork(salt?: number | string): Rng;
}

export function createRng(seed?: number | string): Rng {
  const base = hashSeed(seed);
  const r = mulberry32(base);
  const rng: Rng = {
    rand: r,
    randInt: (a, b) => {
      const lo = Math.ceil(Math.min(a, b));
      const hi = Math.floor(Math.max(a, b));
      return lo + Math.floor(r() * (hi - lo + 1));
    },
    range: (a, b) => a + r() * (b - a),
    chance: (p) => r() < p,
    choice: (arr) => {
      if (!arr.length) throw new Error('choice() of an empty array');
      return arr[Math.floor(r() * arr.length)];
    },
    weighted: (items) => {
      let total = 0;
      for (const [, w] of items) total += Math.max(0, w);
      let x = r() * total;
      for (const [it, w] of items) {
        x -= Math.max(0, w);
        if (x < 0) return it;
      }
      return items[items.length - 1][0];
    },
    shuffle: (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    },
    fork: (salt) => createRng((base ^ hashSeed(salt ?? Math.floor(r() * 4294967296))) >>> 0),
  };
  return rng;
}

// ------------------------------------------------------------------ simplex noise

const GRAD3 = new Float64Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const F3 = 1 / 3;
const G3 = 1 / 6;

export interface Noise {
  /** simplex noise in [-1, 1] */
  noise2(x: number, y: number): number;
  noise3(x: number, y: number, z: number): number;
  /** fractal Brownian motion of noise2, roughly in [-1, 1] */
  fbm2(x: number, y: number, octaves?: number, lacunarity?: number, gain?: number): number;
  fbm3(x: number, y: number, z: number, octaves?: number, lacunarity?: number, gain?: number): number;
}

export function createNoise(seed?: number | string): Noise {
  const r = mulberry32(hashSeed(seed) ^ 0x2545f491);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  const perm = new Uint8Array(512);
  const perm12 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255];
    perm12[i] = perm[i] % 12;
  }

  function noise2(xin: number, yin: number): number {
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    let n0 = 0;
    let n1 = 0;
    let n2 = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) {
      const g = perm12[ii + perm[jj]] * 3;
      t0 *= t0;
      n0 = t0 * t0 * (GRAD3[g] * x0 + GRAD3[g + 1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) {
      const g = perm12[ii + i1 + perm[jj + j1]] * 3;
      t1 *= t1;
      n1 = t1 * t1 * (GRAD3[g] * x1 + GRAD3[g + 1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) {
      const g = perm12[ii + 1 + perm[jj + 1]] * 3;
      t2 *= t2;
      n2 = t2 * t2 * (GRAD3[g] * x2 + GRAD3[g + 1] * y2);
    }
    return 70 * (n0 + n1 + n2);
  }

  function noise3(xin: number, yin: number, zin: number): number {
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const z0 = zin - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) [i1, j1, k1, i2, j2, k2] = [1, 0, 0, 1, 1, 0];
      else if (x0 >= z0) [i1, j1, k1, i2, j2, k2] = [1, 0, 0, 1, 0, 1];
      else [i1, j1, k1, i2, j2, k2] = [0, 0, 1, 1, 0, 1];
    } else {
      if (y0 < z0) [i1, j1, k1, i2, j2, k2] = [0, 0, 1, 0, 1, 1];
      else if (x0 < z0) [i1, j1, k1, i2, j2, k2] = [0, 1, 0, 0, 1, 1];
      else [i1, j1, k1, i2, j2, k2] = [0, 1, 0, 1, 1, 0];
    }
    const x1 = x0 - i1 + G3;
    const y1 = y0 - j1 + G3;
    const z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3;
    const y2 = y0 - j2 + 2 * G3;
    const z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3;
    const y3 = y0 - 1 + 3 * G3;
    const z3 = z0 - 1 + 3 * G3;
    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;
    let n = 0;
    let tt = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (tt > 0) {
      const g = perm12[ii + perm[jj + perm[kk]]] * 3;
      tt *= tt;
      n += tt * tt * (GRAD3[g] * x0 + GRAD3[g + 1] * y0 + GRAD3[g + 2] * z0);
    }
    tt = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (tt > 0) {
      const g = perm12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3;
      tt *= tt;
      n += tt * tt * (GRAD3[g] * x1 + GRAD3[g + 1] * y1 + GRAD3[g + 2] * z1);
    }
    tt = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (tt > 0) {
      const g = perm12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3;
      tt *= tt;
      n += tt * tt * (GRAD3[g] * x2 + GRAD3[g + 1] * y2 + GRAD3[g + 2] * z2);
    }
    tt = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (tt > 0) {
      const g = perm12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3;
      tt *= tt;
      n += tt * tt * (GRAD3[g] * x3 + GRAD3[g + 1] * y3 + GRAD3[g + 2] * z3);
    }
    return 32 * n;
  }

  function fbm2(x: number, y: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
    let amp = 1;
    let f = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < Math.min(12, Math.max(1, octaves)); o++) {
      sum += amp * noise2(x * f + o * 17.31, y * f - o * 9.73);
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }

  function fbm3(x: number, y: number, z: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
    let amp = 1;
    let f = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < Math.min(12, Math.max(1, octaves)); o++) {
      sum += amp * noise3(x * f + o * 17.31, y * f + o * 5.17, z * f - o * 9.73);
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }

  return { noise2, noise3, fbm2, fbm3 };
}
