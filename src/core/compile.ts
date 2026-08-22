/**
 * Blueprint compiler.
 *
 * blueprint (JSON, ~2 KB) -> voxels -> merged boxes -> `/fill` commands
 *
 * Everything expensive happens here, deterministically and offline. The model
 * never sees a voxel: it writes intent, we produce the command stream. That is
 * the whole reason a castle costs ~1.5k output tokens instead of ~60k.
 */

import type {
  Blueprint, CompiledBuild, FillBox, Material, Part, TerrainSample, Vec3,
} from './types.js';
import { VoxelBuffer, mergeToBoxes, VoxelLimitError } from './voxel.js';
import { resolvePalette, type DetailLevel, type Palette, type ResolvedPalette } from './palette.js';
import { rotateY } from './geometry.js';
import { isAir, mirrorBlockSpec, normalizeBlock, rotateBlockSpec } from './blocks.js';
import * as S from './shapes.js';

/** Vanilla's hard cap on a single `/fill`. Exceeding it fails the command. */
export const MAX_FILL_VOLUME = 32768;

export interface CompileOptions {
  /** World position of the blueprint's `[0,0,0]`. */
  origin?: Vec3;
  /** Rotation applied to the entire blueprint. */
  rotate?: 0 | 90 | 180 | 270;
  /** World-space terrain heights, for `ground: "terrain"` and foundations. */
  terrain?: TerrainSample;
  /** Extra palettes loaded from `styles/`. */
  palettes?: Record<string, Palette>;
  /** Resolves `prefab` parts. Injected to keep core acyclic. */
  prefabs?: (name: string, params?: Record<string, unknown>) => Blueprint | null;
  /** Hard voxel budget. */
  limit?: number;
  /** Override the blueprint seed. */
  seed?: number;
  /**
   * Texture granularity for material mixes. Defaults to `med`, and drops
   * automatically on very large builds where per-block noise would cost more
   * in commands than it adds visually.
   */
  detail?: DetailLevel;
  /** Voxel count above which `detail` degrades one step. */
  autoDetailThreshold?: number;
}

// ── Transform algebra (the dihedral group D4 plus a translation) ───────────

interface Xf {
  /** Rotation about Y, in degrees. */
  rot: 0 | 90 | 180 | 270;
  /** Mirror across the YZ plane (negate X), applied after the rotation. */
  flip: boolean;
  off: Vec3;
}

const IDENTITY: Xf = { rot: 0, flip: false, off: [0, 0, 0] };

function applyLinear(rot: 0 | 90 | 180 | 270, flip: boolean, p: Vec3): Vec3 {
  const r = rotateY(p, rot);
  return flip ? [-r[0], r[1], r[2]] : r;
}

function applyXf(t: Xf, p: Vec3): Vec3 {
  const l = applyLinear(t.rot, t.flip, p);
  return [l[0] + t.off[0], l[1] + t.off[1], l[2] + t.off[2]];
}

const norm = (d: number): 0 | 90 | 180 | 270 => (((d % 360) + 360) % 360) as 0 | 90 | 180 | 270;

/**
 * Compose so that `applyXf(out, p) === applyXf(a, applyXf(b, p))`.
 *
 * These transforms form the dihedral group D4 crossed with a translation.
 * Mirroring conjugates rotation to its inverse — `rot(mirX(u), r)` equals
 * `mirX(rot(u, −r))` — which is why a mirrored child flips the sign of the
 * parent's angle instead of adding it.
 */
function compose(a: Xf, b: Xf): Xf {
  const rot = b.flip ? norm(b.rot - a.rot) : norm(a.rot + b.rot);
  const flip = a.flip !== b.flip;
  const movedOff = applyLinear(a.rot, a.flip, b.off);
  return {
    rot,
    flip,
    off: [a.off[0] + movedOff[0], a.off[1] + movedOff[1], a.off[2] + movedOff[2]],
  };
}

/** Apply the transform's rotation/mirror to a block's directional states. */
function transformSpec(t: Xf, spec: string): string {
  let out = rotateBlockSpec(spec, t.rot);
  if (t.flip) out = mirrorBlockSpec(out, 'x');
  return out;
}

// ── Compiler ──────────────────────────────────────────────────────────────

class Compiler {
  readonly buf: VoxelBuffer;
  readonly warnings: string[] = [];
  private readonly pal: ResolvedPalette;
  private readonly seed: number;
  private readonly origin: Vec3;
  private unknownBlocks = new Set<string>();
  private fixedBlocks = 0;
  private depth = 0;

