// Control tools: undo, say, progress, ask_player, finish (+ command).

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { paths } from '../config.ts';
import { SpaceIn, ToolError, defineTool, frameOf, worldOf, type ToolCtx, type ToolDef } from './common.ts';
import type { Vec3 } from '../../core/types.ts';
import { blockId, isAir } from '../../core/blockstate.ts';
import { boxContains, volIndex } from '../../core/volume.ts';
import { checkCommand, localizeCommand } from '../commands.ts';

const SAY_MAX = 300;
const SAY_MIN_INTERVAL_MS = 2500;
const SAY_MAX_PER_JOB = 25;

export async function chat(ctx: ToolCtx, text: string): Promise<void> {
  try {
    await ctx.env.backend().notify({ target: ctx.job.player, kind: 'chat', text });
  } catch (e) {
    ctx.job.log('warn', { where: 'chat', message: (e as Error).message });
  }
}

export const undoTool = defineTool({
  name: 'undo',
  title: 'Undo',
  mutates: true,
  description:
    'Revert your own most recent edit(s) in this job (each build/run_script/terraform/paste/... call is one step). steps = how many calls to revert (default 1). ' +
    'Returns what was reverted. Cannot undo the player\'s own edits or other jobs.',
  input: z.object({ steps: z.number().int().min(1).max(50).default(1) }),
  async run(a, ctx) {
    const { job, env } = ctx;
    const out: string[] = [];
    for (let i = 0; i < a.steps; i++) {
      const stack = env.history.list(job.player);
      const top = stack[stack.length - 1];
      if (!top || !job.undoIds.includes(top.id)) {
        if (!out.length) throw new ToolError('nothing of this job left to undo');
        break;
      }
      const rec = await env.history.undo(job.player, env.backend());
      worldOf(ctx).invalidate();
      if (!rec) break;
      job.undoIds = job.undoIds.filter((id) => id !== rec.id);
      env.onWorldChange?.(rec.before, rec.dimension);
      out.push(`${rec.id} "${rec.label}" (${rec.before.states.length} blocks restored)`);
    }
    return `undone: ${out.join('; ')}`;
  },
});

export const sayTool = defineTool({
  name: 'say',
  title: 'Chat to the player',
  description:
    `Send a short chat message (max ${SAY_MAX} chars) to the requesting player, e.g. to explain the design or announce a phase. ` +
    `Rate-limited (one per ${SAY_MIN_INTERVAL_MS / 1000}s, ${SAY_MAX_PER_JOB} per job). Use sparingly; use progress for status.`,
  input: z.object({ text: z.string().min(1).max(1000) }),
  async run(a, ctx) {
    const { job } = ctx;
    const st = (job.scratch.get('say') as { last: number; n: number } | undefined) ?? { last: 0, n: 0 };
    const now = Date.now();
    if (st.n >= SAY_MAX_PER_JOB) throw new ToolError(`say limit reached (${SAY_MAX_PER_JOB} messages per job); put remaining info into finish()`);
    if (now - st.last < SAY_MIN_INTERVAL_MS) throw new ToolError(`say is rate-limited; wait ${Math.ceil((SAY_MIN_INTERVAL_MS - (now - st.last)) / 1000)}s (message not sent)`);
    st.last = now;
    st.n++;
    job.scratch.set('say', st);
    const text = a.text.replace(/\s+/g, ' ').trim().slice(0, SAY_MAX);
    await chat(ctx, text);
    job.log('say', { text });
    return `sent (${text.length} chars)${a.text.length > SAY_MAX ? ' — truncated' : ''}`;
  },
});

export const progressTool = defineTool({
  name: 'progress',
  title: 'Report progress',
  description:
    "Update the player's progress bar: stage = short text shown in game (≤ 60 chars, e.g. 'Raising the walls'), percent = overall job progress 0-100. " +
    'Call it at every phase change (cheap, no output).',
  input: z.object({
    stage: z.string().min(1).max(200),
    percent: z.number().min(0).max(100),
    phase: z.enum(['thinking', 'building', 'reviewing']).optional(),
  }),
  async run(a, ctx) {
    const { job, env } = ctx;
    job.lastProgressAt = Date.now();
    env.jobs.update(job, { stage: a.stage.slice(0, 60), progress: Math.max(0.01, Math.min(0.99, a.percent / 100)), ...(a.phase ? { state: a.phase } : {}) });
    return 'ok';
  },
});

