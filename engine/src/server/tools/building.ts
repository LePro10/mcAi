// Building tools: build (DSL ops), run_script, terraform, place_prefab, clear.

import { z } from 'zod';
import type { BlockVolume, Box, Vec3 } from '../../core/types.ts';
import { BuildOpSchema, DSL_HELP, executeOps, OpError, type BuildOp } from '../../core/dsl.ts';
import { runScript } from '../../core/script.ts';
import type { EditSession } from '../../core/session.ts';
import { listPrefabs, placePrefab } from '../../core/prefabs.ts';
import { compileMask, type MaskSpec } from '../../core/mask.ts';
import { compilePattern } from '../../core/pattern.ts';
import { boxContains, boxIntersect, boxVolume, volGet, volIndex } from '../../core/volume.ts';
import { isAir, blockId } from '../../core/blockstate.ts';
import { rotateState, type QuarterTurns } from '../../core/transform.ts';
import { analyzeColumns, isVegetation, prefetchTerrain, terraform } from '../terrain.ts';
import { isFluidState, isWaterPlant, removedState, setProp } from '../../core/support.ts';
import { isNaturalGround, naturalTreeMask, posOf, treeDebrisMask } from '../../core/trees.ts';
import { GENERATOR_NAME_RE, GeneratorLibrary, referencedGenerators } from '../generators.ts';
import { propOf } from '../../core/registry.ts';
import {
  BoxIn,
  DrySink,
  SpaceIn,
  SupportIn,
  SpaceSink,
  ToolError,
  Vec3In,
  allowedText,
  commit,
  defineTool,
  fmtBox,
  frameOf,
  jobOriginals,
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

/** Validate ops one by one for precise, actionable errors (throws on the first invalid op). */
export function parseOps(raw: unknown[]): BuildOp[] {
  const { ops, invalid } = validateOps(raw);
  if (invalid.length) throw new ToolError(invalid[0]!.text);
  return ops.map((o) => o.op);
}

interface InvalidOp {
  index: number;
  text: string;
}

/** Schema-validate every op; returns the valid ones (with their original index) and ALL invalid ones. */
export function validateOps(raw: unknown[]): { ops: { index: number; op: BuildOp }[]; invalid: InvalidOp[] } {
  const ops: { index: number; op: BuildOp }[] = [];
  const invalid: InvalidOp[] = [];
  raw.forEach((o, i) => {
    const r = BuildOpSchema.safeParse(o);
    if (!r.success) {
      const name = (o as { op?: unknown })?.op;
      invalid.push({ index: i, text: `op #${i}${typeof name === 'string' ? ` (${name})` : ''} is invalid: ${zodIssues(r.error)}` });
    } else ops.push({ index: i, op: r.data });
  });
  return { ops, invalid };
}

function invalidText(invalid: InvalidOp[], max = 20): string {
  const sorted = [...invalid].sort((a, b) => a.index - b.index);
  const lines = sorted.slice(0, max).map((x) => `  ${x.text}`);
  if (sorted.length > max) lines.push(`  … ${sorted.length - max} more`);
  return lines.join('\n');
}

export const buildTool = defineTool({
  name: 'build',
  title: 'Build (batched shape ops)',
  mutates: true,
  description:
    'Place blocks with a batch of declarative shape ops, executed in order (later ops overwrite earlier ones) as ONE undo step. ' +
    "Coordinates in space 'local' (default; front facade faces +z toward the player, block facings are local too — 'north' = away from the player) or 'world'. " +
    'Fences/panes/walls/stairs connect automatically; doors/beds/tall plants get their other half; unsupported attachables (floating vines/torches, flowers on stone) are dropped (support). ' +
    'Edits must stay inside the allowed build box (else error; clip:true drops outside blocks). Max blocks per call: see get_context limits (default 500k) — split big builds into several calls (foundation, walls, roof, details). ' +
    'All ops are validated first: invalid ops are listed together and nothing is built, unless skipInvalid:true (valid ops run, invalid ones are reported). ' +
    'Returns per-op block counts, warnings and the undo id.\n' +
    DSL_HELP,
  input: z.object({
    ops: z.array(z.looseObject({ op: z.string() })).min(1).max(500),
    space: SpaceIn,
    label: z.string().max(80).optional().describe('short name of this step, e.g. "walls" (shown to the player)'),
    seed: z.number().int().optional().describe('random seed for patterns'),
    clip: z.boolean().default(false),
    skipInvalid: z.boolean().default(false).describe('run the valid ops and report the invalid ones instead of failing the whole batch'),
    support: SupportIn,
  }),
  async run(a, ctx) {
    const { job, env } = ctx;
    const reg = env.registry();
    const { ops: parsed, invalid } = validateOps(a.ops);
    const frame = spaceFrame(ctx, a.space);
    const limit = perCallLimit(ctx);
    // pass 1: dry run of every schema-valid op → extent, bounds, size, per-op errors.
    // Ops that read the terrain (bridge piers) need the real world during the dry run.
    let early: EditSession | null = null;
    if (parsed.some((p) => p.op.op === 'bridge')) {
      early = newSession(ctx, a.label ?? 'build', limit);
      await prefetch(ctx, early, job.allowedBox, 1);
    }
    const dry = new DrySink(job.allowedBox, limit, early ? (x, y, z) => early!.get(x, y, z) : null);
    const good: { index: number; op: BuildOp }[] = [];
    let outsideMin: Vec3 | null = null, outsideMax: Vec3 | null = null;
    try {
      for (const { index, op } of parsed) {
        const before = dry.outside;
        const oMin = [...dry.outsideMin] as Vec3, oMax = [...dry.outsideMax] as Vec3;
        try {
          executeOps([op], { sink: dry, reg, frame, seed: a.seed === undefined ? undefined : a.seed + index });
        } catch (e) {
          if (e instanceof OpError) {
            invalid.push({ index, text: `op #${index} (${op.op}): ${e.message}` });
            continue;
          }
          throw e;
        }
        if (dry.outside > before && !a.clip) {
          invalid.push({ index, text: `op #${index} (${op.op}) writes ${dry.outside - before} blocks outside the allowed box` });
          outsideMin = outsideMin ? (outsideMin.map((v, i) => Math.min(v, dry.outsideMin[i]!)) as Vec3) : ([...dry.outsideMin] as Vec3);
          outsideMax = outsideMax ? (outsideMax.map((v, i) => Math.max(v, dry.outsideMax[i]!)) as Vec3) : ([...dry.outsideMax] as Vec3);
          dry.outsideMin = oMin;
          dry.outsideMax = oMax;
          continue;
        }
        good.push({ index, op });
      }
    } catch (e) {
      if ((e as Error).name === 'LimitError') throw new ToolError(`this build would set more than ${limit.toLocaleString('en')} blocks in one call. Split it into several build calls (or use hollow shapes).`);
      throw e;
    }
    const outsideNote = outsideMin && outsideMax ? ` Outside blocks span world ${fmtBox({ min: outsideMin, max: outsideMax })}; ${allowedText(ctx)} (clip:true drops outside blocks).` : '';
    if (invalid.length === 1 && !a.skipInvalid) {
      throw new ToolError(`${invalid[0]!.text}.${outsideNote} Nothing was built — fix it${a.ops.length > 1 ? ' (or pass skipInvalid:true to build the other ops)' : ''}.`);
    }
    if (invalid.length && !a.skipInvalid) {
      throw new ToolError(`${invalid.length} of ${a.ops.length} ops are invalid — nothing was built. Fix them (or pass skipInvalid:true to build only the valid ops):\n${invalidText(invalid)}${outsideNote}`);
    }
    if (!good.length) throw new ToolError(`no valid ops to build:\n${invalidText(invalid)}${outsideNote}`);
    const ops = good.map((g) => g.op);
    const label = a.label ?? `build ${ops.length} op${ops.length === 1 ? '' : 's'}`;
    // pass 2: real run
    const session = early ?? newSession(ctx, label, limit);
    if (!early) await prefetch(ctx, session, dry.box, 1);
    session.label = label;
    const sink = new SpaceSink(session, null, job.allowedBox, a.clip);
    let results;
    try {
      results = good.map((g) => executeOps([g.op], { sink, reg, frame, seed: a.seed === undefined ? undefined : a.seed + g.index })[0]!);
    } catch (e) {
      session.discard();
      if (e instanceof OpError) throw new ToolError(`${e.message}`);
      throw e;
    }
    const st = await commit(ctx, session, label, { support: a.support, space: a.space });
    const lines = results.map((r, i) => `#${good[i]!.index} ${r.op}: ${r.changed}${r.warnings.length ? ` (${r.warnings.join('; ')})` : ''}`);
    const skipped = invalid.length ? `\nSKIPPED ${invalid.length} invalid op(s):\n${invalidText(invalid)}${outsideNote}` : '';
    return { text: `${label}: ${statsText(st)}${sink.outside ? `; ${sink.outside} outside blocks clipped` : ''}\n${lines.join('\n')}${skipped}`, blocks: st.changed };
  },
});

/** Natural ground per column (world) for groundY(): skips plants, leaves, tree logs and this job's builds. */
async function groundMap(ctx: Parameters<typeof commit>[0], foot: Box): Promise<{ x0: number; z0: number; w: number; d: number; data: Float64Array } | null> {
  const { job, env } = ctx;
  const be = env.backend();
  const reg = env.registry();
  const info = await be.info();
  const hm = await be.heightmap(foot.min[0], foot.min[2], foot.max[0], foot.max[2], 'surface', job.dimension);
  let lo = Infinity, hi = -Infinity;
  for (const h of hm.data) {
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  if (!Number.isFinite(lo)) return null;
  const ylo = Math.max(info.minY, lo - 40);
  const fb: Box = { min: [foot.min[0], ylo, foot.min[2]], max: [foot.max[0], hi, foot.max[2]] };
  if (boxVolume(fb) > 12_000_000) return null;
  const vol = await be.getBlocks(fb, job.dimension);
  const orig = jobOriginals(ctx);
  const get = (x: number, y: number, z: number) => {
    const cur = volGet(vol, x, y, z);
    const o = orig.size ? orig.get(x, y, z) : undefined;
    // the job's own (non-terrain) builds are ignored: look at what was there before
    return o !== undefined && !isNaturalGround(cur) ? o : cur;
  };
  const cols = analyzeColumns(get, fb, ylo, hi, reg);
  return { x0: cols.x0, z0: cols.z0, w: cols.w, d: cols.d, data: cols.ground };
}

function jobGenerators(ctx: Parameters<typeof commit>[0]): Map<string, string> {
  let m = ctx.job.scratch.get('generators') as Map<string, string> | undefined;
  if (!m) ctx.job.scratch.set('generators', (m = new Map()));
  return m;
}

/** generator sources visible to a script: this job's define()s + library entries referenced via call("name") (transitively) */
function generatorsFor(ctx: Parameters<typeof commit>[0], code: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of jobGenerators(ctx)) out[k] = v;
  const lib = new GeneratorLibrary();
  const todo = referencedGenerators(code);
  const seen = new Set<string>();
  while (todo.length) {
    const n = todo.pop()!;
    if (seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    let src = out[n];
    if (src === undefined) {
      const d = lib.load(n);
      if (!d) continue;
      src = out[d.name] = d.code;
    }
    todo.push(...referencedGenerators(src));
  }
  return out;
}

export const runScriptTool = defineTool({
  name: 'run_script',
  title: 'Run a JS build script',
  mutates: true,
  description:
    'Run sandboxed JavaScript that generates blocks (for organic/procedural/repetitive work: trees, terrain details, windows in loops, statues, pixel art). One undo step. ' +
    "Coordinates are local (default) or world. API: set(x,y,z,block|fn), setSoft(x,y,z,block) (only into air/grass/flowers; returns placed?), get(x,y,z) (existing blocks inside readBox + your own writes), " +
    'groundY(x,z) (natural ground y: ignores plants, leaves, tree logs and your own builds), protect(box)/unprotect() (later sets inside are ignored), fill(x1,y1,z1,x2,y2,z2,block), ' +
    'shapes box/cuboid/ellipsoid/sphere/cylinder/cone/pyramid/torus/line/curve/polygon/arch/spiral(params, block|fn(x,y,z)) (params like build ops), positions(shape, params), ' +
    'roof({box,style,stairs,...}), pattern(spec)→fn, block(id,{props}), isAir(s), noise2/noise3/fbm2/fbm3, rand/randInt/chance/choice/shuffle (seeded), vec.*, log(...), info. ' +
    'Reusable modules: define(name, function(params){…}) keeps a generator for the rest of the job; call(name, params) runs it (also generators saved with save_generator; list_generators). ' +
    'Gradient patterns span the readBox by default; give from/to along the axis to control the range, e.g. pattern({type:"gradient",axis:"y",stops:[...],from:0,to:20}). No I/O, no require. Time limit default 15 s (max 120). Logs and errors (with line numbers) are returned verbatim — fix and rerun.',
  input: z.object({
    code: z.string().min(1).max(256 * 1024),
    space: SpaceIn,
    readBox: BoxIn.optional().describe('region readable via get() and groundY() (same space; default = the allowed build box)'),
    label: z.string().max(80).optional(),
    seed: z.number().int().optional(),
    timeoutMs: z.number().int().min(100).max(120_000).default(15_000),
    clip: z.boolean().default(false),
    support: SupportIn,
  }),
  async run(a, ctx) {
    const { job, env } = ctx;
    const reg = env.registry();
    const limit = perCallLimit(ctx);
    const rb = a.readBox ? toWorldBox(ctx, normBoxIn(a.readBox), a.space) : job.allowedBox;
    let volume;
    if (boxVolume(rb) <= 4_000_000) volume = await env.backend().getBlocks(rb, job.dimension);
    const generators = generatorsFor(ctx, a.code);
    const allCode = a.code + '\n' + Object.values(generators).join('\n');
    const ground = /\bgroundY\s*\(/.test(allCode) ? await groundMap(ctx, rb) : null;
    const res = await runScript(
      {
        code: a.code,
        readBox: rb,
        volume,
        ...(a.space === 'local' ? { frame: { anchor: job.req.anchor, facing: job.req.facing } } : {}),
        seed: a.seed,
        timeoutMs: a.timeoutMs,
        maxBlocks: limit,
        ...(ground ? { ground } : {}),
        generators,
      },
      reg,
    );
    const logs = res.logs.length ? `\nlogs:\n${res.logs.join('\n').slice(0, 6000)}` : '';
    if (res.error) throw new ToolError(`script error (nothing built): ${res.error}${logs}`);
    const defined = Object.keys(res.defines ?? {});
    for (const [k, v] of Object.entries(res.defines ?? {})) jobGenerators(ctx).set(k, v);
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
    const st = await commit(ctx, session, label, { support: a.support, space: a.space });
    const extra = [
      skipped ? `${skipped} outside blocks clipped` : '',
      res.protectedSkips ? `${res.protectedSkips} sets inside protect()ed boxes ignored` : '',
      defined.length ? `defined generator(s) ${defined.join(', ')} — call(name, params) in later scripts; save_generator to keep them for future jobs` : '',
    ].filter(Boolean);
    return { text: `${label}: ${res.entries.length} blocks generated in ${Math.round(res.ms)} ms; ${statsText(st)}${extra.length ? `; ${extra.join('; ')}` : ''}${logs}`, blocks: st.changed };
  },
});

export const saveGeneratorTool = defineTool({
  name: 'save_generator',
  title: 'Save a script generator',
  description:
    'Persist a reusable run_script generator in the library (~/.mcai/generators) so future jobs can call(name, params) it. ' +
    'code = function body using `params` (default: the code of define(name, …) from this job). Document params with defaults.',
  input: z.object({
    name: z.string().regex(GENERATOR_NAME_RE).describe('e.g. "elvenTree"'),
    description: z.string().min(3).max(400),
    params: z.record(z.string(), z.string().max(200)).default({}).describe('param → meaning/default, e.g. {height:"trunk height, default 14"}'),
    code: z.string().max(128 * 1024).optional(),
  }),
  async run(a, ctx) {
    const code = a.code ?? jobGenerators(ctx).get(a.name);
    if (!code) throw new ToolError(`no code: pass code or define("${a.name}", …) in a run_script first. Defined in this job: ${[...jobGenerators(ctx).keys()].join(', ') || 'none'}`);
    let d;
    try {
      d = new GeneratorLibrary().save({ name: a.name, description: a.description, params: a.params, code });
    } catch (e) {
      throw new ToolError((e as Error).message);
    }
    jobGenerators(ctx).set(a.name, code);
    return `saved generator "${d.name}" (${code.length} chars) — use call("${d.name}", {...}) in run_script`;
  },
});

export const listGeneratorsTool = defineTool({
  name: 'list_generators',
  title: 'List script generators',
  readOnly: true,
  description: 'List reusable run_script generators: saved library entries (name, description, params) and the ones defined in this job. Use them with call(name, params).',
  input: z.object({ query: z.string().max(80).optional() }),
  async run(a, ctx) {
    const lib = new GeneratorLibrary().list(a.query);
    const job = [...jobGenerators(ctx).keys()].filter((n) => !lib.some((d) => d.name === n));
    const lines = lib.map((d) => `${d.name}: ${d.description}${Object.keys(d.params).length ? `\n  params: ${Object.entries(d.params).map(([k, v]) => `${k} (${v})`).join(', ')}` : ''}`);
    if (job.length) lines.push(`defined in this job (not saved): ${job.join(', ')}`);
    return lines.length ? lines.join('\n') : 'no generators yet — define(name, function(params){…}) in run_script, then save_generator';
  },
});

export const terraformTool = defineTool({
  name: 'terraform',
  title: 'Terraform the site',
  mutates: true,
  description:
    'Reshape natural ground in a footprint (box x/z; y ignored). Actions: ' +
    "'flatten' (level to y — default median ground — cut above/fill below; clearAbove removes trees/plants/blocks above the new ground inside the footprint; blend = minimum width of the smooth slope ring outside the footprint, widened automatically where the height difference needs it; retainingWall:'stone_bricks' (block/pattern) instead walls the pad edge down to the natural ground and lines cut faces), " +
    "'smooth' (average out bumps; radius, iterations), 'raise'/'lower' (by amount; shape 'dome' = hill/pit, 'flat' = plateau/basin), " +
    "'naturalize_edges' (blend the ground around a built footprint into the landscape: smooth ring of `width`, re-grass dirt, sprinkle grass/ferns). " +
    'Top/fill materials default to the local terrain (grass→dirt, sand→sandstone); override with top/fill. Water is never drained (waterlogged plants become water). Only edits inside the allowed box. One undo step.',
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
    retainingWall: z.string().optional().describe('flatten: wall block/pattern for the pad edge, e.g. "70%stone_bricks,30%mossy_stone_bricks"'),
    seed: z.number().int().optional(),
  }),
  async run(a, ctx) {
    const { job, env } = ctx;
    const reg = env.registry();
    const be = env.backend();
    const lbox = normBoxIn(a.box);
    const wfoot = toWorldBox(ctx, { min: [lbox.min[0], 0, lbox.min[2]], max: [lbox.max[0], 0, lbox.max[2]] }, a.space);
    const ab = job.allowedBox;
    const blend0 = a.blend ?? (a.retainingWall ? 0 : 4);
    const ring = a.action === 'flatten' ? Math.max(1, Math.min(24, blend0 * 2 + 2)) : a.action === 'naturalize_edges' ? a.width ?? 3 : 0;
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
    let retainingWall: ((x: number, y: number, z: number) => string | null) | undefined;
    if (a.retainingWall) {
      try {
        const pat = compilePattern(a.retainingWall, reg, { seed: a.seed });
        const f = a.space === 'local' ? frameOf(ctx) : null;
        retainingWall = f ? (x, yy, z) => { const l = f.toLocal([x, yy, z]); const st = pat(l[0], l[1], l[2]); return st && f.stateToWorld(st); } : pat;
      } catch (e) {
        throw new ToolError(`retainingWall: ${(e as Error).message}`);
      }
    }
    const r = terraform(
      { action: a.action, foot, area, allowed: ab, y, amount: a.amount, radius: a.radius, iterations: a.iterations, blend: a.blend, shape: a.shape, width: a.width, clearAbove: a.clearAbove, top: canon(a.top), fill: canon(a.fill), seed: a.seed, retainingWall },
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
    support: SupportIn,
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
    const st = await commit(ctx, session, label, { support: a.support, space: a.space });
    return { text: `${label}: ${n} blocks; ${statsText(st)}${outside ? `; ${outside} clipped` : ''}`, blocks: st.changed };
  },
});

export const clearTool = defineTool({
  name: 'clear',
  title: 'Clear a region',
  mutates: true,
  description:
    "Remove blocks in a box. mode: 'all' (everything incl. fluids), 'vegetation' (trees, leaves, plants, snow layers — waterlogged/underwater plants become water; water itself is kept), " +
    "'above_ground' (everything above the natural ground per column, keeps water — site preparation), 'fluids' (drain water/lava; un-waterlogs blocks), " +
    "'natural_trees' (whole natural trees: logs/leaves connected to natural leaves, never this job's own blocks), 'tree_debris' (leaves > 6 from any log, log pieces cut off from trunk/ground — after trimming trees). " +
    "onlyUnbuilt:true skips positions this job built. Optional mask restricts further (mask 'natural_trees' also works with other modes). Blocks that lose their support (vines, torches…) are removed too. One undo step.",
  input: z.object({
    box: BoxIn,
    space: SpaceIn,
    mode: z.enum(['all', 'vegetation', 'above_ground', 'fluids', 'natural_trees', 'tree_debris']).default('all'),
    mask: z.any().optional().describe('mask spec, e.g. "!air", "#minecraft:leaves", {any:["stone","dirt"]}, or "natural_trees"'),
    onlyUnbuilt: z.boolean().default(false).describe("skip positions edited by this job"),
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
    let maskSpec = a.mask as MaskSpec | undefined;
    let natMask = false;
    if (maskSpec === 'natural_trees') {
      natMask = true;
      maskSpec = undefined;
    }
    let mask: ((x: number, y: number, z: number, s: string) => boolean) | null = null;
    if (maskSpec !== undefined) {
      try {
        mask = compileMask(maskSpec, reg);
      } catch (e) {
        throw new ToolError(`invalid mask: ${(e as Error).message}`);
      }
    }
    const needTrees = a.mode === 'natural_trees' || a.mode === 'tree_debris' || natMask;
    const originals = a.onlyUnbuilt || needTrees ? jobOriginals(ctx) : null;
    const session = newSession(ctx, `clear ${a.mode}`);
    const info = await be.info();
    let groundOf: ((x: number, z: number) => number) | null = null;
    let tvol: BlockVolume | null = null;
    let natural: Uint8Array | null = null;
    let debris: Uint8Array | null = null;
    if (a.mode === 'above_ground') {
      const { ylo, yhi } = await prefetchTerrain(be, session, wbox, wbox.max[1], job.dimension, info.minY);
      const cols = analyzeColumns((x, y, z) => session.get(x, y, z), wbox, ylo, yhi, reg);
      groundOf = (x, z) => cols.ground[(z - cols.z0) * cols.w + (x - cols.x0)]!;
    } else if (needTrees) {
      // trees reach beyond the box: analyse with a margin so trunks/anchors outside are seen
      let abox: Box = { min: [wbox.min[0] - 8, Math.max(info.minY, wbox.min[1] - 8), wbox.min[2] - 8], max: [wbox.max[0] + 8, Math.min(info.maxY, wbox.max[1] + 8), wbox.max[2] + 8] };
      if (boxVolume(abox) > 12_000_000) abox = wbox;
      tvol = await be.getBlocks(abox, job.dimension);
      session.addVolume(tvol);
      const tv = tvol;
      if (a.mode === 'natural_trees' || natMask) natural = naturalTreeMask(tv, reg, (i) => { const p = posOf(tv, i); return originals!.has(p[0], p[1], p[2]); });
      if (a.mode === 'tree_debris') debris = treeDebrisMask(tv, reg).mask;
    } else await session.prefetch(wbox);
    const f = a.space === 'local' ? frameOf(ctx) : null;
    let removed = 0, skippedBuilt = 0;
    for (let y = wbox.min[1]; y <= wbox.max[1]; y++)
      for (let z = wbox.min[2]; z <= wbox.max[2]; z++)
        for (let x = wbox.min[0]; x <= wbox.max[0]; x++) {
          const s = session.get(x, y, z);
          if (isAir(s)) continue;
          if (originals && a.onlyUnbuilt && originals.has(x, y, z)) {
            skippedBuilt++;
            continue;
          }
          const vi = tvol ? volIndex(tvol.box, x, y, z) : -1;
          let to = 'minecraft:air';
          switch (a.mode) {
            case 'vegetation':
              if (!isVegetation(s, reg)) continue;
              to = removedState(s);
              break;
            case 'fluids':
              if (isFluidState(s) || isWaterPlant(s)) to = 'minecraft:air';
              else if (propOf(s, 'waterlogged') === 'true') to = setProp(s, 'waterlogged', 'false');
              else continue;
              break;
            case 'above_ground': {
              const g = groundOf!(x, z);
              if (!Number.isNaN(g) && y <= g) continue;
              if (isFluidState(s)) continue; // keep rivers and ponds
              to = removedState(s);
              break;
            }
            case 'natural_trees':
              if (!natural![vi]) continue;
              to = removedState(s);
              break;
            case 'tree_debris':
              if (!debris![vi]) continue;
              to = removedState(s);
              break;
          }
          if (natMask && !natural![vi]) continue;
          if (mask) {
            const ls = f ? f.stateToLocal(s) : s;
            const lp = f ? f.toLocal([x, y, z]) : [x, y, z];
            if (!mask(lp[0]!, lp[1]!, lp[2]!, ls)) continue;
          }
          if (to === s) continue;
          session.set(x, y, z, to);
          removed++;
        }
    const st = await commit(ctx, session, `clear ${a.mode}`, { space: a.space });
    const note = skippedBuilt ? `; ${skippedBuilt} of this job's blocks kept (onlyUnbuilt)` : '';
    return { text: `clear ${a.mode} in world ${fmtBox(wbox)}: removed ${removed}${note}; ${statsText(st)}`, blocks: st.changed };
  },
});

export const buildingTools: ToolDef[] = [buildTool, runScriptTool, saveGeneratorTool, listGeneratorsTool, terraformTool, placePrefabTool, clearTool];
