/**
 * RCON client.
 *
 * The demo's client sent one command and waited for its reply before sending
 * the next. At ~1 ms of network plus a server tick per round trip, a 1,300
 * command castle spent most of its wall-clock time idle. This client pipelines:
 * it keeps a window of commands in flight and matches replies by packet id,
 * which is what the protocol was designed for.
 *
 * Protocol: little-endian [int32 length][int32 id][int32 type][body\0][\0].
 * Auth is type 3, answered by a type 2 packet whose id echoes the request on
 * success and is −1 on failure. Command is type 2, answered by type 0.
 */

import net from 'node:net';
import { EventEmitter } from 'node:events';

export interface RconOptions {
  host?: string;
  port?: number;
  password: string;
  /** Commands allowed in flight at once. */
  window?: number;
  /** Per-command timeout in ms. */
  timeout?: number;
  /** Give up on a reply this long after the last fragment with the same id. */
  idleFlushMs?: number;
  connectTimeout?: number;
}

const TYPE_AUTH = 3;
const TYPE_COMMAND = 2;
const TYPE_AUTH_RESPONSE = 2;
const TYPE_RESPONSE = 0;

interface Pending {
  id: number;
  command: string;
  resolve(value: string): void;
  reject(err: Error): void;
  chunks: string[];
  timer: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
  sentAt: number;
}

export class RconError extends Error {}

export class RconClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private queue: Array<{ command: string; resolve(v: string): void; reject(e: Error): void }> = [];
  private authResolve: (() => void) | null = null;
  private authReject: ((e: Error) => void) | null = null;
  private connectPromise: Promise<void> | null = null;
  private closed = false;

  readonly host: string;
  readonly port: number;
  private readonly password: string;
  private readonly window: number;
  private readonly timeout: number;
  private readonly idleFlushMs: number;
  private readonly connectTimeout: number;

  /** Observability for the dashboard: how the transport is behaving. */
  stats = { sent: 0, received: 0, failed: 0, reconnects: 0, totalLatencyMs: 0 };

  constructor(opts: RconOptions) {
    super();
    this.host = opts.host ?? '127.0.0.1';
    this.port = opts.port ?? 25575;
    this.password = opts.password;
    this.window = Math.max(1, opts.window ?? 24);
    this.timeout = opts.timeout ?? 15_000;
    this.idleFlushMs = opts.idleFlushMs ?? 25;
    this.connectTimeout = opts.connectTimeout ?? 8_000;
  }

  get connected(): boolean { return this.socket !== null && this.authResolve === null && this.socket.writable; }
  get inFlight(): number { return this.pending.size; }
  get queued(): number { return this.queue.length; }
  get avgLatencyMs(): number {
    return this.stats.received ? +(this.stats.totalLatencyMs / this.stats.received).toFixed(1) : 0;
  }

  async connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.doConnect().finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.closed = false;
      this.buffer = Buffer.alloc(0);
      const socket = new net.Socket();
      this.socket = socket;
      socket.setNoDelay(true);

      const fail = (err: Error) => {
        socket.removeAllListeners();
        socket.destroy();
        if (this.socket === socket) this.socket = null;
        reject(err);
      };

      const connectTimer = setTimeout(
        () => fail(new RconError(`RCON connect to ${this.host}:${this.port} timed out`)),
        this.connectTimeout,
      );

      socket.once('error', (err) => { clearTimeout(connectTimer); fail(err); });

      socket.connect(this.port, this.host, () => {
        clearTimeout(connectTimer);
        socket.removeAllListeners('error');

        socket.on('data', (data) => this.onData(data));
        socket.on('error', (err) => this.onSocketClosed(err));
        socket.on('close', () => this.onSocketClosed(new RconError('RCON connection closed')));

        // Authenticate before anything else may be written.
        const authId = this.nextId++;
        this.authResolve = () => {
          this.authResolve = null;
          this.authReject = null;
          this.emit('ready');
          this.pump();
          resolve();
        };
        this.authReject = (err) => {
          this.authResolve = null;
          this.authReject = null;
          fail(err);
        };
        socket.write(encode(authId, TYPE_AUTH, this.password));
      });
    });
  }

  private onSocketClosed(err: Error): void {
    if (this.socket) { this.socket.removeAllListeners(); this.socket.destroy(); }
    this.socket = null;
    if (this.authReject) { this.authReject(err); return; }

    // Fail everything in flight; the caller decides whether to retry.
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      if (p.idleTimer) clearTimeout(p.idleTimer);
      this.stats.failed++;
      p.reject(new RconError(`${err.message} (while running: ${p.command})`));
    }
    this.pending.clear();
    for (const q of this.queue) q.reject(new RconError(err.message));
    this.queue = [];

    if (!this.closed) this.emit('disconnected', err);
  }

  private onData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);

    while (this.buffer.length >= 12) {
      const length = this.buffer.readInt32LE(0);
      if (length < 10 || length > 8 * 1024 * 1024) {
        // Desynchronised stream: nothing safe to do but reconnect.
        this.onSocketClosed(new RconError('RCON stream desynchronised'));
        return;
      }
      if (this.buffer.length < 4 + length) break;

      const id = this.buffer.readInt32LE(4);
      const type = this.buffer.readInt32LE(8);
      const body = this.buffer.subarray(12, 4 + length - 2).toString('utf8');
      this.buffer = this.buffer.subarray(4 + length);

      this.onPacket(id, type, body);
    }
  }

  private onPacket(id: number, type: number, body: string): void {
    if (this.authResolve || this.authReject) {
      if (type === TYPE_AUTH_RESPONSE) {
        if (id === -1) this.authReject?.(new RconError('RCON authentication failed — check rcon.password'));
        else this.authResolve?.();
      }
      // Servers send an empty type-0 packet before the auth response; ignore it.
      return;
    }

    if (type !== TYPE_RESPONSE) return;

    const p = this.pending.get(id);
    if (!p) return;

    p.chunks.push(body);

    // Replies arrive in order, so any higher id proves the earlier ones are
    // complete. That closes pipelined commands with no extra latency.
    for (const [otherId, other] of this.pending) {
      if (otherId < id) this.settle(other);
    }

    if (p.idleTimer) clearTimeout(p.idleTimer);
    p.idleTimer = setTimeout(() => this.settle(p), this.idleFlushMs);
    if (p.idleTimer.unref) p.idleTimer.unref();
  }

  private settle(p: Pending): void {
    if (!this.pending.has(p.id)) return;
    this.pending.delete(p.id);
    if (p.timer) clearTimeout(p.timer);
    if (p.idleTimer) clearTimeout(p.idleTimer);
    this.stats.received++;
    this.stats.totalLatencyMs += Date.now() - p.sentAt;
    p.resolve(p.chunks.join(''));
    this.pump();
  }

  /** Move queued commands into the in-flight window. */
  private pump(): void {
    while (this.queue.length > 0 && this.pending.size < this.window) {
      const socket = this.socket;
      if (!socket || !socket.writable || this.authResolve) return;
      const item = this.queue.shift()!;
      const id = this.nextId++;
      const p: Pending = {
        id, command: item.command, resolve: item.resolve, reject: item.reject,
        chunks: [], timer: null, idleTimer: null, sentAt: Date.now(),
      };
      p.timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        if (p.idleTimer) clearTimeout(p.idleTimer);
        this.stats.failed++;
        p.reject(new RconError(`RCON timeout after ${this.timeout}ms: ${item.command}`));
        this.pump();
      }, this.timeout);
      if (p.timer.unref) p.timer.unref();

      this.pending.set(id, p);
      this.stats.sent++;
      socket.write(encode(id, TYPE_COMMAND, item.command));
    }
  }

  /**
   * Run one command. Resolves with the server's reply text.
   * Commands submitted while disconnected are rejected rather than queued
   * forever — the executor decides how to retry, not the transport.
   */
  send(command: string): Promise<string> {
    const cmd = command.startsWith('/') ? command.slice(1) : command;
    if (!this.socket || !this.socket.writable) {
      return Promise.reject(new RconError('RCON is not connected'));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ command: cmd, resolve, reject });
      this.pump();
    });
  }

  /** Run many commands with the pipeline kept full. Preserves order. */
  async sendAll(commands: string[]): Promise<string[]> {
    return Promise.all(commands.map((c) => this.send(c)));
  }

  close(): void {
    this.closed = true;
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      if (p.idleTimer) clearTimeout(p.idleTimer);
    }
    this.pending.clear();
    this.queue = [];
    if (this.socket) { this.socket.removeAllListeners(); this.socket.destroy(); this.socket = null; }
  }
}