export const askPlayer = defineTool({
  name: 'ask_player',
  title: 'Ask the player',
  description:
    'Ask the player a question (only when a decision really matters and cannot be inferred). Give 2-5 short options; the player can also answer freely. ' +
    'Waits up to timeoutSec (default 90) and returns the answer, or "no answer — decide yourself".',
  input: z.object({
    question: z.string().min(3).max(300),
    options: z.array(z.string().min(1).max(60)).min(2).max(5),
    timeoutSec: z.number().int().min(10).max(300).default(90),
  }),
  async run(a, ctx) {
    const { job, env } = ctx;
    const q = (job.scratch.get('asked') as number | undefined) ?? 0;
    if (q >= 3) throw new ToolError('you already asked 3 questions in this job; decide yourself');
    job.scratch.set('asked', q + 1);
    const opts = a.options.map((o, i) => `${i + 1}) ${o}`).join('  ');
    await chat(ctx, `[mcAI] ${a.question}  ${opts}  — reply with /mcai reply <number or text>`);
    const prevStage = job.stage;
    env.jobs.update(job, { stage: 'Waiting for your answer (/mcai reply)' });
    job.log('ask', { question: a.question, options: a.options });
    const ans = await env.jobs.ask(job, a.question, a.options, a.timeoutSec * 1000);
    env.jobs.update(job, { stage: prevStage });
    if (ans === null) return 'no answer — decide yourself';
    const n = Number(ans.trim());
    if (Number.isInteger(n) && n >= 1 && n <= a.options.length) return `player chose: ${a.options[n - 1]}`;
    const match = a.options.find((o) => o.toLowerCase() === ans.trim().toLowerCase());
    return match ? `player chose: ${match}` : `player answered: ${ans.slice(0, 500)}`;
  },
});

export function appendFeedback(entry: Record<string, unknown>): string {
  const dir = paths.feedback();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
  return file;
}

export const finishTool = defineTool({
  name: 'finish',
  title: 'Finish the job',
  description:
    'REQUIRED as the last call. summary = 1-3 sentences for the player (shown in chat); highlights = notable features (≤ 6 short items); ' +
    'suggestions = your concrete ideas how the mcAI system/tools/prompts could be improved (missing tools, confusing outputs, bugs you hit) — this feedback is collected to improve the system, be specific. ' +
    'After finish, stop working and end your turn.',
  input: z.object({
    summary: z.string().min(1).max(1000),
    highlights: z.array(z.string().max(200)).max(10).default([]),
    suggestions: z.array(z.string().max(1000)).max(20).default([]),
  }),
  async run(a, ctx) {
    const { job, env } = ctx;
    job.finished = { summary: a.summary, highlights: a.highlights, suggestions: a.suggestions, at: Date.now() };
    try {
      appendFeedback({
        time: new Date().toISOString(),
        jobId: job.id,
        player: job.player,
        prompt: job.req.prompt,
        model: job.req.model ?? env.config.model,
        backend: env.backend().kind,
        blocksChanged: job.blocksChanged,
        toolCalls: job.toolCalls,
        summary: a.summary,
        highlights: a.highlights,
        suggestions: a.suggestions,
      });
    } catch (e) {
      job.log('error', { where: 'feedback', message: (e as Error).message });
    }
    env.jobs.update(job, { stage: 'Finishing', progress: 0.99 });
    await chat(ctx, `[mcAI] ${a.summary.slice(0, 280)}`);
    return 'Job finished and recorded. Stop now — do not call more tools; end your turn with a one-line summary.';
  },
});

