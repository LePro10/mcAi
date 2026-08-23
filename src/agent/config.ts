/**
 * Where the model configuration lives.
 *
 * Environment variables are fine for servers and awful for people: nobody
 * wants to re-export a key every time they open a terminal, and telling
 * someone to edit their shell profile before they can try a thing is how you
 * lose them. So the choice is saved to a file, and the environment still wins
 * when it is set — which keeps Docker and CI working without a config file.
 *
 * The key is written with owner-only permissions and never leaves this machine
 * except in a request to the provider you picked.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PROVIDERS, getProvider, needsKey, normalizeBaseUrl, type ProviderDef } from './providers.js';
import type { LlmConfig } from './llm.js';

export interface StoredConfig {
  provider: string;
  model: string;
  apiKey?: string;
  /** Only for `custom`, or to override a provider's default. */
  baseUrl?: string;
  updatedAt?: string;
}

/** Where the config file lives. `MCAI_HOME` overrides it. */
export function configDir(env = process.env): string {
  if (env.MCAI_HOME) return path.resolve(env.MCAI_HOME);
  return path.join(os.homedir(), '.mcai');
}

export function configPath(env = process.env): string {
  return path.join(configDir(env), 'config.json');
}

export function readStored(env = process.env): StoredConfig | null {
  const file = configPath(env);
  try {
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredConfig;
    if (!data || typeof data.provider !== 'string') return null;
    return data;
  } catch {
    return null;
  }
}

