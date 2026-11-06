// Spawns one headless Claude Code process per build job (ARCHITECTURE §8).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../server/config.ts';
import { AGENT_DIR, paths } from '../server/config.ts';
import type { AgentEvent, Job, RunHandle, RunResult, Runner } from './jobs.ts';
import { StreamParser } from './stream.ts';

/**
 * Built-in Claude Code tools the agent may use: read-only + subagents + todo list.
 * Verified with claude 2.1.318 (init event): the subagent tool is 'Task', todo = TaskCreate/TaskUpdate/TaskList.
 * 'Agent' and 'TodoWrite' (names in other versions) are listed too; unknown names are ignored by claude.
 */
export const BUILTIN_TOOLS = ['Read', 'Glob', 'Grep', 'Task', 'Agent', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TodoWrite'];
export const MCP_SERVER_NAME = 'mcai';

export interface EndpointInfo {
  port: number;
  token: string;
}

export interface ClaudeRunnerOptions {
  config: Config;
  endpoint: () => EndpointInfo;
  /** agent workspace (cwd of claude), default <repo>/agent */
  agentDir?: string;
  /** grace period between SIGTERM and SIGKILL */
  killGraceMs?: number;
}

export function ensureAgentDir(dir = AGENT_DIR): void {
  fs.mkdirSync(dir, { recursive: true });
  const sys = path.join(dir, 'SYSTEM.md');
  if (!fs.existsSync(sys)) {
    fs.writeFileSync(
      sys,
      `# mcAI Master Architect\n\nYou are a master Minecraft architect working through the \`mcai\` MCP tools.\n` +
        `1. Call get_context first. 2. Plan, then build with build/run_script/terraform/place_prefab.\n` +
        `3. Check your work with render_view. 4. Always end with finish (summary, highlights, suggestions).\n`,
    );
  }
}

/** Per-job context appended to the system prompt. */
export function jobContextPrompt(job: Job, cfg: Config): string {
  const b = job.allowedBox;
  const size = [b.max[0] - b.min[0] + 1, b.max[1] - b.min[1] + 1, b.max[2] - b.min[2] + 1];
  return [
    `## Current job ${job.id}`,
    `Player: ${job.player}. Anchor (local origin): ${job.req.anchor.join(',')} facing ${job.req.facing}.`,
    job.req.selection
      ? `Player's selection (primary build area, world): ${job.req.selection.min.join(',')} .. ${job.req.selection.max.join(',')}. Allowed box incl. margin for supports/terrain/paths/trees: ${b.min.join(',')} .. ${b.max.join(',')} (${size.join('x')}).`
      : `Allowed build box (world): ${b.min.join(',')} .. ${b.max.join(',')} (${size.join('x')}).`,
    `Limits: ${cfg.maxBlocksPerCall.toLocaleString('en')} blocks per tool call, ${cfg.maxBlocksPerJob.toLocaleString('en')} per job, budget $${job.req.budgetUsd ?? cfg.budgetUsd}.`,
    job.req.options?.style ? `Requested style: ${job.req.options.style}.` : '',
    job.req.options?.mode === 'plan' ? 'Mode: PLAN — do not build; describe the plan, show it with say/finish.' : '',
    'Only the mcai MCP tools change the world. Always end the job with mcp__mcai__finish.',
  ].filter(Boolean).join('\n');
}

export function userPrompt(job: Job): string {
  return `Build request from ${job.player}:\n\n${job.req.prompt.trim()}\n\nStart with get_context, then design and build it. End with finish.`;
}

export interface ClaudeInvocation {
  command: string;
  args: string[];
  stdin: string;
  mcpConfigFile: string;
}

export function buildInvocation(job: Job, cfg: Config, ep: EndpointInfo, agentDir = AGENT_DIR): ClaudeInvocation {
  const mcpConfigFile = path.join(paths.tmp(), `mcp-${job.id}.json`);
  const sysFile = path.join(agentDir, 'SYSTEM.md');
  const agentsFile = path.join(agentDir, 'agents.json');
  const sys = fs.existsSync(sysFile) ? fs.readFileSync(sysFile, 'utf8') : '';
  const args = [
    '-p',
    '--model', job.req.model ?? cfg.model,
    '--effort', job.req.effort ?? cfg.effort,
    '--output-format', 'stream-json',
    '--verbose',
    '--mcp-config', mcpConfigFile,
    '--strict-mcp-config',
    '--setting-sources', 'user',
    '--no-session-persistence',
    '--tools', BUILTIN_TOOLS.join(','),
    '--allowedTools', [`mcp__${MCP_SERVER_NAME}`, ...BUILTIN_TOOLS].join(','),
    '--permission-mode', 'dontAsk',
    '--max-budget-usd', String(job.req.budgetUsd ?? cfg.budgetUsd),
    '--append-system-prompt', `${sys.trim()}\n\n${jobContextPrompt(job, cfg)}`.trim(),
  ];
  if (fs.existsSync(agentsFile)) {
    const raw = fs.readFileSync(agentsFile, 'utf8');
    JSON.parse(raw); // validate; throws with a clear error if broken
    args.push('--agents', raw);
  }
  if (cfg.fallbackModel) args.push('--fallback-model', cfg.fallbackModel);
  args.push(...cfg.claudeExtraArgs);
  return { command: cfg.claudePath, args, stdin: userPrompt(job), mcpConfigFile };
}

export function mcpConfigJson(job: Job, ep: EndpointInfo): string {
  return JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'http',
        url: `http://127.0.0.1:${ep.port}/mcp`,
        headers: { Authorization: `Bearer ${ep.token}`, 'X-Mcai-Job': job.id },
      },
    },
  });
}

