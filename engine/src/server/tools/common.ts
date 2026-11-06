// Shared plumbing for the MCP tools: environment, schemas, space conversion,
// edit sessions with undo records, and dry-run bounds checking.

import { z } from 'zod';
import type { BlockVolume, Box, EditBatch, Vec3, WorldBackend } from '../../core/types.ts';
import type { Registry } from '../../core/registry.ts';
import { Frame } from '../../core/frame.ts';
import { EditSession, BoundsError, LimitError, type FlushResult, type History } from '../../core/session.ts';
import { summarizeSupport, type SupportMode } from '../../core/support.ts';
import type { BlockSink } from '../../core/dsl.ts';
import type { StructureLibrary } from '../../core/schematic.ts';
import type { AssetStore } from '../../assets/assets.ts';
import { batchBounds, boxContains, boxIntersect, boxUnion, boxVolume, createVolume, volSet, volGet } from '../../core/volume.ts';
import { PosMap } from '../../core/posmap.ts';
import type { Config } from '../config.ts';
import type { Job, JobManager } from '../../agent/jobs.ts';

export interface ToolEnv {
  backend(): WorldBackend;
  registry(): Registry;
  config: Config;
  history: History;
  structures: StructureLibrary;
  assets(): Promise<AssetStore | null>;
  jobs: JobManager;
  /** world changed through a tool (viewer live updates) */
  onWorldChange?(batch: EditBatch, dimension: string): void;
}

export interface ToolCtx {
  job: Job;
  env: ToolEnv;
}

export interface ToolImage {
  data: string;
  mimeType: string;
}

export interface ToolOutput {
  text: string;
  images?: ToolImage[];
  /** blocks changed (for the job log) */
  blocks?: number;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject<any>;
  readOnly?: boolean;
  /** mutating tools move the job into the 'building' state */
  mutates?: boolean;
  run(args: any, ctx: ToolCtx): Promise<ToolOutput | string>;
}

/** Error with a message meant for the agent (shown verbatim, no stack). */
export class ToolError extends Error {}

// ------------------------------------------------------------------ schemas

export const Vec3In = z.tuple([z.number().int(), z.number().int(), z.number().int()]);
export const BoxIn = z
  .union([z.object({ min: Vec3In, max: Vec3In }), z.tuple([Vec3In, Vec3In])])
  .describe('inclusive box {min:[x,y,z],max:[x,y,z]} or [[x,y,z],[x,y,z]], corners in any order');
export const SpaceIn = z
  .enum(['local', 'world'])
  .default('local')
  .describe("'local' (default; see get_context) or 'world'");
export const SupportIn = z
  .enum(['drop', 'warn', 'off'])
  .default('drop')
  .describe("unsupported attachables (floating vines/torches/lanterns, flowers on stone…): 'drop' (default) removes them, 'warn' keeps them, 'off' skips the check");

export function defineTool<S extends z.ZodObject<any>>(def: Omit<ToolDef, 'input' | 'run'> & { input: S; run(args: z.infer<S>, ctx: ToolCtx): Promise<ToolOutput | string> }): ToolDef {
  return def as ToolDef;
}

// ------------------------------------------------------------------ space

export type BoxInput = { min: number[]; max: number[] } | [number[], number[]];

export function normBoxIn(bi: BoxInput): Box {
  const b = Array.isArray(bi) ? { min: bi[0], max: bi[1] } : bi;
  const min: Vec3 = [0, 0, 0];
  const max: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    min[i] = Math.min(b.min[i]!, b.max[i]!);
    max[i] = Math.max(b.min[i]!, b.max[i]!);
  }
  return { min, max };
}

export function frameOf(ctx: ToolCtx): Frame {
  const reg = ctx.env.registry();
  let f = ctx.job.scratch.get('frame') as Frame | undefined;
  if (!f || ctx.job.scratch.get('frameReg') !== reg) {
    f = new Frame(ctx.job.req.anchor, ctx.job.req.facing, reg);
    ctx.job.scratch.set('frame', f);
    ctx.job.scratch.set('frameReg', reg);
  }
  return f;
}

export function identityFrame(ctx: ToolCtx): Frame {
  return Frame.identity(ctx.env.registry());
}

export function spaceFrame(ctx: ToolCtx, space: 'local' | 'world'): Frame {
  return space === 'local' ? frameOf(ctx) : identityFrame(ctx);
}

export function toWorldBox(ctx: ToolCtx, b: Box, space: 'local' | 'world'): Box {
  return space === 'local' ? frameOf(ctx).boxToWorld(b) : b;
}

