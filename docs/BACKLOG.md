# Backlog (from real play-tests and builder-agent feedback)

## From the first real-Minecraft play-test (2026-11-06, singleplayer, 2 builds)
Engine:
- [ ] USER DECISION: the selection is the primary build area, but the agent may extend up to ~5–10 blocks
      in every direction when it makes sense (supports, terrain blending, paths, trees).
      → allowed box = selection + margin (config `selectionMargin`, default 8; vertical margin similar,
      plus the auto-extension below). get_context reports both `selection` (primary) and `allowedBox`;
      SYSTEM.md tells the agent to keep the main structure inside the selection and use the margin only
      for integration. The mod shows the margin as a fainter outline.
- [ ] Low/flat selections become the build box (8–10 high) → auto-extend vertically: down to the lowest
      ground/water bed in the footprint (−2), up to a sensible height (≥ 32 or prompt-dependent);
      get_context must warn when terrain/water below the box is excluded.
- [ ] Clamp run_script/scan_region readBox to allowed box ± margin; never trigger huge chunk loads.
- [ ] Script API: `isWater(x,y,z)`; `groundY` outside the ground map → fall back to a world heightmap
      query instead of throwing.
- [ ] roof op: `ends` accepts patterns; result reports ridge/top y; validate the roof height against the allowed box up front.
- [ ] Support rules: a bottom-half stair (full bottom face) supports a hanging lantern; the error message names the block above.
- [ ] scan_region floating: lily pads on water are supported.
- [ ] Renderer: lily_pad tint (renders near black).
- [ ] render_view `cutOutside: true` (hide terrain/trees outside the allowed box in front of the build).
- [ ] bridge op: arbitrary angle (diagonal) with 4-connected railings.
Mod:
- [ ] Integrated server pauses (menu / focus loss) → stalls builds and engine timeouts.
- [ ] Lag spikes ("Can't keep up! 12 s") during jobs: time-slice get_blocks/chunk loading.
- [ ] Selection messages with a stale far-away corner; show the effective box after the engine reply.
