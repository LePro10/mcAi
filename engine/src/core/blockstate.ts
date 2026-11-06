// Block state string parsing/formatting. Syntax = vanilla /setblock syntax:
//   namespace:id[prop=value,...]{snbt}
// See docs/ARCHITECTURE.md §3.

export interface ParsedState {
  /** fully namespaced id, e.g. 'minecraft:oak_stairs' */
  name: string;
  /** properties as written (not defaults-filled) */
  props: Record<string, string>;
  /** raw SNBT including the outer braces, or undefined */
  nbt?: string;
}

export class BlockStateError extends Error {}

const ID_RE = /^[a-z0-9_.\-]+(:[a-z0-9_.\-/]+)?$/;

export function normalizeId(id: string): string {
  const s = id.trim().toLowerCase();
  return s.includes(':') ? s : `minecraft:${s}`;
}

export function parseBlockState(input: string): ParsedState {
  const s = input.trim();
  if (!s) throw new BlockStateError('empty block state');
  let i = 0;
  while (i < s.length && s[i] !== '[' && s[i] !== '{') i++;
  const rawId = s.slice(0, i).trim();
  if (!ID_RE.test(rawId.toLowerCase())) throw new BlockStateError(`invalid block id "${rawId}" in "${input}"`);
  const name = normalizeId(rawId);
  const props: Record<string, string> = {};
  if (s[i] === '[') {
    const end = s.indexOf(']', i);
    if (end < 0) throw new BlockStateError(`unterminated [ in "${input}"`);
    const body = s.slice(i + 1, end).trim();
    if (body.length) {
      for (const part of body.split(',')) {
        const eq = part.indexOf('=');
        if (eq < 0) throw new BlockStateError(`property without value "${part}" in "${input}"`);
        const k = part.slice(0, eq).trim().toLowerCase();
        const v = part.slice(eq + 1).trim().toLowerCase();
        if (!k || !v) throw new BlockStateError(`bad property "${part}" in "${input}"`);
        props[k] = v;
      }
    }
    i = end + 1;
  }
  let nbt: string | undefined;
  if (i < s.length) {
    const rest = s.slice(i).trim();
    if (!rest.startsWith('{') || !rest.endsWith('}')) throw new BlockStateError(`unexpected trailing text in "${input}"`);
    nbt = rest;
  }
  return { name, props, nbt };
}

export function formatBlockState(p: ParsedState): string {
  const keys = Object.keys(p.props).sort();
  let out = p.name;
  if (keys.length) out += '[' + keys.map((k) => `${k}=${p.props[k]}`).join(',') + ']';
  if (p.nbt) out += p.nbt;
  return out;
}

/** id part only, namespaced: 'oak_stairs[facing=east]' -> 'minecraft:oak_stairs' */
export function blockId(state: string): string {
  let i = 0;
  while (i < state.length && state[i] !== '[' && state[i] !== '{') i++;
  return normalizeId(state.slice(0, i));
}

export const AIR = 'minecraft:air';
const AIRS = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air']);
export function isAir(state: string): boolean {
  return AIRS.has(blockId(state));
}
