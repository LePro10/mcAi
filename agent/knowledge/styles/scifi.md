# Futuristic / Sci-Fi

Sleek hull panels, greebled machinery, glowing light lines, angled forms, domes and antennae. Pick it for space stations, spaceships, labs, cyber cities, research bases, landing pads. Reference: Star Wars hangars, Mass Effect, Halo, Mumbo-style mega-tech.

## Signature features
- Angular or rounded but always **intentional** silhouettes: chamfers at 45°, tapering towers, ribbed domes, wedge shapes.
- Panelling: large clean hull areas broken by seams, stripes and recessed panels.
- **Greebles**: dense machinery detail in recesses — vents, pipes, conduits, antennas.
- Light lines: continuous strips of light along edges, floors and seams.
- Glass domes and big viewports; contrast of white hull and dark tech recesses.
- Accent color used sparingly (one: cyan, orange or red) for signage and lights.

## Proportions & massing
- Modules on a 9/11/13 grid; corridors 3×3 or 5×4 with chamfered corners (cross-section: octagon).
- Towers: 7–15 wide, 3–5 tiers, each tier with a projecting ring/collar 1–2 blocks wide.
- Domes: radius 7–15, ribbed every 4–6 blocks with `iron_block` or `light_gray_concrete` ribs.
- Ships: length:width ≈ 3:1 to 5:1, layered hull (keel, mid-deck, dorsal ridge), engines 1/4 of the length.
- Panel seams every 3–5 blocks; light strips every 6–10 blocks.

## Palette
| Role | Blocks |
|---|---|
| primary (hull) | `white_concrete`, `smooth_quartz`, `light_gray_concrete`, `iron_block`, `quartz_bricks` |
| secondary (tech) | `polished_deepslate`, `gray_concrete`, `polished_tuff`, `black_concrete`, `smooth_basalt` |
| accent | `cyan_concrete`, `light_blue_concrete`, `waxed_oxidized_copper_grate`, `prismarine_bricks`, `crying_obsidian`, `orange_concrete` |
| roof | `smooth_quartz_slab`, `polished_deepslate_slab`, `white_concrete_stairs`, `white_concrete_slab`, `iron_trapdoor` |
| trim | `iron_trapdoor`, `polished_deepslate_wall`, `quartz_pillar`, `chiseled_quartz_block`, `heavy_weighted_pressure_plate`, `lightning_rod` |
| glass | `light_blue_stained_glass`, `cyan_stained_glass`, `tinted_glass`, `glass`, `black_stained_glass` |
| light | `sea_lantern`, `end_rod`, `pearlescent_froglight`, `waxed_copper_bulb[lit=true]`, `redstone_lamp[lit=true]`, `beacon` |
| details | `observer`, `dispenser`, `dropper`, `heavy_core`, `iron_bars`, `daylight_detector`, `crafter`, `target`, `conduit`, `waxed_copper_grate`, `hopper` |
| ground/foliage | `polished_deepslate`, `smooth_stone`, `black_concrete`, `gray_concrete`, `glow_lichen`, `twisting_vines`, `warped_roots` |

Mixes: hull `70%white_concrete,20%smooth_quartz,10%light_gray_concrete` · tech recess `40%polished_deepslate,25%gray_concrete,20%polished_tuff,15%waxed_oxidized_copper_grate` · floor plates `60%polished_deepslate,40%polished_tuff`.

## Walls recipe
1. Hull plane: hull mix in big panels; every 3–5 blocks a seam line of `light_gray_concrete` or a 1-deep groove.
2. Recessed tech bands 1–2 blocks deep along floor lines: fill with greebles (`observer`, `iron_trapdoor`, `heavy_weighted_pressure_plate`, `lightning_rod`, `iron_bars`).
3. Light lines: `sea_lantern` or `end_rod` (facing along the strip) set into the recess or behind `light_blue_stained_glass`.
4. Corners chamfered at 45°: replace the corner column with `white_concrete_stairs`/`smooth_quartz_slab` steps, or a diagonal block line.
5. Base: dark `polished_deepslate` plinth with landing struts/pylons angling outward.

## Roof recipe
- Flat decks with equipment: antenna arrays (`lightning_rod`, `end_rod`, `iron_bars` masts), dishes (small ellipsoid of `smooth_quartz` tilted), vents (`iron_trapdoor` grids).
- Domes: glass dome (`light_blue_stained_glass`) with `iron_block` ribs, or a solid `white_concrete` dome with a ring of viewports.
- Stepped/chamfered parapets using `white_concrete_stairs`; stairs facing toward the high side (inward) to slope the edge.

## Windows & doors
- Viewports: long horizontal bands of `tinted_glass`/`light_blue_stained_glass`, frames of `iron_block` or `polished_deepslate`.
- Hex/round portholes: 3×3 with corners replaced by `smooth_quartz_slab`, or a 5×5 ring.
- Doors: blast doors = 3×3 of `iron_trapdoor` (closed, alternating half) in a `polished_deepslate` frame with `sea_lantern` indicators; or `iron_door` pairs. Hangar doors: wide `iron_trapdoor` walls.

## Signature details
- Reactor core: vertical shaft with `beacon` or `sea_lantern` column inside `light_blue_stained_glass`, ringed by `iron_block` collars and `iron_chain` cables, `conduit` on top.
- Landing pad: octagon of `polished_deepslate` with `yellow_concrete` hazard stripes and `end_rod` edge lights.
- Pipes: `waxed_oxidized_copper_grate`/`iron_block` lines with `iron_trapdoor` clamps; cable bundles of `iron_chain` (axis along run).
- Control room: `black_concrete` consoles, `daylight_detector`/`heavy_weighted_pressure_plate` panels, `observer` screens, `tinted_glass` viewport, `cyan_carpet`.
- Hologram/greenhouse: `glass` vault with `twisting_vines`, `glow_lichen`, `verdant_froglight` floor.

## Layout ideas
- Research base: central dome (radius 11) + 3–4 modules on spokes linked by octagonal corridors, landing pad, antenna tower.
- Spaceship in a hangar: ship 45 long on landing struts, hangar 61×25 with gantries, crane, fuel lines.
- Cyber skyline: 5–9 towers of varied height on a 13-grid, skybridges, neon accent (`cyan_concrete`, `magenta_stained_glass`), elevated rail.

## Avoid
- Flat white boxes — sci-fi needs chamfers, layered hull, greebles.
- Random colors; one accent color only.
- Medieval props (torches, barrels, wooden doors).
- Greebles spread evenly everywhere; concentrate them in recesses so hull areas stay clean.
- Floating parts without struts, pylons or visible support.
