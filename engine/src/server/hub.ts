// The engine hub: one HTTP server on 127.0.0.1 with the REST API, the static viewer,
// WebSockets /mod and /viewer, and the MCP endpoint /mcp (ARCHITECTURE §6).

import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Box, EditBatch, Facing, PlayerInfo, Vec3, WorldBackend, WorldInfo } from '../core/types.ts';
import { Registry } from '../core/registry.ts';
import { History } from '../core/session.ts';
import { StructureLibrary } from '../core/schematic.ts';
import type { AssetStore } from '../assets/assets.ts';
import { renderVolume, type RenderOptions } from '../render/render.ts';
import { cropBelow, undergroundCropY } from '../render/crop.ts';
import { batchBounds, boxVolume, normBox } from '../core/volume.ts';
import { JobWorldCache } from './tools/world-cache.ts';
import { ENGINE_VERSION, VIEWER_DIR, ensureHome, isPidAlive, paths, readEngineInfo, type Config } from './config.ts';
import { ModBackend } from './mod-bridge.ts';
import { handleMcp, tokenOk } from './mcp.ts';
import { b64encode, isBox, isVec3, normalizeBox, type BuildRequestMsg } from './protocol.ts';
import { WorldEdit } from './worldedit.ts';
import { groundY } from './terrain.ts';
import type { ToolEnv } from './tools/common.ts';
import { Job, JobError, JobManager, type JobRequest, type JobSize, type Runner } from '../agent/jobs.ts';
import { ClaudeRunner } from '../agent/runner.ts';
import { ViewerAssets } from './viewer-assets.ts'; // viewer assets

