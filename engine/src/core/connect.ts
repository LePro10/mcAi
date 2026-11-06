// Emulation of vanilla neighbour shape updates. Only properties change, never block ids.
// See docs/ENGINE-API.md (connect.ts). Ported rules (Minecraft 1.21.x / 26.x):
//
//  FenceBlock.connectsTo(n, sturdy, dir) = !isExceptionForConnection(n) && sturdy
//        || isSameFence(n) || (n is fence gate && gate axis ⟂ dir)
//     isSameFence: both #fences and both / neither #wooden_fences (nether brick fence is its own family)
//  IronBarsBlock.attachsTo(n, sturdy) = !isExceptionForConnection(n) && sturdy || n is bars/pane || n is #walls
//  WallBlock.connectsTo(n, sturdy, dir) = n is #walls || !isExceptionForConnection(n) && sturdy
//        || n is bars/pane || (n is fence gate && gate axis ⟂ dir)
//     side = connected ? (the bottom collision face of the block above covers that arm
//            (WallBlock.TEST_SHAPES_WALL: x 7–9, z 0–9 toward the side) ? tall : low) : none
//     up   = wall above has post || sides not a straight line || (not straight-tall && above is
//            #wall_post_override or its bottom collision face covers the centre column 7–9)
//  FenceGateBlock in_wall = a wall on either side of the gate (along its span)
//  StairBlock.getStairsShape (behind → outer, front → inner)
//  RedStoneWireBlock.getConnectionState: sides/up from neighbouring wire and signal sources; a
//     wire with connections on one axis extends to a line; an isolated wire stays a dot if it was
//     a dot (all sides none, the default state), otherwise it becomes a cross
//  SnowyBlock (grass_block, podzol, mycelium): snowy = the block above is #snow
//  TripWireBlock: sides connect to tripwire and to hooks facing away
//  MossyCarpetBlock (pale moss carpet): sides on attachable faces (low; tall under a side-carpet)
//  ChorusPlantBlock: connects to chorus plant/flower, down also to end stone
//  isExceptionForConnection: leaves, barrier, carved pumpkin, jack o'lantern, melon, pumpkin, shulker boxes
//
// Sturdy faces, wall coverage, redstone conductors and signal sources come from the registry
// physics (physics.ts — the real game's isFaceSturdy / collision shapes / isRedstoneConductor /
// isSignalSource). Blocks without physics use heuristics: full solid blocks, double slabs, the
// full back face(s) of stairs, the bottom face of bottom slabs/stairs, the top face of top slabs/stairs.
import type { Vec3 } from './types.ts';
import type { Registry } from './registry.ts';
import { blockId, formatBlockState, isAir, parseBlockState } from './blockstate.ts';
import { PF, WALL_ARM, type PhysClass } from './physics.ts';

export type Dir4 = 'north' | 'east' | 'south' | 'west';
const DIRS4: Dir4[] = ['north', 'east', 'south', 'west'];
const OFF: Record<Dir4, [number, number]> = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] };
const OPP: Record<Dir4, Dir4> = { north: 'south', south: 'north', east: 'west', west: 'east' };
const CW: Record<Dir4, Dir4> = { north: 'east', east: 'south', south: 'west', west: 'north' };
const CCW: Record<Dir4, Dir4> = { north: 'west', west: 'south', south: 'east', east: 'north' };
const AXIS: Record<Dir4, 'x' | 'z'> = { north: 'z', south: 'z', east: 'x', west: 'x' };

export type StairsShape = 'straight' | 'inner_left' | 'inner_right' | 'outer_left' | 'outer_right';
export interface StairInfo {
  facing: Dir4;
  half: string;
}

/**
 * Vanilla StairBlock.getStairsShape. `stairAt` returns facing/half of a stairs block at a
 * position or null if there is no stairs block.
 */
