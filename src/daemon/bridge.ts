/**
 * The plugin bridge.
 *
 * When mcAI runs behind the server plugin, this replaces both RCON and the
 * mineflayer bot. That removes the three worst parts of the setup — editing
 * `server.properties`, inventing an RCON password, and running the server in
 * offline mode so a bot account can join — and it is *faster*, because the
 * plugin exposes batch operations that neither RCON nor a client can offer:
 *
 *   - one request carries a whole build's commands, executed server-side in a
 *     single pass instead of one round trip per `/fill`
 *   - one request returns a whole terrain heightmap, read straight from the
 *     server's own heightmap instead of scanning columns block by block
 *   - one request returns a whole region for the undo snapshot
 *
 * Both ends are on loopback and share a token the plugin generates.
 */

import type { Vec3 } from '../core/types.js';
import type { CommandRunner } from './executor.js';
import type { PlayerInfo, SiteWorld } from './site.js';
import { facingFromVector, type Cardinal } from '../core/geometry.js';

export interface BridgeOptions {
  url?: string;
  token?: string;
  /** Per-request timeout. Batches get a longer allowance. */
  timeoutMs?: number;
}

export interface ServerInfo {
  ok: boolean;
  plugin?: string;
  minecraft?: string;
  world?: string;
  players?: string[];
  error?: string;
}

export interface ExecResult {
  ok: boolean;
  affected: number;
  message: string;
}

export class BridgeError extends Error {}

/**
 * Talks to the plugin. Implements the same two interfaces the RCON path does,
 * so the executor and the site analyser cannot tell the difference.
 */
export class PluginBridge implements SiteWorld, CommandRunner {
  readonly url: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  /** Filled by `refresh()`; the site analyser reads blocks synchronously. */
  private heightCache = new Map<string, number>();
  private blockCache = new Map<string, string>();
  private biomeCache = new Map<string, string>();

  connected = false;
  info: ServerInfo = { ok: false };
  stats = { requests: 0, commands: 0, failures: 0, totalMs: 0 };

