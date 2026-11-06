# Cherry Blossom

Serene pink groves, tea houses, arched bridges over koi ponds and lantern-lit paths — a sakura spring mood blending Japanese garden design with Minecraft's cherry wood. Pick for "cherry", "sakura", "zen", "tea house", "pink", "spring garden".

## Signature features
- The trees ARE the architecture: big, wide, flat-topped cherry canopies framing every view.
- Pink petals carpeting the ground, fading out from the trees.
- Dark roofs and dark timber against pink/white — contrast keeps it elegant, not candy.
- Water: koi ponds, streams, arched bridges, stepping stones.
- Stone lanterns, bamboo groves, moss, gravel and mossy stone paths.

## Proportions & massing
- Pavilions small and low: 5×5 to 9×7, walls 3–4, wide curved roofs with 2 overhang.
- Cherry trees: trunk 1–2 thick, 4–7 tall, splitting into 2–4 branches; canopy 9–15 wide, 4–6 tall, flattened and layered with drooping edges.
- Bridges: arc rising 2–3 over a 7–11 span, 3 wide.
- Leave 60% of the site as garden and water; buildings are accents.

## Palette
| Role | Blocks |
|---|---|
| primary | `cherry_planks`, `calcite`, `white_terracotta`, `pale_oak_planks` |
| secondary | `cherry_log`, `stripped_cherry_log`, `cherry_wood`, `dark_oak_log` |
| accent | `pink_terracotta`, `pink_concrete`, `dark_oak_planks`, `red_terracotta` |
| roof | `deepslate_tile_stairs`, `deepslate_tile_slab`, `cherry_stairs`, `cherry_slab`, `dark_oak_stairs` |
| trim | `cherry_fence`, `cherry_trapdoor`, `dark_oak_fence`, `stripped_cherry_wood` |
| glass | `pink_stained_glass_pane`, `white_stained_glass_pane`, `glass_pane` |
| light | `lantern`, `pink_candle[lit=true]`, `ochre_froglight`, `pearlescent_froglight` |
| details | `pink_petals`, `cherry_leaves`, `bamboo`, `lily_pad`, `potted_cherry_sapling`, `pink_tulip`, `bell`, `pink_banner` |
| ground / foliage | `grass_block`, `moss_block`, `gravel`, `dirt_path`, `cherry_leaves`, `azalea_leaves`, `allium`, `peony`, `lilac` |

Mixes: canopy `85%cherry_leaves,15%flowering_azalea_leaves`; garden path `40%gravel,30%dirt_path,20%moss_block,10%mossy_cobblestone`; stone `50%andesite,30%polished_andesite,20%mossy_stone_bricks`.

## Walls recipe
1. Plinth: 1 course of `polished_andesite` or `mossy_stone_bricks`, raised floor 1 above ground (engawa veranda all around, `cherry_slab`).
2. Frame: `dark_oak_log` or `stripped_cherry_log` posts every 3, beams at the top (axis along the wall).
3. Infill 1 behind: paper-screen look with `white_terracotta`/`calcite`, or `cherry_trapdoor` grids; many walls can be fully open.
4. Railing on the veranda: `cherry_fence` between posts.

## Roof recipe
- Hip or irimoya (hip-and-gable) roof in `deepslate_tile_stairs`, stairs facing toward the ridge; 2 overhang.
- Upswept corners: roof op style swept_hip with lift 1, fascia `cherry_trapdoor`, brackets true (pavilions: finial).
- Eave underside: `dark_oak_stairs[half=top]` facing toward the wall + `cherry_trapdoor` fascia.
- Ridge: `deepslate_tile_slab` with end caps of `deepslate_tile_stairs` turned upward; small pavilions can use a single pyramid roof with a finial `lantern`.

## Windows & doors
- Round moon windows: 3×3 or 5×5 circle cut in a `calcite` wall, `pink_stained_glass_pane` or open.
- Sliding doors: `cherry_door` pairs, or `cherry_trapdoor` screens.

## Signature details
- Cherry tree: curving `cherry_log` trunk (branches as diagonal lines of `cherry_wood`), layered blobs of `cherry_leaves[persistent=true]`, a few blocks drooping below the canopy edge, `pink_petals[flower_amount=4]` under the canopy thinning to 1–2 at the drip line.
- Arched bridge: bridge op, profile arch, deck `cherry_planks`, rail `cherry_fence`, post `red_terracotta`, lantern `lantern`.
- Stone lantern: `stone_brick_wall` base, `polished_andesite` cap block, `lantern` inside a 1-block niche, `andesite_slab` roof.
- Koi pond: irregular 2-deep `water`, edges of `mossy_cobblestone` and `moss_block`, `lily_pad`s, stepping stones of `andesite_slab`.
- Bamboo screen: rows of `bamboo` 3–5 tall behind pavilions as a backdrop.

## Layout ideas
- Tea garden (41×41): pond in the center with an island pavilion, arched bridge, winding gravel path loop, 6–8 cherry trees of varied sizes, bamboo backdrop.
- Shrine on a hill: stair path with lanterns every 5 steps through a tunnel of cherry trees to a small shrine and bell.
- Blossom avenue: 2 rows of trees over a 5-wide path, petal carpet, benches (stairs) and a gate.

## Avoid
- Pink everything: pink must be the trees and petals only, buildings stay dark wood/white/grey stone.
- Lollipop trees (ball on a stick): canopies wide, layered, asymmetric.
- Uniform petal carpets: density gradient from trunk outward.
- Leaves without persistent=true (they decay away from logs).
