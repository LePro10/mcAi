// Content safety for world edits and commands: no command blocks (or command-block minecarts),
// no `run_command` click events / `Command` tags in block-entity or entity SNBT, and summon NBT
// whose nested entities (Passengers …) are all on the decorative allowlist. The mod enforces the
// same (config allowCommandBlocks=false); the engine rejects early with a clear message.

import { blockId } from './blockstate.ts';
import { snbtToNbt, type NbtTag } from './snbt.ts';

export class SafetyError extends Error {
  override name = 'SafetyError';
}

const COMMAND_IDS = /^(minecraft:)?(command_block|chain_command_block|repeating_command_block|command_block_minecart)$/;

export function isCommandBlockId(id: string): boolean {
  return COMMAND_IDS.test(id.trim().toLowerCase());
}

/** `run_command` click events or a `Command` tag in SNBT text (signs, books, banners, entities). */
export function snbtRunsCommands(snbt: string): boolean {
  return /run_command/i.test(snbt) || /(^|[{,\s"'])Command["']?\s*:/.test(snbt);
}

const cache = new Map<string, string | null>();

/** Error message for a forbidden block state, or null. Cached per state string. */
export function blockStateProblem(state: string): string | null {
  let r = cache.get(state);
  if (r !== undefined) return r;
  r = null;
  const id = blockId(state);
  if (isCommandBlockId(id)) r = `${id.slice(10)} is not allowed (command blocks are disabled for mcAI builds)`;
  else {
    const i = state.indexOf('{');
    if (i >= 0 && snbtRunsCommands(state.slice(i))) r = `block data of ${id.slice(10)} contains run_command / Command (click events that run commands are not allowed)`;
  }
  if (cache.size > 50_000) cache.clear();
  cache.set(state, r);
  return r;
}

/** throw SafetyError for forbidden states */
export function assertSafeState(state: string): void {
  const p = blockStateProblem(state);
  if (p) throw new SafetyError(p);
}

/**
 * Validate summon NBT: every nested entity id (Passengers, and any compound with an `id` that is
 * an entity in a Passengers list) must be allowed; no command-block ids anywhere (items included);
 * no run_command / Command content. Returns an error message or null.
 */
export function summonNbtProblem(nbt: string, allowedEntities: Set<string>): string | null {
  if (snbtRunsCommands(nbt)) return 'entity data with run_command / Command is not allowed';
  let root: NbtTag;
  try {
    root = snbtToNbt(nbt);
  } catch (e) {
    return `could not parse the entity NBT (${(e as Error).message}) — fix the SNBT`;
  }
  const short = (s: string) => s.trim().toLowerCase().replace(/^minecraft:/, '');
  const problem = { msg: null as string | null };
  // walk raw values (list elements are raw: compounds as Record<string, NbtTag>)
  const walkRaw = (v: unknown, passenger: boolean): void => {
    if (problem.msg || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) walkRaw(x, passenger);
      return;
    }
    const o = v as Record<string, unknown>;
    if (typeof o.type === 'string' && 'value' in o && !passenger) {
      walkTag(o as unknown as NbtTag, false);
      return;
    }
    walkCompound(o as Record<string, NbtTag | undefined>, passenger);
  };
  const walkCompound = (c: Record<string, NbtTag | undefined>, isEntity: boolean): void => {
    for (const [k, t] of Object.entries(c)) {
      if (!t || problem.msg) continue;
      if (/^command$/i.test(k)) {
        problem.msg = 'entity data with a Command tag is not allowed';
        return;
      }
      if (k === 'id' && t.type === 'string') {
        const id = short(t.value);
        if (isCommandBlockId(id)) problem.msg = `${id} is not allowed`;
        else if (isEntity && !allowedEntities.has(id)) problem.msg = `nested entity '${id}' is not allowed (Passengers may only contain decorative entities)`;
      }
      walkTag(t, k === 'Passengers');
    }
  };
  const walkTag = (t: NbtTag, passengerList: boolean): void => {
    if (problem.msg) return;
    if (t.type === 'string') {
      if (isCommandBlockId(short(t.value))) problem.msg = `${short(t.value)} is not allowed`;
      return;
    }
    if (t.type === 'compound') walkCompound(t.value, false);
    else if (t.type === 'list') walkRaw(t.value.value, passengerList);
  };
  walkCompound(root.type === 'compound' ? root.value : {}, false);
  return problem.msg;
}
