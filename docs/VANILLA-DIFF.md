# Vanilla differential test — engine rules vs the real Minecraft 26.3

`tools/vanilla-diff.mjs` checks the engine's re-implementations of vanilla rules
(`engine/src/core/connect.ts`, `support.ts`, `transform.ts`, `multiblock.ts`, `registry.isFullSolid /
isTransparent`) against the **real 26.3 game**: a dedicated test server driven through the mod, plus
the unobfuscated 26.3 server classes executed directly. This file lists every mismatch found, ordered
by how often the AI builder would hit it, with the vanilla code that decides it and a suggested fix.
Nothing in `engine/`, `mod/` or `agent/` was changed — fixes are for the owners to route.

Run of 2026-11-06 (seed 1; connect also seeds 2 + 3), mod 2.0.0 on 26.3, Fabric test server:

| suite | what is compared | tested | mismatches |
|---|---|---|---|
| static | per-state facts executed in the real classes vs engine face/solidity heuristics | 35 723 states × 6 faces | 16–224 blocks per check (table below) |
| transform | `BlockState.rotate/mirror` vs `rotateState/mirrorState` | 35 321 states × 5 ops = 176 605 | 10 940 (54 families, all deliberate/benign) |
| connect | random scenes placed with vanilla shape updates vs `solveConnections` | 768 scenes, 25 555 positions (8 323 connectable) | 445 connect + 218 "unmodelled" |
| support | attachable next to a candidate support, real neighbour update decides | 17 440 cases, 61 families | 1 622 |
| multiblock | `expandMultiblock` vs decompiled `setPlacedBy` | doors, beds, double plants, small dripleaf, pitcher | 0 |

Connect per family (3 seeds): **stairs 0/1 798**, **fence gates 0/160**, fence 75/1 454, pane 48/874,
wall 237/2 674, redstone wire 85/1 363. Stair shapes (`stairsShapeFor`) and gate `in_wall` are exact.

## How the harness works

```sh
node tools/vanilla-diff.mjs                         # all suites (≈ 3–4 min incl. server boot)
node tools/vanilla-diff.mjs --suite static,transform   # no server needed (uses the cached probe)
node tools/vanilla-diff.mjs --suite connect --seed 7 --scenes 256
node tools/vanilla-diff.mjs --suite support [--scenes N]   # N = sample size of the 17 440 cases
node tools/vanilla-diff.mjs --keep-server ...       # leave the test server up; next run re-attaches
node tools/vanilla-diff.mjs --stop-server
node tools/vanilla-diff.mjs --regenerate-probe      # re-run Probe.java (≈ 3 min)
```

Output: a summary on stdout and `tools/vanilla-diff/last-report.json` (`--report FILE`; ~3 MB,
untracked — consider adding it to `.gitignore`). Every group has examples with the exact states,
positions and neighbourhood, so each finding below can be replayed.

* **static / transform** — `tools/vanilla-diff/Probe.java` runs inside the real 26.3 server jar
  (`java -cp server-26.3.jar:libs Probe.java`, `Bootstrap.bootStrap()`, no world): for every block state it
  records `isFaceSturdy(FULL|CENTER|RIGID)` per face, `isFaceFull(collisionShape|supportShape)`,
  `isSolidRender`, `canOcclude`, `isCollisionShapeFullBlock`, legacy `isSolid()`, `isRedstoneConductor`,
  `canBeReplaced`, `Block.isExceptionForConnection` and `rotate(CW_90|180|CCW_90)` / `mirror(LEFT_RIGHT|FRONT_BACK)`.
  Cached as `~/.mcai-tools/vanilla-diff/probe-26.3-33680f5f.jsonl`. Static runs on both registries the
  engine uses: `offline` (`engine/data/registry-26.3.json`, sim/CLI) and `live` (the mod's hello
  registry, which adds `solid = isCollisionShapeFullBlock` hints; cached from the last server run).
  Executing the vanilla methods is more faithful than reading them; for `rotate/mirror` it is exactly
  what `StructureTemplate` / `place template` call.
