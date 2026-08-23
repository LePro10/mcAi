/**
 * A stand-in for the server plugin, backed by the simulated world.
 *
 * The plugin itself is Java and needs a running Minecraft server, which no
 * test can assume. This implements the same HTTP contract over `SimWorld`, so
 * the bridge — the part that has to be right — is exercised end to end: token
 * checks, batch execution, heightmaps, region snapshots, player lookup.
 *
 * It is also the reference for the protocol. If the Java side and this
 * disagree, this is the one the tests hold to.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { isAir } from '../core/blocks.js';
import type { SimWorld } from './world.js';

export interface SimPluginOptions {
  token?: string;
  /** Artificial delay per batch, to make the batching win measurable. */
  latencyMs?: number;
  /** Commands the plugin will run in one request. */
  maxBatch?: number;
  player?: { name: string; position: [number, number, number]; yaw: number };
}

export class SimPluginServer {
  private server: http.Server;
  readonly token: string;
  private readonly latencyMs: number;
  private readonly maxBatch: number;
  port = 0;

  player: { name: string; position: [number, number, number]; yaw: number };
  chat: Array<{ message: string; player?: string }> = [];
  /** Batch sizes seen, so tests can assert commands really were batched. */
  batches: number[] = [];

  constructor(private readonly world: SimWorld, opts: SimPluginOptions = {}) {
    this.token = opts.token ?? 'sim-token';
    this.latencyMs = opts.latencyMs ?? 0;
    this.maxBatch = opts.maxBatch ?? 20_000;
    this.player = opts.player ?? { name: 'Steve', position: [0, 65, 0], yaw: 0 };
    this.server = http.createServer((req, res) => { void this.handle(req, res); });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.headers['x-mcai-token'] !== this.token) return send(401, { error: 'bad token' });
    if (this.latencyMs) await sleep(this.latencyMs);

    try {
      if (url.pathname === '/info') {
        return send(200, {
          ok: true, plugin: 'sim', minecraft: '1.21.4',
          world: 'world', players: [this.player.name],
        });
      }

      if (url.pathname === '/exec' && req.method === 'POST') {
        const { commands } = JSON.parse(await body(req)) as { commands: string[] };
        if (!Array.isArray(commands)) return send(400, { error: 'commands must be an array' });
        if (commands.length > this.maxBatch) return send(413, { error: 'batch too large' });
        this.batches.push(commands.length);
        const results = commands.map((c) => {
          const r = this.world.execute(c);
          return { ok: r.ok || !!r.noop, affected: r.affected, message: r.message };
        });
        return send(200, { results });
      }

      if (url.pathname === '/heightmap') {
        const n = (k: string) => Number(url.searchParams.get(k));
        const [x1, z1, x2, z2] = [n('x1'), n('z1'), n('x2'), n('z2')];
        if (![x1, z1, x2, z2].every(Number.isFinite)) return send(400, { error: 'bad bounds' });
        const heights: number[] = [];
        const biomes: string[] = [];
        let min = Infinity, max = -Infinity, total = 0;
        for (let z = z1; z <= z2; z++)
          for (let x = x1; x <= x2; x++) {
            const y = this.world.highestY(x, z);
            heights.push(y);
            biomes.push('plains');
            if (y < min) min = y;
            if (y > max) max = y;
            total += y;
          }
        return send(200, {
          heights, biomes, min, max,
          avg: Math.round(total / (heights.length || 1)),
        });
      }

      if (url.pathname === '/region' && req.method === 'POST') {
        const { min, max } = JSON.parse(await body(req)) as { min: number[]; max: number[] };
        const palette: string[] = [];
        const index = new Map<string, number>();
        const data: number[] = [];
        for (let y = min[1]; y <= max[1]; y++)
          for (let z = min[2]; z <= max[2]; z++)
            for (let x = min[0]; x <= max[0]; x++) {
              const spec = this.world.getBlock(x, y, z);
              let i = index.get(spec);
              if (i === undefined) { i = palette.length; palette.push(spec); index.set(spec, i); }
              data.push(i);
            }
        return send(200, { palette, data });
      }

      const playerMatch = /^\/player\/(.+)$/.exec(url.pathname);
      if (playerMatch) {
        const name = decodeURIComponent(playerMatch[1]);
        if (name !== this.player.name) return send(200, { found: false });
        return send(200, {
          found: true, name, position: this.player.position, yaw: this.player.yaw, world: 'world',
        });
      }

      if (url.pathname === '/say' && req.method === 'POST') {
        this.chat.push(JSON.parse(await body(req)));
        return send(200, { ok: true });
      }

      return send(404, { error: 'unknown endpoint' });
    } catch (err) {
      return send(500, { error: (err as Error).message });
    }
  }

  listen(port = 0): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(port, '127.0.0.1', () => {
        this.port = (this.server.address() as AddressInfo).port;
        resolve(this.port);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

function body(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data || '{}'));
    req.on('error', reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export { isAir };
