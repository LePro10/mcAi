/**
 * A minimal RCON server backed by `SimWorld`.
 *
 * With this, `RconClient` can be tested against a real socket speaking the real
 * protocol — auth failures, pipelining, fragmentation and all — instead of a
 * mock that agrees with whatever the client happens to do.
 */

import net from 'node:net';
import { encode } from '../daemon/rcon.js';
import type { SimWorld } from './world.js';

export interface SimRconOptions {
  password?: string;
  /** Artificial per-command latency, to make pipelining measurable. */
  latencyMs?: number;
  /** Split replies larger than this, exercising multi-packet handling. */
  fragmentAt?: number;
  host?: string;
}

export class SimRconServer {
  private server: net.Server;
  private sockets = new Set<net.Socket>();
  readonly password: string;
  private readonly latencyMs: number;
  private readonly fragmentAt: number;
  private readonly host: string;
  port = 0;

  constructor(private readonly world: SimWorld, opts: SimRconOptions = {}) {
    this.password = opts.password ?? 'test';
    this.latencyMs = opts.latencyMs ?? 0;
    this.fragmentAt = opts.fragmentAt ?? 4096;
    this.host = opts.host ?? '127.0.0.1';
    this.server = net.createServer((socket) => this.onConnection(socket));
  }

  private onConnection(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.setNoDelay(true);
    let authed = false;
    let buffer = Buffer.alloc(0);

    socket.on('error', () => {});
    socket.on('close', () => this.sockets.delete(socket));

    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 12) {
        const length = buffer.readInt32LE(0);
        if (buffer.length < 4 + length) break;
        const id = buffer.readInt32LE(4);
        const type = buffer.readInt32LE(8);
        const body = buffer.subarray(12, 4 + length - 2).toString('utf8');
        buffer = buffer.subarray(4 + length);

        if (type === 3) {
          // Vanilla answers auth with an empty value packet then the verdict.
          socket.write(encode(id, 0, ''));
          if (body === this.password) { authed = true; socket.write(encode(id, 2, '')); }
          else socket.write(encode(-1, 2, ''));
          continue;
        }

        if (type === 2) {
          if (!authed) { socket.destroy(); return; }
          const reply = this.world.execute(body).message;
          const write = () => this.writeReply(socket, id, reply);
          if (this.latencyMs > 0) setTimeout(write, this.latencyMs);
          else write();
        }
      }
    });
  }

  private writeReply(socket: net.Socket, id: number, reply: string): void {
    if (socket.destroyed) return;
    if (reply.length <= this.fragmentAt) {
      socket.write(encode(id, 0, reply));
      return;
    }
    for (let i = 0; i < reply.length; i += this.fragmentAt) {
      socket.write(encode(id, 0, reply.slice(i, i + this.fragmentAt)));
    }
  }

  listen(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, this.host, () => {
        const addr = this.server.address();
        this.port = typeof addr === 'object' && addr ? addr.port : port;
        resolve(this.port);
      });
    });
  }

  close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
