// Build DSL: declarative shape ops (zod v4 schemas = MCP tool input) + synchronous executor.
// See docs/ENGINE-API.md (dsl.ts). Coordinates are in the frame's local space (ctx.frame),
// block states are authored in local orientation and rotated with frame.stateToWorld.
import { z } from 'zod';
import type { Box, Vec3 } from './types.ts';
import type { Registry } from './registry.ts';
import type { Frame } from './frame.ts';
import { compilePattern, type PatternFn, type PatternSpec } from './pattern.ts';
import { compileMask, type MaskFn, type MaskSpec } from './mask.ts';
import * as S from './shapes.ts';
import { blockId } from './blockstate.ts';

export interface BlockSink {
  get(x: number, y: number, z: number): string;
  set(x: number, y: number, z: number, state: string): void;
}

// ---------------------------------------------------------------------------------------
// schemas

const Vec3In = z.tuple([z.number(), z.number(), z.number()]).describe('[x,y,z]');
const Vec3f = z.tuple([z.number(), z.number(), z.number()]).describe('[x,y,z]; .5 allowed for even widths');
const BoxIn = z
  .union([z.object({ min: Vec3In, max: Vec3In }), z.tuple([Vec3In, Vec3In])])
  .describe('{min:[x,y,z],max:[x,y,z]} or [[x,y,z],[x,y,z]]; inclusive, any corner order');
const Axis = z.enum(['x', 'y', 'z']);

const BlockStr = z.string().describe('block state, e.g. "stone_bricks" or "oak_stairs[facing=east,half=top]"');
export const PatternSchema: z.ZodType<PatternSpec> = z
  .union([
    z.string(),
    z.array(z.object({ block: z.string(), weight: z.number().min(0).optional() })).min(1),
    z.object({
      type: z.literal('gradient'),
      axis: Axis,
      stops: z.array(z.string()).min(1),
      dither: z.boolean().optional(),
      from: z.number().optional(),
      to: z.number().optional(),
    }),
    z.object({ type: z.literal('noise'), scale: z.number().positive().optional(), blocks: z.array(z.string()).min(1), seed: z.number().optional() }),
    z.object({
      type: z.enum(['checker', 'stripes']),
      blocks: z.array(z.string()).min(1),
      size: z.number().int().min(1).optional(),
      axis: Axis.optional(),
    }),
  ])
  .describe(
    'Block or pattern: "stone_bricks" | "60%stone_bricks,30%cracked_stone_bricks,10%mossy_stone_bricks" (weights % or plain numbers, "keep" = leave unchanged) | ' +
      '[{block,weight}] | {type:"gradient",axis,stops:[..],dither?} (stops spread over the shape along axis) | {type:"noise",blocks:[..],scale?} | ' +
      '{type:"checker"|"stripes",blocks:[..],size?,axis?}',
  );

export const MaskSchema: z.ZodType<MaskSpec> = z
  .lazy(() =>
    z.union([
      z.string(),
      z.array(z.string()),
      z.object({ not: MaskSchema }),
      z.object({ all: z.array(MaskSchema) }),
      z.object({ any: z.array(MaskSchema) }),
    ]),
  )
  .describe(
    'Only modify positions whose CURRENT block matches: "air" | "!air" | "solid" | "liquid" | "replaceable" | "transparent" | "stone" | "oak_stairs[half=top]" | "#minecraft:logs" | "a,b" (any) | {not}|{all:[..]}|{any:[..]}',
  );

const common = {
  mask: MaskSchema.optional(),
  seed: z.number().int().optional().describe('random seed for this op'),
};
const blockReq = { block: PatternSchema, ...common };
const blockOpt = { block: PatternSchema.optional(), ...common };
const Hollow = z.boolean().optional().describe('shell only (watertight)');
const Thick = z.number().min(1).optional().describe('shell thickness (default 1)');

const SetOp = z
  .object({
    op: z.literal('set'),
    pos: Vec3In.optional(),
    positions: z.array(Vec3In).optional(),
    entries: z.array(z.tuple([z.number(), z.number(), z.number(), z.string()])).optional().describe('[[x,y,z,"block"],..] individual blocks'),
    ...blockOpt,
  })
  .describe('single blocks: pos or positions (with block), or entries');
