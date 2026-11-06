# Tropical / Beach

Bamboo stilt huts, tiki bars, overwater bungalows, palm-lined beaches and jungle lodges (Bali, Polynesia, Maldives). Pick for beaches, jungles, islands, "resort", "tiki", "pirate cove", "treehouse".

## Signature features
- Raised on stilts or piers over sand/water; open sides, deep shade, airflow.
- Thatched roofs: steep, oversized, with dramatic overhangs and peaked ridges (Polynesian "A" or Balinese tiered).
- Bamboo and jungle wood everywhere; rope (fences, chains), lanterns and torches.
- Decks, boardwalks, hammocks, docks, overwater walkways.
- Lush planting: palms, ferns, big leaves, flowers; turquoise shallow water.

## Proportions & massing
- Stilts 2–4 tall (`jungle_log` or `stripped_bamboo_block`), deck 1 thick of planks + slab edge.
- Huts 5×5 to 9×7, wall height 3; roof is the dominant mass: roof height ≥ wall height, pitch 45°–60° (1:1 or 2 up per 1 in).
- Overhang 2 on all sides; roof footprint 1.5× the hut.
- Boardwalks 3 wide, with posts every 4.

## Palette
| Role | Blocks |
|---|---|
| primary | `bamboo_planks`, `bamboo_block`, `stripped_bamboo_block`, `jungle_planks` |
| secondary | `jungle_log`, `stripped_jungle_log`, `birch_log`, `bamboo_mosaic` |
| accent | `light_blue_terracotta`, `lime_terracotta`, `orange_terracotta`, `yellow_wool`, `cyan_wool` |
| roof | `bamboo_mosaic_stairs`, `bamboo_mosaic_slab`, `hay_block`, `jungle_stairs`, `jungle_slab`, `dried_kelp_block` |
| trim | `bamboo_fence`, `jungle_fence`, `bamboo_trapdoor`, `jungle_trapdoor`, `iron_chain` |
| glass | `glass_pane` (rarely; mostly open) |
| light | `lantern`, `campfire`, `torch`, `sea_pickle`, `ochre_froglight` |
| details | `sea_pickle`, `brain_coral`, `tube_coral_fan`, `melon`, `bamboo`, `sugar_cane`, `lily_pad`, `orange_tulip`, `barrel`, `white_wool_slab`, `decorated_pot` |
| ground / foliage | `sand`, `sandstone`, `grass_block`, `coarse_dirt`, `jungle_leaves`, `acacia_leaves`, `fern`, `large_fern`, `bush`, `firefly_bush` |

Mixes: deck `70%bamboo_planks,30%stripped_bamboo_block`; thatch `60%hay_block,40%bamboo_mosaic`; beach `75%sand,15%sandstone,10%gravel`.

## Walls recipe
1. Frame: corner posts `jungle_log`, top plate `stripped_bamboo_block` horizontally (axis along the wall).
2. Infill: `bamboo_block` vertical (axis=y), or woven look with alternating `bamboo_planks`/`bamboo_mosaic`; walls often half-height (railing of `bamboo_fence`) for open pavilions.
3. Set infill 1 behind the posts for depth; window holes framed by `bamboo_trapdoor` shutters.
4. Under the deck: cross-bracing with `bamboo_fence` diagonals reads as lashed construction.

## Roof recipe
- Thatch body in the thatch mix as full blocks, then skin the outer surface with `bamboo_mosaic_stairs` (facing toward the ridge) so the slope is smooth.
- Eaves: last row is `bamboo_mosaic_slab` hanging 2 past the wall, with a `jungle_trapdoor` fringe along the edge.
- Ridge: `bamboo_mosaic_slab` cap; Polynesian peaks extend the ridge beyond the gables by 1–2 with an upturned `jungle_stairs[half=top]` at each end.
- Balinese tiered: 2–3 stacked hip roofs each 2 smaller, `dried_kelp_block` for dark thatch accents.

## Windows & doors
- Mostly open; openings 2–3 wide with `bamboo_trapdoor` awnings propped (open, half=top) above.
- Doors: `bamboo_door` or a curtain of `white_wool_slab`/open frame.

## Signature details
- Palm tree: leaning curved `stripped_jungle_log` trunk 6–10 tall (shift 1 sideways every 2–3), crown of 6–8 drooping arms of `jungle_leaves[persistent=true]`, `cocoa` coconuts under the crown.
- Tiki bar: counter of `stripped_bamboo_block` + `bamboo_slab` top, `barrel` and `melon` behind, torches on `bamboo_fence` posts, hanging `lantern[hanging=true]`.
- Overwater bungalow: hut on 3-tall posts over 2-deep `water`, glass-floor panel (`glass`) to see the reef, ladder `ladder` into the water.
- Hammock: `white_wool_slab` or `orange_wool_slab` sagging between two palms with `iron_chain` ends.
- Reef: patches of coral, `sea_pickle[pickles=4]` (waterlogged) for light, `seagrass` and `kelp`.

## Layout ideas
- Resort (60×40): curved beach, 5 overwater bungalows on a branching boardwalk, central tiki bar, pool with lounge chairs (stairs + slabs), palm groves.
- Jungle lodge (31×31): main longhouse on stilts linked by rope bridges (`bamboo_fence` rails, slab walkway) to 3 tree platforms.
- Fishing village: 6 stilt huts along a lagoon, drying racks, docks with boats (`oak_slab`/stairs hulls).

## Avoid
- Thin flat roofs: the roof must be big and steep.
- Over-straight palms; bend and lean them, vary heights.
- Building flush on the sand: lift everything onto stilts or a 1-block sandstone plinth.
- Placing coral above water (dies) — use `dead_brain_coral_block` etc. for dry decor.
