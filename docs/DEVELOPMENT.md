# Developing mcAI

## Repository layout

```
mcai                   launcher: setup / play / start / build / server / status / logs / jobs / feedback / …
engine/                Node ≥ 22.18 package, TypeScript run natively (no build step)
  src/core/            pure logic: block states, registry, shapes + build DSL, patterns/masks,
                       transforms, schematics, script sandbox, edit sessions / undo, support rules
  src/sim/             in-memory voxel world + terrain generator (SimBackend)
  src/render/          software ray tracer → PNG (render_view, /api/render)
  src/assets/          block models / textures (from misode/mcmeta, cached)
  src/server/          hub (HTTP + WebSocket), MCP tools (src/server/tools/*.ts), mod bridge, REST API
  src/agent/           `claude -p` runner, stream-json parser, job manager
  src/viewer/          three.js web viewer
  test/                node:test suites (*.test.ts)
agent/                 the builder agents' workspace: SYSTEM.md, agents.json (subagents), knowledge/
mod/                   Fabric mod (Java 25, Loom): src/main (common + server), src/client, src/gametest
scripts/               launcher internals: setup-client.mjs (launcher profile + Modrinth mods),
                       setup-server.mjs + server.sh (dedicated server), lib.sh, lib/common.mjs,
                       lan-proxy.mjs (optional, see README › Safety)
tools/                 mod dev tooling: verified Minecraft downloads + local mirror, test servers,
                       protocol test, fake engine, client game tests (see tools/README.md)
docs/                  ARCHITECTURE.md (contracts: protocol, tools, jobs; keep it in sync),
                       ENGINE-API.md, SETUP.md, BACKLOG.md, images/ (used by the docs),
                       showcase/ (AI builds + run summaries), renders/ (scratch output, gitignored)
```

`docs/ARCHITECTURE.md` is the contract between mod, engine and agent. If you change a message,
tool or default described there, update it in the same change.

## Tests

| What | Command | Needs |
|---|---|---|
| Engine unit + integration tests (sim backend, MCP, mod bridge with a fake mod, renderer, scripts) | `cd engine && npm test` | Node |
| Type check | `cd engine && npm run check` | Node |
| Mod compile (main, client, gametest source sets) | `cd mod && ./gradlew build` | Java 25 |
| Mod ↔ engine protocol against a **real dedicated server** (85 checks: registry, 100k-block builds, shapes, block entities, exact undo, allowlist, guarded blocks, malformed input, 2M-block performance, engine disconnect) | `tools/testserver.sh start && node tools/mod-protocol-test.mjs` | Java 25, Minecraft server jar (`tools/mc-fetch.mjs`), EULA |
| Real client: wand, prompt GUI, HUD, boss bar, chat buttons, pause, German UI, engine crash; `--dedicated` adds the multiplayer permission test | `tools/client-gametest.sh [--dedicated]` | opens a game window for ~2–3 min |
| Full AI build end to end (costs API money) | `./mcai build "<prompt>"` | Claude Code |

Isolation: the protocol test and the dedicated game test play the engine themselves. Point them at
their own home and server so they never touch a running game:

```sh
export MCAI_HOME=/tmp/mcai-test-home                  # engine.json the test server's mod reads
export MCAI_TESTSERVER_DIR=$PWD/tools/testserver-b    # second, independent test server (gitignored)
export MCAI_TESTSERVER_PORT=25588
MCAI_ACCEPT_EULA=1 tools/testserver.sh start          # MCAI_ACCEPT_EULA=1 = you accept the Minecraft EULA
node tools/mod-protocol-test.mjs
tools/testserver.sh stop
```

## Toolchain quirks

- **Java:** the scripts default to `~/.mcai-tools/jdk-25.0.5+8/Contents/Home`; set `JAVA_HOME` to use
  another JDK 25.
- **Filtered networks (Mojang hosts blocked):** Loom needs Minecraft's jars and libraries.
  `node tools/mc-fetch.mjs 26.3` downloads them once into a sha1-verified cache (from Maven Central,
  BMCLAPI or `--import` of jars fetched elsewhere). `tools/mcgradle.sh build` then serves that cache
  through `tools/mc-mirror.mjs` on `127.0.0.1:8790` and builds through it. The mirror is only active
  when `MCAI_MC_MIRROR` is set, so normal builds are untouched. Once Gradle's caches are warm,
  `./gradlew build --offline` works without any network. Details: [tools/README.md](../tools/README.md).
- **Fabric meta / maven** (`meta.fabricmc.net`, `maven.fabricmc.net`) and Modrinth must be reachable
  for `./mcai setup` and for the first test-server start (the Fabric server launcher is cached in
  `~/.mcai-tools/fabric/`).
- **TypeScript in the engine** is executed by Node directly: imports need explicit `.ts` extensions
  and only erasable syntax is allowed (no `enum`, `namespace` or parameter properties).
- **macOS client tests:** a completely hidden OpenGL window can stall. The Gradle task has a 4-minute
  timeout and `client-gametest.sh` retries a stalled run once.
- **.gitignore:** keep patterns anchored (`/build/`, `/server/`). Unanchored patterns once hid
  `engine/src/server` and the mod's `dev.mcai.build` package from git.

## How the builder agent improves (feedback loop)

1. Every job ends with the agent's `finish` call: summary, highlights and **suggestions**, which are
   concrete complaints about tools, outputs or prompts it struggled with.
2. They are appended to `~/.mcai/feedback/<date>.jsonl`, and the full job log (every stream event and
   tool call with timing and block counts) is in `~/.mcai/jobs/<id>.jsonl`, with a summary in
   `<id>.json`.
3. `./mcai feedback [--limit N]` lists the suggestions per job. `./mcai jobs` lists cost, blocks
   and prompt. The web viewer shows them per job too.
4. A developer (or a coding agent) turns recurring suggestions into tool fixes, knowledge-base
   entries (`agent/knowledge/`) or prompt changes (`agent/SYSTEM.md`), and tracks them in
   `docs/BACKLOG.md`. Then the next headless `./mcai build` run, ideally with the same prompt as a
   showcase run, shows whether it helped (compare `docs/showcase/run*-summary.json`).

## Mod configuration (`config/mcai.json`, created on first start)

| Key | Default | Meaning |
|---|---|---|
| `engine.port` / `engine.token` / `engine.host` | 0 / "" / 127.0.0.1 | fixed engine endpoint (otherwise `~/.mcai/engine.json`) |
| `engine.autoStart` | singleplayer: on, dedicated: off | start the engine if none runs |
| `engine.command` | "" | explicit engine command line |
| `engine.viewerUrl` | "" | viewer link in chat (default: local engine in singleplayer, none on servers) |
| `buildPermissionLevel` | 2 | permission level needed for AI builds and `/mcai` (the singleplayer owner always may) |
| `buildCooldownSeconds` | 10 | minimum time between two build requests of one player |
| `maxPerTick`, `tickBudgetMs` | 20000, 15 | placement throughput vs. server-tick budget |
| `allowTimeWeather`, `commandAllowlist` | false, [] | extra commands the engine may run |
| `allowCommandBlocks` | false | let the engine create command/structure/jigsaw blocks with data and `run_command` signs |
