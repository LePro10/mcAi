/**
 * The Minecraft client.
 *
 * Mineflayer gives us three things RCON cannot: player positions and look
 * direction, block reads (which is how undo snapshots are taken), and chat.
 * Commands still go over RCON — a bot typing `/fill` into chat gets kicked for
 * spam, which is what the demo ran into and then papered over with sleeps.
 */

import { EventEmitter } from 'node:events';
import mineflayer from 'mineflayer';
import vec3 from 'vec3';

import type { Vec3 as V3 } from '../core/types.js';
import { facingFromVector, type Cardinal } from '../core/geometry.js';
import type { SiteWorld, PlayerInfo } from './site.js';

export interface BotOptions {
  host?: string;
  port?: number;
  username?: string;
  auth?: 'offline' | 'microsoft';
  version?: string;
  /** Minimum ms between chat lines; servers kick above ~4 per second. */
  chatIntervalMs?: number;
}

export interface ChatCommand {
  player: string;
  command: string;
  args: string;
  raw: string;
}

/** Convert a mineflayer block into a spec string with its states preserved. */
export function blockToSpec(block: unknown): string {
  const b = block as { name?: string; getProperties?: () => Record<string, unknown> } | null;
  if (!b?.name) return 'air';
  let props: Record<string, unknown> = {};
  try { props = b.getProperties?.() ?? {}; } catch { props = {}; }
  const keys = Object.keys(props).sort();
  if (keys.length === 0) return b.name;
  // Undo has to restore stair facings and slab halves, so states travel with
  // the id rather than being dropped.
  const states = keys.map((k) => `${k}=${String(props[k])}`).join(',');
  return `${b.name}[${states}]`;
}

export class McBot extends EventEmitter implements SiteWorld {
  private bot: mineflayer.Bot | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoff = 2000;
  private chatQueue: string[] = [];
  private chatTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  readonly username: string;
  private readonly opts: Required<Pick<BotOptions, 'host' | 'port' | 'auth' | 'chatIntervalMs'>> & BotOptions;

  connected = false;
  spawnedAt = 0;

  constructor(opts: BotOptions = {}) {
    super();
    this.username = opts.username ?? 'mcAI';
    this.opts = {
      host: opts.host ?? '127.0.0.1',
      port: opts.port ?? 25565,
      auth: opts.auth ?? 'offline',
      chatIntervalMs: opts.chatIntervalMs ?? 350,
      version: opts.version,
      username: this.username,
    };
  }

