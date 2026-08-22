# The Blueprint format

A blueprint describes a structure as intent. The compiler turns it into voxels,
merges those into maximal runs of identical material, and emits one Minecraft
command per run.

Nothing here is required reading to use mcAI — the model writes blueprints for
you. It matters if you want to hand-write a structure, add one to
`blueprints/`, or understand what the model is producing.

```sh
mcai render blueprints/mine.json --ascii     # check a file
mcai prompt                                  # the reference the model works from
```

## Document

```json
{
  "name": "gatehouse",
  "palette": "gothic",
  "materials": { "roof": "blackstone" },
  "seed": 7,
  "parts": [ ... ]
}
```

| field | meaning |
| --- | --- |
| `name` | Shown in chat and the dashboard. |
| `palette` | Style name, or an inline `{slot: material}` map. |
| `materials` | Slot overrides layered on top of the palette. |
| `seed` | Makes material mixes and `scatter` reproducible. |
| `parts` | The structure. Required. |

## Coordinates

Part coordinates are **relative to the build origin**, which the daemon picks
from the survey (in front of the player, on the ground) unless you pass one.

```
[0,0,0]  the floor at the min corner
  +X     east        +Y  up        +Z  south
```

Negative coordinates are fine and often useful — a foundation at `[-1,0,-1]`
that is two blocks wider than the walls above it reads as a plinth.

Later parts overwrite earlier ones. `"mode": "keep"` writes only where the
blueprint has nothing yet, which is how you add corner beams over a wall
without erasing the wall.

## Materials

Three forms:

```json
"block": "stone_bricks"
"block": "@wall"
"block": { "mix": ["stone_bricks", "mossy_stone_bricks"], "weights": [0.8, 0.2] }
```

A `@slot` resolves through the palette, so the same blueprint works in every
style. Slots: `@base` `@stone` `@wall` `@accent` `@trim` `@roof` `@roof_stairs`
`@floor` `@glass` `@light` `@door` `@fence` `@path` `@pillar` `@detail`.

`@stone` is structural masonry, `@wall` is the primary surface. A cottage's
walls are timber and its footings are stone; a castle is `@stone` throughout.
Getting this backwards is how you end up with a wooden castle.

A mix is resolved by hashing the coordinate, not by rolling dice, so a build is
identical every time you compile it. Neighbouring blocks share a draw (a 2×1×2
blob by default) — per-block noise looks similar and costs several times as
many commands, because nothing can merge.

## Ops

### Solids

| op | fields |
| --- | --- |
| `box` | `at`, `size` |
| `shell` | `at`, `size`, `thickness?`, `open?` |
| `walls` | `at`, `size`, `thickness?` |
| `frame` | `at`, `size`, `thickness?` |
| `pyramid` | `at`, `size`, `step?`, `hollow?` |

`shell` is a hollow cuboid; `open` removes faces, e.g. `["top","bottom"]` for a
tube. `walls` is that common case named. `frame` draws only the twelve edges —
corner posts and beams.

**Rooms must be hollow.** `walls` or `shell`, never `box`.

### Curves

| op | fields |
| --- | --- |
| `cylinder` | `at`, `r`, `h`, `axis?`, `hollow?`, `thickness?`, `r2?` |
| `sphere` | `at`, `r`, `hollow?`, `thickness?`, `half?` |
| `cone` | `at`, `r`, `h`, `hollow?`, `thickness?` |

`at` is the min corner of the bounding box, not the centre. A cylinder of
radius 4 occupies 9 blocks across. `r` on a sphere may be `[rx, ry, rz]` for an
ellipsoid; `half` is `"dome"` or `"bowl"`.

A cone reads as a spire at roughly `h = 2r`. At `h = r` it is a mushroom.

### Roofs

```json
{ "op": "roof", "at": [0, 6, 0], "size": [9, 1, 11],
  "kind": "gable", "axis": "z", "pitch": 1, "overhang": 1,
  "stairs": "@roof_stairs", "gableBlock": "@wall", "ridge": "@roof" }
```

`kind` is `gable`, `hip`, `pyramid`, `flat`, `dome`, `cone` or `pagoda`.
`pitch` is rise per horizontal block; 1 is 45°.

Stairs get their `facing` set correctly — pointing uphill, toward the ridge.
This is not cosmetic: stairs facing the other way leave a half-block gap at
every step, and a roof built that way looks visibly generated. If you place
stair blocks yourself, face them uphill.

`size[1]` is ignored except for `flat`; the height comes from the pitch.

### Openings and detail

