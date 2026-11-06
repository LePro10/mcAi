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
  isFullSolid(state: string): boolean;            // full cube: all faces sturdy or full-cube collision (masks/terrain)
  isTransparent(state: string): boolean;          // !isSolidRender: glass, leaves, panes, air, plants, shulker boxes …
  physics(state: string): PhysClass | null;       // real per-state facts (physics.ts), null = no data
  hasPhysics(): boolean;
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

### core-geometry: implementation notes / additions (compatible with the above)
* `registry.ts`: `RegistryError.suggestions: string[]`; extras `suggest(query, limit)`, `tagMembers(tag)`,
  `levenshtein()`, `propOf(state, prop)`. Unknown ids → "Did you mean: …" (word overlap + edit distance +
  alias table, e.g. `cobble`, `grass`, `chain` → `iron_chain`). Solidity comes from the **registry
  physics** (ARCHITECTURE §5: the mod's hello table, else `engine/data/physics-26.3.json`, else id
  heuristics for unknown/modded blocks). `isFullSolid` is true for glass, leaves, mud, soul sand, shulker
  boxes (leaves only by collision — they have no sturdy faces; support.ts/connect.ts use the face data;
  the fence/wall/pane exceptions for leaves/pumpkins/melons/barrier/shulkers live in connect.ts);
  `isTransparent` = `!isSolidRender` (glass, leaves, ice, spawner, grates, shulker boxes, …).
* `physics.ts`: `PhysicsIndex`, `buildPhysicsTable`, `PF` flag bits, `PhysClass` =
  `[full, center, rigid, collision, support, flags]` (direction masks: down, up, north, south, west, east).
* `support.ts` face levels: `CENTER = 1`, `RIGID = 2`, `FULL = 7` (a full face is also centre + rigid; test
  with `(f & L) === L`). Extra kinds `bell` and `soil` (farmland/dirt path under a solid block → `dirt`,
  reported as a replacement); `soilConversions(get, positions, reg, {paths})` for the simulation.
* `connect.ts` also updates `snowy` (grass/podzol/mycelium under `#snow`), tripwire sides and pale moss carpet
  sides; an isolated redstone dot stays a dot (vanilla). Extras `isConductor(state)`, `wallCover(state)`.
* `transform.ts`: extras `rotateDir`, `mirrorDir`. Outputs are canonical; SNBT is kept (not rewritten).
  **Deviation from vanilla:** stairs `shape` left/right is swapped on *every* mirror (vanilla only swaps when
  the stair faces along the mirror axis — geometrically wrong); this keeps `mirror∘rot1 == rot3∘mirror`.
  Also swaps `side_chain` (shelves) left/right on mirror.
* `frame.ts`: extras `anchor`, `facing`, `isIdentity`, `toWorldInto(x,y,z,out)` (hot loops), `boxToLocal`.
* `pattern.ts`: string weights `"60%a,40%b"` or `"3*a,1*b"`, entries may be `keep`; gradient `stops`,
  noise/checker `blocks` entries may themselves be weighted strings; gradient accepts `from`/`to`
  (axis coordinates) instead of `opts.bounds`. Extras: `PatternError`, `hash3`, `mulberry32`, `perlin3`,
  `fbm3`, `uniformNoise3`, `splitTopLevel`, `patternBlocks`. Noise = 2-octave Perlin remapped to uniform.
* `mask.ts`: extra keywords `transparent`, `opaque`, `replaceable`, `*`/`any`; `"a,b"` = any-of; `MaskError`.
  `MaskFn` ignores coordinates (results cached per state string).
