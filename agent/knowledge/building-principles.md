# Building principles — what separates a showcase build from an "AI box"

Read this once per job before designing. Numbers are defaults; break them on purpose, never by accident.

## 1. Silhouette & massing first
- A build is judged from 30 blocks away before anyone sees a detail. Design the **outline against the sky**: one dominant mass, 1–3 subordinate masses, varied heights. Rule of thumb: main volume 100%, wings 50–70% of its height, towers 130–200%.
- Never a single cuboid. Combine volumes: L, T, U, courtyard, offset stacks; a wing shifted 2–3 blocks back reads as depth.
- Upper floors may **jetty** (overhang 1 block per storey) — instant medieval character and shadow lines.
- Asymmetry with balance: a symmetric core facade is fine (temples, castles, modern villas), but break it with one asymmetric element (a tower, a chimney, a side porch, a tree).
- Odd widths (5, 7, 9, 11, 13…) give a true center block for doors, ridges, windows and spires. Gable roofs on odd widths get a clean 1-block ridge.

## 2. Scale (Minecraft player = 2 blocks tall)
| element | good default |
|---|---|
| door | 1×2 (cottage), 2×3 / 3×4 (hall, gate), 5–7 tall castle gate |
| storey height | 4–5 blocks floor-to-floor (3 inside + floor + 1 for beams); grand halls 6–10 |
| room | ≥5×5 interior; bedrooms 5×6, halls 9×15+, kitchens 6×7 |
| corridor | 3 wide (2 minimum), ceiling 3–4 |
| window | 1×2 cottage, 2×3 or 3×4 manor, 1-wide 4–8 tall gothic lancets |
| tower | diameter 7–11 (cylinder), 5×5 minimum for square towers; height ≥ 2.5× diameter |
| stairs | rise 1 per 1 run (stairs block), switchbacks need a 3×3 landing |
| tree | 8–14 tall normal, 20–40 "hero" tree; trunk 1 (small), 2×2 (normal), 3–5 thick with flares (hero) |
- Builds that are too small look like toys; builds too big look empty. Fill large footprints with *composition* (several buildings, courtyard, landscape), not with one huge box.
- Scale to the site and the request: "a house" ≈ 11×15 footprint; "a castle" ≈ 50×50+; "a village" ≈ 5–9 buildings on 80×80+.

## 3. Depth — walls are never flat
Every facade gets **at least three depth planes**:
1. **Frame plane** (0): pillars/logs at corners and every 3–5 blocks, horizontal beams at floor lines.
2. **Infill plane** (−1, recessed 1 block behind the frame): plaster, planks, brick, stone mix.
3. **Window plane** (−1 or −2): glass set one block deeper than the infill, or the infill recessed around it.
- Plus **protrusions** (+1): window sills (slabs/stairs half=top), shutters (open trapdoors), flower boxes, balconies, buttresses, bay windows, eave brackets.
- Corner pillars that stick out 1 block past both walls read as solid, expensive construction.
- Use slab/stair/wall/fence/trapdoor/button variants to get **half-block depth**: a row of upside-down stairs under the eaves, a stone wall cap on parapets, trapdoors as panelling, buttons as rivets.
- Base course: the bottom 1–2 rows of a wall differ (stone plinth under plaster, darker variant, stairs flaring out = "battered" base).

