// WebSocket client for the engine's /viewer stream (ARCHITECTURE §6). No DOM: runs in
// browsers and in node (global WebSocket) for tests.
//
//   const c = new EngineClient({ base: 'http://127.0.0.1:7878' });
//   c.on('job', (m) => …);  await c.connect();  const s = await c.request('status');

export class EngineClient {
  /**
   * @param {{ base?: string, token?: string, WebSocketImpl?: any, fetchImpl?: any, reconnect?: boolean, timeoutMs?: number }} o
   */
  constructor(o = {}) {
    this.base = (o.base ?? (typeof location !== 'undefined' ? location.origin : 'http://127.0.0.1:7878')).replace(/\/$/, '');
    this.token = o.token ?? null;
    this.WS = o.WebSocketImpl ?? globalThis.WebSocket;
    this.fetch = o.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    this.reconnect = o.reconnect !== false;
    this.timeoutMs = o.timeoutMs ?? 60_000;
    this.ws = null;
    this.state = 'idle'; // idle | connecting | open | closed
    this.attempt = 0;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.closedByUser = false;
    this.retryTimer = null;
    this.lastHello = null;
  }

  on(type, cb) {
    let s = this.handlers.get(type);
    if (!s) this.handlers.set(type, (s = new Set()));
    s.add(cb);
    return () => s.delete(cb);
  }

  emit(type, msg) {
    for (const cb of this.handlers.get(type) ?? []) {
      try {
        cb(msg);
      } catch (e) {
        console.error(`[mcai viewer] ${type} handler failed`, e);
      }
    }
    if (type !== '*') for (const cb of this.handlers.get('*') ?? []) cb(msg);
  }

  /** GET /api/session → token (same-origin only) */
  async session() {
    const r = await this.fetch(`${this.base}/api/session`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`session: HTTP ${r.status}`);
    const j = await r.json();
    this.token = j.token;
    return j;
  }

  /** REST helper (adds the bearer token) */
  async api(path, opts = {}) {
    if (!this.token) await this.session();
    const headers = { ...(opts.headers ?? {}), authorization: `Bearer ${this.token}` };
    let body = opts.body;
    if (body !== undefined && typeof body !== 'string') {
      body = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    const r = await this.fetch(`${this.base}${path}`, { method: opts.method ?? (body !== undefined ? 'POST' : 'GET'), headers, body, cache: 'no-store' });
    if (opts.raw) return r;
    const text = await r.text();
    let j;
    try {
      j = text ? JSON.parse(text) : {};
    } catch {
      j = { error: text };
    }
    if (!r.ok) throw Object.assign(new Error(j.error ?? `HTTP ${r.status}`), { status: r.status });
    return j;
  }

  wsUrl() {
    const u = new URL(this.base);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/viewer';
    if (this.token) u.searchParams.set('token', this.token);
    return u.toString();
  }

  /** Connect (fetches the session token first). Resolves on open; reconnects with backoff afterwards. */
  async connect() {
    this.closedByUser = false;
    if (!this.token) {
      try {
        await this.session();
      } catch (e) {
        this.scheduleRetry();
        throw e;
      }
    }
    return new Promise((resolve, reject) => {
      this.state = 'connecting';
      this.emit('connecting', { attempt: this.attempt });
      let ws;
      try {
        ws = new this.WS(this.wsUrl());
      } catch (e) {
        this.state = 'closed';
        this.scheduleRetry();
        return reject(e);
      }
      this.ws = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
        this.state = 'open';
        this.attempt = 0;
        this.emit('open', {});
        resolve();
      };
      ws.onmessage = (ev) => this.onMessage(typeof ev.data === 'string' ? ev.data : String(ev.data));
      ws.onerror = () => {};
      ws.onclose = (ev) => {
        this.state = 'closed';
        if (this.ws === ws) this.ws = null;
        for (const [, p] of this.pending) p.reject(new Error('connection closed'));
        this.pending.clear();
        this.emit('close', { code: ev?.code, reason: ev?.reason, wasOpen: opened });
        if (!opened) reject(new Error(`websocket closed (${ev?.code ?? '?'})`));
        // 401 → token may have been rotated: refetch on the next attempt
        if (!opened) this.token = null;
        if (!this.closedByUser) this.scheduleRetry();
      };
    });
  }

  scheduleRetry() {
    if (!this.reconnect || this.closedByUser || this.retryTimer) return;
    const delay = Math.min(10_000, 400 * 2 ** Math.min(this.attempt, 5)) * (0.75 + Math.random() * 0.5);
    this.attempt++;
    this.emit('retry', { attempt: this.attempt, delay });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect().catch(() => {});
    }, delay);
  }

  close() {
    this.closedByUser = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    try {
      this.ws?.close(1000, 'bye');
    } catch {}
  }

  onMessage(text) {
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (m.re !== undefined) {
      const p = this.pending.get(m.re);
      if (!p) return;
      this.pending.delete(m.re);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m);
      else p.reject(new Error(m.error ?? 'request failed'));
      return;
    }
    if (m.type === 'hello') this.lastHello = m;
    if (typeof m.type === 'string') this.emit(m.type, m);
  }

  /** request/response over the socket: {id, type, ...payload} → {re, ok, ...} */
  request(type, payload = {}, timeoutMs = this.timeoutMs) {
    if (!this.ws || this.state !== 'open') return Promise.reject(new Error('not connected'));
    const id = `v${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${type}: timeout`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...payload, id, type }));
    });
  }
}

/** Job state helpers */
export const ACTIVE_STATES = new Set(['queued', 'thinking', 'building', 'reviewing']);
export const isActive = (job) => !!job && ACTIVE_STATES.has(job.state);

/** Guess an icon id for an agent event (the stream only carries kind + a human line). */
export function agentIcon(ev) {
  const k = ev?.kind;
  const l = String(ev?.line ?? '');
  if (k === 'init') return 'spark';
  if (k === 'text') return 'thought';
  if (k === 'subagent_start') return 'team';
  if (k === 'subagent_end') return 'check';
  if (k === 'result') return 'flag';
  if (k === 'exit') return 'power';
  if (k === 'tool_result') return 'reply';
  const s = l.replace(/^\[[^\]]+\]\s*/, '');
  if (/^Building|^Placing/.test(s)) return 'cube';
  if (/^Running a build script/.test(s)) return 'code';
  if (/^Studying|^Surveying|^Looking/.test(s)) return 'eye';
  if (/^Shaping terrain|^Measuring/.test(s)) return 'terrain';
  if (/^Choosing materials|^Checking/.test(s)) return 'palette';
  if (/^Clearing/.test(s)) return 'eraser';
  if (/^Copying|^Pasting|^Repeating|^Moving/.test(s)) return 'copy';
  if (/^Saving|^Loading|^Browsing/.test(s)) return 'library';
  if (/^Undoing/.test(s)) return 'undo';
  if (/^Talking/.test(s)) return 'chat';
  if (/^Waiting/.test(s)) return 'question';
  if (/^Finishing/.test(s)) return 'flag';
  if (/^Command:/.test(s)) return 'terminal';
  if (/^Reading|^Looking up/.test(s)) return 'book';
  if (/^Planning/.test(s)) return 'list';
  if (/^Delegating/.test(s)) return 'team';
  return 'tool';
}
