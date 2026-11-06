# mcAI v2 — Architecture & Contracts

> This document is the **shared contract** between all components. If you change an
> interface described here, update this file in the same change.

## 1. Big picture

```
 ┌──────────────────────── Minecraft 26.3 (Fabric) ────────────────────────┐
 │  mcai mod (Java 25)                                                     │
 │   • Architect's Wand item, /mcai commands, prompt GUI (client)          │
 │   • thin, fast world executor: read/write blocks on the server thread   │
 │   • bossbar / actionbar / chat / sounds / selection particles           │
 │   • WebSocket CLIENT  ──────────────┐                                   │
 └─────────────────────────────────────┼───────────────────────────────────┘
                                       │ ws://127.0.0.1:7878/mod  (JSON, §5)
 ┌─────────────────────────────────────▼───────────────────────────────────┐
 │  mcai engine (Node ≥ 22.18, TypeScript run natively, no build step)     │
 │   core/    block states, registry, shapes, patterns, transforms,        │
 │            schematics (.schem/.nbt), script sandbox, edit sessions/undo  │
 │   sim/     in-memory voxel world + terrain generator (SimBackend)       │
 │   render/  software ray-tracer → PNG (the agent can SEE its build)      │
 │   server/  HTTP+WS hub, MCP endpoint (/mcp), job manager, mod bridge     │
 │   agent/   spawns `claude -p` per build job, parses stream-json          │
 │   viewer/  three.js web viewer (live view of sim or real world)         │
 └─────────────────────────────────────▲───────────────────────────────────┘
                                       │ MCP (Streamable HTTP) /mcp
 ┌─────────────────────────────────────┴───────────────────────────────────┐
 │  Claude Code (headless, `claude -p`, Opus, effort medium)               │
 │   main agent = "Master Architect" + subagents (builder, landscaper,      │
 │   interior, detailer, critic) — all use the same mcai MCP tools          │
 └─────────────────────────────────────────────────────────────────────────┘
```

Design rules:

1. **All building intelligence lives in the engine.** The mod is a dumb, robust, fast
   executor. Everything that is testable without Minecraft is in the engine and is
   tested against the simulation.
2. **One `WorldBackend` interface** with two implementations: `SimBackend` (in-memory)
   and `ModBackend` (proxy over WebSocket to the Fabric mod). Every engine feature
   must work identically on both.
3. **Every world mutation goes through an `EditSession`** → undo/redo, block limits,
   region bounds, statistics, live viewer updates.
4. The engine is a single long-running process (`mcai serve`). The mod can auto-launch
   it. Claude Code connects to it via MCP over HTTP; no extra processes.

## 2. Repository layout

```
engine/                 Node package "mcai-engine" (ESM, TS executed natively by node)
  src/core/             pure logic, no I/O
  src/sim/              simulation backend + terrain
  src/render/           software renderer (PNG)
  src/assets/           asset loader (models, blockstates, textures) + cache
  src/server/           hub, MCP tools, mod bridge, REST API
  src/agent/            claude runner, prompts assembly, job manager
  src/viewer/           static web viewer (served by engine)
  src/cli.ts            `mcai` CLI entry
  test/                 node:test tests (*.test.ts)
mod/                    Fabric mod (Gradle + Loom), MC 26.3, Java 25
agent/                  agent workspace: system prompt, subagent defs, knowledge base
tools/                  dev tooling (verified Minecraft downloads, local maven mirror)
docs/                   architecture, user guide, screenshots
```

Run TS directly: `node src/cli.ts`. Imports MUST use explicit `.ts` extensions.
Only *erasable* TypeScript syntax (no `enum`, no `namespace`, no constructor
parameter properties). Type-check with `npm run check` (`tsc --noEmit`).
Tests: `npm test` (= `node --test test/`).

## 3. Core data types (engine/src/core/types.ts)

* `Vec3 = [number, number, number]` — integer block coordinates.
* `Box = { min: Vec3; max: Vec3 }` — **inclusive** on both ends, always normalized
  (min ≤ max per axis).
