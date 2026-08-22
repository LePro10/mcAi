/**
 * An in-memory Minecraft world that speaks vanilla commands.
 *
 * This exists so the whole pipeline — prompt, blueprint, compiler, executor,
 * RCON protocol — can be exercised without a Java server anywhere in sight.
 * It runs in CI, it powers `mcai sim` for people who want to try the project
 * before installing Minecraft, and it makes "does the build actually land?"
 * a testable question rather than something you eyeball in-game.
 *
 * It implements the subset of commands mcAI emits, with vanilla's real limits
 * (the 32,768-block `/fill` cap, unloaded-chunk failures, block-id validation)
 * so that a build passing here is a build that passes there.
 */

import { BLOCK_IDS, isAir, parseBlock } from '../core/blocks.js';
import { packKey, unpackKey } from '../core/voxel.js';

export interface SimOptions {
  /** Ground height for generated terrain. */
  seaLevel?: number;
  /** Amplitude of the rolling hills. 0 gives a superflat world. */
  relief?: number;
  seed?: number;
  /** Reject commands touching chunks that are not loaded. */
  enforceChunkLoading?: boolean;
}

export interface CommandResult {
  /** Whether vanilla would treat the command as having succeeded. */
  ok: boolean;
  /** The message vanilla would print. */
  message: string;
  /** Blocks actually changed. */
  affected: number;
  /**
   * True when the command was valid but changed nothing — filling a region
   * that already held the target block, or clearing air. Vanilla reports these
   * as failures, which they are not: a build carves air over positions that
   * may or may not have contained anything, and both outcomes are correct.
   */
  noop?: boolean;
}

const CHUNK = 16;

export class SimWorld {
  private blocks = new Map<number, string>();
  private forceloaded = new Set<string>();
  private readonly seaLevel: number;
  private readonly relief: number;
  private readonly seed: number;
  private readonly enforceChunkLoading: boolean;

  /** Every command the world has seen, for assertions and replay. */
  readonly log: Array<{ command: string; result: CommandResult }> = [];
  /** Counters the tests and the CLI report on. */
  stats = { commands: 0, blocksChanged: 0, failures: 0, noops: 0 };

  constructor(opts: SimOptions = {}) {
    this.seaLevel = opts.seaLevel ?? 64;
    this.relief = opts.relief ?? 6;
    this.seed = opts.seed ?? 1;
    this.enforceChunkLoading = opts.enforceChunkLoading ?? false;
  }

  // ── Terrain ─────────────────────────────────────────────────────────────

  /** Smooth pseudo-terrain, so foundation adaptation has something to chew on. */
  surfaceY(x: number, z: number): number {
    if (this.relief === 0) return this.seaLevel;
    const s = this.seed * 0.017;
    const h =
      Math.sin(x * 0.06 + s) * 0.5 +
      Math.cos(z * 0.05 - s) * 0.5 +
      Math.sin((x + z) * 0.021 + s * 2) * 0.35;
    return Math.round(this.seaLevel + h * this.relief);
  }

  /** Natural block at a position, before any player edits. */
  private naturalBlock(x: number, y: number, z: number): string {
    const surface = this.surfaceY(x, z);
    if (y > surface) return 'air';
    if (y === surface) return 'grass_block';
    if (y > surface - 4) return 'dirt';
    if (y < -60) return 'bedrock';
    return 'stone';
  }

  getBlock(x: number, y: number, z: number): string {
    const edited = this.blocks.get(packKey(x, y, z));
    if (edited !== undefined) return edited;
    return this.naturalBlock(x, y, z);
  }

  setBlock(x: number, y: number, z: number, spec: string): boolean {
    const before = this.getBlock(x, y, z);
    if (before === spec) return false;
    this.blocks.set(packKey(x, y, z), spec);
    return true;
  }

  /** Highest non-air block in a column, matching what a heightmap returns. */
  highestY(x: number, z: number, from = 320): number {
    for (let y = from; y >= -64; y--) {
      if (!isAir(this.getBlock(x, y, z))) return y;
    }
    return -64;
  }

  get editedCount(): number { return this.blocks.size; }

  /** All player-edited voxels, for rendering the simulated result. */
  *edits(): Generator<{ x: number; y: number; z: number; block: string }> {
    for (const [k, block] of this.blocks) {
      const [x, y, z] = unpackKey(k);
      yield { x, y, z, block };
    }
  }

  // ── Chunks ──────────────────────────────────────────────────────────────