export const commandTool = defineTool({
  name: 'command',
  title: 'Run an allowlisted command',
  mutates: true,
  description:
    'Run one Minecraft command from a small allowlist, for things blocks cannot do: ' +
    "summon decorative/ambient entities (armor_stand, item_frame, glow_item_frame, painting, block_display, item_display, text_display, villager, cat, horse, ... — NoAI etc. allowed), " +
    'fillbiome, particle, playsound (plus time/weather if the owner enabled them). Coordinates must be absolute WORLD coordinates inside the allowed build box (convert local with get_context frame info). ' +
    'No selectors other than @s/@p; no execute/op/give/kill/tp. Returns the command output (+ a warning with the nearest free spot if a summoned mob would be stuck inside blocks). Not undoable (entities stay).',
  input: z.object({
    command: z.string().min(2).max(2000).describe("without leading '/', e.g. 'summon armor_stand 3 1 -5 {ShowArms:1b}'"),
    space: SpaceIn,
  }),
  async run(a, ctx) {
    const { job, env } = ctx;
    let cmd = a.command.trim().replace(/^\//, '');
    if (a.space === 'local') cmd = localizeCommand(cmd, frameOf(ctx));
    const err = checkCommand(cmd, { allowedBox: job.allowedBox, extra: env.config.commandAllowlist });
    if (err) throw new ToolError(err);
    let warn: string | null = null;
    try {
      warn = await summonCheck(ctx, cmd);
    } catch {
      warn = null;
    }
    const r = await env.backend().runCommand(cmd);
    job.log('command', { command: cmd, ok: r.ok, output: r.output.slice(0, 500) });
    if (!r.ok) throw new ToolError(`command failed: ${r.output || '(no output)'}${warn ? `\n${warn}` : ''}`);
    return `${r.output || 'ok'}${warn ? `\n${warn}` : ''}`;
  },
});

/** entities without collision that live inside/at block faces */
const NO_COLLISION = new Set(['item_frame', 'glow_item_frame', 'painting', 'block_display', 'item_display', 'text_display', 'interaction', 'leash_knot', 'marker']);
const SMALL = new Set(['cat', 'chicken', 'rabbit', 'fox', 'parrot', 'bee', 'frog', 'axolotl', 'turtle', 'ocelot', 'allay', 'tropical_fish', 'cod', 'salmon', 'squid', 'glow_squid', 'armadillo', 'copper_golem', 'pig', 'wolf', 'sheep', 'goat']);
const TALL: Record<string, number> = { iron_golem: 3, happy_ghast: 4, camel: 3, sniffer: 2, polar_bear: 2 };
const SWIMMERS = new Set(['tropical_fish', 'cod', 'salmon', 'dolphin', 'squid', 'glow_squid', 'axolotl', 'turtle']);
const FLYERS = new Set(['parrot', 'bee', 'allay', 'happy_ghast']);

/** Warn when a summoned entity would sit inside solid blocks; suggest the nearest free spot. */
export async function summonCheck(ctx: ToolCtx, cmd: string): Promise<string | null> {
  const t = cmd.trim().split(/\s+/);
  if ((t[0] ?? '').toLowerCase() !== 'summon') return null;
  const ent = (t[1] ?? '').replace(/^minecraft:/, '').toLowerCase();
  if (NO_COLLISION.has(ent)) return null;
  const [x, y, z] = [Number(t[2]), Number(t[3]), Number(t[4])];
  if (![x, y, z].every(Number.isFinite)) return null;
  const h = TALL[ent] ?? (SMALL.has(ent) ? 1 : 2);
  const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
  const R = 4;
  const box = { min: [bx - R, by - R - 1, bz - R] as Vec3, max: [bx + R, by + R + h, bz + R] as Vec3 };
  const reg = ctx.env.registry();
  const vol = await worldOf(ctx).getBlocks(box, ctx.job.dimension);
  const solidPal = vol.palette.map((st) => {
    if (isAir(st)) return false;
    const id = blockId(st);
    return reg.isFullSolid(st) || reg.hasTag(id, 'minecraft:fences') || reg.hasTag(id, 'minecraft:walls') || id.endsWith('_slab') && /type=(double|top)/.test(st);
  });
  const waterPal = vol.palette.map((st) => /^minecraft:water/.test(st) || /waterlogged=true/.test(st));
  const solid = (xx: number, yy: number, zz: number) => boxContains(box, xx, yy, zz) && solidPal[vol.data[volIndex(box, xx, yy, zz)]!]!;
  const water = (xx: number, yy: number, zz: number) => boxContains(box, xx, yy, zz) && waterPal[vol.data[volIndex(box, xx, yy, zz)]!]!;
  const free = (xx: number, yy: number, zz: number) => {
    for (let k = 0; k < h; k++) if (solid(xx, yy + k, zz)) return false;
    return true;
  };
  let hit: string | null = null;
  for (let k = 0; k < h; k++) if (solid(bx, by + k, bz)) {
    hit = vol.palette[vol.data[volIndex(box, bx, by + k, bz)]!]!;
    break;
  }
  if (!hit) return null;
  const standing = !SWIMMERS.has(ent) && !FLYERS.has(ent);
  let best: Vec3 | null = null, bestD = Infinity;
  for (let dy = -R; dy <= R; dy++)
    for (let dz = -R; dz <= R; dz++)
      for (let dx = -R; dx <= R; dx++) {
        const px = bx + dx, py = by + dy, pz = bz + dz;
        if (!free(px, py, pz)) continue;
        if (standing && !solid(px, py - 1, pz)) continue;
        if (SWIMMERS.has(ent) && !water(px, py, pz)) continue;
        const d = dx * dx + dy * dy * 1.5 + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = [px, py, pz];
        }
      }
  const f = frameOf(ctx);
  const sug = best ? ` Nearest free spot: ${best[0] + 0.5} ${best[1]} ${best[2] + 0.5} (world; local ${f.toLocal(best).join(',')}).` : ' No free spot within 4 blocks.';
  return `WARNING: the ${ent} at ${x} ${y} ${z} is inside ${hit.replace(/^minecraft:/, '').replace(/\[.*$/, '')} — it will be stuck or suffocate.${sug}`;
}

export const controlTools: ToolDef[] = [undoTool, sayTool, progressTool, askPlayer, finishTool, commandTool];