* **Block state string** (same syntax as `/setblock`):
  `namespace:id[prop=value,...]{snbt}`. Namespace defaults to `minecraft`.
  * Canonical form: namespace present, properties **sorted by name**, **all**
    properties of the block present (defaults filled from the registry), no spaces.
    Example: `minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]`
  * Optional block-entity data in SNBT after the properties, e.g.
    `minecraft:chest[facing=west,type=single,waterlogged=false]{Items:[...]}`.
  * `minecraft:air` is air. `cave_air`/`void_air` are treated as air for masks.
* **BlockRegistry** — JSON shape (identical whether it comes from mcmeta for the
  simulation or from the mod at handshake):

```jsonc
{
  "version": "26.3",
  "blocks": {
    "minecraft:oak_stairs": {
      "properties": { "facing": ["north","south","west","east"], "half": ["top","bottom"], ... },
      "default": { "facing": "north", "half": "bottom", ... },
      "mapColor": "#8f7748",        // optional, used by renderer fallback
      "solid": true,                // optional hint (isCollisionShapeFullBlock; ignored when physics exist)
      "tags": ["minecraft:stairs", "minecraft:mineable/axe"]   // optional
    }
  },
  "physics": { "format": 1, "classes": [...], "blocks": {...} }   // optional, see §5 "Registry physics"
}
```

* **BlockVolume** — dense volume of a box: `palette: string[]` (canonical states,
  index 0 is always `minecraft:air`) and `data: Uint16Array` indices, layout
  **x fastest, then z, then y**: `i = (y - min.y) * sx*sz + (z - min.z) * sx + (x - min.x)`.
* **EditBatch** — sparse list of changes:
  `{ palette: string[]; positions: Int32Array /* x,y,z triples */; states: Uint16Array }`.

## 4. WorldBackend (engine/src/core/types.ts)

```ts
interface WorldBackend {
  readonly kind: 'sim' | 'minecraft';
  info(): Promise<WorldInfo>;                 // { name, minY, maxY, seaLevel, mcVersion, dimension }
  registry(): Promise<BlockRegistry>;
  getBlocks(box: Box, dimension?: string): Promise<BlockVolume>;
  setBlocks(batch: EditBatch, opts?: SetBlocksOptions): Promise<SetBlocksResult>;
  heightmap(x0: number, z0: number, x1: number, z1: number,
            kind?: 'surface' | 'ocean_floor', dimension?: string): Promise<Int16Array>;
  biomes(box: Box, step: number, dimension?: string): Promise<{ palette: string[]; data: Uint16Array; step: number }>;
  entities(box: Box, dimension?: string): Promise<EntityInfo[]>;
  players(): Promise<PlayerInfo[]>;
  runCommand(cmd: string, opts?: { as?: string }): Promise<{ ok: boolean; output: string }>;
  notify(n: PlayerNotification): Promise<void>;   // chat / actionbar / bossbar / title / sound
}
interface SetBlocksOptions {
  dimension?: string;
  updateShapes?: boolean;   // default true: fences/panes/walls/stairs connect after placement
  animate?: 'none' | 'layers' | 'sweep';  // visual build order in the real game (sim ignores)
  maxPerTick?: number;
}
interface SetBlocksResult { placed: number; unchanged: number; failed: { index: number; reason: string }[];
                            previous: EditBatch /* same positions, previous states → undo */ }
```

The `ModBackend` maps each call 1:1 to a protocol message (§5).

## 5. Mod ↔ Engine protocol

Transport: WebSocket, engine is the server at `ws://127.0.0.1:<port>/mod`.
Auth: header `Authorization: Bearer <token>` (or `?token=`). Discovery: the engine writes
`~/.mcai/engine.json` = `{ "port": 7878, "token": "...", "pid": 123, "version": "2.0.0" }`.
The mod reads that file (or its own config) and connects; it reconnects with backoff.

Every message is a JSON object. Requests carry `id` (string); responses carry
`re` (the request id) and either `ok: true` + payload or `ok: false` + `error`.
Binary arrays are base64 of little-endian typed arrays.

