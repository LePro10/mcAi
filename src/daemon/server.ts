/**
 * HTTP API and dashboard host.
 *
 * Live updates go out over Server-Sent Events rather than WebSockets: the
 * dashboard only ever listens, SSE is a few lines instead of a framing
 * implementation or another dependency, and browsers reconnect it on their own.
 *
 * Binds to loopback by default. This interface can place blocks and run the
 * agent, so exposing it to a network without a token would be handing out
 * world-edit rights.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compile, getPrefab, listPrefabs, listStyles, PALETTES, renderIsoSvg, validateBlueprint, formatIssues, VERSION } from '../core/index.js';
import type { Blueprint } from '../core/types.js';
import type { BuildService } from './service.js';
import { listProviders, getProvider, needsKey, normalizeBaseUrl } from '../agent/providers.js';
import {
  clearStored, configPath, describeConfig, readStored, testConfig, writeStored,
} from '../agent/config.js';
import type { LlmConfig } from '../agent/llm.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../web');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

export interface ServerOptions {
  port?: number;
  host?: string;
  /** Required as `?token=` or `x-mcai-token` when set. */
  token?: string;
  /** Extra status fields, e.g. bot and RCON health. */
  status?: () => Record<string, unknown>;
}

export function createServer(service: BuildService, opts: ServerOptions = {}) {
  const token = opts.token;
  const clients = new Set<http.ServerResponse>();

  const broadcast = (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try { res.write(payload); } catch { clients.delete(res); }
    }
  };

  service.on('state', (s) => broadcast('state', s));
  service.on('log', (l) => broadcast('log', l));
  service.on('finished', (j) => broadcast('finished', j));
  service.on('build_start', (b) => broadcast('build_start', b));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const route = url.pathname;

    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type, x-mcai-token');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (route === '/health') return json(res, 200, { ok: true, version: VERSION });

    if (token && route.startsWith('/api')) {
      const provided = req.headers['x-mcai-token'] ?? url.searchParams.get('token');
      if (provided !== token) return json(res, 401, { error: 'Invalid or missing token' });
    }

    try {
      if (route === '/api/state') {
        return json(res, 200, { ...service.snapshotState(), status: opts.status?.() ?? {}, version: VERSION });
      }

      if (route === '/api/logs') return json(res, 200, { logs: service.logs.slice(-200) });

      if (route === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write('retry: 2000\n\n');
        res.write(`event: state\ndata: ${JSON.stringify(service.snapshotState())}\n\n`);
        clients.add(res);
        // A periodic comment keeps proxies and browsers from timing the
        // connection out during a long quiet stretch.
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 20_000);
        if (ping.unref) ping.unref();
        req.on('close', () => { clearInterval(ping); clients.delete(res); });
        return;
      }

      // ── Model setup ──
      if (route === '/api/providers') {
        return json(res, 200, {
          providers: listProviders(),
          current: describeConfig(),
          configFile: configPath(),
        });
      }

      if (req.method === 'POST' && route === '/api/provider/test') {
        const cfg = configFromBody(await readJson(req));
        if ('error' in cfg) return json(res, 400, { ok: false, error: cfg.error });
        return json(res, 200, await testConfig(cfg.config));
      }

      if (req.method === 'POST' && route === '/api/provider') {
        const body = await readJson(req);
        const cfg = configFromBody(body);
        if ('error' in cfg) return json(res, 400, { ok: false, error: cfg.error });

        // Refuse to save something that does not work: a saved-but-broken
        // config sends people looking for the fault in the wrong place.
        if (body.skipTest !== true) {
          const check = await testConfig(cfg.config);
          if (!check.ok) return json(res, 400, { ok: false, error: check.error, tested: true });
        }

        writeStored({
          provider: cfg.providerId,
          model: cfg.config.model,
          apiKey: cfg.config.apiKey === 'not-needed' ? undefined : cfg.config.apiKey,
          baseUrl: cfg.config.baseUrl,
        });
        service.reloadModel();
        return json(res, 200, { ok: true, current: describeConfig() });
      }

      if (req.method === 'POST' && route === '/api/provider/clear') {
        clearStored();
        service.reloadModel();
        return json(res, 200, { ok: true, current: describeConfig() });
      }

      if (route === '/api/prefabs') return json(res, 200, { prefabs: listPrefabs() });
      if (route === '/api/styles') {
        return json(res, 200, {
          styles: listStyles().map((s) => ({ ...s, hints: PALETTES[s.name]?.hints ?? [], slots: PALETTES[s.name]?.slots ?? {} })),
        });
      }

      // Rendered preview of a prefab, used by the dashboard gallery.
      const previewMatch = /^\/api\/preview\/([a-z_]+)\.svg$/.exec(route);
      if (previewMatch) {
        const bp = getPrefab(previewMatch[1], numericParams(url.searchParams));
        if (!bp) return json(res, 404, { error: 'Unknown structure' });
        const style = url.searchParams.get('style');
        if (style && PALETTES[style]) bp.palette = style;
        const built = compile(bp, { origin: [0, 64, 0] });
        const svg = renderIsoSvg(built, {
          scale: Number(url.searchParams.get('scale')) || 4,
          background: url.searchParams.get('bg') ?? '#12141a',
        });
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=300' });
        return res.end(svg);
      }

      // ── Direct build endpoints, used by the MCP server ──
      // These bypass the queue and the model: the caller has already decided
      // what to build, so there is nothing to plan.
      if (route === '/api/survey') {
        const radius = Math.max(8, Math.min(96, Number(url.searchParams.get('radius')) || 32));
        return json(res, 200, await service.survey(radius));
      }

      if (req.method === 'POST' && route === '/api/build_blueprint') {
        const body = await readJson(req);
        const bp = body.blueprint as Blueprint;
        const v = validateBlueprint(bp);
        if (!v.ok) return json(res, 400, { ok: false, errors: [formatIssues(v.errors)] });
        if (service.busy) return json(res, 409, { ok: false, errors: ['A build is already running.'] });
        const outcome = await service.build(bp, {
          origin: body.origin as [number, number, number] | undefined,
          rotate: body.rotate as 0 | 90 | 180 | 270 | undefined,
        });
        return json(res, outcome.ok ? 200 : 400, outcome);
      }

      if (req.method === 'POST' && route === '/api/build_prefab') {
        const body = await readJson(req);
        if (service.busy) return json(res, 409, { ok: false, errors: ['A build is already running.'] });
        const outcome = await service.buildPrefab(
          String(body.name ?? ''),
          (body.params as Record<string, unknown>) ?? {},
          {
            origin: body.origin as [number, number, number] | undefined,
            rotate: body.rotate as 0 | 90 | 180 | 270 | undefined,
          },
        );
        return json(res, outcome.ok ? 200 : 400, outcome);
      }

      if (req.method === 'POST' && route === '/api/build') {
        const body = await readJson(req);
        const prompt = String(body.prompt ?? '').trim();
        if (!prompt) return json(res, 400, { error: 'prompt is required' });
        const job = service.submit(String(body.player ?? 'dashboard'), prompt);
        if (!job) return json(res, 429, { error: 'Queue is full' });
        return json(res, 202, { job });
      }

      if (req.method === 'POST' && route === '/api/preview') {
        const body = await readJson(req);
        const bp = body.blueprint as Blueprint;
        const v = validateBlueprint(bp);
        if (!v.ok) return json(res, 400, { error: 'Invalid blueprint', detail: formatIssues(v.errors) });
        const built = compile(bp, { origin: [0, 64, 0] });
        return json(res, 200, {
          stats: built.stats,
          commands: built.commands.length,
          svg: renderIsoSvg(built, { scale: 4, background: '#12141a' }),
        });
      }

      if (req.method === 'POST' && route === '/api/undo') {
        const result = await service.undo();
        return json(res, result.ok ? 200 : 400, result);
      }

      if (req.method === 'POST' && route === '/api/cancel') {
        return json(res, 200, { cancelled: service.cancel() });
      }

      if (req.method === 'POST' && route === '/api/style') {
        const body = await readJson(req);
        const style = body.style === null || body.style === '' ? null : String(body.style);
        if (!service.setStyle(style)) return json(res, 400, { error: `Unknown style "${style}"` });
        return json(res, 200, { style: service.style });
      }

      if (route.startsWith('/api/')) return json(res, 404, { error: 'Unknown endpoint' });

      // ── Static dashboard ──
      const file = route === '/' ? '/index.html' : route;
      const resolved = path.resolve(WEB_DIR, `.${file}`);
      if (!resolved.startsWith(WEB_DIR)) return json(res, 403, { error: 'Forbidden' });
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        return json(res, 404, { error: 'Not found' });
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(resolved)] ?? 'application/octet-stream' });
      return res.end(fs.readFileSync(resolved));
    } catch (err) {
      return json(res, 500, { error: (err as Error).message });
    }
  });

  return {
    server,
    broadcast,
    listen(): Promise<number> {
      const port = opts.port ?? 8765;
      const host = opts.host ?? '127.0.0.1';
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(port));
      });
    },
    close(): Promise<void> {
      for (const c of clients) { try { c.end(); } catch { /* ignore */ } }
      clients.clear();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Turn a settings payload into a testable configuration.
 *
 * An empty key means "keep the one already saved", so the dashboard never has
 * to receive a key in order to send one back.
 */
function configFromBody(body: Record<string, unknown>):
  | { providerId: string; config: LlmConfig }
  | { error: string } {
  const providerId = String(body.provider ?? '');
  const p = getProvider(providerId);
  if (!p) return { error: `Unknown provider "${providerId}".` };

  const model = String(body.model ?? '').trim() || p.defaultModel;
  if (!model) return { error: 'Pick a model.' };

  const baseUrl = normalizeBaseUrl(String(body.baseUrl ?? '').trim() || p.baseUrl);
  if (!baseUrl) return { error: 'This provider needs a base URL.' };

  let apiKey = String(body.apiKey ?? '').trim();
  if (!apiKey) {
    const stored = readStored();
    if (stored?.provider === providerId && stored.apiKey) apiKey = stored.apiKey;
  }
  if (needsKey(p) && !apiKey) return { error: `${p.name} needs an API key.` };

  return {
    providerId,
    config: { provider: p.wire, model, apiKey: apiKey || 'not-needed', baseUrl },
  };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      // A build request is a sentence, not a payload; refuse anything absurd.
      if (data.length > 2_000_000) { reject(new Error('Request body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('Body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}

function numericParams(params: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of params) {
    if (k === 'style' || k === 'bg' || k === 'scale' || k === 'token') continue;
    const n = Number(v);
    out[k] = Number.isFinite(n) ? n : v;
  }
  return out;
}
