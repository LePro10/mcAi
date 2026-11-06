// Per-job read cache in front of the WorldBackend. In real Minecraft every get_blocks /
// heightmap is a round trip through the mod's tick queue (and may load chunks), so a job should
// read its area once and then work from memory:
//  * the first read inside the job area loads the whole allowed box (+ margin) in ONE call;
//  * later reads inside it are served from memory (sliced);
//  * the job's own writes (setBlocks through this wrapper) are applied to the cached volumes and
//    invalidate overlapping heightmaps — the cache never goes stale for the job's own edits;
//  * a TTL (default 90 s) and invalidate() (undo/redo, other jobs' edits) bound staleness from
//    the player or other writers. Every real round trip is logged to the job log ('world').

import type { BiomeSample, BlockRegistry, BlockVolume, Box, EditBatch, EntityInfo, HeightmapResult, PlayerInfo, PlayerNotification, SetBlocksOptions, SetBlocksResult, WorldBackend, WorldInfo } from '../../core/types.ts';
import { boxContains, boxContainsBox, boxIntersect, boxVolume, createVolume, paletteIndex, volIndex } from '../../core/volume.ts';

export interface WorldCacheStats {
  getBlocks: number;
  getBlocksBlocks: number;
  getBlocksHits: number;
  heightmap: number;
  heightmapHits: number;
  setBlocks: number;
  info: number;
}

const live = new Set<JobWorldCache>();

export class JobWorldCache implements WorldBackend {
  readonly kind: WorldBackend['kind'];
  readonly inner: WorldBackend;
  /** EditSession locks on this (all jobs serialize on the real backend) */
  readonly lockTarget: WorldBackend;
  private region: Box;
  private dimension: string;
  private vols: BlockVolume[] = [];
  private heights = new Map<string, HeightmapResult>();
  private infoP: Promise<WorldInfo> | null = null;
  private stamp = Date.now();
  private regionLoaded = false;
  readonly ttlMs: number;
  readonly maxBlocks: number;
  readonly stats: WorldCacheStats = { getBlocks: 0, getBlocksBlocks: 0, getBlocksHits: 0, heightmap: 0, heightmapHits: 0, setBlocks: 0, info: 0 };
  private log: (kind: string, data: Record<string, unknown>) => void;
  /** owner (job) still running? used to prune the global set */
  alive: () => boolean;

  constructor(inner: WorldBackend, o: { region: Box; dimension: string; ttlMs?: number; maxBlocks?: number; log?: (kind: string, data: Record<string, unknown>) => void; alive?: () => boolean }) {
    this.inner = inner;
    this.lockTarget = (inner as { lockTarget?: WorldBackend }).lockTarget ?? inner;
    this.kind = inner.kind;
    this.region = o.region;
    this.dimension = o.dimension;
    this.ttlMs = o.ttlMs ?? 90_000;
    this.maxBlocks = o.maxBlocks ?? 12_000_000;
    this.log = o.log ?? (() => {});
    this.alive = o.alive ?? (() => true);
    for (const c of live) if (!c.alive()) live.delete(c);
    live.add(this);
  }

  /** drop everything (undo/redo or foreign edits) */
  invalidate(): void {
    this.vols = [];
    this.heights.clear();
    this.regionLoaded = false;
    this.stamp = Date.now();
  }

  /** drop cached data overlapping a box (edits by someone else) */
  invalidateBox(b: Box): void {
    this.vols = this.vols.filter((v) => !boxIntersect(v.box, b));
    if (!this.vols.length) this.regionLoaded = false;
    for (const [k, h] of this.heights) if (!(h.x1 < b.min[0] || h.x0 > b.max[0] || h.z1 < b.min[2] || h.z0 > b.max[2])) this.heights.delete(k);
  }

  /** tell every other live job cache that `batch` changed the world */
  static foreignEdit(source: JobWorldCache | null, b: Box): void {
    for (const c of live) if (c !== source) c.invalidateBox(b);
  }

  private fresh(): void {
    if (Date.now() - this.stamp > this.ttlMs) this.invalidate();
  }

  private cachedBlocks(): number {
    let n = 0;
    for (const v of this.vols) n += v.data.length;
    return n;
  }

  private remember(v: BlockVolume): void {
    this.vols.unshift(v);
    while (this.vols.length > 1 && this.cachedBlocks() > this.maxBlocks) this.vols.pop();
  }

  private async fetch(box: Box, dimension?: string): Promise<BlockVolume> {
    const t0 = Date.now();
    const v = await this.inner.getBlocks(box, dimension);
    this.stats.getBlocks++;
    this.stats.getBlocksBlocks += boxVolume(box);
    this.log('world', { call: 'get_blocks', blocks: boxVolume(box), ms: Date.now() - t0 });
    return v;
  }

  info(): Promise<WorldInfo> {
    if (!this.infoP) {
      this.stats.info++;
      this.infoP = this.inner.info().catch((e) => {
        this.infoP = null;
        throw e;
      });
    }
    return this.infoP;
  }

  registry(): Promise<BlockRegistry> {
    return this.inner.registry();
  }