### Mod → Engine (events / requests)
| type | payload |
|---|---|
| `hello` | `modVersion, mcVersion, world, serverType ('integrated'\|'dedicated'), registry (BlockRegistry incl. `physics`, see "Registry physics" below), dimensions: Array<string \| { id, minY, maxY, seaLevel? }>` (objects preferred; strings fall back to vanilla heights) → `{ engineVersion }` if it carries an `id` |
| `build_request` | `player: PlayerInfo, prompt, selection?: Box, anchor: Vec3, facing: 'north'\|'south'\|'east'\|'west', options: { style?, mode: 'build'\|'plan', size? }, size?: {x,y,z}` (the mod's prompt GUI: `style` ∈ medieval/fantasy/japanese/modern/steampunk/nordic/desert/gothic/cozy, omitted for "auto"; without a wand selection the chosen size preset S/M/L/XL = 16³ / 32×24×32 / 48×40×48 / 96×64×96 is sent as `options.size` + `size` **and** as `selection` = the preset box laid out like the engine's default box) → response `{ jobId, allowedBox, selection }` (or `ok:false, error` e.g. "already has an active job"). `selection` = the player's selection (primary build area, `null` without one); `allowedBox` = what the agent may edit: selection + `selectionMargin` (config, default 8) on every side, extended down to the lowest ground/water bed in the footprint (−2, ≤ 32 below the floor) and up to ≥ `minBuildHeight` (32) above the floor (the same extension applies to the default box without selection). The mod draws both (margin fainter). **anchor = the ground block the wand targeted** (local y=0 is that layer); facing = the player's horizontal look direction |
| `job_control` | `action: 'cancel'\|'undo'\|'redo'\|'confirm'\|'reject', player, jobId?` → `{ message, jobId? }`. Without jobId the player's active (or latest) job is used. undo/redo = the player's undo stack (a whole AI job is one step). confirm/reject answer a pending `ask_player` with "yes"/"no" |
| `player_reply` | `player, jobId?, text` (answer to an agent question; the agent asks in chat with numbered options → `/mcai reply <number or text>`) → `{ message }` |
| `tool_request` | `player, tool, args` — non-AI WorldEdit-style operations executed by the engine in world space with per-player clipboards: `copy`/`cut {selection, origin?}`, `paste {at, ignoreAir?}`, `rotate {degrees}`, `flip {axis:'x'\|'z'}`, `undo`, `redo`, `set {selection, block}` (block = pattern), `replace {selection, from (mask), block}`, `clear {selection}`, `stack {selection, count, direction}`, `move {selection, offset}`, `save {name, description?}`, `load {name}`, `list {query?}` → `{ message, ... }` |