* **connect** — scenes of 8 families (fence, pane, wall, wall_above, stairs, gate, redstone, misc) with
  random initial properties and ~100 neighbour kinds, placed in one `set_blocks` with
  `updateShapes:true` (vanilla `Block.updateFromNeighbourShapes`, top-down input order so the wall
  above is final first), read back with `get_blocks`, compared with `solveConnections` over the same
  scene. Wires only stand on vanilla `canSurviveOn` blocks (the mod rejects id-changing shape results).
  Self-activating redstone (observers, daylight detectors, sculk sensors, TNT, pistons, dispensers) is
  excluded: their ticks/vibrations cause real neighbour-update cascades and made runs non-deterministic.
* **support** — the mod's placement never deletes blocks, so survival is tested with vanilla `setblock`
  (allowlisted for the harness only): target T placed without updates, then `setblock` of the candidate
  support S at the cell vanilla checks (`updateShape` direction from the decompiled code) → real
  `updateNeighbourShapes` + `updateNeighboursOnBlockSet`; 8 ticks later T is read back. Engine verdict =
  `checkSupportAt` on the same scene. Cases where S itself broke (cactus on stone …) are not scored.
  Phase 2 places the same scenes the way mcAI does (one `set_blocks`, `updateShapes:true`, nothing else).
* **Isolation**: the test server is started by `tools/testserver.sh` with `MCAI_HOME=~/.mcai-tools/vanilla-diff/home`
  (our own `engine.json` + `config.json` with the command allowlist), port 25599, lock
  `/tmp/mcai-testserver.lock`; `~/.mcai/engine.json` and `tools/testserver/config/mcai.json` are never
  touched; game rules (`block_drops`, `random_tick_speed`, `advance_time`, `spawn_mobs`, `advance_weather`)
  and the forceload are restored at the end; only a server the harness started is stopped.
  Test areas: x 3000–3128, z 3000–3276, y −61…−54 of the flat test world.

Decompiled sources for the references below: `~/.mcai-tools/vanilla-diff/src/net/minecraft/…`
(Vineflower 1.12.0 from Maven Central, sha1-verified; classes from `server-26.3.jar`).

---

## Findings, by priority

### P1 — hit by ordinary builds

#### 1. Leaves are treated as sturdy (torches, lanterns, ladders, buttons, rails, doors, … on leaves)
* **Where**: `support.ts computeFace` → `reg.isFullSolid(leaves) = true` → FULL on every face;
  `registry.ts` header ("leaves count as full").
* **Vanilla**: `LeavesBlock` has an empty block-support shape — `isFaceSturdy(FULL|CENTER|RIGID)` is
  false on **all** faces (probe: `oak_leaves … full=0 center=0 rigid=0`), while the collision shape is a
  full cube. So everything that uses `isFaceSturdy` / `canSupportCenter` / `canSupportRigidBlock` pops on
  leaves: `BaseTorchBlock.canSurvive → canSupportCenter(below, UP)`, `LanternBlock` (also hanging below
  leaves), `WallTorchBlock`, `LadderBlock`, buttons/levers (`FaceAttachedHorizontalDirectionalBlock.canAttach`),
  pressure plates, rails, redstone wire, repeaters, doors (`DoorBlock.canSurvive → isFaceSturdy(UP)`),
  hanging signs, cave/weeping vines, hanging roots, spore blossom, dripstone, amethyst, scaffolding,
  tripwire hooks, wall corals. Vines/glow lichen (`MultifaceBlock.canAttachTo` = support **or collision**
  face full), snow layers (`isFaceFull(collisionShape, UP)`), carpets (`!isEmptyBlock(below)`) and sea pickles
  do stay on leaves.
* **Repro** (support suite, all 3 leaf types): `torch` at P, `oak_leaves[persistent=true]` at P−y →
  vanilla pops, engine keeps. Same for `lantern[hanging=true]` with leaves at P+y (tree lanterns!),
  `wall_torch[facing=north]` with leaves at P+z, `ladder`, `rail`, `oak_door` (lower+upper) on leaves.
* **Fix**: in `computeFace` return NONE for `#minecraft:leaves` (and the other empty-support-shape
  blocks below); keep a separate "collision face full" notion for multiface/vine/snow/sea-pickle rules.
  Best: use the vanilla face table (see "Structural fix").

