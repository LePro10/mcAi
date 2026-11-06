# Japanese (Edo town, temples & shrines)

Dark timber frames, white plaster, layered tile roofs with upturned eaves, stone lanterns, gravel gardens and cherry trees. Pick it for temples, pagodas, shrines, castles (tenshu), tea houses, onsen, Edo streets. Reference: Kyoto machiya, Himeji, Kiyomizu-dera, Fushimi Inari.

## Signature features
- **Roofs dominate**: large, heavy, layered, overhanging 2–3 blocks, with curved/upturned corners.
- Exposed post-and-beam frame of dark wood with white or pale infill panels (shoji/plaster).
- Raised floors on a stone base (engawa veranda around the building).
- Horizontal emphasis for houses; vertical stacking for pagodas (3/5 tiers, each smaller).
- Red lacquer (vermilion) for shrines and torii only; houses are dark wood + white.
- Gardens: raked gravel, moss, stepping stones, koi pond, bamboo, stone lanterns, maples/cherries.

## Proportions & massing
- Houses: footprint 9×13 to 13×17, wall height 4–5, roof as tall as the walls or taller.
- Pagoda: 5–7 wide base, 5 tiers, each tier 4–5 high, each roof 1 block narrower per side; spire (sorin) of `iron_chain`/`lightning_rod` rings on top.
- Castle keep: stone base with battered (sloped) walls 6–10 high, then 3–5 white storeys each with its own roof skirt.
- Torii: posts 2 apart minimum (5–7 wide gate), height 6–9, top beam overhangs 1–2 each side.
- Eave overhang 2–3 blocks; corners lift 1–2 blocks over the last 3–4 blocks of the eave.

## Palette
| Role | Blocks |
|---|---|
| primary (infill) | `white_terracotta`, `calcite`, `birch_planks`, `mushroom_stem` |
| secondary (frame) | `dark_oak_log`, `stripped_dark_oak_log`, `spruce_log`, `stripped_spruce_log`, `dark_oak_planks` |
| accent | `red_terracotta`, `red_concrete`, `bamboo_block`, `gold_block` (temple finials only) |
| roof | `deepslate_tile_stairs`, `deepslate_tile_slab`, `polished_blackstone_stairs`, `polished_blackstone_slab`, `dark_oak_stairs` |
| trim | `dark_oak_fence`, `dark_oak_slab`, `spruce_trapdoor`, `birch_trapdoor`, `dark_oak_trapdoor` |
| glass | `white_stained_glass_pane`, `glass_pane` |
| light | `lantern`, `lantern[hanging=true]`, `soul_lantern`, `candle[lit=true]`, `ochre_froglight` |
| details | `bamboo`, `stone_brick_wall`, `pink_petals`, `lily_pad`, `potted_bamboo`, `moss_carpet`, `bell`, `decorated_pot`, `red_banner` |
| ground/foliage | `gravel`, `moss_block`, `coarse_dirt`, `andesite`, `cherry_leaves`, `azalea_leaves`, `dark_oak_leaves`, `fern` |

Mixes: tatami floor `70%bamboo_mosaic,30%stripped_bamboo_block` · garden path `45%gravel,25%andesite,15%stone,15%moss_block` · stone base `50%stone,25%andesite,15%cobblestone,10%mossy_cobblestone`.

## Walls recipe
1. Stone base 1–2 high (`stone`/`andesite` mix) set 1 block inside the veranda edge; veranda deck of `dark_oak_slab` (type=top at floor level) with `dark_oak_fence` railing on temples.
2. Frame on the outer plane: `stripped_dark_oak_log` posts every 3–4 blocks (axis=y), horizontal beams at floor, mid-wall (nageshi) and top.
3. Infill flush or 1 block behind: `white_terracotta`/`calcite` for plaster; sliding-door panels of `birch_trapdoor` (closed, half=bottom/top stacked) or `white_stained_glass_pane` framed in dark wood for shoji.
4. Lower 1 block of each panel in `dark_oak_planks` (wainscot) on houses.
5. Castle base: battered stone wall — each 2–3 rows step in 1 block using `stone_brick_stairs` facing toward the wall at the step.

## Roof recipe
- Irimoya (hip-and-gable) or hip roof, pitch shallower at the eave and steeper toward the ridge (curved profile: slabs → stairs → stairs+full blocks).
- Upturned corners: along the last 3–4 eave blocks near each corner, raise the eave line by 1 then 2 (slab steps), ending with a `deepslate_tile_stairs` corner tip; use run_script for clean curves.
- Ridge: thick ridge of `deepslate_tile_slab` (type=double/full) with `deepslate_tile_stairs` end ornaments, or `polished_blackstone_wall` caps.
- Eave fascia: `dark_oak_trapdoor` (closed, half=top) on the eave edge; rafter tails `dark_oak_stairs[half=top]` facing toward the wall underneath.
- Gable (irimoya) triangle: dark wood lattice of `dark_oak_trapdoor`/`dark_oak_fence` over white.

## Windows & doors
- Wide horizontal openings with `white_stained_glass_pane` or lattice of `spruce_trapdoor`; no small "Western" windows.
- Machiya street front: vertical lattice of `dark_oak_fence` in front of glass panes, `dark_oak_slab` awning skirt over the ground floor.
- Doors: open framed openings 2–3 wide with `bamboo_door` / `spruce_door`, or noren cloth = `white_banner`/`blue_banner` hung in the lintel.

## Signature details
- Torii: two `red_concrete` posts (or `red_terracotta`), black top beam (kasagi) of `polished_blackstone_slab`/`black_concrete` with upturned ends, second beam (nuki) of `red_concrete` below it, sign plaque in the middle.
- Stone lantern (toro): `stone_brick_wall` post → `andesite_slab`/`chiseled_stone_bricks` box with `lantern` inside → `stone_brick_stairs` hat → `stone_button` tip.
- Zen garden: raked `gravel` field, 2–3 mossy boulders (`mossy_cobblestone`, `andesite`, `moss_block`), `moss_carpet` islands.
- Koi pond: irregular `water` with `lily_pad`, stepping stones (`andesite_slab`), arched red bridge (`red_concrete_slab`/`red_concrete_stairs`, `dark_oak_fence` rails).
- Shishi-odoshi: `bamboo` + `water` cauldron detail beside a path.

## Layout ideas
- Shrine approach: path of 6–10 torii in a row (tunnel effect) up stone steps, purification basin (`water_cauldron[level=3]` under a small roof), main hall at the top (−z), lanterns flanking the path.
- Temple compound: walled courtyard (clay wall with tile cap), gate house, 5-tier pagoda off-axis, main hall on axis, garden with pond.
- Edo street: 5-wide gravel street lined with 2-storey machiya (7 wide, gable to street), shop banners, a bridge over a canal.

## Avoid
- Red everywhere — vermilion is for shrines/torii; houses are dark wood + white.
- Thin roofs with no overhang; Japanese roofs are big and heavy with 2–3 block eaves.
- Straight 45° roof edges without the upturn at the corners.
- Glass blocks and modern lights; use paper-like panes and lanterns.
- Symmetric "Western" gardens; Japanese gardens are asymmetric and naturalistic.