* `shapes.ts`: round shapes include points within radius+0.5 (width = 2r+1; `.5` centers/radii give even
  widths). Hollow = thinnest 6-connectivity-watertight shell; thickness = Manhattan distance to the outside.
  `cylinder` extra `caps?: boolean` (hollow default = open tube), negative `height` grows downward;
  `cone`/`pyramid` extra `thickness`; `cone` height < 0 points down; hollow cones/pyramids/half-ellipsoids
  have no floor. **`pyramid.base` = center of the bottom layer** (use .5 for even sizes). `line.thickness` =
  brush diameter; `curve.radius` = brush radius. `arch`: `from`/`to` = the two feet (same y, differ in x or
  z only), ring rises `height` above from.y, `depth` extrudes along +perpendicular (negative = −).
  `spiral` extra `startAngle`; `spiralCells(p, cb(x,y,z,ascendFacing))`. `roof` extra params `ends?: string`
  (gable end walls) and `facing?: Facing` (shed high side); defaults overhang 1 (dome 0), pitch 1 (shed 0.5,
  spire 3). Roof stairs shapes equal vanilla's `getStairsShape` result (stable under shape updates).
  Extras: `emitRegion`, `bresenham3`, `sampleCurve`, `roofMaterials(reg, stairs, slab?)`.
* `connect.ts`: `solveConnections` expands the 6 neighbours itself (callers need not pre-expand, but may);
  only changed states are returned, SNBT preserved. Extras `Connector`, `connectorFor(reg)`,
  `stairsShapeFor(...)`. Perf: 500k mixed blocks ≈ 0.4–0.6 s.
* `multiblock.ts`: extras `expandMultiblocks(entries, reg)` (only partners at positions not explicitly
  set), `isMultiblock`, `multiblockPartner`. pitcher_crop only expands at age ≥ 3.
