// MCP endpoint (Streamable HTTP, stateless: one server+transport per POST).
// Auth: Authorization: Bearer <token>. Job context: X-Mcai-Job header.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ENGINE_VERSION } from './config.ts';
import { allTools } from './tools/index.ts';
import { explainError, type ToolCtx, type ToolDef, type ToolEnv, type ToolOutput } from './tools/common.ts';
import type { Job } from '../agent/jobs.ts';
import { summarizeInput } from '../agent/stream.ts';

export interface McpDeps {
  token: () => string;
  env: ToolEnv;
  /** job for the X-Mcai-Job header (undefined header → ad-hoc job or null) */
  resolveJob(id: string | undefined, boxHeader?: string): Job | null;
  log?: (msg: string) => void;
}

export function tokenOk(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  const given = Buffer.from(m ? m[1]!.trim() : '');
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

function jsonRpcError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

const INSTRUCTIONS =
  'mcai = Minecraft building tools. Start with get_context. Coordinates default to LOCAL space ' +
  '(anchor = origin, -z = forward into the site, +x = right, +y = up; the front facade faces +z toward the player). ' +
  'Look at your work with render_view. Always end with finish.';

let cachedTools: ToolDef[] | null = null;
function tools(): ToolDef[] {
  return (cachedTools ??= allTools());
}

export async function runTool(def: ToolDef, args: unknown, ctx: ToolCtx): Promise<CallToolResult> {
  const { job, env } = ctx;
  const t0 = Date.now();
  job.toolCalls++;
  if (!job.active) {
    return { isError: true, content: [{ type: 'text', text: `This job has ended (${job.state}). Stop working and end your turn.` }] };
  }
  if (def.mutates && job.req.options?.mode === 'plan') {
    return { isError: true, content: [{ type: 'text', text: 'This is a PLAN job: the world must not be changed. Describe your plan to the player (say) and call finish with the plan as summary.' }] };
  }
  if (def.mutates && job.state === 'thinking') env.jobs.update(job, { state: 'building' });
  if (def.mutates && job.state === 'reviewing') env.jobs.update(job, { state: 'building' });
  try {
    const out = await def.run(args, ctx);
    const o: ToolOutput = typeof out === 'string' ? { text: out } : out;
    const content: CallToolResult['content'] = [];
    for (const img of o.images ?? []) content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
    content.push({ type: 'text', text: o.text });
    job.log('tool', { name: def.name, args: summarizeInput(args), ms: Date.now() - t0, ok: true, blocks: o.blocks, images: o.images?.length, out: o.text.slice(0, 600) });
    return { content };
  } catch (e) {
    const msg = explainError(e, ctx);
    job.log('tool', { name: def.name, args: summarizeInput(args), ms: Date.now() - t0, ok: false, error: msg.slice(0, 2000), ...(e instanceof Error && !(e.constructor.name === 'ToolError') ? { stack: e.stack?.split('\n').slice(0, 4).join(' | ') } : {}) });
    return { isError: true, content: [{ type: 'text', text: `Error: ${msg}` }] };
  }
}

export function createMcpServer(job: Job, env: ToolEnv): McpServer {
  const server = new McpServer({ name: 'mcai', version: ENGINE_VERSION }, { instructions: INSTRUCTIONS, capabilities: { tools: {} } });
  for (const def of tools()) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.input,
        annotations: { readOnlyHint: !!def.readOnly, destructiveHint: !!def.mutates, openWorldHint: false },
      },
      ((args: unknown) => runTool(def, args, { job, env })) as any,
    );
  }
  return server;
}

/** Handle /mcp. `body` = parsed JSON body (POST). */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, body: unknown, deps: McpDeps): Promise<void> {
  if (!tokenOk(req.headers.authorization, deps.token())) return jsonRpcError(res, 401, 'unauthorized: missing or wrong Bearer token');
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: POST only)' }, id: null }));
    return;
  }
  const hdr = req.headers['x-mcai-job'];
  const jobId = Array.isArray(hdr) ? hdr[0] : hdr;
  const boxHdr = req.headers['x-mcai-box'];
  const job = deps.resolveJob(jobId || undefined, Array.isArray(boxHdr) ? boxHdr[0] : boxHdr);
  if (!job) return jsonRpcError(res, 404, jobId ? `unknown job '${jobId}'` : 'missing X-Mcai-Job header');
  const server = createMcpServer(job, deps.env);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    deps.log?.(`mcp error: ${(e as Error).message}`);
    jsonRpcError(res, 500, `internal error: ${(e as Error).message}`);
  }
}
