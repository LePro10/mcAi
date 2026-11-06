// Dense block volumes, boxes and sparse edit batches. See docs/ENGINE-API.md (core-data).
// Layout of BlockVolume.data: x fastest, then z, then y (ARCHITECTURE §3).

import type { Box, Vec3, BlockVolume, EditBatch } from './types.ts';
import { AIR } from './blockstate.ts';

/** Largest dense volume we allow in memory (2 bytes per block → 128 MiB). */
export const MAX_VOLUME = 64 * 1024 * 1024;

export function normBox(a: Vec3, b: Vec3): Box {
  return {
    min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
    max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
  };
}

export function boxSize(b: Box): Vec3 {
  return [b.max[0] - b.min[0] + 1, b.max[1] - b.min[1] + 1, b.max[2] - b.min[2] + 1];
}

export function boxVolume(b: Box): number {
  const s = boxSize(b);
  return s[0] * s[1] * s[2];
}

export function boxContains(b: Box, x: number, y: number, z: number): boolean {
  return (
    x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1] && z >= b.min[2] && z <= b.max[2]
  );
}

export function boxContainsBox(outer: Box, inner: Box): boolean {
  return (
    boxContains(outer, inner.min[0], inner.min[1], inner.min[2]) &&
    boxContains(outer, inner.max[0], inner.max[1], inner.max[2])
  );
}

