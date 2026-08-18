# mcAI

Minecraft AI Builder: an MCP server and Mineflayer bot that turns natural
language build requests into Minecraft builds.

## Repository layout

- `mcp-minecraft/` — TypeScript MCP server and bot daemon
- `.opencode/` — agent and command configuration
- `styles/` — build style presets
- `start.sh` / `stop.sh` — local Minecraft server and bot lifecycle scripts

The local PaperMC server, worlds, plugins, logs and downloaded JAR files are
intentionally excluded from Git. Set up a Paper server in `server/` locally
before using the lifecycle scripts.

## Development

```sh
cd mcp-minecraft
npm install
npm run build
```

The generated `mcp-minecraft/dist/` directory is local build output and is not
committed.

## Running locally

On a Linux host with Java and PaperMC installed:

```sh
./start.sh
./stop.sh
```

Configure local credentials and server settings through environment variables
or local files. Do not commit secrets, player data, worlds, or runtime logs.

## License

Add the project license here before publishing if this repository is intended
for public distribution.

