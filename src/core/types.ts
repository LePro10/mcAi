/**
 * mcAI core types — the Blueprint DSL.
 *
 * Design goal: a full castle must fit in ~2 KB of JSON. Every field is either
 * short or optional. The LLM writes *intent*; the compiler produces voxels.
 */

export type Vec3 = [number, number, number];

/** A material reference. Either a literal Minecraft block id, a palette slot
 *  (`@wall`, `@roof`, ...) or an inline weighted mix for natural texture. */
export type Material = string | MaterialMix;

export interface MaterialMix {
  /** Block ids or palette slots, picked deterministically per-coordinate. */
  mix: string[];
  /** Relative weights, same length as `mix`. Defaults to uniform. */
  weights?: number[];
}

/** How a written voxel interacts with what the blueprint already produced. */
export type WriteMode =
  /** Overwrite whatever is there (default). */
  | 'replace'
  /** Only write where the blueprint has nothing yet. */
  | 'keep';

export interface PartBase {
  /** Material for this part. */
  block?: Material;
  /** Write mode against the in-progress voxel buffer. */
  mode?: WriteMode;
  /** Optional label, surfaced in progress reporting. */
  tag?: string;
}

/** Solid cuboid. `at` is the min corner, relative to the blueprint origin. */
export interface BoxPart extends PartBase { op: 'box'; at: Vec3; size: Vec3 }

/** Cuboid shell. `open` removes faces (e.g. `["top","bottom"]` -> a tube). */
export interface ShellPart extends PartBase {
  op: 'shell'; at: Vec3; size: Vec3;
  thickness?: number;
  open?: Array<'top' | 'bottom' | 'north' | 'south' | 'east' | 'west'>;
}

/** Four vertical walls, no floor or ceiling. Shorthand for a common case. */
export interface WallsPart extends PartBase {
  op: 'walls'; at: Vec3; size: Vec3; thickness?: number;
}

/** Only the 12 edges of a cuboid. */
export interface FramePart extends PartBase { op: 'frame'; at: Vec3; size: Vec3; thickness?: number }

/** Cylinder along an axis. `at` is the min corner of its bounding box. */
export interface CylinderPart extends PartBase {
  op: 'cylinder'; at: Vec3;
  /** Radius in blocks. Diameter is `2r+1` when `even` is false. */
  r: number;
  /** Height along `axis`. */
  h: number;
  axis?: 'x' | 'y' | 'z';
  hollow?: boolean;
  thickness?: number;
  /** Optional second radius for elliptic cylinders. */
  r2?: number;
}

/** Sphere or ellipsoid, centred in its bounding box. */
export interface SpherePart extends PartBase {
  op: 'sphere'; at: Vec3;
  r: number | Vec3;
  hollow?: boolean;
  thickness?: number;
  /** Keep only the upper (`dome`) or lower (`bowl`) half. */
  half?: 'dome' | 'bowl';
}

/** Cone / spire, tapering along +Y. */
export interface ConePart extends PartBase {
  op: 'cone'; at: Vec3; r: number; h: number; hollow?: boolean; thickness?: number;
}

/** Stepped or smooth pyramid. */
export interface PyramidPart extends PartBase {
  op: 'pyramid'; at: Vec3; size: Vec3; hollow?: boolean; step?: number;
}

/**
 * A real roof — the thing the old system could not do. Emits stair blocks with
 * correct `facing`/`half` states, plus optional ridge and gable fill.
 */
export interface RoofPart extends PartBase {
  op: 'roof';
  at: Vec3; size: Vec3;
  kind?: 'gable' | 'hip' | 'pyramid' | 'flat' | 'dome' | 'cone' | 'pagoda';
  /** Ridge axis for gable roofs. */
  axis?: 'x' | 'z';
  /** Vertical rise per horizontal block. 1 = 45°. */
  pitch?: number;
  /** Overhang beyond `size` in blocks. */
  overhang?: number;
  /** Stair block used for the slope; falls back to `block`. */
  stairs?: Material;
  /** Solid block used to close gable ends; falls back to `block`. */
  gableBlock?: Material;
  /** Block for the ridge line. */
  ridge?: Material;
}

/** Semicircular or flat-topped arch, useful for gates and bridges. */
export interface ArchPart extends PartBase {
  op: 'arch'; at: Vec3;
  /** Opening width. */
  span: number;
  /** Total height including the arc. */
  h: number;
  /** Depth along the perpendicular axis. */
  depth?: number;
  axis?: 'x' | 'z';
  /** Carve the opening out of existing voxels instead of drawing the ring. */
  cut?: boolean;
}

/** Crenellations along the perimeter of a rectangle. Castles, finally. */
export interface BattlementsPart extends PartBase {
  op: 'battlements'; at: Vec3; size: Vec3;
  /** Merlon height. */
  height?: number;
  /** Merlon width. */
  width?: number;
  /** Gap width between merlons. */
  gap?: number;
}

/** Spiral staircase inside a cylindrical shaft. */
export interface SpiralPart extends PartBase {
  op: 'spiral'; at: Vec3; r: number; h: number;
  /** Blocks of rise per full turn. */
  turn?: number;
  cw?: boolean;
  /** Use stair blocks with correct facing instead of full blocks. */
  stairs?: Material;
}

/** 3D line (Bresenham) — beams, cables, ridges. */
export interface LinePart extends PartBase { op: 'line'; from: Vec3; to: Vec3; thickness?: number }

/** Single block. */
export interface SetPart extends PartBase { op: 'set'; at: Vec3 }

