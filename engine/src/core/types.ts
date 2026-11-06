// Shared core types. See docs/ARCHITECTURE.md §3–§4. Keep in sync with the doc.

/** Integer block coordinates [x, y, z]. */
export type Vec3 = [number, number, number];

/** Axis-aligned box, inclusive on both ends, normalized (min <= max on every axis). */
export interface Box {
  min: Vec3;
  max: Vec3;
}

export type Facing = 'north' | 'south' | 'east' | 'west';
export type Dimension = string; // e.g. 'minecraft:overworld'

export interface BlockInfo {
  /** property name -> allowed values (in registry order) */
  properties: Record<string, string[]>;
  /** property name -> default value */
  default: Record<string, string>;
  /** '#rrggbb' approximate color (map color or texture average) */
  mapColor?: string;
  solid?: boolean;
  tags?: string[];
}

export interface BlockRegistry {
  version: string;
  blocks: Record<string, BlockInfo>;
}

/**
 * Dense volume of a box. palette[0] is always 'minecraft:air'.
 * Layout: x fastest, then z, then y.
 */
export interface BlockVolume {
  box: Box;
  palette: string[];
  data: Uint16Array;
}

/** Sparse list of block changes. positions = x,y,z triples; states = palette indices. */
export interface EditBatch {
  palette: string[];
  positions: Int32Array;
  states: Uint16Array;
}

export interface SetBlocksOptions {
  dimension?: Dimension;
  /** default true: run vanilla-like shape updates so fences/panes/walls/stairs connect */
  updateShapes?: boolean;
  /** visual build order in the real game (sim ignores) */
  animate?: 'none' | 'layers' | 'sweep';
  maxPerTick?: number;
}

export interface SetBlocksResult {
  placed: number;
  unchanged: number;
  failed: { index: number; reason: string }[];
  /** same positions as the input batch, with the states that were there before */
  previous: EditBatch;
}

export interface WorldInfo {
  name: string;
  minY: number;
  maxY: number; // inclusive
  seaLevel: number;
  mcVersion: string;
  dimension: Dimension;
}

export interface PlayerInfo {
  name: string;
  uuid: string;
  pos: [number, number, number]; // may be fractional
  yaw: number;
  pitch: number;
  dimension: Dimension;
  gameMode?: string;
}

export interface EntityInfo {
  id: string; // entity type, e.g. 'minecraft:armor_stand'
  uuid: string;
  pos: [number, number, number];
  name?: string;
}

export interface PlayerNotification {
  target: string; // player name or '@a'
  kind: 'chat' | 'actionbar' | 'title' | 'toast' | 'sound';
  text?: string; // plain text or JSON text component
  sound?: string;
}

export interface HeightmapResult {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** (x1-x0+1)*(z1-z0+1) values, x fastest. Y of the highest non-air (surface) block. */
  data: Int16Array;
}

export interface BiomeSample {
  palette: string[];
  data: Uint16Array;
  step: number;
}

export interface WorldBackend {
  readonly kind: 'sim' | 'minecraft';
  info(): Promise<WorldInfo>;
  registry(): Promise<BlockRegistry>;
  getBlocks(box: Box, dimension?: Dimension): Promise<BlockVolume>;
  setBlocks(batch: EditBatch, opts?: SetBlocksOptions): Promise<SetBlocksResult>;
  heightmap(
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    kind?: 'surface' | 'ocean_floor',
    dimension?: Dimension,
  ): Promise<HeightmapResult>;
  biomes(box: Box, step: number, dimension?: Dimension): Promise<BiomeSample>;
  entities(box: Box, dimension?: Dimension): Promise<EntityInfo[]>;
  players(): Promise<PlayerInfo[]>;
  runCommand(cmd: string, opts?: { as?: string }): Promise<{ ok: boolean; output: string }>;
  notify(n: PlayerNotification): Promise<void>;
}
