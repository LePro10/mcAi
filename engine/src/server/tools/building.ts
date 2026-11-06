// Building tools: build (DSL ops), run_script, terraform, place_prefab, clear.

import { z } from 'zod';
import type { Box, Vec3 } from '../../core/types.ts';
import { BuildOpSchema, DSL_HELP, executeOps, OpError, type BuildOp } from '../../core/dsl.ts';
import { runScript } from '../../core/script.ts';
import { listPrefabs, placePrefab } from '../../core/prefabs.ts';
import { compileMask, type MaskSpec } from '../../core/mask.ts';
import { boxContains, boxIntersect, boxVolume } from '../../core/volume.ts';
import { isAir, blockId } from '../../core/blockstate.ts';
import { rotateState, type QuarterTurns } from '../../core/transform.ts';
import { analyzeColumns, isVegetation, isWater, prefetchTerrain, terraform } from '../terrain.ts';
import {
  BoxIn,
  DrySink,
  SpaceIn,
  SpaceSink,
  ToolError,
  Vec3In,
  allowedText,
  commit,
  defineTool,
  fmtBox,
  frameOf,
  newSession,
  normBoxIn,
  perCallLimit,
  prefetch,
  spaceFrame,
  statsText,
  toWorldBox,
  type ToolDef,
} from './common.ts';

function zodIssues(err: z.ZodError, max = 6): string {
  return err.issues
    .slice(0, max)
    .map((i) => `${i.path.join('.') || '(op)'}: ${i.message}`)
    .join('; ');
}

/** Validate ops one by one for precise, actionable errors. */
export function parseOps(raw: unknown[]): BuildOp[] {
  const out: BuildOp[] = [];
  raw.forEach((o, i) => {
    const r = BuildOpSchema.safeParse(o);
    if (!r.success) {
      const name = (o as { op?: unknown })?.op;
      throw new ToolError(`op #${i}${typeof name === 'string' ? ` (${name})` : ''} is invalid: ${zodIssues(r.error)}`);
    }
    out.push(r.data);
  });
  return out;
}

export const buildTool = defineTool({
  name: 'build',
  title: 'Build (batched shape ops)',
  mutates: true,
  description:
    'Place blocks with a batch of declarative shape ops, executed in order (later ops overwrite earlier ones) as ONE undo step. ' +
    "Coordinates in space 'local' (default; front facade faces +z toward the player, block facings are local too — 'north' = away from the player) or 'world'. " +
    'Fences/panes/walls/stairs connect automatically; doors/beds/tall plants get their other half. ' +
    'Edits must stay inside the allowed build box (else error; clip:true drops outside blocks). Max blocks per call: see get_context limits (default 500k) — split big builds into several calls (foundation, walls, roof, details). ' +
    'Returns per-op block counts, warnings and the undo id.\n' +
    DSL_HELP,
  input: z.object({
    ops: z.array(z.looseObject({ op: z.string() })).min(1).max(500),
    space: SpaceIn,
    label: z.string().max(80).optional().describe('short name of this step, e.g. "walls" (shown to the player)'),
    seed: z.number().int().optional().describe('random seed for patterns'),
    clip: z.boolean().default(false),
  }),
  async run(a, ctx) {
    const { job, env } = ctx;
    const reg = env.registry();
    const ops = parseOps(a.ops);
    const frame = spaceFrame(ctx, a.space);
    const limit = perCallLimit(ctx);
    const label = a.label ?? `build ${ops.length} op${ops.length === 1 ? '' : 's'}`;
    // pass 1: dry run → extent, bounds, size
    const dry = new DrySink(job.allowedBox, limit);
    const perOpOutside: string[] = [];
    try {
      for (let i = 0; i < ops.length; i++) {
        const before = dry.outside;
        try {
          executeOps([ops[i]!], { sink: dry, reg, frame, seed: a.seed });
        } catch (e) {
          if (e instanceof OpError) throw new ToolError(`op #${i} (${ops[i]!.op}): ${e.message}`);
          throw e;
        }
        if (dry.outside > before && !a.clip) {
          perOpOutside.push(`op #${i} (${ops[i]!.op}) writes ${dry.outside - before} blocks outside`);
        }
      }
    } catch (e) {
      if ((e as Error).name === 'LimitError') throw new ToolError(`this build would set more than ${limit.toLocaleString('en')} blocks in one call. Split it into several build calls (or use hollow shapes).`);
      throw e;
    }
    if (perOpOutside.length && !a.clip) {
      const ob: Box = { min: dry.outsideMin, max: dry.outsideMax };
      throw new ToolError(`${perOpOutside.slice(0, 6).join('; ')}. Outside blocks span world ${fmtBox(ob)}. ${allowedText(ctx)}. Nothing was built — fix the coordinates or pass clip:true.`);
    }
    // pass 2: real run
    const session = newSession(ctx, label, limit);
    await prefetch(ctx, session, dry.box, 1);
    const sink = new SpaceSink(session, null, job.allowedBox, a.clip);
    let results;
    try {
      results = executeOps(ops, { sink, reg, frame, seed: a.seed });
    } catch (e) {
      session.discard();
      if (e instanceof OpError) throw new ToolError(`op #${e.index} (${ops[e.index]?.op}): ${e.message}`);
      throw e;
    }
    const st = await commit(ctx, session, label);
    const lines = results.map((r, i) => `#${i} ${r.op}: ${r.changed}${r.warnings.length ? ` (${r.warnings.join('; ')})` : ''}`);
    return { text: `${label}: ${statsText(st)}${sink.outside ? `; ${sink.outside} outside blocks clipped` : ''}\n${lines.join('\n')}`, blocks: st.changed };
  },
});

