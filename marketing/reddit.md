# Reddit

Three drafts for three audiences. Post one, wait a few days, adapt for the next
— cross-posting the same text the same day reads as spam and gets you filtered.

**Before you post, read this.** Reddit is allergic to marketing. The things that
actually work: lead with the visual, be specific and technical, admit what does
not work yet, answer every comment for the first two hours, and never say
"revolutionary". Post between 13:00–16:00 UTC on a Tuesday, Wednesday or
Thursday. Attach the recording as a native video or GIF — link posts to a
landing page get far less reach than something people can watch in the feed.

---

## 1. r/Minecraft — the main shot

**Title**

> I made a plugin where you type "/mcai build a huge castle" in chat and it
> actually builds one, fitted to your terrain

*(Alternatives, pick by what the clip shows: "Typed one sentence in chat, got a
34,000-block castle" / "Chat command → castle. It reads the terrain and the
biome first." / "One jar in plugins/, then type what you want in chat")*

**Body**

> Been working on this for a while. You type what you want in chat, it looks at
> where you're standing — terrain height, slope, biome, what's nearby — and
> builds it. Foundations follow the ground, so it doesn't float over a hill or
> bury itself in one. Materials come from the biome: the same request gives you
> spruce and turf in a taiga, sandstone with a flat roof in a desert.
>
> The clip is a 61×61 castle. 41,564 blocks, about two seconds.
>
> The part I'm actually proud of: the AI doesn't place blocks. It writes a small
> JSON "blueprint" — about sixty lines describing intent, like *cylinder radius
> 4 height 22* — and a compiler I wrote turns that into vanilla `/fill`
> commands, merging everything it can into as few as possible. A wall that's
> 1,184 blocks ships as four commands instead of 1,184. That's why it's fast and
> why it doesn't cost much.
>
> `/mcai undo` puts everything back exactly how it was, including block states,
> so you can try things without wrecking your world.
>
> Fifteen structures build instantly with no AI at all (`/mcai build lighthouse`,
> `/mcai build windmill`) — those are free and need no API key, so you can
> install it and immediately have something working.
>
> Install is one jar in `plugins/` and that's genuinely it — no RCON, no
> password to set, no `server.properties` edit, no bot account, server stays in
> online mode. Paper/Spigot/Bukkit 1.20+. Open source, MIT.
>
> You can try it without installing Minecraft at all:
> `git clone`, `npm install`, `./mcai serve --sim` — a dashboard with a
> simulated world. No key needed.
>
> [github link]
>
> **What it's still bad at:** interiors are basic — it gets the shell and the
> roof right, but a room is a room. Very abstract requests ("build something
> beautiful") give you generic results; it wants a noun. And it builds one thing
> at a time, so no towns yet.
>
> Happy to answer anything about how the compiler works.

**Prepared comment replies**

- *"Is this just WorldEdit with extra steps?"* — WorldEdit is a great tool and
  you drive it. This decides *what* to build from a sentence, then adapts it to
  your terrain and biome. It emits vanilla commands, so it works next to
  WorldEdit rather than replacing it.
- *"How much does it cost?"* — Roughly a third of a cent per custom build.
  Library structures are free. Local models via Ollama work too.
- *"Does it grief my world?"* — It builds where you're standing and `!undo`
  restores the region exactly. It snapshots before every build.
- *"Bedrock?"* — No. Java only, because it needs RCON and the command syntax.
- *"Can I change the styles?"* — Yes, they're JSON files. Sixteen included,
  drop your own in `styles/`.

---

## 2. r/LocalLLaMA — the technical angle

**Title**

> I cut an agent's token cost 10× by making it stop emitting the output format

**Body**

> Context: an agent that builds structures in Minecraft. The obvious design is
> tool calls that place blocks. That's what I had, and a castle cost tens of
> thousands of output tokens and just as many round trips, because the model was
> literally enumerating 40,000 coordinates.
>
> The fix was to stop having it produce the output at all. I defined a small
> declarative DSL — twenty-three ops — and the model emits about sixty lines of
> that. A deterministic compiler expands it to geometry and merges the result
> into minimal commands. `{"op":"cylinder","r":4,"h":22}` is 40 tokens and 1,100
> blocks.
>
> What actually moved the numbers, in order:
>
> 1. **Compile, don't enumerate.** ~50k output tokens → ~1.5k. This is the
>    whole thing; everything else is a rounding error next to it.
> 2. **Tool surface: 26 → 3.** Schemas are re-sent on every request. Twenty-six
>    tools was ~3k tokens of tax on every call, forever.
> 3. **Return statistics, not records.** The old "scan the terrain" tool
>    returned one object per surface block — 4,096 of them for a 64×64 area.
>    It now returns min/max/avg/slope. Eight numbers. The model makes the same
>    decisions from them.
> 4. **Prompt caching.** The system prompt holds the DSL reference and two
>    worked examples. It's byte-identical on every call, so it's ~90% cheaper
>    after the first request. Anything dynamic in there breaks the cache — the
>    site details go through a tool result instead.
> 5. **Teach with examples, not prose.** Two working blueprints replaced three
>    pages describing the format, and the failure rate went *down*.
>
> One more thing that mattered more than I expected: when validation fails, hand
> back the exact field path (`$.parts[3].size: "size" must be [w,h,d]`). Vague
> errors cost three retries; precise ones cost one.
>
> A full custom build is now ~4k tokens across two round trips. Works with
> Anthropic, OpenAI, DeepSeek, OpenRouter, Groq or local Ollama — it's two wire
> formats behind one interface.
>
> Code is MIT: [github link]. The compiler is dependency-free and the test suite
> runs against a simulated Minecraft, so you can read the interesting part
> without installing a game server.

---

## 3. r/programming — the compiler angle

**Title**

> Greedy 3D box decomposition, or: how to build a castle in 3,175 commands
> instead of 41,564

**Body**

> Minecraft's `/fill` command fills a cuboid. If you have an arbitrary voxel
> volume and want to place it with as few commands as possible, you want to
> partition it into the fewest axis-aligned boxes of uniform material.
>
> Optimal partitioning is NP-hard. Greedy gets you within a few percent on the
> shapes buildings are made of, and it's twenty lines:
>
> Walk voxels in (y, z, x) order. For each unclaimed voxel, grow +X while the
> material matches, then +Z while the entire X-run matches, then +Y while the
> entire XZ-slab matches. Claim the box, emit one `/fill`, continue.
>
> Across my test set: 47,043 blocks → 5,572 commands, 8.4× compression, 337 ms
> for all of it. A hollow 20×8×20 stone wall is 1,184 voxels and four boxes.
>
> Three things I got wrong first:
>
> **Texture noise destroys it.** I was picking wall materials per-block from a
> weighted mix so walls wouldn't look flat. Every neighbour differed, so nothing
> merged: the same castle went from 650 commands to 7,200. Fix was to quantise
> the noise into blobs — sample at `floor(x/4), floor(y/2), floor(z/4)` instead
> of per voxel. It arguably looks *better* (real masonry comes in patches, not
> per-brick static) and it's back to 1,347.
>
> **Ordering is part of correctness.** Air first (clear the volume), then solids
> bottom-up, then anything that needs support — torches, doors, flowers. Emit in
> merge order and your torches land before the wall they hang on.
>
> **The output format has hard limits.** `/fill` caps at 32,768 blocks, so
> oversized boxes need splitting, and it fails outside a player's view distance,
> so the region needs forceloading first. Both were silent failures for weeks.
>
> Full thing (MIT, TypeScript, no deps in the compiler): [github link]
