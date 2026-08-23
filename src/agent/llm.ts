/**
 * Provider-agnostic LLM client.
 *
 * The demo hard-coded a path to one vendor's CLI binary on one developer's
 * laptop. That is not something anyone else can run. This speaks the two wire
 * formats that cover essentially every hosted and local model — Anthropic's
 * Messages API and the OpenAI chat-completions shape — so mcAI works with
 * Claude, GPT, DeepSeek, Gemini via OpenRouter, Groq, or a local Ollama with
 * nothing but an env var changed.
 */

import { resolveConfig } from './config.js';

export type Provider = 'anthropic' | 'openai';

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface AssistantTurn {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stopReason: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/**
 * USD per million tokens, matched against the model name by substring.
 *
 * These move; they are here to give an order-of-magnitude figure in the
 * dashboard, not to bill anyone. An unknown model falls back to a mid-range
 * estimate rather than silently reporting zero, which would read as free.
 */
const PRICES: Record<string, { in: number; out: number; cacheRead?: number; cacheWrite?: number }> = {
  'claude-opus': { in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet': { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku': { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6, cacheRead: 0.1 },
  'gpt-4.1': { in: 2, out: 8, cacheRead: 0.5 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4o': { in: 2.5, out: 10 },
  'o4-mini': { in: 1.1, out: 4.4 },
  'gemini-2.5-pro': { in: 1.25, out: 10 },
  'gemini-2.5-flash': { in: 0.3, out: 2.5 },
  'gemini-2.0-flash': { in: 0.1, out: 0.4 },
  'deepseek-reasoner': { in: 0.55, out: 2.19 },
  'deepseek': { in: 0.27, out: 1.1 },
  'grok-4-fast': { in: 0.2, out: 0.5 },
  'grok': { in: 3, out: 15 },
  'mistral-large': { in: 2, out: 6 },
  'mistral-small': { in: 0.2, out: 0.6 },
  'codestral': { in: 0.3, out: 0.9 },
  'llama-3.3': { in: 0.6, out: 0.8 },
  'qwen': { in: 0.4, out: 1.6 },
  'kimi': { in: 1, out: 3 },
};

/** Local providers cost nothing; do not invent a figure for them. */
const FREE_HINTS = [':', 'local-model'];

export function estimateCost(model: string, usage: Usage): number {
  // An Ollama tag like "qwen2.5-coder:14b" runs on your own hardware.
  if (FREE_HINTS.some((h) => model.includes(h))) return 0;
  // Longest match wins, so "claude-haiku" is not shadowed by a shorter key.
  const key = Object.keys(PRICES)
    .filter((k) => model.includes(k))
    .sort((a, b) => b.length - a.length)[0];
  const p = key ? PRICES[key] : { in: 1, out: 5 };
  return (
    (usage.inputTokens / 1e6) * p.in +
    (usage.outputTokens / 1e6) * p.out +
    (usage.cacheReadTokens / 1e6) * (p.cacheRead ?? p.in * 0.1) +
    (usage.cacheWriteTokens / 1e6) * (p.cacheWrite ?? p.in * 1.25)
  );
}

export interface LlmConfig {
  provider: Provider;
  model: string;
  apiKey: string;
  baseUrl: string;
  maxTokens?: number;
  temperature?: number;
  /** Wall-clock budget for a single request. */
  timeoutMs?: number;
}

/** Message shapes we keep internally; each provider adapter maps them out. */
export type Msg =
  | { role: 'user'; content: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { role: 'tool'; callId: string; name: string; content: string; isError?: boolean };

export class LlmError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) {
    super(message);
    this.name = 'LlmError';
  }
}

/**
 * Resolve a configuration.
 *
 * Kept as a thin re-export so callers do not need to know whether the answer
 * came from the environment or the saved file — see `config.ts` for the
 * precedence rules.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  return resolveConfig(env);
}

export class LlmClient {
  constructor(readonly config: LlmConfig) {}

  get model(): string { return this.config.model; }

  async complete(system: string, messages: Msg[], tools: ToolDef[]): Promise<AssistantTurn> {
    return this.config.provider === 'anthropic'
      ? this.anthropic(system, messages, tools)
      : this.openai(system, messages, tools);
  }

  private async post(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 180_000);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const msg = (err as Error).name === 'AbortError' ? 'request timed out' : (err as Error).message;
      throw new LlmError(`${this.config.provider} request failed: ${msg}`, undefined, true);
    }
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const retryable = res.status === 429 || res.status >= 500;
      throw new LlmError(
        `${this.config.provider} returned ${res.status}: ${text.slice(0, 300)}`,
        res.status,
        retryable,
      );
    }
    return res.json();
  }

  private async anthropic(system: string, messages: Msg[], tools: ToolDef[]): Promise<AssistantTurn> {
    const body = {
      model: this.config.model,
      max_tokens: this.config.maxTokens ?? 8192,
      temperature: this.config.temperature ?? 0.4,
      // Caching the system prompt matters: it holds the DSL reference and the
      // worked examples, and it is identical on every request of every build.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })),
      messages: toAnthropicMessages(messages),
    };

    const json = await this.post(
      `${this.config.baseUrl.replace(/\/$/, '')}/v1/messages`,
      { 'x-api-key': this.config.apiKey, 'anthropic-version': '2023-06-01' },
      body,
    );

    const toolCalls: ToolCall[] = [];
    let text = '';
    for (const block of json.content ?? []) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, args: block.input ?? {} });
      }
    }

    return {
      text,
      toolCalls,
      stopReason: json.stop_reason ?? 'end_turn',
      usage: {
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
        cacheReadTokens: json.usage?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: json.usage?.cache_creation_input_tokens ?? 0,
      },
    };
  }

  private async openai(system: string, messages: Msg[], tools: ToolDef[]): Promise<AssistantTurn> {
    const body = {
      model: this.config.model,
      max_tokens: this.config.maxTokens ?? 8192,
      temperature: this.config.temperature ?? 0.4,
      messages: [{ role: 'system', content: system }, ...toOpenAiMessages(messages)],
      tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })),
      tool_choice: 'auto',
    };

    const json = await this.post(
      `${this.config.baseUrl.replace(/\/$/, '')}/v1/chat/completions`,
      { authorization: `Bearer ${this.config.apiKey}` },
      body,
    );

    const choice = json.choices?.[0];
    const message = choice?.message ?? {};
    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((c: any) => ({
      id: c.id ?? `call_${Math.random().toString(36).slice(2)}`,
      name: c.function?.name ?? '',
      args: safeParse(c.function?.arguments),
    }));

    return {
      text: message.content ?? '',
      toolCalls,
      stopReason: choice?.finish_reason ?? 'stop',
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
        cacheReadTokens: json.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        cacheWriteTokens: 0,
      },
    };
  }
}

function safeParse(s: unknown): Record<string, unknown> {
  if (typeof s !== 'string') return (s as Record<string, unknown>) ?? {};
  try { return JSON.parse(s); } catch { return {}; }
}

function toAnthropicMessages(messages: Msg[]): unknown[] {
  const out: Array<{ role: string; content: unknown[] }> = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
    } else if (m.role === 'assistant') {
      const content: unknown[] = [];
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const c of m.toolCalls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
      out.push({ role: 'assistant', content });
    } else {
      // Consecutive tool results must share one user message.
      const block = { type: 'tool_result', tool_use_id: m.callId, content: m.content, is_error: m.isError ?? false };
      const last = out.at(-1);
      if (last?.role === 'user' && (last.content as any[])[0]?.type === 'tool_result') {
        (last.content as unknown[]).push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
    }
  }
  return out;
}

function toOpenAiMessages(messages: Msg[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.text || null,
        tool_calls: m.toolCalls.length
          ? m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }))
          : undefined,
      });
    } else {
      out.push({ role: 'tool', tool_call_id: m.callId, content: m.content });
    }
  }
  return out;
}