export function boxUnion(a: Box, b: Box): Box {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

export function boxIntersect(a: Box, b: Box): Box | null {
  const min: Vec3 = [Math.max(a.min[0], b.min[0]), Math.max(a.min[1], b.min[1]), Math.max(a.min[2], b.min[2])];
  const max: Vec3 = [Math.min(a.max[0], b.max[0]), Math.min(a.max[1], b.max[1]), Math.min(a.max[2], b.max[2])];
  if (min[0] > max[0] || min[1] > max[1] || min[2] > max[2]) return null;
  return { min, max };
}

export function boxExpand(b: Box, n: number): Box {
  return {
    min: [b.min[0] - n, b.min[1] - n, b.min[2] - n],
    max: [b.max[0] + n, b.max[1] + n, b.max[2] + n],
  };
}

export function boxTranslate(b: Box, d: Vec3): Box {
  return {
    min: [b.min[0] + d[0], b.min[1] + d[1], b.min[2] + d[2]],
    max: [b.max[0] + d[0], b.max[1] + d[1], b.max[2] + d[2]],
  };
}

export function boxToString(b: Box): string {
  return `(${b.min.join(',')})..(${b.max.join(',')})`;
}

export function volIndex(box: Box, x: number, y: number, z: number): number {
  const sx = box.max[0] - box.min[0] + 1;
  const sz = box.max[2] - box.min[2] + 1;
  return (y - box.min[1]) * sx * sz + (z - box.min[2]) * sx + (x - box.min[0]);
}

export function createVolume(box: Box): BlockVolume {
  const b = normBox(box.min, box.max);
  const n = boxVolume(b);
  if (n > MAX_VOLUME) {
    throw new RangeError(`volume ${boxToString(b)} has ${n} blocks, more than the in-memory maximum of ${MAX_VOLUME}`);
  }
  return { box: b, palette: [AIR], data: new Uint16Array(n) };
}

// palette lookup cache (string -> index); rebuilt when the palette was changed by someone else
const paletteMaps = new WeakMap<string[], Map<string, number>>();

/** Index of `state` in `palette`, appending it if needed (Map-backed dedupe). */
export function paletteIndex(palette: string[], state: string): number {
  let m = paletteMaps.get(palette);
  if (!m || m.size !== palette.length) {
    m = new Map();
    for (let i = 0; i < palette.length; i++) if (!m.has(palette[i])) m.set(palette[i], i);
    if (m.size !== palette.length) {
      // palette contains duplicates: keep a consistent map anyway (size mismatch → rebuild each
      // time would be slow), so pad with sentinel keys.
      for (let i = 0; m.size < palette.length; i++) m.set(`\u0000dup${i}`, -1);
    }
    paletteMaps.set(palette, m);
  }
  let i = m.get(state);
  if (i === undefined) {
    i = palette.length;
    if (i > 0xffff) throw new RangeError('palette overflow: more than 65536 distinct block states');
    palette.push(state);
    m.set(state, i);
  }
  return i;
}

export function volGet(v: BlockVolume, x: number, y: number, z: number): string {
  if (!boxContains(v.box, x, y, z)) return AIR;
  return v.palette[v.data[volIndex(v.box, x, y, z)]] ?? AIR;
}

export function volSet(v: BlockVolume, x: number, y: number, z: number, state: string): void {
  if (!boxContains(v.box, x, y, z)) {
    throw new RangeError(`position (${x},${y},${z}) is outside the volume ${boxToString(v.box)}`);
  }
  v.data[volIndex(v.box, x, y, z)] = paletteIndex(v.palette, state);
}

/** Iterate every position of a volume (x fastest, then z, then y). */
export function volForEach(
  v: BlockVolume,
  cb: (x: number, y: number, z: number, state: string, index: number) => void,
  opts: { skipAir?: boolean } = {},
): void {
  const [sx, , sz] = boxSize(v.box);
  const [x0, y0, z0] = v.box.min;
  const n = v.data.length;
  const airIdx = opts.skipAir ? new Set(v.palette.map((s, i) => (isAirState(s) ? i : -1)).filter((i) => i >= 0)) : null;
  for (let i = 0; i < n; i++) {
    const p = v.data[i];
    if (airIdx && airIdx.has(p)) continue;
    const x = i % sx;
    const rest = (i - x) / sx;
    const z = rest % sz;
    const y = (rest - z) / sz;
    cb(x0 + x, y0 + y, z0 + z, v.palette[p], i);
  }
}

function isAirState(s: string): boolean {
  return s === AIR || s === 'minecraft:cave_air' || s === 'minecraft:void_air';
}

export function cloneVolume(v: BlockVolume): BlockVolume {
  return { box: { min: [...v.box.min], max: [...v.box.max] }, palette: [...v.palette], data: new Uint16Array(v.data) };
}

/** Copy `src` into `dst` where they overlap. */
export function volPaste(dst: BlockVolume, src: BlockVolume): void {
  const ov = boxIntersect(dst.box, src.box);
  if (!ov) return;
  const remap = src.palette.map((s) => paletteIndex(dst.palette, s));
  for (let y = ov.min[1]; y <= ov.max[1]; y++)
    for (let z = ov.min[2]; z <= ov.max[2]; z++) {
      let di = volIndex(dst.box, ov.min[0], y, z);
      let si = volIndex(src.box, ov.min[0], y, z);
      for (let x = ov.min[0]; x <= ov.max[0]; x++) dst.data[di++] = remap[src.data[si++]];
    }
}

/** Remove unused palette entries (keeps index 0 = air). */
export function compactVolume(v: BlockVolume): BlockVolume {
  const used = new Uint8Array(v.palette.length);
  for (let i = 0; i < v.data.length; i++) used[v.data[i]] = 1;
  const palette = [AIR];
  const remap = new Uint16Array(v.palette.length);
  for (let i = 0; i < v.palette.length; i++) {
    if (!used[i] && i !== 0) continue;
    remap[i] = i === 0 || v.palette[i] === AIR ? 0 : paletteIndex(palette, v.palette[i]);
  }
  const data = new Uint16Array(v.data.length);
  for (let i = 0; i < data.length; i++) data[i] = remap[v.data[i]];
  return { box: v.box, palette, data };
}

// ---------------------------------------------------------------------------- batches

export function batchFromEntries(entries: Iterable<[number, number, number, string]>): EditBatch {
  const palette: string[] = [];
  const pos: number[] = [];
  const st: number[] = [];
  for (const [x, y, z, s] of entries) {
    pos.push(x, y, z);
    st.push(paletteIndex(palette, s));
  }
  return { palette, positions: Int32Array.from(pos), states: Uint16Array.from(st) };
}

export function batchSize(b: EditBatch): number {
  return b.states.length;
}

export function* batchEntries(b: EditBatch): Generator<[number, number, number, string]> {
  for (let i = 0; i < b.states.length; i++) {
    yield [b.positions[3 * i], b.positions[3 * i + 1], b.positions[3 * i + 2], b.palette[b.states[i]]];
  }
}

/** Split a batch into batches of at most `max` entries (palettes are shared, not copied). */
export function splitBatch(b: EditBatch, max: number): EditBatch[] {
  const n = b.states.length;
  if (n <= max) return [b];
  const out: EditBatch[] = [];
  for (let i = 0; i < n; i += max) {
    const j = Math.min(n, i + max);
    out.push({ palette: b.palette, positions: b.positions.subarray(3 * i, 3 * j), states: b.states.subarray(i, j) });
  }
  return out;
}

export function emptyBatch(): EditBatch {
  return { palette: [], positions: new Int32Array(0), states: new Uint16Array(0) };
}

/** Bounding box of a batch, or null if empty. */
export function batchBounds(b: EditBatch): Box | null {
  if (!b.states.length) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < b.positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const c = b.positions[i + a];
      if (c < min[a]) min[a] = c;
      if (c > max[a]) max[a] = c;
    }
  }
  return { min, max };
}

// ---------------------------------------------------------------------------- base64 helpers

export function typedToB64(a: Int32Array | Uint16Array | Int16Array | Uint8Array): string {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
}

export function b64ToUint16(s: string): Uint16Array {
  const buf = Buffer.from(s, 'base64');
  const out = new Uint16Array(buf.byteLength >> 1);
  new Uint8Array(out.buffer).set(buf.subarray(0, out.byteLength));
  return out;
}

export function b64ToInt32(s: string): Int32Array {
  const buf = Buffer.from(s, 'base64');
  const out = new Int32Array(buf.byteLength >> 2);
  new Uint8Array(out.buffer).set(buf.subarray(0, out.byteLength));
  return out;
}
