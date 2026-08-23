# YouTube

A five-minute video. The structure is deliberate: the payoff is in the first
fifteen seconds, the explanation comes after people have already seen it work,
and there is no intro sequence. Watch time on a technical demo is won or lost
before the title card most channels put first.

**Title** (pick by thumbnail)
- I typed one sentence and Minecraft built a castle
- This Minecraft AI doesn't place blocks. It writes a compiler's input.
- Type it in chat. Watch it get built.

**Thumbnail** — split down the middle. Left: the chat line `!build a huge
castle` in Minecraft's font on a dark blur. Right: the finished castle at
golden hour, wide angle, from slightly below so it towers. No face, no arrows,
no red circles. One number burned in the corner: **41,564 blocks**.

**Description**

> Type what you want in Minecraft chat and it gets built — fitted to your
> terrain and your biome. Open source, MIT licensed.
>
> The interesting part is that the AI never places a block. It writes a small
> JSON blueprint and a compiler turns that into vanilla /fill commands, merging
> everything it can. That's why a 41,000-block castle takes two seconds and
> costs a third of a cent.
>
> Try it without installing Minecraft: git clone, npm install, ./mcai serve --sim
> Code: [github]
>
> 0:00 One sentence, one castle
> 0:35 Setting it up
> 1:10 It reads the terrain first
> 2:00 Why it isn't slow
> 3:20 Undo, styles, your own structures
> 4:20 From your editor with MCP
> 4:50 What it can't do yet

---

## Shot list and script

### 0:00 — Cold open. No intro.

**Screen** — In-game, first person, standing on a hillside at dawn. Chat is
open. You type `!build a huge castle` and press enter, on camera.

> *(as you type)* Watch this.

**Screen** — Chat: `Building castle: 41,564 blocks, 67×52×67, 3,175 commands.`
Then the castle assembles. Do not cut away. Let it run, real time, no speed-up.
This is the entire hook — it has to be an unbroken shot.

> That took two seconds. It's fitted to the hill — look at the foundation on
> the left, it follows the slope down. And it picked stone because we're in a
> plains biome; in a desert this is sandstone.
>
> No mod. No plugin. It's typing vanilla commands into your server.

**Screen** — Walk through the gatehouse, up the keep's spiral stairs, out onto
the battlements. One continuous shot, no cuts, so nobody thinks it's staged.

> I'm going to show you how to run it, and then the one design decision that
> makes it work.

### 0:35 — Setup

**Screen** — Terminal, side by side with `server.properties` open.

> Three lines in server.properties. Turn RCON on, pick a password.

**Screen** — Type it live:
```
export RCON_PASSWORD=whatever
./mcai setup     # pick a provider
./mcai serve
```

> Pick whichever AI you want — there are fourteen, including local ones that
> cost nothing. Or skip it entirely; fifteen structures build with no AI at all.

**Screen** — Browser at `localhost:8765`, dashboard visible.

> There's a dashboard too — you can build from here, and it shows you what it
> cost.

> If you don't have a server, or you just want to poke at it: add `--sim` and
> it runs the whole thing against a simulated world in memory. Same dashboard,
> no Minecraft, no Java.

**Screen** — `./mcai serve --sim`, click a structure in the gallery, it builds
and renders.

### 1:10 — Terrain and biome

**Screen** — Fly to a steep hillside. `!build a watchtower`.

> Before it builds anything, it looks at where you're standing. Ground height,
> slope, biome, what's nearby.

**Screen** — Cut to the terminal log showing the survey result — actual JSON,
readable, small.

> That's the whole survey. Eight numbers. Earlier versions of this sent one
> record per surface block — four thousand objects — which is a lot of money to
> spend saying "it's a bit hilly".

**Screen** — The watchtower goes up. Cut to the base showing foundation columns
stepping down the slope.

> Foundations follow the ground. That's the difference between a build that
> looks placed and one that looks like it was dropped in.

**Screen** — Fly to a desert. Same command: `!build a watchtower`. Different
result — sandstone, flat roof.

> Same words. Different biome. Different building.

### 2:00 — The design decision