export const runScriptTool = defineTool({
  name: 'run_script',
  title: 'Run a JS build script',
  mutates: true,
  description:
    'Run sandboxed JavaScript that generates blocks (for organic/procedural/repetitive work: trees, terrain details, windows in loops, statues, pixel art). One undo step. ' +
    "Coordinates are local (default) or world. API: set(x,y,z,block|fn), get(x,y,z) (existing blocks inside readBox + your own writes), fill(x1,y1,z1,x2,y2,z2,block), " +
    'shapes box/cuboid/ellipsoid/sphere/cylinder/cone/pyramid/torus/line/curve/polygon/arch/spiral(params, block|fn(x,y,z)) (params like build ops), positions(shape, params), ' +
    'roof({box,style,stairs,...}), pattern(spec)→fn, block(id,{props}), isAir(s), noise2/noise3/fbm2/fbm3, rand/randInt/chance/choice/shuffle (seeded), vec.*, log(...), info. ' +
    'Gradient patterns span the readBox by default; give from/to along the axis to control the range, e.g. pattern({type:"gradient",axis:"y",stops:[...],from:0,to:20}). No I/O, no require. Time limit default 15 s (max 120). Logs and errors (with line numbers) are returned verbatim — fix and rerun.',
  input: z.object({
    code: z.string().min(1).max(256 * 1024),
    space: SpaceIn,
    readBox: BoxIn.optional().describe('region readable via get() (same space; default = the allowed build box)'),
    label: z.string().max(80).optional(),
    seed: z.number().int().optional(),
    timeoutMs: z.number().int().min(100).max(120_000).default(15_000),
    clip: z.boolean().default(false),
  }),
  async run(a, ctx) {
    const { job, env } = ctx;
    const reg = env.registry();
    const limit = perCallLimit(ctx);
    const rb = a.readBox ? toWorldBox(ctx, normBoxIn(a.readBox), a.space) : job.allowedBox;
    let volume;
    if (boxVolume(rb) <= 4_000_000) volume = await env.backend().getBlocks(rb, job.dimension);
    const res = await runScript(
      {
        code: a.code,
        readBox: rb,
        volume,
        ...(a.space === 'local' ? { frame: { anchor: job.req.anchor, facing: job.req.facing } } : {}),
        seed: a.seed,
        timeoutMs: a.timeoutMs,
        maxBlocks: limit,
      },
      reg,
    );
    const logs = res.logs.length ? `\nlogs:\n${res.logs.join('\n').slice(0, 6000)}` : '';
    if (res.error) throw new ToolError(`script error (nothing built): ${res.error}${logs}`);
    const label = a.label ?? 'script';
    let outside = 0;
    for (const [x, y, z] of res.entries) if (!boxContains(job.allowedBox, x, y, z)) outside++;
    if (outside && !a.clip) throw new ToolError(`script produced ${outside} of ${res.entries.length} blocks outside the ${allowedText(ctx)}. Nothing was built — fix coordinates or pass clip:true.${logs}`);
    const session = newSession(ctx, label, limit);
    if (volume) session.addVolume(volume);
    let skipped = 0;
    for (const [x, y, z, s] of res.entries) {
      if (!boxContains(job.allowedBox, x, y, z)) {
        skipped++;
        continue;
      }
      session.set(x, y, z, s);
    }
    const st = await commit(ctx, session, label);
    return { text: `${label}: ${res.entries.length} blocks generated in ${Math.round(res.ms)} ms; ${statsText(st)}${skipped ? `; ${skipped} outside blocks clipped` : ''}${logs}`, blocks: st.changed };
  },
});

