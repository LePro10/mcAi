# Engine module API contract

Binding interface between engine modules that are developed in parallel. Each module's
owner implements exactly these exports (more exports are fine). If you must deviate,
keep a compatible wrapper and document it here.

All coordinates are integers. `Vec3 = [x,y,z]`, `Box = {min,max}` inclusive (core/types.ts).
Block states are strings (core/blockstate.ts). "Canonical" = see ARCHITECTURE §3.

---------------------------------------------------------------------------------------
## Owner: core-geometry  (engine/src/core/…)

### registry.ts
```ts
export class Registry {
  constructor(data: BlockRegistry);
  static loadDefault(): Registry;                 // engine/data/registry-26.3.json (cached singleton)
  readonly version: string;
  has(id: string): boolean;                       // accepts 'stone' or 'minecraft:stone'
  info(id: string): BlockInfo | undefined;
  ids(): string[];
  /** Validate + canonicalize. Throws RegistryError with a helpful message
   *  (did-you-mean for ids, list of valid values for bad properties). Keeps SNBT. */
  canonical(state: string): string;
  /** non-throwing variant */
  tryCanonical(state: string): { ok: true; state: string } | { ok: false; error: string };
  hasTag(id: string, tag: string): boolean;       // tag like 'minecraft:stairs' or '#stairs'
  search(query: string, opts?: { tag?: string; limit?: number }): string[];  // fuzzy by id words
  isFullSolid(state: string): boolean;            // heuristic full cube (for connections/AO/masks)
  isTransparent(state: string): boolean;          // glass, leaves, panes, air, plants, …
}
export class RegistryError extends Error {}
```

### transform.ts
```ts
export type QuarterTurns = 0 | 1 | 2 | 3;                 // clockwise when viewed from above (+y)
export function rotateState(state: string, turns: QuarterTurns, reg: Registry): string;
export function mirrorState(state: string, axis: 'x' | 'z', reg: Registry): string;
// mirror axis 'x' = flip x coordinate (east<->west); 'z' = flip z (north<->south)
export function rotatePos(v: Vec3, turns: QuarterTurns, pivot?: Vec3): Vec3;
export function mirrorPos(v: Vec3, axis: 'x' | 'z', pivot?: Vec3): Vec3;
```
Rotation clockwise from above: north→east→south→west. Must handle facing, axis,
rotation(0–15), north/east/south/west props (fences, walls, vines, redstone, multiface),
stairs shape on mirror, door hinge on mirror, rails shape, chest type on mirror,
orientation (jigsaw/crafter), etc.

### frame.ts
```ts
export class Frame {   // local build space, a pure rotation of world space (never a mirror)
  constructor(anchor: Vec3, facing: Facing, reg: Registry);
  toWorld(v: Vec3): Vec3;  toLocal(v: Vec3): Vec3;
  stateToWorld(state: string): string;            // rotate block state local→world
  stateToLocal(state: string): string;
  boxToWorld(b: Box): Box;
  readonly turns: QuarterTurns;                   // north=0, east=1, south=2, west=3 (clockwise)
  static identity(reg: Registry): Frame;          // world space (= facing north, anchor 0,0,0)
}
```
Local space = world space as seen by a player **looking north**: origin = anchor,
+x = player's right, +y = up, **−z = forward** (away from the player, into the site),
**+z = toward the player**. So the building's front facade (entrance) is on its +z side,
facing the player. Block states in local space are authored as if the player looks north
(`oak_stairs[facing=north]` ascends away from the player). `toWorld` rotates by `turns`
clockwise (seen from above) around the anchor:
`(x,z) → north:(x,z) · east:(−z,x) · south:(−x,−z) · west:(z,−x)`, then + anchor.

