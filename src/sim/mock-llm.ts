/**
 * A scriptable LLM server speaking both wire formats.
 *
 * Lets the agent loop be tested for real — tool schemas, message threading,
 * retries, error feedback, token accounting — without spending money or
 * depending on a provider being up.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ScriptedTurn {
  text?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  /** Respond with this HTTP status instead, to exercise retries. */
  status?: number;
  usage?: { input: number; output: number };
}

export class MockLlmServer {
  private server: http.Server;
  private index = 0;
  port = 0;

  /** Every request body the server received, for assertions. */
  readonly requests: any[] = [];

  constructor(private script: ScriptedTurn[]) {
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  setScript(script: ScriptedTurn[]): void {
    this.script = script;
    this.index = 0;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed: any = {};
      try { parsed = JSON.parse(body); } catch { /* ignore */ }
      this.requests.push(parsed);

      const turn = this.script[Math.min(this.index, this.script.length - 1)] ?? {};
      this.index++;

      if (turn.status && turn.status >= 400) {
        res.writeHead(turn.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'scripted failure' } }));
        return;
      }

      const isAnthropic = req.url?.includes('/v1/messages');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(isAnthropic ? this.anthropicBody(turn) : this.openaiBody(turn)));
    });
  }

  private anthropicBody(turn: ScriptedTurn): unknown {
    const content: unknown[] = [];
    if (turn.text) content.push({ type: 'text', text: turn.text });
    for (const [i, c] of (turn.toolCalls ?? []).entries()) {
      content.push({ type: 'tool_use', id: `toolu_${this.index}_${i}`, name: c.name, input: c.args });
    }
    return {
      id: 'msg_mock',
      type: 'message',
      role: 'assistant',
      content,
      stop_reason: turn.toolCalls?.length ? 'tool_use' : 'end_turn',
      usage: {
        input_tokens: turn.usage?.input ?? 1200,
        output_tokens: turn.usage?.output ?? 300,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
  }

  private openaiBody(turn: ScriptedTurn): unknown {
    return {
      id: 'chatcmpl-mock',
      choices: [{
        index: 0,
        finish_reason: turn.toolCalls?.length ? 'tool_calls' : 'stop',
        message: {
          role: 'assistant',
          content: turn.text ?? null,
          tool_calls: (turn.toolCalls ?? []).map((c, i) => ({
            id: `call_${this.index}_${i}`,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        },
      }],
      usage: {
        prompt_tokens: turn.usage?.input ?? 1200,
        completion_tokens: turn.usage?.output ?? 300,
      },
    };
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