/** Evenly spaced openings along a wall run — windows without per-block JSON. */
export interface WindowsPart extends PartBase {
  op: 'windows'; at: Vec3; size: Vec3;
  /** Which wall faces get windows. Defaults to all four. */
  sides?: Array<'north' | 'south' | 'east' | 'west'>;
  /** Window opening size [w,h]. */
  win?: [number, number];
  /** Spacing between window centres. */
  spacing?: number;
  /** Block placed in the opening (glass pane etc). Air if omitted. */
  glass?: Material;
}

/** Doorway: carves a 2-high opening and optionally places a door. */
export interface DoorPart extends PartBase {
  op: 'door'; at: Vec3;
  facing?: 'north' | 'south' | 'east' | 'west';
  width?: number;
  height?: number;
  /** Door block id; if omitted only the opening is carved. */
  door?: string;
}

/** Deterministic scatter for decoration — flowers, rubble, torches. */
export interface ScatterPart extends PartBase {
  op: 'scatter'; at: Vec3; size: Vec3;
  /** 0..1 fraction of positions filled. */
  density?: number;
  /** Only place where the voxel directly below is solid. */
  onGround?: boolean;
}

/** Fill with air — carve out interiors, level terrain. */
export interface ClearPart { op: 'clear'; at: Vec3; size: Vec3; tag?: string }

/**
 * Foundation columns that follow the ground. The compiler needs a terrain
 * height sample to resolve this (supplied at compile time); without one it
 * degrades to a flat slab.
 */
export interface FoundationPart extends PartBase {
  op: 'foundation'; at: Vec3; size: [number, number];
  /** How far below the surface to extend. */
  depth?: number;
  /** Also clear anything above the pad up to this height. */
  clearAbove?: number;
}

/** Group with an optional transform applied to all children. */
export interface GroupPart {
  op: 'group';
  at?: Vec3;
  /** Rotation about the blueprint Y axis, in degrees. */
  rotate?: 0 | 90 | 180 | 270;
  /** Mirror across an axis after rotation. */
  mirror?: 'x' | 'z';
  of: Part[];
  tag?: string;
}

/** Repeat children N times with a per-step offset and optional rotation. */
export interface RepeatPart {
  op: 'repeat';
  count: number;
  step?: Vec3;
  /** Additional rotation applied per iteration. */
  rotateStep?: 0 | 90 | 180 | 270;
  of: Part[];
  tag?: string;
}

/** Mirror children across an axis and keep both copies. */
export interface SymmetryPart {
  op: 'symmetry';
  axis: 'x' | 'z' | 'xz';
  /** Mirror plane position on that axis, relative to blueprint origin. */
  about?: number;
  of: Part[];
  tag?: string;
}

/** Reference a named prefab from the library. */
export interface PrefabPart {
  op: 'prefab'; name: string; at?: Vec3;
  rotate?: 0 | 90 | 180 | 270;
  /** Parameter overrides passed to parametric prefabs. */
  params?: Record<string, unknown>;
  tag?: string;
}

export type Part =
  | BoxPart | ShellPart | WallsPart | FramePart
  | CylinderPart | SpherePart | ConePart | PyramidPart
  | RoofPart | ArchPart | BattlementsPart | SpiralPart
  | LinePart | SetPart | WindowsPart | DoorPart | ScatterPart
  | ClearPart | FoundationPart
  | GroupPart | RepeatPart | SymmetryPart | PrefabPart;

export interface Blueprint {
  /** Human-readable name, echoed in chat and the dashboard. */
  name?: string;
  /** Palette name from the style library, or an inline slot map. */
  palette?: string | Record<string, Material>;
  /** Extra slot overrides layered on top of the named palette. */
  materials?: Record<string, Material>;
  /**
   * Where `[0,0,0]` sits. `player` = in front of the requesting player,
   * `bot` = at the bot, or explicit world coordinates.
   */
  anchor?: 'player' | 'bot' | Vec3;
  /** Ground handling: sit on the terrain, or use the anchor Y verbatim. */
  ground?: 'terrain' | 'anchor';
  /** Rotate the whole blueprint to face the player. */
  facePlayer?: boolean;
  /** Deterministic seed for mixes and scatter. */
  seed?: number;
  parts: Part[];
}

/** One voxel in the compiled output. */
export interface Voxel { x: number; y: number; z: number; block: string }

/** A merged axis-aligned run of identical blocks -> one `/fill`. */
export interface FillBox {
  x1: number; y1: number; z1: number;
  x2: number; y2: number; z2: number;
  block: string;
  /** Number of blocks this box covers. */
  volume: number;
}

export interface CompileStats {
  /** Every voxel written, including the air that clears the site. */
  voxels: number;
  /**
   * Voxels that place an actual block. This is what "blocks" means to a
   * person, and what every reported figure should use — counting cleared air
   * as placed blocks would inflate the numbers several-fold.
   */
  solidVoxels: number;
  fills: number;
  setblocks: number;
  /** Solid blocks per emitted command — the compression ratio we report. */
  ratio: number;
  bounds: { min: Vec3; max: Vec3 };
  blockCounts: Record<string, number>;
  warnings: string[];
  compileMs: number;
}

export interface CompiledBuild {
  name: string;
  commands: string[];
  boxes: FillBox[];
  stats: CompileStats;
  /** Sparse voxel map, kept for preview rendering. */
  voxels: Voxel[];
}

/** Terrain sample used for `ground: terrain` and `foundation` parts. */
export interface TerrainSample {
  /** Inclusive world-space bounds of the sample. */
  x1: number; z1: number; x2: number; z2: number;
  /** Row-major heights, length (x2-x1+1)*(z2-z1+1). */
  heights: Int16Array | number[];
  /** Surface block name per column, optional. */
  surface?: string[];
  /** Highest, lowest and average surface height in the sample. */
  min: number; max: number; avg: number;
}
