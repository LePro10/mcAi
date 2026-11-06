// Shared helpers for core-geometry tests (not a test file itself).
import { Registry } from '../../src/core/registry.ts';
import { AIR } from '../../src/core/blockstate.ts';
import type { BlockSink } from '../../src/core/dsl.ts';

export const reg = Registry.loadDefault();

export const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

/** in-memory BlockSink */
export class MapSink implements BlockSink {
  m = new Map<string, string>();
  sets = 0;
  get(x: number, y: number, z: number): string {
    return this.m.get(key(x, y, z)) ?? AIR;
  }
  set(x: number, y: number, z: number, s: string): void {
    this.sets++;
    if (s === AIR) this.m.delete(key(x, y, z));
    else this.m.set(key(x, y, z), s);
  }
}

/** collect positions from a PosSink-style generator, asserting no duplicates */
export function collect(gen: (emit: (x: number, y: number, z: number) => void) => void): { pts: [number, number, number][]; dups: number; set: Set<string> } {
  const set = new Set<string>();
  const pts: [number, number, number][] = [];
  let dups = 0;
  gen((x, y, z) => {
    const k = key(x, y, z);
    if (set.has(k)) dups++;
    set.add(k);
    pts.push([x, y, z]);
  });
  return { pts, dups, set };
}

/** cartesian product of property values */
export function combos(props: Record<string, string[]>): Record<string, string>[] {
  let out: Record<string, string>[] = [{}];
  for (const [k, vals] of Object.entries(props)) {
    const next: Record<string, string>[] = [];
    for (const o of out) for (const v of vals) next.push({ ...o, [k]: v });
    out = next;
  }
  return out;
}

export function stateOf(id: string, props: Record<string, string>): string {
  const keys = Object.keys(props).sort();
  return keys.length ? `${id}[${keys.map((k) => `${k}=${props[k]}`).join(',')}]` : id;
}
