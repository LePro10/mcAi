// Parser for `claude -p --output-format stream-json --verbose` output.
// Turns raw stream events into compact AgentEvents (activity lines for the boss bar,
// thinking snippets, subagent start/finish, final cost).

import type { AgentEvent } from './jobs.ts';

const MCP_PREFIX = 'mcp__mcai__';
export const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function count(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

/** One-line description of a tool call, suitable for an action bar. */
export function describeToolUse(name: string, input: Record<string, any> = {}): string {
  const tool = name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
  const label = typeof input.label === 'string' && input.label ? `: ${clip(input.label, 40)}` : '';
  switch (tool) {
    case 'get_context': return 'Studying the site';
    case 'scan_region': return `Surveying (${input.mode ?? 'summary'})`;
    case 'render_view': return `Looking at the build (${input.view ?? 'iso'})`;
    case 'find_blocks': return `Choosing materials (${clip(String(input.query ?? ''), 24)})`;
    case 'block_info': return `Checking ${clip(String(input.block ?? ''), 30)}`;
    case 'heightmap': return 'Measuring the terrain';
    case 'build': return `Building ${count(input.ops)} op${count(input.ops) === 1 ? '' : 's'}${label}`;
    case 'run_script': return `Running a build script${label}`;
    case 'terraform': return `Shaping terrain (${input.action ?? '?'})`;
    case 'place_prefab': return `Placing ${clip(String(input.name ?? 'prefab'), 30)}`;
    case 'clear': return 'Clearing space';
    case 'copy': return 'Copying a section';
    case 'paste': return 'Pasting a section';
    case 'stack': return `Repeating a section x${input.count ?? '?'}`;
    case 'move': return 'Moving a section';
    case 'save_structure': return `Saving structure ${clip(String(input.name ?? ''), 30)}`;
    case 'load_structure': return `Loading structure ${clip(String(input.name ?? ''), 30)}`;
    case 'list_structures': return 'Browsing the structure library';
    case 'undo': return 'Undoing a step';
    case 'say': return 'Talking to you';
    case 'progress': return clip(String(input.stage ?? 'Working'), 60);
    case 'ask_player': return 'Waiting for your answer';
    case 'finish': return 'Finishing up';
    case 'command': return `Command: ${clip(String(input.command ?? ''), 40)}`;
    case 'Read': return `Reading ${clip(String(input.file_path ?? '').split('/').pop() ?? '', 40)}`;
    case 'Glob':
    case 'Grep': return 'Looking up references';
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TodoWrite': return 'Planning';
    case 'Task':
    case 'Agent': return `Delegating to ${input.subagent_type ?? 'a helper'}${input.description ? `: ${clip(String(input.description), 40)}` : ''}`;
    default: return clip(tool, 40);
  }
}

export class StreamParser {
  private buf = '';
  private toolNames = new Map<string, string>();
  private subagents = new Map<string, string>();
  model = '';
  sessionId = '';
  tools: string[] = [];
  mcpServers: { name: string; status: string }[] = [];
  result: Record<string, any> | null = null;
  lastText = '';
  private emit: (ev: AgentEvent) => void;

  constructor(emit: (ev: AgentEvent) => void) {
    this.emit = emit;
  }

  push(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line) this.line(line);
    }
  }

  end(): void {
    const rest = this.buf.trim();
    this.buf = '';
    if (rest) this.line(rest);
  }

  private line(line: string): void {
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(line);
    } catch {
      this.emit({ kind: 'raw', line: clip(line, 200) });
      return;
    }
    this.event(ev);
  }

  event(ev: Record<string, any>): void {
    const sub = typeof ev.parent_tool_use_id === 'string' ? this.subagents.get(ev.parent_tool_use_id) : undefined;
    switch (ev.type) {
      case 'system': {
        if (ev.subtype === 'init') {
          this.model = ev.model ?? '';
          this.sessionId = ev.session_id ?? '';
          this.tools = Array.isArray(ev.tools) ? ev.tools : [];
          this.mcpServers = Array.isArray(ev.mcp_servers) ? ev.mcp_servers : [];
          this.emit({ kind: 'init', line: `Architect online (${this.model})`, data: { model: this.model, tools: this.tools, mcpServers: this.mcpServers, sessionId: this.sessionId } });
        }
        return;
      }
      case 'assistant': {
        const content = ev.message?.content;
        if (!Array.isArray(content)) return;
        for (const c of content) {
          if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
            this.lastText = c.text;
            this.emit({ kind: 'text', line: clip(c.text, 140), data: { text: c.text.slice(0, 4000), ...(sub ? { subagent: sub } : {}) } });
          } else if (c.type === 'tool_use') {
            this.toolNames.set(c.id, c.name);
            const input = (c.input ?? {}) as Record<string, any>;
            if (SUBAGENT_TOOLS.has(c.name)) {
              const who = String(input.subagent_type ?? 'general-purpose');
              this.subagents.set(c.id, who);
              this.emit({ kind: 'subagent_start', line: describeToolUse(c.name, input), data: { id: c.id, subagent: who, description: input.description } });
            } else {
              const line = (sub ? `[${sub}] ` : '') + describeToolUse(c.name, input);
              this.emit({ kind: 'tool', line, data: { id: c.id, name: c.name, input: summarizeInput(input), ...(sub ? { subagent: sub } : {}) } });
            }
          }
        }
        return;
      }
      case 'user': {
        const content = ev.message?.content;
        if (!Array.isArray(content)) return;
        for (const c of content) {
          if (c.type !== 'tool_result') continue;
          const name = this.toolNames.get(c.tool_use_id) ?? '?';
          const text = toolResultText(c.content);
          if (this.subagents.has(c.tool_use_id)) {
            const who = this.subagents.get(c.tool_use_id)!;
            this.subagents.delete(c.tool_use_id);
            this.emit({ kind: 'subagent_end', line: `${who} finished`, data: { id: c.tool_use_id, subagent: who, isError: !!c.is_error, text: clip(text, 400) } });
          } else {
            this.emit({ kind: 'tool_result', line: clip(text, 160), data: { id: c.tool_use_id, name, isError: !!c.is_error } });
          }
        }
        return;
      }
      case 'result': {
        this.result = ev;
        this.emit({
          kind: 'result',
          line: `${ev.subtype ?? 'result'}: $${Number(ev.total_cost_usd ?? 0).toFixed(3)}`,
          data: {
            subtype: ev.subtype,
            isError: !!ev.is_error,
            costUsd: Number(ev.total_cost_usd ?? 0),
            durationMs: ev.duration_ms,
            numTurns: ev.num_turns,
            result: typeof ev.result === 'string' ? ev.result.slice(0, 4000) : undefined,
            errors: ev.errors,
          },
        });
        return;
      }
      default:
        return;
    }
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c: any) => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[image]' : '')).join(' ');
  }
  return '';
}

/** Keep logs small: truncate long strings/arrays in tool inputs. */
export function summarizeInput(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return v.length > 300 ? v.slice(0, 300) + `…(+${v.length - 300})` : v;
  if (Array.isArray(v)) {
    const head = v.slice(0, 20).map((x) => summarizeInput(x, depth + 1));
    if (v.length > 20) head.push(`…(+${v.length - 20} more)`);
    return head;
  }
  if (v && typeof v === 'object') {
    if (depth > 4) return '{…}';
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = summarizeInput(x, depth + 1);
    return o;
  }
  return v;
}