const FillOp = z
  .object({
    op: z.literal('fill'),
    box: BoxIn.optional(),
    from: Vec3In.optional(),
    to: Vec3In.optional(),
    mode: z.enum(['solid', 'hollow', 'walls', 'outline', 'floor', 'ceiling']).optional().describe('default solid'),
    thickness: Thick,
    ...blockReq,
  })
  .describe('cuboid (box, or from+to corners)');
const EllipsoidFields = {
  center: Vec3f.optional(),
  radius: z.union([z.number().min(0), z.tuple([z.number(), z.number(), z.number()])]).optional().describe('r or [rx,ry,rz]; width = 2r+1'),
  box: BoxIn.optional().describe('alternative: ellipsoid inscribed in this box'),
  hollow: Hollow,
  thickness: Thick,
  half: z.enum(['top', 'bottom']).optional().describe('dome (top) or bowl (bottom)'),
  ...blockReq,
};
const EllipsoidOp = z.object({ op: z.literal('ellipsoid'), ...EllipsoidFields }).describe('ellipsoid (center+radius or box)');
const SphereOp = z.object({ op: z.literal('sphere'), ...EllipsoidFields }).describe('alias of ellipsoid');
const CylinderOp = z
  .object({
    op: z.literal('cylinder'),
    base: Vec3f.optional().describe('center of the bottom disc'),
    radius: z.union([z.number().min(0), z.tuple([z.number(), z.number()])]).optional(),
    height: z.number().optional().describe('layers along axis (negative = downward)'),
    box: BoxIn.optional().describe('alternative: cylinder filling this box along axis'),
    axis: Axis.optional().describe('default y'),
    hollow: Hollow,
    thickness: Thick,
    caps: z.boolean().optional().describe('hollow: close both ends (default open tube)'),
    ...blockReq,
  })
  .describe('cylinder / tube');
const ConeOp = z
  .object({
    op: z.literal('cone'),
    base: Vec3f.describe('center of the base disc'),
    radius: z.number().min(0),
    height: z.number().describe('negative = pointing down'),
    hollow: Hollow,
    thickness: Thick,
    ...blockReq,
  })
  .describe('cone with apex up (1 block tip)');
const PyramidOp = z
  .object({
    op: z.literal('pyramid'),
    base: Vec3f.optional().describe('center of the bottom layer'),
    size: z.union([z.number().min(1), z.tuple([z.number(), z.number()])]).optional().describe('footprint width or [sx,sz]'),
    box: BoxIn.optional().describe('alternative: footprint box (base y = min.y; height = box height if > 1)'),
    height: z.number().optional(),
    hollow: Hollow,
    thickness: Thick,
    ...blockReq,
  })
  .describe('stepped pyramid');
const TorusOp = z
  .object({ op: z.literal('torus'), center: Vec3f, major: z.number().min(0), minor: z.number().min(0), axis: Axis.optional().describe('ring axis, default y (flat ring)'), ...blockReq })
  .describe('ring');
const LineOp = z
  .object({ op: z.literal('line'), from: Vec3In, to: Vec3In, thickness: z.number().min(1).optional().describe('brush diameter'), ...blockReq })
  .describe('straight line');
const CurveOp = z
  .object({
    op: z.literal('curve'),
    points: z.array(Vec3f).min(2),
    kind: z.enum(['bezier', 'catmull']).optional().describe('catmull (default) passes through points; bezier uses them as control points'),
    radius: z.number().min(0).optional().describe('brush radius (0 = 1 block)'),
    ...blockReq,
  })
  .describe('smooth curve / tube');
const PolygonOp = z
  .object({
    op: z.literal('polygon'),
    points: z.array(z.tuple([z.number(), z.number()])).min(2).describe('[[x,z],..] corners (closed automatically)'),
    y: z.number(),
    height: z.number().optional().describe('default 1'),
    hollow: z.boolean().optional().describe('outline walls only'),
    ...blockReq,
  })
  .describe('vertical prism over a polygon');