export const terraformTool = defineTool({
  name: 'terraform',
  title: 'Terraform the site',
  mutates: true,
  description:
    'Reshape natural ground in a footprint (box x/z; y ignored). Actions: ' +
    "'flatten' (level to y — default median ground — cut above/fill below; clearAbove removes trees/plants/blocks above the new ground inside the footprint; blend = width of a smooth slope ring outside the footprint), " +
    "'smooth' (average out bumps; radius, iterations), 'raise'/'lower' (by amount; shape 'dome' = hill/pit, 'flat' = plateau/basin), " +
    "'naturalize_edges' (blend the ground around a built footprint into the landscape: smooth ring of `width`, re-grass dirt, sprinkle grass/ferns). " +
    'Top/fill materials default to the local terrain (grass→dirt, sand→sandstone); override with top/fill. Only edits inside the allowed box. One undo step.',
  input: z.object({
    action: z.enum(['flatten', 'smooth', 'raise', 'lower', 'naturalize_edges']),
    box: BoxIn.describe('footprint; only x/z are used'),
    space: SpaceIn,
    y: z.number().int().optional().describe("flatten: target ground y in the given space (local: relative to anchor, 0 = anchor level)"),
    amount: z.number().int().min(1).max(64).optional().describe('raise/lower: blocks (default 3)'),
    shape: z.enum(['dome', 'flat']).optional(),
    radius: z.number().int().min(1).max(8).optional().describe('smooth: kernel radius (default 2)'),
    iterations: z.number().int().min(1).max(6).optional(),
    blend: z.number().int().min(0).max(24).optional().describe('flatten: slope ring width outside the footprint (default 4)'),
    width: z.number().int().min(1).max(16).optional().describe('naturalize_edges: ring width (default 3)'),
    clearAbove: z.boolean().optional(),
    top: z.string().optional().describe('surface block override, e.g. "grass_block"'),
    fill: z.string().optional().describe('subsurface block override, e.g. "dirt"'),
    seed: z.number().int().optional(),
  }),
  async run(a, ctx) {
    const { job, env } = ctx;
    const reg = env.registry();
    const be = env.backend();
    const lbox = normBoxIn(a.box);
    const wfoot = toWorldBox(ctx, { min: [lbox.min[0], 0, lbox.min[2]], max: [lbox.max[0], 0, lbox.max[2]] }, a.space);
    const ab = job.allowedBox;
    const ring = a.action === 'flatten' ? a.blend ?? 4 : a.action === 'naturalize_edges' ? a.width ?? 3 : 0;
    const areaRaw: Box = { min: [wfoot.min[0] - ring, ab.min[1], wfoot.min[2] - ring], max: [wfoot.max[0] + ring, ab.max[1], wfoot.max[2] + ring] };
    const area = boxIntersect(areaRaw, ab);
    const foot = boxIntersect({ min: [wfoot.min[0], ab.min[1], wfoot.min[2]], max: [wfoot.max[0], ab.max[1], wfoot.max[2]] }, ab);
    if (!area || !foot) throw new ToolError(`footprint does not overlap the ${allowedText(ctx)}`);
    const info = await be.info();
    const session = newSession(ctx, `terraform ${a.action}`);
    const { ylo, yhi } = await prefetchTerrain(be, session, area, ab.max[1], job.dimension, info.minY);
    const cols = analyzeColumns((x, y, z) => session.get(x, y, z), area, ylo, yhi, reg);
    let y: number | undefined;
    if (a.y !== undefined) y = a.space === 'local' ? job.req.anchor[1] + a.y : a.y;
    const canon = (s?: string) => (s ? blockId(reg.canonical(s)) : undefined);
    const r = terraform(
      { action: a.action, foot, area, allowed: ab, y, amount: a.amount, radius: a.radius, iterations: a.iterations, blend: a.blend, shape: a.shape, width: a.width, clearAbove: a.clearAbove, top: canon(a.top), fill: canon(a.fill), seed: a.seed },
      cols,
      (x, yy, z) => session.get(x, yy, z),
      (x, yy, z, s) => session.set(x, yy, z, s),
      reg,
    );
    const st = await commit(ctx, session, `terraform ${a.action}`);
    const ty = r.targetY !== undefined ? `, ground now y=${r.targetY}${a.space === 'local' ? ` (local ${r.targetY - job.req.anchor[1]})` : ''}` : '';
    return { text: `terraform ${a.action}: ${r.columns} columns changed (${r.raised} raised, ${r.lowered} lowered)${ty}; ${statsText(st)}${r.warnings.length ? `\nwarnings: ${r.warnings.join('; ')}` : ''}`, blocks: st.changed };
  },
});

