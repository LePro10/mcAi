// Mod <-> engine wire protocol helpers (docs/ARCHITECTURE.md §5).
// Binary arrays travel as base64 of little-endian typed arrays.

import os from 'node:os';
import type { Box, BlockRegistry, EditBatch, Facing, PlayerInfo, Vec3 } from '../core/types.ts';

const LITTLE = os.endianness() === 'LE';

type Typed = Int32Array | Uint16Array | Int16Array;
type TypedCtor<T extends Typed> = { new (buf: ArrayBuffer): T; BYTES_PER_ELEMENT: number };

function swapBytes(bytes: Uint8Array, width: number): void {
  for (let i = 0; i + width <= bytes.length; i += width) {
    for (let a = i, b = i + width - 1; a < b; a++, b--) {
      const t = bytes[a]!;
      bytes[a] = bytes[b]!;
      bytes[b] = t;
    }
  }
}

/** typed array -> base64 (little endian) */
export function b64encode(arr: Typed): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  if (LITTLE) return Buffer.from(bytes).toString('base64');
  const copy = Uint8Array.from(bytes);
  swapBytes(copy, arr.BYTES_PER_ELEMENT);
  return Buffer.from(copy).toString('base64');
}

function decode<T extends Typed>(s: string | undefined | null, ctor: TypedCtor<T>, what: string): T {
  if (s == null || s === '') return new ctor(new ArrayBuffer(0));
  if (typeof s !== 'string') throw new ProtocolError(`${what}: expected base64 string`);
  const buf = Buffer.from(s, 'base64');
  if (buf.length % ctor.BYTES_PER_ELEMENT !== 0) {
    throw new ProtocolError(`${what}: byte length ${buf.length} is not a multiple of ${ctor.BYTES_PER_ELEMENT}`);
  }
  const ab = new ArrayBuffer(buf.length);
  const view = new Uint8Array(ab);
  view.set(buf);
  if (!LITTLE) swapBytes(view, ctor.BYTES_PER_ELEMENT);
  return new ctor(ab);
}

export const b64ToInt32 = (s: string | undefined | null, what = 'int32[]') => decode(s, Int32Array, what);
export const b64ToUint16 = (s: string | undefined | null, what = 'uint16[]') => decode(s, Uint16Array, what);
export const b64ToInt16 = (s: string | undefined | null, what = 'int16[]') => decode(s, Int16Array, what);

export class ProtocolError extends Error {}

/** Wire form of an EditBatch (set_blocks payload / previous). */
export interface WireBatch {
  palette: string[];
  positions?: string;
  states: string;
}

export function encodeBatch(b: EditBatch): Required<WireBatch> {
  return { palette: b.palette, positions: b64encode(b.positions), states: b64encode(b.states) };
}

export function decodeBatch(w: WireBatch, positions?: Int32Array): EditBatch {
  const pos = positions ?? b64ToInt32(w.positions, 'positions');
  const states = b64ToUint16(w.states, 'states');
  if (states.length * 3 !== pos.length) {
    throw new ProtocolError(`batch: ${states.length} states but ${pos.length / 3} positions`);
  }
  if (!Array.isArray(w.palette)) throw new ProtocolError('batch: palette must be an array');
  for (let i = 0; i < states.length; i++) {
    if (states[i]! >= w.palette.length) throw new ProtocolError(`batch: state index ${states[i]} out of palette range`);
  }
  return { palette: w.palette, positions: pos, states };
}

/** Split a batch into chunks of at most `max` blocks, each with a compacted palette. */
export function splitBatch(b: EditBatch, max: number): EditBatch[] {
  const n = b.states.length;
  if (n <= max) return [b];
  const out: EditBatch[] = [];
  for (let start = 0; start < n; start += max) {
    const end = Math.min(n, start + max);
    const remap = new Map<number, number>();
    const palette: string[] = [];
    const states = new Uint16Array(end - start);
    for (let i = start; i < end; i++) {
      const s = b.states[i]!;
      let m = remap.get(s);
      if (m === undefined) {
        m = palette.length;
        palette.push(b.palette[s]!);
        remap.set(s, m);
      }
      states[i - start] = m;
    }
    out.push({ palette, positions: b.positions.slice(start * 3, end * 3), states });
  }
  return out;
}

/** Concatenate batches (palettes merged). */
export function concatBatches(parts: EditBatch[]): EditBatch {
  if (parts.length === 1) return parts[0]!;
  const palette: string[] = [];
  const index = new Map<string, number>();
  let total = 0;
  for (const p of parts) total += p.states.length;
  const positions = new Int32Array(total * 3);
  const states = new Uint16Array(total);
  let o = 0;
  for (const p of parts) {
    const remap = p.palette.map((s) => {
      let i = index.get(s);
      if (i === undefined) {
        i = palette.length;
        palette.push(s);
        index.set(s, i);
      }
      return i;
    });
    positions.set(p.positions, o * 3);
    for (let i = 0; i < p.states.length; i++) states[o + i] = remap[p.states[i]!]!;
    o += p.states.length;
  }
  return { palette, positions, states };
}

// ---- message shapes (documentation + light validation) ----

export interface DimensionInfo {
  id: string;
  minY: number;
  maxY: number;
  seaLevel?: number;
}

export interface HelloMsg {
  type: 'hello';
  id?: string;
  modVersion: string;
  mcVersion: string;
  world: string;
  serverType: 'integrated' | 'dedicated';
  registry: BlockRegistry;
  /** dimension ids, or objects with height info */
  dimensions: Array<string | DimensionInfo>;
}

export interface BuildRequestMsg {
  type: 'build_request';
  id: string;
  player: PlayerInfo;
  prompt: string;
  selection?: Box;
  anchor: Vec3;
  facing: Facing;
  options?: { style?: string; mode?: 'build' | 'plan' };
}

export interface JobControlMsg {
  type: 'job_control';
  id?: string;
  action: 'cancel' | 'undo' | 'redo' | 'confirm' | 'reject';
  player: string;
  jobId?: string;
}

export interface PlayerReplyMsg {
  type: 'player_reply';
  id?: string;
  player: string;
  jobId: string;
  text: string;
}

export interface ToolRequestMsg {
  type: 'tool_request';
  id: string;
  player: string;
  tool: string;
  args: Record<string, unknown>;
}

export type ModEvent = HelloMsg | BuildRequestMsg | JobControlMsg | PlayerReplyMsg | ToolRequestMsg;

export interface JobUpdatePayload {
  jobId: string;
  player: string;
  state: 'queued' | 'thinking' | 'building' | 'reviewing' | 'done' | 'failed' | 'cancelled';
  progress: number;
  stage: string;
  detail: string;
  costUsd: number;
}

export function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

export function isBox(b: unknown): b is Box {
  return !!b && typeof b === 'object' && isVec3((b as Box).min) && isVec3((b as Box).max);
}

export function normalizeBox(b: Box): Box {
  const min: Vec3 = [0, 0, 0];
  const max: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const a = Math.floor(b.min[i]!);
    const c = Math.floor(b.max[i]!);
    min[i] = Math.min(a, c);
    max[i] = Math.max(a, c);
  }
  return { min, max };
}