  constructor(
    private readonly bp: Blueprint,
    private readonly opts: CompileOptions,
  ) {
    this.seed = (opts.seed ?? bp.seed ?? 0) | 0;
    this.origin = opts.origin ?? [0, 0, 0];
    this.buf = new VoxelBuffer(opts.limit ?? 3_000_000);
    this.pal = resolvePalette(bp.palette, bp.materials, this.seed, opts.palettes, opts.detail ?? 'med');
  }

  get palette(): ResolvedPalette { return this.pal; }

  warn(msg: string): void {
    if (this.warnings.length < 40 && !this.warnings.includes(msg)) this.warnings.push(msg);
  }

  private ctxFor(t: Xf): S.ShapeCtx {
    const paint: S.Painter = (x, y, z, ref, keep) => {
      const [wx, wy, wz] = applyXf(t, [x, y, z]);
      const raw = this.pal.at(ref, wx, wy, wz);
      const spec = this.finish(transformSpec(t, raw));
      this.buf.set(wx, wy, wz, spec, keep === true);
    };
    return {
      paint,
      seed: this.seed,
      warn: (m) => this.warn(m),
      concrete: (ref, x, y, z) => {
        const [wx, wy, wz] = applyXf(t, [x, y, z]);
        return this.pal.at(ref, wx, wy, wz);
      },
      // Terrain lives in world space while parts address blueprint-local
      // coordinates, so the lookup runs the column through the same transform.
      // Rotation about Y preserves height, hence the result is a valid local Y.
      heightAt: (x, z) => {
        const terrain = this.opts.terrain;
        if (!terrain) return null;
        const [bx, , bz] = applyXf(t, [x, 0, z]);
        const h = S.sampleHeight(terrain, bx + this.origin[0], bz + this.origin[2]);
        return h === null ? null : h - this.origin[1];
      },
    };
  }

  /** Normalise a block spec once, recording anything suspicious. */
  private finish(spec: string): string {
    const n = normalizeBlock(spec);
    if (n.fixed) this.fixedBlocks++;
    if (!n.known) this.unknownBlocks.add(spec);
    return n.spec;
  }

  run(rootRotation: 0 | 90 | 180 | 270 = 0): void {
    this.emit(this.bp.parts ?? [], { ...IDENTITY, rot: rootRotation });
    if (this.unknownBlocks.size) {
      const list = [...this.unknownBlocks].slice(0, 6).join(', ');
      this.warn(`Unrecognised block ids (kept as written, the server may reject them): ${list}`);
    }
    if (this.fixedBlocks) this.warn(`Auto-corrected ${this.fixedBlocks} block id(s) to their vanilla spelling.`);
  }

  private emit(parts: Part[], t: Xf): void {
    if (!Array.isArray(parts)) return;
    if (this.depth > 24) { this.warn('Blueprint nesting is too deep; stopped at 24 levels.'); return; }
    for (const part of parts) this.emitOne(part, t);
  }

