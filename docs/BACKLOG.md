# Backlog (from real play-tests and builder-agent feedback)

## From the first real-Minecraft play-test (2026-11-06, singleplayer, 2 builds)
Engine:
- [x] USER DECISION: the selection is the primary build area, but the agent may extend up to ~5–10 blocks
      in every direction when it makes sense (supports, terrain blending, paths, trees).
      → allowed box = selection + margin (config `selectionMargin`, default 8; vertical margin similar,
      plus the auto-extension below). get_context reports both `selection` (primary) and `allowedBox`;
      SYSTEM.md tells the agent to keep the main structure inside the selection and use the margin only
      for integration. The mod shows the margin as a fainter outline.
- [x] Low/flat selections become the build box (8–10 high) → auto-extend vertically: down to the lowest
      ground/water bed in the footprint (−2), up to a sensible height (≥ 32 or prompt-dependent);
      get_context must warn when terrain/water below the box is excluded.
- [x] Clamp run_script/scan_region readBox to allowed box ± margin; never trigger huge chunk loads.
- [x] Script API: `isWater(x,y,z)`; `groundY` outside the ground map → fall back to a world heightmap
      query instead of throwing.
- [ ] roof op: `ends` accepts patterns; result reports ridge/top y; validate the roof height against the allowed box up front.
- [x] Support rules: a bottom-half stair (full bottom face) supports a hanging lantern; the error message names the block above.
- [x] scan_region floating: lily pads on water are supported.
- [x] Renderer: lily_pad tint (renders near black).
- [x] render_view `cutOutside: true` (hide terrain/trees outside the allowed box in front of the build).
- [x] bridge op: arbitrary angle (diagonal) with 4-connected railings.
Engine (iteration 2 extras: builder suggestions + real castle job):
- [x] `vines` build op: exterior faces only (flood fill + sky access), doorways kept free, faces set automatically.
- [x] `cylinder` `interior` fill: round floors tile exactly with hollow walls (no gap rings).
- [x] find_blocks hints item-only decorations (item_frame / armor_stand / item_display via command).
- [x] Per-job world cache: one read of the job area, own edits applied in memory, heightmaps cached; real round trips logged ('world').
- [x] Support rules verified against the decompiled 26.3 code (SupportType CENTER/RIGID/FULL, getFaceShape at the block boundary):
      hanging lanterns under top slabs / upside-down stairs are correctly rejected (vanilla does too); hopper rims are RIGID only; fence gates #unstable_bottom_center.
- [x] floating scan: diagonal roof pieces (stairs/slabs) count as one surface; lily pads on water supported.
- [x] define(): generators keep the defining script's top-level helpers (functions, side-effect-free consts).
- [x] Script API `topY(x,z,{includeOwn,solid})`; `keep` accepted in build `set` entries.
- [x] render_view (explicit box) and /api/render auto-crop solid underground (`crop=0` disables).
Mod:
- [x] Integrated server pauses (menu / focus loss) → stalls builds and engine timeouts. (bridge keeps serving while paused)
- [x] Lag spikes ("Can't keep up! 12 s") during jobs: time-slice get_blocks/chunk loading. (async chunk tickets, read/write lanes)
- [x] Selection messages with a stale far-away corner; show the effective box after the engine reply. (job area outline + chat; corner distance limit removed on user request)
- [x] Review fixes: server crash on far-out coordinates (chunk tickets beyond the world), payload encoders clip strings
      (no player kicks), boss bars follow rejoin/respawn, command/structure blocks + run_command signs only as copies of
      existing blocks (`allowCommandBlocks`), non-decorative summon passengers rejected, `dev.mcai.build` package was gitignored.