export interface HubOptions {
  config: Config;
  /** world backend (e.g. SimBackend). Omit to use the Minecraft mod over /mod. */
  backend?: WorldBackend;
  /** port override (0 = any free port). Default config.port, next free one if busy. */
  port?: number;
  runner?: Runner;
  /** write ~/.mcai/engine.json (default true) */
  writeEngineJson?: boolean;
  token?: string;
  viewerDir?: string;
  log?: (line: string) => void;
  /** ModBackend tuning (tests) */
  modOptions?: ConstructorParameters<typeof ModBackend>[0];
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

const TALL_PROMPT = /\b(tower|castle|cathedral|spire|lighthouse|skyscraper|tall|giant|huge|turm|burg|kathedrale|leuchtturm|riesig|hoch)\b/i;

/**
 * Effective allowed box for a job. Selection → selection + `selectionMargin` on every side (the
 * selection stays the primary build area). An explicit `size` is used exactly. Selection and default
 * (config size) boxes are extended down to
 * the lowest ground / water bed in the footprint (−2, at most 32 below the floor) and up to at
 * least `minBuildHeight` (+16 for tall prompts) above the floor. Returns notes for get_context.
 */
export async function resolveAllowedBox(
  backend: WorldBackend,
  req: JobRequest,
  cfg: Config,
  world: { minY: number; maxY: number },
): Promise<{ box: Box; notes: string[] }> {
  const notes: string[] = [];
  let box: Box;
  let floorY: number;
  if (req.selection && isBox(req.selection)) {
    const s = normalizeBox(req.selection);
    const m = cfg.selectionMargin;
    box = { min: [s.min[0] - m, s.min[1] - m, s.min[2] - m], max: [s.max[0] + m, s.max[1] + m, s.max[2] + m] };
    floorY = s.min[1];
  } else {
    box = defaultAllowedBox(req.anchor, req.facing, req.size ?? cfg.defaultSize, cfg.depthBelow, world);
    floorY = req.anchor[1];
    // an explicitly requested size (CLI/viewer/API) is used exactly as given
    if (req.size) return { box, notes };
  }
  const area = (box.max[0] - box.min[0] + 1) * (box.max[2] - box.min[2] + 1);
  if (area <= 256 * 256) {
    try {
      const hm = await backend.heightmap(box.min[0], box.min[2], box.max[0], box.max[2], 'ocean_floor', req.dimension);
      let lo = Infinity;
      for (const h of hm.data) if (h > world.minY && h < lo) lo = h;
      if (Number.isFinite(lo)) {
        const want = lo - 2;
        const limit = floorY - 32;
        if (want < box.min[1]) {
          const nm = Math.max(want, limit, world.minY);
          if (nm < box.min[1]) {
            notes.push(`box extended down to y=${nm} so foundations/piers reach the ground or water bed (lowest y=${lo})`);
            box.min[1] = nm;
          }
        }
        if (lo < box.min[1]) notes.push(`WARNING: ground/water bed below the box (down to y=${lo}) is NOT editable — piers and foundations cannot reach it; stay above y=${box.min[1]}`);
      }
    } catch {
      /* heightmap unavailable: keep the base box */
    }
  }
  const minTop = floorY + cfg.minBuildHeight - 1 + (TALL_PROMPT.test(req.prompt ?? '') ? 16 : 0);
  if (box.max[1] < minTop) {
    notes.push(`box extended up to y=${minTop} (low selection)`);
    box.max[1] = minTop;
  }
  box.min[1] = Math.max(world.minY, box.min[1]);
  box.max[1] = Math.min(world.maxY, box.max[1]);
  return { box, notes };
}

/** Default allowed build box for a request without selection (pure rotation of a local box). */
export function defaultAllowedBox(anchor: Vec3, facing: Facing, size: JobSize, depthBelow: number, world: { minY: number; maxY: number }): Box {
  const front = Math.min(8, Math.floor(size.z / 6));
  const lmin: Vec3 = [-Math.floor(size.x / 2), -depthBelow, -(size.z - 1 - front)];
  const lmax: Vec3 = [size.x - Math.floor(size.x / 2) - 1, size.y - 1, front];
  const turns = { north: 0, east: 1, south: 2, west: 3 }[facing];
  const rot = (x: number, z: number): [number, number] => {
    switch (turns) {
      case 1: return [-z, x];
      case 2: return [-x, -z];
      case 3: return [z, -x];
      default: return [x, z];
    }
  };
  const a = rot(lmin[0], lmin[2]);
  const b = rot(lmax[0], lmax[2]);
  const box: Box = {
    min: [anchor[0] + Math.min(a[0], b[0]), Math.max(world.minY, anchor[1] + lmin[1]), anchor[2] + Math.min(a[1], b[1])],
    max: [anchor[0] + Math.max(a[0], b[0]), Math.min(world.maxY, anchor[1] + lmax[1]), anchor[2] + Math.max(a[1], b[1])],
  };
  return box;
}

export function facingFromYaw(yaw: number): Facing {
  const a = ((Math.round(yaw / 90) % 4) + 4) % 4;
  return (['south', 'west', 'north', 'east'] as const)[a]!;
}

export class Hub {
  readonly config: Config;
  readonly mod: ModBackend;
  readonly history = new History({ limit: 200 });
  readonly structures: StructureLibrary;
  readonly jobs: JobManager;
  readonly worldEdit: WorldEdit;
  readonly startedAt = Date.now();
  token: string;
  port = 0;
  private world: WorldBackend | null;
  private server: http.Server | null = null;
  private wssMod = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
  private wssViewer = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  private viewers = new Set<WebSocket>();
  private opts: HubOptions;
  private reg: Registry | null = null;
  private worldInfo: WorldInfo | null = null;
  private assetsP: Promise<AssetStore | null> | null = null;
  private adhoc: Job | null = null;
  private lastUpdate = new Map<string, { t: number; state: string; timer: NodeJS.Timeout | null }>();
  private runner: Runner;
  readonly env: ToolEnv;
  /** viewer assets: atlas, compact geometry, biomes, vendored three.js (viewer-assets.ts) */
  readonly viewerAssets: ViewerAssets;
  log: (line: string) => void;

  constructor(opts: HubOptions) {
    this.opts = opts;
    this.config = opts.config;
    this.log = opts.log ?? ((l) => console.log(`[mcai] ${l}`));
    this.world = opts.backend ?? null;
    this.mod = new ModBackend({ log: (m) => this.log(m), ...(opts.modOptions ?? {}) });
    this.token = opts.token ?? loadOrCreateToken(opts.writeEngineJson !== false);
    this.structures = new StructureLibrary(paths.structures());
    this.runner = opts.runner ?? new ClaudeRunner({ config: this.config, endpoint: () => ({ port: this.port, token: this.token }) });
    this.jobs = new JobManager({
      config: this.config,
      runner: this.runner,
      allowedBox: (req) => this.allowedBoxFor(req),
      onEnd: (job) => this.onJobEnd(job),
    });
    this.env = {
      backend: () => this.backend(),
      registry: () => this.registry(),
      config: this.config,
      history: this.history,
      structures: this.structures,
      assets: () => this.assets(),
      jobs: this.jobs,
      onWorldChange: (b, d) => this.broadcastBlocks(b, d),
    };
    this.worldEdit = new WorldEdit({
      backend: () => this.backend(),
      registry: () => this.registry(),
      history: this.history,
      structures: this.structures,
      maxBlocks: this.config.maxBlocksPerCall,
      onWorldChange: (b, d) => {
        // player tool edits / undo: job read caches must not serve stale blocks there
        const bb = batchBounds(b);
        if (bb) JobWorldCache.foreignEdit(null, bb);
        this.broadcastBlocks(b, d);
      },
    });
    this.viewerAssets = new ViewerAssets({ assets: () => this.assets(), backend: () => this.backend(), config: this.config }); // viewer assets
    this.wireJobs();
    this.wireMod();
  }