  private emitOne(part: Part, t: Xf): void {
    if (!part || typeof part !== 'object' || typeof (part as { op?: unknown }).op !== 'string') {
      this.warn('Skipped a part without an "op" field.');
      return;
    }
    const ctx = this.ctxFor(t);

    switch (part.op) {
      case 'box': S.box(ctx, part); return;
      case 'clear': S.clear(ctx, part); return;
      case 'shell': S.shell(ctx, part); return;
      case 'walls': S.walls(ctx, part); return;
      case 'frame': S.frame(ctx, part); return;
      case 'cylinder': S.cylinder(ctx, part); return;
      case 'sphere': S.sphere(ctx, part); return;
      case 'cone': S.cone(ctx, part); return;
      case 'pyramid': S.pyramid(ctx, part); return;
      case 'roof': S.roof(ctx, part); return;
      case 'arch': S.arch(ctx, part); return;
      case 'battlements': S.battlements(ctx, part); return;
      case 'spiral': S.spiral(ctx, part); return;
      case 'line': S.line(ctx, part); return;
      case 'set': S.setOne(ctx, part); return;
      case 'windows': S.windows(ctx, part); return;
      case 'door': S.door(ctx, part); return;
      case 'scatter': S.scatter(ctx, part); return;
      case 'foundation': S.foundation(ctx, part); return;

      case 'group': {
        const child: Xf = {
          rot: (part.rotate ?? 0) as 0 | 90 | 180 | 270,
          flip: false,
          off: part.at ?? [0, 0, 0],
        };
        let next = compose(t, child);
        if (part.mirror) next = compose(next, mirrorXf(part.mirror, 0));
        this.depth++; this.emit(part.of ?? [], next); this.depth--;
        return;
      }

      case 'repeat': {
        const count = Math.max(0, Math.min(Math.round(part.count ?? 0), 512));
        if (count > 0 && !part.step && !part.rotateStep) {
          this.warn('A "repeat" without "step" or "rotateStep" stacks copies in place.');
        }
        const step = part.step ?? [0, 0, 0];
        this.depth++;
        for (let i = 0; i < count; i++) {
          const child: Xf = {
            rot: norm((part.rotateStep ?? 0) * i),
            flip: false,
            off: [step[0] * i, step[1] * i, step[2] * i],
          };
          this.emit(part.of ?? [], compose(t, child));
        }
        this.depth--;
        return;
      }

      case 'symmetry': {
        this.depth++;
        this.emit(part.of ?? [], t);
        const about = part.about ?? 0;
        const axes = part.axis === 'xz' ? (['x', 'z'] as const) : ([part.axis] as const);
        for (const ax of axes) {
          if (ax !== 'x' && ax !== 'z') continue;
          this.emit(part.of ?? [], compose(t, mirrorXf(ax, about)));
        }
        if (part.axis === 'xz') {
          // The fourth quadrant: mirrored on both axes at once.
          this.emit(part.of ?? [], compose(t, compose(mirrorXf('x', about), mirrorXf('z', about))));
        }
        this.depth--;
        return;
      }

      case 'prefab': {
        const resolve = this.opts.prefabs;
        if (!resolve) { this.warn(`prefab "${part.name}" requested but no prefab library is loaded.`); return; }
        const sub = resolve(part.name, part.params);
        if (!sub) { this.warn(`Unknown prefab "${part.name}".`); return; }
        const child: Xf = { rot: (part.rotate ?? 0) as 0 | 90 | 180 | 270, flip: false, off: part.at ?? [0, 0, 0] };
        this.depth++;
        this.emit(sub.parts ?? [], compose(t, child));
        this.depth--;
        return;
      }

      default:
        this.warn(`Unknown op "${(part as { op: string }).op}".`);
    }
  }
}

function runCompiler(bp: Blueprint, opts: CompileOptions): Compiler {
  const c = new Compiler(bp, opts);
  try {
    c.run(opts.rotate ?? 0);
  } catch (err) {
    if (err instanceof VoxelLimitError) c.warn(err.message);
    else throw err;
  }
  return c;
}

function mirrorXf(axis: 'x' | 'z', about: number): Xf {
  // Mirror about the plane x = about  ->  x' = 2·about − x
  // Mirror about the plane z = about  ->  z' = 2·about − z, expressible as
  // a 180° rotation followed by the X mirror.
  return axis === 'x'
    ? { rot: 0, flip: true, off: [2 * about, 0, 0] }
    : { rot: 180, flip: true, off: [0, 0, 2 * about] };
}

// ── Command emission ──────────────────────────────────────────────────────

/** Blocks that need the block under or beside them to already exist. */
const SUPPORTED = [
  'torch', 'lantern', 'candle', 'flower', 'sapling', 'door', 'bed', 'rail',
  'sign', 'button', 'pressure_plate', 'ladder', 'vine', 'carpet', 'snow',
  'painting', 'redstone', 'repeater', 'comparator', 'lever', 'tripwire',
  'mushroom', 'roots', 'fungus', 'grass', 'fern', 'dripleaf', 'lichen',
  'sea_pickle', 'amethyst_cluster', 'pointed_dripstone', 'chain', 'end_rod',
  'petals', 'moss_carpet', 'cactus', 'sugar_cane', 'bamboo', 'kelp', 'lily_pad',
  'tulip', 'poppy', 'dandelion', 'allium', 'orchid', 'bluet', 'daisy',
  'cornflower', 'lily_of_the_valley', 'wither_rose', 'sunflower', 'lilac',
  'rose_bush', 'peony', 'dead_bush', 'azalea', 'spore_blossom', 'hanging_roots',
  'cobweb', 'item_frame', 'armor_stand', 'flower_pot', 'decorated_pot', 'banner',
];

function isSupported(block: string): boolean {
  const id = block.split('[')[0];
  return SUPPORTED.some((s) => id.includes(s));
}

