import type { FillBox, Vec3, Voxel } from './types.js';
import { isAir } from './blocks.js';

/** Coordinate range a blueprint may occupy, relative to its origin. */
const OFFSET = 4096;
const SPAN = OFFSET * 2;

/** Pack a coordinate triple into a single number key (exact up to 2^53). */
export function packKey(x: number, y: number, z: number): number {
  return ((x + OFFSET) * SPAN + (y + OFFSET)) * SPAN + (z + OFFSET);
}

export function unpackKey(k: number): Vec3 {
  const z = (k % SPAN) - OFFSET;
  const rest = (k - (z + OFFSET)) / SPAN;
  const y = (rest % SPAN) - OFFSET;
  const x = (rest - (y + OFFSET)) / SPAN - OFFSET;
  return [x, y, z];
}

export class VoxelLimitError extends Error {
  constructor(public readonly limit: number) {
    super(
      `Blueprint exceeds the voxel budget (${limit.toLocaleString()} blocks). ` +
      `Reduce the size, or split it into several builds.`,
    );
    this.name = 'VoxelLimitError';
  }
}

/**
 * Sparse voxel buffer. Later writes win by default, which lets a blueprint read
 * top-down: lay a solid box, then carve windows, then drop in furniture.
 */
export class VoxelBuffer {
  private map = new Map<number, string>();
  minX = Infinity; minY = Infinity; minZ = Infinity;
  maxX = -Infinity; maxY = -Infinity; maxZ = -Infinity;

  constructor(public readonly limit = 3_000_000) {}

  get size(): number { return this.map.size; }
  get isEmpty(): boolean { return this.map.size === 0; }

  /**
   * Voxels that place an actual block.
   *
   * Site clearing writes a great deal of air, which is cheap to emit but would
   * otherwise inflate any decision keyed on size — most importantly the
   * texture-detail heuristic, which would coarsen a small building just because
   * it stands in a tall clearing.
   */
  get solidCount(): number {
    let n = 0;
    for (const block of this.map.values()) if (!isAir(block)) n++;
    return n;
  }

  set(x: number, y: number, z: number, block: string, keep = false): void {
    x = Math.round(x); y = Math.round(y); z = Math.round(z);
    if (Math.abs(x) >= OFFSET || Math.abs(y) >= OFFSET || Math.abs(z) >= OFFSET) return;
    const k = packKey(x, y, z);
    if (keep && this.map.has(k)) return;
    if (!this.map.has(k)) {
      if (this.map.size >= this.limit) throw new VoxelLimitError(this.limit);
      if (x < this.minX) this.minX = x;
      if (y < this.minY) this.minY = y;
      if (z < this.minZ) this.minZ = z;
      if (x > this.maxX) this.maxX = x;
      if (y > this.maxY) this.maxY = y;
      if (z > this.maxZ) this.maxZ = z;
    }
    this.map.set(k, block);
  }

  get(x: number, y: number, z: number): string | undefined {
    return this.map.get(packKey(Math.round(x), Math.round(y), Math.round(z)));
  }

  has(x: number, y: number, z: number): boolean {
    return this.map.has(packKey(Math.round(x), Math.round(y), Math.round(z)));
  }

  /** True when the position holds a non-air block. */
  isSolid(x: number, y: number, z: number): boolean {
    const b = this.get(x, y, z);
    return b !== undefined && !isAir(b);
  }

  delete(x: number, y: number, z: number): void {
    this.map.delete(packKey(Math.round(x), Math.round(y), Math.round(z)));
  }

  entries(): IterableIterator<[number, string]> { return this.map.entries(); }

  *voxels(): Generator<Voxel> {
    for (const [k, block] of this.map) {
      const [x, y, z] = unpackKey(k);
      yield { x, y, z, block };
    }
  }

  /** Translate the whole buffer. Used when resolving the world anchor. */
  translated(dx: number, dy: number, dz: number): VoxelBuffer {
    const out = new VoxelBuffer(this.limit);
    for (const [k, block] of this.map) {
      const [x, y, z] = unpackKey(k);
      out.set(x + dx, y + dy, z + dz, block);
    }
    return out;
  }

  blockCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const b of this.map.values()) counts[b] = (counts[b] || 0) + 1;
    return counts;
  }
}

/**
 * Greedy 3D box decomposition.
 *
 * This is the heart of mcAI's speed story. A hollow 20×8×20 stone wall is 1,184
 * voxels; naive `/setblock` needs 1,184 commands. Merging maximal axis-aligned
 * runs of identical blocks turns it into 4. Fewer commands means fewer RCON
 * round trips, less server strain, and a build that lands in seconds.
 *
 * The algorithm walks voxels in (y, z, x) order. For each unclaimed voxel it
 * grows a box: first along +X while blocks match, then +Z while the whole row
 * matches, then +Y while the whole slab matches. Greedy, O(n · box), and within
 * a few percent of optimal for the axis-aligned shapes buildings are made of.
 */
export function mergeToBoxes(buf: VoxelBuffer): FillBox[] {
  if (buf.isEmpty) return [];

  const claimed = new Set<number>();
  const boxes: FillBox[] = [];

  const { minX, minY, minZ, maxX, maxY, maxZ } = buf;

  const at = (x: number, y: number, z: number): string | undefined => {
    const k = packKey(x, y, z);
    if (claimed.has(k)) return undefined;
    return buf.get(x, y, z);
  };

  for (let y = minY; y <= maxY; y++) {
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        const block = at(x, y, z);
        if (block === undefined) continue;

        // Grow along +X.
        let x2 = x;
        while (x2 + 1 <= maxX && at(x2 + 1, y, z) === block) x2++;

        // Grow along +Z while the full X-run matches.
        let z2 = z;
        outerZ: while (z2 + 1 <= maxZ) {
          for (let xi = x; xi <= x2; xi++) {
            if (at(xi, y, z2 + 1) !== block) break outerZ;
          }
          z2++;
        }

        // Grow along +Y while the full XZ-slab matches.
        let y2 = y;
        outerY: while (y2 + 1 <= maxY) {
          for (let zi = z; zi <= z2; zi++) {
            for (let xi = x; xi <= x2; xi++) {
              if (at(xi, y2 + 1, zi) !== block) break outerY;
            }
          }
          y2++;
        }

        for (let yi = y; yi <= y2; yi++)
          for (let zi = z; zi <= z2; zi++)
            for (let xi = x; xi <= x2; xi++) claimed.add(packKey(xi, yi, zi));

        boxes.push({
          x1: x, y1: y, z1: z, x2, y2, z2, block,
          volume: (x2 - x + 1) * (y2 - y + 1) * (z2 - z + 1),
        });
      }
    }
  }

  return boxes;
}