## 4. Roofs (the #1 quality signal)
- **Never make roofs from full blocks.** Use stairs for slopes, slabs for 1:2 pitches and ridges, full blocks only as hidden fill.
- Pitch: 45° (1:1 stairs) is the default; steep (2:1 rise, using stairs stacked on full blocks) for gothic/nordic/fantasy; shallow (1:2 using slabs alternating bottom/top) for mediterranean/japanese/modern.
- **Overhang** 1 block minimum (2 for japanese/nordic). Under the overhang put upside-down stairs (half=top, facing toward the wall) or trapdoors as soffit/brackets.
- **Gable ends**: inset the gable wall 1 block behind the roof edge; frame it with logs; add a round/arched attic window; optionally a decorative barge board of upside-down stairs following the slope.
- **Ridge**: cap with slabs (type=bottom on top of the last stair row) or walls/fences for a fine line; add finials (end_rod, lightning_rod, fence + lantern).
- **Break long roofs**: dormers every 5–7 blocks, cross gables, chimneys (2×2 or 1×2 brick/stone, extends 2–3 above ridge, campfire at top under a slab for smoke), height steps.
- Two-tone roofs: main stair family + a darker/lighter 10–20% scatter (e.g. dark_oak + spruce) or a contrasting trim row at the eave.
- **Staircase artifacts**: a straight stair slope over a wide roof looks like a staircase. Fix with: steeper pitch, mixing slabs between stair rows on long slopes, curved eaves (one row of slabs at the bottom), and texture scatter. Hip and gable intersections must use corner stairs — let the engine resolve shape (inner/outer) by placing adjacent stairs with correct facing.
- Interior: underside of the roof can be exposed (vaulted ceiling with beams) — great in halls.

## 5. Texture via gradients & weighted mixes
- 3–4 core blocks + 1–2 accents per material zone. One block alone = monotone; ten blocks = noise.
- Weighted mixes (pattern strings) for big surfaces: dominant 50–70%, secondary 20–30%, rare 5–10%. Example stone wall: 50% stone_bricks, 20% cracked, 15% mossy, 10% andesite, 5% cobblestone.
- **Gradients**: darker/mossier at the bottom (moisture), lighter/cleaner at the top. Use pattern type gradient on y for tall walls, towers and cliffs. Grime gradient on roofs from eaves up.
- Texture should follow logic: moss on north faces, near water, at the base; cracks near corners and doorways; soot (blackstone/deepslate) above fireplaces and chimneys.
- Noise patterns (scale 4–8) for organic patches (moss carpets, path wear, terrain); random mixes for small-scale grit.

## 6. Color theory
- Pick **value contrast** first (dark roof vs light wall, or dark frame vs light infill), then hue. Squint test: the facade must read in 3 values (dark/mid/light).
- Warm + cool pairing: warm wood/terracotta against cool stone/copper/deepslate.
- Accent color ≤ 10% of the visible surface (doors, banners, flowers, trim stripes).
- Nature is the 4th material: greenery should touch every building (vines, leaves, flower boxes, grass at the foundation).

