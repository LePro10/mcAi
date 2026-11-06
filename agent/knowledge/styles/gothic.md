# Gothic / Cathedral

Soaring verticality: pointed arches, flying buttresses, ribbed vaults, spires, rose windows and stained glass in dark stone. Pick it for cathedrals, abbeys, vampire castles, academies, haunted manors. Reference: Notre-Dame, Cologne, Sagrada (neo), Hogwarts.

## Signature features
- **Verticality**: everything points up — spires, pinnacles, tall lancet windows, steep roofs.
- Pointed arches (never round) for windows, doors and arcades.
- Buttresses and flying buttresses carrying the nave walls; pinnacles on top of each buttress.
- Rose window on the west (entrance) facade; huge stained-glass windows between buttresses.
- Ribbed vaults inside; nave flanked by lower aisles; transept forming a cross plan.
- Dark stone with deep shadows, gargoyles, iron details, candles.

## Proportions & massing
- Cross plan: nave width 11–15, length 3–5× width; aisles half the nave width and half its height; transept crossing at 2/3 of the length.
- Nave height ≈ 2.5–3× its width (e.g. 13 wide → 32–40 to the vault).
- Facade towers: 2 towers 9–11 square, 1.3–1.6× nave height, spires adding another 50–80%.
- Bays: 5–7 long, defined by buttresses; one tall window per bay.
- Buttress: 2–3 thick, steps back every 6–8 blocks; flyer arches span the aisle (5–7 blocks).
- Roof pitch ≥ 60° (steeper than 45°: stack stairs on full blocks).

## Palette
| Role | Blocks |
|---|---|
| primary | `deepslate_bricks`, `stone_bricks`, `tuff_bricks`, `polished_blackstone_bricks` |
| secondary | `polished_deepslate`, `deepslate_tiles`, `cracked_deepslate_bricks`, `chiseled_tuff_bricks`, `polished_tuff` |
| accent | `chiseled_deepslate`, `chiseled_polished_blackstone`, `gilded_blackstone`, `crying_obsidian`, `chiseled_stone_bricks` |
| roof | `deepslate_tile_stairs`, `deepslate_tile_slab`, `polished_blackstone_brick_stairs`, `dark_oak_stairs`, `waxed_oxidized_cut_copper_stairs` |
| trim | `polished_deepslate_wall`, `deepslate_brick_wall`, `deepslate_brick_stairs`, `polished_blackstone_wall`, `iron_bars`, `tuff_brick_wall` |
| glass | `purple_stained_glass_pane`, `red_stained_glass_pane`, `blue_stained_glass_pane`, `yellow_stained_glass_pane`, `magenta_stained_glass_pane`, `gray_stained_glass_pane` |
| light | `soul_lantern`, `lantern[hanging=true]`, `candle[lit=true]`, `black_candle[lit=true]`, `soul_torch` |
| details | `cobweb`, `skeleton_skull`, `iron_chain`, `lectern`, `bookshelf`, `chiseled_bookshelf`, `bell`, `black_banner`, `purple_banner`, `dark_oak_trapdoor` |
| ground/foliage | `gravel`, `cobbled_deepslate`, `coarse_dirt`, `podzol`, `dark_oak_leaves`, `dead_bush`, `wither_rose`, `pale_hanging_moss`, `pale_moss_carpet` |

Mixes: dark stone `50%deepslate_bricks,20%cracked_deepslate_bricks,20%deepslate_tiles,10%polished_deepslate` · lighter stone `55%stone_bricks,20%tuff_bricks,15%cracked_stone_bricks,10%andesite` · rose glass `30%red_stained_glass_pane,25%blue_stained_glass_pane,20%purple_stained_glass_pane,15%yellow_stained_glass_pane,10%magenta_stained_glass_pane`.

## Walls recipe
1. Plinth 2 high in `polished_deepslate`, stepping out 1 block, with a `deepslate_brick_stairs` water-table course (facing toward the wall).
2. Buttresses at every bay line: 2–3 thick, projecting 2–4 blocks, stepping back with `deepslate_brick_stairs` slopes at each set-off; topped by pinnacles (wall + `polished_deepslate_wall` + `lightning_rod` or `end_rod` tip).
3. Between buttresses: wall field recessed so the window fills most of the bay — tall pointed lancets (2–3 wide, 8–15 tall) with tracery (`polished_deepslate_wall`/`iron_bars` mullions).
4. String courses at each storey: `deepslate_tile_slab` or `deepslate_brick_stairs[half=top]`.
5. Flying buttress: an arch (shapes arch, pointed) from the pinnacle top to the nave wall just under the eave, 1–2 thick, `deepslate_brick_stairs` on its top edge.

## Roof recipe
- Very steep gable (≥ 60°): per step 2 up 1 over — full blocks of `deepslate_tiles` with `deepslate_tile_stairs` at each step edge, stairs facing toward the ridge.
- Ridge: `deepslate_tile_slab` + regularly spaced cresting (`iron_bars`, `lightning_rod`).
- Parapets with pierced tracery (`polished_deepslate_wall` alternated with air) run along the eaves, hiding the gutter.
- Crossing tower: square base, octagonal lantern, needle spire (cone, height ≥ 3× its radius), crocket bumps (`deepslate_brick_stairs`) along the spire edges.

## Windows & doors
- Pointed lancet windows: two stair diagonals meeting at the top; glass = stained panes, mullions `polished_deepslate_wall`.
- Rose window: circular, diameter 9–15, radial tracery spokes (run_script rose window recipe), set inside a pointed arch on the entrance facade (+z).
- Portal: triple deep-set pointed portals, each 3–5 wide, receding in 3–4 layers (archivolts) of alternating `polished_deepslate` and `chiseled_deepslate`; tympanum above the doors; `dark_oak_door` pairs with `iron_bars` strapwork.

## Signature details
- Gargoyles: `polished_blackstone_brick_stairs` + `skeleton_skull`/`wither_skeleton_skull` projecting from buttress tops and eaves, 1–2 blocks out.
- Ribbed vault interior: arches spanning every bay, diagonal ribs of `polished_deepslate`, infill `tuff_bricks`, `soul_lantern[hanging=true]` on long `iron_chain`s from the crossing.
- Choir: `dark_oak_stairs` pews in rows, `lectern`, altar of `chiseled_polished_blackstone` with `candle[lit=true]` clusters (candles=4).
- Graveyard: `cobblestone_wall` crosses, `coarse_dirt`/`podzol` mounds, `dead_bush`, `iron_bars` fence, dead dark oak trees, fog of `cobweb` in corners.
- Bell tower: `bell` hung from a `dark_oak_planks` beam in an open louvered belfry (`dark_oak_trapdoor` louvers).

## Layout ideas
- Cathedral: west facade with twin towers + rose window facing the player (+z), nave running −z, transept, apse with radiating chapels at the far end, cloister on one side.
- Haunted manor: asymmetric mass with one tall tower, steep roofs, pointed windows, overgrown courtyard, wrought-iron fence, dead trees.
- Abbey ruin: partial walls, collapsed vault, columns standing alone, moss and vines reclaiming it, cracked block variants dominating.

## Avoid
- Round arches (that's Romanesque) and low, wide proportions.
- Flat walls without buttresses or deep window reveals.
- Roofs at 45° or less — gothic roofs are steep.
- Plain clear glass; stained glass is the soul of the style.
- Over-lit interiors; keep it dim and moody (but no spawnable floor spots).