const ArchOp = z
  .object({
    op: z.literal('arch'),
    from: Vec3In.describe('foot 1'),
    to: Vec3In.describe('foot 2 (same y; differ only in x or only in z)'),
    height: z.number().min(0).describe('crown height above from.y'),
    thickness: z.number().min(1).optional().describe('ring thickness (default 1)'),
    depth: z.number().optional().describe('extrusion perpendicular to the span (default 1; negative = other side)'),
    style: z.enum(['round', 'pointed', 'flat']).optional(),
    ...blockReq,
  })
  .describe('arch ring between two feet (the opening below stays free)');
const SpiralOp = z
  .object({
    op: z.literal('spiral'),
    center: Vec3f.describe('axis position, y = first step'),
    radius: z.number().positive(),
    height: z.number().min(1).describe('number of steps (one per layer)'),
    turns: z.number().describe('revolutions; positive = clockwise from above'),
    width: z.number().positive().optional().describe('radial width (default radius)'),
    stairs: z.string().optional().describe('stairs block → steps become stairs facing up the spiral'),
    column: z.string().optional().describe('block for the central column'),
    ...blockOpt,
  })
  .describe('spiral staircase / helix');
const RoofOp = z
  .object({
    op: z.literal('roof'),
    box: BoxIn.describe('footprint (outer walls); min.y = first roof layer, on top of the walls'),
    style: z.enum(['gable', 'hip', 'pyramid', 'shed', 'dome', 'spire', 'mansard', 'gambrel', 'flat']),
    stairs: z.string().describe('stairs block, e.g. "dark_oak_stairs"'),
    slab: z.string().optional().describe('default: matching slab'),
    axis: z.enum(['x', 'z']).optional().describe('ridge direction (default longer side)'),
    fill: z.string().optional().describe('solid fill under the roof'),
    ends: z.string().optional().describe('gable/gambrel/shed: block for the gable end walls'),
    overhang: z.number().min(0).optional().describe('eaves (default 1, dome 0)'),
    pitch: z.number().min(0).optional().describe('rise per block (default 1; shed 0.5; spire 3)'),
    facing: z.enum(['north', 'south', 'east', 'west']).optional().describe('shed: side that is high'),
    mask: MaskSchema.optional(),
    seed: z.number().int().optional(),
  })
  .describe('roof made of correctly oriented stairs/slabs');
const ReplaceOp = z
  .object({
    op: z.literal('replace'),
    box: BoxIn.optional(),
    from: z.union([MaskSchema, Vec3In]).optional().describe('what to replace (mask; default "!air")'),
    to: z.union([PatternSchema, Vec3In]).optional().describe('new block/pattern'),
    ...blockOpt,
  })
  .describe('replace matching blocks in a box');
const ClearOp = z
  .object({ op: z.literal('clear'), box: BoxIn.optional(), from: Vec3In.optional(), to: Vec3In.optional(), ...common })
  .describe('set a box to air');

export const BuildOpSchema = z.discriminatedUnion('op', [
  SetOp,
  FillOp,
  EllipsoidOp,
  SphereOp,
  CylinderOp,
  ConeOp,
  PyramidOp,
  TorusOp,
  LineOp,
  CurveOp,
  PolygonOp,
  ArchOp,
  SpiralOp,
  RoofOp,
  ReplaceOp,
  ClearOp,
]);
export type BuildOp = z.output<typeof BuildOpSchema>;

export interface OpContext {
  sink: BlockSink;
  reg: Registry;
  frame: Frame;
  seed?: number;
}
export interface OpResult {
  op: string;
  changed: number;
  warnings: string[];
}

export class OpError extends Error {
  index: number;
  constructor(index: number, message: string) {
    super(message);
    this.name = 'OpError';
    this.index = index;
  }
}

// ---------------------------------------------------------------------------------------
// executor

class Fail extends Error {}

function boxOf(b: unknown): Box {
  if (Array.isArray(b)) return normBox(b[0] as Vec3, b[1] as Vec3);
  const o = b as { min: Vec3; max: Vec3 };
  return normBox(o.min, o.max);
}
function normBox(a: Vec3, b: Vec3): Box {
  const r = (v: number) => Math.round(v);
  return {
    min: [Math.min(r(a[0]), r(b[0])), Math.min(r(a[1]), r(b[1])), Math.min(r(a[2]), r(b[2]))],
    max: [Math.max(r(a[0]), r(b[0])), Math.max(r(a[1]), r(b[1])), Math.max(r(a[2]), r(b[2]))],
  };
}
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number');
function needBox(op: { box?: unknown; from?: unknown; to?: unknown }): Box {
  if (op.box) return boxOf(op.box);
  if (isVec3(op.from) && isVec3(op.to)) return normBox(op.from, op.to);
  throw new Fail('needs "box": {min:[x,y,z],max:[x,y,z]} (or "from" and "to" corners)');
}
const r3 = (v: Vec3): Vec3 => [Math.round(v[0]), Math.round(v[1]), Math.round(v[2])];

