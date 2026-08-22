<div align="center">

# mcAI

**Say what you want. Watch it get built.**

A natural-language builder for Minecraft. Stand somewhere, type
`!build a huge castle on the hill`, and a castle appears — fitted to your
terrain, matched to your biome, in seconds, for fractions of a cent.

`npx mcai serve --sim` → try it in a browser with no Minecraft server at all.

</div>

---

## What it does

```
you:  !build a huge medieval castle
mcAI: Building castle: 53,619 blocks, 61×39×61, 2,949 commands.
mcAI: Done. 53,619 blocks · $0.0031. !undo if you hate it.
```

- **Terrain-aware.** Foundations follow the ground instead of floating over it
  or burying themselves in a hill.
- **Biome-aware.** A house in a taiga is spruce and turf; the same request in a
  desert is sandstone with a flat roof.
- **Fast.** A full castle is ~3,000 commands, not 53,000 — see
  [how](#how-it-is-fast) below.
- **Cheap.** Roughly 3,000–6,000 tokens for a custom build. Library structures
  cost nothing at all.
- **Reversible.** `!undo` restores the region exactly, block states and all.
- **Yours.** Styles and structures are JSON files you can edit.

## Install

```sh
npm install -g mcai      # or use npx mcai <command>
```

Needs Node 20+. That is the only requirement for the simulator.

### Try it without Minecraft

```sh
npx mcai serve --sim
```

Opens a dashboard at `http://127.0.0.1:8765` running a simulated world. Click a
structure, watch it build, see the isometric render. Nothing is installed and
nothing is downloaded.

Or stay in the terminal:

```sh
npx mcai sim "a huge castle" --out castle.svg
npx mcai bench
```

### Use it with a real server

Any Paper, Spigot, Fabric or vanilla server, 1.20+. Enable RCON in
`server.properties`:

```properties
enable-rcon=true
rcon.port=25575
rcon.password=pick-something
```

Then:

```sh
export RCON_PASSWORD=pick-something
export ANTHROPIC_API_KEY=sk-...        # optional, see Models below
npx mcai serve
```

Join the server and type `!build a wizard tower`. The dashboard is at
`http://127.0.0.1:8765`.

Run `npx mcai doctor` if something is not working — it checks the toolchain,
the model configuration, the compiler and the server connection, and tells you
which one is wrong.

## In-game commands

| command | what it does |
| --- | --- |
| `!build <anything>` | Build it. |
| `!undo` | Restore the region from before the last build. |
| `!cancel` | Stop the build in progress. |
| `!status` | Progress, totals, spend. |
| `!style <name>` | Force a style, or `!style auto` for biome matching. |
| `!list` | Structures that build instantly, no model needed. |

## Models

mcAI speaks two wire formats, which covers nearly everything. It picks up
whichever key you already have:

| provider | environment variable |
| --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Ollama (local, free) | `OLLAMA_HOST=http://127.0.0.1:11434` |

Override anything explicitly with `MCAI_PROVIDER`, `MCAI_MODEL`,
`MCAI_API_KEY`, `MCAI_BASE_URL`.

**With no model at all**, mcAI still works: any request naming a library
structure builds instantly and free. `!build castle`, `!build lighthouse`,
`!build japanese temple`.

## How it is fast

The obvious way to build with an LLM is to have it place blocks. That is what
this project used to do, and a castle cost tens of thousands of tokens and
tens of thousands of server commands.

mcAI does not do that. The model writes a **blueprint** — a small JSON document
describing intent — and a deterministic compiler turns it into blocks:

```json
{ "op": "cylinder", "at": [0, 0, 0], "r": 4, "h": 22, "block": "@stone", "hollow": true }
```

Eighty characters. 1,100 blocks. The compiler then merges those blocks into
maximal runs of identical material and emits one `/fill` per run, so a wall that
is 1,184 voxels becomes four commands instead of 1,184.

```
$ mcai bench

  structure      blocks   commands   blocks/cmd    ms   size
  ────────────────────────────────────────────────────────────────
  cottage           795        153          5.2    18   12x16x15
  castle         15,882      1,287         12.3   128   47x28x47
  pyramid         8,359        272         30.7    42   31x19x31
  ────────────────────────────────────────────────────────────────
  total          45,942      5,097          9.0   292
```

The model never sees a voxel. It writes about sixty lines of JSON for a castle.

Three other things matter for speed:

- **Pipelined RCON.** Commands go out in a window instead of one at a time
  waiting for each reply. Same work, a fraction of the wall clock.
- **Forceloaded chunks.** `/fill` fails silently outside a player's view
  distance. Every build loads its own footprint first and releases it after.
- **A three-tool surface.** `survey`, `build`, `prefab`. Tool schemas are sent
  on every request; twenty-six of them is a tax on every single call.

## Writing blueprints

You do not have to — the model does it — but the format is small enough to
write by hand, and a file in `blueprints/` becomes buildable by name.

```json
{
  "name": "gatehouse",
  "palette": "gothic",
  "parts": [
    { "op": "symmetry", "axis": "x", "about": 10, "of": [
      { "op": "cylinder", "at": [0, 0, 0], "r": 3, "h": 22, "block": "@stone", "hollow": true },
      { "op": "cone", "at": [-1, 22, -1], "r": 4, "h": 9, "block": "@roof" }
    ]},
    { "op": "box", "at": [7, 0, 2], "size": [7, 16, 3], "block": "@stone" },
    { "op": "arch", "at": [8, 0, 2], "span": 5, "h": 9, "depth": 3, "cut": true },
    { "op": "battlements", "at": [7, 16, 2], "size": [7, 2, 3], "block": "@stone" }
  ]
}
```

```sh
mcai render blueprints/gatehouse.json --ascii
```

Twenty-three ops: boxes, shells, cylinders, spheres, cones, pyramids, real
pitched roofs with correct stair facings, arches, battlements, spiral stairs,
windows, doors, scatter, terrain-following foundations, and `group` / `repeat` /
`symmetry` transforms.

Full reference: [`docs/blueprints.md`](docs/blueprints.md).

## Styles

Sixteen built in — medieval, cottage, modern, fantasy, japanese, viking,
desert, tropical, gothic, elven, dwarven, steampunk, futuristic, ruins, nether,
ice. Each maps semantic slots (`@wall`, `@roof`, `@stone`, `@glass`, `@light`)
to materials, so blueprints stay style-agnostic.

Materials can be weighted mixes, which is what stops walls looking flat:

```json
"stone": { "mix": ["stone_bricks", "cracked_stone_bricks", "mossy_stone_bricks"],
           "weights": [0.7, 0.18, 0.12] }
```

Chosen by a hash of the coordinate, so the same build always comes out the same
way. Drop your own file in `styles/` to add or override one:

```json
{ "extends": "medieval", "slots": { "wall": "quartz_block", "roof": "purpur_block" } }
```

## Use it from your own tools

mcAI is an MCP server, so Claude Code, Claude Desktop, Cursor or any MCP client
can build in your world:

```json
{
  "mcpServers": {
    "mcai": { "command": "npx", "args": ["-y", "mcai-mcp"] }
  }
}
```

Seven tools: `mc_survey`, `mc_build`, `mc_prefab`, `mc_preview`, `mc_undo`,
`mc_blueprint_help`, `mc_status`. `mc_preview` compiles and renders without a
server running, so a client can design offline.

The compiler is also a plain library with no dependencies and no I/O:

```js
import { compile, getPrefab, renderIsoSvg } from 'mcai/core';

const build = compile(getPrefab('castle', { size: 61 }), { origin: [0, 64, 0] });
console.log(build.commands.length, 'commands');
```

## Configuration

| variable | default | meaning |
| --- | --- | --- |
| `RCON_PASSWORD` | — | required for a real server |
| `MC_HOST` / `MC_PORT` | `127.0.0.1` / `25565` | Minecraft server |
| `RCON_PORT` | `25575` | RCON port |
| `MC_USERNAME` | `mcAI` | the bot's name |
| `MCAI_HTTP_PORT` | `8765` | dashboard and API |
| `MCAI_TOKEN` | — | require a token on the API |
| `MCAI_BATCH_SIZE` | `192` | commands per batch |
| `MCAI_BATCH_PAUSE_MS` | `40` | pause between batches |

The dashboard binds to loopback. It can place blocks and spend tokens, so set
`MCAI_TOKEN` before exposing it anywhere.

## Development

```sh
npm install
npm run build
npm test          # 135 tests, no network, no Minecraft
```

The test suite runs the whole pipeline against an in-memory Minecraft that
enforces the real limits — the 32,768-block `/fill` cap, unloaded-chunk
failures, unknown block ids — plus a real RCON server over a real socket. A
build that passes there passes on a server.

```
src/core/      compiler, shapes, palettes, prefabs, renderer (no I/O, isomorphic)
src/daemon/    RCON, bot, executor, site analysis, HTTP + dashboard
src/agent/     provider-agnostic LLM client and the build loop
src/mcp/       MCP server
src/sim/       simulated world, RCON server, mock LLM
web/           dashboard
```

## License

MIT. See [LICENSE](LICENSE).