/** Redact secrets from an argv for logs. */
export function redactArgs(args: string[]): string[] {
  return args.map((a, i) => (args[i - 1] === '--append-system-prompt' ? `<${a.length} chars>` : args[i - 1] === '--agents' ? `<agents.json>` : a));
}

export class ClaudeRunner implements Runner {
  private opts: ClaudeRunnerOptions;
  private live = new Set<number>();

  constructor(opts: ClaudeRunnerOptions) {
    this.opts = opts;
    ensureAgentDir(opts.agentDir ?? AGENT_DIR);
  }

  start(job: Job, onEvent: (ev: AgentEvent) => void): RunHandle {
    const cfg = this.opts.config;
    const agentDir = this.opts.agentDir ?? AGENT_DIR;
    const ep = this.opts.endpoint();
    const inv = buildInvocation(job, cfg, ep, agentDir);
    fs.mkdirSync(paths.tmp(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(inv.mcpConfigFile, mcpConfigJson(job, ep), { mode: 0o600 });
    job.log('spawn', { command: inv.command, args: redactArgs(inv.args), cwd: agentDir });

    // allow a node script as "claude" (tests use a fake claude)
    const isScript = /\.(m?js|ts)$/.test(inv.command);
    const cmd = isScript ? process.execPath : inv.command;
    const argv = isScript ? [inv.command, ...inv.args] : inv.args;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MCAI_JOB_ID: job.id,
      MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT ?? String(20 * 60_000),
      MCP_TIMEOUT: process.env.MCP_TIMEOUT ?? '30000',
    };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    const t0 = Date.now();
    const child = spawn(cmd, argv, { cwd: agentDir, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    if (child.pid) this.live.add(child.pid);
    let stderrTail = '';
    let killed: string | null = null;
    const parser = new StreamParser(onEvent);
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => parser.push(d));
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (d: string) => {
      stderrTail = (stderrTail + d).slice(-4000);
      for (const l of d.split('\n')) if (l.trim()) onEvent({ kind: 'stderr', line: l.slice(0, 300) });
    });
    child.stdin!.on('error', () => {});
    child.stdin!.end(inv.stdin);

    const pid = child.pid;
    let killTimer: NodeJS.Timeout | null = null;
    const signalGroup = (sig: NodeJS.Signals) => {
      if (!pid) return;
      try {
        process.kill(-pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {}
      }
    };

    const done = new Promise<RunResult>((resolve) => {
      let spawnError = '';
      child.on('error', (e) => {
        spawnError = (e as NodeJS.ErrnoException).code === 'ENOENT' ? `claude executable not found: ${inv.command}` : e.message;
      });
      child.on('close', (code, signal) => {
        parser.end();
        if (pid) this.live.delete(pid);
        if (killTimer) clearTimeout(killTimer);
        // make sure no orphaned grandchildren survive
        signalGroup('SIGKILL');
        fs.rm(inv.mcpConfigFile, { force: true }, () => {});
        const r = parser.result;
        const subtype = r?.subtype as string | undefined;
        const ok = !killed && !spawnError && code === 0 && (!r || (!r.is_error && subtype === 'success'));
        const res: RunResult = {
          ok,
          exitCode: code,
          signal,
          costUsd: Number(r?.total_cost_usd ?? 0),
          durationMs: Number(r?.duration_ms ?? Date.now() - t0),
          numTurns: r?.num_turns,
          resultText: typeof r?.result === 'string' ? r.result : undefined,
          subtype,
          error: spawnError || (killed ? `killed (${killed})` : ok ? undefined : describeFailure(r, code, stderrTail)),
        };
        onEvent({ kind: 'exit', line: `agent exited (${code ?? signal})`, data: { ...res } });
        resolve(res);
      });
    });

    return {
      pid,
      done,
      kill: (reason = 'cancelled') => {
        if (killed) return;
        killed = reason;
        signalGroup('SIGTERM');
        killTimer = setTimeout(() => signalGroup('SIGKILL'), this.opts.killGraceMs ?? 5000);
        killTimer.unref();
      },
    };
  }

  /** Kill every live claude process group (engine exit). */
  killAll(): void {
    for (const pid of this.live) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
    }
    this.live.clear();
  }
}

function describeFailure(r: Record<string, any> | null, code: number | null, stderr: string): string {
  if (r?.subtype && r.subtype !== 'success') {
    const errs = Array.isArray(r.errors) ? `: ${r.errors.join('; ').slice(0, 300)}` : '';
    return `${r.subtype}${errs}`;
  }
  if (r?.is_error) return `agent error: ${String(r.result ?? '').slice(0, 300)}`;
  const tail = stderr.trim().split('\n').slice(-3).join(' | ');
  return `claude exited with code ${code}${tail ? `: ${tail.slice(0, 400)}` : ''}`;
}
