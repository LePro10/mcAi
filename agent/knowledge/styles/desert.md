# Desert / Arabian

Sun-bleached sandstone cities, souks, riads and domed palaces (think Agrabah, Persian/Moorish architecture, Saharan ksars). Pick it for deserts, badlands, "oasis", "sultan", "bazaar", "palace", "pyramid" requests.

## Signature features
- Flat roofs with parapets and roof terraces; domes and onion domes as the crowning focal points.
- Thick, massive walls (2 layers) with deep-set small windows — shade is the design driver.
- Pointed and horseshoe arches; arcades around inner courtyards (riads) with a central fountain.
- Lattice screens (mashrabiya) from trapdoors; colorful tilework bands in cyan/blue glazed terracotta.
- Minarets: slender square or octagonal towers with balconies and a small dome or spire.
- Cloth awnings and market stalls in saturated wool colors; palms and an oasis pool.

## Proportions & massing
- Storeys 4–5 blocks (floor to floor). Houses are cubes 7×7 to 11×11, stacked and stepped like a hillside cascade.
- Walls: 2 deep — outer layer flush, windows recessed 1. Parapet 1–2 above roof line with crenels every 2.
- Domes: radius 4–7 on a drum (cylinder) 1–3 tall; onion domes bulge to radius+1 at 1/3 height then taper to a point with `end_rod` or `lightning_rod` finial.
- Minarets: 3×3 or 5×5, height 3–4× the main building, balcony ring of slabs at 2/3 height.
- Courtyards: odd widths (9, 11, 13) with a centered fountain; arcade bays 3 wide.

## Palette
| Role | Blocks |
|---|---|
| primary | `smooth_sandstone`, `sandstone`, `cut_sandstone`, `white_terracotta` |
| secondary | `smooth_red_sandstone`, `red_sandstone`, `terracotta`, `packed_mud`, `mud_bricks` |
| accent | `cyan_terracotta`, `light_blue_terracotta`, `cyan_glazed_terracotta`, `light_blue_glazed_terracotta`, `gold_block`, `chiseled_sandstone`, `orange_terracotta` |
| roof / domes | `smooth_sandstone_slab`, `smooth_sandstone_stairs`, `cut_sandstone_slab`, `waxed_oxidized_cut_copper`, `cyan_terracotta`, `white_concrete` |
| trim | `chiseled_sandstone`, `sandstone_wall`, `cut_red_sandstone`, `acacia_trapdoor`, `jungle_trapdoor` |
| glass | `orange_stained_glass_pane`, `yellow_stained_glass_pane`, `glass_pane` |
| light | `lantern`, `candle[lit=true]`, `campfire`, `ochre_froglight` |
| details | `decorated_pot`, `red_carpet`, `orange_carpet`, `cyan_carpet`, `yellow_wool`, `red_wool`, `barrel`, `potted_cactus`, `brewing_stand`, `cauldron` |
| ground / foliage | `sand`, `red_sand`, `sandstone`, `jungle_leaves`, `stripped_jungle_log`, `cactus`, `dead_bush`, `short_dry_grass`, `tall_dry_grass`, `cactus_flower` |

Mixes: walls `60%smooth_sandstone,25%sandstone,15%cut_sandstone`; old/weathered quarter `50%sandstone,25%smooth_sandstone,15%packed_mud,10%mud_bricks`; street `70%sand,20%smooth_sandstone,10%sandstone`.

## Walls recipe
1. Footing: 1 course of `cut_sandstone` or `smooth_red_sandstone` — a darker base grounds the build.
2. Wall body in the wall mix, 2 thick. Corners get `chiseled_sandstone` quoins every 3rd course or a `cut_sandstone` pilaster pushed out 1.
3. A tile band 1 high of `cyan_terracotta` / glazed terracotta at door-head height or just under the parapet.
4. Parapet: `smooth_sandstone` with `sandstone_wall` or alternating full/slab crenels; drain spouts = a single `smooth_sandstone_stairs[half=top]` sticking out.
5. Windows recessed 1 into the wall; sills of `smooth_sandstone_slab[type=top]` under them.

## Roof recipe
- Default flat: floor of `smooth_sandstone`, edge parapet, terrace props (carpets, pots, cushions of wool slabs, awnings).
- Domes: ellipsoid half=top, hollow, on a short drum; shell in `cyan_terracotta` or `waxed_oxidized_cut_copper`, with a 1-block `gold_block` or `chiseled_sandstone` ring at the base. Onion dome: scripted profile (radius grows to r+1 then tapers to 0 over 1.5 r). Finial: `gold_block` + `lightning_rod`.
- Small domes over every tower and gate; one dominant dome only (hierarchy).
- Avoid pitched roofs except tent canopies.

## Windows & doors
- Pointed arch openings: 3 wide, 4–5 tall; arch shoulders made with `smooth_sandstone_stairs[half=top]` in the top corners of the opening, each facing outward toward its jamb (the solid lower quarter sits against the jamb), leaving a pointed void in the middle.
- Mashrabiya: fill the opening with `acacia_trapdoor` or `jungle_trapdoor` (closed, half=top/bottom alternating, or open against the frame) set 1 block behind the facade.
- Doors: `acacia_door` or `jungle_door` set 1 deep inside a tall arched frame of `chiseled_sandstone` with a tile band above.

## Signature details
- Souk stall: 3×3 posts of `acacia_fence`, roof of colored wool/`red_wool_slab` stripes (alternate `red_wool` and `white_wool`), counters of `barrel` and `decorated_pot`, hanging `lantern[hanging=true]` on `iron_chain`.
- Riad fountain: 5×5 or 7×7 basin of `cut_sandstone` with `cyan_glazed_terracotta` floor, a center pillar of `chiseled_sandstone` and `water`; 4 palms or potted plants on the corners.
- Palm tree: curved trunk of `stripped_jungle_log` (offset 1 sideways every 2–3 blocks), crown of `jungle_leaves[persistent=true]` drooping arms 3–4 long, coconuts with `cocoa`.
- Rooftop awning: `white_wool_slab` / `yellow_wool_slab` sheets on `acacia_fence` posts, `lantern` beneath.
- Tile carpet floors: carpets in a rug pattern (border `red_carpet`, field `orange_carpet`, center `cyan_carpet`).

## Layout ideas
- Oasis village (60×60): central palm-ringed pool, 8–12 cube houses stepping up a dune, souk street with 6 stalls, one domed mosque/palace with minaret as the landmark.
- Palace (41×41): square curtain wall with corner towers, garden courtyard with 4-part cross water channels, main dome radius 7 on axis behind a big pointed iwan arch.
- Caravanserai (25×25): 2-storey arcade ring around a courtyard, one big gate with a tower.

## Avoid
- Plain sand-colored boxes: always add the dark footing, tile band and parapet.
- Large glazed windows — they read wrong; small, deep, shaded openings.
- Mixing too many sandstone textures at full weight: chiseled is an accent, not a wall.
- Leaving cactus next to walkways (it damages players) or floating `jungle_leaves` that decay — always persistent=true.
