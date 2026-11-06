# Steampunk

Victorian industry with brass and copper: riveted plates, pipes, chimneys, clock towers, gears, airships and smoke. Pick it for workshops, factories, airship docks, inventor towers, rail stations, sky cities. Reference: Bioshock Infinite, Howl's castle, Mortal Engines.

## Signature features
- Copper in all oxidation stages (waxed!) as the "brass": domes, roofs, pipes, trims.
- Brick and dark wood Victorian base, tall windows, mansard roofs.
- **Pipes and chimneys everywhere**, with smoke (campfires) and steam (water/cauldrons).
- Mechanical ornament: big clock faces, gear motifs, pistons, rivets, chains.
- Vertical, top-heavy, cluttered silhouettes — towers with balconies, gantries, cranes.
- Airships, balloons, rails and gondolas linking buildings.

## Proportions & massing
- Storeys 5 high; ground floor 6 for workshops with large arched doors.
- Buildings tall and narrow (7×9 base, 4–6 storeys) with overhanging upper decks and bay windows.
- Chimneys 2×2–3×3, rising 6–12 above the roof, banded with copper every 3 blocks.
- Clock tower: 7×7 or 9×9, clock face 7×7 at 2/3 height, copper dome or spire on top.
- Airship: balloon (ellipsoid, length ≈ 2.5× diameter) above a gondola 1/2 its length, hung on `iron_chain`.

## Palette
| Role | Blocks |
|---|---|
| primary | `bricks`, `waxed_cut_copper`, `waxed_exposed_cut_copper`, `dark_oak_planks`, `mud_bricks` |
| secondary | `dark_oak_log`, `stripped_dark_oak_log`, `polished_blackstone`, `polished_blackstone_bricks` |
| accent | `waxed_copper_block`, `waxed_weathered_cut_copper`, `waxed_oxidized_cut_copper`, `gold_block`, `brown_terracotta`, `waxed_chiseled_copper` |
| roof | `waxed_exposed_cut_copper_stairs`, `waxed_exposed_cut_copper_slab`, `waxed_weathered_cut_copper_stairs`, `dark_oak_stairs`, `deepslate_tile_stairs` |
| trim | `waxed_copper_grate`, `waxed_copper_bars`, `iron_trapdoor`, `waxed_copper_trapdoor`, `polished_blackstone_wall`, `lightning_rod`, `iron_chain` |
| glass | `orange_stained_glass_pane`, `brown_stained_glass_pane`, `glass_pane` |
| light | `waxed_copper_lantern[hanging=true]`, `waxed_copper_bulb[lit=true]`, `lantern`, `redstone_lamp[lit=true]` |
| details | `cauldron`, `blast_furnace`, `smoker`, `piston`, `observer`, `anvil`, `campfire`, `waxed_copper_chain`, `hopper`, `barrel`, `grindstone`, `bell` |
| ground/foliage | `polished_blackstone`, `cobbled_deepslate`, `bricks`, `gravel`, `vine`, `fern` |

Mixes: copper `40%waxed_cut_copper,30%waxed_exposed_cut_copper,20%waxed_weathered_cut_copper,10%waxed_oxidized_cut_copper` · brick `70%bricks,20%mud_bricks,10%packed_mud` · street `50%polished_blackstone,30%cobbled_deepslate,20%gravel`.

## Walls recipe
1. Base: `polished_blackstone_bricks` plinth 2 high, projecting 1 block, capped with `polished_blackstone_brick_stairs` (facing toward the wall).
2. Main field in the brick mix, framed by `stripped_dark_oak_log` corner posts or copper pilasters (`waxed_cut_copper` + `waxed_copper_grate` stacks) standing 1 block proud.
3. Floor bands: `waxed_cut_copper_slab`/`waxed_copper_grate` belt course at each floor line (rivets: `iron_trapdoor`/`stone_button` dots on copper).
4. Pipes run vertically on the facade, 1 block in front, `waxed_copper_grate` or `waxed_copper_block` with `iron_trapdoor` clamps every 3 blocks; bend them with `waxed_cut_copper_stairs`.
5. Upper storeys overhang on `dark_oak_stairs[half=top]` brackets facing toward the wall.

## Roof recipe
- Mansard: steep lower slope (stairs stacked on full blocks, nearly vertical) in `waxed_exposed_cut_copper_stairs`, shallow top deck with a `waxed_copper_bars` railing; dormers in the steep slope.
- Domes and onion caps in the copper mix (oxidized at the top, fresh at the bottom = gradient along y).
- Ridge cresting: `waxed_copper_bars` or `iron_bars` along the ridge, `lightning_rod` finials.
- Chimney stacks clustered in 2–4, topped with `campfire` (lit) for smoke; signal smoke with `hay_block` under the campfire.

## Windows & doors
- Tall arched windows 1×3 or 2×4, `orange_stained_glass_pane` (warm interior glow), frames of `waxed_cut_copper` and an arched top of stairs.
- Round porthole windows (3×3 with slab/stair corners) on towers and airships.
- Big round clock window: 7×7 ring of `waxed_cut_copper` with `glass` center and `iron_bars` hands.
- Doors: double `dark_oak_door` or `waxed_copper_door` in a brick arch; workshop doors 3×4 made of `iron_trapdoor` panels.

## Signature details
- Gear: run_script a ring (radius 3–6) of `waxed_copper_block` with tooth bumps every 2 blocks, a hub of `waxed_chiseled_copper`; mount on walls, half-embedded.
- Clock face: `smooth_quartz` disk, hour marks of `iron_trapdoor`/`waxed_copper_trapdoor`, hands of `iron_chain` (axis x/z) or `iron_bars`.
- Airship: balloon of `brown_wool` + `white_wool` stripes with `waxed_cut_copper` ribs, `iron_chain` rigging, gondola of `dark_oak_planks` with `waxed_copper_grate` engines and `campfire` exhaust.
- Steam vent: `campfire` under `iron_trapdoor` grates in the street, or a `water_cauldron[level=3]` next to a `blast_furnace`.
- Boiler room: `blast_furnace` wall, `cauldron`s, `piston`s, `observer`s, pipes, `redstone_lamp[lit=true]` indicators.

## Layout ideas
- Sky dock: platform town on a mountain top with mooring masts, two airships, gantries, a clock tower focal point.
- Factory district: 2–3 brick halls with saw-tooth roofs, chimney cluster, rail line on a `dark_oak_log` trestle, water tower.
- Inventor's tower: narrow 9×9 tower, 6 storeys, balconies on every 2nd floor, a telescope/dome on top, crane arm.

## Avoid
- Unwaxed copper (it oxidizes in survival worlds and changes the palette).
- Copper only in one shade — use the full oxidation gradient.
- Clean, sparse facades; steampunk needs layered clutter (but organized along floor bands and pipes).
- Smoke-less chimneys; add lit campfires.
- Modern glass walls; windows are framed, arched, Victorian.