export function encode(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + payload.length);
  buf.writeInt32LE(10 + payload.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  buf.writeUInt8(0, 12 + payload.length);
  buf.writeUInt8(0, 13 + payload.length);
  return buf;
}

/**
 * Reconnecting wrapper. Keeps trying with exponential backoff so a server
 * restart does not take the daemon down with it.
 */
export class ResilientRcon {
  private client: RconClient;
  private backoff = 1000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  readonly events = new EventEmitter();

  constructor(private readonly opts: RconOptions) {
    this.client = new RconClient(opts);
    this.wire();
  }

  private wire(): void {
    this.client.on('disconnected', (err: Error) => {
      this.events.emit('disconnected', err);
      this.scheduleReconnect();
    });
    this.client.on('ready', () => {
      this.backoff = 1000;
      this.events.emit('ready');
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30_000);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      try {
        this.client.removeAllListeners();
        this.client = new RconClient(this.opts);
        this.wire();
        this.client.stats.reconnects++;
        await this.client.connect();
      } catch (err) {
        this.events.emit('reconnect_failed', err);
        this.scheduleReconnect();
      }
    }, delay);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  async connect(): Promise<void> {
    this.stopped = false;
    try {
      await this.client.connect();
    } catch (err) {
      this.scheduleReconnect();
      throw err;
    }
  }

  get connected(): boolean { return this.client.connected; }
  get stats() { return this.client.stats; }
  get avgLatencyMs(): number { return this.client.avgLatencyMs; }
  get inFlight(): number { return this.client.inFlight; }

  send(command: string): Promise<string> { return this.client.send(command); }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.client.close();
  }
}
