// Auto-crop solid underground from a render volume: a box that reaches deep below the build
// renders as a huge stone cross-section. Keep everything from (lowest terrain surface or lowest
// non-natural block, whichever is lower) − `keep` upward.
import type { BlockVolume, Box } from '../core/types.ts';
import { blockId, isAir } from '../core/blockstate.ts';
import { isNaturalGround } from '../core/trees.ts';
import { boxSize } from '../core/volume.ts';

export function undergroundCropY(v: BlockVolume, opts: { keep?: number; lowestEdit?: number } = {}): number {
  const [sx, sy, sz] = boxSize(v.box);
  const layer = sx * sz;
  const natural = v.palette.map((s) => isAir(s) || isNaturalGround(s) || /water|lava/.test(blockId(s)));
  const airLike = v.palette.map((s) => isAir(s));
  let lowestSurface = Infinity;
  for (let i = 0; i < layer; i++) {
    for (let y = sy - 1; y >= 0; y--) {
      if (airLike[v.data[y * layer + i]!]) continue;
      if (y < lowestSurface) lowestSurface = y;
      break;
    }
  }
  let lowestBuilt = Infinity;
  for (let y = 0; y < sy && lowestBuilt === Infinity; y++) {
    const o = y * layer;
    for (let i = 0; i < layer; i++) if (!natural[v.data[o + i]!]) { lowestBuilt = y; break; }
  }
  const lowest = Math.min(lowestSurface, lowestBuilt, opts.lowestEdit !== undefined ? opts.lowestEdit - v.box.min[1] : Infinity);
  if (!Number.isFinite(lowest)) return v.box.min[1];
  return v.box.min[1] + Math.max(0, lowest - (opts.keep ?? 3));
}

/** the volume without the layers below `y` (same object if nothing to cut) */
export function cropBelow(v: BlockVolume, y: number): BlockVolume {
  if (y <= v.box.min[1]) return v;
  const [sx, , sz] = boxSize(v.box);
  const off = (y - v.box.min[1]) * sx * sz;
  const box: Box = { min: [v.box.min[0], y, v.box.min[2]], max: [...v.box.max] };
  return { box, palette: v.palette, data: v.data.slice(off) };
}