export function stairsShapeFor(
  x: number,
  y: number,
  z: number,
  facing: Dir4,
  half: string,
  stairAt: (x: number, y: number, z: number) => StairInfo | null,
): StairsShape {
  const [fx, fz] = OFF[facing];
  const behind = stairAt(x + fx, y, z + fz);
  if (behind && behind.half === half) {
    const bf = behind.facing;
    if (AXIS[bf] !== AXIS[facing] && canTakeShape(x, y, z, facing, half, OPP[bf], stairAt)) {
      return bf === CCW[facing] ? 'outer_left' : 'outer_right';
    }
  }
  const front = stairAt(x - fx, y, z - fz);
  if (front && front.half === half) {
    const ff = front.facing;
    if (AXIS[ff] !== AXIS[facing] && canTakeShape(x, y, z, facing, half, ff, stairAt)) {
      return ff === CCW[facing] ? 'inner_left' : 'inner_right';
    }
  }
  return 'straight';
}

function canTakeShape(
  x: number,
  y: number,
  z: number,
  facing: Dir4,
  half: string,
  dir: Dir4,
  stairAt: (x: number, y: number, z: number) => StairInfo | null,
): boolean {
  const [dx, dz] = OFF[dir];
  const n = stairAt(x + dx, y, z + dz);
  return !n || n.facing !== facing || n.half !== half;
}

// ---------------------------------------------------------------------------------------
// classification (cached per state string)

type Kind = 'fence' | 'pane' | 'wall' | 'stairs' | 'gate' | 'wire' | 'chorus' | 'snowy' | 'tripwire' | 'mosscarpet' | 'other';

interface Cls {
  kind: Kind;
  id: string;
  short: string;
  air: boolean;
  full: boolean; // registry.isFullSolid
  wooden: boolean; // fences: #wooden_fences
  exception: boolean; // isExceptionForConnection
  props: Record<string, string>;
  /** state without SNBT */
  head: string;
  /** registry physics (null = heuristics) */
  ph: PhysClass | null;
}

/** physics face bits (Direction.values(): down, up, north, south, west, east) */
const PBIT = { down: 1, up: 2, north: 4, south: 8, west: 16, east: 32 } as const;

const EXCEPTION_IDS = new Set([
  'minecraft:barrier',
  'minecraft:carved_pumpkin',
  'minecraft:jack_o_lantern',
  'minecraft:melon',
  'minecraft:pumpkin',
]);

/** blocks that redstone wire connects to from the side (any direction) */
const SIGNAL_SOURCES_RE =
  /(^|_)button$|pressure_plate$|^lever$|^redstone_torch$|^redstone_wall_torch$|^redstone_block$|^daylight_detector$|^comparator$|^trapped_chest$|^tripwire_hook$|^detector_rail$|^target$|sculk_sensor$|^lectern$|lightning_rod$/;
const POST_COVER_RE =
  /lantern$|_chain$|^end_rod$|lightning_rod$|^hopper$|^bell$|^lectern$|^grindstone$|anvil$|^brewing_stand$|^cauldron$|^composter$|campfire$|^scaffolding$|chest$|^cake$|^enchanting_table$|^stonecutter$/;

const MAX_CACHE = 200_000;

export class Connector {
  private reg: Registry;
  private cls = new Map<string, Cls>();
  private results = new Map<string, string>();

  constructor(reg: Registry) {
    this.reg = reg;
  }

