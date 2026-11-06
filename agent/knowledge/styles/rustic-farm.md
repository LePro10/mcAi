# Rustic Farm

Working countryside: gambrel barns, farmhouses with porches, silos, windmills, fenced pastures and crop fields (American heartland, Bavarian Hof, English farmstead). Pick for plains, "farm", "ranch", "barn", "village", "homestead".

## Signature features
- Big red/brown barn with a gambrel roof, white trim and X-braced doors — the hero.
- Farmhouse: 2 storeys, wraparound porch, chimney, dormers.
- Function everywhere: fields in rows with water channels, pens, hay stacks, tools, carts.
- Fences and paths tie the layout together; trees as windbreaks.
- Visible wear: mixed planks, mossy foundations, patched roofs.

## Proportions & massing
- Barn 11–15 wide × 17–25 long; walls 6–8 tall; gambrel roof: lower slope steep (2 up per 1 in) for 3–4 blocks, upper slope shallow (1 up per 2 in). Hayloft door centered high on the gable.
- Farmhouse 9×11 to 11×15, storeys 4, porch 3 deep with posts every 3.
- Silo: cylinder radius 2–3, 1.5–2× barn height, dome or cone cap.
- Fields: plots 9×9 with a central water source (hydrates a 9×9 area), separated by 1-wide paths.

## Palette
| Role | Blocks |
|---|---|
| primary | `oak_planks`, `spruce_planks`, `mangrove_planks` (barn red), `stripped_oak_log` |
| secondary | `oak_log`, `stripped_oak_log`, `spruce_log`, `birch_log` |
| accent | `birch_planks`, `stripped_birch_log` (white trim), `white_terracotta`, `red_terracotta` |
| roof | `dark_oak_stairs`, `dark_oak_slab`, `spruce_stairs`, `spruce_slab`, `mangrove_stairs` |
| trim | `oak_fence`, `spruce_fence`, `oak_trapdoor`, `spruce_trapdoor`, `stripped_birch_log` |
| glass | `glass_pane` |
| light | `lantern`, `torch`, `campfire` |
| details | `hay_block`, `composter`, `barrel`, `beehive`, `cauldron`, `water_cauldron[level=3]`, `pumpkin`, `carved_pumpkin`, `oak_fence_gate`, `grindstone`, `smoker`, `chest` |
| ground / foliage | `dirt_path`, `coarse_dirt`, `farmland`, `grass_block`, `rooted_dirt`, `wheat[age=7]`, `carrots[age=7]`, `potatoes[age=7]`, `beetroots[age=3]`, `sunflower`, `tall_grass` |

Mixes: path `60%dirt_path,30%coarse_dirt,10%rooted_dirt`; old plank wall `60%spruce_planks,25%oak_planks,15%stripped_spruce_log`; foundation `50%cobblestone,35%mossy_cobblestone,15%stone`.

## Walls recipe
1. Foundation: 1–2 courses of cobblestone mix, 1 wider than the wall.
2. Frame: `stripped_oak_log` corner posts and a horizontal beam at each floor line (axis along the wall), posts every 4–6.
3. Infill set 1 behind the frame: barn = `mangrove_planks`; farmhouse = `oak_planks` or `white_terracotta` plaster upstairs.
4. Barn trim: corners and door frames in `stripped_birch_log` / `birch_planks` (white), X-braces on doors with `birch_fence` or trapdoors.

## Roof recipe
- Barn gambrel: two pitches per side, stairs facing toward the ridge, `dark_oak_slab` ridge cap; eaves overhang 1 with `dark_oak_stairs[half=top]` facing toward the wall underneath; gable end in `mangrove_planks` with the hayloft door and a hoist beam (`oak_fence` + `iron_chain` + `lantern`).
- Farmhouse: 45° gable in `spruce_stairs`, 1 overhang, dormers 3 wide every 4 blocks, brick or cobblestone chimney (2×2) on the gable end with `campfire` inside.
- Porch: shed roof of `spruce_slab` at low pitch on `oak_fence` or `stripped_oak_log` posts.
- Patch the roof: mix 10% `spruce_stairs` into a `dark_oak_stairs` roof (same facing/half).

## Windows & doors
- 1×2 or 2×2 `glass_pane` windows, `spruce_trapdoor` shutters open against the wall, `oak_trapdoor` flower box below with flowers on top.
- Barn: 3–5 wide double doors made of `spruce_trapdoor`s or `spruce_door` pairs; sliding door look = trapdoor panel offset 1 to the side.

## Signature details
- Hay storage: `hay_block` stacks (axis mixed), loose in the loft; hay bales on a cart (`spruce_slab` bed, `oak_trapdoor` wheels).
- Windmill: 4-sail blades of `white_wool` on `stripped_oak_log` arms, tower tapered from 7 to 5 wide.
- Animal pens: `oak_fence` with gates, `water_cauldron[level=3]` trough, `composter`, scattered `hay_block`.
- Scarecrow: `oak_fence` post, `hay_block` body, `carved_pumpkin` head, arms of `oak_fence` sideways (or armor stand).
- Apiary: row of `beehive` on `spruce_slab` stands next to flower beds.

## Layout ideas
- Homestead (60×50): farmhouse near the road, barn behind at 90°, silo against the barn, 4 crop plots, pasture with pond, windbreak tree line, dirt path loop.
- Hillside vineyard farm: terraced fields with retaining walls, wine cellar dug into the slope.
- Village farm cluster: 3 small houses around a shared well and threshing yard.

## Avoid
- Square fields without water: crops need hydration — one water source per 9×9.
- Barn without trim or with a simple gable: the gambrel + white trim is the identity.
- Unconnected fences or fences floating over terrain dips — follow the ground.
- Unlit pastures (mobs spawn): hide lanterns on posts every 10–12 blocks.
