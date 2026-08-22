# Blueprints

Drop a `.json` file here and mcAI can build it by name — in game with
`!build <filename>`, from the dashboard, or from the MCP `mc_prefab` tool.
No restart is needed beyond the daemon's next library reload.

The format is documented in `docs/blueprints.md`, and `mcai prompt` prints the
same reference the model works from.

Check a file before using it:

```sh
mcai render blueprints/watchtower_ruin.json --ascii
```
