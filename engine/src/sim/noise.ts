// Seeded 2D gradient noise + helpers for terrain generation (deterministic, fast).

export function hash32(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
/** uniform [0,1) from integer coordinates + seed */
export function rand3(x: number, z: number, seed: number): number {
  return hash32(x, z, seed) / 4294967296;
}

export class Noise2 {
  private perm = new Uint8Array(512);
  private gx = new Float64Array(256);
  private gz = new Float64Array(256);
  constructor(seed: number) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    let s = seed >>> 0 || 1;
    const rnd = () => {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    for (let i = 0; i < 256; i++) {
      const a = rnd() * Math.PI * 2;
      this.gx[i] = Math.cos(a);
      this.gz[i] = Math.sin(a);
    }
  }
  /** gradient noise in about [-1, 1] */
  noise(x: number, z: number): number {
    const xi = Math.floor(x), zi = Math.floor(z);
    const xf = x - xi, zf = z - zi;
    const X = xi & 255, Z = zi & 255;
    const P = this.perm;
    const g = (h: number, dx: number, dz: number) => this.gx[h] * dx + this.gz[h] * dz;
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = zf * zf * zf * (zf * (zf * 6 - 15) + 10);
    const aa = P[P[X] + Z], ab = P[P[X] + Z + 1], ba = P[P[X + 1] + Z], bb = P[P[X + 1] + Z + 1];
    const x1 = g(aa, xf, zf) + u * (g(ba, xf - 1, zf) - g(aa, xf, zf));
    const x2 = g(ab, xf, zf - 1) + u * (g(bb, xf - 1, zf - 1) - g(ab, xf, zf - 1));
    return (x1 + v * (x2 - x1)) * 1.41;
  }
  fbm(x: number, z: number, oct: number, lac = 2, gain = 0.5): number {
    let a = 1, f = 1, s = 0, n = 0;
    for (let i = 0; i < oct; i++) {
      s += a * this.noise(x * f + i * 17.3, z * f - i * 31.7);
      n += a;
      a *= gain;
      f *= lac;
    }
    return s / n;
  }
  ridged(x: number, z: number, oct: number): number {
    let a = 1, f = 1, s = 0, n = 0;
    for (let i = 0; i < oct; i++) {
      const r = 1 - Math.abs(this.noise(x * f + i * 7.1, z * f + i * 3.3));
      s += a * r * r;
      n += a;
      a *= 0.5;
      f *= 2;
    }
    return s / n;
  }
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
