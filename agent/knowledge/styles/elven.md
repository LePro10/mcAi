# Fantasy / Elven

Graceful white-and-pale-wood architecture grown into nature: tall slender towers, curved verdigris roofs, bridges between giant trees, glowing flora. Pick it for elven cities, treehouse villages, sanctuaries, magical libraries. Reference: Rivendell, Lothlórien, high-fantasy server spawns.

## Signature features
- Verticality and slenderness: towers 3–5 wide reaching 25–40 high, spires with pointed tips.
- Organic curves everywhere: arched windows, curved bridges, round platforms; nothing boxy.
- Architecture *integrated* with giant trees: platforms wrap around trunks, stairs spiral around them, roots grip rocks.
- Pale stone and pale wood with green oxidized-copper roofs and gold accents.
- Soft light from froglights, end rods and glowing plants rather than torches.
- Water: cascades, pools, mist (falling water off platforms).

## Proportions & massing
- Towers: diameter 5–9 (odd), height 4–6× diameter; taper or step in 1 block every 8–10 blocks.
- Platforms: round/elliptical, radius 4–8, slab-thick (1 block) with `quartz_slab` or `birch_slab` edges and a balustrade.
- Giant trees: trunk diameter 5–9, height 40–70, canopy radius 12–20; buildings sit at 1/3 and 2/3 of trunk height.
- Bridges: 3 wide, span ≤ 25 between supports, sag/arch 2–4 blocks (catenary or arch curve).
- Storey height 5–6 (lofty), doorways 2×4 or 3×5 with pointed arch.

## Palette
| Role | Blocks |
|---|---|
| primary | `smooth_quartz`, `calcite`, `stripped_birch_wood`, `pale_oak_planks` |
| secondary | `birch_log`, `stripped_birch_log`, `pale_oak_log`, `stripped_pale_oak_log`, `diorite` |
| accent | `waxed_oxidized_copper`, `waxed_oxidized_cut_copper`, `prismarine`, `gold_block`, `chiseled_quartz_block` |
| roof | `waxed_oxidized_cut_copper_stairs`, `waxed_oxidized_cut_copper_slab`, `dark_prismarine_stairs`, `dark_prismarine_slab`, `birch_stairs` |
| trim | `quartz_pillar`, `quartz_slab`, `quartz_stairs`, `birch_fence`, `pale_oak_trapdoor`, `end_rod` |
| glass | `light_blue_stained_glass_pane`, `white_stained_glass_pane`, `glass_pane` |
| light | `pearlescent_froglight`, `verdant_froglight`, `end_rod`, `lantern[hanging=true]`, `glow_lichen`, `cave_vines[berries=true]` |
| details | `chiseled_bookshelf`, `spore_blossom`, `moss_carpet`, `vine`, `lily_of_the_valley`, `allium`, `azure_bluet`, `amethyst_cluster` |
| ground/foliage | `moss_block`, `grass_block`, `podzol`, `rooted_dirt`, `azalea_leaves`, `flowering_azalea_leaves`, `birch_leaves`, `mangrove_roots` |

Mixes: stone `70%calcite,20%smooth_quartz,10%diorite` · giant trunk `60%oak_wood,25%spruce_wood,15%jungle_wood` · canopy `55%azalea_leaves,25%flowering_azalea_leaves,20%birch_leaves` (all leaves persistent=true).

## Walls recipe
1. Frame: `quartz_pillar` (axis=y) or `stripped_birch_log` columns every 3–4 blocks on the outer plane; columns get a `quartz_stairs` capital (half=top) at the top.
2. Infill: `calcite`/`smooth_quartz` 1 block behind the columns; on round towers use the curved wall itself as infill and add thin vertical ribs of `stripped_birch_wood`.
3. Windows: tall and narrow (1×3, 1×4), with a pointed top made of two `quartz_stairs[half=top]` meeting; set 1 block deep.
4. Base: roots — `mangrove_roots`, `rooted_dirt`, `moss_block` creeping 1–3 blocks up the wall, plus `vine` and `glow_lichen` patches.
5. Gold sparingly: one `gold_block` keystone per arch or a thin band at a floor line — never large areas.

## Roof recipe
- Conical/spire roofs on round towers: roof op style cone on the tower box (overhang 1, flare for the flared eave, soffit, finial `end_rod`); height ≥ 2× radius (pitch ≥ 2).
- Curved "leaf" roofs on halls: ogee/bell profile — shallow at the eave, steep at the ridge; build in `waxed_oxidized_cut_copper_stairs`/`waxed_oxidized_cut_copper_slab`, stairs facing toward the ridge.
- Eave underside: `quartz_stairs[half=top]` facing toward the wall; or `birch_trapdoor` soffits.
- Ridge: `waxed_oxidized_cut_copper_slab` and periodic `end_rod` ridge spikes.

## Windows & doors
- Pointed arch openings with `light_blue_stained_glass_pane`; deep reveals lined with `quartz_slab` sills.
- Round windows (oculus 3×3 or 5×5 ring of `quartz_stairs`) on gables.
- Doors: `birch_door` or `pale_oak_door` inside a 3-wide pointed arch; flank with `flowering_azalea_leaves` and `lantern` on `birch_fence` posts.

## Signature details
- Spiral staircase around a giant trunk: 3-wide `birch_stairs`/`birch_slab` ring (use run_script spiral), `birch_fence` railing on the outer edge, `lantern[hanging=true]` every quarter turn.
- Hanging gardens: `cave_vines[berries=true]`, `vine`, `spore_blossom` under every platform and bridge — never a bare underside.
- Arched bridge: bridge op (profile arch, deck `birch_planks`, post `birch_fence`, lantern `end_rod`) on a `quartz_block` arch, `vine` dangling from solid faces only.
- Moonwell: round pool of `water` ringed by `quartz_slab`, `sea_lantern` under `lily_pad`s, `amethyst_cluster` crystals at the rim.
- Library alcove: `chiseled_bookshelf` walls, `lectern`, `candle[lit=true]`, `enchanting_table`.

## Layout ideas
- Treehouse village: 3–5 giant trees 25–35 apart, each with 2–3 round platform houses at different heights, linked by sagging rope bridges (`birch_fence` + `birch_slab`), a central great-tree hall with a spiral stair.
- Valley city: terraced platforms down a cliff with waterfalls between, slender towers on spurs, a main hall with a curved copper roof at the focal point.
- Forest shrine: circular colonnade (radius 7, `quartz_pillar` columns) around a moonwell, half swallowed by moss and azalea.

## Avoid
- Square boxes with white walls — elven means curves, verticality, nature.
- Large flat areas of quartz without columns, ribs or texture; add `calcite`/`diorite` mix.
- Torches; use hidden froglights and end rods.
- Floating platforms without visible support (brackets, branches, roots, chains).
- Bare tree trunks: add branches, roots, moss, vines, glow lichen.