/** growable list of local positions (+ optional per-position local state) */
class PosBuf {
  xyz = new Int32Array(3 * 1024);
  n = 0;
  states: (string | null)[] | null = null;
  min: Vec3 = [Infinity, Infinity, Infinity];
  max: Vec3 = [-Infinity, -Infinity, -Infinity];
  push = (x: number, y: number, z: number, state?: string): void => {
    if (this.n * 3 + 3 > this.xyz.length) {
      const a = new Int32Array(this.xyz.length * 2);
      a.set(this.xyz);
      this.xyz = a;
    }
    const i = this.n * 3;
    this.xyz[i] = x;
    this.xyz[i + 1] = y;
    this.xyz[i + 2] = z;
    if (state !== undefined) {
      if (!this.states) this.states = new Array(this.n).fill(null);
      this.states.push(state);
    } else if (this.states) this.states.push(null);
    this.n++;
    if (x < this.min[0]) this.min[0] = x;
    if (y < this.min[1]) this.min[1] = y;
    if (z < this.min[2]) this.min[2] = z;
    if (x > this.max[0]) this.max[0] = x;
    if (y > this.max[1]) this.max[1] = y;
    if (z > this.max[2]) this.max[2] = z;
  };
  bounds(): Box | undefined {
    return this.n ? { min: [...this.min] as Vec3, max: [...this.max] as Vec3 } : undefined;
  }
}

function canonOrFail(reg: Registry, s: string, what: string): string {
  const r = reg.tryCanonical(s);
  if (!r.ok) throw new Fail(`${what}: ${r.error}`);
  return r.state;
}

/** Execute ops in order. Synchronous; throws OpError(index, message) (nothing of the failing op is written). */
export function executeOps(ops: BuildOp[], ctx: OpContext): OpResult[] {
  const results: OpResult[] = [];
  for (let i = 0; i < ops.length; i++) {
    const parsed = BuildOpSchema.safeParse(ops[i]);
    if (!parsed.success) {
      const msg = parsed.error.issues
        .slice(0, 5)
        .map((x) => `${x.path.join('.') || 'op'}: ${x.message}`)
        .join('; ');
      throw new OpError(i, `invalid op: ${msg}`);
    }
    try {
      results.push(execOne(parsed.data, ctx, i));
    } catch (e) {
      if (e instanceof OpError) throw e;
      throw new OpError(i, (e as Error).message);
    }
  }
  return results;
}