  connect(): void {
    this.stopped = false;
    const bot = mineflayer.createBot({
      host: this.opts.host,
      port: this.opts.port,
      username: this.username,
      auth: this.opts.auth,
      version: this.opts.version,
      hideErrors: true,
    });
    this.bot = bot;

    bot.once('spawn', () => {
      this.connected = true;
      this.spawnedAt = Date.now();
      this.backoff = 2000;
      this.emit('spawn');
    });

    bot.on('chat', (username: string, message: string) => {
      if (username === this.username) return;
      const text = message.trim();
      if (!text.startsWith('!')) return;
      const space = text.indexOf(' ');
      const command = (space === -1 ? text.slice(1) : text.slice(1, space)).toLowerCase();
      const args = space === -1 ? '' : text.slice(space + 1).trim();
      this.emit('command', { player: username, command, args, raw: text } satisfies ChatCommand);
    });

    bot.on('kicked', (reason: unknown) => {
      this.connected = false;
      this.emit('disconnected', `kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`);
      this.scheduleReconnect();
    });

    bot.on('end', (reason: string) => {
      this.connected = false;
      this.emit('disconnected', reason);
      this.scheduleReconnect();
    });

    bot.on('error', (err: Error) => { this.emit('error', err); });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 60_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  // ── SiteWorld ───────────────────────────────────────────────────────────

  getBlock(x: number, y: number, z: number): string {
    if (!this.bot) return 'air';
    try {
      return blockToSpec(this.bot.blockAt(vec3([x, y, z])));
    } catch { return 'air'; }
  }

  /**
   * Highest non-air block in a column.
   *
   * Starts from the caller's hint rather than the world ceiling. Scanning from
   * y=320 every time, as the demo did, is 384 lookups per column — a 64×64
   * survey was over a million reads and visibly stalled the client.
   */
  highestY(x: number, z: number, from = 320): number {
    if (!this.bot) return 64;
    const start = Math.min(319, Math.max(-63, Math.round(from)));
    for (let y = start; y >= -64; y--) {
      const block = this.bot.blockAt(vec3([x, y, z]));
      if (!block) continue;
      const name = block.name;
      if (name && name !== 'air' && name !== 'cave_air' && name !== 'void_air') return y;
    }
    // Nothing below the hint: the column may rise above it (a hill, a tree).
    if (start < 319) {
      for (let y = 319; y > start; y--) {
        const block = this.bot.blockAt(vec3([x, y, z]));
        if (block && block.name !== 'air' && block.name !== 'cave_air' && block.name !== 'void_air') return y;
      }
    }
    return -64;
  }

  biomeAt(x: number, y: number, z: number): string {
    if (!this.bot) return 'unknown';
    try {
      // Read at the surface: the block under a player's feet is often stone,
      // whose biome entry is the cave one, which is how the demo ended up
      // reporting "unknown" for every build.
      const surface = this.highestY(x, z, y + 8);
      const block = this.bot.blockAt(vec3([x, surface, z]));
      const name = (block as unknown as { biome?: { name?: string } })?.biome?.name;
      return name ? name.replace(/^minecraft:/, '') : 'unknown';
    } catch { return 'unknown'; }
  }

  // ── Players ─────────────────────────────────────────────────────────────

  player(name: string): PlayerInfo | null {
    const entity = this.bot?.players?.[name]?.entity;
    if (!entity?.position) return null;
    return {
      name,
      position: [
        Math.round(entity.position.x),
        Math.round(entity.position.y),
        Math.round(entity.position.z),
      ],
      yaw: 0,
      facing: this.facingOf(entity.yaw),
    };
  }

  /**
   * Mineflayer's forward vector is `(-sin yaw, ., -cos yaw)`, so yaw 0 points
   * north — the opposite of the wire protocol. Deriving the facing from the
   * vector sidesteps the confusion entirely.
   */
  private facingOf(yaw: number): Cardinal {
    return facingFromVector(-Math.sin(yaw), -Math.cos(yaw));
  }

  onlinePlayers(): string[] {
    return Object.keys(this.bot?.players ?? {}).filter((n) => n !== this.username);
  }

  position(): V3 {
    const p = this.bot?.entity?.position;
    return p ? [Math.round(p.x), Math.round(p.y), Math.round(p.z)] : [0, 64, 0];
  }

  // ── Chat ────────────────────────────────────────────────────────────────

  /**
   * Queue a chat line. Rate limited, deduplicated against the previous line,
   * and truncated — the demo piped every line of model stdout into chat, which
   * buried the player in noise and got the bot kicked.
   */
  say(message: string): void {
    const clean = message.replace(/§[0-9a-fklmnor]/gi, '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    if (this.chatQueue.at(-1) === clean) return;
    if (this.chatQueue.length > 12) return;
    this.chatQueue.push(clean.slice(0, 240));
    this.drainChat();
  }

  private drainChat(): void {
    if (this.chatTimer) return;
    const step = () => {
      const next = this.chatQueue.shift();
      if (next === undefined) {
        if (this.chatTimer) clearInterval(this.chatTimer);
        this.chatTimer = null;
        return;
      }
      if (this.bot && this.connected) {
        try { this.bot.chat(next); } catch { /* the socket may have gone */ }
      }
    };
    step();
    if (this.chatQueue.length === 0) return;
    this.chatTimer = setInterval(step, this.opts.chatIntervalMs);
    if (this.chatTimer.unref) this.chatTimer.unref();
  }

  quit(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.chatTimer) clearInterval(this.chatTimer);
    this.chatQueue = [];
    try { this.bot?.quit(); } catch { /* ignore */ }
    this.bot = null;
    this.connected = false;
  }
}