  classify(state: string): Cls {
    let c = this.cls.get(state);
    if (c) return c;
    const brace = state.indexOf('{');
    const head = brace >= 0 ? state.slice(0, brace) : state;
    const id = blockId(head);
    const reg = this.reg;
    const short = id.slice(id.indexOf(':') + 1);
    let kind: Kind = 'other';
    if (reg.hasTag(id, 'minecraft:fences')) kind = 'fence';
    else if (reg.hasTag(id, 'minecraft:walls')) kind = 'wall';
    else if (reg.hasTag(id, 'minecraft:fence_gates')) kind = 'gate';
    else if (reg.hasTag(id, 'minecraft:stairs') || short.endsWith('_stairs')) kind = 'stairs';
    else if (short.endsWith('_pane') || reg.hasTag(id, 'minecraft:bars') || short === 'iron_bars') kind = 'pane';
    else if (short === 'redstone_wire') kind = 'wire';
    else if (short === 'chorus_plant') kind = 'chorus';
    else if (reg.info(id)?.properties.snowy) kind = 'snowy';
    else if (short === 'tripwire') kind = 'tripwire';
    else if (short === 'pale_moss_carpet') kind = 'mosscarpet';
    let props: Record<string, string> = {};
    if (head.includes('[')) {
      try {
        props = parseBlockState(head).props;
      } catch {
        /* ignore malformed */
      }
    }
    const air = isAir(head);
    c = {
      kind,
      id,
      short,
      air,
      full: !air && reg.isFullSolid(head),
      wooden: reg.hasTag(id, 'minecraft:wooden_fences'),
      exception:
        EXCEPTION_IDS.has(id) || reg.hasTag(id, 'minecraft:leaves') || reg.hasTag(id, 'minecraft:shulker_boxes') || short.endsWith('shulker_box'),
      props,
      head,
      ph: air ? null : reg.physics(head),
    };
    if (this.cls.size >= MAX_CACHE) this.cls.clear();
    this.cls.set(state, c);
    return c;
  }

  /** Is the face of `state` that points toward `face` (direction from the block outward) sturdy? */
  sturdyFace(state: string, face: Dir4 | 'up' | 'down'): boolean {
    return this.sturdy(this.classify(state), face);
  }

  private sturdy(c: Cls, face: Dir4 | 'up' | 'down'): boolean {
    if (c.air) return false;
    if (c.ph) return (c.ph[0] & PBIT[face]) !== 0;
    if (c.full) return true;
    if (c.short.endsWith('_slab')) {
      const t = c.props.type;
      if (t === 'double') return true;
      return (face === 'down' && t === 'bottom') || (face === 'up' && t === 'top');
    }
    if (c.kind === 'stairs') {
      const half = c.props.half;
      if (face === 'down') return half === 'bottom';
      if (face === 'up') return half === 'top';
      const f = c.props.facing as Dir4;
      const shape = c.props.shape;
      if (shape === 'straight') return face === f;
      if (shape === 'inner_left') return face === f || face === CCW[f];
      if (shape === 'inner_right') return face === f || face === CW[f];
      return false;
    }
    return false;
  }

  private coversPost(c: Cls): boolean {
    if (c.air) return false;
    if (c.ph) return (c.ph[5] & PF.WALL_POST) !== 0;
    if (this.sturdy(c, 'down')) return true;
    if (c.kind === 'fence' || c.kind === 'pane') return true;
    if (c.kind === 'wall') return c.props.up === 'true';
    if (c.kind === 'gate') return false;
    return POST_COVER_RE.test(c.short);
  }

  private gateConnects(gate: Cls, dir: Dir4): boolean {
    // gate spans perpendicular to its facing; connects to neighbours along its span
    return AXIS[gate.props.facing as Dir4] === AXIS[CW[dir]];
  }

  /** isRedstoneConductor (physics; heuristic: full && !transparent) */
  isConductor(state: string): boolean {
    return this.conductor(this.classify(state));
  }

  /** what a wall below this block sees: tall arms per side and whether the post is covered */
  wallCover(state: string): { post: boolean; arms: Record<Dir4, boolean> } {
    const c = this.classify(state);
    const arm = (d: Dir4) => {
      if (c.air) return false;
      if (c.ph) return (c.ph[5] & WALL_ARM[d]) !== 0;
      return this.sturdy(c, 'down') || (c.kind === 'wall' && !!c.props[d] && c.props[d] !== 'none');
    };
    return { post: this.coversPost(c), arms: { north: arm('north'), east: arm('east'), south: arm('south'), west: arm('west') } };
  }

  /** true if the block can change through a neighbour shape update */
  isConnectable(state: string): boolean {
    return this.classify(state).kind !== 'other';
  }