### Engine → Mod (requests the mod must answer)
| type | payload → response |
|---|---|
| `get_blocks` | `dimension, box, blockEntities?` → `{ palette, data: b64(Uint16) }` (palette[0] = air; max 2^25 blocks). With `blockEntities: true` palette entries of block-entity blocks carry their SNBT (`minecraft:chest[...]{Items:[...]}`) |
| `set_blocks` | `dimension, palette, positions: b64(Int32 xyz), states: b64(Uint16), updateShapes, animate, maxPerTick` → `{ placed, unchanged, failed, previous: { palette, states: b64 }, shapeUpdates, ticks, ms, placeMs, shapeMs }` (max 4 194 304 blocks per message; the extra numbers are diagnostics) |
| `heightmap` | `dimension, x0,z0,x1,z1, kind` → `{ x0, z0, x1, z1, data: b64(Int16) }` — x fastest; Y of the highest non-air block (`ocean_floor`: highest non-fluid motion-blocking block); empty column → minY − 1 |
| `biomes` | `dimension, box, step` → `{ palette, data: b64(Uint16), step, size: [nx, ny, nz] }` — samples at `min + k·step` per axis, layout x fastest, then z, then y |
| `entities` | `dimension, box` → `{ entities: EntityInfo[] }` (players excluded, max 10 000; only entities in loaded chunks) |
| `players` | → `{ players: PlayerInfo[] }` |
| `command` | `command, as?` → `{ ok, output }` (engine enforces the allowlist; mod double-checks). A failed command answers `ok:false` **with** `output` (distinguished from a transport error, which has `error`); a mod-side rejection also has `error`. Runs as the server, or positioned/rotated as player `as`; permissions are capped at game-master level |
| `notify` | `PlayerNotification` (+ optional `subtitle` for `title`) → `{ delivered }` (number of players reached). `toast` = action bar + toast sound (vanilla has no server toasts) |
| `job_update` | `jobId, player, state ('queued'\|'thinking'\|'building'\|'reviewing'\|'done'\|'failed'\|'cancelled'), progress 0..1, stage, detail, costUsd` → `{}` — one boss bar per job, shown to `player` (re-attached when they rejoin), removed 3 s after a final state and on engine disconnect |
| `status` | → `{ tick, mspt, queuedTasks, jobBars, players }` — cheap health probe (mspt excludes mcAI's own end-of-tick work; use the tick rate) |

`PlayerNotification = { target: string /* player name or '@a' */, kind: 'chat'|'actionbar'|'title'|'toast'|'sound', text?: string /* plain or JSON text component */, sound?: string, options?: string[], actions?: ('undo'|'redo'|'cancel'|'viewer')[] }`

Chat buttons (mod): `options` are rendered as clickable answers `[1 …] [2 …] [Own answer…]` (→ `/mcai reply N`);
`actions` append `[Undo] [Redo] [Cancel] [Open viewer]`. Without these fields the mod falls back to
heuristics: a text with `1) a  2) b … /mcai reply` gets answer buttons, and the first `[mcAI] …` chat
message after the player's job reached done/failed/cancelled gets `[Undo] [Redo] [Open viewer]`.
The viewer link is `http://127.0.0.1:<engine port>/` in singleplayer (config `engine.viewerUrl` overrides;
hidden on dedicated servers by default).

Timeouts (engine side): 30 s default; get_blocks 30 s + 1 s per 20k blocks; set_blocks 60 s + 2 ms
per block per message; big set_blocks are split into messages of ≤ 200 000 blocks (each with its
own compacted palette); `failed[].index` refers to the position inside that message. A newer mod
connection replaces the older one (close code 4001). The engine pings every 30 s.

Block placement in the mod (`mod/…/world/PlaceBlocksTask.java`):

* Block requests run on the server thread, time-sliced at the end of each tick within a wall-clock
  budget (`tickBudgetMs`, default 15 ms, `config/mcai.json`), in two FIFO lanes: **reads**
  (`get_blocks`, `heightmap`, `biomes`) and **writes** (`set_blocks`, at most `maxPerTick` placements
  per tick, default 20 000). Reads never wait behind a long build (they get up to half the budget while
  writes are pending); a read sent while a write is still running may see part of it, so the engine
  awaits its own writes before reading (it does). `players`/`entities`/`status`/`notify`/`command`
  run between ticks and are never queued.
* **Chunks never block the server thread:** a task requests all chunks it needs up front with a
  non-persistent ticket (loading/generation happens on the chunk worker threads) and yields until they
  are ready; afterwards they stay loaded ~15 s for the engine's next request (a chunk that does not load
  within 60 s fails the task). Steps over 100 ms are logged (`mcai: slow … step`).
