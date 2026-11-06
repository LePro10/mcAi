// Tiny private block-registry helper for assets/render/sim (the full Registry lives in
// core/registry.ts, owned by core-geometry). Loads engine/data/registry-<ver>.json,
// fills default properties and validates states.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BlockRegistry } from '../core/types.ts';
import { parseBlockState, formatBlockState } from '../core/blockstate.ts';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const loaded = new Map<string, BlockRegistry | null>();

export function loadRegistryData(version = '26.3'): BlockRegistry | null {
  if (loaded.has(version)) return loaded.get(version)!;
  const p = join(DATA_DIR, `registry-${version}.json`);
  const reg = existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as BlockRegistry) : null;
  loaded.set(version, reg);
  return reg;
}

/** Structural subset of core Registry that the sim needs (so a core Registry can be passed in). */
export interface RegistryLike {
  tryCanonical(state: string): { ok: true; state: string } | { ok: false; error: string };
}

export class LiteRegistry implements RegistryLike {
  readonly data: BlockRegistry;
  private cache = new Map<string, { ok: true; state: string } | { ok: false; error: string }>();
  constructor(data: BlockRegistry) {
    this.data = data;
  }
  static load(version = '26.3'): LiteRegistry {
    const d = loadRegistryData(version);
    if (!d) throw new Error(`block registry for ${version} not found in ${DATA_DIR}`);
    return new LiteRegistry(d);
  }
  has(id: string): boolean {
    return !!this.data.blocks[id.includes(':') ? id : `minecraft:${id}`];
  }
  tryCanonical(state: string): { ok: true; state: string } | { ok: false; error: string } {
    const hit = this.cache.get(state);
    if (hit) return hit;
    let res: { ok: true; state: string } | { ok: false; error: string };
    try {
      const p = parseBlockState(state);
      const info = this.data.blocks[p.name];
      if (!info) res = { ok: false, error: `unknown block "${p.name}"` };
      else {
        const props: Record<string, string> = { ...info.default };
        let err = '';
        for (const [k, v] of Object.entries(p.props)) {
          const allowed = info.properties[k];
          if (!allowed) {
            err = `block ${p.name} has no property "${k}" (has: ${Object.keys(info.properties).join(', ') || 'none'})`;
            break;
          }
          if (!allowed.includes(v)) {
            err = `invalid value "${v}" for ${p.name}[${k}] (allowed: ${allowed.join(', ')})`;
            break;
          }
          props[k] = v;
        }
        res = err ? { ok: false, error: err } : { ok: true, state: formatBlockState({ name: p.name, props, nbt: p.nbt }) };
      }
    } catch (e) {
      res = { ok: false, error: (e as Error).message };
    }
    if (this.cache.size > 200_000) this.cache.clear();
    this.cache.set(state, res);
    return res;
  }
  canonical(state: string): string {
    const r = this.tryCanonical(state);
    if (!r.ok) throw new Error(r.error);
    return r.state;
  }
}

/** parse + fill registry defaults (non-throwing; unknown blocks keep their props) */
export function stateProps(state: string, version = '26.3'): { id: string; props: Record<string, string> } {
  const p = parseBlockState(state);
  const info = loadRegistryData(version)?.blocks[p.name];
  return { id: p.name, props: info ? { ...info.default, ...p.props } : p.props };
}