export function toWorldPos(ctx: ToolCtx, v: Vec3, space: 'local' | 'world'): Vec3 {
  return space === 'local' ? frameOf(ctx).toWorld(v) : v;
}

export function toLocalBox(ctx: ToolCtx, b: Box): Box {
  const f = frameOf(ctx);
  const a = f.toLocal(b.min);
  const c = f.toLocal(b.max);
  return normBoxIn({ min: a, max: c });
}

export function fmtV(v: readonly number[]): string {
  return `[${v.map((n) => Math.round(n * 10) / 10).join(',')}]`;
}

export function fmtBox(b: Box): string {
  const s = [b.max[0] - b.min[0] + 1, b.max[1] - b.min[1] + 1, b.max[2] - b.min[2] + 1];
  return `${fmtV(b.min)}..${fmtV(b.max)} (${s.join('x')})`;
}

/** allowed box described in both spaces */
export function allowedText(ctx: ToolCtx): string {
  return `allowed build box: world ${fmtBox(ctx.job.allowedBox)} = local ${fmtBox(toLocalBox(ctx, ctx.job.allowedBox))}`;
}

/**
 * Read a world region and return it re-oriented into the requested space: for 'local'
 * the returned volume's box is in local coordinates and block states are local.
 */
export async function readSpaceVolume(ctx: ToolCtx, boxIn: Box, space: 'local' | 'world'): Promise<{ vol: BlockVolume; worldBox: Box }> {
  const worldBox = toWorldBox(ctx, boxIn, space);
  const raw = await ctx.env.backend().getBlocks(worldBox, ctx.job.dimension);
  if (space === 'world') return { vol: raw, worldBox };
  const f = frameOf(ctx);
  const out = createVolume(boxIn);
  const localPal = new Map<number, string>();
  const rsx = raw.box.max[0] - raw.box.min[0] + 1;
  const rsxz = rsx * (raw.box.max[2] - raw.box.min[2] + 1);
  for (let y = boxIn.min[1]; y <= boxIn.max[1]; y++) {
    for (let z = boxIn.min[2]; z <= boxIn.max[2]; z++) {
      for (let x = boxIn.min[0]; x <= boxIn.max[0]; x++) {
        const w = f.toWorld([x, y, z]);
        const idx = raw.data[(w[1] - raw.box.min[1]) * rsxz + (w[2] - raw.box.min[2]) * rsx + (w[0] - raw.box.min[0])]!;
        if (idx === 0) continue;
        let s = localPal.get(idx);
        if (s === undefined) {
          s = f.stateToLocal(raw.palette[idx]!);
          localPal.set(idx, s);
        }
        volSet(out, x, y, z, s);
      }
    }
  }
  return { vol: out, worldBox };
}

// ------------------------------------------------------------------ sinks

/** Space-aware sink over an EditSession: local coords/states are rotated into the world. */
export class SpaceSink implements BlockSink {
  private session: EditSession;
  private frame: Frame | null;
  private clip: boolean;
  private bounds: Box;
  outside = 0;
  writes = 0;

  constructor(session: EditSession, frame: Frame | null, bounds: Box, clip: boolean) {
    this.session = session;
    this.frame = frame;
    this.bounds = bounds;
    this.clip = clip;
  }

  get(x: number, y: number, z: number): string {
    if (!this.frame) return this.session.get(x, y, z);
    const w = this.frame.toWorld([x, y, z]);
    return this.frame.stateToLocal(this.session.get(w[0], w[1], w[2]));
  }

  set(x: number, y: number, z: number, state: string): void {
    let wx = x, wy = y, wz = z, s = state;
    if (this.frame) {
      [wx, wy, wz] = this.frame.toWorld([x, y, z]);
      s = this.frame.stateToWorld(state);
    }
    if (!boxContains(this.bounds, wx, wy, wz)) {
      this.outside++;
      if (this.clip) return;
    }
    this.writes++;
    this.session.set(wx, wy, wz, s);
  }
}

/**
 * Dry-run sink in WORLD coordinates: records the bounding box of all reads/writes,
 * counts writes and writes outside the allowed box. Reads see earlier dry writes.
 */