function prefabHelp(): string {
  try {
    return listPrefabs().map((p) => p.name).join(', ');
  } catch {
    return '(call with name "list")';
  }
}

export const placePrefabTool = defineTool({
  name: 'place_prefab',
  title: 'Place a prefab',
  mutates: true,
  get description() {
    return (
      'Place a parametric prefab (ready-made detail: trees, lamps, furniture, wells, ...) with its base at `at`. ' +
      "Local space by default: the prefab's front faces +z (toward the player); rotate turns it clockwise (degrees). One undo step. Call with name:'list' once to see descriptions and params. Prefabs: " +
      prefabHelp()
    );
  },
  input: z.object({
    name: z.string().min(1).max(64),
    at: Vec3In.optional(),
    space: SpaceIn,
    params: z.record(z.string(), z.any()).default({}),
    rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
    seed: z.number().int().optional(),
    clip: z.boolean().default(false),
  }),
  async run(a, ctx) {
    const { job, env } = ctx;
    const reg = env.registry();
    const all = listPrefabs();
    if (a.name === 'list') return all.map((p) => `${p.name}: ${p.description}${Object.keys(p.params).length ? `\n  params: ${Object.entries(p.params).map(([k, v]) => `${k} (${v})`).join(', ')}` : ''}`).join('\n');
    if (!all.some((p) => p.name === a.name)) throw new ToolError(`unknown prefab '${a.name}'. Available: ${all.map((p) => p.name).join(', ')}`);
    if (!a.at) throw new ToolError('missing `at` position');
    const at = a.at as Vec3;
    const label = `prefab ${a.name}`;
    // rotation: wrap the space frame with an extra rotation around `at`
    const base = a.space === 'local' ? frameOf(ctx) : null;
    const turns = a.rotate / 90;
    const rot = (v: Vec3): Vec3 => {
      let x = v[0] - at[0], z = v[2] - at[2];
      for (let t = 0; t < turns; t++) [x, z] = [-z, x];
      return [at[0] + x, v[1], at[2] + z];
    };
    const toW = (v: Vec3): Vec3 => {
      const r = rot(v);
      return base ? base.toWorld(r) : r;
    };
    const stW = (s: string): string => {
      const r = turns ? rotateState(s, turns as QuarterTurns, reg) : s;
      return base ? base.stateToWorld(r) : r;
    };
    // dry run for bounds
    const dry = new DrySink(job.allowedBox, perCallLimit(ctx));
    const drySink = {
      get: (x: number, y: number, z: number) => { const w = toW([x, y, z]); return dry.get(w[0], w[1], w[2]); },
      set: (x: number, y: number, z: number, s: string) => { const w = toW([x, y, z]); dry.set(w[0], w[1], w[2], s); },
    };
    placePrefab(a.name, at, a.params, drySink, reg, a.seed);
    if (dry.outside && !a.clip) throw new ToolError(`prefab would place ${dry.outside} blocks outside the ${allowedText(ctx)}. Move it or pass clip:true.`);
    const session = newSession(ctx, label);
    await prefetch(ctx, session, dry.box, 1);
    let outside = 0;
    const sink = {
      get: (x: number, y: number, z: number) => { const w = toW([x, y, z]); const s = session.get(w[0], w[1], w[2]); return base ? base.stateToLocal(s) : s; },
      set: (x: number, y: number, z: number, s: string) => {
        const w = toW([x, y, z]);
        if (!boxContains(job.allowedBox, w[0], w[1], w[2])) { outside++; return; }
        session.set(w[0], w[1], w[2], stW(s));
      },
    };
    const n = placePrefab(a.name, at, a.params, sink, reg, a.seed);
    const st = await commit(ctx, session, label);
    return { text: `${label}: ${n} blocks; ${statsText(st)}${outside ? `; ${outside} clipped` : ''}`, blocks: st.changed };
  },
});

