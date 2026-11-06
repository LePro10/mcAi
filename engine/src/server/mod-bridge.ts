// ModBackend: WorldBackend implemented over the /mod WebSocket (ARCHITECTURE §5).
// One active Minecraft server at a time; a newer connection replaces the older one.

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type {
  BiomeSample,
  BlockRegistry,
  BlockVolume,
  Box,
  Dimension,
  EditBatch,
  EntityInfo,
  HeightmapResult,
  PlayerInfo,
  PlayerNotification,
  SetBlocksOptions,
  SetBlocksResult,
  WorldBackend,
  WorldInfo,
} from '../core/types.ts';
import { Registry } from '../core/registry.ts';
import {
  b64encode,
  b64ToInt16,
  b64ToUint16,
  concatBatches,
  decodeBatch,
  type DimensionInfo,
  type HelloMsg,
  type JobUpdatePayload,
  normalizeBox,
  ProtocolError,
  splitBatch,
} from './protocol.ts';

export const OVERWORLD = 'minecraft:overworld';

export class ModError extends Error {}
export class NotConnectedError extends ModError {
  constructor() {
    super('Minecraft is not connected to the engine (no mod connection on /mod). Start Minecraft with the mcai mod, or run the engine with --sim.');
  }
}

interface Pending {
  type: string;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  ws: WebSocket;
}

export type ModRequestHandler = (msg: Record<string, any>) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

export interface ModBackendOptions {
  /** max blocks per set_blocks message (default 200 000) */
  maxSetBlocksPerMessage?: number;
  /** multiplier for all timeouts (tests use small values) */
  timeoutScale?: number;
  log?: (msg: string) => void;
}

export class ModBackend extends EventEmitter implements WorldBackend {
  readonly kind = 'minecraft' as const;
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private handlers = new Map<string, ModRequestHandler>();
  private helloMsg: HelloMsg | null = null;
  private reg: Registry | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private alive = true;
  private readonly maxPerMsg: number;
  private readonly tScale: number;
  private readonly log: (m: string) => void;
  connectedAt = 0;

  constructor(opts: ModBackendOptions = {}) {
    super();
    this.maxPerMsg = opts.maxSetBlocksPerMessage ?? 200_000;
    this.tScale = opts.timeoutScale ?? 1;
    this.log = opts.log ?? (() => {});
  }

  get connected(): boolean {
    return !!this.ws && this.ws.readyState === 1 && !!this.helloMsg;
  }

  get hello(): HelloMsg | null {
    return this.helloMsg;
  }

  /** Registry received in the mod's hello (null before the handshake). */
  get blockRegistry(): Registry | null {
    return this.reg;
  }

  /** Register a handler for a mod -> engine request/event type (build_request, job_control, ...). */
  onRequest(type: string, handler: ModRequestHandler): void {
    this.handlers.set(type, handler);
  }