export class DrySink implements BlockSink {
  private writesMap = new PosMap<string>();
  min: Vec3 = [Infinity, Infinity, Infinity];
  max: Vec3 = [-Infinity, -Infinity, -Infinity];
  writes = 0;
  outside = 0;
  outsideMin: Vec3 = [Infinity, Infinity, Infinity];
  outsideMax: Vec3 = [-Infinity, -Infinity, -Infinity];
  private bounds: Box;
  private limit: number;
  private read: ((x: number, y: number, z: number) => string) | null;

  /** `read` (optional) = the world as known so far, for ops that look at the terrain (bridge piers) */
  constructor(bounds: Box, limit: number, read: ((x: number, y: number, z: number) => string) | null = null) {
    this.bounds = bounds;
    this.limit = limit;
    this.read = read;
  }

  private touch(x: number, y: number, z: number): void {
    if (x < this.min[0]) this.min[0] = x;
    if (y < this.min[1]) this.min[1] = y;
    if (z < this.min[2]) this.min[2] = z;
    if (x > this.max[0]) this.max[0] = x;
    if (y > this.max[1]) this.max[1] = y;
    if (z > this.max[2]) this.max[2] = z;
  }

  get(x: number, y: number, z: number): string {
    this.touch(x, y, z);
    return this.writesMap.get(x, y, z) ?? (this.read ? this.read(x, y, z) : 'minecraft:air');
  }

  set(x: number, y: number, z: number, state: string): void {
    this.touch(x, y, z);
    if (!boxContains(this.bounds, x, y, z)) {
      this.outside++;
      for (let i = 0; i < 3; i++) {
        const c = [x, y, z][i]!;
        if (c < this.outsideMin[i]!) this.outsideMin[i] = c;
        if (c > this.outsideMax[i]!) this.outsideMax[i] = c;
      }
    }
    if (!this.writesMap.has(x, y, z)) this.writes++;
    if (this.writes > this.limit) throw new LimitError(`more than ${this.limit.toLocaleString('en')} blocks in one call`);
    this.writesMap.set(x, y, z, state);
  }

  get box(): Box | null {
    return this.min[0] === Infinity ? null : { min: [...this.min] as Vec3, max: [...this.max] as Vec3 };
  }
}

// ------------------------------------------------------------------ edit sessions

export function perCallLimit(ctx: ToolCtx): number {
  const left = ctx.env.config.maxBlocksPerJob - ctx.job.blocksChanged;
  if (left <= 0) {
    throw new ToolError(`block budget of this job is used up (${ctx.env.config.maxBlocksPerJob.toLocaleString('en')} blocks). Finish the job.`);
  }
  return Math.min(ctx.env.config.maxBlocksPerCall, left);
}

export function newSession(ctx: ToolCtx, label: string, maxBlocks = perCallLimit(ctx)): EditSession {
  return new EditSession(ctx.env.backend(), ctx.env.registry(), {
    bounds: ctx.job.allowedBox,
    maxBlocks,
    dimension: ctx.job.dimension,
    actor: ctx.job.player,
    label,
  });
}

/** Prefetch a world box clipped to the allowed box (+margin) and to a sane size. */
export async function prefetch(ctx: ToolCtx, session: EditSession, box: Box | null, margin = 1): Promise<void> {
  if (!box) return;
  const ab = ctx.job.allowedBox;
  const lim: Box = { min: [ab.min[0] - margin, ab.min[1] - margin, ab.min[2] - margin], max: [ab.max[0] + margin, ab.max[1] + margin, ab.max[2] + margin] };
  const b = boxIntersect({ min: [box.min[0] - margin, box.min[1] - margin, box.min[2] - margin], max: [box.max[0] + margin, box.max[1] + margin, box.max[2] + margin] }, lim);
  if (!b) return;
  if (boxVolume(b) > 24_000_000) throw new ToolError(`region ${fmtBox(b)} is too large to edit in one call; split it.`);
  await session.prefetch(b);
}

export interface FlushStats {
  /** support check summary lines (local coordinates) */
  support: string[];
  changed: number;
  unchanged: number;
  failed: number;
  undoId: string | null;
  ms: number;
  failures: string[];
  warnings: string[];
}