  /** compute the updated state of one block given a reader (null = not a connecting block) */
  update(get: (x: number, y: number, z: number) => string, x: number, y: number, z: number, state: string): string | null {
    const c = this.classify(state);
    switch (c.kind) {
      case 'fence':
      case 'pane':
      case 'wall':
        return this.updateConnecting(get, x, y, z, c);
      case 'gate':
        return this.updateGate(get, x, y, z, c);
      case 'stairs':
        return this.updateStairs(get, x, y, z, c);
      case 'wire':
        return this.updateWire(get, x, y, z, c);
      case 'chorus':
        return this.updateChorus(get, x, y, z, c);
      case 'tripwire': {
        // TripWireBlock.shouldConnectTo: a hook facing away from us, or more tripwire
        const p: Record<string, string> = {};
        for (const d of DIRS4) {
          const n = this.classify(get(x + OFF[d][0], y, z + OFF[d][1]));
          p[d] = String(n.short === 'tripwire_hook' ? n.props.facing === OPP[d] : n.short === 'tripwire');
        }
        return this.result(c, `${p.north}${p.east}${p.south}${p.west}`, () => p);
      }
      case 'mosscarpet':
        return this.updateMossCarpet(get, x, y, z, c);
      case 'snowy': {
        const snowy = String(this.reg.hasTag(this.classify(get(x, y + 1, z)).id, 'minecraft:snow'));
        return this.result(c, snowy, () => ({ snowy }));
      }
      default:
        return null;
    }
  }

  /** memoized "state + neighbour signature → new state" */
  private result(c: Cls, sig: string, patch: () => Record<string, string>): string {
    const k = c.head + '|' + sig;
    let r = this.results.get(k);
    if (r === undefined) {
      r = formatBlockState({ name: c.id, props: { ...c.props, ...patch() } });
      if (this.results.size >= MAX_CACHE) this.results.clear();
      this.results.set(k, r);
    }
    return r;
  }

  private connects(self: Cls, nc: Cls, dir: Dir4): boolean {
    if (nc.air) return false;
    const sturdy = !nc.exception && this.sturdy(nc, OPP[dir]);
    switch (self.kind) {
      case 'fence':
        if (sturdy) return true;
        if (nc.kind === 'fence' && nc.wooden === self.wooden) return true;
        return nc.kind === 'gate' && this.gateConnects(nc, dir);
      case 'pane':
        return sturdy || nc.kind === 'pane' || nc.kind === 'wall';
      case 'wall':
        return nc.kind === 'wall' || sturdy || nc.kind === 'pane' || (nc.kind === 'gate' && this.gateConnects(nc, dir));
    }
    return false;
  }

  private updateConnecting(get: (x: number, y: number, z: number) => string, x: number, y: number, z: number, c: Cls): string {
    const n = this.connects(c, this.classify(get(x, y, z - 1)), 'north');
    const e = this.connects(c, this.classify(get(x + 1, y, z)), 'east');
    const s = this.connects(c, this.classify(get(x, y, z + 1)), 'south');
    const w = this.connects(c, this.classify(get(x - 1, y, z)), 'west');
    if (c.kind !== 'wall') {
      const sig = (n ? 'n' : '') + (e ? 'e' : '') + (s ? 's' : '') + (w ? 'w' : '');
      return this.result(c, sig, () => ({ north: String(n), east: String(e), south: String(s), west: String(w) }));
    }
    // walls
    const ac = this.classify(get(x, y + 1, z));
    const full = this.sturdy(ac, 'down');
    const side = (conn: boolean, d: Dir4) => {
      if (!conn) return 'none';
      if (ac.ph) return (ac.ph[5] & WALL_ARM[d]) !== 0 ? 'tall' : 'low';
      if (full) return 'tall';
      return ac.kind === 'wall' && ac.props[d] && ac.props[d] !== 'none' ? 'tall' : 'low';
    };
    const p = { north: side(n, 'north'), east: side(e, 'east'), south: side(s, 'south'), west: side(w, 'west'), up: '' };
    p.up = String(this.wallPost(p, ac));
    return this.result(c, `${p.north},${p.east},${p.south},${p.west},${p.up}`, () => p);
  }

