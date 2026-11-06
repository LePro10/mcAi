# Cozy Cottage-core

Storybook cottages swallowed by gardens: crooked roofs, round doors, flower boxes, climbing roses, beehives and warm window light (Cotswolds, Shire hobbit holes, Ghibli countryside). Pick for "cozy", "cute", "cottage", "hobbit", "witch house", "fairy", "small house".

## Signature features
- Small, asymmetric, slightly crooked masses — a main body plus bump-outs, bay windows and a lean-to.
- Steep oversized roofs (often sweeping almost to the ground), chunky chimney, moss on the roof.
- Plants everywhere: flower boxes, climbing vines, overflowing gardens, bushes against the walls.
- Warm materials: plaster, timber, mossy cobblestone, brick chimneys; warm light from every window.
- Lived-in clutter: firewood, baskets, pots, a bench, a laundry line, a garden path.

## Proportions & massing
- Footprint 7×9 to 11×13 for the main body; side wings 5×5. Wall height only 3–4 (cozy, low eaves); roof height ≥ 1.2× wall height, pitch 45°–60°.
- Eaves overhang 1; gables overhang 1 with trim.
- Chimney 2×2 or 1×2 rising 2–3 above the ridge, slightly offset from center.
- Hobbit holes: round door diameter 3–5 set into a hillside, earth dome with grass and flowers on top.

## Palette
| Role | Blocks |
|---|---|
| primary | `white_terracotta`, `calcite`, `oak_planks`, `birch_planks` |
| secondary | `stripped_oak_log`, `oak_log`, `spruce_log`, `stripped_spruce_log` |
| accent | `mud_bricks`, `bricks`, `moss_block`, `pink_terracotta` |
| roof | `spruce_stairs`, `spruce_slab`, `mangrove_stairs`, `mangrove_slab`, `dark_oak_stairs`, `moss_carpet` |
| trim | `oak_fence`, `spruce_trapdoor`, `oak_trapdoor`, `stripped_oak_wood`, `birch_fence` |
| glass | `glass_pane`, `white_stained_glass_pane` |
| light | `lantern`, `candle[lit=true]`, `campfire`, `firefly_bush` |
| details | `flower_pot`, `potted_poppy`, `potted_azure_bluet`, `beehive`, `composter`, `barrel`, `decorated_pot`, `white_carpet`, `oak_shelf`, `chiseled_bookshelf` |
| ground / foliage | `grass_block`, `moss_block`, `dirt_path`, `coarse_dirt`, `rooted_dirt`, `flowering_azalea_leaves`, `azalea_leaves`, `pink_petals`, `wildflowers`, `leaf_litter`, `bush`, `rose_bush`, `peony`, `lilac`, `sweet_berry_bush` |

Mixes: foundation `50%cobblestone,35%mossy_cobblestone,15%stone`; plaster `75%white_terracotta,25%calcite`; mossy roof skin `80%spruce_stairs,20%mangrove_stairs` (same facing/half) with `moss_carpet` patches on top; garden fill `35%short_grass,15%wildflowers,10%poppy,10%azure_bluet,10%oxeye_daisy,10%cornflower,10%air`.

## Walls recipe
1. Foundation 1–2 courses of the foundation mix, bulging 1 out at corners.
2. Timber frame: `stripped_oak_log` posts at corners and every 3–4, a beam at the floor line; occasional diagonal brace with stairs.
3. Plaster infill 1 behind the frame (`white_terracotta`/`calcite` mix), or `oak_planks` for the ground floor.
4. Upper floor (if any) jetties out 1 over the ground floor on `spruce_stairs[half=top]` corbels facing toward the wall.
5. Soften: `bush`, `azalea_leaves[persistent=true]` and `rose_bush` against the base, `vine` on one corner.

## Roof recipe
- Steep gable with cross-gables and dormers; stairs facing toward the ridge, ridge `spruce_slab`.
- Sag/crooked feel: make one slope 1 longer, drop the eave 1 on one side, offset dormers.
- Eaves: `spruce_stairs[half=top]` facing toward the wall under the edge, `spruce_trapdoor` fascia on gables.
- Moss: 15–25% `moss_carpet` on top of roof stairs (on the shady side), `vine` hanging from eaves in a few spots.
- Chimney: `bricks`/`mud_bricks` mix with `stone_brick_slab` cap, `campfire` inside for smoke (signal_fire for taller smoke).

## Windows & doors
- Small 1×2 or 2×2 panes set 1 deep with `spruce_trapdoor` shutters open against the wall, flower box below: `spruce_trapdoor[half=top]` (open=false) under the window, flowers or `flowering_azalea_leaves[persistent=true]` set on the block row in front.
- Bay window: 3-wide bump-out with a `spruce_slab` roof and glass on 3 sides.
- Round door (hobbit): circle frame of `stripped_oak_wood`, `spruce_door` pair or `green_concrete`/`oak_trapdoor` center; ordinary cottages use `spruce_door` under a small stair canopy.

## Signature details
- Flower boxes under every window (different flower per window).
- Garden: picket fence (`birch_fence`), arch over the gate with `vine`/`flowering_azalea_leaves`, cottage garden bed in the garden mix, stepping-stone path of `dirt_path` and moss.
- Apiary corner: `beehive` on a stump, `sunflower` and `peony` around.
- Firewood stack: `stripped_oak_log[axis=x]` against a wall under a `spruce_slab` lean-to, a chopping block (`oak_log`) beside it.
- Interior: hearth, `oak_shelf` with items, `chiseled_bookshelf`, `candle[lit=true]` clusters, rugs of `white_carpet`/`pink_carpet`, `red_bed` with a carpet at its foot.

## Layout ideas
- Single cottage (25×25 plot): cottage off-center, garden in front, veg patch + beehives behind, well, winding path to the gate, 2 trees.
- Hobbit hillside (40×30): 3 round doors in an earth mound, chimneys poking through the grass, terraced gardens.
- Witch's cottage: dark variant with `dark_oak_log` timbers, `pale_hanging_moss`, cauldron, mushrooms and `candle` clusters in a misty swamp.

## Avoid
- Perfect symmetry and straight lines: cozy means slightly irregular.
- Big windows and tall walls (looks like a suburban house).
- Bare ground around the house: plants must hug the walls and fill the garden.
- Flat-roofed bump-outs; give every wing its own pitched roof.
