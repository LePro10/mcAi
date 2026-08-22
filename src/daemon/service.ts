/**
 * The build service: everything between "a player typed something" and
 * "blocks changed", plus the state the dashboard renders.
 *
 * One build runs at a time on purpose. Two agents writing to overlapping
 * regions produce garbage that neither can undo, and a Minecraft server does
 * not enjoy two thousand simultaneous fills either.
 */

import { EventEmitter } from 'node:events';
import type { Blueprint, CompiledBuild, Vec3 } from '../core/types.js';
import { getPrefab, matchPrefab, listPrefabs } from '../core/prefabs.js';
import { renderIsoSvg } from '../core/render.js';
import { PALETTES } from '../core/palette.js';
import { Executor, type CommandRunner, type Snapshot } from './executor.js';
import { buildSize, place, sampleTerrain, survey, type PlayerInfo, type SiteWorld } from './site.js';
import { Agent, type AgentHost, type AgentResult, type BuildOutcome, type SurveyResult } from '../agent/agent.js';
import { LlmClient, estimateCost, type LlmConfig } from '../agent/llm.js';
import { loadBlueprints, loadStyles } from './library.js';
import type { Palette } from '../core/palette.js';

export type JobStatus = 'queued' | 'planning' | 'building' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  player: string;
  prompt: string;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Progress within the current phase, 0..1. */
  progress: number;
  phase: string;
  blocks: number;
  commands: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  costUsd: number;
  size?: Vec3;
  origin?: Vec3;
  summary?: string;
  error?: string;
  warnings: string[];
  /** Isometric preview of what was built. */
  previewSvg?: string;
  snapshotId?: string;
}

export interface LogEntry { t: number; level: 'info' | 'warn' | 'error'; msg: string }

export interface ServiceOptions {
  llm?: LlmConfig | null;
  /** Default style when the biome suggestion is not overridden. */
  defaultStyle?: string;
  maxHistory?: number;
  maxUndo?: number;
  batchSize?: number;
  batchPauseMs?: number;
  /** Render an isometric preview after each build. */
  previews?: boolean;
  agentTurns?: number;
  /** Load user styles and blueprints from disk. */
  library?: boolean;
}

export class BuildService extends EventEmitter implements AgentHost {
  private queue: Job[] = [];
  private current: Job | null = null;
  private executor: Executor;
  private undoStack: Array<{ snapshot: Snapshot; job: Job }> = [];
  private running = false;

  readonly history: Job[] = [];
  readonly logs: LogEntry[] = [];
  /** Player whose position anchors the current build. */
  private activePlayer: PlayerInfo | null = null;
  private styleOverride: string | null = null;

  totals = { builds: 0, blocks: 0, commands: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, costUsd: 0 };

  /** Styles and blueprints loaded from `styles/` and `blueprints/`. */
  customStyles: Record<string, Palette> = {};
  customBlueprints: Record<string, Blueprint> = {};

  constructor(
    private readonly world: SiteWorld,
    private readonly runner: CommandRunner,
    private readonly getPlayer: (name: string) => PlayerInfo | null,
    private readonly botPosition: () => Vec3,
    private readonly opts: ServiceOptions = {},
  ) {
    super();
    this.executor = new Executor(runner, {
      batchSize: opts.batchSize,
      batchPauseMs: opts.batchPauseMs,
    });
    this.executor.on('progress', (p) => {
      if (!this.current) return;
      this.current.progress = p.total > 0 ? p.done / p.total : 0;
      this.current.phase = p.phase;
      this.current.blocks = p.blocksChanged;
      this.emitState();
    });
    if (opts.library !== false) this.reloadLibrary();
  }

  /** Re-read user styles and blueprints from disk. */
  reloadLibrary(): { styles: number; blueprints: number; errors: string[] } {
    const styles = loadStyles();
    const blueprints = loadBlueprints();
    this.customStyles = styles.items;
    this.customBlueprints = blueprints.items;
    const errors = [...styles.errors, ...blueprints.errors];
    for (const e of errors) this.log(`Library: ${e}`, 'warn');
    const n = Object.keys(styles.items).length;
    const b = Object.keys(blueprints.items).length;
    if (n || b) this.log(`Loaded ${n} custom style(s) and ${b} custom blueprint(s)`);
    return { styles: n, blueprints: b, errors };
  }

