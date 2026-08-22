/**
 * Build executor.
 *
 * Turns a compiled command stream into actual world changes, and takes
 * responsibility for the four things the demo left to chance:
 *
 *   1. Chunk loading. `/fill` silently fails with "That position is not
 *      loaded" outside a player's view distance. Every build now forceloads
 *      its footprint first and releases it afterwards.
 *   2. Verification. The server tells you how many blocks it changed. Reading
 *      that back turns "the AI said it built a castle" into a number.
 *   3. Undo. A snapshot of the region is taken before the first command, so a
 *      build you dislike is one `!undo` away instead of permanent.
 *   4. Pacing. Commands go out in batches sized to keep the server responsive
 *      rather than as one unbounded flood.
 */

import { EventEmitter } from 'node:events';
import type { CompiledBuild, Vec3 } from '../core/types.js';
import { VoxelBuffer, mergeToBoxes } from '../core/voxel.js';
import { boxToCommand, orderBoxes, splitOversized } from '../core/compile.js';
import { isAir } from '../core/blocks.js';

/** Anything that can read blocks: mineflayer's world, or the simulator. */
export interface WorldReader {
  getBlock(x: number, y: number, z: number): string;
}

/** Anything that can run commands and report what the server said. */
export interface CommandRunner {
  send(command: string): Promise<string>;
  readonly connected: boolean;
}

export interface ExecutorOptions {
  /** Commands dispatched before pausing to let the server tick. */
  batchSize?: number;
  /** Pause between batches, in ms. */
  batchPauseMs?: number;
  /** Skip snapshots above this many blocks (memory and time guard). */
  maxSnapshotVolume?: number;
  /** Forceload the build footprint before running commands. */
  forceload?: boolean;
}

export interface ExecuteProgress {
  done: number;
  total: number;
  blocksChanged: number;
  failures: number;
  phase: string;
  elapsedMs: number;
}

export interface ExecuteResult {
  ok: boolean;
  commands: number;
  blocksChanged: number;
  failures: number;
  /** Distinct server error messages, deduplicated, at most a handful. */
  errors: string[];
  elapsedMs: number;
  commandsPerSecond: number;
  snapshotId: string | null;
  cancelled: boolean;
}

/** A compact record of a region before a build, used to undo it. */
export interface Snapshot {
  id: string;
  min: Vec3;
  max: Vec3;
  /** Distinct block specs. */
  palette: string[];
  /** Palette index per voxel, in (y, z, x) order. */
  data: Uint16Array;
  createdAt: number;
  label: string;
}

const RE_FILLED = /Successfully filled (\d+)/i;
const RE_CLONED = /(\d+) block\(s\) cloned/i;
const RE_CHANGED = /Changed the block/i;

export class BuildCancelled extends Error {
  constructor() { super('Build cancelled'); this.name = 'BuildCancelled'; }
}

export class Executor extends EventEmitter {
  private readonly batchSize: number;
  private readonly batchPauseMs: number;
  private readonly maxSnapshotVolume: number;
  private readonly useForceload: boolean;
  private cancelRequested = false;

  constructor(
    private readonly runner: CommandRunner,
    private readonly opts: ExecutorOptions = {},
  ) {
    super();
    this.batchSize = Math.max(1, opts.batchSize ?? 192);
    this.batchPauseMs = Math.max(0, opts.batchPauseMs ?? 40);
    this.maxSnapshotVolume = opts.maxSnapshotVolume ?? 900_000;
    this.useForceload = opts.forceload !== false;
  }

  cancel(): void { this.cancelRequested = true; }
  get cancelled(): boolean { return this.cancelRequested; }

  /**
   * Capture a region so it can be restored later.
   *
   * Stored as a palette plus 16-bit indices: a 100×40×100 region is 400k
   * voxels, which is 800 KB here versus ~30 MB as an array of objects.
   */
  snapshot(reader: WorldReader, min: Vec3, max: Vec3, label = 'build'): Snapshot | null {
    const w = max[0] - min[0] + 1;
    const h = max[1] - min[1] + 1;
    const d = max[2] - min[2] + 1;
    const volume = w * h * d;
    if (volume <= 0 || volume > this.maxSnapshotVolume) return null;

    const palette: string[] = [];
    const index = new Map<string, number>();
    const data = new Uint16Array(volume);

    let i = 0;
    for (let y = min[1]; y <= max[1]; y++)
      for (let z = min[2]; z <= max[2]; z++)
        for (let x = min[0]; x <= max[0]; x++) {
          const block = reader.getBlock(x, y, z) || 'air';
          let idx = index.get(block);
          if (idx === undefined) {
            if (palette.length >= 65535) idx = 0;
            else { idx = palette.length; palette.push(block); index.set(block, idx); }
          }
          data[i++] = idx;
        }

    return {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      min: [...min] as Vec3, max: [...max] as Vec3,
      palette, data, createdAt: Date.now(), label,
    };
  }

