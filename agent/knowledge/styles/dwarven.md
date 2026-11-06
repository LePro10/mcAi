# Dwarven (mountain halls & forges)

Massive geometric halls carved into mountains: dark stone, gold inlay, colossal pillars, lava light, forges and statues. Pick it for mountain cities, underground kingdoms, mines, forges, vaults, great gates. Reference: Erebor, Moria, Ironforge.

## Signature features
- Monumental scale and symmetry: huge carved gates, halls 20–40 high, rows of giant pillars.
- Strict geometry: straight lines, 45° chamfers, stepped ziggurat forms, octagonal pillars, angular "runic" patterns.
- Dark stone (deepslate/blackstone) with **gold and copper inlay** in bands and patterns.
- Built *into* rock: facades carved in a cliff, interior volumes hollowed out of mountains.
- Warm light from lava channels, magma and lanterns in a cold dark palette.
- Industry: forges, bellows, minecart tracks, chains, anvils, ore veins visible in the walls.

## Proportions & massing
- Great gate: 7–11 wide, 11–17 tall, recessed 3–5 blocks into the mountain, flanked by 2 statues or pillars 15–25 tall.
- Pillars: 3×3 or 5×5 with chamfered corners (octagonal), base and capital 1 block wider; spacing 7–9 centre to centre.
- Halls: width 15–31, height ≥ width × 0.8; ceilings with stepped coffers or ribbed vaults.
- Walls 2–3 blocks thick; doorways 3×4 minimum, main portals 5×7.
- Everything symmetric about the main axis; asymmetry only in mines and workshops.

## Palette
| Role | Blocks |
|---|---|
| primary | `deepslate_bricks`, `deepslate_tiles`, `polished_blackstone_bricks`, `polished_deepslate` |
| secondary | `polished_basalt`, `basalt`, `cobbled_deepslate`, `tuff_bricks`, `dark_oak_log` |
| accent | `gold_block`, `raw_gold_block`, `gilded_blackstone`, `waxed_cut_copper`, `waxed_exposed_cut_copper`, `cinnabar_bricks` |
| roof/ceiling | `deepslate_tile_stairs`, `deepslate_tile_slab`, `polished_blackstone_brick_stairs`, `polished_deepslate_slab` |
| trim | `chiseled_deepslate`, `polished_deepslate_wall`, `deepslate_brick_wall`, `chiseled_polished_blackstone`, `iron_bars` |
| glass | `orange_stained_glass_pane`, `tinted_glass` |
| light | `lantern`, `lantern[hanging=true]`, `magma_block`, `shroomlight`, `waxed_copper_bulb[lit=true]`, `lava` |
| details | `anvil`, `chipped_anvil`, `blast_furnace`, `smithing_table`, `grindstone`, `iron_chain`, `barrel`, `chest`, `lodestone`, `raw_iron_block`, `rail` |
| ground | `polished_deepslate`, `deepslate_tiles`, `cobbled_deepslate`, `gravel`, `glow_lichen`, `hanging_roots` |

Mixes: walls `50%deepslate_bricks,25%deepslate_tiles,15%cracked_deepslate_bricks,10%polished_deepslate` · floor `60%polished_deepslate,25%deepslate_tiles,15%cobbled_deepslate` · ore wall `85%deepslate,6%deepslate_gold_ore,5%deepslate_iron_ore,4%deepslate_copper_ore`.

## Walls recipe
1. Plinth 2–3 high of `polished_deepslate` stepping out 1 block, topped by a `polished_blackstone_brick_stairs` course (half=bottom, facing toward the wall).
2. Main field in the wall mix, divided into bays by pilasters (2 wide, `polished_deepslate` with `chiseled_deepslate` capitals) every 5–7 blocks, standing 1 block proud.
3. Gold inlay: horizontal band of `gold_block` or `waxed_cut_copper` at 1/3 and 2/3 height, recessed flush; chevron/diamond motifs between pilasters.
4. Top: cornice of `deepslate_tile_stairs[half=top]` facing toward the wall, then a stepped parapet.
5. Carved facades: carve the cliff, then **frame** the opening in brick so the rock reads as natural around a crisp man-made edge.

## Roof recipe
- Usually no pitched roof: halls are inside the mountain. Ceilings: stepped coffers (each step 1 block in, 1 up) or 45° chamfered vaults using `deepslate_tile_stairs[half=top]` facing toward the wall.
- Freestanding buildings: low stepped ziggurat roofs or 45° hip roofs in `deepslate_tile_stairs`, gold-capped ridge (`gold_block` or `waxed_cut_copper_slab`).
- Hall ceilings carry hanging braziers: `iron_chain` + `lantern[hanging=true]` or chains holding a `magma_block`/`shroomlight` cage of `iron_bars`.

## Windows & doors
- Few windows; light slots 1×3 with `orange_stained_glass_pane` and magma behind for glow.
- Gates: double/triple layered frame — outer `polished_deepslate` chamfer, middle `gold_block` ring, inner `deepslate_tiles`; door leaf of `iron_bars`/`dark_oak_planks` or a portcullis of `iron_bars`.
- Interior doors: `iron_door` or `dark_oak_door` set in a 3-wide 45°-chamfered opening.

## Signature details
- Guardian statues flanking the gate: 15–25 tall, blocky figures with axe/hammer in `polished_blackstone`, beard in `gilded_blackstone`, eyes `shroomlight` (run_script).
- Lava channel: 1–2 wide trench of `lava` in the floor, edged with `polished_blackstone_brick_slab`, crossed by `iron_bars`-railed bridges; flowing lava falls behind `iron_bars`.
- Forge: `blast_furnace` row, `anvil`s, `lava` pit, `campfire` under a `polished_blackstone` hood with an `iron_chain`-hung bellows (`dark_oak_trapdoor`), weapon racks (armor stands via summon, if available).
- Mine shaft: `dark_oak_log` + `dark_oak_planks` timber supports every 4 blocks, `rail` on `gravel`, `lantern` on posts, exposed ore veins.
- Treasury: `gold_block`/`raw_gold_block` piles, `chest`s, `barrel`s, `decorated_pot`s.

## Layout ideas
- Mountain gate: valley approach with a stone bridge over a chasm (5 wide, 30 long), giant recessed gate, two statues, watch slits above.
- Great hall: 25×51 nave, 2 rows of 5×5 pillars, lava channel down the middle, throne on a stepped dais at the far end (−z), forges in side aisles.
- Underground city: stacked terraces around a central shaft with chain-hung braziers, switchback stairs, houses carved as facades into the shaft walls.

## Avoid
- Organic curves and leaves — dwarven is geometric.
- Lighting the whole hall evenly; use pools of warm light and darkness for drama (but mob-proof the floor).
- Thin 1-block walls and 1×1 pillars at monumental scale.
- Gold everywhere; it's inlay, ≤ 5% of surfaces.
- Dull single-block walls — always mix deepslate variants and add pilasters.
