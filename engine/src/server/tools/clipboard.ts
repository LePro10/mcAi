// Clipboard / library tools: copy, paste, stack, move, save_structure, load_structure, list_structures.

import { z } from 'zod';
import type { Box, Vec3 } from '../../core/types.ts';
import { copyFromSink, pasteBox, pasteInto, stackRegion, moveRegion, transformClipboard, clipboardBlockCount, type Clipboard } from '../../core/clipboard.ts';
import type { QuarterTurns } from '../../core/transform.ts';
import { boxContainsBox, boxUnion, boxVolume } from '../../core/volume.ts';
import {
  BoxIn,
  SpaceIn,
  SpaceSink,
  ToolError,
  Vec3In,
  allowedText,
  commit,
  defineTool,
  fmtBox,
  fmtV,
  frameOf,
  newSession,
  normBoxIn,
  prefetch,
  statsText,
  toWorldBox,
  type ToolCtx,
  type ToolDef,
} from './common.ts';

interface StoredClip {
  clip: Clipboard;
  space: 'local' | 'world';
}

function clips(ctx: ToolCtx): Map<string, StoredClip> {
  let m = ctx.job.scratch.get('clipboards') as Map<string, StoredClip> | undefined;
  if (!m) ctx.job.scratch.set('clipboards', (m = new Map()));
  return m;
}

/** Return the clipboard re-oriented for `space`. */
function clipFor(ctx: ToolCtx, s: StoredClip, space: 'local' | 'world'): Clipboard {
  if (s.space === space) return s.clip;
  const turns = frameOf(ctx).turns;
  if (turns === 0) return s.clip;
  const rot = (space === 'world' ? turns : (4 - turns) % 4) as QuarterTurns;
  return transformClipboard(s.clip, { rotate: rot }, ctx.env.registry());
}

const ClipName = z.string().min(1).max(64).default('main').describe('clipboard name (per job)');

function spaceSink(ctx: ToolCtx, session: ReturnType<typeof newSession>, space: 'local' | 'world', clip: boolean): SpaceSink {
  return new SpaceSink(session, space === 'local' ? frameOf(ctx) : null, ctx.job.allowedBox, clip);
}

function checkInside(ctx: ToolCtx, wbox: Box, what: string, clip: boolean): void {
  if (!clip && !boxContainsBox(ctx.job.allowedBox, wbox)) {
    throw new ToolError(`${what} would cover world ${fmtBox(wbox)}, which leaves the ${allowedText(ctx)}. Move it or pass clip:true.`);
  }
}

async function readSession(ctx: ToolCtx, wbox: Box) {
  if (boxVolume(wbox) > 8_000_000) throw new ToolError(`region ${fmtBox(wbox)} is too large (max 8M blocks)`);
  const s = newSession(ctx, 'read', 1);
  await s.prefetch(wbox);
  return s;
}

export const copyTool = defineTool({
  name: 'copy',
  title: 'Copy to clipboard',
  readOnly: true,
  description:
    'Copy the blocks of a box into a named per-job clipboard. origin = the reference point that will land on `at` when pasting (default: box.min). ' +
    'May copy from outside the allowed box (e.g. an existing build nearby). Clipboards remember their space; pasting in the other space rotates correctly.',
  input: z.object({ box: BoxIn, space: SpaceIn, name: ClipName, origin: Vec3In.optional() }),
  async run(a, ctx) {
    const box = normBoxIn(a.box);
    const wbox = toWorldBox(ctx, box, a.space);
    const session = await readSession(ctx, wbox);
    const sink = spaceSink(ctx, session, a.space, true);
    const origin = (a.origin ?? box.min) as Vec3;
    const c = copyFromSink(sink, box, origin);
    clips(ctx).set(a.name, { clip: c, space: a.space });
    return `copied ${a.space} ${fmtBox(box)} into clipboard '${a.name}' (${clipboardBlockCount(c)} non-air blocks, origin ${fmtV(origin)})`;
  },
});

