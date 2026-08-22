/**
 * The build agent.
 *
 * A deliberately short loop over a deliberately small tool surface. The old
 * system exposed 26 tools whose schemas alone cost about 3,000 tokens on every
 * request, then asked the model to drive them block by block. Here the model
 * gets three tools and normally uses two of them once each: look at the site,
 * write a blueprint. Everything else is the compiler's job.
 */

import { EventEmitter } from 'node:events';
import type { Blueprint, Vec3 } from '../core/types.js';
import { validateBlueprint, formatIssues } from '../core/blueprint.js';
import { listPrefabs } from '../core/prefabs.js';
import {
  LlmClient, LlmError, addUsage, estimateCost, ZERO_USAGE,
  type Msg, type ToolDef, type Usage,
} from './llm.js';
import { buildSystemPrompt } from './prompt.js';

export interface SurveyResult {
  player: { name: string; position: Vec3; facing: string };
  bot: { position: Vec3 };
  biome: string;
  ground: { min: number; max: number; avg: number; slope: number; flat: boolean };
  /** Suggested origin: clear ground in front of the player. */
  suggestedOrigin: Vec3;
  suggestedStyle: string;
  /** Rotation that makes the blueprint's +Z front face the player. */
  suggestedRotation: 0 | 90 | 180 | 270;
  /** What is nearby, as counts rather than a block list. */
  nearby: Record<string, number>;
  /** Space available before hitting terrain or existing structures. */
  clearRadius: number;
  notes: string[];
}

export interface BuildOutcome {
  ok: boolean;
  blocks: number;
  commands: number;
  seconds: number;
  origin: Vec3;
  size: Vec3;
  warnings: string[];
  errors: string[];
}

/** Everything the agent needs from the world. Implemented by the daemon. */
export interface AgentHost {
  survey(radius?: number): Promise<SurveyResult>;
  build(blueprint: Blueprint, opts: { origin?: Vec3; rotate?: 0 | 90 | 180 | 270; note?: string }): Promise<BuildOutcome>;
  buildPrefab(name: string, params: Record<string, unknown>, opts: { origin?: Vec3; rotate?: 0 | 90 | 180 | 270; note?: string }): Promise<BuildOutcome>;
}

const VEC3_SCHEMA = {
  type: 'array',
  items: { type: 'number' },
  minItems: 3,
  maxItems: 3,
  description: 'World coordinates [x, y, z]',
};

export const TOOLS: ToolDef[] = [
  {
    name: 'survey',
    description:
      'Look at the build site. Returns player position and facing, biome, ground height and slope, ' +
      'nearby blocks, a suggested origin and style. Call this once, first.',
    schema: {
      type: 'object',
      properties: {
        radius: { type: 'number', description: 'How far around the player to sample. Default 32, max 96.' },
      },
    },
  },
  {
    name: 'build',
    description:
      'Compile and place a blueprint. Returns how many blocks landed and any warnings. ' +
      'If the blueprint is invalid the errors come back with the exact field to fix — repair and call again.',
    schema: {
      type: 'object',
      properties: {
        blueprint: {
          type: 'object',
          description: 'The Blueprint document: {name, palette, parts:[...]}',
          properties: {
            name: { type: 'string' },
            palette: { type: 'string' },
            seed: { type: 'number' },
            materials: { type: 'object', description: 'Optional slot overrides, e.g. {"wall":"quartz_block"}' },
            parts: { type: 'array', items: { type: 'object' } },
          },
          required: ['parts'],
        },
        origin: { ...VEC3_SCHEMA, description: 'World position of the blueprint origin. Defaults to the surveyed suggestion.' },
        rotate: { type: 'number', enum: [0, 90, 180, 270], description: 'Rotate the whole build. Use the surveyed suggestion to face the player.' },
        note: { type: 'string', description: 'One short sentence shown to the player when the build finishes.' },
      },
      required: ['blueprint'],
    },
  },
  {
    name: 'prefab',
    description:
      `Build a library structure directly. Available: ${listPrefabs().map((p) => p.name).join(', ')}. ` +
      'Use this when the request maps cleanly onto one — it is instant and needs no blueprint.',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: listPrefabs().map((p) => p.name) },
        params: { type: 'object', description: 'Size parameters, e.g. {"size":61} for a castle.' },
        origin: VEC3_SCHEMA,
        rotate: { type: 'number', enum: [0, 90, 180, 270] },
        note: { type: 'string' },
      },
      required: ['name'],
    },
  },
];

export interface AgentOptions {
  maxTurns?: number;
  /** Retries for transient provider failures (429, 5xx, timeouts). */
  maxRetries?: number;
  /** Hard wall-clock budget for the whole build. */
  budgetMs?: number;
}

export interface AgentResult {
  ok: boolean;
  summary: string;
  usage: Usage;
  costUsd: number;
  turns: number;
  toolCalls: number;
  builds: BuildOutcome[];
  elapsedMs: number;
  error?: string;
}

export class Agent extends EventEmitter {
  private readonly system = buildSystemPrompt();

  constructor(
    private readonly llm: LlmClient,
    private readonly host: AgentHost,
    private readonly opts: AgentOptions = {},
  ) { super(); }