export function writeStored(cfg: StoredConfig, env = process.env): string {
  const dir = configDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = configPath(env);
  const body = JSON.stringify({ ...cfg, updatedAt: new Date().toISOString() }, null, 2);
  // Write with owner-only permissions from the start, rather than creating a
  // world-readable file holding an API key and tightening it afterwards.
  fs.writeFileSync(file, `${body}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* not all filesystems support it */ }
  return file;
}

export function clearStored(env = process.env): boolean {
  const file = configPath(env);
  try {
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

export interface ResolvedConfig extends LlmConfig {
  providerId: string;
  providerName: string;
  /** Where this configuration came from, for the UI to explain itself. */
  source: 'env' | 'file' | 'explicit';
}

function build(p: ProviderDef, model: string, apiKey: string, baseUrl: string, source: ResolvedConfig['source']): ResolvedConfig {
  return {
    providerId: p.id,
    providerName: p.name,
    provider: p.wire,
    model: model || p.defaultModel,
    apiKey: apiKey || 'not-needed',
    baseUrl: normalizeBaseUrl(baseUrl || p.baseUrl),
    source,
  };
}

/**
 * Resolve the active configuration.
 *
 * Precedence, highest first:
 *   1. `MCAI_PROVIDER` and friends — an explicit override
 *   2. a provider-specific key in the environment (`ANTHROPIC_API_KEY`, ...)
 *   3. the saved config file
 *
 * Returns null when nothing is configured, which is a supported state: the
 * library structures still build.
 */
export function resolveConfig(env = process.env): ResolvedConfig | null {
  // 1. Explicit override.
  if (env.MCAI_PROVIDER) {
    const p = getProvider(env.MCAI_PROVIDER)
      // An unknown name still works if it is really a wire format plus a URL.
      ?? (env.MCAI_BASE_URL ? getProvider('custom') : undefined);
    if (p) {
      const wire = env.MCAI_PROVIDER.toLowerCase() === 'anthropic' ? 'anthropic' : p.wire;
      return {
        ...build(p, env.MCAI_MODEL ?? '', env.MCAI_API_KEY ?? '', env.MCAI_BASE_URL ?? '', 'explicit'),
        provider: wire,
      };
    }
  }

  // 2. A vendor key already in the environment.
  for (const p of PROVIDERS) {
    for (const key of p.envKeys) {
      const value = env[key];
      if (!value) continue;
      // OLLAMA_HOST and LMSTUDIO_HOST are addresses, not keys.
      const isAddress = /^https?:\/\//.test(value);
      return build(
        p,
        env.MCAI_MODEL ?? '',
        isAddress ? '' : value,
        isAddress ? value : (env.MCAI_BASE_URL ?? ''),
        'env',
      );
    }
  }

  // 3. The saved file.
  const stored = readStored(env);
  if (stored) {
    const p = getProvider(stored.provider);
    if (p) return build(p, stored.model, stored.apiKey ?? '', stored.baseUrl ?? '', 'file');
  }

  return null;
}

/** Everything the dashboard needs to describe the current setup, minus the key. */
export function describeConfig(env = process.env) {
  const c = resolveConfig(env);
  if (!c) return { configured: false as const };
  return {
    configured: true as const,
    provider: c.providerId,
    providerName: c.providerName,
    model: c.model,
    baseUrl: c.baseUrl,
    source: c.source,
    keyMasked: maskKey(c.apiKey),
    local: getProvider(c.providerId)?.local ?? false,
  };
}

/** Never return a key to a caller; return enough to recognise which one it is. */
export function maskKey(key: string): string {
  if (!key || key === 'not-needed') return '';
  if (key.length <= 10) return '••••';
  return `${key.slice(0, 6)}••••${key.slice(-4)}`;
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
  /** Round-trip time of the test call. */
  ms?: number;
  /** Model the provider actually answered with, when it says. */
  model?: string;
}

/**
 * Send the smallest possible real request, so "Test" means the key works,
 * the model exists and the endpoint is reachable — not just that the URL parses.
 */
export async function testConfig(cfg: LlmConfig, timeoutMs = 20_000): Promise<ValidationResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const isAnthropic = cfg.provider === 'anthropic';
  const url = isAnthropic
    ? `${normalizeBaseUrl(cfg.baseUrl)}/v1/messages`
    : `${normalizeBaseUrl(cfg.baseUrl)}/v1/chat/completions`;

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (isAnthropic) {
    headers['x-api-key'] = cfg.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers.authorization = `Bearer ${cfg.apiKey}`;
  }

  const body = isAnthropic
    ? { model: cfg.model, max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }
    : { model: cfg.model, max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] };

  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    clearTimeout(timer);
    const ms = Date.now() - started;

    if (res.ok) {
      const json = await res.json().catch(() => ({}));
      return { ok: true, ms, model: (json as { model?: string }).model ?? cfg.model };
    }

    const text = await res.text().catch(() => '');
    return { ok: false, ms, error: explainHttp(res.status, text, cfg) };
  } catch (err) {
    clearTimeout(timer);
    const e = err as Error;
    if (e.name === 'AbortError') {
      return { ok: false, error: `No response within ${Math.round(timeoutMs / 1000)}s. Is the endpoint reachable?` };
    }
    return { ok: false, error: `Could not reach ${cfg.baseUrl} — ${e.message}` };
  }
}

/** Turn a provider's error into something a person can act on. */
function explainHttp(status: number, text: string, cfg: LlmConfig): string {
  const detail = extractMessage(text);
  switch (status) {
    case 401: case 403:
      return `The key was rejected (${status}). Check you pasted the whole key and that it is for ${cfg.baseUrl}.`;
    case 404:
      return `No such model "${cfg.model}" at this endpoint (404). Pick a different model.${detail ? ` — ${detail}` : ''}`;
    case 429:
      return `Rate limited or out of credit (429).${detail ? ` — ${detail}` : ''}`;
    case 400:
      return `The provider rejected the request (400).${detail ? ` — ${detail}` : ' Usually a model name that does not exist.'}`;
    default:
      return `Provider returned ${status}.${detail ? ` — ${detail}` : ''}`;
  }
}

function extractMessage(text: string): string {
  try {
    const json = JSON.parse(text);
    const msg = json?.error?.message ?? json?.message ?? json?.error;
    if (typeof msg === 'string') return msg.slice(0, 200);
  } catch { /* not JSON */ }
  return text.replace(/\s+/g, ' ').trim().slice(0, 160);
}
