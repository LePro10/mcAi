# Nordic / Viking

Heavy timber longhouses with turf roofs, stone footings, carved dragon gables, shields, smoke and snow. Pick it for viking villages, mead halls, harbours with longships, mountain outposts, winter builds. Reference: Skyrim (Whiterun/Riften), Valheim, Norwegian stave churches.

## Signature features
- Long, low halls with **huge roofs** reaching almost to the ground; turf/moss or wood shingle.
- Massive log construction: horizontal log walls with notched, protruding corners.
- Crossed carved bargeboards forming "dragon heads" at the gable peaks.
- Stone footings and rubble walls; heavy dark timber; few, small windows.
- Life signs: smoke holes, fires, hanging meat/hides, shields on walls, barrels, nets.
- Stave churches: multi-tiered steep roofs, dark wood, dragon finials.

## Proportions & massing
- Longhouse: 9–13 wide, 21–35 long (ratio ~1:3), walls 3–4 high, roof rising 6–9 above the walls.
- Roof pitch 45–60°, eaves dropping to 1–2 blocks above the ground, overhang 1–2.
- Log corners protrude 1 block beyond both walls.
- Mead hall (focal point): 15–19 wide, 41+ long, interior with 2 rows of log columns, central fire trench.
- Stave church: 9×9 core, 3–4 roof tiers each 2 blocks narrower, total height 25–35.

## Palette
| Role | Blocks |
|---|---|
| primary | `spruce_planks`, `stripped_spruce_log`, `spruce_log`, `spruce_wood` |
| secondary | `dark_oak_log`, `dark_oak_planks`, `stripped_dark_oak_log`, `stripped_spruce_wood` |
| foundation | `cobblestone`, `mossy_cobblestone`, `stone`, `andesite` |
| accent | `white_wool`, `red_wool`, `blue_wool`, `dark_oak_trapdoor`, `gold_block` (hall only) |
| roof | `spruce_stairs`, `spruce_slab`, `dark_oak_stairs`, `dark_oak_slab`, `moss_block`, `moss_carpet`, `grass_block` |
| trim | `spruce_fence`, `dark_oak_fence`, `spruce_trapdoor`, `cobblestone_wall`, `stripped_spruce_wood` |
| glass | `glass_pane` (sparingly) |
| light | `lantern`, `lantern[hanging=true]`, `campfire`, `wall_torch` |
| details | `barrel`, `hay_block`, `red_banner`, `white_banner`, `iron_chain`, `smoker`, `dragon_head`, `skeleton_skull`, `chest`, `snow`, `grindstone` |
| ground/foliage | `coarse_dirt`, `podzol`, `gravel`, `snow_block`, `spruce_leaves`, `fern`, `large_fern`, `sweet_berry_bush`, `moss_carpet` |

Mixes: footing `50%cobblestone,25%mossy_cobblestone,15%stone,10%andesite` · turf roof surface `60%moss_block,30%grass_block,10%coarse_dirt` · ground `40%coarse_dirt,30%podzol,20%gravel,10%dirt_path`.

## Walls recipe
1. Footing: 1–2 courses of the footing mix, projecting 1 block, partly buried.
2. Walls: horizontal `spruce_log` (axis along the wall) stacked; alternate courses with `stripped_spruce_log` for subtle banding.
3. Corners: `dark_oak_log` (axis=y) posts or crossed log ends protruding 1 block past both walls.
4. Gable walls: vertical `spruce_planks` above the wall line, inset 1 block behind the barge boards, with a `dark_oak_trapdoor` smoke vent near the peak.
5. Low walls only — the roof does most of the visual work.

## Roof recipe
- Steep gable on the long axis, eaves low. Shingle roof: `spruce_stairs` facing toward the ridge, alternating rows of `dark_oak_stairs` for texture.
- Turf roof: shape the roof in stairs, then lay `moss_block`/`grass_block` on the upper layer with `moss_carpet`, `short_grass`, `fern` sprinkled — ends of each slope finished with `spruce_stairs` so the turf edge looks contained.
- Crossed barge boards at each gable: two lines of `dark_oak_fence` or `dark_oak_stairs` following the rake, extending 2–3 blocks past the ridge to cross, topped with a `dragon_head` (or carved `dark_oak_stairs` + `spruce_trapdoor` beak).
- Ridge: `spruce_slab` line or a log ridge beam (`spruce_log` axis along the ridge) visible at both gables.
- Smoke hole: 1×2 gap at the ridge above the hearth with a mini roof of `spruce_slab`.

## Windows & doors
- Very few windows: 1×1 openings with `spruce_trapdoor` shutters (open, facing away from the wall), no glass or `glass_pane` only.
- Main door in the gable end (front, +z) under a covered porch: `spruce_door` pair framed by `dark_oak_log` posts, porch roof of `spruce_stairs`, steps of `cobblestone_stairs`.
- Shields beside the door: `red_banner`/`white_banner` on walls, or item frames with shields if entities are available.

## Signature details
- Longship: 25–35 long, hull curve (run_script) in `spruce_planks` with `dark_oak_planks` gunwale strake, `dragon_head` prow, mast of `spruce_log`, striped sail of `red_wool` + `white_wool`, oars of `spruce_fence`.
- Fire trench: central hearth 1×5 of `campfire`s sunk in a `cobblestone` frame, `iron_chain` + `cauldron` cooking pot above.
- Drying rack: `spruce_fence` frame with `hay_block`/`dried_kelp_block` and `iron_chain` hooks.
- Rune stone: 2×1×4 `mossy_cobblestone`/`stone` monolith with `chiseled_stone_bricks` face, `moss_carpet` at the base.
- Snow dressing: `snow` layers on roofs and ground (heights 1–3, more in corners), `powder_snow` drifts, `packed_ice` sparingly for frozen puddles and icicle accents under eaves.

## Layout ideas
- Fjord village: 5–8 longhouses fanning around a harbour, wooden pier (`spruce_planks` on `spruce_log` piles) with 1–2 longships, mead hall on the highest ground (focal point).
- Mead hall interior: 2 rows of `dark_oak_log` columns, fire trench, long tables (`spruce_slab` on `spruce_fence`), raised jarl's seat at the far end (−z), banners between columns.
- Mountain outpost: palisade of `spruce_log` (axis=y, top sharpened with `spruce_fence`), watchtower, 2 small houses, signal fire.

## Avoid
- Tall walls with small roofs — viking buildings are mostly roof.
- Large glass windows and light colors.
- Flat turf: always contain the turf edges and vary vegetation.
- Perfectly regular spacing; villages grow organically around the hall and harbour.
- Forgetting smoke: every hall gets a hearth and a smoke hole/chimney.
