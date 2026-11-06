# Medieval (timber-frame village)

Half-timbered houses on stone plinths, steep dark roofs, jettied upper floors, chimneys and smoke. Pick it for villages, taverns, markets, farms-with-character, "cozy old town". Reference: Tudor/Fachwerk towns, Conquest-style servers.

## Signature features
- Stone ground floor (plinth), timber-framed upper floors that **jetty out 1 block** over the street.
- Log frame on the outer plane, light plaster infill recessed 1 block behind it.
- Steep roofs (45° or steeper), deep 1–2 block overhangs, cross-gables and dormers.
- Brick or cobble chimney poking through the ridge, often off-centre.
- Irregularity: no two houses the same height, slight wonky rooflines, lean-tos, sheds, add-ons.
- Small inset windows with trapdoor shutters and flower boxes.
- Crowded street life: stalls, barrels, signs, hanging lanterns, laundry lines.

## Proportions & massing
- Storey height 4 (3 air + 1 floor beam); ground floor 4–5 for shops/taverns.
- Footprints 7×9, 9×11, 7×13 (odd widths so the door and ridge can sit on a centreline).
- Jetty: each upper floor overhangs 1 block on the street side (max 2 storeys of jetty).
- Roof: gable on the long axis, pitch 1:1 (stairs) or steeper with stacked full-height stairs+slabs; total roof height ≈ 0.6–0.8 × building width.
- Mix 1-, 2- and 3-storey buildings; a tavern or guildhall 1.5× larger as the focal point.

## Palette
| Role | Blocks |
|---|---|
| primary (infill) | `calcite`, `white_terracotta`, `smooth_sandstone` (warm plaster), `mud_bricks` (rustic) |
| secondary (frame) | `spruce_log`, `stripped_spruce_log`, `dark_oak_log`, `stripped_dark_oak_log` |
| foundation | `cobblestone`, `stone_bricks`, `mossy_cobblestone`, `andesite`, `tuff` |
| accent | `bricks`, `mud_bricks`, `packed_mud`, `spruce_planks` |
| roof | `dark_oak_stairs`, `dark_oak_slab`, `spruce_stairs`, `spruce_slab`, `deepslate_tile_stairs` |
| trim | `spruce_trapdoor`, `spruce_fence`, `stone_brick_wall`, `cobblestone_wall`, `spruce_planks` |
| glass | `glass_pane`, `brown_stained_glass_pane` |
| light | `lantern`, `lantern[hanging=true]`, `wall_torch`, `campfire` |
| details | `barrel`, `hay_block`, `composter`, `cauldron`, `grindstone`, `iron_chain`, `flower_pot`, `red_banner`, `spruce_fence_gate` |
| ground/foliage | `dirt_path`, `coarse_dirt`, `gravel`, `packed_mud`, `oak_leaves`, `fern`, `poppy`, `dandelion` |

Mixes: plinth `45%cobblestone,25%stone_bricks,15%mossy_cobblestone,10%andesite,5%tuff` · infill `70%calcite,20%white_terracotta,10%smooth_sandstone` · street `50%dirt_path,25%coarse_dirt,15%gravel,10%packed_mud`.

## Walls recipe
1. Plinth: ground floor in the plinth mix, 1 block thicker than the wall above or with a `stone_brick_stairs` skirting course (half=bottom, facing toward the wall) at the base.
2. Frame (outer plane, z = facade): vertical `stripped_spruce_log` (axis=y) at corners and every 3–4 blocks; horizontal beams (axis=x or z along the wall) at each floor line — these beams carry the jetty.
3. Infill: plaster mix **1 block behind** the frame plane. Optional diagonal braces of `spruce_stairs`/`spruce_slab` in some panels (not all — vary).
4. Jetty: upper floor's frame plane = 1 block in front of the ground floor; underneath, `spruce_stairs[half=top]` brackets facing toward the wall at each post.
5. Corners: always log, never plaster; corner posts may run full height.

## Roof recipe
- Gable on the long axis, stairs facing toward the ridge (the high side) on each slope; ridge capped with `dark_oak_slab` (type=bottom) or a row of upside-down stairs.
- Overhang 1 block on eaves, 1 block on gables (barge boards = `spruce_stairs` along the rake, or `spruce_trapdoor` faces).
- Under the eave: `dark_oak_stairs[half=top]` facing toward the wall to fake rafter ends.
- Gable end: frame continues into the gable triangle (log king post + plaster) — never a flat plank triangle.
- Break long roofs with a cross-gable or dormer every 6–8 blocks; a chimney (`bricks` or cobble, 2×1 or 1×1, capped with `stone_brick_wall` or a `campfire` for smoke) rising 2–3 above the ridge.
- Steeper look: alternate stairs and full blocks of a matching color (`dark_oak_planks`) in 2-up/1-over steps; finish the step edges with slabs.

## Windows & doors
- Windows 1×2 or 2×2 `glass_pane` set flush with the infill (so 1 block recessed behind the frame); sill = `spruce_trapdoor` (closed, half=top) or `spruce_slab` under it.
- Shutters: open `spruce_trapdoor` on both sides, facing away from the wall.
- Flower box: `spruce_trapdoor` closed in front + `potted_red_tulip` / `azalea` on top of a ledge, or leaves.
- Doors: `spruce_door` or `dark_oak_door`, framed by logs, with a `spruce_stairs[half=top]` lintel pair; shops get wide double doors + a `oak_hanging_sign` on a `spruce_fence` bracket.

## Signature details
- Market stall: 3×2 `spruce_fence` posts, `white_wool` + `red_wool` striped awning (wool slabs/stairs for the slope), barrels, `hay_block`, `melon`, `pumpkin` as goods.
- Well: 3×3 `cobblestone_wall` ring around water, 2 `spruce_fence` posts + `spruce_slab` roof, an `iron_chain` hanging into the shaft, a `cauldron` beside it as the bucket.
- Hanging street lights: `spruce_fence` arm out of a wall + `iron_chain` + `lantern[hanging=true]`.
- Smithy: open front, `anvil`, `grindstone`, `blast_furnace`, `lava` behind `iron_bars`, `campfire` smoke.
- Laundry line: `spruce_fence` rail between two upper windows with `white_banner`/`light_blue_banner` "sheets" hung under it (wall banners on the rail's side faces).

## Layout ideas
- Village square 25×25: well or market cross in the centre, tavern (11×13, 3 storeys) as the focal point on one side, 4–6 houses around, streets 3 wide curving out.
- Main street: 4–5 wide, houses packed shoulder to shoulder with alternating heights and gable-to-street orientation; one archway/gatehouse at the end.
- Farmstead: house 7×11 + barn 9×15 + fenced yard + crops in 9×9 plots with water lines.

## Avoid
- Plank walls with log corners and nothing else — infill must be lighter than the frame and recessed.
- Uniform houses in a grid; vary height, orientation, color of plaster.
- Shallow 1-block-tall "lid" roofs; medieval roofs are tall.
- Glowstone or sea lanterns anywhere visible.
- Perfectly straight streets; let them bend and widen into small squares.
