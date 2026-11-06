// Job manager: queue, per-player single active job, global concurrency, lifecycle
// (ARCHITECTURE §8), job logs (~/.mcai/jobs/<id>.jsonl + <id>.json summary).

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Box, Dimension, Facing, PlayerInfo, Vec3 } from '../core/types.ts';
import type { Config } from '../server/config.ts';
import { paths } from '../server/config.ts';
import type { JobUpdatePayload } from '../server/protocol.ts';

export type JobState = 'queued' | 'thinking' | 'building' | 'reviewing' | 'done' | 'failed' | 'cancelled';
export const TERMINAL: ReadonlySet<JobState> = new Set(['done', 'failed', 'cancelled']);

export interface JobSize {
  x: number;
  y: number;
  z: number;
}

export interface JobRequest {
  player: PlayerInfo | { name: string; pos?: [number, number, number]; yaw?: number; pitch?: number; uuid?: string; dimension?: string };
  prompt: string;
  anchor: Vec3;
  facing: Facing;
  selection?: Box;
  dimension?: Dimension;
  /** allowed area when there is no selection (local x width, y height, z depth) */
  size?: JobSize;
  options?: { style?: string; mode?: 'build' | 'plan' };
  source?: 'mod' | 'viewer' | 'cli' | 'api' | 'test';
  model?: string;
  effort?: string;
  budgetUsd?: number;
  timeoutMin?: number;
}

export interface FinishInfo {
  summary: string;
  highlights: string[];
  suggestions: string[];
  at: number;
}

export interface AgentEvent {
  kind: 'init' | 'text' | 'tool' | 'tool_result' | 'subagent_start' | 'subagent_end' | 'result' | 'stderr' | 'raw' | 'exit';
  /** short human-readable line */
  line?: string;
  data?: Record<string, unknown>;
}

export interface RunResult {
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  costUsd: number;
  durationMs: number;
  numTurns?: number;
  resultText?: string;
  subtype?: string;
  error?: string;
}

export interface RunHandle {
  pid?: number;
  done: Promise<RunResult>;
  kill(reason?: string): void;
}

export interface Runner {
  start(job: Job, onEvent: (ev: AgentEvent) => void): RunHandle;
}

export class JobError extends Error {}