function execOne(op: BuildOp, ctx: OpContext, index: number): OpResult {
  const { reg, frame, sink } = ctx;
  const warnings: string[] = [];
  const seed = op.seed ?? (((ctx.seed ?? 0) + Math.imul(index + 1, 0x9e3779b1)) | 0);
  const buf = new PosBuf();
  const emit: S.PosSink = buf.push;
  let blockSpec: PatternSpec | undefined = (op as { block?: PatternSpec }).block;
  let maskSpec: MaskSpec | undefined = op.mask;
  let needBlock = true;

  switch (op.op) {
    case 'set': {
      if (op.entries?.length) {
        const cache = new Map<string, string>();
        for (const [x, y, z, b] of op.entries) {
          let st = cache.get(b);
          if (!st) {
            st = canonOrFail(reg, b, `entries block "${b}"`);
            cache.set(b, st);
          }
          buf.push(Math.round(x), Math.round(y), Math.round(z), st);
        }
      }
      const pts = [...(op.pos ? [op.pos] : []), ...(op.positions ?? [])];
      if (pts.length && blockSpec === undefined) throw new Fail('"pos"/"positions" need a "block"');
      for (const p of pts) buf.push(Math.round(p[0]), Math.round(p[1]), Math.round(p[2]));
      if (!pts.length && !op.entries?.length) throw new Fail('needs "pos", "positions" or "entries"');
      needBlock = pts.length > 0;
      break;
    }
    case 'fill':
      S.box({ box: needBox(op), mode: op.mode, thickness: op.thickness }, emit);
      break;
    case 'clear':
      S.box({ box: needBox(op) }, emit);
      blockSpec = 'air';
      break;
    case 'replace': {
      let box: Box;
      if (op.box) box = boxOf(op.box);
      else if (isVec3(op.from) && isVec3(op.to as unknown)) {
        box = normBox(op.from, op.to as unknown as Vec3);
        op = { ...op, from: undefined, to: undefined };
      } else throw new Fail('needs "box"');
      S.box({ box }, emit);
      const what = (op as { from?: MaskSpec }).from;
      const extra = what ?? (maskSpec === undefined ? '!air' : undefined);
      if (extra !== undefined) maskSpec = maskSpec === undefined ? extra : { all: [extra, maskSpec] };
      const to = (op as { to?: PatternSpec }).to;
      blockSpec = to ?? blockSpec;
      if (blockSpec === undefined) throw new Fail('needs "to" (the new block/pattern)');
      break;
    }
    case 'ellipsoid':
    case 'sphere': {
      let center: Vec3, radius: number | Vec3;
      if (op.box) {
        const b = boxOf(op.box);
        center = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
        radius = [(b.max[0] - b.min[0]) / 2, (b.max[1] - b.min[1]) / 2, (b.max[2] - b.min[2]) / 2];
        if (op.half === 'top') center[1] = b.min[1];
        if (op.half === 'bottom') center[1] = b.max[1];
        if (op.half) radius[1] = b.max[1] - b.min[1];
      } else {
        if (!op.center || op.radius === undefined) throw new Fail('needs "center" + "radius" (or "box")');
        center = op.center;
        radius = op.radius;
      }
      S.ellipsoid({ center, radius, hollow: op.hollow, thickness: op.thickness, half: op.half ?? null }, emit);
      break;
    }
    case 'cylinder': {
      const axis = op.axis ?? 'y';
      if (op.box) {
        const b = boxOf(op.box);
        const ai = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
        const [ia, ib] = ai === 0 ? [1, 2] : ai === 1 ? [0, 2] : [0, 1];
        const base: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
        base[ai] = b.min[ai];
        S.cylinder(
          {
            base,
            radius: [(b.max[ia] - b.min[ia]) / 2, (b.max[ib] - b.min[ib]) / 2],
            height: b.max[ai] - b.min[ai] + 1,
            axis,
            hollow: op.hollow,
            thickness: op.thickness,
            caps: op.caps,
          },
          emit,
        );
      } else {
        if (!op.base || op.radius === undefined || op.height === undefined) throw new Fail('needs "base", "radius", "height" (or "box")');
        S.cylinder({ base: op.base, radius: op.radius, height: op.height, axis, hollow: op.hollow, thickness: op.thickness, caps: op.caps }, emit);
      }
      break;
    }
    case 'cone':
      S.cone({ base: op.base, radius: op.radius, height: op.height, hollow: op.hollow, thickness: op.thickness }, emit);
      break;
    case 'pyramid': {
      if (op.box) {
        const b = boxOf(op.box);
        const h = op.height ?? (b.max[1] > b.min[1] ? b.max[1] - b.min[1] + 1 : undefined);
        S.pyramid(
          {
            base: [(b.min[0] + b.max[0]) / 2, b.min[1], (b.min[2] + b.max[2]) / 2],
            size: [b.max[0] - b.min[0] + 1, b.max[2] - b.min[2] + 1],
            height: h,
            hollow: op.hollow,
            thickness: op.thickness,
          },
          emit,
        );
      } else {
        if (!op.base || op.size === undefined) throw new Fail('needs "base" + "size" (or "box")');
        S.pyramid({ base: op.base, size: op.size, height: op.height, hollow: op.hollow, thickness: op.thickness }, emit);
      }
      break;
    }
    case 'torus':
      S.torus({ center: op.center, major: op.major, minor: op.minor, axis: op.axis }, emit);
      break;
    case 'line':
      S.line({ from: r3(op.from), to: r3(op.to), thickness: op.thickness }, emit);
      break;
    case 'curve':
      S.curve({ points: op.points, kind: op.kind, radius: op.radius }, emit);
      break;
    case 'polygon':
      S.polygon({ points: op.points, y: op.y, height: op.height ?? 1, hollow: op.hollow }, emit);
      break;
    case 'arch':
      S.arch({ from: op.from, to: op.to, height: op.height, thickness: op.thickness, depth: op.depth, style: op.style }, emit);
      break;
    case 'spiral': {
      let stairsId: string | null = null;
      if (op.stairs) {
        stairsId = blockId(canonOrFail(reg, op.stairs, 'stairs'));
        if (!reg.info(stairsId)?.properties.facing || !reg.info(stairsId)?.properties.shape)
          throw new Fail(`stairs: "${op.stairs}" is not a stairs block`);
      }
      if (!stairsId && blockSpec === undefined) throw new Fail('needs "block" or "stairs"');
      const stairCache = new Map<string, string>();
      S.spiralCells({ center: op.center, radius: op.radius, height: op.height, turns: op.turns, width: op.width }, (x, y, z, f) => {
        if (stairsId) {
          let st = stairCache.get(f);
          if (!st) {
            st = reg.canonical(`${stairsId}[facing=${f},half=bottom]`);
            stairCache.set(f, st);
          }
          buf.push(x, y, z, st);
        } else buf.push(x, y, z);
      });
      if (op.column) {
        const col = canonOrFail(reg, op.column, 'column');
        const cx = op.center[0], cz = op.center[2];
        if (!Number.isInteger(cx) || !Number.isInteger(cz)) warnings.push('column needs an integer center; rounded');
        for (let k = 0; k < Math.round(op.height); k++) buf.push(Math.round(cx), Math.round(op.center[1]) + k, Math.round(cz), col);
      }
      needBlock = !stairsId;
      break;
    }
    case 'roof': {
      S.roof(
        {
          box: boxOf(op.box),
          style: op.style,
          axis: op.axis,
          stairs: op.stairs,
          slab: op.slab,
          fill: op.fill,
          ends: op.ends,
          overhang: op.overhang,
          pitch: op.pitch,
          facing: op.facing,
        },
        reg,
        (x, y, z, st) => buf.push(x, y, z, st),
      );
      needBlock = false;
      break;
    }
    default:
      throw new Fail(`unknown op "${(op as { op: string }).op}"`);
  }

  // compile pattern + mask (errors before any write)
  let pat: PatternFn | null = null;
  if (needBlock || blockSpec !== undefined) {
    if (blockSpec === undefined) throw new Fail('needs "block"');
    try {
      pat = compilePattern(blockSpec, reg, { seed, bounds: buf.bounds() });
    } catch (e) {
      throw new Fail(`block: ${(e as Error).message}`);
    }
  }
  let mask: MaskFn | null = null;
  if (maskSpec !== undefined) {
    try {
      mask = compileMask(maskSpec, reg);
    } catch (e) {
      throw new Fail(`mask: ${(e as Error).message}`);
    }
  }
  if (buf.n === 0) warnings.push('shape is empty (check sizes/radius/height)');

  // write
  const xyz = buf.xyz;
  const states = buf.states;
  const w: Vec3 = [0, 0, 0];
  let lastLocal: string | null = null;
  let lastWorld = '';
  let changed = 0;
  let masked = 0;
  for (let k = 0; k < buf.n; k++) {
    const lx = xyz[3 * k], ly = xyz[3 * k + 1], lz = xyz[3 * k + 2];
    let st: string | null = states ? states[k] : null;
    if (st === null) {
      if (!pat) continue;
      st = pat(lx, ly, lz);
      if (st === null) continue;
    }
    frame.toWorldInto(lx, ly, lz, w);
    const cur = sink.get(w[0], w[1], w[2]);
    if (mask && !mask(w[0], w[1], w[2], cur)) {
      masked++;
      continue;
    }
    let ws: string;
    if (st === lastLocal) ws = lastWorld;
    else {
      ws = frame.stateToWorld(st);
      lastLocal = st;
      lastWorld = ws;
    }
    if (ws === cur) continue;
    sink.set(w[0], w[1], w[2], ws);
    changed++;
  }
  if (buf.n > 0 && changed === 0)
    warnings.push(masked === buf.n ? 'mask excluded every position — nothing changed' : 'nothing changed (blocks were already there)');
  return { op: op.op, changed, warnings };
}

