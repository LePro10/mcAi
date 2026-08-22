/**
 * Render a region of the simulated world, terrain included.
 *
 * Rendering the build alone shows whether the geometry is right. Rendering it
 * in the ground shows whether it is *sited* right — whether the foundation
 * meets the slope, whether a hillside still pokes through the wall, whether
 * the thing is standing on a plinth. Those are the failures that look worst
 * in game and are invisible in an isolated render.
 */

import type { CompiledBuild, Vec3 } from '../core/types.js';
import { VoxelBuffer, mergeToBoxes } from '../core/voxel.js';
import { orderBoxes, boxToCommand } from '../core/compile.js';
import { isAir } from '../core/blocks.js';
import type { SimWorld } from './world.js';

export interface RegionOptions {
  /** Blocks of ground to include around the build. */
  margin?: number;
  /** Depth of ground to show beneath the lowest block. */
  depth?: number;
  /** Cap on the sampled volume. */
  maxVolume?: number;
}

/**
 * Sample a cuboid of the world into the shape the renderer expects.
 *
 * Only the surface layers are kept: filling the full depth would be millions
 * of hidden voxels for a picture that looks identical.
 */
export function captureRegion(
  world: SimWorld,
  min: Vec3,
  max: Vec3,
  opts: RegionOptions = {},
): CompiledBuild {
  const margin = opts.margin ?? 6;
  const depth = opts.depth ?? 3;
  const maxVolume = opts.maxVolume ?? 2_000_000;

  const x1 = min[0] - margin, x2 = max[0] + margin;
  const z1 = min[2] - margin, z2 = max[2] + margin;

  const buf = new VoxelBuffer(maxVolume);
  let lowest = Infinity, highest = -Infinity;

  for (let z = z1; z <= z2; z++) {
    for (let x = x1; x <= x2; x++) {
      const surface = world.highestY(x, z, max[1] + 4);
      const floor = Math.min(surface - depth + 1, min[1]);
      for (let y = floor; y <= Math.max(surface, max[1]); y++) {
        const block = world.getBlock(x, y, z);
        if (isAir(block)) continue;
        buf.set(x, y, z, block);
        if (y < lowest) lowest = y;
        if (y > highest) highest = y;
      }
    }
  }

  const boxes = orderBoxes(mergeToBoxes(buf));
  return {
    name: 'region',
    commands: boxes.map(boxToCommand),
    boxes,
    voxels: [...buf.voxels()],
    stats: {
      voxels: buf.size,
      solidVoxels: buf.solidCount,
      fills: boxes.filter((b) => b.volume > 1).length,
      setblocks: boxes.filter((b) => b.volume === 1).length,
      ratio: boxes.length ? +(buf.solidCount / boxes.length).toFixed(1) : 0,
      bounds: buf.isEmpty
        ? { min: [0, 0, 0], max: [0, 0, 0] }
        : { min: [buf.minX, buf.minY, buf.minZ], max: [buf.maxX, buf.maxY, buf.maxZ] },
      blockCounts: buf.blockCounts(),
      warnings: [],
      compileMs: 0,
    },
  };
}
