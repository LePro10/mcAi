// Test helpers: temp MCAI_HOME, a tiny in-memory WorldBackend, a controllable fake runner.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  BiomeSample, BlockRegistry, BlockVolume, Box, EditBatch, EntityInfo, HeightmapResult, PlayerInfo,
  PlayerNotification, SetBlocksOptions, SetBlocksResult, WorldBackend, WorldInfo,
} from '../../src/core/types.ts';
import { PosMap } from '../../src/core/posmap.ts';
import { Registry } from '../../src/core/registry.ts';
import { parseConfig, type Config } from '../../src/server/config.ts';
import type { AgentEvent, Job, RunHandle, RunResult, Runner } from '../../src/agent/jobs.ts';

export function tmpHome(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcai-test-'));
  process.env.MCAI_HOME = d;
  return d;
}

export function testConfig(over: Record<string, unknown> = {}): Config {
  return parseConfig({ port: 7878, ...over });
}

/** Flat world: bedrock -64, stone ..60, dirt 61-63, grass 64. */
export class MemBackend implements WorldBackend {
  readonly kind = 'sim' as const;
  edits = new PosMap<string>();
  notifications: PlayerNotification[] = [];
  commands: string[] = [];
  playerList: PlayerInfo[] = [];
  setCalls = 0;
  ground = 64;

  base(y: number): string {
    if (y > this.ground) return 'minecraft:air';
    if (y === this.ground) return 'minecraft:grass_block[snowy=false]';
    if (y >= this.ground - 3) return 'minecraft:dirt';
    if (y === -64) return 'minecraft:bedrock';
    return 'minecraft:stone';
  }

  at(x: number, y: number, z: number): string {
    return this.edits.get(x, y, z) ?? this.base(y);
  }

  async info(): Promise<WorldInfo> {
    return { name: 'mem', minY: -64, maxY: 319, seaLevel: 63, mcVersion: '26.3', dimension: 'minecraft:overworld' };
  }
  async registry(): Promise<BlockRegistry> {
    return Registry.loadDefault().data;
  }
  async getBlocks(box: Box): Promise<BlockVolume> {
    const palette = ['minecraft:air'];
    const idx = new Map<string, number>([['minecraft:air', 0]]);
    const sx = box.max[0] - box.min[0] + 1, sy = box.max[1] - box.min[1] + 1, sz = box.max[2] - box.min[2] + 1;
    const data = new Uint16Array(sx * sy * sz);
    let i = 0;
    for (let y = box.min[1]; y <= box.max[1]; y++)
      for (let z = box.min[2]; z <= box.max[2]; z++)
        for (let x = box.min[0]; x <= box.max[0]; x++, i++) {
          const s = this.at(x, y, z);
          let k = idx.get(s);
          if (k === undefined) {
            k = palette.length;
            palette.push(s);
            idx.set(s, k);
          }
          data[i] = k;
        }
    return { box, palette, data };
  }
  async setBlocks(batch: EditBatch, _opts?: SetBlocksOptions): Promise<SetBlocksResult> {
    this.setCalls++;
    const n = batch.states.length;
    const prevPal: string[] = [];
    const prevIdx = new Map<string, number>();
    const prevStates = new Uint16Array(n);
    let placed = 0, unchanged = 0;
    for (let i = 0; i < n; i++) {
      const x = batch.positions[3 * i]!, y = batch.positions[3 * i + 1]!, z = batch.positions[3 * i + 2]!;
      const cur = this.at(x, y, z);
      let k = prevIdx.get(cur);
      if (k === undefined) {
        k = prevPal.length;
        prevPal.push(cur);
        prevIdx.set(cur, k);
      }
      prevStates[i] = k;
      const s = batch.palette[batch.states[i]!]!;
      if (s === cur) unchanged++;
      else {
        placed++;
        this.edits.set(x, y, z, s);
      }
    }
    return { placed, unchanged, failed: [], previous: { palette: prevPal, positions: batch.positions, states: prevStates } };
  }
  async heightmap(x0: number, z0: number, x1: number, z1: number): Promise<HeightmapResult> {
    const w = x1 - x0 + 1, d = z1 - z0 + 1;
    const data = new Int16Array(w * d);
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        let y = 160;
        while (y > -64 && this.at(x, y, z) === 'minecraft:air') y--;
        data[(z - z0) * w + (x - x0)] = y;
      }
    return { x0, z0, x1, z1, data };
  }
  async biomes(box: Box, step: number): Promise<BiomeSample> {
    const n = Math.ceil((box.max[0] - box.min[0] + 1) / step) * Math.ceil((box.max[2] - box.min[2] + 1) / step);
    return { palette: ['minecraft:plains'], data: new Uint16Array(Math.max(1, n)), step };
  }
  async entities(): Promise<EntityInfo[]> {
    return [];
  }
  async players(): Promise<PlayerInfo[]> {
    return this.playerList;
  }
  async runCommand(cmd: string): Promise<{ ok: boolean; output: string }> {
    this.commands.push(cmd);
    return { ok: true, output: `ran ${cmd.split(' ')[0]}` };
  }
  async notify(n: PlayerNotification): Promise<void> {
    this.notifications.push(n);
  }
}

/** Runner whose process "runs" until killed or finished via `finish(job)`. */
export class FakeRunner implements Runner {
  started: Job[] = [];
  private resolvers = new Map<string, (r: RunResult) => void>();
  events = new Map<string, (ev: AgentEvent) => void>();

  start(job: Job, onEvent: (ev: AgentEvent) => void): RunHandle {
    this.started.push(job);
    this.events.set(job.id, onEvent);
    const done = new Promise<RunResult>((resolve) => this.resolvers.set(job.id, resolve));
    return {
      pid: 0,
      done,
      kill: () => this.complete(job, { ok: false, exitCode: null, signal: 'SIGTERM', costUsd: 0, durationMs: 1, error: 'killed' }),
    };
  }

  complete(job: Job, r: Partial<RunResult> = {}): void {
    const res = this.resolvers.get(job.id);
    this.resolvers.delete(job.id);
    res?.({ ok: true, exitCode: 0, signal: null, costUsd: 0.01, durationMs: 5, subtype: 'success', ...r });
  }
}

export function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 5000, what = 'condition'): Promise<T> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let v: T | undefined | null | false;
      try {
        v = fn();
      } catch {
        v = undefined;
      }
      if (v) return resolve(v);
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`timeout waiting for ${what}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}
