// Clipboards: copy / transform / paste / stack / move. See docs/ENGINE-API.md (core-data).
//
// A Clipboard holds a dense volume plus `origin` = the copy point relative to volume.box.min.
// Pasting at `at` puts the copy point at `at`: world = at - origin + (p - box.min).

import type { Box, Vec3, BlockVolume, WorldBackend } from './types.ts';
import type { Registry } from './registry.ts';
import type { BlockSink } from './dsl.ts';
import type { MaskFn } from './mask.ts';
import type { QuarterTurns } from './transform.ts';
import { rotateState, mirrorState } from './transform.ts';
import { isAir, AIR } from './blockstate.ts';
import { boxSize, createVolume, paletteIndex, volIndex, boxVolume, MAX_VOLUME } from './volume.ts';

export interface ClipboardEntity {
  id: string;
  /** position relative to volume.box.min (may be fractional) */
  pos: [number, number, number];
  /** entity NBT as SNBT (without id/Pos) */
  snbt?: string;
}

export interface Clipboard {
  volume: BlockVolume;
  /** offset of the copy point relative to volume.box.min */
  origin: Vec3;
  entities?: unknown[];
  meta?: Record<string, unknown>;
}

const STRUCTURE_VOID = 'minecraft:structure_void';

/** Copy a world region. `origin` is the world position of the copy point (e.g. the player). */
export async function copyRegion(backend: WorldBackend, box: Box, origin: Vec3, dimension?: string): Promise<Clipboard> {
  const n = boxVolume(box);
  if (n > MAX_VOLUME) throw new RangeError(`copy region has ${n} blocks (max ${MAX_VOLUME})`);
  let volume: BlockVolume;
  const [sx, sy, sz] = boxSize(box);
  const layer = sx * sz;
  const step = Math.max(1, Math.floor(1_000_000 / layer));
  if (sy <= step) volume = await backend.getBlocks(box, dimension);
  else {
    volume = createVolume(box);
    for (let y = box.min[1]; y <= box.max[1]; y += step) {
      const part = await backend.getBlocks(
        { min: [box.min[0], y, box.min[2]], max: [box.max[0], Math.min(box.max[1], y + step - 1), box.max[2]] },
        dimension,
      );
      const remap = part.palette.map((s) => paletteIndex(volume.palette, s));
      const off = volIndex(volume.box, box.min[0], y, box.min[2]);
      for (let i = 0; i < part.data.length; i++) volume.data[off + i] = remap[part.data[i]];
    }
  }
  return {
    volume,
    origin: [origin[0] - volume.box.min[0], origin[1] - volume.box.min[1], origin[2] - volume.box.min[2]],
    meta: { copiedFrom: { min: [...box.min], max: [...box.max] }, dimension },
  };
}

/** Copy from any BlockSink (e.g. an EditSession with prefetched cache). */
export function copyFromSink(sink: BlockSink, box: Box, origin: Vec3): Clipboard {
  const volume = createVolume(box);
  let i = 0;
  for (let y = box.min[1]; y <= box.max[1]; y++)
    for (let z = box.min[2]; z <= box.max[2]; z++)
      for (let x = box.min[0]; x <= box.max[0]; x++) volume.data[i++] = paletteIndex(volume.palette, sink.get(x, y, z));
  return { volume, origin: [origin[0] - box.min[0], origin[1] - box.min[1], origin[2] - box.min[2]] };
}

/** Rotate a relative vector clockwise (seen from above) by quarter turns: north→east→south→west. */
function rot(x: number, z: number, t: number): [number, number] {
  switch (t & 3) {
    case 1:
      return [-z, x];
    case 2:
      return [-x, -z];
    case 3:
      return [z, -x];
    default:
      return [x, z];
  }
}

/**
 * Mirror (first) and/or rotate (second) positions *and* block states around the copy point.
 * The copy point keeps its world position, so pasting the result at the same spot rotates in place.
 */
export function transformClipboard(c: Clipboard, t: { rotate?: QuarterTurns; mirror?: 'x' | 'z' }, reg: Registry): Clipboard {
  const turns = ((t.rotate ?? 0) & 3) as QuarterTurns;
  const mirror = t.mirror;
  if (!turns && !mirror) return c;
  const v = c.volume;
  const [sx, sy, sz] = boxSize(v.box);
  const W: Vec3 = [v.box.min[0] + c.origin[0], v.box.min[1] + c.origin[1], v.box.min[2] + c.origin[2]];
  const tf = (rx: number, rz: number): [number, number] => {
    if (mirror === 'x') rx = -rx;
    else if (mirror === 'z') rz = -rz;
    return rot(rx, rz, turns);
  };
  // relative coords of the source box corners (relative to the copy point)
  const x0 = -c.origin[0];
  const z0 = -c.origin[2];
  const x1 = x0 + sx - 1;
  const z1 = z0 + sz - 1;
  const corners = [tf(x0, z0), tf(x1, z0), tf(x0, z1), tf(x1, z1)];
  const nminx = Math.min(...corners.map((q) => q[0]));
  const nminz = Math.min(...corners.map((q) => q[1]));
  const nmaxx = Math.max(...corners.map((q) => q[0]));
  const nmaxz = Math.max(...corners.map((q) => q[1]));
  const nbox: Box = {
    min: [W[0] + nminx, v.box.min[1], W[2] + nminz],
    max: [W[0] + nmaxx, v.box.max[1], W[2] + nmaxz],
  };
  const out = createVolume(nbox);
  // state remap per palette entry
  const remap = new Uint16Array(v.palette.length);
  for (let i = 0; i < v.palette.length; i++) {
    let s = v.palette[i];
    if (!isAir(s)) {
      if (mirror) s = mirrorState(s, mirror, reg);
      if (turns) s = rotateState(s, turns, reg);
    }
    remap[i] = paletteIndex(out.palette, s);
  }
  const [osx, , osz] = boxSize(nbox);
  let i = 0;
  for (let y = 0; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++, i++) {
        const p = v.data[i];
        if (p === 0 && remap[0] === 0) continue;
        const [nx, nz] = tf(x0 + x, z0 + z);
        const ox = W[0] + nx - nbox.min[0];
        const oz = W[2] + nz - nbox.min[2];
        out.data[y * osx * osz + oz * osx + ox] = remap[p];
      }
  const entities = (c.entities as ClipboardEntity[] | undefined)?.map((e) => {
    // block-centred relative position → transform → back
    const rx = v.box.min[0] + e.pos[0] - W[0] - 0.5;
    const rz = v.box.min[2] + e.pos[2] - W[2] - 0.5;
    const [nx, nz] = tf(rx, rz);
    return { ...e, pos: [W[0] + nx + 0.5 - nbox.min[0], e.pos[1], W[2] + nz + 0.5 - nbox.min[2]] as [number, number, number] };
  });
  return {
    volume: out,
    origin: [W[0] - nbox.min[0], W[1] - nbox.min[1], W[2] - nbox.min[2]],
    entities,
    meta: { ...(c.meta ?? {}), transformed: { rotate: turns, mirror: mirror ?? null } },
  };
}

