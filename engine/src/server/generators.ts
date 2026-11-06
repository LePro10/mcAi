// Persistent library of reusable run_script generators (~/.mcai/generators/<slug>.json).
// A generator is a JS function body that receives `params` and uses the normal script API
// (set, box, roof, groundY, call, …). Scripts use it with call(name, params).

import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.ts';

export interface GeneratorDef {
  name: string;
  description: string;
  /** parameter name → short description (with default) */
  params: Record<string, string>;
  code: string;
  created: string;
  updated: string;
}

export const GENERATOR_NAME_RE = /^[A-Za-z_][\w-]{0,63}$/;
const MAX_CODE = 128 * 1024;

export function generatorSlug(name: string): string {
  if (typeof name !== 'string' || !GENERATOR_NAME_RE.test(name)) throw new Error(`invalid generator name "${name}" — use letters, digits, _ and - (start with a letter)`);
  return name.toLowerCase();
}

export class GeneratorLibrary {
  readonly dir: string;
  constructor(dir = path.join(paths.home(), 'generators')) {
    this.dir = dir;
  }

  private file(name: string): string {
    return path.join(this.dir, `${generatorSlug(name)}.json`);
  }

  save(def: { name: string; description: string; params?: Record<string, string>; code: string }): GeneratorDef {
    if (!def.code?.trim()) throw new Error('generator code is empty');
    if (def.code.length > MAX_CODE) throw new Error(`generator code too long (${def.code.length} chars, max ${MAX_CODE})`);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const prev = this.load(def.name);
    const now = new Date().toISOString();
    const out: GeneratorDef = { name: def.name, description: def.description, params: def.params ?? {}, code: def.code, created: prev?.created ?? now, updated: now };
    fs.writeFileSync(this.file(def.name), JSON.stringify(out, null, 1), { mode: 0o600 });
    return out;
  }

  load(name: string): GeneratorDef | null {
    let f: string;
    try {
      f = this.file(name);
    } catch {
      return null;
    }
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8')) as GeneratorDef;
      return typeof d.code === 'string' ? d : null;
    } catch {
      return null;
    }
  }

  list(query?: string): GeneratorDef[] {
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const out: GeneratorDef[] = [];
    for (const f of files) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as GeneratorDef;
        if (typeof d.code !== 'string') continue;
        if (query && !`${d.name} ${d.description}`.toLowerCase().includes(query.toLowerCase())) continue;
        out.push(d);
      } catch {
        /* skip broken files */
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  delete(name: string): boolean {
    try {
      fs.rmSync(this.file(name));
      return true;
    } catch {
      return false;
    }
  }
}

/** Names used as call("name", …) / call('name') in a piece of code. */
export function referencedGenerators(code: string): string[] {
  const out = new Set<string>();
  const re = /\bcall\(\s*(['"`])([A-Za-z_][\w-]{0,63})\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) out.add(m[2]!);
  return [...out];
}