  private wallPost(p: Record<string, string>, ac: Cls): boolean {
    if (ac.kind === 'wall' && ac.props.up === 'true') return true;
    const n = p.north === 'none', e = p.east === 'none', s = p.south === 'none', w = p.west === 'none';
    if ((n && s && w && e) || n !== s || w !== e) return true;
    if ((p.north === 'tall' && p.south === 'tall') || (p.east === 'tall' && p.west === 'tall')) return false;
    if (ac.air) return false;
    return this.reg.hasTag(ac.id, 'minecraft:wall_post_override') || this.coversPost(ac);
  }

  private updateGate(get: (x: number, y: number, z: number) => string, x: number, y: number, z: number, c: Cls): string {
    const f = c.props.facing as Dir4;
    const isWall = (d: Dir4) => this.classify(get(x + OFF[d][0], y, z + OFF[d][1])).kind === 'wall';
    const inWall = String(isWall(CW[f]) || isWall(CCW[f]));
    return this.result(c, inWall, () => ({ in_wall: inWall }));
  }

  private stairAtFn(get: (x: number, y: number, z: number) => string) {
    return (x: number, y: number, z: number): StairInfo | null => {
      const c = this.classify(get(x, y, z));
      if (c.kind !== 'stairs') return null;
      return { facing: c.props.facing as Dir4, half: c.props.half };
    };
  }

  private updateStairs(get: (x: number, y: number, z: number) => string, x: number, y: number, z: number, c: Cls): string {
    const shape = stairsShapeFor(x, y, z, c.props.facing as Dir4, c.props.half, this.stairAtFn(get));
    return this.result(c, shape, () => ({ shape }));
  }

  private wireConnectsTo(c: Cls, dir: Dir4 | null): boolean {
    if (c.air) return false;
    if (c.kind === 'wire') return true;
    if (c.short === 'repeater') {
      const f = c.props.facing as Dir4;
      return dir !== null && (f === dir || f === OPP[dir]);
    }
    if (c.short === 'observer') return dir !== null && c.props.facing === dir;
    if (dir === null) return false;
    if (c.ph) return (c.ph[5] & PF.SIGNAL_SOURCE) !== 0;
    return SIGNAL_SOURCES_RE.test(c.short);
  }

  /** isRedstoneConductor */
  private conductor(c: Cls): boolean {
    if (c.air) return false;
    if (c.ph) return (c.ph[5] & PF.CONDUCTOR) !== 0;
    return c.full && !this.reg.isTransparent(c.head);
  }

  /** vanilla RedStoneWireBlock.canSurviveOn (+ trapdoors: wire may climb onto them) */
  private wirePlaceableOn(n: Cls): boolean {
    return this.sturdy(n, 'up') || n.short === 'hopper' || n.short.endsWith('_trapdoor');
  }

  private updateWire(get: (x: number, y: number, z: number) => string, x: number, y: number, z: number, c: Cls): string {
    const aboveConductor = this.conductor(this.classify(get(x, y + 1, z)));
    const side: Record<Dir4, string> = { north: 'none', east: 'none', south: 'none', west: 'none' };
    for (const d of DIRS4) {
      const [dx, dz] = OFF[d];
      const n = this.classify(get(x + dx, y, z + dz));
      if (!aboveConductor) {
        if (this.wirePlaceableOn(n) && this.wireConnectsTo(this.classify(get(x + dx, y + 1, z + dz)), null)) {
          side[d] = this.sturdy(n, OPP[d]) ? 'up' : 'side';
          continue;
        }
      }
      if (this.wireConnectsTo(n, d) || (!this.conductor(n) && this.wireConnectsTo(this.classify(get(x + dx, y - 1, z + dz)), null))) side[d] = 'side';
    }
    // vanilla getConnectionState: a dot (all none) without connections stays a dot; otherwise a
    // wire with connections on only one axis extends to a line and no connections → cross
    const n = side.north !== 'none', s = side.south !== 'none', e = side.east !== 'none', w = side.west !== 'none';
    const wasDot = c.props.north === 'none' && c.props.south === 'none' && c.props.east === 'none' && c.props.west === 'none';
    if (wasDot && !n && !s && !e && !w) return this.result(c, 'dot', () => side);
    const noNS = !n && !s;
    const noEW = !e && !w;
    if (!w && noNS) side.west = 'side';
    if (!e && noNS) side.east = 'side';
    if (!n && noEW) side.north = 'side';
    if (!s && noEW) side.south = 'side';
    return this.result(c, `${side.north},${side.east},${side.south},${side.west}`, () => side);
  }

