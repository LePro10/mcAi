// Fast map keyed by integer block positions.
//
// x and z (|v| < 2^25 ≈ 33.5M, covers the ±30M world border) are packed exactly into one
// 52-bit safe integer; y selects a per-layer Map (y is not range-limited). A single packed
// key for all three axes would need 61+ bits, which does not fit a JS double exactly.

const OFF = 33554432; // 2^25
const MUL = 67108864; // 2^26

export function packXZ(x: number, z: number): number {
  return (x + OFF) * MUL + (z + OFF);
}

export function unpackXZ(k: number): [number, number] {
  const z = (k % MUL) - OFF;
  const x = Math.floor(k / MUL) - OFF;
  return [x, z];
}

export function checkCoord(x: number, y: number, z: number): void {
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) {
    throw new TypeError(`block coordinates must be integers, got (${x},${y},${z})`);
  }
  if (x <= -OFF || x >= OFF || z <= -OFF || z >= OFF) {
    throw new RangeError(`position (${x},${y},${z}) is outside the world (|x|,|z| must be < 33554432)`);
  }
}

export class PosMap<V> {
  private layers = new Map<number, Map<number, V>>();
  private lastY = NaN;
  private lastLayer: Map<number, V> | undefined;
  private count = 0;

  get size(): number {
    return this.count;
  }

  private layer(y: number, create: boolean): Map<number, V> | undefined {
    if (y === this.lastY && this.lastLayer) return this.lastLayer;
    let l = this.layers.get(y);
    if (!l && create) {
      l = new Map();
      this.layers.set(y, l);
    }
    if (l) {
      this.lastY = y;
      this.lastLayer = l;
    }
    return l;
  }

  get(x: number, y: number, z: number): V | undefined {
    return this.layer(y, false)?.get(packXZ(x, z));
  }

  has(x: number, y: number, z: number): boolean {
    return this.layer(y, false)?.has(packXZ(x, z)) ?? false;
  }

  set(x: number, y: number, z: number, v: V): this {
    const l = this.layer(y, true)!;
    const k = packXZ(x, z);
    if (!l.has(k)) this.count++;
    l.set(k, v);
    return this;
  }

  delete(x: number, y: number, z: number): boolean {
    const l = this.layer(y, false);
    if (!l) return false;
    const ok = l.delete(packXZ(x, z));
    if (ok) this.count--;
    if (l.size === 0) {
      this.layers.delete(y);
      if (this.lastLayer === l) {
        this.lastLayer = undefined;
        this.lastY = NaN;
      }
    }
    return ok;
  }

  clear(): void {
    this.layers.clear();
    this.lastLayer = undefined;
    this.lastY = NaN;
    this.count = 0;
  }

  forEach(cb: (v: V, x: number, y: number, z: number) => void): void {
    for (const [y, l] of this.layers) {
      for (const [k, v] of l) {
        const [x, z] = unpackXZ(k);
        cb(v, x, y, z);
      }
    }
  }

  *entries(): Generator<[number, number, number, V]> {
    for (const [y, l] of this.layers) {
      for (const [k, v] of l) {
        const [x, z] = unpackXZ(k);
        yield [x, y, z, v];
      }
    }
  }
}
