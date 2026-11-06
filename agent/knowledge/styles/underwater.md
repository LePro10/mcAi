# Underwater

Glass-domed habitats, sunken Atlantis temples, prismarine palaces and coral gardens. Pick for oceans, "atlantis", "aquarium", "submarine base", "mermaid", "ocean monument".

## Signature features
- Domes and tubes of glass revealing the sea; air pockets connected by tunnels.
- Prismarine and oxidized copper read as "aquatic"; gold accents for Atlantean grandeur.
- Soft glowing light everywhere (`sea_lantern`, `sea_pickle`, froglights) — the ocean is dark.
- Organic surroundings: coral reefs, kelp forests, seagrass, rock arches, sand dunes.
- Ruins variant: tilted columns, collapsed roofs, overgrown with coral and kelp.

## Proportions & massing
- Domes: radius 6–12, hollow, shell 1 thick of `glass` with a rib every 45° of `prismarine_bricks` or `waxed_oxidized_copper`.
- Tunnels: 3–5 wide, semi-circular glass, rings of ribs every 4.
- Temples: monumental and symmetrical, stepped pyramids/ziggurats, columns 2×2, 3–4× human scale.
- Keep 2–3 blocks of water above roofs so the build reads underwater, and leave the seabed visible around it.

## Palette
| Role | Blocks |
|---|---|
| primary | `prismarine_bricks`, `prismarine`, `dark_prismarine` |
| secondary | `waxed_oxidized_copper`, `waxed_oxidized_cut_copper`, `smooth_quartz` |
| accent | `tube_coral_block`, `brain_coral_block`, `horn_coral_block`, `fire_coral_block`, `bubble_coral_block`, `gold_block` |
| roof | `prismarine_brick_stairs`, `dark_prismarine_stairs`, `prismarine_slab`, `dark_prismarine_slab` |
| trim | `prismarine_wall`, `waxed_oxidized_copper_grate`, `waxed_oxidized_copper_bars`, `dark_prismarine_slab` |
| glass | `glass`, `light_blue_stained_glass`, `cyan_stained_glass` |
| light | `sea_lantern`, `sea_pickle[pickles=4,waterlogged=true]`, `glowstone`, `conduit`, `verdant_froglight` |
| details | `kelp`, `seagrass`, `tall_seagrass`, `tube_coral_fan`, `brain_coral_wall_fan`, `horn_coral`, `sponge`, `wet_sponge` |
| ground / foliage | `sand`, `gravel`, `clay`, `mud`, `kelp`, `tube_coral`, `brain_coral`, `bubble_coral`, `fire_coral` |

Mixes: walls `50%prismarine_bricks,35%prismarine,15%dark_prismarine`; reef bed `25%tube_coral_block,25%brain_coral_block,20%horn_coral_block,15%fire_coral_block,15%bubble_coral_block`; seabed `60%sand,25%gravel,15%clay`.

## Water rules (critical)
- Every non-full block placed in water must be waterlogged: `prismarine_brick_stairs[waterlogged=true]`, `dark_prismarine_slab[waterlogged=true]`, `prismarine_wall[waterlogged=true]`, `lantern[waterlogged=true]`, panes, fences, `iron_chain[waterlogged=true]` — otherwise it creates air bubbles.
- Live coral, coral fans, `kelp`, `seagrass` need water; above water use `dead_tube_coral_block`, `dead_brain_coral` etc.
- Air pockets: build the sealed glass shell first, then clear the inside to air, then furnish. Every opening must be sealed; doors/trapdoors do not hold water back reliably — use a 2-block airlock with glass or a waterlogged-free tunnel.
- `conduit` gives underwater breathing in a frame of prismarine (at least 16 blocks of prismarine family in a 5×5×5 cross frame around it).
- Bubble columns: `magma_block` under water pulls down, `soul_sand` pushes up — great elevators and fountains.

## Walls recipe
1. Base plinth `dark_prismarine` 1–2 high, footing buried 1 into the sand.
2. Walls in the wall mix with pilasters of `prismarine_bricks` every 4, capitals of `dark_prismarine_slab`.
3. Window bands of `glass` or `light_blue_stained_glass` set 1 deep, framed with `waxed_oxidized_cut_copper`.
4. Overgrowth: `brain_coral_wall_fan[waterlogged=true]` and `tube_coral_fan` on ledges, `kelp` columns against walls.

## Roof recipe
- Domes (half ellipsoid) in glass with copper/prismarine ribs and a `sea_lantern` oculus ring at the top.
- Temples: stepped roofs of `dark_prismarine_stairs[waterlogged=true]` facing toward the ridge, `gold_block` crown.
- Spires: thin cones of `prismarine_bricks` topped with `end_rod` (waterlog-free) or `lightning_rod[waterlogged=true]`.

## Windows & doors
- Large glass panels inside a rib grid (every 3–4 blocks), portholes: 3×3 glass ring with `waxed_oxidized_copper_grate` frame.
- Entrances: moon-pool in the floor (1-wide water hole into an air room — water stays as source if the pocket is sealed) or arched gateways for open temples.

## Signature details
- Kelp forest: columns of `kelp` 4–12 tall on sand in clumps, varied heights.
- Coral reef garden: mounds in the reef mix with fans and `sea_pickle` clusters (light), heights 1–4.
- Atlantis columns: 2×2 `prismarine_bricks` shafts with `gold_block` bands, some broken and toppled sideways.
- Aquarium tunnel: glass tube through a reef with `sea_lantern` floor strips.
- Light: sea pickles in groups of 4 every 6–8 blocks across the seabed; `sea_lantern` inside pillars.

## Layout ideas
- Research base (50×50): central dome r=10, 3 satellite domes r=6 joined by tunnels, moon-pool, conduit tower, reef ring.
- Sunken Atlantis (80×80): ziggurat temple on axis, avenue of columns, ruined houses, giant statue head, coral overgrowth gradient (heavier at the edges).
- Mermaid grotto: rock arches (noise sculpted `stone`/`prismarine`), glowing pickles and a throne.

## Avoid
- Forgetting waterlogged=true: air holes everywhere.
- A dome sitting on flat cleared seabed — blend the base with sand/gravel mounds and coral.
- Overusing `sea_lantern` on the exterior as a flat grid — cluster light like bioluminescence.
- Building in water too shallow: the player should look down on it or through water.