export const pasteTool = defineTool({
  name: 'paste',
  title: 'Paste clipboard',
  mutates: true,
  description:
    "Paste a clipboard (from copy or load_structure) so its origin lands on `at`. rotate = clockwise degrees seen from above (0/90/180/270), mirror = 'x' (flip east-west) or 'z' (flip north-south); " +
    'block states (stairs, doors, ...) are rotated too. ignoreAir:true keeps existing blocks where the clipboard has air. One undo step.',
  input: z.object({
    name: ClipName,
    at: Vec3In,
    space: SpaceIn,
    rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
    mirror: z.enum(['x', 'z']).optional(),
    ignoreAir: z.boolean().default(false),
    clip: z.boolean().default(false).describe('drop blocks outside the allowed box instead of failing'),
  }),
  async run(a, ctx) {
    const s = clips(ctx).get(a.name);
    if (!s) throw new ToolError(`no clipboard '${a.name}'. Existing: ${[...clips(ctx).keys()].join(', ') || 'none'} — use copy or load_structure first.`);
    let c = clipFor(ctx, s, a.space);
    if (a.rotate || a.mirror) c = transformClipboard(c, { rotate: (a.rotate / 90) as QuarterTurns, ...(a.mirror ? { mirror: a.mirror } : {}) }, ctx.env.registry());
    const at = a.at as Vec3;
    const wbox = toWorldBox(ctx, pasteBox(c, at), a.space);
    checkInside(ctx, wbox, 'paste', a.clip);
    const session = newSession(ctx, `paste ${a.name}`);
    await prefetch(ctx, session, wbox, 0);
    const sink = spaceSink(ctx, session, a.space, a.clip);
    pasteInto(sink, c, at, { ignoreAir: a.ignoreAir });
    const st = await commit(ctx, session, `paste ${a.name}`);
    return `pasted '${a.name}' at ${a.space} ${fmtV(at)} → world ${fmtBox(wbox)}${sink.outside ? ` (${sink.outside} blocks outside the allowed box dropped)` : ''}: ${statsText(st)}`;
  },
});

const DIRS: Record<string, Vec3> = {
  forward: [0, 0, -1], back: [0, 0, 1], left: [-1, 0, 0], right: [1, 0, 0], up: [0, 1, 0], down: [0, -1, 0],
  north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0],
};

export const stackTool = defineTool({
  name: 'stack',
  title: 'Stack (repeat) a region',
  mutates: true,
  description:
    'Repeat the contents of a box `count` times edge-to-edge in a direction (+ gap blocks between copies). ' +
    "direction: up/down/left/right/forward/back (local) or north/south/east/west (in local space north=forward). Great for colonnades, floors of a tower, fences. One undo step.",
  input: z.object({
    box: BoxIn,
    space: SpaceIn,
    count: z.number().int().min(1).max(256),
    direction: z.enum(['up', 'down', 'left', 'right', 'forward', 'back', 'north', 'south', 'east', 'west']),
    gap: z.number().int().min(0).max(64).default(0),
    ignoreAir: z.boolean().default(false),
    clip: z.boolean().default(false),
  }),
  async run(a, ctx) {
    const box = normBoxIn(a.box);
    const dir = DIRS[a.direction]!;
    const size = [box.max[0] - box.min[0] + 1, box.max[1] - box.min[1] + 1, box.max[2] - box.min[2] + 1];
    const k = a.count;
    const last: Box = {
      min: [box.min[0] + dir[0] * (size[0]! + a.gap) * k, box.min[1] + dir[1] * (size[1]! + a.gap) * k, box.min[2] + dir[2] * (size[2]! + a.gap) * k],
      max: [box.max[0] + dir[0] * (size[0]! + a.gap) * k, box.max[1] + dir[1] * (size[1]! + a.gap) * k, box.max[2] + dir[2] * (size[2]! + a.gap) * k],
    };
    const total = toWorldBox(ctx, boxUnion(box, last), a.space);
    const dest = toWorldBox(ctx, boxUnion(last, last), a.space);
    checkInside(ctx, dest, 'stack result', a.clip);
    const session = newSession(ctx, `stack x${k}`);
    await session.prefetch(total);
    const sink = spaceSink(ctx, session, a.space, a.clip);
    stackRegion(sink, box, k, dir, { gap: a.gap, ignoreAir: a.ignoreAir });
    const st = await commit(ctx, session, `stack x${k}`);
    return `stacked ${a.space} ${fmtBox(box)} ${k}x ${a.direction}: ${statsText(st)}`;
  },
});

