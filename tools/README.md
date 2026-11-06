# tools/ — dev tooling for the mcai mod

| Script | Purpose |
|---|---|
| `mc-fetch.mjs` | Download Minecraft (version JSON, client/server jars, libraries, optional assets) into a sha1-verified cache |
| `mc-mirror.mjs` | Serve that cache on 127.0.0.1 in Mojang's URL layout, so Loom/Gradle can build without Mojang's hosts |
| `mcgradle.sh` | Run `mod/gradlew` through the mirror (starts it if needed) |
| `testserver.sh` | Headless Fabric dedicated server with Fabric API + the mod (`tools/testserver/`, gitignored) |
| `mod-protocol-test.mjs` | Fake engine; integration test of the mod's engine bridge against the running test server |
| `gen-mod-assets.mjs` | Generates the wand texture and the mod icon (pixel art, no dependencies) |
| `client-gametest.sh` | Builds the mod and runs the client game tests in a real client window; screenshots → `docs/renders/mod-*.png` (gitignored scratch; images used by the docs are curated in `docs/images/`) |
| `fake-engine.mjs` | Fake engine with an HTTP control API (records mod traffic, pushes job_update/notify); used by the client tests |
| `vanilla-diff.mjs` | Differential test of the engine's vanilla rules (faces, connections, survival, rotate/mirror) against the real 26.3 server + classes — see `docs/VANILLA-DIFF.md` |
| `vanilla-diff/gen-physics.mjs` | Regenerates `engine/data/physics-26.3.json` (registry physics for the simulation) from Probe.java's dump of the real 26.3 classes (`--check`: fail if stale) |

Versions: Minecraft **26.3**, Java 25, Fabric Loader **0.20.1**, Fabric Loom **1.19.3**
(plugin id `net.fabricmc.fabric-loom`), Fabric API **0.165.2+26.3**, Gradle 9.8.2 (wrapper, sha256-pinned).
JDK: `~/.mcai-tools/jdk-25.0.5+8/Contents/Home` (scripts default to it; override with `JAVA_HOME`).

## Building the mod

With normal internet access nothing special is needed:

```sh
cd mod && JAVA_HOME=… ./gradlew build          # → mod/build/libs/mcai-2.0.0.jar
```

Once the Gradle/Loom caches are warm (one online build), `./gradlew build --offline` works without any network.

### Networks that block Mojang (piston-meta / piston-data / libraries.minecraft.net)

1. `node tools/mc-fetch.mjs 26.3` — fills `~/.mcai-tools/mc/` (override: `MCAI_MC_CACHE`).
2. `tools/mcgradle.sh build` — starts `mc-mirror.mjs` on `127.0.0.1:8790` and runs Gradle with
   `MCAI_MC_MIRROR=http://127.0.0.1:8790`.

How the redirection works (all of it is inactive unless `MCAI_MC_MIRROR` or `-Pmcai.mcMirror` is set,
so builds on a normal network are untouched):