  /** MossyCarpetBlock.getUpdatedState(createSides = false): sides grow on attachable walls */
  private updateMossCarpet(get: (x: number, y: number, z: number) => string, x: number, y: number, z: number, c: Cls): string {
    const base = c.props.bottom === 'true';
    const above = this.classify(get(x, y + 1, z));
    const below = this.classify(get(x, y - 1, z));
    const p: Record<string, string> = {};
    for (const d of DIRS4) {
      const n = this.classify(get(x + OFF[d][0], y, z + OFF[d][1]));
      // MultifaceBlock.canAttachTo: the neighbour's face toward us is a full support or collision face
      const b = PBIT[OPP[d]];
      const attach = n.air ? false : n.ph ? ((n.ph[3] | n.ph[4]) & b) !== 0 : this.sturdy(n, OPP[d]);
      let side = attach ? (base ? 'low' : c.props[d] ?? 'none') : 'none';
      if (side === 'low') {
        if (above.short === 'pale_moss_carpet' && above.props[d] !== 'none' && above.props.bottom !== 'true') side = 'tall';
        if (!base && below.short === 'pale_moss_carpet' && below.props[d] === 'none') side = 'none';
      }
      p[d] = side;
    }
    return this.result(c, `${p.north},${p.east},${p.south},${p.west},${above.head},${below.head}`, () => p);
  }

  private updateChorus(get: (x: number, y: number, z: number) => string, x: number, y: number, z: number, c: Cls): string {
    const ok = (s: string, down: boolean) => {
      const id = this.classify(s).id;
      return id === 'minecraft:chorus_plant' || id === 'minecraft:chorus_flower' || (down && id === 'minecraft:end_stone');
    };
    const p: Record<string, string> = {};
    for (const d of DIRS4) p[d] = String(ok(get(x + OFF[d][0], y, z + OFF[d][1]), false));
    p.up = String(ok(get(x, y + 1, z), false));
    p.down = String(ok(get(x, y - 1, z), true));
    return this.result(c, `${p.north}${p.east}${p.south}${p.west}${p.up}${p.down}`, () => p);
  }
}

const connectors = new WeakMap<Registry, Connector>();
export function connectorFor(reg: Registry): Connector {
  let c = connectors.get(reg);
  if (!c) {
    c = new Connector(reg);
    connectors.set(reg, c);
  }
  return c;
}