export const moveTool = defineTool({
  name: 'move',
  title: 'Move a region',
  mutates: true,
  description: 'Move the contents of a box by offset [dx,dy,dz]; the vacated area becomes `fill` (default air). One undo step.',
  input: z.object({
    box: BoxIn,
    space: SpaceIn,
    offset: Vec3In,
    fill: z.string().default('minecraft:air'),
    clip: z.boolean().default(false),
  }),
  async run(a, ctx) {
    const box = normBoxIn(a.box);
    const o = a.offset as Vec3;
    const dest: Box = { min: [box.min[0] + o[0], box.min[1] + o[1], box.min[2] + o[2]], max: [box.max[0] + o[0], box.max[1] + o[1], box.max[2] + o[2]] };
    const wsrc = toWorldBox(ctx, box, a.space);
    const wdest = toWorldBox(ctx, dest, a.space);
    checkInside(ctx, boxUnion(wsrc, wdest), 'move', a.clip);
    const fill = ctx.env.registry().canonical(a.fill);
    const session = newSession(ctx, 'move');
    await session.prefetch(boxUnion(wsrc, wdest));
    const sink = spaceSink(ctx, session, a.space, a.clip);
    moveRegion(sink, box, o, { fill });
    const st = await commit(ctx, session, 'move');
    return `moved ${a.space} ${fmtBox(box)} by ${fmtV(o)}: ${statsText(st)}`;
  },
});

export const saveStructure = defineTool({
  name: 'save_structure',
  title: 'Save to structure library',
  description:
    'Save a clipboard (or a box, copied first) to the persistent structure library (~/.mcai/structures, Sponge .schem) so later jobs can reuse it. ' +
    'Structures are stored in LOCAL orientation (front facing +z). Give a descriptive name, description and tags (e.g. ["tower","medieval"]).',
  input: z.object({
    name: z.string().min(1).max(64),
    clipboard: z.string().default('main'),
    box: BoxIn.optional().describe('if given, copy this box first (origin = box.min unless origin given)'),
    origin: Vec3In.optional(),
    space: SpaceIn,
    description: z.string().max(500).default(''),
    tags: z.array(z.string().max(32)).max(12).default([]),
  }),
  async run(a, ctx) {
    let stored = clips(ctx).get(a.clipboard);
    if (a.box) {
      const box = normBoxIn(a.box);
      const session = await readSession(ctx, toWorldBox(ctx, box, a.space));
      const c = copyFromSink(spaceSink(ctx, session, a.space, true), box, (a.origin ?? box.min) as Vec3);
      stored = { clip: c, space: a.space };
      clips(ctx).set(a.clipboard, stored);
    }
    if (!stored) throw new ToolError(`no clipboard '${a.clipboard}' — copy something first or pass box`);
    const c = clipFor(ctx, stored, 'local');
    const meta = await ctx.env.structures.save(a.name, c, { description: a.description, tags: a.tags, author: `mcai job ${ctx.job.id}` });
    return `saved structure '${meta.name}' (${meta.slug}.schem, size ${meta.size.join('x')}, ${meta.blocks} blocks)`;
  },
});

export const loadStructure = defineTool({
  name: 'load_structure',
  title: 'Load from structure library',
  readOnly: true,
  description: 'Load a saved structure into a clipboard (local orientation, front = +z). Then place it with paste (rotate/mirror as needed). Returns size and origin.',
  input: z.object({ name: z.string().min(1).max(64), clipboard: z.string().default('main') }),
  async run(a, ctx) {
    const c = await ctx.env.structures.load(a.name);
    clips(ctx).set(a.clipboard, { clip: c, space: 'local' });
    const b = c.volume.box;
    const size = [b.max[0] - b.min[0] + 1, b.max[1] - b.min[1] + 1, b.max[2] - b.min[2] + 1];
    return `loaded '${a.name}' into clipboard '${a.clipboard}': size ${size.join('x')}, origin offset ${fmtV(c.origin)} (from the min corner), ${clipboardBlockCount(c)} blocks${c.meta?.description ? `\n${c.meta.description}` : ''}`;
  },
});

export const listStructures = defineTool({
  name: 'list_structures',
  title: 'List saved structures',
  readOnly: true,
  description: 'List structures in the library (name, size, block count, tags, description). Optional text query or tag filter.',
  input: z.object({ query: z.string().max(80).optional(), tag: z.string().max(32).optional() }),
  async run(a, ctx) {
    const list = await ctx.env.structures.list({ query: a.query, tag: a.tag });
    if (!list.length) return 'no structures saved yet';
    return list.slice(0, 100).map((m) => `${m.name} — ${m.size.join('x')}, ${m.blocks} blocks${m.tags.length ? ` [${m.tags.join(', ')}]` : ''}${m.description ? `: ${m.description.slice(0, 120)}` : ''}`).join('\n');
  },
});

export const clipboardTools: ToolDef[] = [copyTool, pasteTool, stackTool, moveTool, saveStructure, loadStructure, listStructures];