  async run(request: string, player: string): Promise<AgentResult> {
    const started = Date.now();
    const maxTurns = this.opts.maxTurns ?? 6;
    const budgetMs = this.opts.budgetMs ?? 5 * 60_000;

    const messages: Msg[] = [{
      role: 'user',
      content: `${player} asks: "${request}"\n\nSurvey the site, then build it.`,
    }];

    let usage = ZERO_USAGE;
    let toolCalls = 0;
    let turns = 0;
    const builds: BuildOutcome[] = [];
    let summary = '';

    try {
      for (turns = 1; turns <= maxTurns; turns++) {
        if (Date.now() - started > budgetMs) {
          return this.finish(false, summary || 'Out of time.', usage, turns, toolCalls, builds, started, 'time budget exceeded');
        }

        const turn = await this.completeWithRetry(messages);
        usage = addUsage(usage, turn.usage);
        this.emit('turn', { turn: turns, usage, text: turn.text });

        if (turn.text) summary = turn.text.trim();

        if (turn.toolCalls.length === 0) {
          const built = builds.some((b) => b.ok);
          return this.finish(built, summary || 'Nothing was built.', usage, turns, toolCalls, builds, started,
            built ? undefined : 'the model stopped without building anything');
        }

        messages.push({ role: 'assistant', text: turn.text, toolCalls: turn.toolCalls });

        for (const call of turn.toolCalls) {
          toolCalls++;
          this.emit('tool', { name: call.name, args: call.args });
          const { content, isError, outcome } = await this.runTool(call.name, call.args);
          if (outcome) builds.push(outcome);
          messages.push({ role: 'tool', callId: call.id, name: call.name, content, isError });
        }

        // A successful build with nothing left to fix ends the run; there is
        // no value in another round trip just to say "done".
        const last = builds.at(-1);
        if (last?.ok && last.warnings.length === 0) {
          return this.finish(true, summary || describeBuild(last), usage, turns, toolCalls, builds, started);
        }
      }

      const built = builds.some((b) => b.ok);
      return this.finish(built, summary || 'Reached the turn limit.', usage, turns, toolCalls, builds, started,
        built ? undefined : 'reached the turn limit without a successful build');
    } catch (err) {
      return this.finish(false, summary, usage, turns, toolCalls, builds, started, (err as Error).message);
    }
  }

  private finish(
    ok: boolean, summary: string, usage: Usage, turns: number, toolCalls: number,
    builds: BuildOutcome[], started: number, error?: string,
  ): AgentResult {
    return {
      ok, summary, usage,
      costUsd: estimateCost(this.llm.model, usage),
      turns, toolCalls, builds,
      elapsedMs: Date.now() - started,
      error,
    };
  }

  private async completeWithRetry(messages: Msg[]) {
    const maxRetries = this.opts.maxRetries ?? 2;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.llm.complete(this.system, messages, TOOLS);
      } catch (err) {
        lastErr = err;
        if (!(err instanceof LlmError) || !err.retryable || attempt === maxRetries) throw err;
        const delay = 800 * 2 ** attempt;
        this.emit('retry', { attempt: attempt + 1, delay, error: err.message });
        await sleep(delay);
      }
    }
    throw lastErr;
  }

  private async runTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: string; isError?: boolean; outcome?: BuildOutcome }> {
    try {
      switch (name) {
        case 'survey': {
          const radius = clampNum(args.radius, 8, 96, 32);
          const s = await this.host.survey(radius);
          return { content: JSON.stringify(s) };
        }

        case 'build': {
          const bp = args.blueprint as Blueprint | undefined;
          if (!bp || typeof bp !== 'object') {
            return { content: 'ERROR: "blueprint" must be an object with a "parts" array.', isError: true };
          }
          const v = validateBlueprint(bp);
          if (!v.ok) {
            // Hand back the precise field so the next turn is a repair, not a
            // guess. This is the difference between one retry and three.
            return {
              content: `Blueprint rejected. Fix these and call build again:\n${formatIssues(v.errors)}`,
              isError: true,
            };
          }
          const outcome = await this.host.build(bp, {
            origin: asVec3(args.origin),
            rotate: asRotation(args.rotate),
            note: typeof args.note === 'string' ? args.note : undefined,
          });
          return { content: JSON.stringify(outcome), isError: !outcome.ok, outcome };
        }

        case 'prefab': {
          const prefabName = String(args.name ?? '');
          const outcome = await this.host.buildPrefab(
            prefabName,
            (args.params as Record<string, unknown>) ?? {},
            {
              origin: asVec3(args.origin),
              rotate: asRotation(args.rotate),
              note: typeof args.note === 'string' ? args.note : undefined,
            },
          );
          return { content: JSON.stringify(outcome), isError: !outcome.ok, outcome };
        }

        default:
          return { content: `Unknown tool "${name}". Available: survey, build, prefab.`, isError: true };
      }
    } catch (err) {
      return { content: `Tool "${name}" failed: ${(err as Error).message}`, isError: true };
    }
  }
}

function describeBuild(b: BuildOutcome): string {
  return `Built ${b.blocks.toLocaleString()} blocks (${b.size[0]}x${b.size[1]}x${b.size[2]}) in ${b.seconds.toFixed(1)}s.`;
}

function clampNum(v: unknown, lo: number, hi: number, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : def;
}

function asVec3(v: unknown): Vec3 | undefined {
  if (!Array.isArray(v) || v.length !== 3) return undefined;
  const out = v.map((n) => Math.round(Number(n)));
  return out.every((n) => Number.isFinite(n)) ? (out as Vec3) : undefined;
}

function asRotation(v: unknown): 0 | 90 | 180 | 270 | undefined {
  const n = Number(v);
  return n === 0 || n === 90 || n === 180 || n === 270 ? n : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