export const clearTool = defineTool({
  name: 'clear',
  title: 'Clear a region',
  mutates: true,
  description:
    "Remove blocks in a box (set to air). mode: 'all' (everything), 'vegetation' (trees, leaves, plants, snow layers), 'above_ground' (everything above the natural ground per column — site preparation), " +
    "'fluids' (water/lava). Optional mask further restricts what is removed (e.g. '#minecraft:logs'). One undo step.",
  input: z.object({
    box: BoxIn,
    space: SpaceIn,
    mode: z.enum(['all', 'vegetation', 'above_ground', 'fluids']).default('all'),
    mask: z.any().optional().describe('mask spec, e.g. "!air", "#minecraft:leaves", {any:["stone","dirt"]}'),
    clip: z.boolean().default(true).describe('default true: parts of the box outside the allowed box are ignored'),
  }),
  async run(a, ctx) {
    const { job, env } = ctx;
    const reg = env.registry();
    const be = env.backend();
    const box = normBoxIn(a.box);
    let wbox = toWorldBox(ctx, box, a.space);
    if (!a.clip && !boxIntersect(wbox, job.allowedBox)) throw new ToolError(`box is outside the ${allowedText(ctx)}`);
    const inter = boxIntersect(wbox, job.allowedBox);
    if (!inter) throw new ToolError(`box does not overlap the ${allowedText(ctx)}`);
    if (!a.clip && (inter.min.some((v, i) => v !== wbox.min[i]) || inter.max.some((v, i) => v !== wbox.max[i]))) {
      throw new ToolError(`box leaves the ${allowedText(ctx)}; pass clip:true to clear only the inside`);
    }
    wbox = inter;
    if (boxVolume(wbox) > 8_000_000) throw new ToolError('box too large (max 8M blocks per clear)');
    let mask: ((x: number, y: number, z: number, s: string) => boolean) | null = null;
    if (a.mask !== undefined) {
      try {
        mask = compileMask(a.mask as MaskSpec, reg);
      } catch (e) {
        throw new ToolError(`invalid mask: ${(e as Error).message}`);
      }
    }
    const session = newSession(ctx, `clear ${a.mode}`);
    let groundOf: ((x: number, z: number) => number) | null = null;
    if (a.mode === 'above_ground') {
      const info = await be.info();
      const { ylo, yhi } = await prefetchTerrain(be, session, wbox, wbox.max[1], job.dimension, info.minY);
      const cols = analyzeColumns((x, y, z) => session.get(x, y, z), wbox, ylo, yhi, reg);
      groundOf = (x, z) => cols.ground[(z - cols.z0) * cols.w + (x - cols.x0)]!;
    } else await session.prefetch(wbox);
    const f = a.space === 'local' ? frameOf(ctx) : null;
    let removed = 0;
    for (let y = wbox.min[1]; y <= wbox.max[1]; y++)
      for (let z = wbox.min[2]; z <= wbox.max[2]; z++)
        for (let x = wbox.min[0]; x <= wbox.max[0]; x++) {
          const s = session.get(x, y, z);
          if (isAir(s)) continue;
          if (a.mode === 'vegetation' && !isVegetation(s, reg)) continue;
          if (a.mode === 'fluids' && !(isWater(s) || blockId(s) === 'minecraft:lava')) continue;
          if (a.mode === 'above_ground') {
            const g = groundOf!(x, z);
            if (!Number.isNaN(g) && y <= g) continue;
          }
          if (mask) {
            const ls = f ? f.stateToLocal(s) : s;
            const lp = f ? f.toLocal([x, y, z]) : [x, y, z];
            if (!mask(lp[0]!, lp[1]!, lp[2]!, ls)) continue;
          }
          session.set(x, y, z, 'minecraft:air');
          removed++;
        }
    const st = await commit(ctx, session, `clear ${a.mode}`);
    return { text: `clear ${a.mode} in world ${fmtBox(wbox)}: removed ${removed}; ${statsText(st)}`, blocks: st.changed };
  },
});

export const buildingTools: ToolDef[] = [buildTool, runScriptTool, terraformTool, placePrefabTool, clearTool];