  // ── Logging and state ───────────────────────────────────────────────────

  log(msg: string, level: LogEntry['level'] = 'info'): void {
    const entry: LogEntry = { t: Date.now(), level, msg };
    this.logs.push(entry);
    if (this.logs.length > 400) this.logs.shift();
    this.emit('log', entry);
  }

  private emitState(): void { this.emit('state', this.snapshotState()); }

  snapshotState() {
    return {
      current: this.current,
      queue: this.queue.map((j) => ({ id: j.id, player: j.player, prompt: j.prompt, status: j.status })),
      history: this.history.slice(-25),
      totals: this.totals,
      undoDepth: this.undoStack.length,
      style: this.styleOverride,
      customStyles: Object.keys(this.customStyles),
      customBlueprints: Object.keys(this.customBlueprints),
      llm: this.opts.llm ? { provider: this.opts.llm.provider, model: this.opts.llm.model } : null,
      prefabs: listPrefabs().map((p) => p.name),
      // Deduplicate: styles/ ships an editable copy of every built-in, so a
      // naive concatenation lists each name twice.
      styles: [...new Set([...Object.keys(PALETTES), ...Object.keys(this.customStyles)])].sort(),
    };
  }

  // ── Queue ───────────────────────────────────────────────────────────────

  /** Accept a request. Returns the job, or null when the queue is full. */
  submit(player: string, prompt: string): Job | null {
    if (this.queue.length >= 8) return null;
    const job: Job = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      player, prompt, status: 'queued', createdAt: Date.now(),
      progress: 0, phase: 'queued', blocks: 0, commands: 0,
      tokensIn: 0, tokensOut: 0, tokensCached: 0, costUsd: 0, warnings: [],
    };
    this.queue.push(job);
    this.emitState();
    void this.pump();
    return job;
  }

  cancel(): boolean {
    if (!this.current) return false;
    this.executor.cancel();
    this.current.status = 'cancelled';
    this.log(`Build ${this.current.id} cancelled`, 'warn');
    this.emitState();
    return true;
  }

  get busy(): boolean { return this.running; }
  get currentJob(): Job | null { return this.current; }

  private async pump(): Promise<void> {
    if (this.running) return;
    const job = this.queue.shift();
    if (!job) return;
    this.running = true;
    this.current = job;
    job.status = 'planning';
    job.startedAt = Date.now();
    job.phase = 'planning';
    this.emitState();

    try {
      await this.runJob(job);
    } catch (err) {
      job.status = 'failed';
      job.error = (err as Error).message;
      this.log(`Build ${job.id} failed: ${job.error}`, 'error');
    } finally {
      job.finishedAt = Date.now();
      const unfinished: JobStatus[] = ['planning', 'building'];
      if (unfinished.includes(job.status)) job.status = 'done';
      this.history.push(job);
      while (this.history.length > (this.opts.maxHistory ?? 50)) this.history.shift();
      this.current = null;
      this.running = false;
      this.emit('finished', job);
      this.emitState();
      if (this.queue.length) void this.pump();
    }
  }

  private async runJob(job: Job): Promise<void> {
    const player = this.getPlayer(job.player);
    this.activePlayer = player ?? {
      name: job.player, position: this.botPosition(), yaw: 0, facing: 'south',
    };

    // Fast path: a request that names a library structure needs no model at
    // all. This is most requests, and it is instant and free.
    const direct = this.matchStructure(job.prompt);
    const wantsCustom = /\b(like|shaped|with|and then|custom|design)\b/i.test(job.prompt);
    if (direct && (!this.opts.llm || (!wantsCustom && job.prompt.split(/\s+/).length <= 6))) {
      this.log(`"${job.prompt}" matched the ${direct} prefab — building directly`);
      job.phase = 'building';
      job.status = 'building';
      this.emitState();
      const outcome = await this.buildPrefab(direct, sizeHint(job.prompt), {});
      job.status = outcome.ok ? 'done' : 'failed';
      job.summary = outcome.ok
        ? `${direct}: ${outcome.blocks.toLocaleString()} blocks in ${outcome.seconds.toFixed(1)}s`
        : outcome.errors[0] ?? 'build failed';
      if (!outcome.ok) job.error = outcome.errors[0];
      return;
    }

    if (!this.opts.llm) {
      job.status = 'failed';
      job.error = `No model configured, and "${job.prompt}" does not match a built-in structure. ` +
        `Try one of: ${listPrefabs().slice(0, 8).map((p) => p.name).join(', ')}`;
      return;
    }

    const agent = new Agent(new LlmClient(this.opts.llm), this, { maxTurns: this.opts.agentTurns ?? 6 });
    agent.on('tool', (t: { name: string }) => {
      job.phase = t.name === 'survey' ? 'surveying' : 'building';
      if (t.name !== 'survey') job.status = 'building';
      this.emitState();
    });
    agent.on('retry', (r: { attempt: number; error: string }) =>
      this.log(`Model call failed (${r.error}); retry ${r.attempt}`, 'warn'));

    const result: AgentResult = await agent.run(job.prompt, job.player);

    job.tokensIn = result.usage.inputTokens;
    job.tokensOut = result.usage.outputTokens;
    job.tokensCached = result.usage.cacheReadTokens;
    job.costUsd = result.costUsd;
    job.summary = result.summary;
    job.status = result.ok ? 'done' : 'failed';
    if (!result.ok) job.error = result.error;

    this.totals.tokensIn += job.tokensIn;
    this.totals.tokensOut += job.tokensOut;
    this.totals.tokensCached += job.tokensCached;
    this.totals.costUsd += job.costUsd;

    this.log(
      `Build ${job.id}: ${result.turns} turns, ` +
      `${result.usage.inputTokens + result.usage.outputTokens} tokens, ` +
      `$${result.costUsd.toFixed(4)}`,
    );
  }

  /** Match a request against built-in prefabs and user blueprints alike. */
  matchStructure(prompt: string): string | null {
    const t = prompt.toLowerCase();
    const custom = Object.keys(this.customBlueprints)
      .filter((n) => t.includes(n))
      .sort((a, b) => b.length - a.length)[0];
    // A user's own blueprint wins over a built-in of a similar name: they put
    // it there on purpose.
    return custom ?? matchPrefab(prompt);
  }

  // ── AgentHost ───────────────────────────────────────────────────────────

  async survey(radius = 32): Promise<SurveyResult> {
    const player = this.activePlayer ?? { name: 'player', position: this.botPosition(), yaw: 0, facing: 'south' as const };
    const result = survey(this.world, player, this.botPosition(), radius);
    if (this.styleOverride) result.suggestedStyle = this.styleOverride;
    return result;
  }

  async build(bp: Blueprint, opts: { origin?: Vec3; rotate?: 0 | 90 | 180 | 270; note?: string }): Promise<BuildOutcome> {
    const player = this.activePlayer ?? { name: 'player', position: this.botPosition(), yaw: 0, facing: 'south' as const };
    if (this.styleOverride && !bp.palette) bp.palette = this.styleOverride;

    const terrain = sampleTerrain(this.world, player.position, 72);
    const site = survey(this.world, player, this.botPosition(), 32);
    const origin = opts.origin ?? site.suggestedOrigin;
    const rotate = opts.rotate ?? site.suggestedRotation;

    const compiled = place(bp, origin, {
      rotate, terrain,
      compile: { palettes: this.customStyles },
    });
    return this.execute(compiled, opts.note);
  }

  async buildPrefab(
    name: string,
    params: Record<string, unknown>,
    opts: { origin?: Vec3; rotate?: 0 | 90 | 180 | 270; note?: string },
  ): Promise<BuildOutcome> {
    const key = name?.toLowerCase?.() ?? '';
    const bp = getPrefab(key, params) ?? this.customBlueprints[key] ?? null;
    if (!bp) {
      const available = [...listPrefabs().map((p) => p.name), ...Object.keys(this.customBlueprints)];
      return {
        ok: false, blocks: 0, commands: 0, seconds: 0, origin: [0, 0, 0], size: [0, 0, 0],
        warnings: [], errors: [`Unknown structure "${name}". Available: ${available.join(', ')}`],
      };
    }
    return this.build(bp, opts);
  }

  private async execute(compiled: CompiledBuild, note?: string): Promise<BuildOutcome> {
    const job = this.current;
    if (job) {
      job.commands = compiled.commands.length;
      job.size = buildSize(compiled);
      job.origin = compiled.stats.bounds.min;
      job.warnings = compiled.stats.warnings;
      job.status = 'building';
      job.phase = 'building';
      this.emitState();
    }

    this.emit('build_start', {
      name: compiled.name,
      commands: compiled.commands.length,
      blocks: compiled.stats.solidVoxels,
      size: buildSize(compiled),
    });

    const result = await this.executor.run(compiled, this.world);

    if (result.snapshot) {
      this.undoStack.push({ snapshot: result.snapshot, job: job! });
      while (this.undoStack.length > (this.opts.maxUndo ?? 10)) this.undoStack.shift();
      if (job) job.snapshotId = result.snapshot.id;
    }

    this.totals.builds++;
    this.totals.blocks += result.blocksChanged;
    this.totals.commands += result.commands;

    if (job && this.opts.previews !== false) {
      try {
        job.previewSvg = renderIsoSvg(compiled, { scale: 4, maxVoxels: 40_000, background: '#12141a' });
      } catch { /* a preview is never worth failing a build over */ }
    }

    const size = buildSize(compiled);
    this.log(
      `${compiled.name}: ${result.blocksChanged.toLocaleString()} blocks, ` +
      `${result.commands} commands, ${(result.elapsedMs / 1000).toFixed(1)}s, ` +
      `${result.commandsPerSecond}/s${result.failures ? `, ${result.failures} failures` : ''}`,
      result.failures ? 'warn' : 'info',
    );
    if (note) this.emit('note', note);

    return {
      ok: result.ok,
      blocks: result.blocksChanged,
      commands: result.commands,
      seconds: result.elapsedMs / 1000,
      origin: compiled.stats.bounds.min,
      size,
      warnings: compiled.stats.warnings,
      errors: result.errors,
    };
  }

  // ── Undo ────────────────────────────────────────────────────────────────

  get canUndo(): boolean { return this.undoStack.length > 0; }

  async undo(): Promise<{ ok: boolean; blocks: number; label: string; error?: string }> {
    const entry = this.undoStack.pop();
    if (!entry) return { ok: false, blocks: 0, label: '', error: 'Nothing to undo.' };
    this.log(`Undoing ${entry.snapshot.label}`);
    try {
      const result = await this.executor.undo(entry.snapshot);
      this.emitState();
      return {
        ok: result.ok,
        blocks: result.blocksChanged,
        label: entry.snapshot.label,
        error: result.errors[0],
      };
    } catch (err) {
      return { ok: false, blocks: 0, label: entry.snapshot.label, error: (err as Error).message };
    }
  }

  setStyle(style: string | null): boolean {
    if (style && !PALETTES[style] && !this.customStyles[style]) return false;
    this.styleOverride = style;
    this.emitState();
    return true;
  }

  get style(): string | null { return this.styleOverride; }

  /** Compile without executing — powers the dashboard's preview. */
  preview(bp: Blueprint, origin: Vec3 = [0, 64, 0]): CompiledBuild {
    return place(bp, origin, { place: 'corner' });
  }

  costSoFar(): string { return `$${this.totals.costUsd.toFixed(4)}`; }

  estimate(tokensIn: number, tokensOut: number): number {
    if (!this.opts.llm) return 0;
    return estimateCost(this.opts.llm.model, {
      inputTokens: tokensIn, outputTokens: tokensOut, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
  }
}

/** Pull a size hint out of a plain-language request. */
export function sizeHint(prompt: string): Record<string, unknown> {
  const p = prompt.toLowerCase();
  const big = /\b(huge|giant|massive|enormous|riesig|riesige|gigantisch|gross|groß|large|epic)\b/.test(p);
  const small = /\b(small|tiny|little|modest|klein|kleine|winzig)\b/.test(p);
  if (big) return { size: 61, w: 17, d: 21, h: 8, r: 7, len: 61, base: 45, wallH: 14, towerH: 26, floors: 3 };
  if (small) return { size: 21, w: 7, d: 9, h: 4, r: 3, len: 15, base: 15, wallH: 6, towerH: 10, floors: 1 };
  return {};
}