  // ------------------------------------------------------------ world access

  /** The active world backend (sim, or the connected Minecraft server). */
  backend(): WorldBackend {
    return this.world ?? this.mod;
  }

  registry(): Registry {
    if (!this.world && this.mod.blockRegistry) return this.mod.blockRegistry;
    return (this.reg ??= Registry.loadDefault());
  }

  assets(): Promise<AssetStore | null> {
    if (!this.assetsP && process.env.MCAI_NO_ASSETS) this.assetsP = Promise.resolve(null);
    if (!this.assetsP) {
      this.assetsP = import('../assets/assets.ts')
        .then((m) => m.AssetStore.open())
        .catch((e: Error) => {
          this.log(`assets unavailable (${e.message}); renders use flat colors`);
          return null;
        });
    }
    return this.assetsP;
  }

  private async refreshWorldInfo(): Promise<void> {
    try {
      this.worldInfo = await this.backend().info();
    } catch {}
  }

  allowedBoxFor(req: JobRequest): Box {
    const w = this.worldInfo ?? { minY: -64, maxY: 319 };
    if (req.selection && isBox(req.selection)) {
      const s = normalizeBox(req.selection);
      return { min: [s.min[0], Math.max(w.minY, s.min[1]), s.min[2]], max: [s.max[0], Math.min(w.maxY, s.max[1]), s.max[2]] };
    }
    return defaultAllowedBox(req.anchor, req.facing, req.size ?? this.config.defaultSize, this.config.depthBelow, w);
  }

