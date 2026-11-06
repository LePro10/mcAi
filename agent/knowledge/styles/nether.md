# Nether / Infernal

Blackstone bastions, basalt citadels, lava moats, crimson/warped fungal forests, demon gates. Works in the Nether and as an "infernal / volcanic / dark lord" theme in the overworld. Pick for "nether", "hell", "volcano", "demon", "dark lord", "piglin", "fire".

## Signature features
- Massive, aggressive silhouettes: spikes, buttresses, jagged spires, oversized gates.
- Near-black stone with glowing veins (magma, gold, crying obsidian) — contrast of dark and hot.
- Lava falls and contained lava moats as light and drama; smoke from soul campfires.
- Fungal growth: crimson and warped stems/wart canopies, weeping/twisting vines.
- Chains, skulls and gold — piglin treasure aesthetic.

## Proportions & massing
- Exaggerate scale: doors 4–5 tall, halls 7–10 tall, walls 3–4 thick.
- Battered walls flaring at the base (bottom 4–6 blocks), towers taper upward, spires at 3–5× base width.
- Buttresses every 6–8 blocks, projecting 2, with spikes (`pointed_dripstone` or blackstone walls) on top.
- Bridges: 3–5 wide, arched spans with no rails or low `nether_brick_fence`.

## Palette
| Role | Blocks |
|---|---|
| primary | `polished_blackstone_bricks`, `nether_bricks`, `red_nether_bricks`, `blackstone` |
| secondary | `polished_basalt`, `basalt`, `crimson_hyphae`, `crimson_planks`, `warped_planks`, `polished_blackstone` |
| accent | `gilded_blackstone`, `gold_block`, `crying_obsidian`, `magma_block`, `cinnabar_bricks`, `chiseled_nether_bricks`, `chiseled_polished_blackstone` |
| roof | `polished_blackstone_brick_stairs`, `polished_blackstone_brick_slab`, `nether_brick_stairs`, `red_nether_brick_stairs`, `crimson_stairs` |
| trim | `nether_brick_fence`, `polished_blackstone_wall`, `red_nether_brick_wall`, `iron_chain`, `crimson_fence` |
| glass | `red_stained_glass_pane`, `orange_stained_glass_pane`, `black_stained_glass_pane` |
| light | `shroomlight`, `soul_lantern`, `lantern`, `magma_block`, `soul_campfire`, `lava`, `ochre_froglight` |
| details | `weeping_vines`, `twisting_vines`, `crimson_roots`, `warped_roots`, `nether_sprouts`, `wither_skeleton_skull`, `respawn_anchor`, `lodestone`, `iron_chain`, `gold_block` |
| ground / foliage | `netherrack`, `crimson_nylium`, `warped_nylium`, `soul_soil`, `soul_sand`, `blackstone`, `nether_wart_block`, `warped_wart_block`, `crimson_fungus`, `warped_fungus` |

Mixes: walls `55%polished_blackstone_bricks,25%cracked_polished_blackstone_bricks,10%blackstone,10%gilded_blackstone`; brick `60%nether_bricks,25%red_nether_bricks,15%cracked_nether_bricks`; volcanic ground `50%blackstone,25%basalt,15%magma_block,10%netherrack`.

## Safety rules
- Lava must be contained on all sides and below by solid blocks; never adjacent to wooden blocks, never upstream of paths. Prefer lava behind `glass`/`orange_stained_glass_pane` windows or in sealed channels.
- Fire only on `netherrack` (eternal) or `soul_sand`/`soul_soil` (soul fire); keep away from wood, wool and leaves. Prefer `campfire`/`soul_campfire` for flame.
- `magma_block` damages players standing on it: use in walls, ceilings and under lava, not on walkways.
- Crimson and warped wood do NOT burn — the safe choice for wooden parts near lava/fire.

## Walls recipe
1. Battered base in `blackstone`/`basalt` mix, flaring with `polished_blackstone_brick_stairs` (facing toward the wall).
2. Main wall in the wall mix; vertical ribs of `polished_basalt` (axis=y) every 4 block, set 1 out.
3. Glowing seams: a 1-wide vertical slot of `magma_block` or `crying_obsidian` set 1 deep between ribs, or lava behind panes.
4. Top: jagged crenels of uneven heights (1–3), spikes of `polished_blackstone_wall` + `pointed_dripstone[vertical_direction=up]`.

## Roof recipe
- Steep spires (pitch 2:1 or steeper) in `polished_blackstone_brick_stairs`, facing toward the ridge; eaves with `nether_brick_stairs[half=top]` facing toward the wall; ridge spikes of `nether_brick_fence` + `iron_chain`.
- Flat fighting platforms with heavy parapets on bastions; hanging `soul_lantern[hanging=true]` from chains underneath overhangs.
- Organic variant: domes of `nether_wart_block` / `warped_wart_block` as fungal caps with `shroomlight` spots.

## Windows & doors
- Narrow tall slits (1×3) glowing red: `red_stained_glass_pane` with `shroomlight` or `lava` behind.
- Gates: 5–7 wide pointed arch, framed with `gilded_blackstone` and `chiseled_polished_blackstone`, portcullis of `iron_bars`, `crimson_door` or `warped_door`.

## Signature details
- Lava fall: lava source high in a wall niche falling into a contained basin of `blackstone`, lit and visible through panes.
- Treasure vault: `gold_block` piles (uneven heights), `gilded_blackstone`, chains, `wither_skeleton_skull` trophies.
- Fungal tree: `crimson_stem` trunk 2×2 bending, cap of `nether_wart_block` with `shroomlight` 10% and `weeping_vines` dripping 2–6 below.
- Brazier: `polished_blackstone_wall` post with `soul_campfire` on top or `magma_block` bowl framed by stairs.
- Basalt columns: clusters of `basalt`/`polished_basalt` pillars of random heights around the site.

## Layout ideas
- Bastion fortress (70×70): fortress on a basalt plateau, lava moat with a single bridge, central tall spire, treasure vault below.
- Infernal gate (25×35): giant portal frame of `crying_obsidian` + `obsidian` flanked by statues, braziers along an approach road.
- Fungal village: crimson-forest settlement of huts on stilts above soul-sand valleys.

## Avoid
- All-black monotony: mix blackstone with nether brick reds, gold and glow.
- Unsafe lava/fire next to paths or wood.
- Smooth regular shapes: jag, spike and tilt; this style rewards asymmetry and menace.
- Nether-only blocks that look odd in pristine overworld biomes without blending the ground (add blackstone/basalt/magma terrain transition).
