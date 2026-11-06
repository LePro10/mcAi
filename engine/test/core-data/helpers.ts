// Test doubles for core-data tests (test folder only).
import type {
  BiomeSample,
  BlockRegistry,
  BlockVolume,
  Box,
  EditBatch,
  EntityInfo,
  HeightmapResult,
  PlayerInfo,
  SetBlocksOptions,
  SetBlocksResult,
  WorldBackend,
  WorldInfo,
} from '../../src/core/types.ts';
import { AIR } from '../../src/core/blockstate.ts';
import { PosMap } from '../../src/core/posmap.ts';
import { createVolume, paletteIndex, volIndex } from '../../src/core/volume.ts';
import { Registry } from '../../src/core/registry.ts';

let regSingleton: Registry | undefined;
export function reg(): Registry {
  return (regSingleton ??= Registry.loadDefault());
}

/** Minimal in-memory WorldBackend that records calls. */
export class MemBackend implements WorldBackend {
  readonly kind = 'sim' as const;
  world = new PosMap<string>();
  setCalls: Array<{ size: number; opts?: SetBlocksOptions }> = [];
  getCalls: Box[] = [];
  /** artificial latency per setBlocks call (ms) */
  delayMs = 0;
  /** positions (as "x,y,z") that fail */
  failAt = new Set<string>();
  log: string[] = [];

  constructor(init?: Array<[number, number, number, string]>) {
    for (const [x, y, z, s] of init ?? []) this.world.set(x, y, z, s);
  }

  at(x: number, y: number, z: number): string {
    return this.world.get(x, y, z) ?? AIR;
  }

  async info(): Promise<WorldInfo> {
    return { name: 'mem', minY: -64, maxY: 319, seaLevel: 62, mcVersion: '26.3', dimension: 'minecraft:overworld' };
  }
  async registry(): Promise<BlockRegistry> {
    throw new Error('not needed');
  }
  async getBlocks(box: Box): Promise<BlockVolume> {
    this.getCalls.push(box);
    const v = createVolume(box);
    for (let y = box.min[1]; y <= box.max[1]; y++)
      for (let z = box.min[2]; z <= box.max[2]; z++)
        for (let x = box.min[0]; x <= box.max[0]; x++) {
          const s = this.world.get(x, y, z);
          if (s) v.data[volIndex(v.box, x, y, z)] = paletteIndex(v.palette, s);
        }
    return v;
  }
  async setBlocks(batch: EditBatch, opts?: SetBlocksOptions): Promise<SetBlocksResult> {
    this.setCalls.push({ size: batch.states.length, opts });
    this.log.push(`set:${batch.states.length}:start`);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const prevPal: string[] = [];
    const prevSt = new Uint16Array(batch.states.length);
    let placed = 0;
    let unchanged = 0;
    const failed: { index: number; reason: string }[] = [];
    for (let i = 0; i < batch.states.length; i++) {
      const x = batch.positions[3 * i];
      const y = batch.positions[3 * i + 1];
      const z = batch.positions[3 * i + 2];
      const prev = this.at(x, y, z);
      prevSt[i] = paletteIndex(prevPal, prev);
      if (this.failAt.has(`${x},${y},${z}`)) {
        failed.push({ index: i, reason: 'test failure' });
        continue;
      }
      const s = batch.palette[batch.states[i]];
      if (prev === s) unchanged++;
      else placed++;
      if (s === AIR) this.world.delete(x, y, z);
      else this.world.set(x, y, z, s);
    }
    this.log.push(`set:${batch.states.length}:end`);
    return { placed, unchanged, failed, previous: { palette: prevPal, positions: batch.positions, states: prevSt } };
  }
  async heightmap(x0: number, z0: number, x1: number, z1: number): Promise<HeightmapResult> {
    return { x0, z0, x1, z1, data: new Int16Array((x1 - x0 + 1) * (z1 - z0 + 1)) };
  }
  async biomes(): Promise<BiomeSample> {
    return { palette: ['minecraft:plains'], data: new Uint16Array(1), step: 4 };
  }
  async entities(): Promise<EntityInfo[]> {
    return [];
  }
  async players(): Promise<PlayerInfo[]> {
    return [];
  }
  async runCommand(): Promise<{ ok: boolean; output: string }> {
    return { ok: true, output: '' };
  }
  async notify(): Promise<void> {}
}

/** BlockSink that records sets into a map (reads through to an optional base function). */
export class RecordingSink {
  map = new Map<string, string>();
  order: Array<[number, number, number, string]> = [];
  base: (x: number, y: number, z: number) => string;
  constructor(base?: (x: number, y: number, z: number) => string) {
    this.base = base ?? (() => AIR);
  }
  get(x: number, y: number, z: number): string {
    return this.map.get(`${x},${y},${z}`) ?? this.base(x, y, z);
  }
  set(x: number, y: number, z: number, state: string): void {
    this.map.set(`${x},${y},${z}`, state);
    this.order.push([x, y, z, state]);
  }
}