#### 2. AI-placed leaves decay (default state is `persistent=false`)
* **Where**: registry default `oak_leaves[distance=7,persistent=false]`; the agent's `"oak_leaves"` is
  canonicalised to it (`dsl.ts` even documents `{op:"torus",…,block:"oak_leaves"}`); only `prefabs.ts`
  forces `persistent=true`.
* **Vanilla**: `LeavesBlock.isRandomlyTicking = distance == 7 && !persistent`; `randomTick` →
  `decaying()` → `dropResources` + `removeBlock`. The mod's shape pass calls `LeavesBlock.updateShape`,
  which schedules the distance tick: measured on the test server, a leaf placed as `distance=1` with no
  log nearby is `distance=7` a few ticks after mcAI placed it (log-adjacent ones get `distance=1`). With
  a player nearby (random ticks run only near players) hedges, topiary and leaf roofs vanish within
  minutes. A player-placed leaf is always `persistent=true`.
* **Fix**: when canonicalising states for placement, default `persistent=true` for `#leaves` unless the
  caller set it explicitly (tree generators that want natural leaves already set it). `trees.ts`
  "natural leaf" detection keeps working (it reads world leaves).

#### 3. Walls: `tall`/`low` and the post come from the collision shape of the block above
* **Where**: `connect.ts updateConnecting` (`full = sturdy(above,'down')`, else "wall above with that side")
  and `wallPost` (`POST_COVER_RE`, `coversPost`).
* **Vanilla** (`WallBlock.updateShape(level,state,topPos,topNeighbour,…)`): `aboveShape =
  topNeighbour.getCollisionShape().getFaceShape(DOWN)`; side = `tall` iff `isCovered(aboveShape,
  TEST_SHAPES_WALL[dir])` (`Block.boxZ(2,16,0,9)` rotated: x 7–9, z 0–9 from that edge to the centre);
  post: `topNeighbour is WallBlock && up` → true; else corner/end rules; else not if a straight tall pair;
  else `#wall_post_override || isCovered(aboveShape, TEST_SHAPE_POST = column(2,0,16))` (x/z 7–9).
* **Measured** (144 + 28 of 445 connect mismatches — the largest group): engine `low`, vanilla `tall`
  under pale/moss/wool carpets, end portal frame, sculk sensor, campfire, stonecutter, soul sand, mud,
  farmland, dirt path, composter, glass panes / bars / fences (on the side of their arm), bell,
  daylight detector, comparator, enchanting table, lectern, trapdoors, snow layers. Post: vanilla `up=true`
  under flower pots, potted plants, heads/skulls, candles, sea pickles, amethyst, barrel, target; vanilla
  `up=false` under cauldron, hopper, campfire, glass pane/copper bars (straight), stonecutter, lectern, bell,
  grindstone, composter (engine `true`).
* **Repro**: `cobblestone_wall` line x=0..2 at y=0, `white_carpet` on x=1,y=1 → vanilla middle wall
  `east=tall,west=tall,up=false`, engine `low/low`. `stone_brick_wall` line + `flower_pot` above the middle
  → vanilla `up=true`.
* **Fix**: give the connector the bottom collision face of the block above as a 16×16 coverage mask
  (or just two booleans per state: "covers centre column 7–9" and per direction "covers arm x7–9 z0–9") —
  from the vanilla table; then `tall = covers(arm[d])`, post per the vanilla order above.

#### 4. Fences / panes / walls connect to every sturdy face, not only full blocks
* **Where**: `connect.ts Connector.sturdy()` (full blocks, slabs, stairs only).
* **Vanilla**: `FenceBlock.connectsTo(n, n.isFaceSturdy(level, pos, dir.opposite), …)`,
  `IronBarsBlock.attachsTo`, `WallBlock.connectsTo` — any FULL-sturdy face counts.
  Probe/scene evidence: **doors** (the panel face: front/back when closed, the side when open —
  48 cases), **composter** (sides, 44), **soul sand / mud** (30 + 29, see 5), open/closed **trapdoors**
  (the panel face), **shelves** (back), **ladders** (back), piston bases.