* **Paused singleplayer** (pause menu, window in the background with pause-on-lost-focus): the
  integrated server stops ticking, so the bridge keeps serving the engine by running the world work as
  server tasks between the skipped ticks; the world itself stays paused (the pause menu shows "mcAI
  keeps building while the game is paused").
* Phase 1 records the previous state (+ block-entity SNBT) of every position for `previous`, then
  places with flags `UPDATE_CLIENTS | UPDATE_SKIP_ALL_SIDEEFFECTS` (no neighbour updates, no drops,
  no onPlace side effects — sand does not fall, containers do not spill) and applies block-entity
  SNBT. Invalid states / out-of-height positions / positions beyond the world limit (±30 000 000) become
  per-index `failed` entries (boxes of `get_blocks`/`biomes`/`entities`/`heightmap` beyond it are rejected;
  the mod never requests chunks outside the world). Guarded palette entries also fail per index:
  command / structure / jigsaw / test blocks **with** block-entity data and any block entity whose data
  contains `run_command` — unless it is an exact copy (state + NBT) of a block the mod read from the world
  before (`previous` of an earlier `set_blocks`, `get_blocks` with `blockEntities`), so undo and
  copy/paste keep working. Config `allowCommandBlocks: true` lifts this.
* Phase 2 (`updateShapes`): vanilla `Block.updateFromNeighbourShapes` for every placed block, then
  for existing blocks adjacent to the batch. **A shape result is only accepted if it keeps the block
  id** — shape updates only change properties (fence/pane/wall connections, stair shapes,
  waterlogging), they never delete a block (a lone door half or a plant on stone stays). Boundary
  neighbours changed in phase 2 are not part of `previous`; undo with `updateShapes: true`
  re-derives them.
* `animate: 'layers'` orders by y, then distance from the batch's horizontal centre; `'sweep'` by
  y, x, z; `'none'` keeps the input order (later duplicates win).
* If the engine disconnects mid-job, running tasks still finish (the world stays consistent); their
  answers are dropped. The mod reconnects (1 s … 30 s backoff) and sends a fresh `hello`.
* Measured on the dedicated test server (`tools/mod-protocol-test.mjs`): 2 000 000 blocks in one
  37 MB message in ≈ 12 s at a steady 20 TPS (≈ 3.3 s of server-thread work spread over ~230 ticks).

### Registry physics (`registry.physics`, format 1)

The engine never guesses block shapes: sturdy faces, wall coverage, conductors etc. come from the real
block classes. The mod computes them per state in `RegistryDump.physics` (empty world, `BlockPos.ZERO`);
the simulation uses `engine/data/physics-26.3.json`, generated from the real 26.3 server classes by
`tools/vanilla-diff/gen-physics.mjs` (Probe.java). Both use the same algorithm
(`engine/src/core/physics.ts buildPhysicsTable`), and `tools/vanilla-diff.mjs --suite static` checks
both tables state by state against the real classes.

```jsonc
"physics": {
  "format": 1,
  "classes": [[63, 63, 63, 63, 63, 511], …],     // distinct facts: [full, center, rigid, collision, support, flags]
  "blocks": {
    "minecraft:stone": 0,                         // every state has class 0
    "minecraft:oak_stairs": {                     // only properties that change the facts, sorted by name,
      "p": [["facing", ["north","south","west","east"]], ["half", ["top","bottom"]], …],  // values as enumerated
      "c": [57, 58, …]                            // class per combination, mixed radix, first property slowest
    }
  }
}
```

* `full` / `center` / `rigid`: 6-bit masks of `isFaceSturdy(dir, SupportType.FULL|CENTER|RIGID)`;
  `collision` / `support`: `Block.isFaceFull(collisionShape|blockSupportShape, dir)`. Bit i =
  `Direction.values()[i]` = down, up, north, south, west, east.
* `flags`: 1 `isSolidRender`, 2 legacy `isSolid()`, 4 `isRedstoneConductor`, 8 `canBeReplaced`,
  16 `isCollisionShapeFullBlock`, 32 `isSignalSource`, 64 collision top face non-empty, 128
  `propagatesSkylightDown`, 256 bottom collision face covers `WallBlock.TEST_SHAPE_POST`, 512/1024/2048/4096
  … covers `TEST_SHAPES_WALL[north|south|west|east]` (a wall below gets a tall side).
* Class id −1 = the mod could not compute the state without a real world (modded blocks) → engine heuristics.
* Size: 1 286 blocks, 168 classes ≈ 165 kB of JSON (≈ 10 kB gzip) in a ≈ 920 kB hello registry. The mod
  computes it once per server start (≈ 0.3–0.9 s on the server thread, shape facts cached by identity) and
  reuses it for every hello.
* Backward compatible: without `physics` (older mods) the engine uses the bundled 26.3 table for the
  blocks it knows and id heuristics for the rest; with `physics`, blocks missing from it use heuristics.
  `Registry.physics(state)` exposes the facts; `isFullSolid` = all faces sturdy or a full-cube collision
  shape, `isTransparent` = `!isSolidRender`.

### Engine discovery & auto-start (mod)

The mod connects to the engine named in `~/.mcai/engine.json` (or `$MCAI_HOME/engine.json`; config
`engine.port`/`engine.token` override). It re-reads the file every 2 s while disconnected and reconnects
at once when the file changes. **Auto-start** (config `engine.autoStart`; default `true` in
singleplayer/LAN, `false` on dedicated servers): if no engine runs (no engine.json, or its `pid` is dead),
the mod starts one at server start. Command resolution:

1. config `engine.command` (a command line, e.g. `node /path/engine/src/cli.ts serve`);
2. env `MCAI_ENGINE` — an engine directory (→ `node <dir>/src/cli.ts serve`) or a command line;
3. **`~/.mcai/engine-path`** (written by `./mcai setup`): line 1 = absolute path of the engine directory,
   line 2 (optional) = absolute path of the `node` binary (launchers do not see the shell PATH) →
   `<node> <dir>/src/cli.ts serve` with the engine directory as working directory;
4. otherwise the player is told to run `./mcai setup`.

A leading bare `node` is located on PATH plus common install dirs (Homebrew, nvm, volta, fnm, …) and must
be ≥ 22.18; `claude` is looked up the same way (or `claudePath` in `~/.mcai/config.json`) — missing tools
are reported in the prompt GUI with exact fix instructions. The child gets PATH = node's dir + claude's
dir + the inherited PATH, output goes to `<game dir>/logs/mcai-engine.log`. An engine the mod started is
stopped when the game exits (dedicated: when the server stops); an engine that exits on its own is
reported ("stopped unexpectedly (exit code N) — see logs/mcai-engine.log").

## 6. Engine HTTP surface (127.0.0.1 only)

* `GET /` → web viewer. `WS /viewer` → live world/job stream for the viewer.
* `WS /mod` → mod bridge (§5).
* `POST /mcp` (+GET/DELETE per MCP Streamable HTTP) → MCP server. The job is
  identified by header `X-Mcai-Job: <jobId>`; auth via `Authorization: Bearer <token>`.
* `GET /api/status`, `GET /api/jobs`, `GET /api/jobs/:id[?log=N]`, `POST /api/jobs` (start a build
  from the viewer — simulated "wand": `{prompt, player?, anchor?, facing?, selection?, size?: "48x40x48",
  style?, mode?, model?, effort?, budgetUsd?}`), `POST /api/jobs/:id/cancel`, `POST /api/jobs/:id/reply {text}`,
  `POST /api/undo|redo {player}`, `GET /api/structures`, `GET /api/feedback?limit=`,
  `GET /api/blocks?box=x1,y1,z1,x2,y2,z2` (→ `{box, palette, data: b64 Uint16}`),
  `GET /api/render?box=…&view=&width=&height=&time=` (→ PNG), `GET /api/session` (→ `{token}`; same-origin only,
  used by the bundled viewer).
* Security: every request must carry `Host: 127.0.0.1:<port>`/`localhost:<port>` (DNS-rebinding guard).
  POSTs need the Bearer token or a same-origin `Origin`. `/mod` needs the token; `/viewer` the token
  (`?token=`) or a same-origin Origin. The token persists in `~/.mcai/token`; `engine.json` (0600) is
  removed on clean exit.
* MCP is stateless (one server + transport per POST; GET/DELETE → 405). Requests without
  `X-Mcai-Job` get an ad-hoc "Developer" job (manual sessions).
* `WS /viewer` protocol: engine → viewer events `{type:'hello', status, jobs}`, `{type:'job', job}`
  (JobSnapshot on every change), `{type:'agent', jobId, ev:{kind,line}}`, `{type:'blocks', dimension,
  palette, positions: b64 Int32, states: b64 Uint16}` (after every engine edit/undo), `{type:'mod',
  connected}`, `{type:'notify', target, kind, text}` (chat/actionbar sent to players). Viewer → engine requests `{id, type, ...}` answered with `{re: id, ok, ...}`:
  `status`, `jobs`, `get_blocks {box}`, `heightmap {x0,z0,x1,z1}`, `players`, `start_job {prompt,…}`,
  `cancel_job {jobId}`, `reply {jobId,text}`, `undo|redo {player}`.

## 7. Agent tools (MCP server name `mcai`)

Coordinates in tools are **world coordinates** unless `space: "local"` is given. Local
space = world space as seen by the player looking north: anchor = origin, +x = right,
+y = up, −z = forward (into the site), +z = toward the player (the front facade faces +z).
The engine rotates positions **and block states** into world space (pure rotation).

Perception: `get_context`, `scan_region`, `render_view` (returns PNG image),
`find_blocks`, `block_info`, `heightmap`.
Building: `build` (batched DSL ops, one undo step), `run_script` (sandboxed JS
generator), `terraform`, `place_prefab`, `clear`.
Clipboard/library: `copy`, `paste`, `stack`, `move`, `save_structure`,
`load_structure`, `list_structures`.
Control: `undo`, `say`, `progress`, `ask_player`, `finish`.
Extra: `command` (allowlisted commands, local coordinates rotated incl. Rotation/Facing NBT).
`scan_region` modes: summary | layers | surface | blocks | dark (spawnable dark spots).
Saved structures are stored in **local orientation** (front facing +z). All tools default to
`space: 'local'`. Every mutating call = one undo record; at job end the job's records are merged
into one per player. Exact schemas live in `engine/src/server/tools/*.ts` (the MCP tool
descriptions are the source of truth) and in `agent/TOOLS.md`.

## 8. Job lifecycle

`queued → thinking → building → (reviewing) → done | failed | cancelled`.
One active job per player (configurable global concurrency, default 2). A job = one
`claude -p` process, cwd `agent/`, MCP config pointing at `/mcp` with the job header,
`--strict-mcp-config`, built-in tools restricted to read-only + subagents, budget cap
`--max-budget-usd`. Exact invocation (agent/runner.ts): `claude -p --model <opus> --effort <medium>
--output-format stream-json --verbose --mcp-config <tmp file> --strict-mcp-config --setting-sources user
--no-session-persistence --tools Read,Glob,Grep,Task,Agent,TaskCreate,TaskUpdate,TaskList,TodoWrite
--allowedTools mcp__mcai,<same built-ins> --permission-mode dontAsk --max-budget-usd <n>
--append-system-prompt <agent/SYSTEM.md + job context> [--agents <agent/agents.json>]`, prompt on stdin.
(claude 2.1.318: subagent tool = `Task`, todo tools = `TaskCreate/TaskUpdate/TaskList`.) Env:
`MCP_TOOL_TIMEOUT=1200000`. The job's log is `~/.mcai/jobs/<id>.jsonl` (stream events + every tool call
with timing/blocks), summary `~/.mcai/jobs/<id>.json`; `finish(suggestions)` → `~/.mcai/feedback/<date>.jsonl`.
Config `~/.mcai/config.json`: `model, effort, fallbackModel, budgetUsd (10), maxBlocksPerJob, maxBlocksPerCall,
concurrency (2), jobTimeoutMin (45), commandAllowlist, port (7878), defaultSize {x,y,z} (48x40x48),
depthBelow (12), claudePath, claudeExtraArgs`. Default allowed box without selection: local
x ∈ [−w/2, w/2), y ∈ [−depthBelow, h), z ∈ [−(d−1−front), front] with front = min(8, d/6). stream-json events are mapped to `job_update` (stage text = the
agent's latest `progress()` call or summarized tool activity). Cancel = SIGTERM the
process group, the job's edits stay (player can `/mcai undo`). Every job is one undo
group per player; `undo` reverts the whole job.

## 9. Safety

* The engine binds 127.0.0.1 only; token required for /mod and /mcp.
* Region guard: each job has an allowed build box (selection, or anchor ± limits);
  edits outside are rejected with a clear error to the agent.
* Block limit per job (default 2 000 000), per call (default 500 000).
* Command allowlist (summon decorative entities, fillbiome, particle, playsound,
  time/weather only if enabled). Never: op/deop/stop/ban/kick/execute-as-others/etc. The mod re-checks
  it and also rejects non-decorative entity ids inside summon data (e.g. a TNT passenger).
* The mod does not create command-capable blocks for the engine (command/structure blocks with data,
  `run_command` signs, which run at game-master level for whoever clicks them) except as exact copies
  of existing blocks (§5, `allowCommandBlocks`).
* The script sandbox (`run_script`) runs in a separate Node child process per script with the
  permission model (`--permission`, fs read only for engine/src/core, no fs write / child
  processes / workers / network / addons) plus a `node:vm` context that only contains the
  script API; hard timeout (SIGKILL), heap cap and block cap (see core/script.ts).