  /** Rebuild the command stream that restores a snapshot. */
  static snapshotCommands(snap: Snapshot): string[] {
    const buf = new VoxelBuffer(snap.data.length + 16);
    let i = 0;
    for (let y = snap.min[1]; y <= snap.max[1]; y++)
      for (let z = snap.min[2]; z <= snap.max[2]; z++)
        for (let x = snap.min[0]; x <= snap.max[0]; x++) {
          buf.set(x, y, z, snap.palette[snap.data[i++]] ?? 'air');
        }
    return orderBoxes(splitOversized(mergeToBoxes(buf))).map(boxToCommand);
  }

  /** Chunk-aligned forceload commands covering a region. */
  static forceloadCommands(min: Vec3, max: Vec3, add: boolean): string[] {
    const cx1 = Math.floor(min[0] / 16), cx2 = Math.floor(max[0] / 16);
    const cz1 = Math.floor(min[2] / 16), cz2 = Math.floor(max[2] / 16);
    const chunks = (cx2 - cx1 + 1) * (cz2 - cz1 + 1);
    const verb = add ? 'add' : 'remove';

    // Vanilla caps a single forceload at 256 chunks; tile past that.
    if (chunks <= 256) {
      return [`forceload ${verb} ${min[0]} ${min[2]} ${max[0]} ${max[2]}`];
    }
    const out: string[] = [];
    const step = 16 * 16; // 16x16 chunks = 256 per command
    for (let x = min[0]; x <= max[0]; x += step)
      for (let z = min[2]; z <= max[2]; z += step) {
        out.push(`forceload ${verb} ${x} ${z} ${Math.min(max[0], x + step - 1)} ${Math.min(max[2], z + step - 1)}`);
      }
    return out;
  }

  /**
   * Run a compiled build.
   *
   * `reader` is optional: without it the build still runs, it just cannot be
   * undone. Undo should never be the reason a build refuses to start.
   */
  async run(
    build: CompiledBuild,
    reader?: WorldReader | null,
  ): Promise<ExecuteResult & { snapshot: Snapshot | null }> {
    this.cancelRequested = false;
    const started = Date.now();
    const { min, max } = build.stats.bounds;

    let blocksChanged = 0;
    let failures = 0;
    const errors = new Set<string>();

    const finish = (cancelled: boolean, snapshot: Snapshot | null): ExecuteResult & { snapshot: Snapshot | null } => {
      const elapsedMs = Date.now() - started;
      return {
        ok: failures === 0 && !cancelled,
        commands: build.commands.length,
        blocksChanged, failures,
        errors: [...errors].slice(0, 5),
        elapsedMs,
        commandsPerSecond: elapsedMs > 0 ? Math.round((build.commands.length / elapsedMs) * 1000) : 0,
        snapshotId: snapshot?.id ?? null,
        cancelled,
        snapshot,
      };
    };

    if (build.commands.length === 0) return finish(false, null);

    // 1. Load the footprint so nothing lands in an unloaded chunk.
    if (this.useForceload) {
      this.emitProgress(0, build.commands.length, 0, 0, 'loading chunks', started);
      for (const cmd of Executor.forceloadCommands(min, max, true)) {
        try { await this.runner.send(cmd); } catch { /* forceload is best effort */ }
      }
    }

    // 2. Snapshot for undo, after loading so the reader sees real blocks.
    let snapshot: Snapshot | null = null;
    if (reader) {
      this.emitProgress(0, build.commands.length, 0, 0, 'snapshot', started);
      try {
        snapshot = this.snapshot(reader, min, max, build.name);
      } catch { snapshot = null; }
    }

    // 3. Execute in batches, keeping the pipeline full within each batch.
    try {
      for (let i = 0; i < build.commands.length; i += this.batchSize) {
        if (this.cancelRequested) return finish(true, snapshot);
        const batch = build.commands.slice(i, i + this.batchSize);
        const replies = await Promise.allSettled(batch.map((c) => this.runner.send(c)));

        for (let j = 0; j < replies.length; j++) {
          const r = replies[j];
          if (r.status === 'rejected') {
            failures++;
            errors.add(String(r.reason?.message ?? r.reason).slice(0, 160));
            continue;
          }
          const changed = parseAffected(r.value);
          if (changed === null) {
            failures++;
            errors.add(`${batch[j].slice(0, 60)} -> ${r.value.replace(/\n/g, ' ').slice(0, 100)}`);
          } else {
            blocksChanged += changed;
          }
        }

        this.emitProgress(
          Math.min(i + batch.length, build.commands.length),
          build.commands.length, blocksChanged, failures, 'building', started,
        );

        if (this.batchPauseMs > 0 && i + this.batchSize < build.commands.length) {
          await sleep(this.batchPauseMs);
        }
      }
    } finally {
      // 4. Always release the chunks, even if the build blew up.
      if (this.useForceload) {
        for (const cmd of Executor.forceloadCommands(min, max, false)) {
          try { await this.runner.send(cmd); } catch { /* ignore */ }
        }
      }
    }

    return finish(this.cancelRequested, snapshot);
  }