* `dsl.ts`: also exports `PatternSchema`, `MaskSchema`, `DSL_HELP` (cheat-sheet for the agent prompt —
  prefer it over hand-written op docs). Ops: `set` (`pos` | `positions` | `entries:[[x,y,z,block],..]`),
  `fill` (`box` or `from`+`to`), `ellipsoid`/`sphere` (center+radius or `box`), `cylinder` (or `box`),
  `cone`, `pyramid` (base+size or footprint `box`), `torus`, `line`, `curve`, `polygon`, `arch`,
  `spiral` (+`stairs`, `column`), `roof`, `replace` (`box`, `from` = mask of what to replace, default
  `!air`, `to` = pattern; corner form `from`/`to` + `mask` + `block` also accepted), `clear`.
  Boxes: `{min,max}` or `[[x,y,z],[x,y,z]]`, any corner order. `executeOps` re-validates each op with the
  schema; `OpError.message` has no "op #i" prefix (callers add it). Patterns are evaluated in local
  coordinates (gradients follow the op's local bounds); masks see the current world state.

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

### core-data: implementation notes / additions (compatible with the above)
* `volume.ts` extras: `paletteIndex, volForEach, volPaste, cloneVolume, compactVolume, boxExpand,
  boxTranslate, boxContainsBox, boxToString, batchEntries, splitBatch, batchBounds, emptyBatch,
  typedToB64/b64ToInt32/b64ToUint16`. `volGet` outside the box returns air; `volSet` outside throws.
* `posmap.ts`: `PosMap<V>` — x/z packed exactly into one safe integer (|x|,|z| < 2^25), one Map per y.
* `session.ts`: `SessionOptions.history?: History` (flush pushes its record automatically).
  `set()` canonicalizes via the registry (throws RegistryError for bad states). Extras: `used`, `misses`,
  `records`, `cached()`, `isKnown()`, `addVolume()`, `discard()`, `withBackendLock(backend, fn)`.
  `FlushResult = { placed, unchanged, failed: {pos,reason}[], changed, connections, multiblock, batches,
  ms, warnings, record: UndoRecord | null }`. Undo `before` comes from `SetBlocksResult.previous`
  (never from a stale cache). Flush prefetches uncached blocks within Manhattan distance 2 of the
  changes before solving connections; connection changes outside `bounds` or at unknown blocks are
  skipped; multiblock partners never override explicitly set positions.
  `new History({ limit?: 100 })`; `group(actor, sinceId, label)` merges `sinceId` **inclusive** and
  everything newer; `mark(actor)` + `groupAfter(actor, mark, label)` merges everything pushed after
  the mark (exclusive; `''` = whole stack). Also `redoList`, `clear`, `mergeRecords`.
* `clipboard.ts`: `transformClipboard` applies mirror first, then rotation; the copy point keeps
  its world position. `entities` items are `{ id, pos /* rel. to volume.box.min */, snbt? }`.
  Extras: `copyFromSink, pasteBox, stackRegion(sink, box, count, dir, {gap, ignoreAir, mask}),
  moveRegion(sink, box, delta, {fill, ignoreAir}), clipboardBlockCount`. structure_void is never pasted.
* `schematic.ts`: `writeSponge(c, opts?)` / `writeStructureNbt(c, opts?)` take `{ dataVersion, name, author }`
  (default DataVersion is a placeholder — 26.3's real value is unverified). Read results carry
  `meta.format` and `meta.warnings` (unknown blocks → air, bad props → default state).
  `new StructureLibrary(dir = ~/.mcai/structures, reg = Registry.loadDefault())`, all methods async:
  `save(name, c, {description, tags, author}) → StructureMeta`, `load(name)`, `list({tag, query})`,
  `has(name)`, `delete(name)`. Names are slugified (`structureSlug`), so no path traversal.
  SNBT helpers live in `snbt.ts` (`nbtToSnbt, snbtToNbt, normalizeSnbt`).
* `script.ts`: `ScriptRequest.memoryMb?` (default 512). Defaults: timeout 15 s (max 120 s), maxBlocks
  500 000. When `error` is set, `entries` hold what was set before the failure (callers should
  normally not apply them). Script API (globals): `set, get, fill(x1,y1,z1,x2,y2,z2,b), box/cuboid,
  sphere/ellipsoid, cylinder, cone, pyramid, torus, line, curve, polygon, arch, spiral` (params as in
  shapes.ts, `box` also accepts `{from,to}`; block = state string | pattern string | PatternSpec |
  `(x,y,z) => state|null`), `roof(params)`, `positions(shape, params)`, `pattern(spec)`, `block(id, props)`,
  `isAir`, `noise2, noise3, fbm(=fbm2), fbm3`, `rand, randInt, chance, choice, shuffle` (seeded;
  `Math.random` is seeded too), `vec.*`, `log/console.log`, `info` ({space, frame, readBox, maxBlocks, seed}).
  Coordinates are rounded to integers.
* `analysis.ts`: `summarize(v, reg?, {byState?})`, `layerAscii(v, y, {byState?})` (rows = z north→south,
  columns = x west→east, legend char → block id), `surfaceMap(v, reg, {solidOnly?, ignoreLeaves?})`,
  `findDarkSpots(v, reg, {maxResults?: 5000})`, plus `lightEmission(state)`, `computeBlockLight(v, reg)`
  and `diffVolumes(a, b, {maxChanges?}) → { changes: [x,y,z,from,to][], added, removed, replaced, truncated }`.
* `prefabs.ts`: `at` = first air block above the ground. `params.facing` orients street furniture
  (front faces +z in local space); nature prefabs get a random rotation. Default seed derives from
  name + position. Extras: `resolvePrefabName` (aliases like `willow`, `palm`, `rock`).

### core: physics, connectivity, builders (builder-feedback iteration)
* `support.ts`: vanilla-like survival rules from block states only. `faceSupport(state, dir, reg)` → NONE/CENTER/FULL;
  `checkSupportAt`, `needsSupport`, `resolveSupport(seeds, get, reg, {mode, set, allow})` (cascading, top-down;
  unknown neighbours count as support), `removedState(state)` (water for waterlogged blocks / underwater plants,
  else air), `holdsWater`, `isFluidState`, `isWaterPlant`, `summarizeSupport`. Gravity blocks over air only warn.
* `session.ts`: `SessionOptions.support` / `FlushOptions.support` = `'drop'` (default) | `'warn'` | `'off'`; flush
  seeds the check with changed blocks + known neighbours of changed non-full blocks (drops become part of the
  undo record); `FlushResult.support: SupportReport | null` and `support: …` warning lines. Player WorldEdit tools
  use `'off'`.
* `trees.ts`: `naturalTreeMask(vol, reg, edited)`, `treeDebrisMask(vol, reg)` (floating log groups, leaves > 6
  from logs unless the leaf cluster rests on something), `findFloating(vol, reg, {within})`, `isNaturalGround`.
* `analysis.ts`: `classifyDarkSpots(vol, reg, spots)` → `'interior'|'covered'|'outdoor'|'roof'`.
* `builders.ts`: `bridge(p, reg, emit, get)` (half-slab quantised walkable deck, rails, posts, piers, ropes,
  lanterns) and `slabEdge(p, reg, emit)`; DSL ops `bridge`, `slab_edge` (alias `fascia`); helpers `slabFor`, `railFor`.
* `shapes.ts` roof: styles `cone`, `swept_hip`; params `round`, `flare`, `sweep`, `lift`, `skipBox`, `soffit`,
  `fascia`, `brackets`, `bracketEvery`, `finial`, `fill: true | id`; `validateRoofParams`, `ROOF_STYLES`.
* `script.ts`: `ScriptRequest.ground` (natural ground map for `groundY`), `.generators` (name → body);
  `ScriptResult.defines`, `.protectedSkips`. Sandbox globals `groundY, setSoft, protect, unprotect, define, call`;
  shape/roof params are validated with usage messages.
* `server/generators.ts`: `GeneratorLibrary` (`~/.mcai/generators/<name>.json`), `referencedGenerators(code)`.

### iteration 2 (real-Minecraft play-test)
* `server/hub.ts resolveAllowedBox(backend, req, cfg, world)` → `{box, notes}`: selection + `selectionMargin`
  (default 8), extended down to the lowest ground/water bed (ocean_floor heightmap) −2 (≤ 32 below the floor) and
  up to ≥ `minBuildHeight` (32, +16 for tall prompts). `JobRequest.allowedBox/boxNotes`; get_context shows
  `selection` (primary area) and `allowedBox.notes`; build_request answers `{ jobId, allowedBox, selection }`.
* `server/tools/world-cache.ts JobWorldCache` (via `worldOf(ctx)`): per-job read cache — first read inside the
  job area loads allowed box ± 4 once, slices afterwards; own writes update it; heightmaps cached and invalidated
  by overlapping writes; TTL 90 s; foreign edits (other jobs, player tools) invalidate overlaps; every real round
  trip is logged as job-log kind `world`. EditSession locks on `lockTarget` (the real backend).
* readBox (run_script) clamped to allowed ± 4, scan_region to allowed ± 16. Script globals `isWater(x,y,z)`;
  `groundY` covers allowed ± 8 and falls back to the nearest column instead of throwing.
* DSL: `vines` op (`builders.ts vines`: exterior detection by flood fill + sky access within 3, doorways skipped),
  `cylinder.interior` (exact tiling with the hollow shell), bridge rails 4-connected on diagonals.

---------------------------------------------------------------------------------------
## Owner: assets-render-sim

### assets/assets.ts
```ts
export class AssetStore {
  static open(version?: string /* '26.3' */, cacheDir?: string /* ~/.mcai/cache */): Promise<AssetStore>; // memoized; rejects if unavailable
  static tryOpen(version?, cacheDir?): Promise<AssetStore | null>;          // never throws
  constructor(source: AssetSource, version?: string);                       // e.g. new JarSource(path) / McmetaSource(dir)
  /** resolved geometry (state may be non-canonical: missing props = registry defaults) */
  geometry(state: string): BlockGeometry;   // see assets/geometry.ts
  textureAtlas(): { png: Buffer; width: number; height: number; uv(texture: string): [number, number, number, number] };
  atlasData(): AtlasData;                   // raw RGBA atlas + rects/flags (renderer)
  averageColor(state: string): [number, number, number, number];   // rgba 0..255 (top face, tinted)
  tint(kind: 'grass' | 'foliage' | 'dry_foliage' | 'water', biome?: string): [number, number, number];
  tintFor(g: BlockGeometry, biome?: string): [number, number, number] | null;
}
interface BlockGeometry { state; cuboids: GeoCuboid[]; ao; layer: 'opaque'|'cutout'|'translucent'; fluid: 'water'|'lava'|null;
  fluidLevel; fullCube; emission /*0..15*/; tint: rgb|null; tintKind; synthetic; flat; color: rgba; invisible }
interface GeoCuboid { from; to /* element space 0..16 */; m: number[9]; t: number[3] /* element→block: p' = m·p + t */;
  identity; faces: Partial<Record<Dir, GeoFace>> /* keyed by element-space dir */; shade }
interface GeoFace { texture /* 'block/stone' */; uv: [u0,v0,u1,v1] /* 0..16 */; rotation; tint /* -1 none */; cullface: Dir|null /* block space */; uvlock }
```
Sources (assets/sources.ts): client jar preferred (`MCAI_MC_JAR`, `~/Library/Application Support/minecraft/versions/<v>/<v>.jar`,
`%APPDATA%/.minecraft`, `~/.minecraft`), else misode/mcmeta (`<v>-summary` block_definition + model, `<v>-atlas` blocks+entities
atlases, `<v>-assets` colormaps) cached in `~/.mcai/cache/mcmeta/<v>/` (`MCAI_CACHE`, `MCAI_OFFLINE=1`, `MCAI_NO_JAR=1`).
Tints follow vanilla BlockColors only (grass/foliage/dry_foliage/water colormaps, fixed birch/spruce/mangrove/lily pad,
redstone power, stems, banner dye); everything else (cherry/azalea/pale oak leaves…) is untinted.

### render/render.ts
```ts
export interface RenderOptions { width?: number /*1024*/; height?: number /*768*/;
  view?: 'iso_ne' | 'iso_nw' | 'iso_se' | 'iso_sw' | 'front' | 'back' | 'left' | 'right' | 'top' | 'orbit';
  yaw?: number;   // orbit: Minecraft yaw of the look direction (0 = looking south, 90 = west, 180 = north; default 135);
                  // top: image-up = north rotated clockwise by yaw
  pitch?: number; // elevation in degrees, positive looks down (iso 30, elevations 0, orbit 28)
  zoom?: number; focus?: Box /* frame this box, default = non-air bounds */;
  shadows?: boolean; time?: 'day' | 'sunset' | 'night'; highlight?: Box; labels?: boolean;
  supersample?: number /* 1|2 */; ao?: boolean; ground?: boolean /* grid plane at volume bottom */; fog?: boolean;
  biome?: string /* tints, default plains */; sun?: 'camera' | 'world'; parallel?: boolean; title?: string }
export function renderVolume(v: BlockVolume, assets: AssetStore | null, opts?: RenderOptions): Promise<Buffer /* PNG */>;
export function renderImage(v, assets, opts?): Promise<Img>;                       // RGBA for compositing
export function contactSheet(v, assets, opts?: RenderOptions & { views?: ViewName[] }): Promise<Buffer>; // default 4 iso views, 2×2, labelled
export function renderLayers(v, assets, ys: number[], opts?: { cell?; maxWidth?; columns?; ghost? }): Promise<Buffer>; // blueprint slices
```
Extras: `section?: boolean` (default true — natural terrain/water cut by the volume edge is drawn as a flat
hatched section), `cutaway?: boolean` (default true — elevations skip natural terrain in front of the focus box);
clear/stained glass get tint, fresnel sky reflection and darker edges. `render/expand.ts`: `builtMask(records)`,
`expandToComponents(box, …)` (render_view `expand`, grows the box along connected build parts ≤ 24 per side).
Views: camera position relative to the target — iso_se = from +x/+z, front = from +z (south) looking north, back = from −z,
left = from −x (west), right = from +x. Orthographic except 'orbit' (perspective, fov 45°). Never fails without assets
(flat palette colors + approximate shapes). Large images use a worker_threads pool (`MCAI_RENDER_THREADS`).

### sim/sim-backend.ts
```ts
export class SimBackend implements WorldBackend {
  constructor(opts?: { seed?: number; name?: string; persistDir?: string /* auto-loads world.bin.gz */; registry?: Registry;
                       players?: PlayerInfo[] /* default: Steve at spawn */ });
  on(event: 'blocks' | 'notify' | 'command', cb: (...a: any[]) => void): void;  // 'blocks': (batch: EditBatch) final states after setBlocks
  off(event, cb): void;
  addPlayer(p: PlayerInfo): void;  removePlayer(name: string): void;
  save(): Promise<void>;  load(): Promise<boolean>;      // modified sections + state, gzip binary
  getBlocksSync(box): BlockVolume;  setBlocksSync(batch, opts?): SetBlocksResult;   // sync variants
  biomeAt(x, y, z): string;  spawnPoint(): [number, number, number];
  readonly state: { time; weather; gamerules; entities; biomeOverrides };  readonly notifications: PlayerNotification[];
}
```
`heightmap()` returns `HeightmapResult` (types.ts), y of the highest non-air block ('ocean_floor': ignores fluids/plants/leaves).
`biomes()` samples at `min + i*step`, layout x fastest, then z, then y. Only `minecraft:overworld` exists.
`runCommand` supports time, weather, summon, kill, fillbiome, setblock, fill, particle/playsound/stopsound (no-op), say/tellraw/title
(→ notify), gamerule, difficulty; anything else → `{ ok:false }` with the supported list. `setBlocks` with `updateShapes` (default)
runs core `solveConnections` on changed positions (neighbour changes are applied but not part of `previous`, like the real game).

---------------------------------------------------------------------------------------
## Owner: server-agent (engine/src/server, engine/src/agent, engine/src/cli.ts)
Consumes everything above. Exposes the HTTP/WS/MCP surface from ARCHITECTURE §5–§8.

```ts
// server/hub.ts
export class Hub { constructor(o: { config: Config; backend?: WorldBackend /* sim; omit = ModBackend */; port?: number /* 0 = any */;
  runner?: Runner; writeEngineJson?: boolean; token?: string; viewerDir?: string; log?: (l: string) => void });
  start(): Promise<void>; stop(): Promise<void>; readonly port: number; readonly token: string;
  backend(): WorldBackend; registry(): Registry; readonly jobs: JobManager; readonly history: History;
  submitJob(body: { prompt; player?; anchor?; facing?; selection?; size?; ... }, source?): Promise<Job>;
  broadcast(msg: object): void /* to all /viewer sockets */ }
// server/mod-bridge.ts
export class ModBackend implements WorldBackend { attach(ws); connected; hello; blockRegistry; onRequest(type, handler);
  request(type, payload, timeoutMs); jobUpdate(u); waitForConnection(ms) }   // events: 'hello', 'disconnect'
// agent/jobs.ts
export class JobManager { submit(req: JobRequest): Job; cancel(id, reason); ask(job, q, options, ms); answer(jobId, text);
  get(id); list(); activeFor(player) }   // events: 'update' (Job), 'agent' (Job, AgentEvent), 'end' (Job)
// agent/runner.ts
export class ClaudeRunner implements Runner { constructor(o: { config; endpoint: () => {port, token}; agentDir?; killGraceMs? }) }
export function buildInvocation(job, cfg, endpoint): { command; args; stdin; mcpConfigFile }
```
Env: `MCAI_HOME` (default ~/.mcai), `MCAI_CLAUDE` (claude executable; a `.mjs/.js/.ts` path is run with node),
`MCAI_NO_ASSETS=1` (renders without textures, no downloads).