  // ------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    ensureHome();
    if (this.opts.writeEngineJson !== false) {
      const other = readEngineInfo();
      if (other && other.pid !== process.pid && isPidAlive(other.pid)) {
        throw new Error(`another mcai engine is already running (pid ${other.pid}, port ${other.port}). Stop it first or use it.`);
      }
    }
    if (this.world) await this.refreshWorldInfo();
    this.server = http.createServer((req, res) => {
      this.onRequest(req, res).catch((e: Error) => {
        const status = e instanceof HttpError ? e.status : 500;
        if (status === 500) this.log(`http error ${req.method} ${req.url}: ${e.stack ?? e.message}`);
        if (!res.headersSent) {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        } else res.end();
      });
    });
    this.server.requestTimeout = 0; // long MCP tool calls (ask_player, huge builds)
    this.server.headersTimeout = 60_000;
    this.server.keepAliveTimeout = 30_000;
    this.server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket as any, head));
    const want = this.opts.port ?? this.config.port;
    this.port = await listen(this.server, want, want === 0 ? 0 : 20);
    if (this.opts.writeEngineJson !== false) {
      fs.writeFileSync(paths.engineJson(), JSON.stringify({ port: this.port, token: this.token, pid: process.pid, version: ENGINE_VERSION }, null, 2), { mode: 0o600 });
      fs.chmodSync(paths.engineJson(), 0o600);
    }
    this.log(`engine ${ENGINE_VERSION} listening on http://127.0.0.1:${this.port} (${this.world ? `${this.world.kind} world` : 'waiting for Minecraft on /mod'})`);
  }

  async stop(): Promise<void> {
    await this.jobs.shutdown().catch(() => {});
    if (this.runner instanceof ClaudeRunner) this.runner.killAll();
    this.mod.close();
    for (const v of this.viewers) {
      try {
        v.close(1001, 'engine shutting down');
      } catch {}
    }
    this.wssMod.close();
    this.wssViewer.close();
    if (this.server) {
      const s = this.server;
      this.server = null;
      await new Promise<void>((r) => {
        s.close(() => r());
        s.closeAllConnections();
      });
    }
    if (this.opts.writeEngineJson !== false) {
      const cur = readEngineInfo();
      if (cur && cur.pid === process.pid) fs.rmSync(paths.engineJson(), { force: true });
    }
    const w = this.world as (WorldBackend & { save?: () => Promise<void> }) | null;
    if (w?.save) await w.save().catch(() => {});
  }

  // ------------------------------------------------------------ jobs <-> mod/viewer

  private wireJobs(): void {
    this.jobs.on('update', (job: Job) => {
      this.broadcast({ type: 'job', job: job.snapshot() });
      this.sendJobUpdate(job);
    });
    this.jobs.on('agent', (job: Job, ev) => {
      if (ev.kind === 'raw' || ev.kind === 'stderr') return;
      this.broadcast({ type: 'agent', jobId: job.id, ev: { kind: ev.kind, line: ev.line } });
    });
  }

  /** job_update to the mod, throttled to ~4/s per job (state changes always go out). */
  private sendJobUpdate(job: Job): void {
    if (!this.mod.connected) return;
    const st = this.lastUpdate.get(job.id) ?? { t: 0, state: '', timer: null };
    this.lastUpdate.set(job.id, st);
    const now = Date.now();
    const send = () => {
      st.t = Date.now();
      st.state = job.state;
      st.timer = null;
      void this.mod.jobUpdate(job.toUpdate());
      if (!job.active) this.lastUpdate.delete(job.id);
    };
    if (st.state !== job.state || now - st.t > 250) {
      if (st.timer) clearTimeout(st.timer);
      send();
    } else if (!st.timer) {
      st.timer = setTimeout(send, 250 - (now - st.t));
    }
  }

  private async onJobEnd(job: Job): Promise<void> {
    if (job.undoIds.length > 1) {
      try {
        const merged = this.history.group(job.player, job.undoIds[0]!, `AI: ${job.req.prompt.slice(0, 48)}`);
        if (merged) job.undoIds = [merged.id];
      } catch (e) {
        job.log('warn', { where: 'group undo', message: (e as Error).message });
      }
    }
    const cost = job.costUsd ? ` · $${job.costUsd.toFixed(2)}` : '';
    let text: string;
    if (job.state === 'cancelled') text = `[mcAI] Build cancelled.${job.blocksChanged ? ` ${job.blocksChanged} blocks stay — /mcai undo removes them.` : ''}`;
    else if (job.state === 'failed' || job.error) text = `[mcAI] Build failed: ${job.error}${job.blocksChanged ? ` (${job.blocksChanged} blocks placed — /mcai undo removes them)` : ''}`;
    else text = `[mcAI] Done: ${job.blocksChanged} blocks in ${Math.round((Date.now() - job.startedAt) / 1000)}s${cost}. /mcai undo reverts the whole build.`;
    try {
      await this.backend().notify({ target: job.player, kind: 'chat', text });
    } catch {}
  }

  /** Ad-hoc job for MCP clients without X-Mcai-Job (manual sessions / debugging). */
  private adhocJob(boxHeader?: string): Job {
    // Optional X-Mcai-Box: x1,y1,z1,x2,y2,z2 (world) — a manual/repair session for that region.
    const nums = boxHeader?.split(',').map(Number);
    const box: Box | null =
      nums && nums.length === 6 && nums.every(Number.isFinite)
        ? normBox([nums[0], nums[1], nums[2]], [nums[3], nums[4], nums[5]])
        : null;
    if (this.adhoc && this.adhoc.active && !box) return this.adhoc;
    const anchor: Vec3 = box ? [Math.round((box.min[0] + box.max[0]) / 2), box.min[1], Math.round((box.min[2] + box.max[2]) / 2)] : [0, 64, 0];
    const req: JobRequest = { player: { name: 'Developer' }, prompt: '(manual MCP session)', anchor, facing: 'north', source: 'api' };
    const job = new Job(`adhoc-${Date.now().toString(36)}`, req, box ?? this.allowedBoxFor(req));
    job.state = 'thinking';
    job.startedAt = Date.now();
    this.jobs.adopt(job);
    this.adhoc = job;
    return job;
  }

  /** Submit a job from a loose request (viewer/API/CLI). Fills player/anchor defaults. */
  async submitJob(body: Record<string, any>, source: JobRequest['source'] = 'api'): Promise<Job> {
    if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw new JobError('prompt is required');
    await this.refreshWorldInfo();
    const name = typeof body.player === 'string' && body.player ? body.player : 'Viewer';
    let player: JobRequest['player'] = { name };
    try {
      const p = (await this.backend().players()).find((x) => x.name === name);
      if (p) player = p;
    } catch {}
    let anchor: Vec3 | null = isVec3(body.anchor) ? (body.anchor.map(Math.floor) as Vec3) : null;
    const facing: Facing = ['north', 'south', 'east', 'west'].includes(body.facing) ? body.facing : 'pos' in player && player.pos ? facingFromYaw(player.yaw ?? 180) : 'north';
    if (!anchor) {
      let x = 0, z = 0;
      if ('pos' in player && player.pos) {
        x = Math.floor(player.pos[0]);
        z = Math.floor(player.pos[2]);
      }
      anchor = [x, await groundY(this.backend(), this.registry(), x, z), z];
    }
    const size = parseSize(body.size);
    const base: JobRequest = {
      player,
      prompt: body.prompt,
      anchor,
      facing,
      selection: isBox(body.selection) ? normalizeBox(body.selection) : undefined,
      size: size ?? undefined,
      options: { style: typeof body.style === 'string' ? body.style : undefined, mode: body.mode === 'plan' ? 'plan' : 'build' },
      source,
      model: typeof body.model === 'string' ? body.model : undefined,
      effort: typeof body.effort === 'string' ? body.effort : undefined,
      budgetUsd: typeof body.budgetUsd === 'number' ? body.budgetUsd : undefined,
      timeoutMin: typeof body.timeoutMin === 'number' ? body.timeoutMin : undefined,
    };
    return this.jobs.submit(await this.withAllowedBox(base));
  }

  /** attach the effective allowed box (selection + margin + terrain extension) to a request */
  async withAllowedBox(req: JobRequest): Promise<JobRequest> {
    const w = this.worldInfo ?? { minY: -64, maxY: 319 };
    try {
      const { box, notes } = await resolveAllowedBox(this.backend(), req, this.config, w);
      return { ...req, allowedBox: box, boxNotes: notes };
    } catch {
      return req;
    }
  }

  private wireMod(): void {
    this.mod.on('hello', () => {
      this.reg = null;
      void this.refreshWorldInfo();
      this.broadcast({ type: 'mod', connected: true, hello: this.modSummary() });
    });
    this.mod.on('disconnect', () => this.broadcast({ type: 'mod', connected: false }));
    this.mod.on('notify', (n) => this.broadcast({ type: 'notify', ...n }));
    const w = this.world as (WorldBackend & { on?: (ev: string, cb: (...a: any[]) => void) => void }) | null;
    if (w && typeof w.on === 'function') {
      try {
        w.on('notify', (n: Record<string, unknown>) => this.broadcast({ type: 'notify', ...n }));
      } catch {}
    }
    this.mod.onRequest('build_request', async (m) => {
      const msg = m as unknown as BuildRequestMsg;
      if (!msg.player?.name || !isVec3(msg.anchor)) throw new Error('build_request needs player and anchor');
      await this.refreshWorldInfo();
      const job = this.jobs.submit(await this.withAllowedBox({
        player: msg.player,
        prompt: String(msg.prompt ?? ''),
        anchor: msg.anchor.map(Math.floor) as Vec3,
        facing: ['north', 'south', 'east', 'west'].includes(msg.facing) ? msg.facing : facingFromYaw(msg.player.yaw ?? 180),
        selection: isBox(msg.selection) ? normalizeBox(msg.selection) : undefined,
        dimension: msg.player.dimension,
        options: { style: msg.options?.style, mode: msg.options?.mode === 'plan' ? 'plan' : 'build' },
        source: 'mod',
      }));
      return { jobId: job.id, allowedBox: job.allowedBox, selection: job.req.selection ?? null };
    });
    this.mod.onRequest('job_control', async (m) => {
      const player = String(m.player ?? '');
      const job = m.jobId ? this.jobs.get(String(m.jobId)) : this.jobs.activeFor(player) ?? this.jobs.latestFor(player);
      switch (m.action) {
        case 'cancel': {
          if (!job || !job.active) return { message: 'no active build to cancel' };
          await this.jobs.cancel(job.id, `cancelled by ${player}`);
          return { message: 'build cancelled', jobId: job.id };
        }
        case 'undo':
        case 'redo':
          return this.worldEdit.handle(player, m.action, {});
        case 'confirm':
        case 'reject': {
          if (!job || !this.jobs.answer(job.id, m.action === 'confirm' ? 'yes' : 'no')) return { message: 'nothing to confirm' };
          return { message: m.action === 'confirm' ? 'confirmed' : 'rejected', jobId: job.id };
        }
        default:
          throw new Error(`unknown job_control action '${m.action}'`);
      }
    });
    this.mod.onRequest('player_reply', async (m) => {
      const player = String(m.player ?? '');
      const job = m.jobId ? this.jobs.get(String(m.jobId)) : this.jobs.activeFor(player);
      if (!job || !this.jobs.answer(job.id, String(m.text ?? ''))) return { message: 'no question is waiting for an answer' };
      return { message: 'answer delivered', jobId: job.id };
    });
    this.mod.onRequest('tool_request', async (m) => {
      return this.worldEdit.handle(String(m.player ?? ''), String(m.tool ?? ''), (m.args ?? {}) as Record<string, unknown>);
    });
  }

  private modSummary() {
    const h = this.mod.hello;
    return h ? { modVersion: h.modVersion, mcVersion: h.mcVersion, world: h.world, serverType: h.serverType, blocks: Object.keys(h.registry.blocks).length } : null;
  }

  // ------------------------------------------------------------ viewer

  broadcast(msg: Record<string, unknown>): void {
    if (!this.viewers.size) return;
    const s = JSON.stringify(msg);
    for (const v of this.viewers) if (v.readyState === 1) v.send(s);
  }

  private broadcastBlocks(b: EditBatch, dimension: string): void {
    if (!this.viewers.size) return;
    this.broadcast({ type: 'blocks', dimension, palette: b.palette, positions: b64encode(b.positions), states: b64encode(b.states) });
  }

  private async onViewerMessage(ws: WebSocket, text: string): Promise<void> {
    let m: Record<string, any>;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    const reply = (ok: boolean, payload: Record<string, unknown>) => {
      if (m.id !== undefined && ws.readyState === 1) ws.send(JSON.stringify({ re: m.id, ok, ...payload }));
    };
    try {
      switch (m.type) {
        case 'status': return reply(true, await this.status());
        case 'jobs': return reply(true, { jobs: this.jobs.list().map((j) => j.snapshot()) });
        case 'get_blocks': {
          if (!isBox(m.box)) throw new Error('box required');
          const b = normalizeBox(m.box);
          if (boxVolume(b) > 16_000_000) throw new Error('box too large (max 16M blocks)');
          const v = await this.backend().getBlocks(b, m.dimension);
          return reply(true, { box: v.box, palette: v.palette, data: b64encode(v.data) });
        }
        case 'heightmap': {
          const h = await this.backend().heightmap(m.x0, m.z0, m.x1, m.z1, m.kind ?? 'surface', m.dimension);
          return reply(true, { x0: h.x0, z0: h.z0, x1: h.x1, z1: h.z1, data: b64encode(h.data) });
        }
        case 'players': return reply(true, { players: await this.backend().players() });
        case 'start_job': {
          const job = await this.submitJob(m, 'viewer');
          return reply(true, { job: job.snapshot() });
        }
        case 'cancel_job': {
          const job = await this.jobs.cancel(String(m.jobId), 'cancelled from viewer');
          return reply(true, { job: job.snapshot() });
        }
        case 'reply': return reply(this.jobs.answer(String(m.jobId), String(m.text ?? '')), {});
        case 'undo':
        case 'redo': return reply(true, await this.worldEdit.handle(String(m.player ?? 'Viewer'), m.type, {}));
        default: throw new Error(`unknown viewer request '${m.type}'`);
      }
    } catch (e) {
      reply(false, { error: (e as Error).message });
    }
  }

  // ------------------------------------------------------------ HTTP

  async status() {
    const be = this.backend();
    let world: WorldInfo | null = null;
    try {
      world = await be.info();
    } catch {}
    const jobs = this.jobs.list();
    return {
      version: ENGINE_VERSION,
      pid: process.pid,
      port: this.port,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      backend: be.kind,
      world,
      mod: { connected: this.mod.connected, ...(this.modSummary() ?? {}) },
      jobs: { total: jobs.length, active: jobs.filter((j) => j.active).length },
      registry: this.registry().version,
    };
  }

  private checkHost(req: IncomingMessage): void {
    const host = (req.headers.host ?? '').toLowerCase();
    const ok = host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}` || host === `[::1]:${this.port}`;
    if (!ok) throw new HttpError(421, 'bad Host header');
  }

  private sameOrigin(req: IncomingMessage): boolean {
    const o = req.headers.origin;
    return o === `http://127.0.0.1:${this.port}` || o === `http://localhost:${this.port}`;
  }

  private authed(req: IncomingMessage, url: URL): boolean {
    return tokenOk(req.headers.authorization, this.token) || url.searchParams.get('token') === this.token;
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.checkHost(req);
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    const p = url.pathname;
    if (p === '/mcp') {
      const body = req.method === 'POST' ? await readJson(req, 16 * 1024 * 1024) : undefined;
      return handleMcp(req, res, body, {
        token: () => this.token,
        env: this.env,
        resolveJob: (id, boxHeader) => (id ? this.jobs.get(id) ?? null : this.adhocJob(boxHeader)),
        log: (m) => this.log(m),
      });
    }
    if (p.startsWith('/api/')) return this.api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    if (this.viewerAssets.serveVendor(res, p)) return; // viewer assets: /vendor/three/…
    return this.serveStatic(res, p);
  }

  private async api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const p = url.pathname;
    const m = req.method ?? 'GET';
    const json = (obj: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    if (m === 'POST' && !(this.authed(req, url) || this.sameOrigin(req))) throw new HttpError(401, 'token required (Authorization: Bearer <token from ~/.mcai/engine.json>)');
    if (m === 'GET' && p === '/api/session') {
      // the bundled viewer fetches the token; only same-origin pages (or no Origin) can read it
      const o = req.headers.origin;
      if (o && !this.sameOrigin(req)) throw new HttpError(403, 'cross-origin');
      return json({ token: this.token, port: this.port, version: ENGINE_VERSION });
    }
    if (p.startsWith('/api/viewer/') && (await this.viewerAssets.handleApi(req, res, url))) return; // viewer assets
    if (m === 'GET' && p === '/api/status') return json(await this.status());
    if (m === 'GET' && p === '/api/jobs') return json({ jobs: this.jobs.list().map((j) => j.snapshot()) });
    let mm: RegExpExecArray | null;
    if (m === 'GET' && (mm = /^\/api\/jobs\/([\w-]+)$/.exec(p))) {
      const job = this.jobs.get(mm[1]!);
      if (!job) throw new HttpError(404, 'no such job');
      const out: Record<string, unknown> = { job: job.snapshot() };
      if (url.searchParams.get('log')) out.log = tailLines(job.logFile, Number(url.searchParams.get('log')) || 200);
      return json(out);
    }
    if (m === 'POST' && p === '/api/jobs') {
      const body = (await readJson(req, 1024 * 1024)) as Record<string, any>;
      try {
        const job = await this.submitJob(body ?? {}, body?.source === 'cli' ? 'cli' : 'viewer');
        return json({ job: job.snapshot() }, 201);
      } catch (e) {
        if (e instanceof JobError) throw new HttpError(409, e.message);
        throw e;
      }
    }
    if (m === 'POST' && (mm = /^\/api\/jobs\/([\w-]+)\/cancel$/.exec(p))) {
      if (!this.jobs.get(mm[1]!)) throw new HttpError(404, 'no such job');
      const job = await this.jobs.cancel(mm[1]!, 'cancelled via API');
      return json({ job: job.snapshot() });
    }
    if (m === 'POST' && (mm = /^\/api\/jobs\/([\w-]+)\/reply$/.exec(p))) {
      const body = (await readJson(req, 64 * 1024)) as Record<string, any>;
      return json({ delivered: this.jobs.answer(mm[1]!, String(body?.text ?? '')) });
    }
    if (m === 'POST' && (p === '/api/undo' || p === '/api/redo')) {
      const body = ((await readJson(req, 64 * 1024)) ?? {}) as Record<string, any>;
      return json(await this.worldEdit.handle(String(body.player ?? 'Viewer'), p.endsWith('undo') ? 'undo' : 'redo', {}));
    }
    if (m === 'GET' && p === '/api/structures') return json({ structures: await this.structures.list({ query: url.searchParams.get('q') ?? undefined }) });
    if (m === 'GET' && p === '/api/feedback') return json({ feedback: readFeedback(Number(url.searchParams.get('limit')) || 100) });
    if (m === 'GET' && p === '/api/blocks') {
      const box = parseBoxParam(url.searchParams.get('box'));
      if (boxVolume(box) > 16_000_000) throw new HttpError(400, 'box too large');
      const v = await this.backend().getBlocks(box);
      return json({ box: v.box, palette: v.palette, data: b64encode(v.data) });
    }
    if (m === 'GET' && p === '/api/render') {
      const box = parseBoxParam(url.searchParams.get('box'));
      if (boxVolume(box) > 8_000_000) throw new HttpError(400, 'box too large');
      let v = await this.backend().getBlocks(box);
      if (url.searchParams.get('crop') !== '0') v = cropBelow(v, undergroundCropY(v, { keep: 3 }));
      const png = await renderVolume(v, await this.assets(), {
        view: (url.searchParams.get('view') ?? 'iso_se') as RenderOptions['view'],
        width: Number(url.searchParams.get('width')) || 800,
        height: Number(url.searchParams.get('height')) || 600,
        time: (url.searchParams.get('time') ?? 'day') as RenderOptions['time'],
      });
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      res.end(png);
      return;
    }
    throw new HttpError(404, `unknown endpoint ${m} ${p}`);
  }

  private serveStatic(res: ServerResponse, p: string): void {
    const root = path.resolve(this.opts.viewerDir ?? VIEWER_DIR);
    let rel = decodeURIComponent(p);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root + path.sep) && file !== root) throw new HttpError(403, 'forbidden');
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      throw new HttpError(404, 'not found');
    }
    if (st.isDirectory()) return this.serveStatic(res, p.replace(/\/?$/, '/'));
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  private onUpgrade(req: IncomingMessage, socket: import('node:net').Socket, head: Buffer): void {
    const reject = (code: number, msg: string) => {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    try {
      this.checkHost(req);
    } catch {
      return reject(421, 'Misdirected Request');
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    if (url.pathname === '/mod') {
      if (!this.authed(req, url)) return reject(401, 'Unauthorized');
      this.wssMod.handleUpgrade(req, socket, head, (ws) => this.mod.attach(ws, String(req.socket.remoteAddress ?? '')));
      return;
    }
    if (url.pathname === '/viewer') {
      if (!this.authed(req, url) && !this.sameOrigin(req)) return reject(401, 'Unauthorized');
      this.wssViewer.handleUpgrade(req, socket, head, (ws) => {
        this.viewers.add(ws);
        ws.on('close', () => this.viewers.delete(ws));
        ws.on('error', () => this.viewers.delete(ws));
        ws.on('message', (d, bin) => {
          if (!bin) void this.onViewerMessage(ws, d.toString());
        });
        void this.status().then((s) => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'hello', status: s, jobs: this.jobs.list().map((j) => j.snapshot()) }));
        });
      });
      return;
    }
    reject(404, 'Not Found');
  }
}

