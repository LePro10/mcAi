// Multi-block structures: placing one part yields the full set of states.
// See docs/ENGINE-API.md (connect.ts / multiblock.ts).
//
//  * half=lower|upper (doors, sunflower, lilac, rose_bush, peony, tall_grass, large_fern,
//    pitcher_plant, tall_seagrass, small_dripleaf, pitcher_crop when age >= 3, any future block
//    with the same property): the other half goes directly above/below with the same
//    properties (facing, hinge, open, powered, waterlogged, …) except `half`.
//  * part=foot|head (beds): the head is one block in the bed's `facing` direction from the foot.
//  * Big dripleaf (stem + leaf are separate blocks) and pistons are not expanded.
//
// expandMultiblock returns the given block first, then its partner(s).
// expandMultiblocks applies this to a whole list and never overrides positions that were
// explicitly placed (so if the agent places both halves itself, nothing is duplicated).
import type { Vec3 } from './types.ts';
import type { Registry } from './registry.ts';
import { formatBlockState, parseBlockState } from './blockstate.ts';

const OFF: Record<string, [number, number]> = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] };

type Entry = [number, number, number, string];

const cache = new WeakMap<Registry, Map<string, { dx: number; dy: number; dz: number; state: string } | null>>();

function partnerOf(state: string, reg: Registry): { dx: number; dy: number; dz: number; state: string } | null {
  let m = cache.get(reg);
  if (!m) {
    m = new Map();
    cache.set(reg, m);
  }
  const brace = state.indexOf('{');
  const head = brace >= 0 ? state.slice(0, brace) : state;
  const hit = m.get(head);
  if (hit !== undefined) return hit;
  let res: { dx: number; dy: number; dz: number; state: string } | null = null;
  const canon = reg.canonical(head);
  const p = parseBlockState(canon);
  const info = reg.info(p.name)!;
  const props = p.props;
  const halfVals = info.properties.half;
  if (halfVals && halfVals.includes('upper') && halfVals.includes('lower')) {
    let double = true;
    if (p.name === 'minecraft:pitcher_crop') double = Number(props.age) >= 3;
    if (double) {
      const lower = props.half === 'lower';
      res = { dx: 0, dy: lower ? 1 : -1, dz: 0, state: formatBlockState({ name: p.name, props: { ...props, half: lower ? 'upper' : 'lower' } }) };
    }
  } else if (info.properties.part && info.properties.part.includes('head') && info.properties.part.includes('foot') && props.facing) {
    const [fx, fz] = OFF[props.facing] ?? [0, 0];
    const foot = props.part === 'foot';
    res = {
      dx: foot ? fx : -fx,
      dy: 0,
      dz: foot ? fz : -fz,
      state: formatBlockState({ name: p.name, props: { ...props, part: foot ? 'head' : 'foot' } }),
    };
  }
  if (m.size > 50_000) m.clear();
  m.set(head, res);
  return res;
}

/** Full set of states for a (possibly multi-block) block placed at x,y,z. First entry = the input. */
export function expandMultiblock(x: number, y: number, z: number, state: string, reg: Registry): Array<[number, number, number, string]> {
  const out: Entry[] = [[x, y, z, state]];
  const part = partnerOf(state, reg);
  if (part) out.push([x + part.dx, y + part.dy, z + part.dz, part.state]);
  return out;
}

/** true if the state is one half of a multi-block structure */
export function isMultiblock(state: string, reg: Registry): boolean {
  return partnerOf(state, reg) !== null;
}

/**
 * Expand a batch: returns only the *additional* entries (partners) whose positions were not
 * explicitly set in `entries`. Later partners never override earlier explicit entries.
 */
export function expandMultiblocks(entries: Iterable<Entry>, reg: Registry): Entry[] {
  const list = [...entries];
  const explicit = new Set<string>();
  for (const [x, y, z] of list) explicit.add(`${x},${y},${z}`);
  const extra = new Map<string, Entry>();
  for (const [x, y, z, s] of list) {
    const part = partnerOf(s, reg);
    if (!part) continue;
    const X = x + part.dx, Y = y + part.dy, Z = z + part.dz;
    const k = `${X},${Y},${Z}`;
    if (explicit.has(k) || extra.has(k)) continue;
    extra.set(k, [X, Y, Z, part.state]);
  }
  return [...extra.values()];
}

/** partner position of a multi-block part, or null */
export function multiblockPartner(x: number, y: number, z: number, state: string, reg: Registry): Vec3 | null {
  const part = partnerOf(state, reg);
  return part ? [x + part.dx, y + part.dy, z + part.dz] : null;
}
