<div align="center">

# mcAI — the plugin

**One jar. Drop it in `plugins/`. Type `/mcai build a huge castle`.**

</div>

---

## Install

1. Download `mcAI.jar`.
2. Put it in your server's `plugins/` folder.
3. Start the server.

That is the whole install. Works on Paper, Spigot and Bukkit, 1.20 and newer.

The first start unpacks the build engine into `plugins/mcAI/engine` and starts
it. Nothing to download separately, no `npm install`, no versions to keep in
step — the engine ships inside the jar.

You need [Node 20+](https://nodejs.org) on the machine. It is the one thing a
Java plugin cannot bring along. If it is missing, mcAI says so in the console
with the address to get it, rather than failing later with something cryptic.

## Use it

```
/mcai build a huge medieval castle on the hill
/mcai build a japanese temple
/mcai undo
```

Tab completion knows the structures and styles the engine has loaded, including
any you added yourself as JSON files.

Builds land where you are standing, facing the way you are looking, fitted to
the ground you are standing on.

| command | what it does |
| --- | --- |
| `/mcai build <what>` | build it where you stand |
| `/mcai undo` | put the last build back, exactly |
| `/mcai cancel` | stop the build in progress |
| `/mcai list` | the structures that need no AI |
| `/mcai style <name>` | force a style, or `auto` to match the biome |
| `/mcai status` | engine, world and AI at a glance |
| `/mcai setup` | connect an AI provider |
| `/mcai dashboard` | the web dashboard, with an access link |

Permissions: `mcai.build` for building and undoing, `mcai.admin` for `/mcai
reload` and for the dashboard link. Both default to op.

## Connect an AI — or don't

Fifteen structures build with no AI at all. `/mcai build castle`,
`/mcai build lighthouse`, `/mcai build windmill` work the moment the server
starts, cost nothing, and need no account.

For anything else — *"a ruined watchtower overgrown with vines"* — mcAI needs a
model. Run `/mcai dashboard`, open the link, click **AI provider**, pick one,
paste a key, **Save**.

Fourteen providers are supported, including **Ollama** and **LM Studio**, which
run on your own machine and cost nothing. The dashboard tests the key before
saving it and tells you what is wrong if it fails.

## How it works

```
   Minecraft server                        the engine (Node)
   ┌───────────────────┐                   ┌────────────────────┐
   │ mcAI.jar          │  ── heightmap ──▶ │  survey the site   │
   │                   │  ── region ─────▶ │  choose a structure│
   │  /mcai build …    │                   │  compile a blueprint│
   │                   │ ◀── 2,000 cmds ── │  one batch         │
   └───────────────────┘                   └────────────────────┘
        loopback, one generated token
```

The plugin owns the world; the engine owns the thinking. They talk over
loopback with a token the plugin generates on first start.

What makes this fast is that neither side chats. A castle is **one** request
carrying ~2,000 `/fill` commands, executed server-side in a single pass —
not 2,000 round trips, and emphatically not one `setblock` per block. Terrain
comes back as **one** heightmap request read straight from the server's own
heightmap, instead of probing columns block by block.

Compared to the RCON setup this replaces, it also removes every part of the
install that a human had to do: no `server.properties` edit, no RCON password,
no port to open, no bot account, and the server can stay in online mode.

## Configuration

`plugins/mcAI/config.yml`, created on first start. The defaults work.

| key | default | |
| --- | --- | --- |
| `token` | generated | shared secret between plugin and engine |
| `world` | first world | which world mcAI builds in |
| `bridge-port` | 8766 | plugin ↔ engine |
| `dashboard-port` | 8765 | the web dashboard |
| `auto-start-engine` | true | off to run the engine yourself |
| `engine-path` | *(empty)* | an engine elsewhere; disables unpacking |
| `node-path` | *(empty)* | for servers started with a minimal PATH |

Both ports bind to `127.0.0.1` only. Nothing mcAI opens is reachable from
outside the machine.

Your AI provider settings live in `plugins/mcAI/config/`, so moving the server
folder takes the configuration with it. The key file is written `0600` and the
dashboard never shows it back to you, masked or otherwise.

## Building the jar

```sh
cd plugin
./build.sh      # -> build/mcAI.jar
./test.sh       # the JSON codec, which is the part that can corrupt a prompt
```

`build.sh` compiles the plugin against the stubs in `stubs/` rather than the
Paper artifact, then compiles the TypeScript engine and packs it in. It fails
the build if the engine ever grows a dependency the jar cannot ship — the check
is in `scripts/check-engine-deps.mjs`.

`WITH_ENGINE=0 ./build.sh` skips the engine step for a fast Java-only build.

## When something is wrong

Start with `/mcai status`. It reports the world, the bridge, the engine (with
its pid, or why it stopped) and which model is configured.

**"The mcAI engine is not answering."** Node is missing, or the engine died.
`/mcai status` prints the last lines it wrote. Set `node-path` in the config if
Node is installed but your server's PATH cannot see it.

**"Could not open the bridge port."** Something else has 8766. Change
`bridge-port` and restart.

**Builds work but nothing custom does.** No AI is connected — `/mcai setup`.
The fifteen library structures are the ones that work without one.

## License

MIT, same as the rest of mcAI.
