// Builds engine/data/registry-<ver>.json (BlockRegistry, see docs/ARCHITECTURE.md §3)
// from misode/mcmeta summary data (blocks + block tags). Usage: node scripts/build-registry.ts [version]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BlockRegistry, BlockInfo } from '../src/core/types.ts';

const version = process.argv[2] ?? '26.3';
const base = `https://raw.githubusercontent.com/misode/mcmeta/${version}-summary`;

async function get(path: string): Promise<any> {
  const r = await fetch(`${base}/${path}`);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

const blocks: Record<string, [Record<string, string[]>, Record<string, string>]> = await get('blocks/data.min.json');
const tags: Record<string, { values: string[] }> = await get('data/tag/block/data.min.json');

// resolve tag membership (tags can include other tags via '#')
const resolved = new Map<string, Set<string>>();
function resolve(tag: string, stack: string[] = []): Set<string> {
  const hit = resolved.get(tag);
  if (hit) return hit;
  const out = new Set<string>();
  const def = tags[tag];
  if (def && !stack.includes(tag)) {
    for (const v of def.values) {
      const val = typeof v === 'string' ? v : (v as any).id;
      if (val.startsWith('#')) for (const x of resolve(val.slice(1).replace(/^minecraft:/, ''), [...stack, tag])) out.add(x);
      else out.add(val.replace(/^minecraft:/, ''));
    }
  }
  resolved.set(tag, out);
  return out;
}
const blockTags = new Map<string, string[]>();
for (const tag of Object.keys(tags)) for (const b of resolve(tag)) {
  if (!blockTags.has(b)) blockTags.set(b, []);
  blockTags.get(b)!.push(`minecraft:${tag}`);
}

const reg: BlockRegistry = { version, blocks: {} };
for (const id of Object.keys(blocks).sort()) {
  const [properties, def] = blocks[id];
  const info: BlockInfo = { properties, default: def };
  const t = blockTags.get(id);
  if (t?.length) info.tags = t.sort();
  reg.blocks[`minecraft:${id}`] = info;
}
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', `registry-${version}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(reg));
console.log(`wrote ${out}: ${Object.keys(reg.blocks).length} blocks, ${Object.keys(tags).length} tags`);