const NB: [number, number, number][] = [
  [0, 0, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
  [0, 1, 0],
  [0, -1, 0],
];
const MAX_GRID = 32_000_000;

/**
 * Recompute connection properties for the given positions and their 6 neighbours (vanilla
 * neighbour shape updates). `get` returns the current canonical state (with the new blocks
 * already applied). Returns only the states that changed (SNBT preserved). Stairs are solved
 * first (their shape only depends on neighbouring stairs), then fences/panes/walls/gates/wire
 * top-down (a wall's post depends on the wall above).
 *
 * Performance: positions are de-duplicated with a bitmap over their bounding box (fallback: a
 * packed-key set for very sparse inputs); only blocks of connectable families are updated and
 * all per-state work is cached, so callers may pass already-expanded neighbour lists cheaply.
 */
export function solveConnections(
  get: (x: number, y: number, z: number) => string,
  positions: Iterable<Vec3>,
  reg: Registry,
): Array<[number, number, number, string]> {
  const conn = connectorFor(reg);
  // gather input
  let buf = new Int32Array(3 * 4096);
  let n = 0;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const p of positions) {
    if (3 * n + 3 > buf.length) {
      const b = new Int32Array(buf.length * 2);
      b.set(buf);
      buf = b;
    }
    const x = p[0], y = p[1], z = p[2];
    buf[3 * n] = x;
    buf[3 * n + 1] = y;
    buf[3 * n + 2] = z;
    n++;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  if (!n) return [];
  // index space: bbox + margin 2 (candidates are within 1, their reads within 2)
  x0 -= 2; y0 -= 2; z0 -= 2; x1 += 2; y1 += 2; z1 += 2;
  const nx = x1 - x0 + 1, ny = y1 - y0 + 1, nz = z1 - z0 + 1;
  const dense = nx * ny * nz <= MAX_GRID;
  const vis = dense ? new Uint8Array(nx * ny * nz) : null;
  const visSet = dense ? null : new Set<string>();
  const idx = (x: number, y: number, z: number) => ((y - y0) * nz + (z - z0)) * nx + (x - x0);
  const pk = (x: number, y: number, z: number) => x + ',' + y + ',' + z;

  // candidates (connectable blocks among positions + neighbours)
  const stairs: number[] = [];
  const others: number[] = [];
  for (let i = 0; i < n; i++) {
    const px = buf[3 * i], py = buf[3 * i + 1], pz = buf[3 * i + 2];
    for (let k = 0; k < 7; k++) {
      const o = NB[k];
      const x = px + o[0], y = py + o[1], z = pz + o[2];
      if (vis) {
        const j = idx(x, y, z);
        if (vis[j]) continue;
        vis[j] = 1;
      } else {
        const j = pk(x, y, z);
        if (visSet!.has(j)) continue;
        visSet!.add(j);
      }
      const kind = conn.classify(get(x, y, z)).kind;
      if (kind === 'other') continue;
      (kind === 'stairs' ? stairs : others).push(x, y, z);
    }
  }
  if (!stairs.length && !others.length) return [];

  // overlay of updated states (reads must see earlier updates)
  const overlay = new Map<number | string, string>();
  const okey = (x: number, y: number, z: number): number | string =>
    dense && x >= x0 && x <= x1 && y >= y0 && y <= y1 && z >= z0 && z <= z1 ? idx(x, y, z) : pk(x, y, z);
  const read = (x: number, y: number, z: number): string => {
    if (overlay.size) {
      const v = overlay.get(okey(x, y, z));
      if (v !== undefined) return v;
    }
    return get(x, y, z);
  };
  const out: Array<[number, number, number, string]> = [];
  const outAt = new Map<number | string, number>();
  const apply = (x: number, y: number, z: number) => {
    const s = read(x, y, z);
    const c = conn.classify(s);
    const r = conn.update(read, x, y, z, c.head);
    if (r === null || r === c.head) return;
    const full = s.length > c.head.length ? r + s.slice(c.head.length) : r;
    const k = okey(x, y, z);
    overlay.set(k, full);
    const at = outAt.get(k);
    if (at === undefined) {
      outAt.set(k, out.length);
      out.push([x, y, z, full]);
    } else out[at][3] = full;
  };
  for (let i = 0; i < stairs.length; i += 3) apply(stairs[i], stairs[i + 1], stairs[i + 2]);
  // others top-down (walls read the wall above)
  const order: number[] = [];
  for (let i = 0; i < others.length; i += 3) order.push(i);
  order.sort((a, b) => others[b + 1] - others[a + 1]);
  for (const i of order) apply(others[i], others[i + 1], others[i + 2]);
  // drop entries that ended up unchanged versus the original world
  return out.filter(([x, y, z, s]) => get(x, y, z) !== s);
}