### pattern.ts / mask.ts
```ts
export type PatternSpec = string | { block: string; weight?: number }[] | {
  type: 'gradient'; axis: 'x'|'y'|'z'; stops: string[]; dither?: boolean } | {
  type: 'noise'; scale?: number; blocks: string[]; seed?: number } | {
  type: 'checker' | 'stripes'; blocks: string[]; size?: number; axis?: 'x'|'y'|'z' };
// string forms: 'stone_bricks' | '60%stone_bricks,30%cracked_stone_bricks,10%mossy_stone_bricks' | 'keep'
export type PatternFn = (x: number, y: number, z: number) => string | null;   // null = leave unchanged
export function compilePattern(spec: PatternSpec, reg: Registry, opts?: { seed?: number; bounds?: Box }): PatternFn;

export type MaskSpec = string | string[] | { not: MaskSpec } | { all: MaskSpec[] } | { any: MaskSpec[] };
// strings: 'air' | '!air' | 'solid' | 'liquid' | 'stone' | '#minecraft:logs' | 'oak_stairs[half=top]' (partial props match)
export type MaskFn = (x: number, y: number, z: number, current: string) => boolean;
export function compileMask(spec: MaskSpec, reg: Registry): MaskFn;
```

### shapes.ts
```ts
export interface PosSink { (x: number, y: number, z: number): void }
// every shape: shapeName(params, emit). Integer output, no duplicates.
export function box(p: { box: Box; mode?: 'solid'|'hollow'|'walls'|'outline'|'floor'|'ceiling'; thickness?: number }, emit: PosSink): void;
export function ellipsoid(p: { center: Vec3; radius: number | Vec3; hollow?: boolean; thickness?: number; half?: 'top'|'bottom'|null }, emit: PosSink): void;
export function cylinder(p: { base: Vec3; radius: number | [number, number]; height: number; axis?: 'x'|'y'|'z'; hollow?: boolean; thickness?: number }, emit: PosSink): void;
export function cone(p: { base: Vec3; radius: number; height: number; hollow?: boolean }, emit: PosSink): void;
export function pyramid(p: { base: Vec3; size: number | [number, number]; height?: number; hollow?: boolean }, emit: PosSink): void;
export function torus(p: { center: Vec3; major: number; minor: number; axis?: 'x'|'y'|'z' }, emit: PosSink): void;
export function line(p: { from: Vec3; to: Vec3; thickness?: number }, emit: PosSink): void;
export function curve(p: { points: Vec3[]; kind?: 'bezier'|'catmull'; radius?: number }, emit: PosSink): void;
export function polygon(p: { points: [number, number][]; y: number; height: number; hollow?: boolean }, emit: PosSink): void; // points in x,z
export function arch(p: { from: Vec3; to: Vec3; height: number; thickness?: number; depth?: number; style?: 'round'|'pointed'|'flat' }, emit: PosSink): void;
export function spiral(p: { center: Vec3; radius: number; height: number; turns: number; width?: number }, emit: PosSink): void;

export interface StateSink { (x: number, y: number, z: number, state: string): void }
export function roof(p: { box: Box /* footprint x/z, base y = box.min.y */; style: 'gable'|'hip'|'pyramid'|'shed'|'dome'|'spire'|'mansard'|'gambrel'|'flat';
  axis?: 'x'|'z'; stairs: string; slab?: string; fill?: string; overhang?: number; pitch?: number }, reg: Registry, emit: StateSink): void;
```

### connect.ts / multiblock.ts
```ts
// Emulates vanilla neighbour shape updates (fences, panes, iron bars, walls, stairs corners, …)
export function solveConnections(get: (x: number, y: number, z: number) => string,
  positions: Iterable<Vec3>, reg: Registry): Array<[number, number, number, string]>;  // changed states
// Doors (upper half), beds (head), double plants, tall seagrass, … → full set of states
export function expandMultiblock(x: number, y: number, z: number, state: string, reg: Registry): Array<[number, number, number, string]>;
```

