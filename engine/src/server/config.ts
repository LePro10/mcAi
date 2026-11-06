// Engine configuration (~/.mcai/config.json) + well-known paths.
// MCAI_HOME overrides ~/.mcai (used by tests and the headless `mcai build`).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const ENGINE_VERSION = '2.0.0';

const here = path.dirname(fileURLToPath(import.meta.url));
/** engine/ package root */
export const ENGINE_ROOT = path.resolve(here, '..', '..');
/** repository root (contains engine/, agent/, mod/) */
export const REPO_ROOT = path.resolve(ENGINE_ROOT, '..');
export const VIEWER_DIR = path.join(ENGINE_ROOT, 'src', 'viewer');
export const AGENT_DIR = path.join(REPO_ROOT, 'agent');

export function mcaiHome(): string {
  return process.env.MCAI_HOME ? path.resolve(process.env.MCAI_HOME) : path.join(os.homedir(), '.mcai');
}

export const paths = {
  home: () => mcaiHome(),
  engineJson: () => path.join(mcaiHome(), 'engine.json'),
  config: () => path.join(mcaiHome(), 'config.json'),
  jobs: () => path.join(mcaiHome(), 'jobs'),
  feedback: () => path.join(mcaiHome(), 'feedback'),
  structures: () => path.join(mcaiHome(), 'structures'),
  tmp: () => path.join(mcaiHome(), 'tmp'),
  cache: () => path.join(mcaiHome(), 'cache'),
};

/** Create ~/.mcai (0700) and its subdirectories. */
export function ensureHome(): void {
  fs.mkdirSync(mcaiHome(), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(mcaiHome(), 0o700); // engine.json / token live here
  } catch {}
  for (const d of [paths.jobs(), paths.feedback(), paths.structures(), paths.tmp()]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
}

const SizeSchema = z.object({
  /** width (local x), height (y above anchor), depth (local -z, into the site) */
  x: z.number().int().min(4).max(512),
  y: z.number().int().min(4).max(384),
  z: z.number().int().min(4).max(512),
});

export const ConfigSchema = z.object({
  /** claude model alias or id */
  model: z.string().min(1).default('opus'),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  fallbackModel: z.string().optional(),
  /** per job --max-budget-usd */
  budgetUsd: z.number().positive().max(1000).default(10),
  maxBlocksPerJob: z.number().int().positive().default(2_000_000),
  maxBlocksPerCall: z.number().int().positive().default(500_000),
  concurrency: z.number().int().min(1).max(16).default(2),
  /** wall-clock limit per job */
  jobTimeoutMin: z.number().positive().max(24 * 60).default(45),
  /** extra command prefixes allowed for the agent (e.g. "time set", "weather") */
  commandAllowlist: z.array(z.string()).default([]),
  port: z.number().int().min(1024).max(65535).default(7878),
  /** default allowed build area when the player has no selection */
  defaultSize: SizeSchema.default({ x: 48, y: 40, z: 48 }),
  /** blocks below the anchor that the agent may still edit (foundations, terraforming) */
  depthBelow: z.number().int().min(0).max(64).default(12),
  /** the player's selection is the primary build area; the agent may extend this many blocks around it
   *  (supports, terrain blending, paths, trees) — horizontally and vertically */
  selectionMargin: z.number().int().min(0).max(32).default(8),
  /** minimum height of the allowed box above the selection floor / anchor (low selections grow upward) */
  minBuildHeight: z.number().int().min(4).max(256).default(32),
  /** path to the claude executable (env MCAI_CLAUDE overrides) */
  claudePath: z.string().default('claude'),
  /** extra CLI args appended to every claude invocation */
  claudeExtraArgs: z.array(z.string()).default([]),
});
export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {}

export function parseConfig(raw: unknown): Config {
  const r = ConfigSchema.safeParse(raw ?? {});
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new ConfigError(`invalid config: ${msg}`);
  }
  return r.data;
}

/** Load ~/.mcai/config.json (missing file = defaults). Overrides are merged on top. */
export function loadConfig(overrides: Partial<Config> = {}): Config {
  let raw: Record<string, unknown> = {};
  const file = paths.config();
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new ConfigError(`${file}: ${(e as Error).message}`);
    }
  }
  const cfg = parseConfig({ ...raw, ...stripUndefined(overrides) });
  if (process.env.MCAI_CLAUDE) cfg.claudePath = process.env.MCAI_CLAUDE;
  return cfg;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

export interface EngineInfoFile {
  port: number;
  token: string;
  pid: number;
  version: string;
}

export function readEngineInfo(): EngineInfoFile | null {
  try {
    return JSON.parse(fs.readFileSync(paths.engineJson(), 'utf8')) as EngineInfoFile;
  } catch {
    return null;
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
