# Block-state cheat sheet (Minecraft 26.3)

Syntax = /setblock syntax: `id[prop=value,...]{snbt}`. Omitted properties take defaults. Authoring in
**local space**: states are written as if the player looks north; +z = toward the player, −z = into the site.
The engine rotates positions *and* states to world space. When in doubt: `block_info <id>` lists properties.

Directions in local space: `north` = −z (away from player), `south` = +z (toward player / front facade),
`east` = +x (player's right), `west` = −x.

## Engine does this for you — don't fight it
- **Connections** (fences, walls, panes, iron/copper bars, stairs corner shapes, chest pairs, redstone, tripwire) are
  computed on flush. Never hardcode `north=true`/`shape=outer_left`; just place the base id.
- **Multiblocks**: place doors (lower half), beds (foot), tall plants (lower half), tall seagrass, pitcher plants,
  small dripleaf — the engine adds the other half. Keep the second cell free.
- **Support (vanilla canSurvive)** is checked on flush; unsupported blocks are dropped and listed in the
  `physics:` line (`support:'warn'` keeps them). Needs: `vine` a full face on each true side or the same face on
  a vine above; `glow_lichen`/`sculk_vein` faces are trimmed to supported sides; wall torches, ladders,
  `tripwire_hook`, buttons/levers (`face=wall`), amethyst buds and wall corals a full face behind; wall signs/
  banners any solid block behind; `torch`, `lantern`, candles a full block or a post (fence, wall, chain, rod,
  top slab — not a bottom slab, chest or lantern) below; `lantern[hanging=true]`, hanging signs a block/chain
  above; flowers, grass, saplings, bushes dirt-like ground (`grass_block`, `dirt`, `moss_block`, `mud`,
  `farmland`; dead bush/dry grass also sand/terracotta; crops `farmland`; `cactus` sand and no solid side
  neighbours; `sugar_cane` water next to its base); carpets anything below; rails, pressure plates, redstone,
  doors a solid floor; `lily_pad` water; `cocoa` a jungle log. Removing a support also drops what hung on it.

## Stairs  `*_stairs[facing, half, shape, waterlogged]`
- `facing` = the side of the **tall back** of the step = the direction you walk *up*. Roof slope on the front (+z)
  side of a ridge running along x → `facing=north`; slope on the back side → `facing=south`; east slope of a ridge
  along z → `facing=west`.
- `half=top` = upside down (flat bottom face is at the top). Eave brackets / soffits: `half=top`, facing **toward the
  wall** (the filled lower quarter sits against the wall, the open side faces out).
- Chairs: `half=bottom`; the backrest is on the `facing` side, the sitter looks the opposite way. Chair on the
  table's south side, sitter looking north at the table → `facing=south`.
- Window sill: `half=top` stair facing into the wall under the window.
- Arch shoulders: `half=top` stairs in the top corners of an opening, each facing toward its jamb (outward from the
  opening's center) — the solid lower quarter sits against the jamb, the curve opens toward the middle.
- Shape (inner/outer corners) is automatic.

## Slabs `*_slab[type=bottom|top|double]`
Bottom = lower half (default). Top = upper half (ceilings, sills, smooth eaves). Double = full block of the slab
material (use for e.g. `smooth_stone_slab[type=double]` texture). 26.3 adds concrete and wool slabs/stairs
(e.g. `white_concrete_slab`, `red_wool_stairs`).

## Axis blocks `[axis=x|y|z]`
Logs, wood, stripped variants, stems/hyphae, `bamboo_block`, `basalt`, `polished_basalt`, `quartz_pillar`,
`purpur_pillar`, `bone_block`, `hay_block`, `deepslate`, froglights, `iron_chain`, `creaking_heart`.
y = vertical post, x = beam running east–west, z = beam running north–south. Horizontal beams at floor/eave lines
are the cheapest big upgrade to any facade. `*_wood` = bark on all 6 faces (use for corner posts and tree trunks).

## Doors `*_door[facing, half, hinge, open]`
- Place the lower half only. `facing` = direction a person looks when walking **in** from the front.
  Front entrance on the +z facade → `facing=north`. Door panel is flush with the side it was entered from.
- Double door: two doors, same facing, hinges opposite (`hinge=left` + `hinge=right`) so they open outward from
  the middle. Doors are 1 wide; a "3-wide gate" = door pair + framed arch, or open fence gates/trapdoors.

## Trapdoors `*_trapdoor[facing, half, open]`
- Closed: thin plate at the bottom (`half=bottom`) or top (`half=top`) of the cell — floor panels, table tops,
  ceiling panels, mini-steps.
- **Open**: vertical plate hugging the side of the cell **opposite** to `facing` (facing points away from the
  surface it lies on). Shutters on a +z facade, placed in the air cells left/right of the window in front of the
  wall → `open=true,facing=south`. Inside a cell against a wall to the north → `facing=south`.
- Uses: shutters, flower boxes, panelling, chair arms, cabinet doors, roof eave trim, railings, corbels.

## Fence gates `*_fence_gate[facing, in_wall, open]`
Gate spans perpendicular to `facing`: in a fence line running along x use `facing=north` or `south`.
`in_wall` is automatic next to walls. Open gates look like decorative brackets.

## Walls / fences / panes / bars
Just place the id (connections automatic). Walls get a raised post (`up=true`) at ends, corners and when something
sits on top. Fence + carpet/pressure plate on top = table; fence posts carry lanterns.

## Beds `*_bed[facing, part]` (also `straw_bed` in 26.3)
Place the foot (`part=foot`, default). `facing` points from foot to head; the head goes 1 block in that direction.
Headboard against the north wall → `facing=north`, foot cell one block south of the wall cell.

## Wall-attached blocks — facing points AWAY from the support (the direction the front faces)
`wall_torch`, `soul_wall_torch`, `copper_wall_torch`, `redstone_wall_torch`, `ladder`, `*_wall_sign`,
`*_wall_banner`, `*_wall_skull`/`*_wall_head`, `*_coral_wall_fan`, `tripwire_hook`, buttons/levers/grindstone
with `face=wall`. A torch on a wall north of it → `wall_torch[facing=south]`.
**Exception:** `cocoa[facing]` points *toward* its jungle log.
`*_wall_hanging_sign[facing]`: the board sticks out from the wall perpendicular to it; `facing` must be
**parallel to the wall** (e.g. wall along x → `facing=east|west`); text reads along the street.

## Directional "points-to" blocks (facing = the direction the tip points)
`end_rod`, `lightning_rod` (and copper variants), `amethyst_cluster`, `large_amethyst_bud`, `medium_amethyst_bud`,
`small_amethyst_bud`, `barrel` (up = lid on top, sideways = barrel rack), `shulker_box`, `dispenser`, `observer`
(face points to `facing`). Stalactite-style decoration: end rods `facing=down` under a ceiling.

## Lights
- `lantern[hanging=true]` / `soul_lantern` / `copper_lantern` (and waxed variants): hanging=true under a ceiling or
  `iron_chain[axis=y]` (26.3 name — plain `chain` no longer exists; copper chains: `copper_chain`,
  `waxed_copper_chain`, …). hanging=false standing on a block, fence post, or wall.
- Candles: `candle`/`<color>_candle[candles=1..4,lit=true]` — lit is false by default! Clusters of 2–4. Not lit
  when waterlogged. `candle_cake[lit=true]`.
- `campfire[lit=true,signal_fire=false]` (lit by default). signal_fire=true → tall smoke (chimneys). Burns
  entities standing on it; put it under a slab/trapdoor in a hearth or chimney top. `soul_campfire` = blue.
- Steady always-on: `sea_lantern`, `glowstone`, `shroomlight`, froglights (`ochre_froglight`, `verdant_froglight`,
  `pearlescent_froglight`, axis), `jack_o_lantern`, `end_rod`, `beacon`, `conduit`, `magma_block` (dim),
  `glow_lichen` (dim, 7), `sea_pickle[pickles=4,waterlogged=true]` (only glows waterlogged), `cave_vines[berries=true]`.
- `copper_bulb[lit=true]` (and waxed/oxidized variants) **stays lit** without power — the best switchable-look lamp.
  Oxidation dims it (15/12/8/4); use `waxed_copper_bulb[lit=true]`.
- `redstone_lamp[lit=true]` turns OFF at the next block update unless powered — put a hidden `redstone_block`
  next to it, or prefer copper bulbs/froglights.
- `light[level=0..15]` is an invisible light source: last resort for dark corners (it shows nothing in renders).

## Leaves & plants
- Leaves: ALWAYS `persistent=true` (e.g. `oak_leaves[persistent=true]`), else they decay. Leaf ids: oak, spruce,
  birch, jungle, acacia, dark_oak, mangrove, cherry, azalea, flowering_azalea, pale_oak, plus 26.3
  `orange_poplar_leaves`, `red_poplar_leaves`, `yellow_poplar_leaves` (autumn colors!).
- Ground cover with `facing` + amount 1–4: `pink_petals[flower_amount]`, `wildflowers[flower_amount]`,
  `leaf_litter[segment_amount]`. Vary facing and amount randomly.
- Grass: `short_grass` (not "grass"), `tall_grass` (double), `fern`, `large_fern`, `short_dry_grass`,
  `tall_dry_grass`, `bush`, `firefly_bush` (glowing particles at night), `dead_bush`.
- Crops (on `farmland[moisture=7]`): `wheat[age=7]`, `carrots[age=7]`, `potatoes[age=7]`, `beetroots[age=3]`,
  `sweet_berry_bush[age=3]`, `cocoa[age=2]`, `nether_wart[age=3]`.
- Bamboo stalk: base `bamboo[leaves=none]`, middle `leaves=small`, top 2 `leaves=large`.
- Vines: `vine[north=true]` = clinging to the block on its north side; `up=true` = hanging from above.
  Multiface blocks (`glow_lichen`, `sculk_vein`, `resin_clump`) also have up/down.
- Hanging: `pale_hanging_moss[tip=true]` at the bottom end, `tip=false` above; weeping vines: body
  `weeping_vines_plant`, tip `weeping_vines`; twisting vines grow up (body `twisting_vines_plant`); cave vines body
  `cave_vines_plant`, tip `cave_vines`; `hanging_roots`, `spore_blossom` under ceilings.
- Big dripleaf: `big_dripleaf_stem` below, `big_dripleaf` on top (same facing).
- Mushroom blocks: `brown_mushroom_block`, `red_mushroom_block`, `mushroom_stem` have 6 face props (true = cap/skin
  texture). Defaults (all true) are fine for giant mushrooms.

## Pointed dripstone (and 26.3 `sulfur_spike`, same props)
Stalactite (hanging): `vertical_direction=down`; from the ceiling down: `thickness=base`, `middle` (repeat),
`frustum`, `tip`. Stalagmite: `vertical_direction=up`, same order from the floor up. Length 1 = `tip`. Where a
stalactite tip meets a stalagmite tip: both `tip_merge`.

## Water, lava & waterlogging
- Source block: `water` (level=0). Contain all water/lava completely (in the real game it flows once updated).
- Underwater builds and puddle details: `waterlogged=true` on stairs, slabs, walls, fences, panes, bars, trapdoors,
  signs, lanterns, chains, ladders, leaves, coral, sea pickles, lightning rods, copper grates, candles (unlit),
  heavy core, dripleaf, mangrove roots/propagule, glow lichen, hanging roots.
- Living coral needs water (waterlogged=true / in water); dry decorative coral → `dead_*` variants.
- Bubble columns: `magma_block` (down) / `soul_sand` (up) under water; the engine/game forms `bubble_column`.
- Lava only inside stone/obsidian/glass basins; never next to wood or wool (fire spread in the real game).

## Snow & ice
`snow[layers=1..8]` (8 ≈ full block). `grass_block[snowy=true]` under snow. `powder_snow` traps players — avoid on
paths. `ice` melts near light in the real world; use `packed_ice`/`blue_ice` for permanent ice.

## Copper (oxidation)
Stages: (none) → `exposed_` → `weathered_` → `oxidized_` (orange → green). Base names: `copper_block`,
`cut_copper` (+ `_stairs`/`_slab`), `chiseled_copper`, `copper_grate`, `copper_bulb`, `copper_door`,
`copper_trapdoor`, `copper_bars`, `copper_chain`, `copper_lantern`, `copper_chest`, `copper_golem_statue`,
`lightning_rod` (`exposed_lightning_rod` …). Always use the **`waxed_` prefix** (e.g. `waxed_oxidized_cut_copper_stairs`,
`waxed_copper_block`) so the chosen color never changes. Mix stages for weathered realism.
`copper_golem_statue[copper_golem_pose=standing|sitting|running|star,facing]` is a great decorative statue.
`copper_torch` / `copper_wall_torch` give a green flame.

## Mud & earth
`mud` (dark, slightly sinks), `packed_mud`, `mud_bricks` (+stairs/slab/wall), `muddy_mangrove_roots`, `rooted_dirt`,
`coarse_dirt`, `podzol`, `dirt_path` (lowered 1/16, great for roads), `moss_block`, `pale_moss_block`, `clay`.

## Storage & workstations (facing = the front/opening faces that direction)
`chest`/`trapped_chest`/`copper_chest[type=single|left|right]`: double chest = two chests, same facing; seen from the
front, the left block is `type=right` and the right block is `type=left` (the engine connects them too).
`barrel`, `furnace`/`smoker`/`blast_furnace[lit=true]` (lit = glowing front, purely visual), `lectern[has_book=true]`,
`loom`, `stonecutter`, `grindstone[face=floor|wall|ceiling]`, `bell[attachment=floor|ceiling|single_wall|double_wall]`,
`anvil`/`chipped_anvil`/`damaged_anvil`, `brewing_stand[has_bottle_0=true]`, `cauldron`,
`water_cauldron[level=1..3]`, `lava_cauldron`, `composter[level=0..8]`, `beehive[honey_level=0..5]`, `jukebox`.
- `chiseled_bookshelf[facing,slot_0_occupied..slot_5_occupied]`: the slot props alone render books — randomize them
  for a lived-in library (no NBT needed).
- Shelves (26.x): `oak_shelf` … `poplar_shelf`, `crimson_shelf`, `warped_shelf`, `bamboo_shelf`
  `[facing,powered,side_chain,waterlogged]`; facing = toward the room; `side_chain` connects automatically.
  Contents (3 slots): `oak_shelf[facing=south]{Items:[{Slot:0b,id:"minecraft:book",count:1},{Slot:2b,id:"minecraft:lantern",count:1}]}`.
- `decorated_pot[facing,cracked]` — 26.3 sherd SNBT (per-side object):
  `decorated_pot[facing=south]{sherds:{front:"minecraft:heart_pottery_sherd",left:"minecraft:brick",right:"minecraft:brick",back:"minecraft:flow_pottery_sherd"}}`.
  Sherd item ids: angler, archer, arms_up, blade, brewer, burn, danger, explorer, flow, friend, guster, heart,
  heartbreak, howl, miner, mourner, plenty, prize, scrape, sheaf, shelter, skull, snort (+ `_pottery_sherd`).
  A plain pot (no NBT) is already a great amphora.
- Flower pots: use the `potted_*` blocks directly (`potted_poppy`, `potted_fern`, `potted_bamboo`, `potted_cactus`,
  `potted_azalea_bush`, `potted_flowering_azalea_bush`, `potted_cherry_sapling`, `potted_red_mushroom`,
  `potted_crimson_fungus`, `potted_torchflower`, `potted_wither_rose`, `potted_open_eyeblossom`,
  `potted_golden_dandelion`, `potted_poplar_sapling`, …). `flower_pot` = empty.

## Signs (26.x text format)
- Standing: `oak_sign[rotation=0..15]`; rotation 0 = text faces south (+z, toward the player), 4 = west,
  8 = north, 12 = east. Wall: `oak_wall_sign[facing]` (facing = where the text faces).
- Hanging: `oak_hanging_sign[attached=false,rotation=0|4|8|12]` under a block; `*_wall_hanging_sign` see above.
- SNBT (text components are NBT since 1.21.5 — plain strings or compounds, NOT JSON-in-a-string):
  `oak_wall_sign[facing=south]{front_text:{messages:["","The Prancing","Pony",""],color:"brown",has_glowing_text:1b},is_waxed:1b}`
  Styled line: `{text:"INN",color:"gold",bold:1b}` as one of the 4 messages. Always exactly 4 messages.
  `back_text` has the same shape. `is_waxed:1b` stops players from editing.

## Banners
`white_banner[rotation]` (standing) / `white_wall_banner[facing]` (16 colors). Patterns SNBT (bottom → top layer):
`red_wall_banner[facing=south]{patterns:[{pattern:"minecraft:stripe_top",color:"yellow"},{pattern:"minecraft:border",color:"black"},{pattern:"minecraft:flower",color:"yellow"}]}`
Valid patterns: base, border, bricks, circle, creeper, cross, curly_border, diagonal_left, diagonal_right,
diagonal_up_left, diagonal_up_right, flow, flower, globe, gradient, gradient_up, guster, half_horizontal,
half_horizontal_bottom, half_vertical, half_vertical_right, mojang, piglin, rhombus, skull, small_stripes,
square_bottom_left, square_bottom_right, square_top_left, square_top_right, straight_cross, stripe_bottom,
stripe_center, stripe_downleft, stripe_downright, stripe_left, stripe_middle, stripe_right, stripe_top,
triangle_bottom, triangle_top, triangles_bottom, triangles_top (prefix `minecraft:`). Colors: dye names.
Max 6 layers look good; 2–3 is usually best. Banners on walls flanking gates, hanging in halls, on market stalls.

## Heads
`skeleton_skull`, `wither_skeleton_skull`, `zombie_head`, `creeper_head`, `piglin_head`, `dragon_head`, `player_head`
with `[rotation]`, wall variants `*_wall_skull`/`*_wall_head[facing]`. A dragon head on a gable = viking ship prow.

## Glazed terracotta
`[facing]` rotates the motif. Four in a 2×2 with facings north/east/south/west (clockwise) make rosettes/medallions.

## Entities (only via a command/summon capability if the toolset offers one; world coordinates!)
Commands are not rotated by the engine — convert local → world yourself using get_context's frame.
- Item frame: `summon item_frame X Y Z {Facing:3b,Item:{id:"minecraft:compass",count:1},Fixed:1b}` (`glow_item_frame`
  too). Facing byte: 0 down, 1 up, 2 north, 3 south, 4 west, 5 east = direction it faces (away from the wall);
  X Y Z = the air cell in front of the wall. `Invisible:1b` hides the frame (floating item on a wall/shelf).
- Painting: `summon painting X Y Z {facing:2b,variant:"minecraft:wanderer"}` (facing byte: 0 south, 1 west, 2 north,
  3 east). Variants: alban, aztec, aztec2, backyard, baroque, bomb, bouquet, burning_skull, bust, cavebird, changing,
  cotan, courbet, creebet, dennis, donkey_kong, earth, endboss, fern, fighters, finding, fire, graham, humble, kebab,
  lowmist, match, meditative, orb, owlemons, passage, pigscene, plant, pointer, pond, pool, prairie_ride, sea,
  skeleton, skull_and_roses, stage, sunflowers, sunset, tides, unpacked, void, wanderer, wasteland, water, wind, wither.
- Armor stand (1.21.5+ `equipment` map): `summon armor_stand X Y Z {ShowArms:1b,NoBasePlate:1b,Rotation:[180f,0f],equipment:{head:{id:"minecraft:iron_helmet",count:1},chest:{id:"minecraft:iron_chestplate",count:1},mainhand:{id:"minecraft:iron_sword",count:1}},Pose:{RightArm:[-30f,0f,0f]}}`
  Rotation yaw: 0 = faces south, 90 = west, 180 = north, 270 = east. Slots: head, chest, legs, feet, mainhand, offhand.
- Block display (sub-block detail, scaled/rotated blocks):
  `summon block_display X Y Z {block_state:{Name:"minecraft:oak_trapdoor",Properties:{open:"true"}},transformation:{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],translation:[0f,0f,0f],scale:[0.5f,0.5f,0.5f]}}`
  `text_display`: `{text:{text:"Welcome",color:"gold"},billboard:"center"}`.
- Renders may not show entities — verify placement with the command output.
<!-- validate-ignore: chain id -->
