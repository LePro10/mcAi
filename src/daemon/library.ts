/**
 * User-supplied styles and blueprints.
 *
 * The built-in palettes cover common ground, but "customizable" has to mean
 * more than picking from a list. Dropping a JSON file into `styles/` adds or
 * overrides a palette; dropping one into `blueprints/` adds a structure the
 * model and the `!build` command can both reach by name. No rebuild, no code.
 *
 * Files are read at startup and on demand, and a malformed one is reported and
 * skipped rather than taking the daemon down with it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Blueprint, Material } from '../core/types.js';
import type { Palette } from '../core/palette.js';
import { PALETTES } from '../core/palette.js';
import { validateBlueprint, formatIssues } from '../core/blueprint.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '../..');

export interface LoadResult<T> {
  items: Record<string, T>;
  errors: string[];
  /** Directories that were actually read. */
  sources: string[];
}

/** Where to look: the working directory first, then the installed package. */
export function searchPaths(dirName: string, extra?: string): string[] {
  const dirs = [
    extra,
    process.env.MCAI_HOME ? path.join(process.env.MCAI_HOME, dirName) : undefined,
    path.resolve(process.cwd(), dirName),
    path.resolve(PACKAGE_ROOT, dirName),
  ].filter((d): d is string => !!d);
  // Deduplicate while keeping precedence order.
  return [...new Set(dirs.map((d) => path.resolve(d)))];
}

function readJsonDir(dirs: string[]): { files: Array<{ name: string; data: unknown; file: string }>; errors: string[]; sources: string[] } {
  const files: Array<{ name: string; data: unknown; file: string }> = [];
  const errors: string[] = [];
  const sources: string[] = [];

  // Later directories are lower precedence, so read them first and let earlier
  // ones overwrite.
  for (const dir of [...dirs].reverse()) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    sources.push(dir);
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue;
      const file = path.join(dir, entry);
      try {
        files.push({ name: entry.replace(/\.json$/, '').toLowerCase(), data: JSON.parse(fs.readFileSync(file, 'utf8')), file });
      } catch (err) {
        errors.push(`${file}: ${(err as Error).message}`);
      }
    }
  }
  return { files, errors, sources };
}

/** Validate a palette file, returning it or the reason it was rejected. */
export function parsePalette(name: string, data: unknown): { palette?: Palette; error?: string } {
  if (!data || typeof data !== 'object') return { error: 'not a JSON object' };
  const d = data as Record<string, unknown>;
  const slots = d.slots ?? d.materials;
  if (!slots || typeof slots !== 'object') {
    return { error: 'missing a "slots" object mapping slot names to blocks' };
  }
  const cleaned: Record<string, Material> = {};
  for (const [slot, value] of Object.entries(slots as Record<string, unknown>)) {
    if (typeof value === 'string') cleaned[slot] = value;
    else if (value && typeof value === 'object' && Array.isArray((value as { mix?: unknown }).mix)) {
      cleaned[slot] = value as Material;
    } else {
      return { error: `slot "${slot}" must be a block id or {"mix":[...]}` };
    }
  }
  // Inherit from a built-in so a file only has to say what differs.
  const baseName = typeof d.extends === 'string' ? d.extends.toLowerCase() : null;
  const base = baseName ? PALETTES[baseName] : undefined;
  if (baseName && !base) return { error: `extends unknown style "${baseName}"` };

  return {
    palette: {
      name: typeof d.name === 'string' ? d.name : name,
      description: typeof d.description === 'string' ? d.description : `Custom style "${name}"`,
      slots: { ...(base?.slots ?? {}), ...cleaned },
      hints: Array.isArray(d.hints) ? (d.hints as string[]).filter((h) => typeof h === 'string') : base?.hints,
      biomes: Array.isArray(d.biomes) ? (d.biomes as string[]).filter((b) => typeof b === 'string') : undefined,
      auto: d.auto === true,
    },
  };
}

export function loadStyles(extraDir?: string): LoadResult<Palette> {
  const dirs = searchPaths('styles', extraDir);
  const { files, errors, sources } = readJsonDir(dirs);
  const items: Record<string, Palette> = {};
  for (const f of files) {
    const { palette, error } = parsePalette(f.name, f.data);
    if (error) { errors.push(`${f.file}: ${error}`); continue; }
    items[f.name] = palette!;
  }
  return { items, errors, sources };
}

export function loadBlueprints(extraDir?: string): LoadResult<Blueprint> {
  const dirs = searchPaths('blueprints', extraDir);
  const { files, errors, sources } = readJsonDir(dirs);
  const items: Record<string, Blueprint> = {};
  for (const f of files) {
    const v = validateBlueprint(f.data);
    if (!v.ok) { errors.push(`${f.file}:\n${formatIssues(v.errors, 4)}`); continue; }
    const bp = f.data as Blueprint;
    items[f.name] = { ...bp, name: bp.name ?? f.name };
  }
  return { items, errors, sources };
}

/** Write the built-in palettes out as editable files people can start from. */
export function exportBuiltinStyles(dir: string): string[] {
  fs.mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const [name, palette] of Object.entries(PALETTES)) {
    const file = path.join(dir, `${name}.json`);
    fs.writeFileSync(file, `${JSON.stringify({
      name: palette.name,
      description: palette.description,
      hints: palette.hints,
      biomes: palette.biomes,
      auto: palette.auto ?? false,
      slots: palette.slots,
    }, null, 2)}\n`);
    written.push(file);
  }
  return written;
}
