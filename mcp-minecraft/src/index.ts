/**
 * MCP Server for mcAI — proxies to bot-daemon HTTP API (v3 — Performance)
 * 
 * Commands run server-side via RCON. No bot teleportation needed.
 * Bot only teleports once at build start (via /tp endpoint) for chunk loading.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API = "http://127.0.0.1:8765";
const BOT_NAME = "AIBuilder";

async function api(path: string, method = "GET", body?: any): Promise<any> {
  const opts: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API}${path}`, opts);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`BotDaemon error (${res.status}): ${err}`);
  }
  return res.json();
}

const server = new Server(
  { name: "mcai-mcp", version: "4.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "mc_get_world_state",
      description:
        "Scan a cuboid region and return all non-air blocks with coordinates and block names. Use this BEFORE building to understand terrain, existing structures, and what's around. Max 50000 blocks.",
      inputSchema: {
        type: "object",
        properties: {
          x1: { type: "number" }, y1: { type: "number" }, z1: { type: "number" },
          x2: { type: "number" }, y2: { type: "number" }, z2: { type: "number" },
        },
        required: ["x1", "y1", "z1", "x2", "y2", "z2"],
      },
    },
    {
      name: "mc_get_player_position",
      description:
        "Get the current coordinates of a player. Use this to determine WHERE to build — always build relative to the player's position.",
      inputSchema: {
        type: "object",
        properties: { username: { type: "string" } },
        required: ["username"],
      },
    },
    {
      name: "mc_get_bot_position",
      description: "Get the AI bot's current position and connection status.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "mc_get_biome",
      description:
        "Get the biome at a position. CRITICAL: always check biome before choosing materials. Plains→oak, Taiga→spruce, Desert→sandstone, Jungle→jungle, Swamp→dark_oak, Savanna→acacia, Mountains→stone.",
      inputSchema: {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
        required: ["x", "y", "z"],
      },
    },
    {
      name: "mc_fill_region",
      description:
        "Fill a cuboid volume with a single block type using vanilla /fill command. Use for walls, floors, roofs, foundations. ALWAYS prefer this for areas > 1 block. Add 'hollow' as blockType suffix for hollow structures. Commands run server-side — no teleport needed.",
      inputSchema: {
        type: "object",
        properties: {
          x1: { type: "number" }, y1: { type: "number" }, z1: { type: "number" },
          x2: { type: "number" }, y2: { type: "number" }, z2: { type: "number" },
          blockType: { type: "string", description: 'Block ID, e.g. "stone_bricks" or "stone_bricks hollow" for hollow fill' },
        },
        required: ["x1", "y1", "z1", "x2", "y2", "z2", "blockType"],
      },
    },
    {
      name: "mc_setblock",
      description:
        "Place a SINGLE block at exact coordinates using /setblock. Only for fine details. For areas use mc_fill_region. Commands run server-side — no teleport needed.",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number" }, y: { type: "number" }, z: { type: "number" },
          blockType: { type: "string" },
        },
        required: ["x", "y", "z", "blockType"],
      },
    },
    {
      name: "mc_execute_command",
      description:
        "Execute ANY Minecraft command. Use for: /summon (spawn animals), /tp (teleport), /give, /clone, /fill hollow, //schem (WorldEdit). Commands run server-side via RCON.",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
    {
      name: "mc_teleport_bot",
      description:
        "Teleport the bot to a position. Use ONCE at build start to load chunks around the build site. Do NOT call before every command.",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number" }, y: { type: "number" }, z: { type: "number" },
        },
        required: ["x", "y", "z"],
      },
    },
    {
      name: "mc_scan_entities",
      description: "Scan for entities (animals, monsters, players) within radius.",
      inputSchema: {
        type: "object",
        properties: { radius: { type: "number", default: 50 } },
      },
    },
    {
      name: "mc_send_chat",
      description:
        "Send a message in Minecraft chat. Use for progress updates and final summary with token/cost report.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
    {
      name: "mc_get_build_requests",
      description:
        "Get all pending build requests. Each contains: id, player name, prompt, player position, timestamp.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "mc_mark_build_done",
      description:
        "Mark a build as completed or failed. Include result message shown to player.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["completed", "failed"] },
          result: { type: "string" },
        },
        required: ["id", "status", "result"],
      },
    },
    {
      name: "mc_check_bot_online",
      description: "Check if the bot is connected to the Minecraft server.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "mc_get_build_log",
      description: "Get recent build activity log. Shows what the AI is currently doing, phases, and recent actions. Use this to check progress or debug issues.",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number", default: 30 } },
      },
    },
    {
      name: "mc_build_structure",
      description: "Build an entire structure from a JSON definition. Handles layers, openings, interior, exterior in one call. Much faster than individual block commands. Use this as PRIMARY building method for complex structures.",
      inputSchema: {
        type: "object",
        properties: {
          structure: {
            type: "object",
            description: "JSON structure definition with origin, layers, interior, exterior. Layers have type (solid/hollow/floor/roof/frame), block, size, y_offset, openings. Interior/exterior have block and pos arrays."
          }
        },
        required: ["structure"]
      },
    },
    {
      name: "mc_get_world_state_json",
      description: "Scan a region and return structured JSON with blocks, stats, and terrain analysis. Use BEFORE building to understand the area. Returns dimensions, block_counts, surface blocks, and terrain_profile.",
      inputSchema: {
        type: "object",
        properties: {
          x1: { type: "number" }, y1: { type: "number" }, z1: { type: "number" },
          x2: { type: "number" }, y2: { type: "number" }, z2: { type: "number" }
        },
        required: ["x1", "y1", "z1", "x2", "y2", "z2"]
      },
    },
    {
      name: "mc_copy_to_clipboard",
      description: "Copy a region to clipboard for later pasting. Uses WorldEdit. Use for repetitive structures - build once, paste multiple times.",
      inputSchema: {
        type: "object",
        properties: {
          x1: { type: "number" }, y1: { type: "number" }, z1: { type: "number" },
          x2: { type: "number" }, y2: { type: "number" }, z2: { type: "number" }
        },
        required: ["x1", "y1", "z1", "x2", "y2", "z2"]
      },
    },
    {
      name: "mc_paste_from_clipboard",
      description: "Paste copied region at position. Optional rotation (0, 90, 180, 270 degrees). Must call mc_copy_to_clipboard first.",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number" }, y: { type: "number" }, z: { type: "number" },
          rotation: { type: "number", enum: [0, 90, 180, 270], default: 0 }
        },
        required: ["x", "y", "z"]
      },
    },
    {
      name: "mc_save_structure",
      description: "Save a region as a named structure file for later reuse. Creates a JSON file that can be loaded with mc_load_structure.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name for the structure (used as filename)" },
          x1: { type: "number" }, y1: { type: "number" }, z1: { type: "number" },
          x2: { type: "number" }, y2: { type: "number" }, z2: { type: "number" }
        },
        required: ["name", "x1", "y1", "z1", "x2", "y2", "z2"]
      },
    },
    {
      name: "mc_load_structure",
      description: "Load a saved structure and place it at position. Optional rotation (0, 90, 180, 270). Use mc_list_structures to see available structures.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the saved structure" },
          x: { type: "number" }, y: { type: "number" }, z: { type: "number" },
          rotation: { type: "number", enum: [0, 90, 180, 270], default: 0 }
        },
        required: ["name", "x", "y", "z"]
      },
    },
    {
      name: "mc_list_structures",
      description: "List all saved structures. Returns name, dimensions, block_count, and created date for each.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "mc_replace_blocks",
      description: "Replace all instances of one block type with another in a region. Uses /fill replace command.",
      inputSchema: {
        type: "object",
        properties: {
          x1: { type: "number" }, y1: { type: "number" }, z1: { type: "number" },
          x2: { type: "number" }, y2: { type: "number" }, z2: { type: "number" },
          from_block: { type: "string", description: "Block type to replace" },
          to_block: { type: "string", description: "Block type to replace with" }
        },
        required: ["x1", "y1", "z1", "x2", "y2", "z2", "from_block", "to_block"]
      },
    },
    {
      name: "mc_fill_pattern",
      description: "Fill a region with a pattern (checkerboard, stripes_x, stripes_z, random_mix). Provide array of blocks to cycle through.",
      inputSchema: {
        type: "object",
        properties: {
          x1: { type: "number" }, y1: { type: "number" }, z1: { type: "number" },
          x2: { type: "number" }, y2: { type: "number" }, z2: { type: "number" },
          pattern: { type: "string", enum: ["checkerboard", "stripes_x", "stripes_z", "random_mix"] },
          blocks: { type: "array", items: { type: "string" }, description: "Array of block types to use in pattern" }
        },
        required: ["x1", "y1", "z1", "x2", "y2", "z2", "pattern", "blocks"]
      },
    },
    {
      name: "mc_get_terrain_profile",
      description: "Get terrain height profile for a region. Use to adapt foundations to uneven ground. Returns surface heights, stats (min/max/avg), and is_flat flag.",
      inputSchema: {
        type: "object",
        properties: {
          x1: { type: "number" }, z1: { type: "number" },
          x2: { type: "number" }, z2: { type: "number" }
        },
        required: ["x1", "z1", "x2", "z2"]
      },
    },
    {
      name: "mc_get_style",
      description: "Get material recommendations for a building style. Returns primary/secondary/roof materials, colors, and characteristics.",
      inputSchema: {
        type: "object",
        properties: {
          style: { type: "string", enum: ["medieval", "modern", "fantasy", "japanese", "viking", "desert", "tropical"] }
        },
        required: ["style"]
      },
    },
    {
      name: "mc_list_styles",
      description: "List all available building styles with their names, descriptions, and color palettes.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "mc_get_world_state": {
        const { x1, y1, z1, x2, y2, z2 } = args as any;
        const data = await api(`/world?x1=${x1}&y1=${y1}&z1=${z1}&x2=${x2}&y2=${y2}&z2=${z2}`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      case "mc_get_player_position": {
        const { username } = args as any;
        const data = await api(`/player/${encodeURIComponent(username)}`);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
      case "mc_get_bot_position": {
        const data = await api("/status");
        return { content: [{ type: "text", text: JSON.stringify({ position: data.position, biome: data.biome, connected: data.connected }) }] };
      }
      case "mc_get_biome": {
        const { x, y, z } = args as any;
        const data = await api(`/biome?x=${x}&y=${y}&z=${z}`);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
      case "mc_fill_region": {
        const { x1, y1, z1, x2, y2, z2, blockType } = args as any;
        const cmd = `/fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${blockType}`;
        const data = await api("/command", "POST", { command: cmd });
        return { content: [{ type: "text", text: data.result || `Filled ${x1},${y1},${z1} → ${x2},${y2},${z2} with ${blockType}` }] };
      }
      case "mc_setblock": {
        const { x, y, z, blockType } = args as any;
        const data = await api("/command", "POST", { command: `/setblock ${x} ${y} ${z} ${blockType}` });
        return { content: [{ type: "text", text: data.result || `Set ${blockType} at ${x},${y},${z}` }] };
      }
      case "mc_execute_command": {
        const { command } = args as any;
        const data = await api("/command", "POST", { command });
        return { content: [{ type: "text", text: data.result || "OK" }] };
      }
      case "mc_teleport_bot": {
        const { x, y, z } = args as any;
        await api("/tp", "POST", { x, y, z });
        return { content: [{ type: "text", text: `Teleported bot to ${x},${y},${z}` }] };
      }
      case "mc_scan_entities": {
        const { radius = 50 } = (args as any) || {};
        const data = await api(`/entities?radius=${radius}`);
        return { content: [{ type: "text", text: JSON.stringify({ radius, count: data.entities?.length || 0, entities: data.entities }) }] };
      }
      case "mc_send_chat": {
        const { message } = args as any;
        await api("/chat", "POST", { message });
        return { content: [{ type: "text", text: `Sent: "${message}"` }] };
      }
      case "mc_get_build_requests": {
        const data = await api("/queue");
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
      case "mc_mark_build_done": {
        const { id, status, result } = args as any;
        const data = await api(`/queue/${id}`, "POST", { status, result });
        if (result) {
          await api("/chat", "POST", { message: result });
        }
        return { content: [{ type: "text", text: `Build ${id}: ${status}` }] };
      }
      case "mc_check_bot_online": {
        const data = await api("/status");
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
      case "mc_get_build_log": {
        const limit = (args as any)?.limit || 30;
        const data = await api(`/activity?limit=${limit}`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      case "mc_build_structure": {
        const { structure } = args as any;
        const data = await api("/structure/build", "POST", { structure });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      case "mc_get_world_state_json": {
        const { x1, y1, z1, x2, y2, z2 } = args as any;
        const data = await api(`/world_json?x1=${x1}&y1=${y1}&z1=${z1}&x2=${x2}&y2=${y2}&z2=${z2}`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      case "mc_copy_to_clipboard": {
        const { x1, y1, z1, x2, y2, z2 } = args as any;
        const data = await api("/copy", "POST", { x1, y1, z1, x2, y2, z2 });
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
      case "mc_paste_from_clipboard": {
        const { x, y, z, rotation } = args as any;
        const data = await api("/paste", "POST", { x, y, z, rotation: rotation || 0 });
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
      case "mc_save_structure": {
        const { name, x1, y1, z1, x2, y2, z2 } = args as any;
        const data = await api("/structure/save", "POST", { name, x1, y1, z1, x2, y2, z2 });
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
      case "mc_load_structure": {
        const { name, x, y, z, rotation } = args as any;
        const data = await api("/structure/load", "POST", { name, x, y, z, rotation: rotation || 0 });
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
      case "mc_list_structures": {
        const data = await api("/structures");
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      case "mc_replace_blocks": {
        const { x1, y1, z1, x2, y2, z2, from_block, to_block } = args as any;
        const data = await api("/replace", "POST", { x1, y1, z1, x2, y2, z2, from_block, to_block });
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
      case "mc_fill_pattern": {
        const { x1, y1, z1, x2, y2, z2, pattern, blocks } = args as any;
        const data = await api("/pattern", "POST", { x1, y1, z1, x2, y2, z2, pattern, blocks });
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
      case "mc_get_terrain_profile": {
        const { x1, z1, x2, z2 } = args as any;
        const data = await api(`/terrain_profile?x1=${x1}&z1=${z1}&x2=${x2}&z2=${z2}`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      case "mc_get_style": {
        const { style } = args as any;
        const data = await api(`/style/${style}`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      case "mc_list_styles": {
        const data = await api("/styles");
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (error: any) {
    return { content: [{ type: "text", text: `Error in ${name}: ${error.message}` }], isError: true };
  }
});

async function main() {
  console.error("[mcAI-MCP] MCP Server starting (v4, JSON Structure Builder, Copy/Paste, Styles)");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcAI-MCP] Ready, proxying to http://127.0.0.1:8765");
  console.error("[mcAI-MCP] New tools: mc_build_structure, mc_get_world_state_json, mc_copy_to_clipboard, mc_paste_from_clipboard, mc_save_structure, mc_load_structure, mc_list_structures, mc_replace_blocks, mc_fill_pattern, mc_get_terrain_profile, mc_get_style, mc_list_styles");
}

main().catch((err) => {
  console.error("[mcAI-MCP] Fatal:", err);
  process.exit(1);
});
