// Local build frame: a pure rotation (never a mirror) of world space around an anchor.
// Local space = world as seen by a player looking north: +x right, +y up, −z forward
// (into the site), +z toward the player. toWorld rotates clockwise (from above) by `turns`:
//   (x,z) → north:(x,z) · east:(−z,x) · south:(−x,−z) · west:(z,−x), then + anchor.
// See docs/ENGINE-API.md (frame.ts).
import type { Box, Facing, Vec3 } from './types.ts';
import type { Registry } from './registry.ts';
import { rotateState, type QuarterTurns } from './transform.ts';

const TURNS: Record<Facing, QuarterTurns> = { north: 0, east: 1, south: 2, west: 3 };

export class Frame {
  readonly anchor: Vec3;
  readonly facing: Facing;
  readonly turns: QuarterTurns;
  readonly reg: Registry;
  private stw = new Map<string, string>();
  private stl = new Map<string, string>();

  constructor(anchor: Vec3, facing: Facing, reg: Registry) {
    if (!(facing in TURNS)) throw new Error(`Frame: invalid facing "${facing}" (north|east|south|west)`);
    this.anchor = [anchor[0], anchor[1], anchor[2]];
    this.facing = facing;
    this.turns = TURNS[facing];
    this.reg = reg;
  }

  static identity(reg: Registry): Frame {
    return new Frame([0, 0, 0], 'north', reg);
  }

  /** true when local == world (north facing, anchor at origin) */
  get isIdentity(): boolean {
    return this.turns === 0 && this.anchor[0] === 0 && this.anchor[1] === 0 && this.anchor[2] === 0;
  }

  toWorld(v: Vec3): Vec3 {
    const [x, y, z] = v;
    const a = this.anchor;
    switch (this.turns) {
      case 0: return [a[0] + x, a[1] + y, a[2] + z];
      case 1: return [a[0] - z + 0, a[1] + y, a[2] + x];
      case 2: return [a[0] - x + 0, a[1] + y, a[2] - z + 0];
      default: return [a[0] + z, a[1] + y, a[2] - x + 0];
    }
  }

  toLocal(v: Vec3): Vec3 {
    const a = this.anchor;
    const x = v[0] - a[0];
    const y = v[1] - a[1];
    const z = v[2] - a[2];
    switch (this.turns) {
      case 0: return [x, y, z];
      case 1: return [z, y, -x + 0];
      case 2: return [-x + 0, y, -z + 0];
      default: return [-z + 0, y, x];
    }
  }

  /** Fast in-place variant for hot loops: writes world coords of local (x,y,z) into out. */
  toWorldInto(x: number, y: number, z: number, out: Vec3): Vec3 {
    const a = this.anchor;
    switch (this.turns) {
      case 0: out[0] = a[0] + x; out[2] = a[2] + z; break;
      case 1: out[0] = a[0] - z; out[2] = a[2] + x; break;
      case 2: out[0] = a[0] - x; out[2] = a[2] - z; break;
      default: out[0] = a[0] + z; out[2] = a[2] - x; break;
    }
    out[1] = a[1] + y;
    return out;
  }

  /** rotate a block state from local to world orientation (canonical result, cached) */
  stateToWorld(state: string): string {
    let r = this.stw.get(state);
    if (r === undefined) {
      r = rotateState(state, this.turns, this.reg);
      if (this.stw.size > 100_000) this.stw.clear();
      this.stw.set(state, r);
    }
    return r;
  }

  stateToLocal(state: string): string {
    let r = this.stl.get(state);
    if (r === undefined) {
      r = rotateState(state, ((4 - this.turns) % 4) as QuarterTurns, this.reg);
      if (this.stl.size > 100_000) this.stl.clear();
      this.stl.set(state, r);
    }
    return r;
  }

  boxToWorld(b: Box): Box {
    return normBox(this.toWorld(b.min), this.toWorld(b.max));
  }

  boxToLocal(b: Box): Box {
    return normBox(this.toLocal(b.min), this.toLocal(b.max));
  }
}

function normBox(a: Vec3, b: Vec3): Box {
  return {
    min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
    max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
  };
}
