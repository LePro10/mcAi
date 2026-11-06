# Castle / Fortress

Concentric curtain walls, round and square towers, a massive keep, gatehouse with portcullis, battlements and banners (Carcassonne, Bodiam, Hohenzollern, Minas Tirith). Pick for "castle", "fortress", "citadel", "keep", "kingdom", "stronghold".

## Signature features
- Strong silhouette: towers of different heights, the keep clearly the tallest, spires/conical roofs on towers.
- Thick curtain walls with a wall-walk, crenellations and machicolations (corbelled overhang).
- Gatehouse with flanking towers, deep arched passage, portcullis, drawbridge over a moat.
- Battered (sloped) bases that grip the terrain or rock outcrops.
- Banners, arrow slits, buttresses; heavy stone with weathering.

## Proportions & massing
- Curtain walls 3 thick (wall-walk 2 wide on top + parapet 1), 10–16 tall. Wall segments between towers 15–30 long.
- Towers: round radius 4–6 (diameter 9–13), 1.4–1.8× wall height; square towers 7×7 to 11×11. Project towers 3–4 beyond the wall face for flanking.
- Keep: 15×15 to 25×25, 25–40 tall, 4 storeys of 5–6 blocks.
- Battlements: merlon 1 wide/2 tall, crenel 1 wide, on top of a 1-high parapet. Machicolation: parapet pushed out 1 on `stone_brick_stairs[half=top]` corbels facing toward the wall.
- Battered base: bottom 3–5 blocks flare out 1–2 using stairs and a darker mix.

## Palette
| Role | Blocks |
|---|---|
| primary | `stone_bricks`, `cracked_stone_bricks`, `mossy_stone_bricks`, `andesite` |
| secondary | `polished_andesite`, `tuff_bricks`, `cobblestone`, `stone` |
| accent | `deepslate_bricks`, `chiseled_stone_bricks`, `polished_tuff`, `dark_oak_planks` |
| roof | `deepslate_tile_stairs`, `deepslate_tile_slab`, `dark_oak_stairs`, `spruce_stairs`, `blue_terracotta` |
| trim | `stone_brick_wall`, `stone_brick_stairs`, `stone_brick_slab`, `andesite_wall`, `dark_oak_log` |
| glass | `iron_bars`, `glass_pane`, `gray_stained_glass_pane` |
| light | `lantern`, `wall_torch`, `campfire`, `soul_lantern` |
| details | `red_banner`, `blue_banner`, `red_wall_banner`, `iron_chain`, `iron_bars`, `anvil`, `grindstone`, `barrel`, `hay_block`, `cauldron` |
| ground / foliage | `gravel`, `cobblestone`, `dirt_path`, `coarse_dirt`, `vine`, `moss_carpet`, `short_grass` |

Mixes: wall `50%stone_bricks,20%cracked_stone_bricks,15%mossy_stone_bricks,10%andesite,5%cobblestone`; base (darker, bottom 4 blocks) `40%cobblestone,30%andesite,20%mossy_cobblestone,10%tuff`; courtyard `60%gravel,25%cobblestone,15%coarse_dirt`. Use a vertical gradient: mossy near the ground, clean at the top.

## Walls recipe
1. Battered base in the base mix, flaring 1–2 out with `stone_brick_stairs` (facing toward the wall).
2. Wall face in the wall mix. Every 6–8 blocks a buttress/pilaster 1 out of `stone_bricks` or `polished_andesite`.
3. String course: 1 row of `stone_brick_slab[type=top]` or `stone_brick_stairs[half=top]` sticking out 1 at wall-walk level.
4. Parapet with merlons; arrow slits = 1×2 holes (or `iron_bars`) in merlons/towers.
5. Interior face cleaner (`stone_bricks`), wall-walk floor `stone_brick_slab`.

## Roof recipe
- Round towers: roof op style cone (or round spire) in `deepslate_tile_stairs`, overhang 1, pitch 1.5–2, soffit and finial true; banner below the finial.
- Square towers: steep pyramid/hip roof or open battlements; a 2-tier "hat" (lower flared ring of stairs, then steep spire).
- Keep: hip roof in `deepslate_tile_stairs` with dormers and corner turrets (radius 2) corbelled out on `stone_brick_stairs[half=top]` corbels.
- Gatehouse: battlements + machicolations, small roof over the portcullis room.

## Windows & doors
- Low levels: arrow slits only. Upper keep: tall 2×4 windows with round/pointed arches, `iron_bars` or `gray_stained_glass_pane` set 1–2 deep (walls are thick — show it).
- Gate passage: 5 wide × 7 tall pointed arch, 6–10 deep, portcullis of `iron_bars` hanging under an `iron_chain`, `spruce_door`/`dark_oak_trapdoor` double gates further in.
- Drawbridge: `spruce_planks`/`dark_oak_planks` deck with `iron_chain` lines up to the gatehouse.

## Signature details
- Machicolated parapet ring around tower tops: corbels `stone_brick_stairs[half=top]`, parapet pushed out 1, holes between corbels.
- Banners: `red_wall_banner` pairs flanking the gate, long banners on tower faces (stack 2 wall banners), pattern via SNBT.
- Moat: 4–6 wide, water at 2 below the bank, `mossy_cobblestone` lining, lily pads.
- Courtyard life: well (stone ring + `cauldron`), smithy (`anvil`, `blast_furnace`, `grindstone`), stables (`hay_block`, fence stalls), market stalls.
- Ruined parts: missing merlons, rubble piles of `cobblestone_slab`/`gravel`, vines on the shady side.

## Layout ideas
- Hilltop castle (80×70): irregular curtain wall following the contour, 5–7 round towers, gatehouse at the approach road, keep at the highest point, inner bailey wall.
- Concentric fortress (101×101): outer low wall + inner high wall, square keep in the center, four gate axes.
- Cliff fortress: keep fused into a rock outcrop (blend stone into the cliff), bridge/causeway access.

## Avoid
- One giant box with crenels: vary tower heights, roof shapes and wall angles.
- Paper-thin walls: 3 thick minimum, show depth at every opening.
- Straight walls on uneven terrain floating or cutting hills flat — follow the terrain and root walls into it.
- Plain uniform `stone_bricks` everywhere: use the mix + gradient + accents.
- Dark interiors — light the courtyard, wall-walks and keep floors (lanterns, hidden lights).