// ---------------------------------------------------------------------------------------

export const DSL_HELP = `BUILD OPS (coordinates local unless told otherwise: +x right, +y up, -z away from the player, +z toward the player; the entrance/front faces +z; block facings are local too: facing=north = away from the player).
Every op: {op, ...params, block?, mask?, seed?}. Ops run in order; later ops overwrite earlier ones.
BLOCK/PATTERN: "stone_bricks" | "oak_stairs[facing=east,half=top]" | "60%stone_bricks,30%cracked_stone_bricks,10%mossy_stone_bricks" (or "3*a,1*b"; "keep" = leave unchanged)
  | [{block:"andesite",weight:2},{block:"tuff"}] | {type:"gradient",axis:"y",stops:["mud_bricks","bricks"],dither:true} | {type:"noise",blocks:["moss_block","grass_block"],scale:6} | {type:"checker"|"stripes",blocks:[a,b],size:1,axis:"y"}
MASK (only touch where the CURRENT block matches): "air" "!air" "solid" "liquid" "replaceable" "transparent" "stone" "oak_stairs[half=top]" "#minecraft:logs" "a,b" {not:..} {all:[..]} {any:[..]}
BOX: {min:[x,y,z],max:[x,y,z]} or [[x,y,z],[x,y,z]], inclusive. Round shapes: width = 2*radius+1; for even widths use a .5 center (or the box form).
set      {op:"set",pos:[0,1,0],block:"lantern"}  |  positions:[[..],..]  |  entries:[[x,y,z,"block"],..]
fill     {op:"fill",box:{min:[0,0,0],max:[8,4,6]},block:"stone_bricks",mode:"walls"}   mode: solid|hollow|walls|outline|floor|ceiling, thickness
clear    {op:"clear",box:[[0,1,0],[8,6,6]]}   (air; optional mask)
replace  {op:"replace",box:[[0,0,0],[8,6,6]],from:"cobblestone",to:"70%keep,30%mossy_cobblestone"}
ellipsoid {op:"ellipsoid",center:[0,10,0],radius:[6,4,6],hollow:true,block:"glass"}  | box:{..} | half:"top" (dome) / "bottom" (bowl); sphere = alias
cylinder {op:"cylinder",base:[0,0,0],radius:3,height:12,hollow:true,block:"stone_bricks"}  axis x|y|z, caps:true closes a hollow tube, box form fits a box
cone     {op:"cone",base:[0,12,0],radius:4,height:9,block:"deepslate_tiles"}   height<0 points down
pyramid  {op:"pyramid",box:{min:[0,0,0],max:[10,0,10]},block:"sandstone"}  | base(center)+size, height, hollow
torus    {op:"torus",center:[0,5,0],major:6,minor:1,block:"oak_leaves"}
line     {op:"line",from:[0,0,0],to:[10,6,3],thickness:1,block:"oak_log"}
curve    {op:"curve",points:[[0,0,0],[5,8,2],[12,4,8]],radius:1,block:"stone"}  kind catmull (through points) | bezier
polygon  {op:"polygon",points:[[0,0],[8,0],[12,6],[4,10]],y:0,height:5,hollow:true,block:"bricks"}
arch     {op:"arch",from:[0,3,0],to:[6,3,0],height:3,depth:2,style:"round",block:"stone_bricks"}   ring only; opening stays free; style round|pointed|flat
spiral   {op:"spiral",center:[0,1,0],radius:2,height:16,turns:2,stairs:"stone_brick_stairs",column:"stone_bricks"}  (or block for a helix)
roof     {op:"roof",box:{min:[-1,6,-1],max:[9,6,7]},style:"gable",stairs:"dark_oak_stairs",ends:"spruce_planks"}
         styles gable|hip|pyramid|shed|dome|spire|mansard|gambrel|flat; box = wall footprint, min.y = first layer above the walls;
         overhang (default 1, eaves continue the slope down), pitch (1 = 45°, 0.5 low with slabs, 2 steep), axis = ridge direction, slab, fill (solid), ends (gable walls), facing (shed high side)`;