* **Repro**: `oak_fence` at (0,0,0), `oak_door[facing=east,half=lower,open=false]` at (1,0,0) +
  upper half → vanilla `east=true`, engine `false`. `glass_pane` beside an **open** door in a wall line
  connects to it in vanilla.
* **Fix**: replace `sturdy()` with the vanilla per-state sturdy-face mask (structural fix); short term add
  doors (face = opposite of the panel side), trapdoors (panel face), composter (4 sides + bottom),
  shelves (back), ladder (back).

#### 5. Live registry: `solid=false` hint makes mud and soul sand non-solid
* **Where**: `registry.ts` constructor `full: info.solid === false ? false : idFull(id)`; the mod sends
  `solid = isCollisionShapeFullBlock` (`RegistryDump.java:62`).
* **Vanilla**: mud and soul sand have a 14/16 collision box but a **full support shape** — every face is
  sturdy, they hide neighbour faces and conduct redstone. With the live registry the engine says
  `isFullSolid=false` → fences/panes/walls don't connect (59 connect mismatches), walls under them stay low,
  `isTransparent=true`, `conductor=false`. Offline (sim) gets them right. (`support.ts` special-cases mud
  and soul sand, so survival is fine.) The live hint is right for powder snow (offline wrong).
* **Fix**: don't derive "sturdy" from collision fullness; let the mod send the sturdy masks (structural
  fix) or use `solid` only as an "occupies the whole cube" hint, never for faces.

#### 6. `dirt_path` and `farmland` tops are not sturdy (15/16 tall)
* **Where**: `support.ts computeFace` returns FULL for `farmland`, `dirt_path`, `honey_block` (and `mud`,
  `soul_sand` — those two are correct).
