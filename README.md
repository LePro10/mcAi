<div align="center">

# mcAI

**Say what you want. Watch it get built.**

A natural-language builder for Minecraft. Stand somewhere, type
`/mcai build a huge castle on the hill`, and a castle appears — fitted to your
terrain, matched to your biome, in seconds, for fractions of a cent.

Install is one jar in `plugins/`. No account, no login, and no API key required
to start.

</div>

---

## What it does

```
you:  /mcai build a huge medieval castle
mcAI: Building castle: 41,564 blocks, 67×52×67, 3,175 commands.
mcAI: Done. 44,611 blocks changed · $0.0031. /mcai undo if you hate it.
```

- **One jar.** Drop it in `plugins/`, start the server, build. The engine
  ships inside it.
- **Terrain-aware.** Foundations follow the ground instead of floating over it
  or burying themselves in a hill.
- **Biome-aware.** A house in a taiga is spruce and turf; the same request in a
  desert is sandstone with a flat roof.
- **Fast.** A full castle is ~3,000 commands, not 42,000 — see
  [how](#how-it-is-fast) below.
- **Cheap.** Roughly 3,000–6,000 tokens for a custom build. Library structures
  cost nothing at all.
- **Reversible.** `!undo` restores the region exactly, block states and all.
- **Any AI you like.** Fourteen providers, or a local model, or none.
- **Yours.** Styles and structures are JSON files you can edit.

## Get it running

### On a Minecraft server — one jar

Put **`mcAI.jar`** in your server's `plugins/` folder and start the server.

```
/mcai build a huge medieval castle on the hill
/mcai undo
```

That is the entire install. Paper, Spigot or Bukkit, 1.20+. No RCON, no
`server.properties` edit, no password to invent, no bot account, and the server
stays in online mode.

The jar carries the build engine inside it and unpacks it on first start, so
there is no second download and no `npm install`. The one thing it cannot bring
along is [Node 20+](https://nodejs.org) — install that on the machine, and mcAI
says so clearly in the console if you forget.

Fifteen structures build immediately, with no AI connected and no account.
For anything else, `/mcai setup` points you at the dashboard: pick one of
fourteen providers, paste a key, Save.

See [`plugin/README.md`](plugin/README.md) for commands, permissions and
configuration, or `cd plugin && ./build.sh` to build the jar yourself.

### On your own machine — no Minecraft at all

You need [Node 20+](https://nodejs.org). Nothing else.

```sh
git clone https://github.com/LePro10/mcAi.git
cd mcAi
npm install          # installs and builds
./mcai serve --sim   # dashboard at http://127.0.0.1:8765
```

A complete, working mcAI against a simulated world. Click a structure, watch it
build, look at the render. **No Minecraft, no Java, no API key, no account.**
This is also how the builder is developed and tested.

> `npx mcai` does not work yet — the package is not on npm. Clone it.
> Windows: use `node dist/cli/main.js` in place of `./mcai`.

### In a container instead

If you would rather nothing touched your machine, `compose.yaml` brings up a
Paper server and mcAI beside it:

```sh
docker compose up -d
```

Dashboard on `localhost:8765`, Minecraft on `localhost:25565`. Everything lives
in named volumes; `docker compose down -v` removes all of it.

### Connect an AI

Optional — fifteen structures build without one. For anything else:

```sh
./mcai setup
```

It lists every provider, takes your key, tests it against the real endpoint,
and saves it to `~/.mcai/config.json` with owner-only permissions. You can do
the same from the dashboard: **AI provider**, top right.

| | providers |
| --- | --- |
| **Hosted** | Anthropic · OpenAI · Google Gemini · OpenRouter · DeepSeek · Groq · Mistral · xAI Grok · Together · Fireworks · Cerebras |
| **Local, free** | Ollama · LM Studio |
| **Anything else** | any OpenAI-compatible endpoint |

`./mcai providers` lists them with notes. If you already export a key
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …) it is picked up
automatically and wins over the saved file, so containers and CI need no setup
step.

There is no mcAI account and no login. Your key goes to the provider you chose
and nowhere else.

### Without the plugin, over RCON

The plugin is the better path on any server that can run one: it is faster
(batched commands, server-side heightmaps) and there is nothing to configure.
RCON is still there for vanilla and Fabric servers, where a Bukkit plugin
cannot go.

Enable RCON in `server.properties`:

```properties
enable-rcon=true
rcon.port=25575
rcon.password=pick-something
```

Then:

```sh
export RCON_PASSWORD=pick-something
./mcai serve
```

Join the server and type `!build a wizard tower`.

Run `./mcai doctor` when something is wrong — it checks Node, the provider, the
key, the compiler, the build pipeline and the server connection, and tells you
which one failed.

## In-game commands

With the plugin, these are slash commands — `/mcai build`, `/mcai undo`. Over
RCON the bot listens for `!` in chat instead.

| command | what it does |
| --- | --- |
| `!build <anything>` | Build it. |
| `!undo` | Restore the region from before the last build. |
| `!cancel` | Stop the build in progress. |
| `!status` | Progress, totals, spend. |
| `!style <name>` | Force a style, or `!style auto` for biome matching. |
| `!list` | Structures that build instantly, no model needed. |

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
$ ./mcai bench

  structure      blocks   commands   blocks/cmd    ms   size
  ────────────────────────────────────────────────────────────────
  cottage           795        153          5.2    21   12x16x15
  castle         16,628      1,356         12.3   162   47x33x47
  pyramid         8,057        280         28.8    40   31x19x31
  ────────────────────────────────────────────────────────────────
  total          47,043      5,572          8.4   337
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
./mcai render blueprints/gatehouse.json --ascii
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
    "mcai": { "command": "node", "args": ["/absolute/path/to/mcAi/dist/mcp/main.js"] }
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
npm install       # also builds
npm test          # 167 tests, no network, no Minecraft
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