### dsl.ts
```ts
export interface BlockSink {                      // implemented by core-data's EditSession
  get(x: number, y: number, z: number): string;   // canonical state (reads through to world)
  set(x: number, y: number, z: number, state: string): void;
}
export const BuildOpSchema: z.ZodType<BuildOp>;   // zod v4, discriminated union on 'op'
export type BuildOp = /* set | fill | ellipsoid | cylinder | cone | pyramid | torus | line | curve |
  polygon | arch | spiral | roof | replace | clear | … — params mirror shapes.ts + block: PatternSpec + mask?: MaskSpec */;
export interface OpContext { sink: BlockSink; reg: Registry; frame: Frame; seed?: number; }
export interface OpResult { op: string; changed: number; warnings: string[] }
export function executeOps(ops: BuildOp[], ctx: OpContext): OpResult[];   // synchronous; throws OpError(index, message)
export class OpError extends Error { index: number }
```

---------------------------------------------------------------------------------------
## Owner: core-data  (engine/src/core/…)

### volume.ts
```ts
export function createVolume(box: Box): BlockVolume;          // all air
export function volGet(v: BlockVolume, x: number, y: number, z: number): string;
export function volSet(v: BlockVolume, x: number, y: number, z: number, state: string): void;
export function volIndex(box: Box, x: number, y: number, z: number): number;
export function boxSize(b: Box): Vec3; export function boxVolume(b: Box): number;
export function boxContains(b: Box, x: number, y: number, z: number): boolean;
export function boxUnion(a: Box, b: Box): Box; export function boxIntersect(a: Box, b: Box): Box | null;
export function normBox(a: Vec3, b: Vec3): Box;
export function batchFromEntries(entries: Iterable<[number, number, number, string]>): EditBatch;
```

### session.ts
```ts
export interface SessionOptions { bounds?: Box; maxBlocks?: number; dimension?: string; actor?: string; label?: string;
  connect?: boolean /* run solveConnections + expandMultiblock on flush, default true */ }
export class EditSession implements BlockSink {
  constructor(backend: WorldBackend, reg: Registry, opts?: SessionOptions);
  prefetch(box: Box): Promise<void>;     // load world blocks into the read cache (get() is sync!)
  get(x, y, z): string;                  // pending change > cache > 'minecraft:air' if never prefetched (and records a miss)
  set(x, y, z, state): void;             // throws BoundsError / LimitError
  readonly pending: number;
  flush(opts?: SetBlocksOptions): Promise<FlushResult>;   // writes in batches ≤ 50k, returns stats + UndoRecord
  on(ev: 'flush', cb: (r: FlushResult) => void): void;
}
export interface UndoRecord { id: string; label: string; actor: string; dimension: string; before: EditBatch; after: EditBatch; time: number }
export class History {                   // per actor stack
  push(rec: UndoRecord): void;
  undo(actor: string, backend: WorldBackend): Promise<UndoRecord | null>;
  redo(actor: string, backend: WorldBackend): Promise<UndoRecord | null>;
  list(actor: string): UndoRecord[];
  /** group several records into one (a whole AI job = one undo step) */
  group(actor: string, sinceId: string, label: string): void;
}
export class BoundsError extends Error {}  export class LimitError extends Error {}
```

### clipboard.ts / schematic.ts
```ts
export interface Clipboard { volume: BlockVolume; origin: Vec3 /* offset of copy point relative to volume.box.min */; entities?: unknown[]; meta?: Record<string, unknown> }
export function copyRegion(backend: WorldBackend, box: Box, origin: Vec3, dimension?: string): Promise<Clipboard>;
export function transformClipboard(c: Clipboard, t: { rotate?: QuarterTurns; mirror?: 'x'|'z' }, reg: Registry): Clipboard;
export function pasteInto(sink: BlockSink, c: Clipboard, at: Vec3, opts?: { ignoreAir?: boolean; mask?: MaskFn }): number;
export function readSchematic(buf: Buffer, reg: Registry): Promise<Clipboard>;  // auto-detect .schem (v2/v3), vanilla .nbt, .litematic
export function writeSponge(c: Clipboard): Promise<Buffer>;  export function writeStructureNbt(c: Clipboard): Promise<Buffer>;
export class StructureLibrary { constructor(dir: string); save(name, c, meta); load(name); list(); delete(name) }  // ~/.mcai/structures
```

