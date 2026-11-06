// Per-state physical facts of the real game ("registry physics", ARCHITECTURE §5): sturdy faces
// (SupportType FULL / CENTER / RIGID), collision / support face fullness, solid render, legacy
// isSolid, redstone conductor / signal source, replaceable, the bottom collision face as walls see
// it, … — computed from the real block classes, never guessed from ids.
//
// Sources: the mod sends `registry.physics` in hello (computed from the running game, incl. modded
// blocks); the simulation / CLI use engine/data/physics-26.3.json (generated from the real 26.3
// server classes by tools/vanilla-diff/gen-physics.mjs). An older mod without physics falls back
// to the bundled table for the blocks it knows, then to the id heuristics in registry.ts/support.ts.
//
// Wire format (compact; both sides build it with the same algorithm):
//   { format: 1,
//     classes: [[full, center, rigid, collision, support, flags], …],   // distinct facts
//     blocks: { "minecraft:stone": 0,                                   // every state: class 0
//               "minecraft:oak_stairs": { p: [["facing", ["north","south","west","east"]],
//                                             ["half", ["top","bottom"]], ["shape", [...]]],
//                                         c: [3, 7, …] } } }               // per relevant state
// Direction masks: bit i = Direction.values()[i] = down, up, north, south, west, east.
// `p` lists only the properties that change the facts (sorted by name; values in the order the
// sender enumerates them); `c` is indexed mixed-radix over `p`, the first property varying slowest.
// Properties not in `p` (waterlogged, power, distance, …) do not matter. A class id of -1 means
// "unknown" (the sender could not compute it without a world) → heuristics.

export const PHYSICS_FORMAT = 1;
export const DIR_ORDER = ['down', 'up', 'north', 'south', 'west', 'east'] as const;
export type PhysDir = (typeof DIR_ORDER)[number];

/** flag bits (class field 5) */
export const PF = {
  /** BlockState.isSolidRender: hides neighbour faces (mushroom ground, face culling) */
  SOLID_RENDER: 1 << 0,
  /** legacy BlockState.isSolid(): signs, banners, cakes stand on it; farmland/dirt path turn to dirt under it */
  LEGACY_SOLID: 1 << 1,
  /** isRedstoneConductor */
  CONDUCTOR: 1 << 2,
  /** canBeReplaced (FallingBlock.isFree) */
  REPLACEABLE: 1 << 3,
  /** isCollisionShapeFullBlock (occupies the whole cube) */
  COLLISION_FULL: 1 << 4,
  /** isSignalSource (redstone wire connects from the side) */
  SIGNAL_SOURCE: 1 << 5,
  /** collision shape has a non-empty top face (sea pickles) */
  COLLISION_TOP: 1 << 6,
  /** propagatesSkylightDown */
  SKYLIGHT: 1 << 7,
  /** bottom collision face covers WallBlock.TEST_SHAPE_POST (centre column 7–9) */
  WALL_POST: 1 << 8,
  /** bottom collision face covers WallBlock.TEST_SHAPES_WALL[dir]: bit 9 + (north,south,west,east) */
  WALL_ARM_N: 1 << 9,
  WALL_ARM_S: 1 << 10,
  WALL_ARM_W: 1 << 11,
  WALL_ARM_E: 1 << 12,
} as const;

export const WALL_ARM: Record<'north' | 'south' | 'west' | 'east', number> = {
  north: PF.WALL_ARM_N,
  south: PF.WALL_ARM_S,
  west: PF.WALL_ARM_W,
  east: PF.WALL_ARM_E,
};

export type PhysClass = [full: number, center: number, rigid: number, collision: number, support: number, flags: number];

export interface PhysicsBlock {
  p: [string, string[]][];
  c: number[];
}
export interface PhysicsTable {
  format: number;
  classes: PhysClass[];
  blocks: Record<string, number | PhysicsBlock>;
}

/** bit of a direction in a 6-bit mask */
export const dirBit = (d: PhysDir): number => 1 << DIR_ORDER.indexOf(d);

/** Lookup of a block's class from its properties. */
export class PhysicsIndex {
  readonly table: PhysicsTable;
  private blocks = new Map<string, { p: [string, Map<string, number>][]; c: number[] } | number>();

  constructor(table: PhysicsTable) {
    this.table = table;
    for (const [id, b] of Object.entries(table.blocks)) {
      if (typeof b === 'number') this.blocks.set(id, b);
      else this.blocks.set(id, { p: b.p.map(([n, vals]) => [n, new Map(vals.map((v, i) => [v, i]))]), c: b.c });
    }
  }

  has(id: string): boolean {
    return this.blocks.has(id);
  }

  /** class of a state given its id and (complete enough) properties; null if unknown */
  get(id: string, props: Record<string, string>): PhysClass | null {
    const b = this.blocks.get(id);
    if (b === undefined) return null;
    let ci: number;
    if (typeof b === 'number') ci = b;
    else {
      let idx = 0;
      for (const [name, vals] of b.p) {
        const v = props[name];
        const i = v === undefined ? undefined : vals.get(v);
        if (i === undefined) return null;
        idx = idx * vals.size + i;
      }
      ci = b.c[idx] ?? -1;
    }
    return ci >= 0 ? (this.table.classes[ci] ?? null) : null;
  }
}

/**
 * Build the compact table from per-state facts (used by tools/vanilla-diff/gen-physics.mjs; the mod
 * implements the same algorithm in RegistryDump.java). `blocks`: id → property order
 * ([name, values in enumeration order], sorted by name) + every state's props and class (or null).
 */
export function buildPhysicsTable(
  blocks: Iterable<{ id: string; props: [string, string[]][]; states: { props: Record<string, string>; cls: PhysClass | null }[] }>,
): PhysicsTable {
  const classes: PhysClass[] = [];
  const classIdx = new Map<string, number>();
  const idOf = (c: PhysClass | null): number => {
    if (!c) return -1;
    const k = c.join(',');
    let i = classIdx.get(k);
    if (i === undefined) {
      i = classes.length;
      classes.push(c);
      classIdx.set(k, i);
    }
    return i;
  };
  const out: Record<string, number | PhysicsBlock> = {};
  for (const b of blocks) {
    const ids = b.states.map((s) => idOf(s.cls));
    if (!ids.length) continue;
    if (ids.every((i) => i === ids[0])) {
      out[b.id] = ids[0]!;
      continue;
    }
    // a property is irrelevant if every group of states differing only in it shares one class
    const relevant = b.props.filter(([name]) => {
      const groups = new Map<string, number>();
      for (let k = 0; k < b.states.length; k++) {
        const key = b.props.filter(([n]) => n !== name).map(([n]) => b.states[k]!.props[n]).join(',');
        const g = groups.get(key);
        if (g === undefined) groups.set(key, ids[k]!);
        else if (g !== ids[k]) return true;
      }
      return false;
    });
    const size = relevant.reduce((a, [, v]) => a * v.length, 1);
    const c = new Array<number>(size).fill(-1);
    for (let k = 0; k < b.states.length; k++) {
      let idx = 0;
      for (const [n, vals] of relevant) idx = idx * vals.length + vals.indexOf(b.states[k]!.props[n]!);
      c[idx] = ids[k]!;
    }
    out[b.id] = { p: relevant, c };
  }
  return { format: PHYSICS_FORMAT, classes, blocks: out };
}