* `mod/settings.gradle` sets Loom's mirror properties `loom_libraries_base` / `loom_resources_base`
  (read by Loom's `MirrorUtil` when its repository plugin is applied) in `gradle.beforeProject`.
  Gradle's "Mojang" maven repository then points at `/libraries/` of the mirror.
* `mod/build.gradle` adds a versions manifest `loom.versionsManifests.add('mcai-mirror', …, -10)`.
  It has the highest priority and its own cache name (`mcai-mirror_*` files in
  `~/.gradle/caches/fabric-loom`), so mirror and normal caches never mix.
* The mirror serves the version JSON with Mojang URLs rewritten to itself; the generated manifest
  lists the sha1 of the *rewritten* JSON, so Loom's own sha1 checks still pass. The jars keep their
  original sha1s, which Loom verifies too.

Verified: a build with an **empty** `GRADLE_USER_HOME` through the mirror on the filtered network
succeeds (Loom + Fabric come from maven.fabricmc.net, Minecraft only from the mirror).

## mc-fetch trust chain

```
node tools/mc-fetch.mjs [version=26.3] [--sha1 <hex>] [--assets] [--import <dir>] [--quiet]
```

1. **Anchor** = sha1 of `<version>.json`, from the first available of: `--sha1`, Mojang's version
   manifest (HTTPS), `misode/mcmeta` `<v>-summary/version.json` (GitHub HTTPS), a value pinned in
   the script. For 26.3 Mojang re-published the JSON once (asset-index update): `96c00d95…`
   (misode/pinned) and `80608ff6…` (current Mojang manifest) are both genuine; jars are identical.
2. The version JSON (from Mojang or the BMCLAPI mirror `/v1/packages/<sha1>/<v>.json`) must hash to
   the anchor.
3. Every file listed in it is verified by sha1 + size. Libraries are tried from Maven Central first
   (identical artifacts), then Mojang, then BMCLAPI `/maven`. TLS verification is never disabled;
   BMCLAPI nodes with broken certificates are simply retried (per-host back-off on HTTP 429).

Known limitation: from outside China, BMCLAPI redirects client/server jars to `piston-data.mojang.com`
itself, so on a network that blocks Mojang the jars must come from elsewhere: download
`client.jar` / `server.jar` on any other network and run `mc-fetch.mjs --import <dir>` (files are
accepted only if their sha1 matches the verified version JSON).

Cache layout mirrors the URLs: `piston-meta/v1/packages/<sha1>/…`, `piston-data/v1/objects/<sha1>/…`,
`libraries/<maven path>`, `resources/<hh>/<hash>`, plus `versions.json` (index of verified versions).

## Test server

```sh
MCAI_ACCEPT_EULA=1 tools/testserver.sh start   # first start only; see EULA below
tools/testserver.sh start [--fresh]             # --fresh deletes the world
tools/testserver.sh status | logs [-f] | stop | restart
tools/testserver.sh cmd "say hi"                # console command via a FIFO
```

* Production layout in `tools/testserver/`: vanilla `server.jar` (copied from the verified cache),
  Fabric server launcher (cached in `~/.mcai-tools/fabric/`, from meta.fabricmc.net), `mods/` =
  Fabric API (from maven.fabricmc.net, verified against the maven's `.sha1`) + `mod/build/libs/mcai-*.jar`
  (build the mod first).
* `server.properties`: `online-mode=false`, flat world (bedrock/dirt/grass, no structures),
  `spawn-protection=0`, port 25565 (`MCAI_TESTSERVER_PORT`), RCON off, `pause-when-empty-seconds=0`
  (tasks must keep ticking with nobody online), view distance 6. Heap: `MCAI_TESTSERVER_XMX` (4G).
* `MCAI_HOME` is passed through, so the mod can be pointed at a separate engine home.
* `MCAI_TESTSERVER_DIR=<dir>` runs an independent second server (e.g. `tools/testserver-b`, gitignored;
  combine with its own `MCAI_TESTSERVER_PORT` and `MCAI_HOME`), so parallel test runs never share a
  world or an engine. All `testserver.sh` subcommands (and the protocol test's console commands)
  honour it.
* **EULA:** running a Minecraft server requires accepting the Minecraft EULA
  (<https://aka.ms/MinecraftEULA>). The project owner accepted it for this local dev server only.
  The script never accepts it on anyone's behalf: if `tools/testserver/eula.txt` is not already
  `eula=true`, `start` refuses unless you run it with `MCAI_ACCEPT_EULA=1`, which means **you**
  accept the EULA.

## Protocol integration test

```sh
tools/testserver.sh start && node tools/mod-protocol-test.mjs [--skip-perf] [--perf-size N] [--start]
```

Plays the engine on a random port, writes `~/.mcai/engine.json` (an existing file is moved aside
and restored on exit/Ctrl-C), waits for the mod's `hello`, then checks: registry dump (> 1000 blocks,
property order, defaults, map colour, tags, dimension heights), ~100k-block `set_blocks` with
fences/panes/walls/stairs (connections and stair shapes after the shape pass), signs/chest with SNBT,
`get_blocks` round-trip equality, `previous` correctness and exact undo (including block entities),
heightmap, biomes, players, entities, command allowlist rejections (incl. non-decorative summon
passengers), invalid states (per-index `failed`), coordinates beyond the world limit (must fail
cleanly — a chunk ticket there used to crash the server), malformed messages/envelopes, guarded
blocks (command blocks / `run_command` signs refused, exact copies via undo allowed), notify,
boss-bar lifecycle, a 2 000 000-block single-message `set_blocks` with TPS sampling, and an engine
disconnect in the middle of a job.

**Never run it against the shared `~/.mcai`** while a real game is open: give the test server and the
test their own `MCAI_HOME` (see docs/DEVELOPMENT.md), otherwise a reconnecting game could pick up the
fake engine.

Last runs (2026-11-06, filtered network, MacBook x86_64): **85/85 checks passed**.
Unloaded machine: 2 000 000 blocks (37 MB message) in 11.5 s round trip at 20.0 TPS
(mod: 2.3 s placement + 1.2 s shape pass of server-thread time, spread over 219 ticks); with a game
client and a second server running on the same laptop: 31.9 s, still 20.0 TPS.

## Client game tests (real client, automated)

```sh
tools/client-gametest.sh               # singleplayer: ~2–3 min, a client window opens
tools/client-gametest.sh --dedicated   # + multiplayer permission test against tools/testserver
```

`fabric-client-gametest-api-v1` via Loom's `runClientGameTest` (source set `mod/src/gametest`). The mod
itself auto-starts `tools/fake-engine.mjs` (config `engine.command`, isolated `MCAI_HOME` in the run dir),
so the whole path is exercised without AI cost. Covered: engine auto-start + connect, key-binding
conflicts, wand right-click → corner 2, client selection rendering, prompt GUI (B key, typing, style
chip, Ctrl/Cmd+Enter) → asserted `build_request` (prompt, selection, anchor, facing, style, mode),
job_update → HUD (3 thoughts) + boss bar, engine requests served while singleplayer is **paused**,
Cancel from the GUI → `job_control`, chat buttons ([Undo] [Redo] [Open viewer], answer options →
`player_reply`), German UI, engine crash → offline state with reason, and (with `--dedicated`) a non-op
player is refused (GUI disabled, forged payload rejected server-side) until `op`.

Test-only client settings (mixin in the gametest source set): no vsync, no pause on focus loss.
Mojang services are pointed at a closed local port (`-Dminecraft.api.discovery.host`), so the client
never waits on them. macOS can stall an OpenGL window that is completely hidden; the Gradle task has a
4-minute timeout and the script retries a stalled run once.
