// EditSession (sync read/write facade over a WorldBackend) and per-actor undo History.
// See docs/ENGINE-API.md (core-data) and ARCHITECTURE §1 rule 3.

import type { Box, Vec3, BlockVolume, EditBatch, SetBlocksOptions, WorldBackend } from './types.ts';
import type { Registry } from './registry.ts';
import type { BlockSink } from './dsl.ts';
import { AIR } from './blockstate.ts';
import { solveConnections } from './connect.ts';
import { expandMultiblock } from './multiblock.ts';
import { PosMap, checkCoord } from './posmap.ts';
import { needsSupport, resolveSupport, summarizeSupport, type SupportMode, type SupportReport } from './support.ts';
import {
  boxContains,
  boxContainsBox,
  boxExpand,
  boxToString,
  boxVolume,
  emptyBatch,
  paletteIndex,
  splitBatch,
  volGet,
  volSet,
} from './volume.ts';

export class BoundsError extends Error {
  override name = 'BoundsError';
}
export class LimitError extends Error {
  override name = 'LimitError';
}

export interface SessionOptions {
  bounds?: Box;
  maxBlocks?: number;
  dimension?: string;
  actor?: string;
  label?: string;
  /** run solveConnections + expandMultiblock on flush, default true */
  connect?: boolean;
  /** if given, every flush with changes is pushed onto this history */
  history?: History;
  /**
   * physical plausibility on flush (core/support.ts): 'drop' (default) removes unsupported
   * attachables (floating vines, torches in mid-air, flowers on stone …) and trims multiface
   * blocks; 'warn' only reports them; 'off' skips the check.
   */
  support?: SupportMode;
}

export interface FlushOptions extends SetBlocksOptions {
  /** override SessionOptions.support for this flush */
  support?: SupportMode;
}

export interface UndoRecord {
  id: string;
  label: string;
  actor: string;
  dimension: string;
  before: EditBatch;
  after: EditBatch;
  time: number;
}

export interface FlushResult {
  /** blocks the backend reported as placed */
  placed: number;
  /** blocks skipped because they already had the target state (engine-side or backend-side) */
  unchanged: number;
  failed: { pos: Vec3; reason: string }[];
  /** positions whose state actually changed (= size of the undo record) */
  changed: number;
  /** extra states produced by solveConnections */
  connections: number;
  /** extra states produced by expandMultiblock (door tops, bed heads, …) */
  multiblock: number;
  batches: number;
  ms: number;
  warnings: string[];
  record: UndoRecord | null;
  /** support check result (null if off / nothing to check) — warnings also contain a summary */
  support: SupportReport | null;
}

/** Max entries per backend.setBlocks call. */
export const MAX_BATCH = 50_000;
/** Max blocks per backend.getBlocks call during prefetch. */
export const MAX_FETCH = 1_000_000;
export const DEFAULT_MAX_BLOCKS = 2_000_000;
export const DEFAULT_DIMENSION = 'minecraft:overworld';

let recordSeq = 0;
export function newRecordId(): string {
  return `u${++recordSeq}-${Date.now().toString(36)}`;
}

// ------------------------------------------------------------------ per-backend write lock

const locks = new WeakMap<object, Promise<unknown>>();