  private chunkKey(x: number, z: number): string {
    return `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
  }

  forceload(x1: number, z1: number, x2: number, z2: number): number {
    let n = 0;
    for (let cx = Math.floor(Math.min(x1, x2) / CHUNK); cx <= Math.floor(Math.max(x1, x2) / CHUNK); cx++)
      for (let cz = Math.floor(Math.min(z1, z2) / CHUNK); cz <= Math.floor(Math.max(z1, z2) / CHUNK); cz++) {
        this.forceloaded.add(`${cx},${cz}`);
        n++;
      }
    return n;
  }

  forceloadRemoveAll(): void { this.forceloaded.clear(); }

  private isLoaded(x: number, z: number): boolean {
    if (!this.enforceChunkLoading) return true;
    return this.forceloaded.has(this.chunkKey(x, z));
  }

  // ── Commands ────────────────────────────────────────────────────────────

  /** Execute one command and return what vanilla's RCON would reply. */
  execute(raw: string): CommandResult {
    const command = raw.trim().replace(/^\//, '');
    const result = this.dispatch(command);
    this.stats.commands++;
    this.stats.blocksChanged += result.affected;
    if (result.noop) this.stats.noops++;
    else if (!result.ok) this.stats.failures++;
    if (this.log.length < 200_000) this.log.push({ command, result });
    return result;
  }

  private dispatch(command: string): CommandResult {
    const parts = command.split(/\s+/);
    const verb = parts[0]?.toLowerCase();

    switch (verb) {
      case 'fill': return this.cmdFill(parts);
      case 'setblock': return this.cmdSetblock(parts);
      case 'clone': return this.cmdClone(parts);
      case 'forceload': return this.cmdForceload(parts);
      case 'say': case 'tellraw': case 'title':
        return { ok: true, message: '', affected: 0 };
      case 'time': case 'weather': case 'gamerule': case 'gamemode': case 'difficulty':
        return { ok: true, message: `${verb} set`, affected: 0 };
      case 'tp': case 'teleport':
        return { ok: true, message: 'Teleported', affected: 0 };
      case 'summon':
        return { ok: true, message: 'Object successfully summoned', affected: 0 };
      case 'give':
        return { ok: true, message: 'Gave item', affected: 0 };
      case 'list':
        return { ok: true, message: 'There are 0 of a max of 20 players online:', affected: 0 };
      default:
        return { ok: false, message: `Unknown or incomplete command, see below for error\n${command}<--[HERE]`, affected: 0 };
    }
  }

  private coords(parts: string[], from: number, count: number): number[] | null {
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      const v = Number(parts[from + i]);
      if (!Number.isFinite(v)) return null;
      out.push(Math.floor(v));
    }
    return out;
  }

  /** Reject ids vanilla would not know, the way a real server does. */
  private validBlock(spec: string): boolean {
    const id = parseBlock(spec).id;
    return BLOCK_IDS.has(id);
  }

  private cmdSetblock(parts: string[]): CommandResult {
    const c = this.coords(parts, 1, 3);
    const spec = parts.slice(4).join(' ');
    if (!c || !spec) return { ok: false, message: 'Incorrect argument for command', affected: 0 };
    if (!this.validBlock(spec)) {
      return { ok: false, message: `Unknown block type '${parseBlock(spec).id}'`, affected: 0 };
    }
    if (!this.isLoaded(c[0], c[2])) {
      return { ok: false, message: 'That position is not loaded', affected: 0 };
    }
    const changed = this.setBlock(c[0], c[1], c[2], spec);
    return changed
      ? { ok: true, message: `Changed the block at ${c[0]}, ${c[1]}, ${c[2]}`, affected: 1 }
      : { ok: false, message: 'Could not set the block', affected: 0, noop: true };
  }

  private cmdFill(parts: string[]): CommandResult {
    const c = this.coords(parts, 1, 6);
    if (!c) return { ok: false, message: 'Incorrect argument for command', affected: 0 };
    const rest = parts.slice(7);
    const spec = rest[0];
    if (!spec) return { ok: false, message: 'Incorrect argument for command', affected: 0 };

    const mode = rest[1]?.toLowerCase();
    const filterSpec = rest[2];

    if (!this.validBlock(spec)) {
      return { ok: false, message: `Unknown block type '${parseBlock(spec).id}'`, affected: 0 };
    }

    const x1 = Math.min(c[0], c[3]), x2 = Math.max(c[0], c[3]);
    const y1 = Math.min(c[1], c[4]), y2 = Math.max(c[1], c[4]);
    const z1 = Math.min(c[2], c[5]), z2 = Math.max(c[2], c[5]);
    const volume = (x2 - x1 + 1) * (y2 - y1 + 1) * (z2 - z1 + 1);

    if (volume > 32768) {
      return { ok: false, message: `Too many blocks in the specified area (maximum 32768, specified ${volume})`, affected: 0 };
    }
    if (!this.isLoaded(x1, z1) || !this.isLoaded(x2, z2)) {
      return { ok: false, message: 'That position is not loaded', affected: 0 };
    }

    const hollow = mode === 'hollow';
    const outline = mode === 'outline';
    const keep = mode === 'keep';
    const replaceFilter = mode === 'replace' && filterSpec ? parseBlock(filterSpec).id : null;

    let affected = 0;
    for (let y = y1; y <= y2; y++)
      for (let z = z1; z <= z2; z++)
        for (let x = x1; x <= x2; x++) {
          const onShell = x === x1 || x === x2 || y === y1 || y === y2 || z === z1 || z === z2;
          if ((hollow || outline) && !onShell) {
            if (hollow && this.setBlock(x, y, z, 'air')) affected++;
            continue;
          }
          if (keep && !isAir(this.getBlock(x, y, z))) continue;
          if (replaceFilter && parseBlock(this.getBlock(x, y, z)).id !== replaceFilter) continue;
          if (this.setBlock(x, y, z, spec)) affected++;
        }

    return affected > 0
      ? { ok: true, message: `Successfully filled ${affected} block(s)`, affected }
      : { ok: false, message: 'No blocks were filled', affected: 0, noop: true };
  }

  private cmdClone(parts: string[]): CommandResult {
    const c = this.coords(parts, 1, 9);
    if (!c) return { ok: false, message: 'Incorrect argument for command', affected: 0 };
    const rest = parts.slice(10).map((s) => s.toLowerCase());
    const maskMode = rest.find((r) => ['replace', 'masked', 'filtered'].includes(r)) ?? 'replace';

    const x1 = Math.min(c[0], c[3]), x2 = Math.max(c[0], c[3]);
    const y1 = Math.min(c[1], c[4]), y2 = Math.max(c[1], c[4]);
    const z1 = Math.min(c[2], c[5]), z2 = Math.max(c[2], c[5]);
    const volume = (x2 - x1 + 1) * (y2 - y1 + 1) * (z2 - z1 + 1);
    if (volume > 32768) {
      return { ok: false, message: `Too many blocks in the specified area (maximum 32768, specified ${volume})`, affected: 0 };
    }

    const [dx, dy, dz] = [c[6] - x1, c[7] - y1, c[8] - z1];

    // Snapshot first so overlapping source and destination behave like vanilla.
    const snapshot: string[] = [];
    for (let y = y1; y <= y2; y++)
      for (let z = z1; z <= z2; z++)
        for (let x = x1; x <= x2; x++) snapshot.push(this.getBlock(x, y, z));

    let i = 0, affected = 0;
    for (let y = y1; y <= y2; y++)
      for (let z = z1; z <= z2; z++)
        for (let x = x1; x <= x2; x++) {
          const src = snapshot[i++];
          if (maskMode === 'masked' && isAir(src)) continue;
          if (this.setBlock(x + dx, y + dy, z + dz, src)) affected++;
        }

    return affected > 0
      ? { ok: true, message: `${affected} block(s) cloned`, affected }
      : { ok: false, message: 'No blocks were cloned', affected: 0, noop: true };
  }

  private cmdForceload(parts: string[]): CommandResult {
    const sub = parts[1]?.toLowerCase();
    if (sub === 'remove' && parts[2]?.toLowerCase() === 'all') {
      this.forceloadRemoveAll();
      return { ok: true, message: 'Unmarked all forceloaded chunks', affected: 0 };
    }
    if (sub === 'add') {
      const c = this.coords(parts, 2, 4) ?? this.coords(parts, 2, 2);
      if (!c) return { ok: false, message: 'Incorrect argument for command', affected: 0 };
      const n = c.length === 4
        ? this.forceload(c[0], c[1], c[2], c[3])
        : this.forceload(c[0], c[1], c[0], c[1]);
      return { ok: true, message: `Marked ${n} chunk(s) for force loading`, affected: 0 };
    }
    if (sub === 'remove') {
      return { ok: true, message: 'Unmarked chunk(s)', affected: 0 };
    }
    return { ok: false, message: 'Incorrect argument for command', affected: 0 };
  }
}
