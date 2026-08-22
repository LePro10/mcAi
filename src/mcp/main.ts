#!/usr/bin/env node
/**
 * MCP server.
 *
 * Exposes mcAI to any MCP client — Claude Code, Claude Desktop, Cursor, an
 * agent SDK — so you can build in Minecraft from whatever you already use.
 *
 * The tool surface is deliberately the same three the built-in agent gets,
 * plus undo and a preview. The demo's server had 26 tools whose schemas cost
 * about 3,000 tokens on every request in the host's context, and most of them
 * existed to place individual blocks — work the compiler does better.
 *
 * It talks to a running daemon over HTTP. Blueprint compilation and preview
 * work offline, so a client can design and inspect a build with no server up.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import {
  compile, getPrefab, listPrefabs, listStyles, PALETTES,
  validateBlueprint, formatIssues, renderAsciiTop, VERSION,
} from '../core/index.js';
import type { Blueprint } from '../core/types.js';

const API = (process.env.MCAI_API ?? 'http://127.0.0.1:8765').replace(/\/$/, '');
const TOKEN = process.env.MCAI_TOKEN;

async function api(path: string, method = 'GET', body?: unknown): Promise<any> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (TOKEN) headers['x-mcai-token'] = TOKEN;
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (err) {
    throw new Error(
      `Cannot reach the mcAI daemon at ${API} (${(err as Error).message}). ` +
      `Start it with "npx mcai serve", or use mc_preview to work offline.`,
    );
  }
  if (!res.ok) throw new Error(`Daemon returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const VEC3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };

const TOOLS = [
  {
    name: 'mc_survey',
    description:
      'Look at the build site in the connected Minecraft world. Returns player position and facing, ' +
      'biome, ground height and slope, nearby blocks, and a suggested origin, rotation and style. ' +
      'Call this before designing anything.',
    inputSchema: {
      type: 'object',
      properties: { radius: { type: 'number', description: 'Sample radius in blocks, 8-96. Default 32.' } },
    },
  },
  {
    name: 'mc_build',
    description:
      'Compile a Blueprint and build it in the world. Use mc_blueprint_help for the format. ' +
      'Returns blocks placed, commands used and elapsed time. Invalid blueprints come back with the ' +
      'exact field to fix.',
    inputSchema: {
      type: 'object',
      properties: {
        blueprint: { type: 'object', description: 'Blueprint document: {name, palette, parts:[...]}' },
        origin: { ...VEC3, description: 'World position for the blueprint origin. Defaults to the surveyed suggestion.' },
        rotate: { type: 'number', enum: [0, 90, 180, 270] },
      },
      required: ['blueprint'],
    },
  },
  {
    name: 'mc_prefab',
    description:
      `Build a library structure. Available: ${listPrefabs().map((p) => p.name).join(', ')}. ` +
      'Instant and needs no blueprint. Pass params to resize, e.g. {"size": 61} for a castle.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: listPrefabs().map((p) => p.name) },
        params: { type: 'object' },
        origin: VEC3,
        rotate: { type: 'number', enum: [0, 90, 180, 270] },
      },
      required: ['name'],
    },
  },
  {
    name: 'mc_preview',
    description:
      'Compile a blueprint WITHOUT building it. Returns dimensions, block count, command count, ' +
      'warnings and a top-down ASCII plan. Works with no Minecraft server running — use it to ' +
      'check a design before committing it to a world.',
    inputSchema: {
      type: 'object',
      properties: {
        blueprint: { type: 'object' },
        prefab: { type: 'string', description: 'Preview a library structure instead of a blueprint.' },
        params: { type: 'object' },
      },
    },
  },
  {
    name: 'mc_undo',
    description: 'Undo the most recent build, restoring the region exactly as it was.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mc_blueprint_help',
    description:
      'The Blueprint format: every op with its fields, the palette slots, the available styles, ' +
      'and two worked examples. Read this before writing your first blueprint.',
    inputSchema: {
      type: 'object',
      properties: { style: { type: 'string', description: 'Also return this palette\'s material slots.' } },
    },
  },
  {
    name: 'mc_status',
    description: 'Daemon health: bot and RCON connection, current build, totals and cost so far.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const server = new Server({ name: 'mcai', version: VERSION }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;

  const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
  const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

  try {
    switch (name) {
      case 'mc_survey': {
        const radius = Math.max(8, Math.min(96, Number(args.radius) || 32));
        return ok(JSON.stringify(await api(`/api/survey?radius=${radius}`)));
      }

      case 'mc_build': {
        const bp = args.blueprint as Blueprint;
        const v = validateBlueprint(bp);
        if (!v.ok) return fail(`Blueprint rejected. Fix these and try again:\n${formatIssues(v.errors)}`);
        const result = await api('/api/build_blueprint', 'POST', {
          blueprint: bp, origin: args.origin, rotate: args.rotate,
        });
        return result.ok === false ? fail(JSON.stringify(result)) : ok(JSON.stringify(result));
      }

      case 'mc_prefab': {
        const result = await api('/api/build_prefab', 'POST', {
          name: args.name, params: args.params ?? {}, origin: args.origin, rotate: args.rotate,
        });
        return result.ok === false ? fail(JSON.stringify(result)) : ok(JSON.stringify(result));
      }

      case 'mc_preview': {
        // Offline on purpose: previewing must not require a running world.
        let bp: Blueprint | null = null;
        if (typeof args.prefab === 'string') {
          bp = getPrefab(args.prefab, (args.params as Record<string, unknown>) ?? {});
          if (!bp) return fail(`Unknown structure "${args.prefab}".`);
        } else if (args.blueprint) {
          bp = args.blueprint as Blueprint;
          const v = validateBlueprint(bp);
          if (!v.ok) return fail(`Blueprint rejected:\n${formatIssues(v.errors)}`);
        } else {
          return fail('Pass either "blueprint" or "prefab".');
        }
        const built = compile(bp, { origin: [0, 64, 0] });
        const s = built.stats;
        const size = s.bounds.max.map((v2, i) => v2 - s.bounds.min[i] + 1);
        return ok(JSON.stringify({
          name: built.name,
          size: { width: size[0], height: size[1], depth: size[2] },
          blocks: s.solidVoxels,
          commands: built.commands.length,
          blocksPerCommand: s.ratio,
          compileMs: s.compileMs,
          topBlocks: Object.entries(s.blockCounts).sort((a, b) => b[1] - a[1]).slice(0, 8),
          warnings: s.warnings,
          plan: renderAsciiTop(built, 64),
        }, null, 2));
      }

      case 'mc_undo': {
        const result = await api('/api/undo', 'POST', {});
        return result.ok ? ok(JSON.stringify(result)) : fail(JSON.stringify(result));
      }

      case 'mc_blueprint_help': {
        const style = typeof args.style === 'string' ? PALETTES[args.style] : undefined;
        const { buildSystemPrompt } = await import('../agent/prompt.js');
        return ok(
          buildSystemPrompt() +
          (style ? `\n\n# Palette "${style.name}"\n${JSON.stringify(style.slots, null, 2)}` : '') +
          `\n\n# Styles\n${listStyles().map((s) => `${s.name}: ${s.description}`).join('\n')}`,
        );
      }

      case 'mc_status':
        return ok(JSON.stringify(await api('/api/state')));

      default:
        return fail(`Unknown tool "${name}".`);
    }
  } catch (err) {
    return fail(`${name} failed: ${(err as Error).message}`);
  }
});

async function main(): Promise<void> {
  console.error(`[mcai-mcp] ${VERSION} — ${TOOLS.length} tools, daemon at ${API}`);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error('[mcai-mcp] fatal:', err);
  process.exit(1);
});