| op | fields |
| --- | --- |
| `arch` | `at`, `span`, `h`, `depth?`, `axis?`, `cut?` |
| `battlements` | `at`, `size`, `height?`, `width?`, `gap?` |
| `spiral` | `at`, `r`, `h`, `turn?`, `cw?`, `stairs?` |
| `windows` | `at`, `size`, `sides?`, `win?`, `spacing?`, `glass?` |
| `door` | `at`, `facing`, `width?`, `height?`, `door?` |
| `line` | `from`, `to`, `thickness?` |
| `set` | `at` |
| `scatter` | `at`, `size`, `density?` |
| `clear` | `at`, `size` |

`arch` with `"cut": true` carves the opening out of what is already there,
which is how you put a gate through a wall you have just built. Without it, it
draws the ring.

`windows` spaces openings along a wall run and fills them with `glass`. Pass
the same `at` and `size` as the `walls` op it belongs to.

`spiral` fits inside a shaft of radius `r`; `turn` is blocks of rise per full
turn. Around 10 is walkable.

`scatter` is deterministic — same seed, same rubble.

### Terrain

```json
{ "op": "foundation", "at": [0, 0, 0], "size": [17, 21], "depth": 4, "block": "@base" }
```

Note `size` is `[width, depth]` here — two numbers, not three. Each column runs
from the ground under it up to the pad, so the building sits level on sloped
terrain instead of floating or being half-buried. `clearAbove` also removes
whatever is standing on the site.

### Transforms

```json
{ "op": "group",    "at": [10, 0, 0], "rotate": 90, "mirror": "x", "of": [ ... ] }
{ "op": "repeat",   "count": 6, "step": [5, 0, 0], "rotateStep": 0, "of": [ ... ] }
{ "op": "symmetry", "axis": "xz", "about": 20, "of": [ ... ] }
{ "op": "prefab",   "name": "tower", "at": [0, 0, 0], "rotate": 180, "params": { "h": 30 } }
```

Rotations are 0, 90, 180 or 270 and rotate block states along with geometry —
a stair facing north inside a group rotated 90° comes out facing east.

`symmetry` keeps the original and adds mirrored copies about the plane at
`about`. `"xz"` gives all four quadrants, which is the four corner towers of a
castle written once.

## Limits

- A single `/fill` covers at most 32,768 blocks; the compiler splits larger
  runs automatically.
- A blueprint is capped at 3,000,000 blocks and rejected before compiling if
  the estimate exceeds it.
- Sizes are at least 1 on every axis.
- `repeat` counts above 512 are clamped.

## Worked example

A two-storey watchtower with a walkway, on sloped ground:

```json
{
  "name": "watchtower",
  "palette": "medieval",
  "parts": [
    { "op": "foundation", "at": [0, 0, 0], "size": [9, 9], "depth": 4, "block": "@base" },
    { "op": "box", "at": [0, 0, 0], "size": [9, 1, 9], "block": "@floor" },

    { "op": "walls", "at": [0, 1, 0], "size": [9, 14, 9], "block": "@stone", "thickness": 1 },
    { "op": "frame", "at": [0, 1, 0], "size": [9, 14, 9], "block": "@pillar", "mode": "keep" },
    { "op": "box", "at": [1, 7, 1], "size": [7, 1, 7], "block": "@floor" },
    { "op": "clear", "at": [1, 7, 1], "size": [2, 1, 3] },

    { "op": "windows", "at": [0, 1, 0], "size": [9, 14, 9], "win": [1, 2], "spacing": 4, "glass": "@glass" },
    { "op": "door", "at": [4, 1, 8], "facing": "south", "door": "@door" },
    { "op": "spiral", "at": [1, 1, 1], "r": 3, "h": 13, "turn": 10, "stairs": "@roof_stairs" },

    { "op": "box", "at": [-1, 15, -1], "size": [11, 1, 11], "block": "@floor" },
    { "op": "battlements", "at": [-1, 16, -1], "size": [11, 2, 11], "height": 2, "width": 1, "gap": 1, "block": "@stone" },
    { "op": "repeat", "count": 3, "step": [0, 5, 0], "of": [
      { "op": "set", "at": [4, 4, 4], "block": "@light" }
    ]}
  ]
}
```

```
$ mcai render docs/watchtower.json
  watchtower  1,021 blocks · 247 commands · 4.1 blocks/cmd · 23ms
  11 x 21 x 11 blocks
```

## Debugging

`mcai render` prints warnings for anything suspicious — unknown block ids,
auto-corrected spellings, parts skipped for a missing field, a blueprint over
budget. The `build` tool returns the same list, so the model sees them too.

An unknown block id is not fatal. mcAI repairs the common mistakes
(`stone_brick` → `stone_bricks`, `spruce_stair` → `spruce_stairs`,
`wooden_door` → `oak_door`) and passes anything else through so the server's
own error tells you what it rejected.
