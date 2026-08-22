/**
 * Site analysis and placement.
 *
 * "Build a castle here" needs answering three questions the demo never asked:
 * where exactly, facing which way, and at what height on ground that is not
 * flat. This module answers them from a terrain sample, and — importantly —
 * reports terrain to the model as *statistics* rather than as a list of every
 * column. The old `terrain_profile` returned one JSON object per surface block;
 * a 64x64 survey was 4,096 of them, tens of thousands of tokens, to convey what
 * "average 71, slope 6, not flat" says in eight.
 */

import type { Blueprint, CompiledBuild, TerrainSample, Vec3 } from '../core/types.js';
import { compile, type CompileOptions } from '../core/compile.js';
import { facingFromYaw, rotationForFacing, type Cardinal } from '../core/geometry.js';
import { styleForBiome } from '../core/palette.js';
import { isAir, parseBlock } from '../core/blocks.js';
import type { SurveyResult } from '../agent/agent.js';
import type { WorldReader } from './executor.js';

export interface SiteWorld extends WorldReader {
  /** Highest non-air block in a column, searching down from `from`. */
  highestY(x: number, z: number, from?: number): number;
  biomeAt(x: number, y: number, z: number): string;
}

export interface PlayerInfo {
  name: string;
  position: Vec3;
  /** Yaw in degrees, wire-protocol convention (0 = south). */
  yaw: number;
  /**
   * Facing, when the caller can derive it more reliably than from a yaw —
   * mineflayer's yaw uses a different zero than the protocol, so anything
   * reading a live entity should compute this from its look vector instead.
   */
  facing?: Cardinal;
}

/**
 * Sample ground heights over a square region.
 *
 * Scanning starts a little above the player rather than at the world ceiling:
 * the demo's version walked down from y=320 for every column, which is 384
 * block lookups per column and the reason a survey could stall the bot for
 * seconds.
 */
export function sampleTerrain(
  world: SiteWorld,
  centre: Vec3,
  radius: number,
  step = 1,
): TerrainSample {
  const x1 = centre[0] - radius, x2 = centre[0] + radius;
  const z1 = centre[2] - radius, z2 = centre[2] + radius;
  const w = Math.floor((x2 - x1) / step) + 1;
  const d = Math.floor((z2 - z1) / step) + 1;
  const heights = new Int16Array(w * d);

  const from = Math.min(319, centre[1] + 24);
  let min = Infinity, max = -Infinity, total = 0;

  let i = 0;
  for (let z = z1; z <= z2; z += step) {
    for (let x = x1; x <= x2; x += step) {
      const y = world.highestY(x, z, from);
      heights[i++] = y;
      if (y < min) min = y;
      if (y > max) max = y;
      total += y;
    }
  }

  const count = i || 1;
  return {
    x1, z1, x2: x1 + (w - 1) * step, z2: z1 + (d - 1) * step,
    heights,
    min: Number.isFinite(min) ? min : centre[1],
    max: Number.isFinite(max) ? max : centre[1],
    avg: Math.round(total / count),
  };
}

/** Ground height at a world column, from a sample. Null when out of range. */
export function heightAt(t: TerrainSample, x: number, z: number): number | null {
  if (x < t.x1 || x > t.x2 || z < t.z1 || z > t.z2) return null;
  const w = t.x2 - t.x1 + 1;
  const v = t.heights[(z - t.z1) * w + (x - t.x1)];
  return Number.isFinite(v) ? v : null;
}

/** Median ground height under a rectangle — robust against a single spike. */
export function groundLevel(t: TerrainSample, x1: number, z1: number, x2: number, z2: number): number {
  const values: number[] = [];
  for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++)
    for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
      const h = heightAt(t, x, z);
      if (h !== null) values.push(h);
    }
  if (values.length === 0) return t.avg;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length * 0.5)];
}

/**
 * Survey the build site.
 *
 * Everything here is chosen to fit in a couple of hundred tokens while still
 * letting the model make real decisions: where there is room, which way the
 * player is looking, how rough the ground is, what the biome suggests.
 */