/** Serialize async work per backend (flushes, undo, redo never interleave on one backend). */
export function withBackendLock<T>(backend: WorldBackend, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(backend) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(
    backend,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

// ------------------------------------------------------------------ canonical cache

const canonCaches = new WeakMap<Registry, Map<string, string>>();
export function cachedCanonical(reg: Registry, state: string): string {
  let m = canonCaches.get(reg);
  if (!m) canonCaches.set(reg, (m = new Map()));
  let c = m.get(state);
  if (c === undefined) {
    c = reg.canonical(state);
    if (m.size > 100_000) m.clear();
    m.set(state, c);
  }
  return c;
}

/** Apply a batch in ≤ MAX_BATCH chunks; returns the concatenated `previous` states. */
async function applyBatch(
  backend: WorldBackend,
  batch: EditBatch,
  opts: SetBlocksOptions,
): Promise<{ previous: string[]; failed: Set<number>; reasons: Map<number, string>; placed: number; unchanged: number; calls: number }> {
  const previous: string[] = new Array(batch.states.length);
  const failed = new Set<number>();
  const reasons = new Map<number, string>();
  let placed = 0;
  let unchanged = 0;
  let base = 0;
  let calls = 0;
  for (const part of splitBatch(batch, MAX_BATCH)) {
    const res = await backend.setBlocks(part, opts);
    calls++;
    placed += res.placed;
    unchanged += res.unchanged;
    for (const f of res.failed) {
      failed.add(base + f.index);
      reasons.set(base + f.index, f.reason);
    }
    const prev = res.previous;
    for (let i = 0; i < part.states.length; i++) {
      previous[base + i] = prev && prev.states.length > i ? prev.palette[prev.states[i]] : AIR;
    }
    base += part.states.length;
  }
  return { previous, failed, reasons, placed, unchanged, calls };
}

// ------------------------------------------------------------------ EditSession

export class EditSession implements BlockSink {
  readonly backend: WorldBackend;
  readonly reg: Registry;
  readonly bounds: Box | undefined;
  readonly maxBlocks: number;
  readonly dimension: string;
  readonly actor: string;
  label: string;
  readonly connect: boolean;
  readonly history: History | undefined;
  support: SupportMode;

  private changes = new PosMap<string>();
  private volumes: BlockVolume[] = [];
  private known = new PosMap<string>();
  private listeners: Array<(r: FlushResult) => void> = [];
  private lastVol: BlockVolume | undefined;
  private lastIn = '';
  private lastOut = '';
  /** distinct positions set so far (across flushes) — used for the block limit */
  private touched = 0;
  /** number of get() calls that hit neither pending changes nor the prefetched cache */
  misses = 0;
  /** all undo records produced by this session, in order */
  readonly records: UndoRecord[] = [];

  constructor(backend: WorldBackend, reg: Registry, opts: SessionOptions = {}) {
    this.backend = backend;
    this.reg = reg;
    this.bounds = opts.bounds ? { min: [...opts.bounds.min], max: [...opts.bounds.max] } : undefined;
    this.maxBlocks = opts.maxBlocks ?? DEFAULT_MAX_BLOCKS;
    this.dimension = opts.dimension ?? DEFAULT_DIMENSION;
    this.actor = opts.actor ?? 'system';
    this.label = opts.label ?? 'edit';
    this.connect = opts.connect !== false;
    this.history = opts.history;
    this.support = opts.support ?? 'drop';
  }

  get pending(): number {
    return this.changes.size;
  }

  /** total distinct positions written (pending + flushed) — counts against maxBlocks */
  get used(): number {
    return this.touched;
  }

  on(ev: 'flush', cb: (r: FlushResult) => void): void {
    if (ev === 'flush') this.listeners.push(cb);
  }

  /** Load world blocks into the read cache (in chunks of ≤ MAX_FETCH blocks). */
  async prefetch(box: Box): Promise<void> {
    const [sx, sy, sz] = [box.max[0] - box.min[0] + 1, box.max[1] - box.min[1] + 1, box.max[2] - box.min[2] + 1];
    if (sx <= 0 || sy <= 0 || sz <= 0) return;
    const layer = sx * sz;
    if (layer > MAX_FETCH) {
      // split along x as well
      const step = Math.max(1, Math.floor(MAX_FETCH / (sz * Math.min(sy, 64))));
      for (let x = box.min[0]; x <= box.max[0]; x += step) {
        await this.prefetch({ min: [x, box.min[1], box.min[2]], max: [Math.min(box.max[0], x + step - 1), box.max[1], box.max[2]] });
      }
      return;
    }
    const ys = Math.max(1, Math.floor(MAX_FETCH / layer));
    for (let y = box.min[1]; y <= box.max[1]; y += ys) {
      const part: Box = { min: [box.min[0], y, box.min[2]], max: [box.max[0], Math.min(box.max[1], y + ys - 1), box.max[2]] };
      const vol = await this.backend.getBlocks(part, this.dimension);
      this.addVolume(vol);
    }
  }

  /** Add an already-fetched volume to the read cache (newest wins). */
  addVolume(vol: BlockVolume): void {
    // sparse knowledge inside the new volume is superseded
    if (this.known.size) {
      for (const [x, y, z] of [...this.known.entries()]) if (boxContains(vol.box, x, y, z)) this.known.delete(x, y, z);
    }
    this.volumes.unshift(vol);
    this.lastVol = vol;
  }

  /** Whether a position is covered by the read cache (or pending changes). */
  isKnown(x: number, y: number, z: number): boolean {
    return this.changes.has(x, y, z) || this.cached(x, y, z) !== undefined;
  }

  /** State in the read cache (world state as last known), ignoring pending changes. */
  cached(x: number, y: number, z: number): string | undefined {
    const k = this.known.get(x, y, z);
    if (k !== undefined) return k;
    const lv = this.lastVol;
    if (lv && boxContains(lv.box, x, y, z)) return volGet(lv, x, y, z);
    for (const v of this.volumes) {
      if (boxContains(v.box, x, y, z)) {
        this.lastVol = v;
        return volGet(v, x, y, z);
      }
    }
    return undefined;
  }

  get(x: number, y: number, z: number): string {
    const p = this.changes.get(x, y, z);
    if (p !== undefined) return p;
    const c = this.cached(x, y, z);
    if (c !== undefined) return c;
    this.misses++;
    return AIR;
  }

  /** Pending (unflushed) state at a position, if any. */
  pendingAt(x: number, y: number, z: number): string | undefined {
    return this.changes.get(x, y, z);
  }

  inBounds(x: number, y: number, z: number): boolean {
    return !this.bounds || boxContains(this.bounds, x, y, z);
  }

  set(x: number, y: number, z: number, state: string): void {
    checkCoord(x, y, z);
    if (this.bounds && !boxContains(this.bounds, x, y, z)) {
      const b = this.bounds;
      throw new BoundsError(
        `position (${x},${y},${z}) is outside the allowed build area (${b.min.join(',')})..(${b.max.join(',')}) — the job is limited to the selection`,
      );
    }
    let s: string;
    if (state === this.lastIn) s = this.lastOut;
    else {
      s = cachedCanonical(this.reg, state);
      this.lastIn = state;
      this.lastOut = s;
    }
    if (!this.changes.has(x, y, z)) {
      if (this.touched >= this.maxBlocks) {
        throw new LimitError(
          `block limit reached: this job may change at most ${this.maxBlocks} blocks and has already set ${this.touched}. ` +
            `Build less (hollow shapes instead of solid, fewer layers) or finish the job.`,
        );
      }
      this.touched++;
    }
    this.changes.set(x, y, z, s);
  }

  /** Drop all pending changes (does not refund the block limit). */
  discard(): void {
    this.changes.clear();
  }

  /** Write pending changes to the backend. Serialized per backend. */
  flush(opts: FlushOptions = {}): Promise<FlushResult> {
    return withBackendLock(this.backend, () => this.doFlush(opts));
  }

  private async doFlush(flushOpts: FlushOptions): Promise<FlushResult> {
    const { support: supportOpt, ...opts } = flushOpts;
    const t0 = performance.now();
    const warnings: string[] = [];
    const work = this.changes;
    this.changes = new PosMap<string>();
    let multiblock = 0;
    let connections = 0;

    if (work.size === 0) {
      return { placed: 0, unchanged: 0, failed: [], changed: 0, connections: 0, multiblock: 0, batches: 0, ms: 0, warnings, record: null, support: null };
    }

    if (this.connect) {
      // 1. multiblock expansion (door tops, bed heads, tall plants)
      const extra: Array<[number, number, number, string]> = [];
      for (const [x, y, z, s] of work.entries()) {
        let parts: Array<[number, number, number, string]>;
        try {
          parts = expandMultiblock(x, y, z, s, this.reg);
        } catch (e) {
          warnings.push(`multiblock expansion failed at (${x},${y},${z}): ${(e as Error).message}`);
          continue;
        }
        for (const p of parts) extra.push(p);
      }
      for (const [x, y, z, s] of extra) {
        // never override positions that were explicitly set (agent placed both halves itself)
        if (work.has(x, y, z)) continue;
        if (!this.inBounds(x, y, z)) {
          warnings.push(`(${x},${y},${z}) part of a multi-block (${s}) is outside the build area and was not placed`);
          continue;
        }
        multiblock++;
        work.set(x, y, z, s);
      }

      // 2. neighbour shape updates (fences, panes, walls, stairs, …). The solver looks at the
      // neighbours of changed blocks and *their* neighbours → make sure ±2 is cached.
      await this.ensureCached(work, warnings);
      const getter = (x: number, y: number, z: number): string => {
        const w = work.get(x, y, z);
        if (w !== undefined) return w;
        return this.cached(x, y, z) ?? AIR;
      };
      // solveConnections looks at the neighbours of the given positions itself
      const list: Vec3[] = [];
      for (const [x, y, z] of work.entries()) list.push([x, y, z]);
      let solved: Array<[number, number, number, string]> = [];
      try {
        solved = solveConnections(getter, list, this.reg);
      } catch (e) {
        warnings.push(`connection solving failed: ${(e as Error).message}`);
      }
      for (const [x, y, z, s] of solved) {
        if (getter(x, y, z) === s) continue;
        if (!this.inBounds(x, y, z)) continue; // never touch blocks outside the job area
        if (!work.has(x, y, z) && this.cached(x, y, z) === undefined) continue;
        connections++;
        work.set(x, y, z, s);
      }
    }

    // 2b. physical plausibility: unsupported attachables are dropped / trimmed (or reported)
    let support: SupportReport | null = null;
    const supportMode = supportOpt ?? this.support;
    if (supportMode !== 'off') {
      if (!this.connect) await this.ensureCached(work, warnings);
      support = this.checkSupport(work, supportMode);
      if (support) {
        for (const line of summarizeSupport(support.changes)) warnings.push(`support: ${line}`);
        if (support.warnings.length) for (const line of summarizeSupport(support.warnings, undefined, 'found')) warnings.push(`support: ${line}`);
      }
    }

    // 3. skip blocks that already have the target state
    let unchanged = 0;
    const entries: Array<[number, number, number, string]> = [];
    for (const [x, y, z, s] of work.entries()) {
      if (this.cached(x, y, z) === s) {
        unchanged++;
        continue;
      }
      entries.push([x, y, z, s]);
    }

    const palette: string[] = [];
    const positions = new Int32Array(entries.length * 3);
    const states = new Uint16Array(entries.length);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      positions[3 * i] = e[0];
      positions[3 * i + 1] = e[1];
      positions[3 * i + 2] = e[2];
      states[i] = paletteIndex(palette, e[3]);
    }
    const batch: EditBatch = { palette, positions, states };

    let applied: Awaited<ReturnType<typeof applyBatch>> = {
      previous: [],
      failed: new Set(),
      reasons: new Map(),
      placed: 0,
      unchanged: 0,
      calls: 0,
    };
    if (entries.length) {
      applied = await applyBatch(this.backend, batch, {
        ...opts,
        dimension: this.dimension,
        updateShapes: opts.updateShapes ?? true,
      });
    }

    // 4. undo record + cache update
    const bPal: string[] = [];
    const aPal: string[] = [];
    const recPos: number[] = [];
    const bSt: number[] = [];
    const aSt: number[] = [];
    const failed: { pos: Vec3; reason: string }[] = [];
    for (let i = 0; i < entries.length; i++) {
      const [x, y, z, s] = entries[i];
      if (applied.failed.has(i)) {
        failed.push({ pos: [x, y, z], reason: applied.reasons.get(i) ?? 'failed' });
        continue;
      }
      this.remember(x, y, z, s);
      const prev = applied.previous[i] ?? AIR;
      if (prev === s) continue;
      recPos.push(x, y, z);
      bSt.push(paletteIndex(bPal, prev));
      aSt.push(paletteIndex(aPal, s));
    }
    let record: UndoRecord | null = null;
    if (aSt.length) {
      const pos = Int32Array.from(recPos);
      record = {
        id: newRecordId(),
        label: this.label,
        actor: this.actor,
        dimension: this.dimension,
        before: { palette: bPal, positions: pos, states: Uint16Array.from(bSt) },
        after: { palette: aPal, positions: pos, states: Uint16Array.from(aSt) },
        time: Date.now(),
      };
      this.records.push(record);
      this.history?.push(record);
    }
    if (failed.length) warnings.push(`${failed.length} block(s) could not be placed (first: ${failed[0].reason})`);

    const result: FlushResult = {
      placed: entries.length ? applied.placed : 0,
      unchanged: unchanged + applied.unchanged,
      failed,
      changed: aSt.length,
      connections,
      multiblock,
      batches: applied.calls,
      ms: Math.round(performance.now() - t0),
      warnings,
      record,
      support,
    };
    for (const cb of this.listeners) {
      try {
        cb(result);
      } catch {
        /* listener errors must not break the build */
      }
    }
    return result;
  }

  /** Seeds = changed blocks that need support + known neighbours of changed blocks that may have lost it. */
  private checkSupport(work: PosMap<string>, mode: SupportMode): SupportReport | null {
    const reg = this.reg;
    const seeds: Vec3[] = [];
    const nb: Vec3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (const [x, y, z, s] of work.entries()) {
      if (needsSupport(s, reg)) seeds.push([x, y, z]);
      if (reg.isFullSolid(s)) continue; // a full block never removes support from its neighbours
      for (const d of nb) {
        const px = x + d[0], py = y + d[1], pz = z + d[2];
        if (work.has(px, py, pz)) continue;
        const c = this.cached(px, py, pz);
        if (c !== undefined && needsSupport(c, reg)) seeds.push([px, py, pz]);
      }
    }
    if (!seeds.length) return null;
    const get = (x: number, y: number, z: number): string | undefined => work.get(x, y, z) ?? this.cached(x, y, z);
    const rep = resolveSupport(seeds, get, reg, {
      mode,
      allow: (x, y, z) => this.inBounds(x, y, z) && (work.has(x, y, z) || this.cached(x, y, z) !== undefined),
      set: (x, y, z, st) => work.set(x, y, z, cachedCanonical(reg, st)),
    });
    return rep.changes.length || rep.warnings.length ? rep : null;
  }

  private remember(x: number, y: number, z: number, s: string): void {
    let inVol = false;
    for (const v of this.volumes) {
      if (boxContains(v.box, x, y, z)) {
        volSet(v, x, y, z, s);
        inVol = true;
      }
    }
    if (!inVol) this.known.set(x, y, z, s);
  }

  /** Prefetch blocks within Manhattan distance 2 of `work` that are not cached yet (bounded size). */
  private async ensureCached(work: PosMap<string>, warnings: string[]): Promise<void> {
    let bb: Box | null = null;
    for (const [x, y, z] of work.entries()) {
      if (!bb) bb = { min: [x, y, z], max: [x, y, z] };
      else {
        if (x < bb.min[0]) bb.min[0] = x;
        if (y < bb.min[1]) bb.min[1] = y;
        if (z < bb.min[2]) bb.min[2] = z;
        if (x > bb.max[0]) bb.max[0] = x;
        if (y > bb.max[1]) bb.max[1] = y;
        if (z > bb.max[2]) bb.max[2] = z;
      }
    }
    if (!bb) return;
    const grown = boxExpand(bb, 2);
    if (this.volumes.some((v) => boxContainsBox(v.box, grown))) return; // fast path: job area prefetched
    let min: Vec3 | null = null;
    let max: Vec3 | null = null;
    for (const [x, y, z] of work.entries()) {
      for (const [dx, dy, dz] of NEAR2) {
        const px = x + dx;
        const py = y + dy;
        const pz = z + dz;
        if (work.has(px, py, pz) || this.cached(px, py, pz) !== undefined) continue;
        if (!min || !max) {
          min = [px, py, pz];
          max = [px, py, pz];
        } else {
          if (px < min[0]) min[0] = px;
          if (py < min[1]) min[1] = py;
          if (pz < min[2]) min[2] = pz;
          if (px > max[0]) max[0] = px;
          if (py > max[1]) max[1] = py;
          if (pz > max[2]) max[2] = pz;
        }
      }
    }
    if (!min || !max) return;
    const box: Box = { min, max };
    if (boxVolume(box) > 4 * MAX_FETCH) {
      warnings.push(`neighbour region ${boxToString(box)} too large to prefetch; connections at unknown neighbours were skipped`);
      return;
    }
    try {
      await this.prefetch(box);
    } catch (e) {
      warnings.push(`could not prefetch neighbours: ${(e as Error).message}`);
    }
  }
}

/** offsets with Manhattan distance 1..2 */
const NEAR2: Vec3[] = [];
for (let dx = -2; dx <= 2; dx++)
  for (let dy = -2; dy <= 2; dy++)
    for (let dz = -2; dz <= 2; dz++) {
      const d = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
      if (d >= 1 && d <= 2) NEAR2.push([dx, dy, dz]);
    }

// ------------------------------------------------------------------ History

interface ActorStacks {
  undo: UndoRecord[];
  redo: UndoRecord[];
}

export interface HistoryOptions {
  /** max undo steps per actor (default 100) */
  limit?: number;
}

export class History {
  readonly limit: number;
  private stacks = new Map<string, ActorStacks>();

  constructor(opts: HistoryOptions = {}) {
    this.limit = Math.max(1, opts.limit ?? 100);
  }

  private stack(actor: string): ActorStacks {
    let s = this.stacks.get(actor);
    if (!s) this.stacks.set(actor, (s = { undo: [], redo: [] }));
    return s;
  }

  push(rec: UndoRecord): void {
    const s = this.stack(rec.actor);
    s.undo.push(rec);
    s.redo.length = 0;
    while (s.undo.length > this.limit) s.undo.shift();
  }

  /** undo stack, oldest first */
  list(actor: string): UndoRecord[] {
    return [...this.stack(actor).undo];
  }

  redoList(actor: string): UndoRecord[] {
    return [...this.stack(actor).redo];
  }

  /** id of the newest undo record ('' if none) — pass to groupAfter() later */
  mark(actor: string): string {
    const u = this.stack(actor).undo;
    return u.length ? u[u.length - 1].id : '';
  }

  clear(actor?: string): void {
    if (actor === undefined) this.stacks.clear();
    else this.stacks.delete(actor);
  }

  async undo(actor: string, backend: WorldBackend): Promise<UndoRecord | null> {
    return withBackendLock(backend, async () => {
      const s = this.stack(actor);
      const rec = s.undo.pop();
      if (!rec) return null;
      try {
        await applyBatch(backend, rec.before, { dimension: rec.dimension, updateShapes: true });
      } catch (e) {
        s.undo.push(rec);
        throw e;
      }
      s.redo.push(rec);
      return rec;
    });
  }

  async redo(actor: string, backend: WorldBackend): Promise<UndoRecord | null> {
    return withBackendLock(backend, async () => {
      const s = this.stack(actor);
      const rec = s.redo.pop();
      if (!rec) return null;
      try {
        await applyBatch(backend, rec.after, { dimension: rec.dimension, updateShapes: true });
      } catch (e) {
        s.redo.push(rec);
        throw e;
      }
      s.undo.push(rec);
      return rec;
    });
  }

  /** Merge the record `sinceId` (inclusive) and everything newer into one undo step. */
  group(actor: string, sinceId: string, label: string): UndoRecord | null {
    const u = this.stack(actor).undo;
    const i = u.findIndex((r) => r.id === sinceId);
    if (i < 0) throw new Error(`undo record ${sinceId} not found for ${actor}`);
    return this.mergeFrom(actor, i, label);
  }

  /** Merge everything pushed after `markId` (exclusive; '' = whole stack) into one step. */
  groupAfter(actor: string, markId: string, label: string): UndoRecord | null {
    const u = this.stack(actor).undo;
    let i = 0;
    if (markId) {
      const j = u.findIndex((r) => r.id === markId);
      // mark fell off the bottom of the stack (limit) → group everything still there
      i = j < 0 ? 0 : j + 1;
    }
    return this.mergeFrom(actor, i, label);
  }

  private mergeFrom(actor: string, i: number, label: string): UndoRecord | null {
    const u = this.stack(actor).undo;
    const parts = u.slice(i);
    if (parts.length === 0) return null;
    const merged = mergeRecords(parts, label);
    u.splice(i, parts.length);
    if (merged) u.push(merged);
    return merged;
  }
}

/** Merge consecutive undo records (oldest first): earliest `before`, latest `after` per position. */
export function mergeRecords(recs: UndoRecord[], label: string): UndoRecord | null {
  if (!recs.length) return null;
  const dim = recs[0].dimension;
  for (const r of recs) {
    if (r.dimension !== dim) throw new Error(`cannot group undo records of different dimensions (${dim}, ${r.dimension})`);
  }
  const map = new PosMap<[string, string]>();
  const order: Vec3[] = [];
  for (const r of recs) {
    const n = r.after.states.length;
    for (let k = 0; k < n; k++) {
      const x = r.after.positions[3 * k];
      const y = r.after.positions[3 * k + 1];
      const z = r.after.positions[3 * k + 2];
      const a = r.after.palette[r.after.states[k]];
      const e = map.get(x, y, z);
      if (e) e[1] = a;
      else {
        map.set(x, y, z, [r.before.palette[r.before.states[k]], a]);
        order.push([x, y, z]);
      }
    }
  }
  const bPal: string[] = [];
  const aPal: string[] = [];
  const pos: number[] = [];
  const bs: number[] = [];
  const as: number[] = [];
  for (const [x, y, z] of order) {
    const [b, a] = map.get(x, y, z)!;
    if (a === b) continue;
    pos.push(x, y, z);
    bs.push(paletteIndex(bPal, b));
    as.push(paletteIndex(aPal, a));
  }
  const positions = Int32Array.from(pos);
  const last = recs[recs.length - 1];
  return {
    id: newRecordId(),
    label,
    actor: last.actor,
    dimension: dim,
    before: as.length ? { palette: bPal, positions, states: Uint16Array.from(bs) } : emptyBatch(),
    after: as.length ? { palette: aPal, positions, states: Uint16Array.from(as) } : emptyBatch(),
    time: last.time,
  };
}