  async getBlocks(box: Box, dimension?: string): Promise<BlockVolume> {
    if ((dimension ?? this.dimension) !== this.dimension) return this.inner.getBlocks(box, dimension);
    this.fresh();
    for (const v of this.vols) {
      if (boxContainsBox(v.box, box)) {
        this.stats.getBlocksHits++;
        return slice(v, box);
      }
    }
    // first read inside the job area: load the whole area once
    if (!this.regionLoaded && boxContainsBox(this.region, box) && boxVolume(this.region) <= Math.min(this.maxBlocks, 8_000_000)) {
      const v = await this.fetch(this.region, dimension);
      this.regionLoaded = true;
      this.remember(v);
      return slice(v, box);
    }
    const v = await this.fetch(box, dimension);
    this.remember(v);
    return v;
  }

  async setBlocks(batch: EditBatch, opts?: SetBlocksOptions): Promise<SetBlocksResult> {
    const t0 = Date.now();
    const res = await this.inner.setBlocks(batch, opts);
    this.stats.setBlocks++;
    this.log('world', { call: 'set_blocks', blocks: batch.states.length, ms: Date.now() - t0 });
    const failed = new Set(res.failed.map((f) => f.index));
    let bmin: number[] = [Infinity, Infinity, Infinity], bmax: number[] = [-Infinity, -Infinity, -Infinity];
    const n = batch.states.length;
    for (let i = 0; i < n; i++) {
      const x = batch.positions[3 * i]!, y = batch.positions[3 * i + 1]!, z = batch.positions[3 * i + 2]!;
      if (x < bmin[0]!) bmin[0] = x; if (y < bmin[1]!) bmin[1] = y; if (z < bmin[2]!) bmin[2] = z;
      if (x > bmax[0]!) bmax[0] = x; if (y > bmax[1]!) bmax[1] = y; if (z > bmax[2]!) bmax[2] = z;
      if (failed.has(i)) continue;
      const s = batch.palette[batch.states[i]!]!;
      for (const v of this.vols) {
        if (!boxContains(v.box, x, y, z)) continue;
        v.data[volIndex(v.box, x, y, z)] = paletteIndex(v.palette, s);
      }
    }
    if (n) {
      const b: Box = { min: bmin as Box['min'], max: bmax as Box['max'] };
      // neighbour shape updates may touch the ring around the batch: refresh it from the world lazily
      const ring: Box = { min: [b.min[0] - 1, b.min[1] - 1, b.min[2] - 1], max: [b.max[0] + 1, b.max[1] + 1, b.max[2] + 1] };
      for (const [k, h] of this.heights) if (!(h.x1 < ring.min[0] || h.x0 > ring.max[0] || h.z1 < ring.min[2] || h.z0 > ring.max[2])) this.heights.delete(k);
      JobWorldCache.foreignEdit(this, ring);
    }
    return res;
  }

  async heightmap(x0: number, z0: number, x1: number, z1: number, kind?: 'surface' | 'ocean_floor', dimension?: string): Promise<HeightmapResult> {
    this.fresh();
    const key = `${x0},${z0},${x1},${z1},${kind ?? 'surface'},${dimension ?? this.dimension}`;
    const hit = this.heights.get(key);
    if (hit) {
      this.stats.heightmapHits++;
      return hit;
    }
    const t0 = Date.now();
    const h = await this.inner.heightmap(x0, z0, x1, z1, kind, dimension);
    this.stats.heightmap++;
    this.log('world', { call: 'heightmap', columns: (x1 - x0 + 1) * (z1 - z0 + 1), ms: Date.now() - t0 });
    this.heights.set(key, h);
    return h;
  }

  biomes(box: Box, step: number, dimension?: string): Promise<BiomeSample> {
    return this.inner.biomes(box, step, dimension);
  }
  entities(box: Box, dimension?: string): Promise<EntityInfo[]> {
    return this.inner.entities(box, dimension);
  }
  players(): Promise<PlayerInfo[]> {
    return this.inner.players();
  }
  runCommand(cmd: string, opts?: { as?: string }): Promise<{ ok: boolean; output: string }> {
    return this.inner.runCommand(cmd, opts);
  }
  notify(n: PlayerNotification): Promise<void> {
    return this.inner.notify(n);
  }
}

/** copy a sub-box out of a cached volume (fresh palette indices are kept; palette shared by copy) */
function slice(v: BlockVolume, box: Box): BlockVolume {
  if (v.box.min.every((c, i) => c === box.min[i]) && v.box.max.every((c, i) => c === box.max[i])) {
    return { box: { min: [...v.box.min], max: [...v.box.max] }, palette: [...v.palette], data: v.data.slice() };
  }
  const out = createVolume(box);
  out.palette = [...v.palette];
  const sx = box.max[0] - box.min[0] + 1;
  const vsx = v.box.max[0] - v.box.min[0] + 1, vsz = v.box.max[2] - v.box.min[2] + 1;
  let o = 0;
  for (let y = box.min[1]; y <= box.max[1]; y++)
    for (let z = box.min[2]; z <= box.max[2]; z++) {
      const src = (y - v.box.min[1]) * vsx * vsz + (z - v.box.min[2]) * vsx + (box.min[0] - v.box.min[0]);
      out.data.set(v.data.subarray(src, src + sx), o);
      o += sx;
    }
  return out;
}