/** Split boxes that exceed vanilla's `/fill` volume limit. */
export function splitOversized(boxes: FillBox[], max = MAX_FILL_VOLUME): FillBox[] {
  const out: FillBox[] = [];
  for (const b of boxes) {
    if (b.volume <= max) { out.push(b); continue; }
    const w = b.x2 - b.x1 + 1, h = b.y2 - b.y1 + 1, d = b.z2 - b.z1 + 1;
    // Slice along Y first: layers keep the build reading bottom-up.
    const layerVolume = w * d;
    const maxLayers = Math.max(1, Math.floor(max / layerVolume));
    if (layerVolume <= max) {
      for (let y = b.y1; y <= b.y2; y += maxLayers) {
        const y2 = Math.min(b.y2, y + maxLayers - 1);
        out.push({ ...b, y1: y, y2, volume: w * d * (y2 - y + 1) });
      }
      continue;
    }
    // A single layer is already too big: tile it in X and Z as well.
    const side = Math.max(1, Math.floor(Math.sqrt(max)));
    for (let y = b.y1; y <= b.y2; y++)
      for (let z = b.z1; z <= b.z2; z += side)
        for (let x = b.x1; x <= b.x2; x += side) {
          const x2 = Math.min(b.x2, x + side - 1);
          const z2 = Math.min(b.z2, z + side - 1);
          out.push({ ...b, x1: x, x2, y1: y, y2: y, z1: z, z2, volume: (x2 - x + 1) * (z2 - z + 1) });
        }
    void h;
  }
  return out;
}

/**
 * Order boxes so the build is valid as it lands: clear the volume first, then
 * raise solids bottom-up, then attach the things that need something to hang
 * on. Getting this wrong is why AI builds end up with torches on the floor.
 */
export function orderBoxes(boxes: FillBox[]): FillBox[] {
  const air: FillBox[] = [];
  const solid: FillBox[] = [];
  const attach: FillBox[] = [];
  for (const b of boxes) {
    if (isAir(b.block)) air.push(b);
    else if (isSupported(b.block)) attach.push(b);
    else solid.push(b);
  }
  const byY = (a: FillBox, b: FillBox) => a.y1 - b.y1 || a.z1 - b.z1 || a.x1 - b.x1;
  solid.sort(byY);
  attach.sort(byY);
  air.sort(byY);
  return [...air, ...solid, ...attach];
}

export function boxToCommand(b: FillBox): string {
  if (b.x1 === b.x2 && b.y1 === b.y2 && b.z1 === b.z2) {
    return `setblock ${b.x1} ${b.y1} ${b.z1} ${b.block}`;
  }
  return `fill ${b.x1} ${b.y1} ${b.z1} ${b.x2} ${b.y2} ${b.z2} ${b.block}`;
}

const DETAIL_ORDER: DetailLevel[] = ['high', 'med', 'low', 'off'];

/**
 * Pick a texture granularity for a build of this size.
 *
 * Per-block noise on a 200k-block build would cost tens of thousands of extra
 * commands to render detail nobody can see from the ground. Large builds get
 * coarser blobs; small ones keep the fine grain.
 */
export function autoDetail(voxels: number, threshold = 8_000): DetailLevel {
  if (voxels > threshold * 10) return 'off';
  if (voxels > threshold) return 'low';
  return 'med';
}

/** Compile a blueprint into a ready-to-execute command stream. */
export function compile(bp: Blueprint, opts: CompileOptions = {}): CompiledBuild {
  const t0 = Date.now();
  const origin = opts.origin ?? [0, 0, 0];

  let c = runCompiler(bp, opts);

  // Size is only known after the first pass, so re-run once when the build
  // turned out large enough that finer noise is not worth the commands.
  if (opts.detail === undefined) {
    const want = autoDetail(c.buf.size, opts.autoDetailThreshold);
    if (want !== 'med' && DETAIL_ORDER.indexOf(want) > DETAIL_ORDER.indexOf('med')) {
      c = runCompiler(bp, { ...opts, detail: want });
    }
  }

  const world = c.buf.translated(origin[0], origin[1], origin[2]);

  const merged = mergeToBoxes(world);
  const boxes = orderBoxes(splitOversized(merged));
  const commands = boxes.map(boxToCommand);

  let fills = 0, setblocks = 0;
  for (const b of boxes) (b.volume === 1 ? setblocks++ : fills++);

  const voxels = [...world.voxels()];
  const t1 = Date.now();

  return {
    name: bp.name ?? 'build',
    commands,
    boxes,
    voxels,
    stats: {
      voxels: world.size,
      fills,
      setblocks,
      ratio: commands.length ? +(world.size / commands.length).toFixed(1) : 0,
      bounds: world.isEmpty
        ? { min: [0, 0, 0], max: [0, 0, 0] }
        : { min: [world.minX, world.minY, world.minZ], max: [world.maxX, world.maxY, world.maxZ] },
      blockCounts: world.blockCounts(),
      warnings: c.warnings,
      compileMs: t1 - t0,
    },
  };
}

export type { Material };
