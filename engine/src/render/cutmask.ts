// Per-cell "removable natural" mask for elevation cutaways and outside cuts: natural terrain,
// loose plants, water and natural trees (leaves persistent=false and the logs/attachments they
// reach) — but never positions the caller marks as kept (the job's own blocks).
import type { BlockVolume } from '../core/types.ts';
import { Registry } from '../core/registry.ts';
import { naturalTreeMask } from '../core/trees.ts';
import type { SceneData } from './scene.ts';

export interface KeepSet {
  forEach(cb: (v: unknown, x: number, y: number, z: number) => void): void;
}

export function cutMask(v: BlockVolume, scene: SceneData, keep?: KeepSet): Uint8Array {
  const { sx, sy, sz, ox, oy, oz } = scene;
  const n = sx * sy * sz;
  const out = new Uint8Array(new SharedArrayBuffer(Math.max(1, n)));
  const kept = new Uint8Array(n);
  keep?.forEach((_v, x, y, z) => {
    const gx = x - ox, gy = y - oy, gz = z - oz;
    if (gx < 0 || gy < 0 || gz < 0 || gx >= sx || gy >= sy || gz >= sz) return;
    kept[(gy * sz + gz) * sx + gx] = 1;
  });
  const pt = scene.pTerrain;
  for (let i = 0; i < n; i++) if (pt[v.data[i]] !== 0 && !kept[i]) out[i] = 1;
  let reg: Registry | null = null;
  try {
    reg = Registry.loadDefault();
  } catch {
    reg = null;
  }
  if (reg && v.palette.some((s) => s.includes('persistent=false'))) {
    const trees = naturalTreeMask(v, reg, (i) => kept[i] === 1);
    for (let i = 0; i < n; i++) if (trees[i]) out[i] = 1;
  }
  return out;
}