## 7. Windows & doors
- Glass panes for thin frames (cottage, gothic); full glass blocks for modern/sci-fi curtain walls or when the window plane is deep.
- Set windows **one block deeper** than the wall; sill below (stair half=top facing into the wall or slab top), lintel above (stairs half=top, slab, or log axis horizontal).
- Shutters: open trapdoors left and right of the window, lying flat on the facade (see block-states.md for facing).
- Flower boxes: a trapdoor (open, flat against the wall) or a row of slab/stairs under the window with flowers/azalea on top (placed in the window's sill row).
- Group windows in rhythms (2-1-2, A-B-A) and align them vertically across storeys.
- Doors: always framed (logs/pillars at the sides, beam/arch above), a step or porch in front, a lantern next to it. Main entrance on the +z facade facing the player, widest and most decorated.

## 8. Foundations that grip the terrain
- Never let a building float or sit on a perfectly flat slab on a slope. Options: (a) stone plinth that extends **down to the ground at every column** (scan the heightmap, fill down to terrain + 1 block into it), (b) stilts/piers with braces, (c) terrace the terrain (retaining walls), (d) dig the building into the hill.
- Plinth is wider than the wall by 1 block (or flares with stairs), material darker than the walls.
- Blend: scatter coarse dirt, gravel, moss, short grass and stones around the base; no clean 90° cut between lawn and wall.

## 9. Organic shapes (trees, rocks, terrain)
- Trees: tapering trunks with root flares, 2–4 main branches that split again, **clustered** leaf blobs (ellipsoids/noise spheres around branch ends, not one big ball), persistent=true leaves, mix 2 leaf types (e.g. 80/20) for depth, hanging vines/moss underneath. Use run_script (cookbook) — never hand-place.
- Rocks: noisy ellipsoids with a stone gradient (stone, andesite, tuff, cobblestone, mossy_cobblestone at the top/north), half-buried, in groups of 1 big + 2–3 small.
- Terrain: soft slopes (max 1–2 blocks height change per step), carve rivers with sloped banks, scatter vegetation by noise, not uniformly.

## 10. Lighting hidden in the design (mob-proof)
- Light level ≥ 1 everywhere players walk prevents mob spawns (1.18+ spawn rule: block light 0 only). Spacing: a light source every ~10 blocks indoors, lanterns every 8–12 along paths.
- Hide light: under carpet/moss carpet (glowstone/shroomlight/froglight under a carpet), behind leaves, inside lampposts, in ceilings behind trapdoors, behind paintings/item frames, sea lanterns under water, light blocks are invisible but only use them if nothing else fits (they look like nothing in renders).
- Visible light should be *designed*: hanging lanterns on chains in halls, wall lanterns flanking doors, candles in clusters of 2–4 on tables, campfires in hearths, end rods as modern strips, froglights as warm/cool accents.

## 11. Storytelling details
- Every building has a purpose and an inhabitant: a blacksmith (anvil, blast furnace, lava, chains, tool racks via item frames), baker (smoker, hay, barrels, cake), librarian (lectern, bookshelves, chiseled bookshelves, candles), farmer (composter, hay, crops, fence pens).
- Wear: a broken fence segment, a cobweb in the barn corner, moss creeping on steps, leaf litter at doorways, a cart (barrel + fences) by the road.
- Paths connect doors to each other and to the edge of the site — follow desire lines (curved, wider at junctions), never straight lines between nothing.
- Edge treatment: the site ends in nature (bushes, fences, walls, trees), not a cliff of dirt.

## 12. Interiors (short — see the interior-designer agent)
- Floors: 2–3 plank/stone types in a pattern or rug (carpet) zones; ceilings with beams (logs axis horizontal) every 3–4 blocks.
- Furniture vocabulary: stairs + trapdoors = chairs/sofas; slabs/trapdoors on fences = tables; barrels/chests = storage; shelves (oak_shelf etc.) hold 3 items; bookshelves + lectern; beds with a chest at the foot; fireplaces (campfire, bricks, iron_chain/trapdoor hood); kitchens (smoker, furnace, cauldron sink, barrels, cake, decorated_pot).
- Leave a 1-block walking lane; no cramming.

## 13. Common AI-builder mistakes (check yourself against this list)
1. **Box with holes** — cuboid + door + windows + flat/pyramid roof. Fix: massing, depth planes, real roof.
2. **Flat walls** — single plane, single block. Fix: frame/infill/window layers + texture mix.
3. **Roofs of full blocks** or roofs without overhang. Fix: stairs/slabs, ≥1 overhang, eave trim.
4. **Floating blocks/junk** — leaves without support, half-cleared terrain, stray blocks from overlapping ops. Fix: scan after each pass, clear outliers.
5. **Unconnected fences/panes/walls** — because neighbours were placed later or states were forced. Let the engine connect (don't hardcode north/east/... props).
6. **Wrong stair/trapdoor/door facings** — roofs rising the wrong way, chairs facing walls. Verify with render_view close-ups.
7. **Symmetric boredom** — perfectly mirrored everything. Add one asymmetric feature.
8. **Monotone materials** — one plank everywhere. Use mixes and a second material for structure.
9. **Ignoring terrain** — flattening everything to a pad, or floating over slopes. Adapt the foundation; keep natural features (trees, cliffs, water) as part of the composition.
10. **Empty interiors** behind big windows — renders and players see inside. Furnish anything visible.
11. **No lighting** → mobs spawn inside; or torch spam. Design light in.
12. **Building on the player / blocking the entrance** — keep the player's position and a path to the door free.
13. **Leaves decaying** — always persistent=true.
14. **Ugly transitions** — wall meets roof with a gap, path ends abruptly, water edge with straight sand line. Inspect seams.