* **Vanilla**: probe `dirt_path`/`farmland`: no FULL/CENTER/RIGID top or side; `honey_block`: no sturdy
  faces at all. So torches, lanterns, pressure plates, rails, redstone, buttons, doors, scaffolding,
  snow layers, leaf litter on paths/farmland pop; wall torches/ladders/buttons on their sides pop.
  Composter top is not sturdy either (engine FULL). Verified separately on the server: `oak_door`
  (both halves), `stone_pressure_plate`, `torch`, `rail`, `lantern` placed on `dirt_path` and on
  `farmland` all pop on the first update — and the path under a solid block (door, plate, lantern) also
  turns into `dirt` (`DirtPathBlock.updateShape(UP)` → tick → `turnToDirt`; same for farmland, #28).
  (In the support suite most dirt_path cases are unscored because the path itself changed.)
* **Repro**: `lantern` at P, `dirt_path` at P−y → vanilla pops, engine keeps. `oak_door` on `dirt_path`
  (a path leading into a doorway) → the door pops.
* **Fix**: farmland/dirt_path → FULL only for `down`; honey_block → NONE (collision face full for
  multiface only); composter: no `up`.

#### 7. `grass_block`/`podzol`/`mycelium` become `snowy=true` under snow — engine does not model it
* **Where**: not in `connect.ts` (kind `other`). 82 "unmodelled" changes.
* **Vanilla**: `SnowyDirtBlock.updateShape(UP)` → `snowy = above is #snow` (snow layer, snow block,
  powder snow). The mod's boundary shape pass applies it in the world, so the world is right but the
  engine's world model / renderer / undo diff are not.
* **Fix**: add a `snowy` kind (grass_block, podzol, mycelium): `snowy = above ∈ #minecraft:snow`.

### P2 — common decorations / medium frequency

#### 8. Bells have no survival rule
* `support.ts` has no rule → floating bells are never dropped/warned. Vanilla `BellBlock.canSurvive`:
  floor → `canAttach(below)` (FULL sturdy), ceiling → `canSupportCenter(above, DOWN)`, single_wall →
  sturdy face behind, double_wall never pops. 246/516 bell cases differ (bell on air, slabs, fences, chains,
  leaves, hoppers … stays in the engine).
* **Fix**: `faceAttached`-like rule keyed on `attachment` (ceiling = CENTER, others FULL, double_wall none).

#### 9. Mushrooms depend on light and solid-render
* Engine: FULL face below. Vanilla `MushroomBlock.canSurvive`: below `#overrides_mushroom_light_requirement`
  (mycelium, podzol, nyliums) → ok; else `rawBrightness(pos) < 13 && below.isSolidRender()`. At noon on
  the surface (sky light 15) every mushroom on stone/grass/dirt/planks pops (66/96 cases); glass, leaves,
  slabs never work. In caves/indoors they stay.
* **Fix**: allow only the override tag, or `isSolidRender` + a light estimate (warn on sky-exposed cells).

#### 10. Hanging/standing small lights: CENTER table details
* Lanterns, torches, pressure plates, hanging signs. Vanilla `canSupportCenter` / `isFaceSturdy(CENTER)`:
  * engine keeps, vanilla pops: below `hopper` (side-facing), `grindstone`, `bed`, `pointed_dripstone`
    (hanging); on top of `composter`, `farmland`, `dirt_path`, `honey_block`, `cauldron`s, `hopper`(top),
    `pointed_dripstone`. (`#unstable_bottom_center` is checked for `DOWN`.)
  * engine drops, vanilla keeps: hanging under a standing lantern, anvil, flower pot, heads, decorated
    pot, heavy core, azalea, sculk sensor, repeater, cake; standing on bell, grindstone, decorated pot,
    azalea, amethyst cluster, dragon/sniffer egg, piston head.
* Fix: vanilla table (structural fix).

#### 11. Vines: the `up` face checks the TOP face of the block above (vanilla quirk)
* `VineBlock.getUpdatedState`: `state.setValue(UP, isAcceptableNeighbour(level, abovePos, Direction.DOWN))`
  → `MultifaceBlock.canAttachTo(level, DOWN, …)` tests `faceFull(…, DOWN.getOpposite() = UP)`.
  So a ceiling vine (`up=true`) survives under a **top** slab / upside-down stairs / top trapdoor and
  pops under a **bottom** slab, bottom stairs, closed bottom trapdoor, lectern, stonecutter, enchanting
  table, daylight detector, bed — the opposite of `vineRule`'s `has(up, FULL)` (29 cases).
  Side faces also accept doors/shelves/ladders (sturdy-or-collision face), but not dirt_path/farmland/honey.
* **Fix**: in `vineRule` test the above block's `up` collision/support face for the `up` property.

#### 12. Candles and wall hanging signs never pop in vanilla
* `CandleBlock.updateShape` has no survival check (only placement checks `canSupportCenter`);
  `WallHangingSignBlock` does not override `canSurvive` (only `canPlace` checks the sides). The engine drops
  them (`floorCenter` / side rule): 108/258 candle and 34/258 wall-hanging-sign cases. The engine is
  stricter than the game — harmless for looks, but it deletes blocks a player could keep. Optional:
  downgrade to a warning.

#### 13. Floor-standing signs, banners, cakes use legacy `isSolid()`
* `StandingSignBlock/BannerBlock/CakeBlock.canSurvive → below.isSolid()` (legacy "solid" flag).
  Engine `solidish` gets it wrong for: end rod, carpets, moss carpet, `snow[layers=8]`, scaffolding
  (not solid in vanilla → pop) and cobweb, signs (solid → stay). Wall signs/banners same (end rod).
* Fix: ship the `legacySolid` bit (probe column) and use it in `solidish`.

### P3 — rare

| # | rule (file/function) | vanilla (26.3 code) | engine | cases |
|---|---|---|---|---|
| 14 | ascending rails (`support.ts` `floorFullCover`) | `BaseRailBlock.shouldBeRemoved`: also `canSupportRigidBlock(pos.relative(ascending dir))` | ignores the slope side | 133/258 |
| 15 | rails/repeaters/comparators use RIGID (`DiodeBlock.canSurviveOn`, `canSupportRigidBlock`) | RIGID ≠ FULL for 28 blocks (static `support.rule.RIGID-up`) | FULL | (in 1/6) |
| 16 | redstone wire on hopper | `RedStoneWireBlock.canSurviveOn = isFaceSturdy(UP) \|\| is(HOPPER)` | drops | 4 |
| 17 | chorus plant/flower (`computeRule` returns null) | `ChorusPlantBlock/ChorusFlowerBlock.canSurvive` (end stone / chorus below …), scheduled tick | never drops | 84/96 |
| 18 | big dripleaf (no rule) | `#supports_big_dripleaf` or stem/dripleaf below | never drops | 32 |
| 19 | small dripleaf (`supports_small_dripleaf` OR `supports_vegetation`) | `SmallDripleafBlock.mayPlaceOn`: `#supports_small_dripleaf` or (water source above-ish **and** vegetation) | keeps on dirt/grass/mud | 10/48 |
| 20 | hanging mangrove propagule (`ceilCenter`) | `#supports_hanging_mangrove_propagule` (mangrove leaves) | any CENTER face | 75/129 |
| 21 | spore blossom (`ceilFull`) | `canSupportCenter(above, DOWN)` (fences/chains ok) | needs FULL | 24 |
| 22 | sea pickle (`has(down, CENTER)`) | non-empty collision top face or sturdy (stairs, hopper, open trapdoor, cauldron ok; path/farmland/honey not) | CENTER | 21/129 |
| 23 | cactus flower | `CactusFlowerBlock`: `#support_override_cactus_flower` or sturdy CENTER top (stone, planks, glass …) | tag-only | 21/48 |
| 24 | dead coral plants (`has(down, FULL)` for corals) | dead corals: `BaseCoralPlantTypeBlock` — sturdy top; 76 cases stem from slabs/stairs/fences/… differences and leaves | | 76 |
| 25 | gravity (`gravityRule`, warn-only) | `FallingBlock.isFree`: air, fire, liquids **or replaceable** (snow layers, vines, glow lichen …) | only air/fluid | 12 |
| 26 | wire "dot" (`updateWire`) | `getConnectionState`: a dot (all `none`) with no connections stays a dot; engine turns every isolated wire into a cross | 62 |
| 27 | wire conductors (`conductor = full && !transparent`) | `isRedstoneConductor`: observer, pistons, copper bulbs, redstone block, glowstone, sea lantern, TNT, snow block 8 are **not**; vault, trial spawner, spawner, slime, barrier, mangrove roots **are** | 11 + static 24 blocks |
| 28 | farmland under a solid block (unmodelled) | `FarmBlock.updateShape(UP)` schedules `turnToDirt` when the block above is solid | keeps farmland | 44 |
| 29 | tripwire / pale moss carpet sides / door half sync (unmodelled) | `TripWireBlock`, `MossyCarpetBlock`, `DoorBlock.updateShape` copy/derive props | not modelled | 36+13+4 |

Registry heuristics (static, live registry): `isFullSolid` differs for 17 blocks (14 leaves, chorus
flower, mud, soul sand — vanilla: no sturdy faces / all sturdy), `isTransparent` (≈ !isSolidRender) for
20 (shulker boxes are not solid-render; mud/soul sand are). `Connector.classify().exception` matches
vanilla `isExceptionForConnection` exactly.

### Mod placement: what breaks after an mcAI build even without neighbour updates
Phase 2 of the support suite places target + support in one `set_blocks(updateShapes:true)`. The mod's
shape pass discards id-changing results, but vanilla `updateShape` still **schedules ticks**, and those
ticks remove unsupported blocks a moment later: cactus next to a solid block or on wrong ground,
sugar cane without water, bamboo, scaffolding, pointed dripstone, cave/weeping/twisting vines, pale
hanging moss, chorus plant/flower, anvils over air. The engine already drops most of these (mode `drop`),
except **chorus** (no rule: 84/86 broke on non-end-stone ground) and **anvils** (gravity is warn-only). Gravity blocks
**without properties** (sand, gravel, concrete powder) are skipped by the mod's shape pass
(`PlaceBlocksTask.fixShape`: "a block without properties cannot change") and so float until the next
neighbour update — anvils (with `facing`) fall immediately. Daylight detectors/sculk sensors in a build
emit real updates on their own and re-trigger survival checks of neighbours.

A related ordering caveat: the mod's shape pass is a single pass in input order, so a fence/pane next to
a stair placed *later* in the batch sees the stair's pre-update shape. Harmless in production (the
engine sends already-solved shapes), but the mod's own result is not always a fixed point.

