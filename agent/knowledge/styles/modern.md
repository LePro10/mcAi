# Modern / Minimalist

Clean volumes, cantilevers, flat roofs, floor-to-ceiling glass, warm wood against white concrete, water and planted terraces. Pick it for villas, beach houses, offices, galleries, apartments. Reference: Case Study houses, Fallingwater, contemporary Minecraft villa builders.

## Signature features
- Composition of **2–4 intersecting boxes** of different sizes, offset and cantilevered — never one box.
- Horizontal emphasis: long thin slab edges, ribbon windows, flat roofs with thin overhanging edges.
- Huge glazing (full-height glass walls) contrasted with solid planes.
- Material contrast: white concrete + one warm wood + one dark accent.
- Indoor-outdoor flow: terraces, infinity pool, decks, planters, rooftop gardens.
- Hidden lighting (lights under slabs, behind carpet, in the ceiling plane).

## Proportions & massing
- Storey height 4–5 (3–4 air) — modern interiors feel lofty.
- Volumes: e.g. 13×9 ground box + 17×7 upper box rotated or slid 3–5 blocks to cantilever.
- Cantilever up to 5–7 blocks; show it clearly (no supports underneath, or one slender `iron_bars`/`light_gray_concrete` column).
- Roof/slab edges 1 block thick, projecting 1–2 beyond the walls.
- Glass:solid ratio ≈ 50:50 on the main facade; back/side facades more solid.

## Palette
| Role | Blocks |
|---|---|
| primary | `white_concrete`, `smooth_quartz`, `light_gray_concrete`, `polished_tuff`, `calcite` |
| secondary | `gray_concrete`, `black_concrete`, `polished_deepslate`, `tuff_bricks`, `polished_andesite` |
| accent (wood) | `stripped_oak_wood`, `pale_oak_planks`, `spruce_planks`, `stripped_cherry_wood`, `stripped_spruce_wood` |
| roof/slabs | `smooth_stone_slab`, `white_concrete_slab`, `gray_concrete_slab`, `smooth_quartz_slab` |
| trim | `smooth_quartz_slab`, `white_concrete_stairs`, `light_gray_concrete_slab`, `iron_trapdoor`, `polished_tuff_wall` |
| glass | `glass`, `light_gray_stained_glass`, `tinted_glass`, `glass_pane` |
| light | `sea_lantern`, `pearlescent_froglight`, `ochre_froglight`, `end_rod`, `redstone_lamp[lit=true]` |
| details | `oak_shelf`, `flower_pot`, `potted_bamboo`, `white_carpet`, `gray_carpet`, `heavy_weighted_pressure_plate`, `white_wool_slab`, `light_gray_wool_slab`, `iron_bars` |
| ground/foliage | `smooth_stone`, `polished_andesite`, `grass_block`, `white_concrete_powder`, `azalea`, `azalea_leaves`, `bamboo`, `short_grass` |

Mixes: concrete is used pure — no random mixes on modern facades. Paving `70%smooth_stone,30%polished_andesite` or a checker of the two (size 2). Dark base `60%polished_deepslate,40%polished_tuff`.

## Walls recipe
1. Solid planes are pure single blocks (`white_concrete`), large and uninterrupted — depth comes from **volume offsets**, not texture.
2. Wrap a box in a 1-block "frame" (slab edge + side fins) of `smooth_quartz` that projects 1 block beyond a recessed glass wall.
3. Glass walls: `glass` full blocks (panes look thin and connect awkwardly at scale), recessed 1 block behind the frame.
4. Wood feature wall: one plane of `stripped_oak_wood` or vertical `spruce_planks` slats (alternate planks and `spruce_trapdoor` for louvers).
5. Plinth: dark `polished_deepslate` band or a recessed shadow gap 1 block under the ground floor so the house floats.

## Roof recipe
- Flat roofs: `smooth_stone_slab` or `white_concrete_slab` (type=bottom) field, with a 1-block raised parapet or a thin slab edge projecting 1–2 blocks (slab_edge op: block `smooth_quartz`, overhang 1, light `sea_lantern` for a soffit light strip).
- Hidden lights: `sea_lantern`/`pearlescent_froglight` flush in the ceiling plane (covered by the roof/floor above), or `end_rod` uplights in planters.
- Optional single-pitch (shed) roof: shallow 1:3 with slabs, or a green roof of `moss_block` + `short_grass` + `azalea`.
- Rooftop: sundeck of `spruce_planks`, glass balustrade (`glass_pane`), planters.

## Windows & doors
- Floor-to-ceiling `glass` between slab edges; ribbon windows 1 high × 5–11 long.
- Vertical fins of `smooth_quartz_slab`/`iron_trapdoor` in front of glass for rhythm.
- Doors: `iron_door` or `pale_oak_door` set in a full-height glass wall; pivot-door feel with `glass` sidelights.
- Garage: `iron_trapdoor` stack or `light_gray_concrete` panel door.

## Signature details
- Infinity pool: `water` in a `white_concrete` basin whose view-side edge has no rim (water flush with the slab edge), `sea_lantern` set into the pool floor every 4 blocks.
- Floating stairs: `smooth_quartz_slab` treads cantilevered from a wall, no stringer.
- Planters: `polished_deepslate` or `light_gray_concrete` box filled with `grass_block` + `azalea` + `bamboo`, edge `smooth_stone_slab`.
- Interior: `white_wool_slab` sofas, `light_gray_wool_stairs` armchairs, `oak_shelf` with items, `black_concrete` kitchen island with `smooth_quartz_slab` top, `flower_pot` greenery.
- Fire pit: `campfire` sunk in a `polished_deepslate` ring on the terrace.

## Layout ideas
- Cliff villa: two boxes stepping down a slope, lower box's roof = upper terrace, pool cantilevered toward the view.
- Courtyard house: L or U plan around a pool/garden with full glass facing the courtyard, solid walls to the street.
- Gallery: long 31×11 bar raised on 3 columns over water, ribbon window, ramp access.

## Avoid
- A single white cube with holes — compose multiple volumes.
- Texture mixes and cracked blocks; modern = crisp.
- Pitched roofs with stairs (unless deliberately shed/butterfly).
- Visible torches/lanterns everywhere; light from hidden sources.
- Glass panes at large scale (they connect into thin grids) — use `glass`.
