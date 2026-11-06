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
      "solid": true,                // optional hints
      "tags": ["minecraft:stairs", "minecraft:mineable/axe"]   // optional
    }
  }
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
| `hello` | `modVersion, mcVersion, world, serverType ('integrated'\|'dedicated'), registry (BlockRegistry), dimensions[]` |
| `build_request` | `player: PlayerInfo, prompt, selection?: Box, anchor: Vec3, facing: 'north'\|'south'\|'east'\|'west', options: { style?, mode: 'build'\|'plan' }` → response `{ jobId }` |
| `job_control` | `action: 'cancel'\|'undo'\|'redo'\|'confirm'\|'reject', player, jobId?` |
| `player_reply` | `player, jobId, text` (answer to an agent question) |
| `tool_request` | `player, tool, args` — non-AI WorldEdit-style operations issued by commands (copy/paste/rotate/undo...) executed by the engine |

### Engine → Mod (requests the mod must answer)
| type | payload → response |
|---|---|
| `get_blocks` | `dimension, box` → `{ palette, data: b64(Uint16) }` |
| `set_blocks` | `dimension, palette, positions: b64(Int32 xyz), states: b64(Uint16), updateShapes, animate, maxPerTick` → `{ placed, unchanged, failed, previous: { palette, states: b64 } }` |
| `heightmap` | `dimension, x0,z0,x1,z1, kind` → `{ data: b64(Int16) }` |
| `biomes` | `dimension, box, step` → `{ palette, data: b64(Uint16) }` |
| `entities` | `dimension, box` → `{ entities: EntityInfo[] }` |
| `players` | → `{ players: PlayerInfo[] }` |
| `command` | `command, as?` → `{ ok, output }` (engine enforces the allowlist; mod double-checks) |
| `notify` | `PlayerNotification` → `{}` |
| `job_update` | `jobId, player, state ('queued'\|'thinking'\|'building'\|'done'\|'failed'\|'cancelled'), progress 0..1, stage, detail, costUsd` → `{}` (mod renders bossbar/actionbar) |

`PlayerNotification = { target: string /* player name or '@a' */, kind: 'chat'|'actionbar'|'title'|'toast'|'sound', text?: string /* plain or JSON text component */, sound?: string }`

Block placement in the mod: on the server thread, spread over ticks (`maxPerTick`, default
20 000), flags = no neighbour updates / no drops during placement, then a second pass
calling the vanilla shape update for placed blocks if `updateShapes`. Chunks are loaded
as needed. Block entity data (SNBT) is applied.

## 6. Engine HTTP surface (127.0.0.1 only)

* `GET /` → web viewer. `WS /viewer` → live world/job stream for the viewer.
* `WS /mod` → mod bridge (§5).
* `POST /mcp` (+GET/DELETE per MCP Streamable HTTP) → MCP server. The job is
  identified by header `X-Mcai-Job: <jobId>`; auth via `Authorization: Bearer <token>`.
* `GET /api/status`, `GET /api/jobs`, `POST /api/jobs` (start a build from the viewer —
  simulated "wand"), `POST /api/jobs/:id/cancel`, `GET /api/structures`, `GET /api/feedback`.

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
Exact schemas live in `engine/src/server/tools/*.ts` and in `agent/TOOLS.md`.

## 8. Job lifecycle

`queued → thinking → building → (reviewing) → done | failed | cancelled`.
One active job per player (configurable global concurrency, default 2). A job = one
`claude -p` process, cwd `agent/`, MCP config pointing at `/mcp` with the job header,
`--strict-mcp-config`, built-in tools restricted to read-only + subagents, budget cap
`--max-budget-usd`. stream-json events are mapped to `job_update` (stage text = the
agent's latest `progress()` call or summarized tool activity). Cancel = SIGTERM the
process group, the job's edits stay (player can `/mcai undo`). Every job is one undo
group per player; `undo` reverts the whole job.

## 9. Safety

* The engine binds 127.0.0.1 only; token required for /mod and /mcp.
* Region guard: each job has an allowed build box (selection, or anchor ± limits);
  edits outside are rejected with a clear error to the agent.
* Block limit per job (default 2 000 000), per call (default 500 000).
* Command allowlist (summon decorative entities, fillbiome, particle, playsound,
  time/weather only if enabled). Never: op/deop/stop/ban/kick/execute-as-others/etc.
* The script sandbox (`run_script`) runs in `node:vm` in a worker thread with a time
  limit and no access to `require`, `process`, network, or the file system.