### Transform (rotate / mirror) — no actionable bug
All 54 mismatch families are places where the engine is *geometrically* right and vanilla is not (vanilla
relies on a later `updateShape` to repair them):
* stairs `shape` on mirror (vanilla `StairBlock.mirror` swaps left/right only when facing is along the
  mirror axis — already documented as deliberate in `transform.ts`);
* chests / copper chests `type=left|right` (vanilla `ChestBlock.mirror` keeps the type, so mirrored
  double chests split in vanilla structures);
* shelves `side_chain` (vanilla keeps it);
* fire and chorus plant `north/east/south/west` (vanilla does not override rotate/mirror — they are
  recomputed by `updateShape`);
* anvils `facing` on mirror (vanilla keeps it; the model is 180°-symmetric).
Everything else — facing/horizontal_facing, axis, rotation 0–15 (incl. both mirror formulas), rails
(incl. ascending/curves), hinges, crafter/jigsaw `orientation`, walls/fences/panes/wire sides — matches
for every state. Positions (`rotatePos`/`mirrorPos`) match `StructureTemplate.transform`
(CW_90: (x,z)→(−z,x); LEFT_RIGHT: z→−z; FRONT_BACK: x→−x).
Suggestion: list chests/shelves/fire/chorus/anvil next to the stairs note in the `transform.ts` header.