export function newJobId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${randomBytes(3).toString('hex')}`;
}

/** One build job. Tools hold a reference to it for job-scoped state. */
export class Job {
  readonly id: string;
  readonly req: JobRequest;
  readonly player: string;
  readonly dimension: Dimension;
  readonly createdAt = Date.now();
  state: JobState = 'queued';
  startedAt = 0;
  endedAt = 0;
  stage = 'Queued';
  detail = '';
  progress = 0;
  costUsd = 0;
  durationMs = 0;
  numTurns = 0;
  error = '';
  /** world-space allowed build box (set by the manager on submit) */
  allowedBox: Box;
  /** blocks changed by this job (sum over flushes) */
  blocksChanged = 0;
  toolCalls = 0;
  /** undo record ids of this job, oldest first */
  undoIds: string[] = [];
  finished: FinishInfo | null = null;
  /** job-scoped data for tools (clipboards, rate limits, ...) */
  scratch = new Map<string, unknown>();
  question: { text: string; options: string[]; resolve: (a: string | null) => void } | null = null;
  lastProgressAt = 0;
  private logStream: fs.WriteStream | null = null;

  constructor(id: string, req: JobRequest, allowedBox: Box) {
    this.id = id;
    this.req = req;
    this.player = req.player.name;
    this.dimension = req.dimension ?? req.player.dimension ?? 'minecraft:overworld';
    this.allowedBox = allowedBox;
  }

  get active(): boolean {
    return !TERMINAL.has(this.state);
  }

  get logFile(): string {
    return path.join(paths.jobs(), `${this.id}.jsonl`);
  }

  /** Append a line to the job log (never throws). */
  log(kind: string, data: Record<string, unknown> = {}): void {
    try {
      if (!this.logStream) {
        fs.mkdirSync(paths.jobs(), { recursive: true, mode: 0o700 });
        this.logStream = fs.createWriteStream(this.logFile, { flags: 'a', mode: 0o600 });
        this.logStream.on('error', () => {});
      }
      this.logStream.write(JSON.stringify({ t: Date.now(), kind, ...data }) + '\n');
    } catch {}
  }

  closeLog(): Promise<void> {
    const s = this.logStream;
    this.logStream = null;
    if (!s) return Promise.resolve();
    return new Promise((r) => s.end(r));
  }

  snapshot(): JobSnapshot {
    return {
      id: this.id,
      player: this.player,
      prompt: this.req.prompt,
      state: this.state,
      stage: this.stage,
      detail: this.detail,
      progress: this.progress,
      costUsd: this.costUsd,
      durationMs: this.durationMs || (this.startedAt ? (this.endedAt || Date.now()) - this.startedAt : 0),
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      anchor: this.req.anchor,
      facing: this.req.facing,
      selection: this.req.selection,
      allowedBox: this.allowedBox,
      dimension: this.dimension,
      blocksChanged: this.blocksChanged,
      toolCalls: this.toolCalls,
      numTurns: this.numTurns,
      undoIds: this.undoIds,
      error: this.error || undefined,
      finished: this.finished ?? undefined,
      question: this.question ? { text: this.question.text, options: this.question.options } : undefined,
      source: this.req.source ?? 'api',
    };
  }

  toUpdate(): JobUpdatePayload {
    return {
      jobId: this.id,
      player: this.player,
      state: this.state,
      progress: this.progress,
      stage: this.stage,
      detail: this.detail,
      costUsd: Math.round(this.costUsd * 10000) / 10000,
    };
  }
}

export interface JobSnapshot {
  id: string;
  player: string;
  prompt: string;
  state: JobState;
  stage: string;
  detail: string;
  progress: number;
  costUsd: number;
  durationMs: number;
  createdAt: number;
  startedAt: number;
  endedAt: number;
  anchor: Vec3;
  facing: Facing;
  selection?: Box;
  allowedBox: Box;
  dimension: string;
  blocksChanged: number;
  toolCalls: number;
  numTurns: number;
  undoIds: string[];
  error?: string;
  finished?: FinishInfo;
  question?: { text: string; options: string[] };
  source: string;
}

export interface JobManagerOptions {
  config: Config;
  runner: Runner;
  /** computes the world-space allowed box for a request */
  allowedBox: (req: JobRequest) => Box;
  /** called when a job reaches a terminal state, before the 'end' event (group undo records, ...) */
  onEnd?: (job: Job) => Promise<void> | void;
}

/**
 * Events: 'update' (job: Job) on every state/stage change; 'end' (job: Job);
 * 'agent' (job: Job, ev: AgentEvent) for every parsed agent stream event.
 */
export class JobManager extends EventEmitter {
  private jobs = new Map<string, Job>();
  private queue: Job[] = [];
  private running = new Map<string, { handle: RunHandle; timer: NodeJS.Timeout }>();
  private opts: JobManagerOptions;
  private stopping = false;

  constructor(opts: JobManagerOptions) {
    super();
    this.opts = opts;
  }

  get config(): Config {
    return this.opts.config;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  activeFor(player: string): Job | undefined {
    for (const j of this.jobs.values()) if (j.player === player && j.active) return j;
    return undefined;
  }

  /** Most recent job of a player (any state). */
  latestFor(player: string): Job | undefined {
    return this.list().find((j) => j.player === player);
  }

  /** Register an externally driven job (no runner), e.g. a manual MCP session. */
  adopt(job: Job): void {
    this.jobs.set(job.id, job);
  }

  submit(req: JobRequest): Job {
    if (this.stopping) throw new JobError('engine is shutting down');
    if (!req.prompt || !req.prompt.trim()) throw new JobError('empty prompt');
    if (req.prompt.length > 4000) throw new JobError('prompt too long (max 4000 characters)');
    const busy = this.activeFor(req.player.name);
    if (busy) throw new JobError(`${req.player.name} already has an active job (${busy.id}, ${busy.state}). Cancel it first.`);
    const job = new Job(newJobId(), req, this.opts.allowedBox(req));
    this.jobs.set(job.id, job);
    job.log('submitted', { request: req, allowedBox: job.allowedBox });
    this.queue.push(job);
    this.emit('update', job);
    this.pump();
    return job;
  }

  update(job: Job, patch: Partial<Pick<Job, 'state' | 'stage' | 'detail' | 'progress' | 'costUsd'>>): void {
    if (!job.active && patch.state === undefined) return;
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if ((job as any)[k] !== v) {
        (job as any)[k] = v;
        changed = true;
      }
    }
    if (changed) this.emit('update', job);
  }

  private pump(): void {
    while (this.running.size < this.opts.config.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      if (job.state !== 'queued') continue;
      this.startJob(job);
    }
    // queue position feedback
    this.queue.forEach((j, i) => this.update(j, { stage: `Queued (#${i + 1})` }));
  }

  private startJob(job: Job): void {
    job.startedAt = Date.now();
    this.update(job, { state: 'thinking', stage: 'Starting the architect…', progress: 0.02 });
    job.log('start', {});
    let handle: RunHandle;
    try {
      handle = this.opts.runner.start(job, (ev) => this.onAgentEvent(job, ev));
    } catch (e) {
      void this.end(job, 'failed', `could not start agent: ${(e as Error).message}`);
      return;
    }
    const timeoutMs = (job.req.timeoutMin ?? this.opts.config.jobTimeoutMin) * 60_000;
    const timer = setTimeout(() => {
      job.error = `timed out after ${Math.round(timeoutMs / 60000)} min`;
      job.log('timeout', {});
      handle.kill('timeout');
    }, timeoutMs);
    timer.unref();
    this.running.set(job.id, { handle, timer });
    handle.done.then(
      (r) => this.onRunDone(job, r),
      (e: Error) => this.onRunDone(job, { ok: false, exitCode: null, signal: null, costUsd: 0, durationMs: 0, error: e.message }),
    );
  }

  private onAgentEvent(job: Job, ev: AgentEvent): void {
    job.log('agent', { ev: ev.kind, line: ev.line, ...(ev.data ? { data: ev.data } : {}) });
    if (ev.kind === 'result' && ev.data) {
      const c = Number(ev.data.costUsd ?? 0);
      if (Number.isFinite(c)) job.costUsd = c;
      if (typeof ev.data.numTurns === 'number') job.numTurns = ev.data.numTurns;
    }
    // stage text: agent progress() calls win for a few seconds over tool activity
    if (ev.line && job.active && ev.kind !== 'raw' && ev.kind !== 'stderr' && ev.kind !== 'tool_result') {
      const recentProgress = Date.now() - job.lastProgressAt < 8000;
      if (ev.kind === 'tool' || ev.kind === 'subagent_start') {
        this.update(job, recentProgress ? { detail: ev.line } : { stage: ev.line.slice(0, 80), detail: '' });
      } else if (ev.kind === 'text') {
        this.update(job, { detail: ev.line });
      }
    }
    this.emit('agent', job, ev);
  }

  private async onRunDone(job: Job, r: RunResult): Promise<void> {
    const run = this.running.get(job.id);
    if (run) clearTimeout(run.timer);
    this.running.delete(job.id);
    job.costUsd = r.costUsd || job.costUsd;
    if (r.numTurns) job.numTurns = r.numTurns;
    job.log('exit', { ...r });
    if (job.state === 'cancelled') {
      await this.end(job, 'cancelled', job.error || 'cancelled');
    } else if (job.error && job.error.startsWith('timed out')) {
      await this.end(job, 'failed', job.error);
    } else if (r.subtype === 'error_max_budget_usd') {
      await this.end(job, job.finished ? 'done' : 'failed', `budget of $${this.budgetFor(job)} exhausted`);
    } else if (r.ok || job.finished) {
      if (!job.finished) job.detail = 'agent ended without calling finish()';
      await this.end(job, 'done', '');
    } else {
      await this.end(job, 'failed', r.error || `agent exited with code ${r.exitCode}${r.signal ? ` (${r.signal})` : ''}`);
    }
    this.pump();
  }

  budgetFor(job: Job): number {
    return job.req.budgetUsd ?? this.opts.config.budgetUsd;
  }

  private async end(job: Job, state: 'done' | 'failed' | 'cancelled', error: string): Promise<void> {
    if (TERMINAL.has(job.state) && job.endedAt) return;
    job.endedAt = Date.now();
    job.durationMs = job.endedAt - (job.startedAt || job.createdAt);
    if (error) job.error = error;
    if (job.question) {
      job.question.resolve(null);
      job.question = null;
    }
    const stage = state === 'done' ? 'Done' : state === 'cancelled' ? 'Cancelled' : `Failed: ${error}`;
    try {
      await this.opts.onEnd?.(job);
    } catch (e) {
      job.log('error', { where: 'onEnd', message: (e as Error).message });
    }
    this.update(job, { state, stage: stage.slice(0, 120), progress: state === 'done' ? 1 : job.progress });
    job.log('end', { state, error, costUsd: job.costUsd, durationMs: job.durationMs, blocksChanged: job.blocksChanged });
    this.persistSummary(job);
    await job.closeLog();
    this.emit('end', job);
  }

  private persistSummary(job: Job): void {
    try {
      fs.mkdirSync(paths.jobs(), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(paths.jobs(), `${job.id}.json`), JSON.stringify(job.snapshot(), null, 2), { mode: 0o600 });
    } catch {}
  }

  /** Cancel a queued or running job. Edits stay (undo separately). */
  async cancel(id: string, reason = 'cancelled by player'): Promise<Job> {
    const job = this.jobs.get(id);
    if (!job) throw new JobError(`no job ${id}`);
    if (!job.active) return job;
    job.error = reason;
    const run = this.running.get(id);
    if (!run) {
      // still queued
      this.queue = this.queue.filter((j) => j !== job);
      job.state = 'cancelled';
      await this.end(job, 'cancelled', reason);
      return job;
    }
    job.state = 'cancelled';
    job.log('cancel', { reason });
    this.emit('update', job);
    run.handle.kill(reason);
    await new Promise<void>((resolve) => {
      if (!this.running.has(id)) return resolve();
      const h = (j: Job) => {
        if (j === job) {
          this.off('end', h);
          resolve();
        }
      };
      this.on('end', h);
    });
    return job;
  }

  /** Agent asks the player; resolves with the answer or null on timeout/cancel. */
  ask(job: Job, text: string, options: string[], timeoutMs: number): Promise<string | null> {
    if (job.question) job.question.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(null), timeoutMs);
      const done = (a: string | null) => {
        clearTimeout(timer);
        if (job.question && job.question.resolve === done) job.question = null;
        this.emit('update', job);
        resolve(a);
      };
      job.question = { text, options, resolve: done };
      this.emit('update', job);
    });
  }

  /** Deliver a player's answer. Returns false if no question is pending. */
  answer(jobId: string, text: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || !job.question) return false;
    job.log('player_reply', { text });
    job.question.resolve(text);
    return true;
  }

  /** Stop accepting jobs, cancel everything, wait for processes to exit. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    await Promise.all(this.list().filter((j) => j.active).map((j) => this.cancel(j.id, 'engine shutting down').catch(() => {})));
  }
}