export interface PasteOptions {
  /** skip air blocks of the clipboard (default false) */
  ignoreAir?: boolean;
  /** only paste where the mask matches the current world block */
  mask?: MaskFn;
}

/** Paste so that the clipboard's copy point lands at `at`. Returns blocks set. structure_void is never pasted. */
export function pasteInto(sink: BlockSink, c: Clipboard, at: Vec3, opts: PasteOptions = {}): number {
  const v = c.volume;
  const [sx, sy, sz] = boxSize(v.box);
  const bx = at[0] - c.origin[0];
  const by = at[1] - c.origin[1];
  const bz = at[2] - c.origin[2];
  const skip = new Uint8Array(v.palette.length);
  for (let i = 0; i < v.palette.length; i++) {
    const s = v.palette[i];
    if (s === STRUCTURE_VOID || (opts.ignoreAir && isAir(s))) skip[i] = 1;
  }
  let n = 0;
  let i = 0;
  for (let y = 0; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++, i++) {
        const p = v.data[i];
        if (skip[p]) continue;
        const wx = bx + x;
        const wy = by + y;
        const wz = bz + z;
        if (opts.mask && !opts.mask(wx, wy, wz, sink.get(wx, wy, wz))) continue;
        sink.set(wx, wy, wz, v.palette[p]);
        n++;
      }
  return n;
}

/** World box a paste at `at` would cover. */
export function pasteBox(c: Clipboard, at: Vec3): Box {
  const [sx, sy, sz] = boxSize(c.volume.box);
  const min: Vec3 = [at[0] - c.origin[0], at[1] - c.origin[1], at[2] - c.origin[2]];
  return { min, max: [min[0] + sx - 1, min[1] + sy - 1, min[2] + sz - 1] };
}

/**
 * Repeat the contents of `box` `count` times along `direction` (a unit vector like [1,0,0] or
 * [0,1,0]); copies are placed edge to edge (+ `gap` blocks). Reads through the sink.
 */
export function stackRegion(
  sink: BlockSink,
  box: Box,
  count: number,
  direction: Vec3,
  opts: { gap?: number; ignoreAir?: boolean; mask?: MaskFn } = {},
): number {
  const size = boxSize(box);
  const gap = opts.gap ?? 0;
  const clip = copyFromSink(sink, box, box.min);
  let n = 0;
  for (let k = 1; k <= count; k++) {
    const at: Vec3 = [
      box.min[0] + direction[0] * (size[0] + gap) * k,
      box.min[1] + direction[1] * (size[1] + gap) * k,
      box.min[2] + direction[2] * (size[2] + gap) * k,
    ];
    n += pasteInto(sink, clip, at, opts);
  }
  return n;
}

/** Move the contents of `box` by `delta`; vacated blocks become `fill` (default air). */
export function moveRegion(
  sink: BlockSink,
  box: Box,
  delta: Vec3,
  opts: { fill?: string; ignoreAir?: boolean } = {},
): number {
  const clip = copyFromSink(sink, box, box.min);
  const fill = opts.fill ?? AIR;
  const dest: Box = {
    min: [box.min[0] + delta[0], box.min[1] + delta[1], box.min[2] + delta[2]],
    max: [box.max[0] + delta[0], box.max[1] + delta[1], box.max[2] + delta[2]],
  };
  let n = 0;
  for (let y = box.min[1]; y <= box.max[1]; y++)
    for (let z = box.min[2]; z <= box.max[2]; z++)
      for (let x = box.min[0]; x <= box.max[0]; x++) {
        const inDest =
          x >= dest.min[0] && x <= dest.max[0] && y >= dest.min[1] && y <= dest.max[1] && z >= dest.min[2] && z <= dest.max[2];
        if (inDest) continue;
        if (opts.ignoreAir && isAir(sink.get(x, y, z))) continue;
        sink.set(x, y, z, fill);
        n++;
      }
  n += pasteInto(sink, clip, dest.min, { ignoreAir: opts.ignoreAir });
  return n;
}

/** Count of non-air blocks in a clipboard. */
export function clipboardBlockCount(c: Clipboard): number {
  const air = new Uint8Array(c.volume.palette.length);
  c.volume.palette.forEach((s, i) => (air[i] = isAir(s) || s === STRUCTURE_VOID ? 1 : 0));
  let n = 0;
  for (let i = 0; i < c.volume.data.length; i++) if (!air[c.volume.data[i]]) n++;
  return n;
}