/** Flush a session, record undo, update job counters, notify viewer. */
export async function commit(ctx: ToolCtx, session: EditSession, label: string, opts: { support?: SupportMode; space?: 'local' | 'world' } = {}): Promise<FlushStats> {
  const t0 = Date.now();
  if (session.pending === 0) return { changed: 0, unchanged: 0, failed: 0, undoId: null, ms: 0, failures: [], warnings: [], support: [] };
  const r: FlushResult = await session.flush({ animate: 'layers', dimension: ctx.job.dimension, ...(opts.support ? { support: opts.support } : {}) });
  const support: string[] = [];
  if (r.support) {
    const f = (opts.space ?? 'local') === 'local' ? frameOf(ctx) : null;
    const fmt = (p: Vec3) => fmtV(f ? f.toLocal(p) : p);
    support.push(...summarizeSupport(r.support.changes, fmt));
    if (r.support.warnings.length) support.push(...summarizeSupport(r.support.warnings, fmt, 'kept'));
  }
  const rec = r.record;
  const changed = r.changed;
  let undoId: string | null = null;
  if (rec && rec.after.states.length > 0) {
    ctx.env.history.push(rec);
    undoId = rec.id;
    ctx.job.undoIds.push(rec.id);
    ctx.env.onWorldChange?.(rec.after, ctx.job.dimension);
  }
  ctx.job.blocksChanged += changed;
  const reasons = new Map<string, number>();
  for (const f of r.failed) reasons.set(f.reason, (reasons.get(f.reason) ?? 0) + 1);
  return {
    support,
    changed,
    unchanged: r.unchanged,
    failed: r.failed.length,
    warnings: r.warnings.filter((w) => !w.startsWith('support: ')),
    undoId,
    ms: Date.now() - t0,
    failures: [...reasons].slice(0, 5).map(([k, n]) => `${n}x ${k}`),
  };
}

export function statsText(s: FlushStats): string {
  const parts = [`changed ${s.changed} blocks`];
  if (s.unchanged) parts.push(`${s.unchanged} already correct`);
  if (s.failed) parts.push(`${s.failed} FAILED (${s.failures.join('; ')})`);
  parts.push(s.undoId ? `undo id ${s.undoId}` : 'nothing to undo');
  if (s.warnings.length) parts.push(`warnings: ${s.warnings.slice(0, 5).join(' | ')}${s.warnings.length > 5 ? ` (+${s.warnings.length - 5})` : ''}`);
  let out = parts.join(', ');
  if (s.support.length) out += `\nphysics (local coords): ${s.support.join(' | ')}`;
  return out;
}

/** Map core errors to agent-facing messages. */
export function explainError(e: unknown, ctx: ToolCtx): string {
  const err = e as Error;
  if (err instanceof ToolError) return err.message;
  if (err instanceof BoundsError) return `${err.message}. ${allowedText(ctx)}. Move/shrink the edit or pass clip:true to drop outside blocks.`;
  if (err instanceof LimitError) return `${err.message}. Split the work into several smaller calls (limit ${ctx.env.config.maxBlocksPerCall.toLocaleString('en')} blocks per call).`;
  return err?.message ?? String(e);
}

export function volCounts(v: BlockVolume): Map<string, number> {
  const counts = new Uint32Array(v.palette.length);
  for (let i = 0; i < v.data.length; i++) counts[v.data[i]!]!++;
  const m = new Map<string, number>();
  v.palette.forEach((s, i) => {
    if (counts[i]) m.set(s, (m.get(s) ?? 0) + counts[i]!);
  });
  return m;
}

export { volGet };

/** short id: drop 'minecraft:' */
export function short(s: string): string {
  return s.startsWith('minecraft:') ? s.slice(10) : s;
}

export function clampInt(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/** Bounding box (world) of everything this job changed so far, or null. */
export function jobEditBounds(ctx: ToolCtx): Box | null {
  const ids = new Set(ctx.job.undoIds);
  let out: Box | null = null;
  for (const rec of ctx.env.history.list(ctx.job.player)) {
    if (!ids.has(rec.id)) continue;
    const b = batchBounds(rec.after);
    if (b) out = out ? boxUnion(out, b) : b;
  }
  return out;
}

/**
 * Positions edited by this job (world) → the state they had BEFORE the job first touched them.
 * Built from the job's undo records (oldest first); undone records are not included.
 */
export function jobOriginals(ctx: ToolCtx): PosMap<string> {
  const ids = new Set(ctx.job.undoIds);
  const out = new PosMap<string>();
  for (const rec of ctx.env.history.list(ctx.job.player)) {
    if (!ids.has(rec.id)) continue;
    const b = rec.before;
    for (let k = 0; k < b.states.length; k++) {
      const x = b.positions[3 * k]!, y = b.positions[3 * k + 1]!, z = b.positions[3 * k + 2]!;
      if (!out.has(x, y, z)) out.set(x, y, z, b.palette[b.states[k]!]!);
    }
  }
  return out;
}