### script.ts
```ts
export interface ScriptRequest { code: string; readBox?: Box; volume?: BlockVolume /* prefetched for get() */;
  frame?: { anchor: Vec3; facing: Facing }; seed?: number; timeoutMs?: number; maxBlocks?: number }
export interface ScriptResult { entries: Array<[number, number, number, string]>; logs: string[]; error?: string; ms: number }
export function runScript(req: ScriptRequest, reg: Registry): Promise<ScriptResult>;
```
Runs in a separate Node child process with the permission model (`--permission`, no fs
write, no child processes, no workers, no network) + `node:vm`. Script API inside the
sandbox: `set(x,y,z,block)`, `get(x,y,z)`, all shapes.ts functions with a block/pattern
argument, `pattern(spec)`, `noise2(x,z)`, `noise3(x,y,z)`, `rand()`, `randInt(a,b)`,
`log(...)`, constants. Coordinates are local if `frame` is given.

### analysis.ts / prefabs.ts
```ts
export function summarize(v: BlockVolume, reg: Registry): { counts: Record<string, number>; nonAir: number; bounds: Box | null };
export function layerAscii(v: BlockVolume, y: number): { grid: string[]; legend: Record<string, string> };
export function surfaceMap(v: BlockVolume, reg: Registry): { heights: Int16Array; tops: string[]; w: number; d: number };
export function findDarkSpots(v: BlockVolume, reg: Registry): Vec3[];      // spawnable spots far from light sources
export function listPrefabs(): { name: string; description: string; params: Record<string, string> }[];
export function placePrefab(name: string, at: Vec3, params: Record<string, unknown>, sink: BlockSink, reg: Registry, seed?: number): number;
```

---------------------------------------------------------------------------------------
## Owner: assets-render-sim

### assets/assets.ts
```ts
export class AssetStore {
  static open(version?: string /* '26.3' */, cacheDir?: string /* ~/.mcai/cache */): Promise<AssetStore>; // downloads & caches
  /** resolved geometry for a canonical state: list of cuboids (0..16 units) with per-face texture + uv, tint index, rotation applied */
  geometry(state: string): BlockGeometry;
  textureAtlas(): { png: Buffer; width: number; height: number; uv(texture: string): [number, number, number, number] };
  averageColor(state: string): [number, number, number, number];   // rgba 0..255
  tint(kind: 'grass' | 'foliage' | 'water', biome?: string): [number, number, number];
}
```
### render/render.ts
```ts
export interface RenderOptions { width?: number; height?: number;
  view?: 'iso_ne' | 'iso_nw' | 'iso_se' | 'iso_sw' | 'front' | 'back' | 'left' | 'right' | 'top' | 'orbit';
  yaw?: number; pitch?: number; zoom?: number; focus?: Box;
  shadows?: boolean; time?: 'day' | 'sunset' | 'night'; highlight?: Box; labels?: boolean }
export function renderVolume(v: BlockVolume, assets: AssetStore | null, opts?: RenderOptions): Promise<Buffer /* PNG */>;
```
### sim/sim-backend.ts
```ts
export class SimBackend implements WorldBackend {
  constructor(opts?: { seed?: number; name?: string; persistDir?: string; registry?: Registry });
  on(event: 'blocks' | 'notify' | 'command', cb: (...a: any[]) => void): void;  // 'blocks': (batch: EditBatch) after setBlocks
  addPlayer(p: PlayerInfo): void;  save(): Promise<void>;
}
```

---------------------------------------------------------------------------------------
## Owner: server-agent (engine/src/server, engine/src/agent, engine/src/cli.ts)
Consumes everything above. Exposes the HTTP/WS/MCP surface from ARCHITECTURE §5–§8.