  /** Attach a freshly accepted WebSocket. Replaces any previous connection. */
  attach(ws: WebSocket, remote = ''): void {
    if (this.ws && this.ws !== ws) {
      const old = this.ws;
      this.detach(old, 'replaced by a newer mod connection');
      try {
        old.close(4001, 'replaced by newer connection');
      } catch {}
    }
    this.ws = ws;
    this.helloMsg = null;
    this.alive = true;
    this.connectedAt = Date.now();
    this.log(`mod connected ${remote}`);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      this.onMessage(ws, data.toString());
    });
    ws.on('pong', () => {
      this.alive = true;
    });
    ws.on('close', () => this.detach(ws, 'mod connection closed'));
    ws.on('error', (e) => this.log(`mod socket error: ${e.message}`));
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.ws !== ws) return;
      if (!this.alive) {
        this.log('mod connection timed out (no pong)');
        ws.terminate();
        return;
      }
      this.alive = false;
      try {
        ws.ping();
      } catch {}
    }, 30_000);
    this.pingTimer.unref();
  }

  private detach(ws: WebSocket, reason: string): void {
    for (const [id, p] of this.pending) {
      if (p.ws !== ws) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new ModError(`${p.type}: ${reason}`));
    }
    if (this.ws === ws) {
      this.ws = null;
      this.helloMsg = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.log(`mod disconnected (${reason})`);
      this.emit('disconnect', reason);
    }
  }

  close(): void {
    if (this.ws) {
      const ws = this.ws;
      this.detach(ws, 'engine shutting down');
      try {
        ws.close(1001, 'engine shutting down');
      } catch {}
    }
  }

  /** Resolves when a mod has connected and said hello. */
  waitForConnection(timeoutMs = 0): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = timeoutMs > 0 ? setTimeout(() => {
        this.off('hello', h);
        reject(new NotConnectedError());
      }, timeoutMs) : null;
      const h = () => {
        if (t) clearTimeout(t);
        resolve();
      };
      this.once('hello', h);
    });
  }

  private send(ws: WebSocket, obj: unknown): void {
    ws.send(JSON.stringify(obj));
  }

  private onMessage(ws: WebSocket, text: string): void {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(text);
    } catch {
      this.log('mod sent invalid JSON');
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (typeof msg.re === 'string') {
      const p = this.pending.get(msg.re);
      if (!p) return; // late answer after timeout
      this.pending.delete(msg.re);
      clearTimeout(p.timer);
      // `command` answers {ok:false, output} for a failed command (not a transport error)
      if (msg.ok === false && !(p.type === 'command' && 'output' in msg)) p.reject(new ModError(`${p.type} failed in Minecraft: ${msg.error ?? 'unknown error'}`));
      else p.resolve(msg);
      return;
    }
    const type = msg.type;
    if (typeof type !== 'string') return;
    if (ws !== this.ws) return;
    if (type === 'hello') {
      try {
        this.handleHello(msg as HelloMsg);
        if (msg.id) this.send(ws, { re: msg.id, ok: true, engineVersion: '2.0.0' });
        this.emit('hello', this.helloMsg);
      } catch (e) {
        if (msg.id) this.send(ws, { re: msg.id, ok: false, error: (e as Error).message });
        this.log(`bad hello: ${(e as Error).message}`);
      }
      return;
    }
    const h = this.handlers.get(type);
    const reply = (ok: boolean, payload: Record<string, unknown>) => {
      if (msg.id && ws.readyState === 1) this.send(ws, { re: msg.id, ok, ...payload });
    };
    if (!h) {
      this.emit('event', msg);
      reply(false, { error: `unknown message type '${type}'` });
      return;
    }
    Promise.resolve()
      .then(() => h(msg))
      .then((r) => reply(true, r ?? {}))
      .catch((e: Error) => reply(false, { error: e.message }));
  }

  private handleHello(msg: HelloMsg): void {
    if (!msg.registry || typeof msg.registry !== 'object' || !msg.registry.blocks) {
      throw new ProtocolError('hello: registry missing');
    }
    this.reg = new Registry(msg.registry);
    this.helloMsg = msg;
    this.log(`mod hello: ${msg.modVersion ?? '?'} mc ${msg.mcVersion ?? '?'} world '${msg.world ?? '?'}' (${Object.keys(msg.registry.blocks).length} blocks)`);
  }

  /** Send a request to the mod and await its `re` response. */
  request<T = Record<string, any>>(type: string, payload: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1 || !this.helloMsg) return Promise.reject(new NotConnectedError());
    const id = randomUUID();
    const ms = Math.max(1, Math.round(timeoutMs * this.tScale));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ModError(`${type}: Minecraft did not answer within ${Math.round(ms / 1000)}s`));
      }, ms);
      this.pending.set(id, { type, resolve, reject, timer, ws });
      try {
        this.send(ws, { id, type, ...payload });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new ModError(`${type}: send failed: ${(e as Error).message}`));
      }
    });
  }

  private dimInfo(dim: string): DimensionInfo {
    const dims = this.helloMsg?.dimensions ?? [];
    for (const d of dims) {
      if (typeof d === 'object' && d && d.id === dim) return d;
    }
    if (dim === 'minecraft:the_nether') return { id: dim, minY: 0, maxY: 255, seaLevel: 32 };
    if (dim === 'minecraft:the_end') return { id: dim, minY: 0, maxY: 255, seaLevel: 0 };
    return { id: dim, minY: -64, maxY: 319, seaLevel: 63 };
  }

  // ---------------- WorldBackend ----------------

  async info(): Promise<WorldInfo> {
    if (!this.helloMsg) throw new NotConnectedError();
    const d = this.dimInfo(OVERWORLD);
    return {
      name: this.helloMsg.world ?? 'world',
      minY: d.minY,
      maxY: d.maxY,
      seaLevel: d.seaLevel ?? 63,
      mcVersion: this.helloMsg.mcVersion ?? '26.3',
      dimension: OVERWORLD,
    };
  }

  async registry(): Promise<BlockRegistry> {
    if (!this.helloMsg) throw new NotConnectedError();
    return this.helloMsg.registry;
  }

  async getBlocks(box: Box, dimension: Dimension = OVERWORLD): Promise<BlockVolume> {
    const b = normalizeBox(box);
    const vol = (b.max[0] - b.min[0] + 1) * (b.max[1] - b.min[1] + 1) * (b.max[2] - b.min[2] + 1);
    const r = await this.request<{ palette: string[]; data: string }>('get_blocks', { dimension, box: b }, 30_000 + vol / 20);
    const data = b64ToUint16(r.data, 'get_blocks.data');
    if (data.length !== vol) throw new ProtocolError(`get_blocks: expected ${vol} entries, got ${data.length}`);
    let palette = Array.isArray(r.palette) ? r.palette : [];
    if (palette[0] !== 'minecraft:air') {
      // contract: palette[0] is air — remap if the mod did not follow it
      const airIdx = palette.indexOf('minecraft:air');
      palette = ['minecraft:air', ...palette.filter((_, i) => i !== airIdx)];
      const remap = (r.palette ?? []).map((s) => palette.indexOf(s));
      for (let i = 0; i < data.length; i++) data[i] = remap[data[i]!] ?? 0;
    }
    return { box: b, palette, data };
  }

  async setBlocks(batch: EditBatch, opts: SetBlocksOptions = {}): Promise<SetBlocksResult> {
    const dimension = opts.dimension ?? OVERWORLD;
    const chunks = splitBatch(batch, this.maxPerMsg);
    let placed = 0;
    let unchanged = 0;
    const failed: SetBlocksResult['failed'] = [];
    const prev: EditBatch[] = [];
    let offset = 0;
    for (const c of chunks) {
      const n = c.states.length;
      const r = await this.request<{ placed: number; unchanged: number; failed?: { index: number; reason: string }[]; previous?: { palette: string[]; states: string } }>(
        'set_blocks',
        {
          dimension,
          palette: c.palette,
          positions: b64encode(c.positions),
          states: b64encode(c.states),
          updateShapes: opts.updateShapes ?? true,
          animate: opts.animate ?? 'none',
          ...(opts.maxPerTick ? { maxPerTick: opts.maxPerTick } : {}),
        },
        60_000 + n * 2,
      );
      placed += r.placed ?? 0;
      unchanged += r.unchanged ?? 0;
      for (const f of r.failed ?? []) failed.push({ index: f.index + offset, reason: f.reason });
      if (r.previous) prev.push(decodeBatch(r.previous, c.positions));
      else prev.push({ palette: ['minecraft:air'], positions: c.positions, states: new Uint16Array(n) });
      offset += n;
    }
    const previous = prev.length ? concatBatches(prev) : { palette: [], positions: new Int32Array(0), states: new Uint16Array(0) };
    return { placed, unchanged, failed, previous };
  }

  async heightmap(x0: number, z0: number, x1: number, z1: number, kind: 'surface' | 'ocean_floor' = 'surface', dimension: Dimension = OVERWORLD): Promise<HeightmapResult> {
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1), az = Math.min(z0, z1), bz = Math.max(z0, z1);
    const n = (bx - ax + 1) * (bz - az + 1);
    const r = await this.request<{ data: string }>('heightmap', { dimension, x0: ax, z0: az, x1: bx, z1: bz, kind }, 30_000 + n / 50);
    const data = b64ToInt16(r.data, 'heightmap.data');
    if (data.length !== n) throw new ProtocolError(`heightmap: expected ${n} values, got ${data.length}`);
    return { x0: ax, z0: az, x1: bx, z1: bz, data };
  }

  async biomes(box: Box, step: number, dimension: Dimension = OVERWORLD): Promise<BiomeSample> {
    const r = await this.request<{ palette: string[]; data: string; step?: number }>('biomes', { dimension, box: normalizeBox(box), step }, 30_000);
    return { palette: r.palette ?? [], data: b64ToUint16(r.data, 'biomes.data'), step: r.step ?? step };
  }

  async entities(box: Box, dimension: Dimension = OVERWORLD): Promise<EntityInfo[]> {
    const r = await this.request<{ entities: EntityInfo[] }>('entities', { dimension, box: normalizeBox(box) }, 20_000);
    return r.entities ?? [];
  }

  async players(): Promise<PlayerInfo[]> {
    const r = await this.request<{ players: PlayerInfo[] }>('players', {}, 10_000);
    return r.players ?? [];
  }

  async runCommand(cmd: string, opts: { as?: string } = {}): Promise<{ ok: boolean; output: string }> {
    const r = await this.request<{ ok?: boolean; output?: string; result?: { ok: boolean; output: string } }>('command', { command: cmd, ...(opts.as ? { as: opts.as } : {}) }, 30_000);
    // response has the outer ok:true (transport) plus the command result
    const res = r.result ?? r;
    return { ok: res.ok !== false, output: String(res.output ?? '') };
  }

  async notify(n: PlayerNotification): Promise<void> {
    this.emit('notify', n);
    if (!this.connected) return;
    await this.request('notify', { ...n }, 10_000);
  }

  /** Push a job status to the mod (boss bar / action bar). Never throws. */
  async jobUpdate(u: JobUpdatePayload): Promise<void> {
    if (!this.connected) return;
    try {
      await this.request('job_update', { ...u }, 10_000);
    } catch (e) {
      this.log(`job_update failed: ${(e as Error).message}`);
    }
  }
}