### Multiblock — matches
`DoorBlock.setPlacedBy` (upper = same state, `half=upper`, at +y), `DoublePlantBlock.setPlacedBy/placeAt`
(upper at +y, `copyWaterloggedFrom`), `SmallDripleafBlock.setPlacedBy` (upper keeps `facing`),
`PitcherCropBlock.isDouble(age) = age >= 3`, `AbstractBedBlock` (head = foot + `facing`): all agree with
`multiblock.ts`. The engine copies *all* properties to the partner; vanilla copies fewer for double
plants, which have no other properties — equivalent. (26.3 adds `StrawBedBlock`; the generic `part`
rule covers it.)

---

## Structural fix (recommended)

Most P1–P3 face/solidity findings disappear if the engine stops guessing faces. The mod has the real
classes at hand: extend `RegistryDump` with per-state bit masks (6 bits each) for
`isFaceSturdy FULL / CENTER / RIGID`, `isFaceFull(collisionShape)`, `isFaceFull(supportShape)`, plus
`isSolidRender`, legacy `isSolid`, `isRedstoneConductor`, `canBeReplaced`, and the two wall-coverage bits
of the bottom collision face (arm per direction, centre column). That is ≈ 6 bytes × 35 723 states
(≈ 290 kB raw, far less as base64 per block). Snapshot it into `engine/data/` for the offline registry
(Probe.java already computes all of it — `probe.mjs` output can be converted directly). Then:
`Connector.sturdy` = FULL mask, wall tall/post = coverage bits, `support.ts computeFace` = FULL/CENTER
masks (RIGID for rails/diodes, collision mask for multiface/vine(up quirk)/snow/sea pickle),
`solidish` = legacy solid, `conductor` = conductor bit, `isFullSolid` = all six FULL bits.
Keep `vanilla-diff --suite static` as the regression test for the table.

## Not covered / limits
* Water-dependent plants (lily pad, sugar cane next to water, seagrass, kelp, live coral) are not tested
  dynamically — flowing water would leak between cases; their rules were only read in the decompiled code
  (`WaterlilyBlock.mayPlaceOn`: water with empty fluid above, or ice; `SugarCaneBlock`: water/frosted ice
  next to the ground block) and look consistent with `support.ts`.
* Random-tick behaviour (leaf decay, vine/grass spread) cannot run on a server without players; leaf decay
  is shown statically + by the distance update after placement.
* Survival of blocks whose check depends on more than one neighbour is sampled with one candidate support
  at a time (other neighbours air), e.g. vines with several faces.