  constructor(opts: BridgeOptions = {}) {
    this.url = (opts.url ?? process.env.MCAI_BRIDGE_URL ?? 'http://127.0.0.1:8766').replace(/\/+$/, '');
    this.token = opts.token ?? process.env.MCAI_BRIDGE_TOKEN ?? '';
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  private async call<T>(path: string, method: 'GET' | 'POST', body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      const res = await fetch(`${this.url}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { 'x-mcai-token': this.token } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      this.stats.requests++;
      this.stats.totalMs += Date.now() - started;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new BridgeError(
          res.status === 401
            ? 'The plugin rejected our token. Restart the server, or copy the token from plugins/mcAI/config.yml.'
            : `Plugin returned ${res.status}: ${text.slice(0, 200)}`,
        );
      }
      return (await res.json()) as T;
    } catch (err) {
      this.stats.failures++;
      if (err instanceof BridgeError) throw err;
      const e = err as Error;
      if (e.name === 'AbortError') throw new BridgeError(`The plugin did not answer within ${timeoutMs}ms.`);
      throw new BridgeError(
        `Cannot reach the mcAI plugin at ${this.url} — ${e.message}. ` +
        'Is the server running with the plugin installed?',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async connect(): Promise<ServerInfo> {
    try {
      this.info = await this.call<ServerInfo>('/info', 'GET', undefined, 8000);
      this.connected = this.info.ok !== false;
      return this.info;
    } catch (err) {
      this.connected = false;
      this.info = { ok: false, error: (err as Error).message };
      return this.info;
    }
  }

  // ── CommandRunner ───────────────────────────────────────────────────────

  async send(command: string): Promise<string> {
    const [result] = await this.exec([command]);
    return result?.message ?? '';
  }

  /**
   * Run many commands in one request.
   *
   * This is the reason the bridge is faster than RCON: 2,000 fills become one
   * HTTP call the server executes in a tight loop, rather than 2,000 protocol
   * round trips each waiting on a server tick.
   */
  async exec(commands: string[]): Promise<ExecResult[]> {
    if (commands.length === 0) return [];
    this.stats.commands += commands.length;
    const { results } = await this.call<{ results: ExecResult[] }>(
      '/exec', 'POST', { commands },
      // Allow generously for a big batch; the plugin caps its own work per tick.
      Math.max(this.timeoutMs, commands.length * 20),
    );
    return results ?? [];
  }

  // ── SiteWorld ───────────────────────────────────────────────────────────

  getBlock(x: number, y: number, z: number): string {
    return this.blockCache.get(`${x},${y},${z}`) ?? 'air';
  }

  highestY(x: number, z: number): number {
    const h = this.heightCache.get(`${x},${z}`);
    return h === undefined ? 64 : h;
  }

  biomeAt(x: number, _y: number, z: number): string {
    return this.biomeCache.get(`${x},${z}`) ?? 'plains';
  }

  /**
   * Load a heightmap for a square around a point.
   *
   * `SiteWorld` is synchronous because the compiler is; the network is not. So
   * the caller pre-loads the area it is about to analyse, and the synchronous
   * reads afterwards hit the cache. One request instead of thousands.
   */
  async loadHeights(centre: Vec3, radius: number): Promise<{ min: number; max: number; avg: number }> {
    const x1 = centre[0] - radius, x2 = centre[0] + radius;
    const z1 = centre[2] - radius, z2 = centre[2] + radius;
    const data = await this.call<{ heights: number[]; biomes?: string[]; min: number; max: number; avg: number }>(
      `/heightmap?x1=${x1}&z1=${z1}&x2=${x2}&z2=${z2}`, 'GET',
    );
    const width = x2 - x1 + 1;
    for (let i = 0; i < data.heights.length; i++) {
      const x = x1 + (i % width);
      const z = z1 + Math.floor(i / width);
      this.heightCache.set(`${x},${z}`, data.heights[i]);
      if (data.biomes?.[i]) this.biomeCache.set(`${x},${z}`, data.biomes[i]);
    }
    return { min: data.min, max: data.max, avg: data.avg };
  }

  /** Load every block in a region, for the survey and the undo snapshot. */
  async loadRegion(min: Vec3, max: Vec3): Promise<number> {
    const data = await this.call<{ palette: string[]; data: number[] }>(
      '/region', 'POST', { min, max },
    );
    let i = 0;
    for (let y = min[1]; y <= max[1]; y++)
      for (let z = min[2]; z <= max[2]; z++)
        for (let x = min[0]; x <= max[0]; x++) {
          const spec = data.palette[data.data[i++]] ?? 'air';
          this.blockCache.set(`${x},${y},${z}`, spec);
        }
    return i;
  }

  /** Drop cached world data. Called between builds so it cannot go stale. */
  clearCache(): void {
    this.heightCache.clear();
    this.blockCache.clear();
    this.biomeCache.clear();
  }

  get cacheSize(): number {
    return this.heightCache.size + this.blockCache.size;
  }

  // ── Players and chat ────────────────────────────────────────────────────

  async player(name: string): Promise<PlayerInfo | null> {
    try {
      const p = await this.call<{ found: boolean; position: Vec3; yaw: number; name: string }>(
        `/player/${encodeURIComponent(name)}`, 'GET', undefined, 8000,
      );
      if (!p.found) return null;
      return {
        name: p.name,
        position: p.position,
        yaw: p.yaw,
        facing: facingFromMinecraftYaw(p.yaw),
      };
    } catch {
      return null;
    }
  }

  async say(message: string, player?: string): Promise<void> {
    try { await this.call('/say', 'POST', { message, player }, 8000); } catch { /* chat is best effort */ }
  }

  async players(): Promise<string[]> {
    try {
      const info = await this.call<ServerInfo>('/info', 'GET', undefined, 8000);
      this.info = info;
      return info.players ?? [];
    } catch { return []; }
  }

  get avgLatencyMs(): number {
    return this.stats.requests ? +(this.stats.totalMs / this.stats.requests).toFixed(1) : 0;
  }
}

/**
 * Bukkit reports the player's yaw in the wire protocol's convention: 0 points
 * south (+Z) and it increases clockwise. Deriving the look vector from it
 * keeps this in one place, away from mineflayer's opposite convention.
 */
export function facingFromMinecraftYaw(yaw: number): Cardinal {
  const rad = (yaw * Math.PI) / 180;
  return facingFromVector(-Math.sin(rad), Math.cos(rad));
}
