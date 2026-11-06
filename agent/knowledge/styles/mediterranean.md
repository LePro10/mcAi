# Mediterranean / Greek

Two moods in one family: whitewashed Cycladic villages with blue domes cascading down cliffs (Santorini), and classical marble temples with columns and pediments (Parthenon). Also Tuscan/Provençal villas with terracotta tile roofs. Pick for coast, cliffs, "greek", "temple", "villa", "santorini", "olive".

## Signature features
- Brilliant white cubic houses stacked on terraces with stairs between them; rounded edges and soft corners.
- Blue accents: domes, doors, shutters, window frames — one strong blue only.
- Classical temples: stylobate steps, colonnade of round-feel columns, entablature band, low triangular pediment.
- Villas: terracotta tile roofs at low pitch (about 1:2), loggias, pergolas with vines, cypress trees.
- Bougainvillea spilling over walls; pots and amphorae everywhere.

## Proportions & massing
- Cycladic cubes 5×5 to 9×7, 4-block storeys, roofs flat with a 1-block rounded parapet; stack 2–4 levels stepping back down the slope.
- Domes: radius 3–5 on a drum, only on chapels.
- Temple: columns 1×1 `quartz_pillar` (or 3×3 for grand temples), spacing 1 gap (narrow) or 2 gaps; column height ≈ 6–8× its width; pediment pitch 1:3 (very low — use slabs, not stairs alone).
- Villa: footprint 2:1 rectangles around a courtyard, eaves overhang 1.

## Palette
| Role | Blocks |
|---|---|
| primary | `calcite`, `white_concrete`, `smooth_quartz`, `white_terracotta` |
| secondary | `quartz_pillar`, `smooth_quartz`, `polished_diorite`, `diorite`, `chiseled_quartz_block`, `quartz_bricks` |
| accent | `blue_concrete`, `light_blue_concrete`, `blue_terracotta`, `cyan_terracotta`, `blue_concrete_stairs` |
| roof | `brick_stairs`, `brick_slab`, `granite_stairs`, `granite_slab`, `blue_concrete_stairs`, `smooth_quartz_slab`, `smooth_quartz_stairs` |
| trim | `quartz_slab`, `quartz_stairs`, `spruce_trapdoor`, `warped_trapdoor`, `dark_oak_fence`, `smooth_quartz_stairs` |
| glass | `glass_pane`, `light_blue_stained_glass_pane` |
| light | `lantern`, `candle[lit=true]`, `sea_lantern` |
| details | `decorated_pot`, `flower_pot`, `potted_azalea_bush`, `flowering_azalea_leaves`, `vine`, `oxeye_daisy`, `white_carpet`, `blue_carpet`, `bell` |
| ground / foliage | `smooth_stone`, `stone_bricks`, `polished_diorite`, `coarse_dirt`, `azalea_leaves`, `dark_oak_leaves`, `spruce_leaves` |

Mixes: whitewash `80%calcite,15%white_terracotta,5%diorite`; tile roof `70%brick_stairs,30%granite_stairs` (same facing); marble `70%smooth_quartz,20%quartz_bricks,10%calcite`.

## Walls recipe
1. Cycladic: walls in the whitewash mix, 1 thick, but round every outer vertical corner by placing `smooth_quartz_stairs` or leaving the corner block out and adding stairs (soft-edge look). Parapet top = `smooth_quartz_slab`.
2. Windows framed by a 1-block blue surround (`blue_terracotta`) or just blue shutters; glass set 1 deep.
3. Villa: plaster `white_terracotta` + `calcite`, `stripped_spruce_log` lintels, stone base of `stone_bricks` 1–2 high.
4. Temple: stylobate 2–3 steps of `smooth_quartz_stairs` all around, cella wall `smooth_quartz` set back 2 behind the colonnade, entablature = `chiseled_quartz_block` frieze between `smooth_quartz_slab[type=top]` courses.

## Roof recipe
- Cycladic: flat + chapel dome (half ellipsoid, hollow) in `blue_concrete` or `blue_terracotta`, white drum, small `smooth_quartz` cross or `lightning_rod` finial; bell gable = a 3-wide white wall with an arched hole holding a `bell`.
- Villa: low gable/hip in the tile mix; facing points toward the ridge; ridge capped with `brick_slab`; eave edge of `brick_stairs[half=top]` facing toward the wall 1 out.
- Temple pediment: triangle wall of `smooth_quartz` with slab steps (2 wide per 1 up), cornice of `quartz_stairs[half=top]` along the eaves, roof surface `smooth_quartz_slab` / `quartz_stairs`.

## Windows & doors
- Blue doors: `warped_door` or `blue_concrete` surround with `spruce_door`; arched top of `smooth_quartz_stairs[half=top]`.
- Shutters: `warped_trapdoor` (teal-blue) open, facing away from the wall on both sides of the window.
- Small square windows 1×1 or 1×2; one big arched window per chapel.

## Signature details
- Terraced stairways: 3-wide `smooth_quartz_stairs` winding between houses, white walls of `calcite` slabs as railings, potted flowers on every landing.
- Bougainvillea: `flowering_azalea_leaves[persistent=true]` + `pink_petals` draped over wall tops and door heads, thicker at corners.
- Pergola: `dark_oak_fence` posts with `stripped_spruce_log` beams, `vine` and `azalea_leaves[persistent=true]` on top; table of `spruce_trapdoor` on a fence post below.
- Amphorae: rows of `decorated_pot` along walls; olive trees from `oak_log` gnarled trunk and `azalea_leaves` + `dark_oak_leaves` canopy.
- Cypress: 1-wide columns of `spruce_leaves` 5–8 tall, 3×3 at the base fading to 1.

## Layout ideas
- Santorini cliff (50 wide × 40 tall slope): 15–20 cubes stepping down, 2 blue-domed chapels as focal points, winding stair spine, terraces with pools (`water` with `light_blue_concrete` floor).
- Greek temple (17×31): peripteral colonnade 6×13 columns on a 3-step base, cella inside, statue (armor stand) inside, cypress avenue approach.
- Tuscan villa (31×25): U-shaped around a courtyard, loggia arcade, tile roofs, cypress driveway, vineyard rows.

## Avoid
- More than one blue; never mix navy and turquoise accents on the same house.
- Full-block or steep roofs on the temple — the pediment is LOW.
- Sharp, perfect cube villages: vary heights by 1–2, round corners, overlap terraces.
- Columns made of plain `smooth_quartz` cubes with no base/capital — add slab plinth + `chiseled_quartz_block` capital.