// ------------------------------------------------------------------ helpers

function loadOrCreateToken(persist: boolean): string {
  const file = path.join(paths.home(), 'token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{32,}$/.test(t)) return t;
  } catch {}
  const t = randomBytes(24).toString('hex');
  if (persist) {
    try {
      ensureHome();
      fs.writeFileSync(file, t + '\n', { mode: 0o600 });
    } catch {}
  }
  return t;
}

function listen(server: http.Server, port: number, tries: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let p = port;
    const attempt = () => {
      const onErr = (e: NodeJS.ErrnoException) => {
        server.off('listening', onOk);
        if (e.code === 'EADDRINUSE' && tries-- > 0) {
          p++;
          attempt();
        } else reject(e);
      };
      const onOk = () => {
        server.off('error', onErr);
        resolve((server.address() as import('node:net').AddressInfo).port);
      };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(p, '127.0.0.1');
    };
    attempt();
  });
}

function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > limit) {
        reject(new HttpError(413, `request body too large (max ${limit} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!n) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export function parseBoxParam(s: string | null): Box {
  const n = (s ?? '').split(',').map(Number);
  if (n.length !== 6 || n.some((v) => !Number.isFinite(v))) throw new HttpError(400, 'box=x1,y1,z1,x2,y2,z2 required');
  return normalizeBox({ min: [n[0]!, n[1]!, n[2]!], max: [n[3]!, n[4]!, n[5]!] });
}

export function parseSize(s: unknown): JobSize | null {
  if (s && typeof s === 'object' && 'x' in s) return s as JobSize;
  if (typeof s !== 'string') return null;
  const m = /^(\d+)x(\d+)x(\d+)$/i.exec(s.trim());
  return m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } : null;
}

function tailLines(file: string, n: number): unknown[] {
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    return lines.slice(-n).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return l;
      }
    });
  } catch {
    return [];
  }
}

export function readFeedback(limit = 100): unknown[] {
  const dir = paths.feedback();
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().reverse();
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').reverse();
    for (const l of lines) {
      if (!l) continue;
      try {
        out.push(JSON.parse(l));
      } catch {}
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export type { PlayerInfo };