**Screen** — Editor, split. Left: a blueprint JSON, about sixty lines. Right:
the compiled command list scrolling.

> Here's the thing I actually want to talk about.
>
> The obvious way to build with an AI is to let it place blocks. That's what
> this used to do. A castle was tens of thousands of tool calls, cost a fortune
> in tokens, and took minutes.
>
> So the AI stopped placing blocks.

**Screen** — Highlight one line: `{"op":"cylinder","at":[0,0,0],"r":4,"h":22}`.

> It writes this instead. Eighty characters. That's a tower — eleven hundred
> blocks. It describes what it wants, not where every block goes.

**Screen** — Animate the compilation: blueprint → voxels → merged boxes.
Reuse the animation from the site if that's easier.

> Then a compiler expands it and merges everything it can into runs of the same
> material, because Minecraft's fill command takes a whole box at once.

**Screen** — Terminal: `mcai bench`, full table.

> A wall that's 1,184 blocks ships as four commands. Across everything built
> in: eight and a half blocks per command, and the whole library compiles in a
> third of a second.

> That's the reason it's fast and the reason it's cheap. A full custom build is
> about four thousand tokens. Anything in the library is free — no API key at
> all.

### 3:20 — Undo, styles, your own structures

**Screen** — Back in game, in front of the castle. `!undo`.

> If you don't like it — undo. It snapshots the whole region before it builds,
> so this is exact. Block states and all.

**Screen** — The castle disappears; the hillside is back, untouched.

> Which means you can just try things.

**Screen** — `!style gothic`, then `!build a keep`. Then `!style japanese`,
`!build a keep`.

> Sixteen styles. Same structure, different world.

**Screen** — Editor: open `styles/medieval.json`, change `wall` to
`quartz_block`, save. Back in game, build again.

> They're just JSON files. So are the structures — drop one in `blueprints/`
> and it's buildable by name.

**Screen** — Show `blueprints/glass_spire.json` briefly, then its render.

> That's forty lines. Twenty-three ops total — cylinders, domes, real pitched
> roofs, arches, battlements, spiral stairs, symmetry.

**Screen** — Close-up on a roof edge, showing the stair blocks.

> Small thing I'll defend: the roof stairs face uphill. In vanilla, a stair's
> facing is the side with the full-height half — so on a slope they point
> toward the ridge. Get it backwards and every step leaves a half-block gap.
> It's the detail that separates a roof that looks built from a roof that looks
> generated.

### 4:20 — MCP

**Screen** — Claude Code (or Cursor) with the MCP server configured. Ask it to
build something. Cut to the game as it appears.

> It's also an MCP server, so you can build from whatever editor you already
> use. There's a preview tool that compiles and renders without a server
> running, so you can design something on a plane and build it later.

### 4:50 — Limits, then out

**Screen** — Back in game, standing in the castle courtyard.

> What it's not good at yet: interiors are basic. It nails the shell and the
> roof; a room is still a room. Very vague requests give you generic results —
> it wants a noun. And it builds one thing at a time, so no villages.
>
> It's MIT licensed and the whole thing is in the description. If you try it,
> tell me what it got wrong — that's more useful to me than what it got right.

**Screen** — Fade on a wide shot of the castle at sunset. No outro card, no
subscribe animation. End on the build.

---

## Production notes

- **Record at 1440p60**, upload at that. Voxel edges alias badly at 1080p30 and
  the build animation is the whole video.
- **No music under the build sequence.** The command stream firing has its own
  rhythm; let the block sounds carry it.
- **Do not speed up the first build.** If it's genuinely two seconds, showing
  it in real time is the strongest claim in the video. A speed-up ramp there
  reads as a cover-up and people will say so in the comments.
- **Shoot the failure too.** Have one take where a build comes out ugly, and
  leave a couple of seconds of it in around 4:50. It buys more credibility than
  anything else in the script.
- **Chapters in the description** as timestamps, exactly as listed. YouTube
  turns them into a scrubber.
- **Pin a comment** with the install command and an offer to answer questions.
- **Captions**: upload a real transcript, don't rely on auto-generated. Half of
  this audience watches muted.