  /** Restore a snapshot, undoing whatever was built over it. */
  async undo(snap: Snapshot): Promise<ExecuteResult> {
    const started = Date.now();
    const commands = Executor.snapshotCommands(snap);
    let blocksChanged = 0, failures = 0;
    const errors = new Set<string>();

    if (this.useForceload) {
      for (const cmd of Executor.forceloadCommands(snap.min, snap.max, true)) {
        try { await this.runner.send(cmd); } catch { /* ignore */ }
      }
    }

    try {
      for (let i = 0; i < commands.length; i += this.batchSize) {
        const batch = commands.slice(i, i + this.batchSize);
        const replies = await Promise.allSettled(batch.map((c) => this.runner.send(c)));
        for (const r of replies) {
          if (r.status === 'rejected') { failures++; errors.add(String(r.reason?.message).slice(0, 160)); continue; }
          const changed = parseAffected(r.value);
          if (changed === null) failures++; else blocksChanged += changed;
        }
        this.emitProgress(Math.min(i + batch.length, commands.length), commands.length, blocksChanged, failures, 'undoing', started);
        if (this.batchPauseMs > 0 && i + this.batchSize < commands.length) await sleep(this.batchPauseMs);
      }
    } finally {
      if (this.useForceload) {
        for (const cmd of Executor.forceloadCommands(snap.min, snap.max, false)) {
          try { await this.runner.send(cmd); } catch { /* ignore */ }
        }
      }
    }

    const elapsedMs = Date.now() - started;
    return {
      ok: failures === 0,
      commands: commands.length,
      blocksChanged, failures,
      errors: [...errors].slice(0, 5),
      elapsedMs,
      commandsPerSecond: elapsedMs > 0 ? Math.round((commands.length / elapsedMs) * 1000) : 0,
      snapshotId: snap.id,
      cancelled: false,
    };
  }

  private emitProgress(
    done: number, total: number, blocksChanged: number, failures: number,
    phase: string, started: number,
  ): void {
    const p: ExecuteProgress = { done, total, blocksChanged, failures, phase, elapsedMs: Date.now() - started };
    this.emit('progress', p);
  }
}

/**
 * How many blocks the server says it changed, or null when the reply is an
 * error. "No blocks were filled" is not a failure — it means the region already
 * held the target block, which is normal when a build overlaps itself.
 */
export function parseAffected(reply: string): number | null {
  const text = reply.trim();
  if (!text) return 0;
  const filled = RE_FILLED.exec(text);
  if (filled) return Number(filled[1]);
  const cloned = RE_CLONED.exec(text);
  if (cloned) return Number(cloned[1]);
  if (RE_CHANGED.test(text)) return 1;
  if (/^no blocks were (filled|cloned)/i.test(text)) return 0;
  if (/could not set the block/i.test(text)) return 0;
  if (/marked \d+ chunk|unmarked/i.test(text)) return 0;
  return null;
}

/** Blocks the build will actually place, ignoring the air it carves. */
export function solidBlockCount(build: CompiledBuild): number {
  let n = 0;
  for (const b of build.boxes) if (!isAir(b.block)) n += b.volume;
  return n;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