export function survey(
  world: SiteWorld,
  player: PlayerInfo,
  botPosition: Vec3,
  radius = 32,
): SurveyResult {
  const facing = player.facing ?? facingFromYaw(player.yaw);
  const terrain = sampleTerrain(world, player.position, radius);
  const slope = terrain.max - terrain.min;

  const origin = suggestOrigin(world, player, terrain, facing);
  const biome = world.biomeAt(origin[0], origin[1], origin[2]);

  // Count what is around instead of listing it: "oak_log: 240" tells the model
  // it is in a forest; 240 coordinate triples tell it the same thing for 3,000
  // times the tokens.
  const nearby: Record<string, number> = {};
  const sampleStep = Math.max(1, Math.floor(radius / 12));
  for (let z = -radius; z <= radius; z += sampleStep)
    for (let x = -radius; x <= radius; x += sampleStep) {
      const wx = player.position[0] + x, wz = player.position[2] + z;
      const y = heightAt(terrain, wx, wz);
      if (y === null) continue;
      const id = parseBlock(world.getBlock(wx, y, wz)).id;
      if (isAir(id)) continue;
      nearby[id] = (nearby[id] ?? 0) + 1;
    }
  const topNearby = Object.fromEntries(
    Object.entries(nearby).sort((a, b) => b[1] - a[1]).slice(0, 8),
  );

  const notes: string[] = [];
  if (slope > 8) notes.push('Ground is steep. Use a foundation op so the base follows it.');
  if (slope <= 2) notes.push('Ground is flat. A simple slab foundation is enough.');
  const water = Object.keys(topNearby).some((b) => b.includes('water'));
  if (water) notes.push('Water nearby — consider stilts or a bridge.');

  return {
    player: { name: player.name, position: player.position, facing },
    bot: { position: botPosition },
    biome,
    ground: { min: terrain.min, max: terrain.max, avg: terrain.avg, slope, flat: slope <= 2 },
    suggestedOrigin: origin,
    suggestedStyle: styleForBiome(biome),
    suggestedRotation: rotationForFacing(facing),
    nearby: topNearby,
    clearRadius: clearRadius(world, origin, terrain, radius),
    notes,
  };
}

/** A ground point in front of the player, clear of where they are standing. */
export function suggestOrigin(
  world: SiteWorld,
  player: PlayerInfo,
  terrain: TerrainSample,
  facing: Cardinal,
  distance = 10,
): Vec3 {
  const dir: Record<Cardinal, [number, number]> = {
    north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0],
  };
  const [dx, dz] = dir[facing];
  const x = player.position[0] + dx * distance;
  const z = player.position[2] + dz * distance;
  const h = heightAt(terrain, x, z) ?? world.highestY(x, z, player.position[1] + 24);
  return [x, h + 1, z];
}

/** How far from `centre` the ground stays buildable, in blocks. */
export function clearRadius(world: SiteWorld, centre: Vec3, terrain: TerrainSample, max: number): number {
  const base = heightAt(terrain, centre[0], centre[2]) ?? centre[1] - 1;
  for (let r = 4; r <= max; r += 4) {
    let rough = 0, samples = 0;
    for (let a = 0; a < 8; a++) {
      const angle = (a / 8) * Math.PI * 2;
      const x = Math.round(centre[0] + Math.cos(angle) * r);
      const z = Math.round(centre[2] + Math.sin(angle) * r);
      const h = heightAt(terrain, x, z);
      if (h === null) continue;
      samples++;
      if (Math.abs(h - base) > 6) rough++;
    }
    if (samples > 0 && rough / samples > 0.5) return r;
  }
  return max;
}

export interface PlacementOptions {
  /** Where the origin sits relative to the build. */
  place?: 'center' | 'corner';
  /** Clear trees and terrain out of the build's own airspace. */
  clearSite?: boolean;
  /** Sit the build on the ground under its footprint. */
  ground?: boolean;
  rotate?: 0 | 90 | 180 | 270;
  terrain?: TerrainSample;
  compile?: Omit<CompileOptions, 'origin' | 'rotate' | 'terrain'>;
}

/**
 * Compile a blueprint into world space at a sensible spot.
 *
 * Runs the compiler twice on purpose. The first pass has no origin and exists
 * only to measure the build; the second places it, now that we know how big it
 * is and can centre it on the requested point and sit it on the ground beneath
 * its actual footprint. Terrain-following foundations need the true world
 * origin at compile time, so this cannot be done by translating afterwards.
 */
export function place(bp: Blueprint, origin: Vec3, opts: PlacementOptions = {}): CompiledBuild {
  const rotate = opts.rotate ?? 0;
  // The probe only measures; clearing it would waste a pass and skew nothing.
  const probe = compile(bp, { ...opts.compile, origin: [0, 0, 0], rotate, clearSite: false });
  if (probe.stats.solidVoxels === 0) return probe;

  const { min, max } = probe.stats.bounds;
  let ox = origin[0];
  let oz = origin[2];
  if ((opts.place ?? 'center') === 'center') {
    ox -= Math.round((min[0] + max[0]) / 2);
    oz -= Math.round((min[2] + max[2]) / 2);
  }

  let oy = origin[1];
  if (opts.ground !== false && opts.terrain) {
    // Sit the blueprint's floor — local y=0 by convention — one block above the
    // median ground under the footprint.
    //
    // Offsetting by the build's own minimum instead would raise the floor by
    // the depth of its foundation, standing every building on a plinth as tall
    // as the footings that were supposed to be buried. Foundations reach down
    // on their own, through the terrain sample.
    oy = groundLevel(opts.terrain, ox + min[0], oz + min[2], ox + max[0], oz + max[2]) + 1;
  }

  return compile(bp, {
    ...opts.compile,
    origin: [ox, oy, oz], rotate, terrain: opts.terrain,
    clearSite: opts.clearSite ?? true,
  });
}

/** Human-readable dimensions of a compiled build. */
export function buildSize(b: CompiledBuild): Vec3 {
  const { min, max } = b.stats.bounds;
  return [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1];
}
