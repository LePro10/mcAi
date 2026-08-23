/**
 * The daemon, driven by the server plugin.
 *
 * There is no RCON connection and no bot account here. The plugin runs the
 * commands, reads the blocks and relays the chat, which means the whole setup
 * is: drop a jar in `plugins/`, start the server.
 *
 * Because `SiteWorld` is synchronous and HTTP is not, each build pre-loads the
 * area it needs — one heightmap request and one region request — and the
 * compiler then reads from that cache. It works out faster than the mineflayer
 * path it replaces, which walked columns one block at a time.
 */

import process from 'node:process';

import { VERSION, listPrefabs, PALETTES } from '../core/index.js';
import { PluginBridge } from './bridge.js';
import { BuildService } from './service.js';
import { createServer } from './server.js';
import { resolveConfig } from '../agent/config.js';

export interface BridgeDaemonOptions {
  bridgeUrl?: string;
  bridgeToken?: string;
  httpHost?: string;
  httpPort?: number;
  httpToken?: string;
  /** Radius of terrain pre-loaded before each build. */
  surveyRadius?: number;
}

const HELP = 'Commands: /mcai build <what> · /mcai undo · /mcai cancel · /mcai status';

export async function bridgeMain(opts: BridgeDaemonOptions = {}): Promise<void> {
  const bridge = new PluginBridge({ url: opts.bridgeUrl, token: opts.bridgeToken });
  const llm = resolveConfig();
  const surveyRadius = opts.surveyRadius ?? 48;

  // The plugin generates one secret and passes it in the environment. Both the
  // bridge (engine → plugin) and the dashboard (plugin → engine, and the
  // browser) authenticate with it, so there is only ever one to lose.
  const httpToken = opts.httpToken
    ?? process.env.MCAI_HTTP_TOKEN
    ?? process.env.MCAI_BRIDGE_TOKEN
    ?? undefined;
  const httpHost = opts.httpHost ?? '127.0.0.1';
  const httpPort = opts.httpPort ?? Number(process.env.MCAI_HTTP_PORT ?? 8765);

  console.log(`mcAI ${VERSION} — plugin mode`);
  console.log(`  plugin      ${bridge.url}`);
  console.log(`  model       ${llm ? `${llm.model} via ${llm.provider}` : 'none — library builds only'}`);

  const info = await bridge.connect();
  if (!info.ok) {
    console.error(`\n  Cannot reach the plugin: ${info.error}\n`);
    console.error('  Install mcAI.jar in your server\'s plugins/ folder and start the server.');
    console.error('  The plugin starts this process for you; running it by hand is only for debugging.\n');
  } else {
    console.log(`  server      ${info.minecraft ?? 'unknown'} · world "${info.world ?? '?'}"`);
  }

  const service: BuildService = new BuildService(
    bridge,
    bridge,
    () => service.player,
    () => service.player?.position ?? [0, 64, 0],
    {
      llm,
      // The plugin executes a whole batch in one request, so there is no
      // round-trip cost to amortise and no reason to pause between them.
      batchSize: 512,
      batchPauseMs: 0,
      prepare: (radius) => prime(radius),
    },
  );

  /**
   * Pull the world the compiler is about to read, in two requests.
   *
   * Without this the synchronous `SiteWorld` reads would each need a network
   * round trip, which is exactly the mistake the mineflayer path made when it
   * scanned columns one block at a time.
   */
  async function prime(radius: number): Promise<void> {
    const player = service.player;
    if (!player) return;
    bridge.clearCache();
    try {
      await bridge.loadHeights(player.position, Math.max(radius, surveyRadius));
      const [px, py, pz] = player.position;
      const r = Math.min(radius, 40);
      await bridge.loadRegion([px - r, py - 2, pz - r], [px + r, py + 2, pz + r]);
    } catch (err) {
      service.log(`Could not read the world: ${(err as Error).message}`, 'warn');
    }
  }

  // ── Chat relay ──
  let lastPercent = -1;
  service.on('state', (s: { current: { progress: number; blocks: number } | null }) => {
    if (!s.current) { lastPercent = -1; return; }
    const pct = Math.floor(s.current.progress * 4) * 25;
    if (pct > lastPercent && pct > 0 && pct < 100) {
      lastPercent = pct;
      void bridge.say(`${pct}% · ${s.current.blocks.toLocaleString()} blocks`, service.player?.name);
    }
  });

  service.on('build_start', (b: { name: string; blocks: number; commands: number; size: number[] }) => {
    void bridge.say(
      `Building ${b.name}: ${b.blocks.toLocaleString()} blocks, ${b.size.join('×')}.`,
      service.player?.name,
    );
  });

  service.on('finished', (job: { status: string; error?: string; blocks: number; costUsd: number; summary?: string }) => {
    lastPercent = -1;
    const to = service.player?.name;
    if (job.status === 'done') {
      const cost = job.costUsd > 0 ? ` · $${job.costUsd.toFixed(4)}` : '';
      void bridge.say(`Done. ${job.blocks.toLocaleString()} blocks${cost}. /mcai undo to remove it.`, to);
    } else if (job.status === 'cancelled') {
      void bridge.say('Cancelled. /mcai undo to remove what landed.', to);
    } else {
      void bridge.say(`Failed: ${(job.error ?? 'unknown error').slice(0, 150)}`, to);
    }
  });

  // ── The endpoint the plugin posts player commands to ──
  const http = createServer(service, {
    host: httpHost,
    port: httpPort,
    token: httpToken,
    status: () => ({
      bot: {
        connected: bridge.connected,
        username: 'plugin',
        position: service.player?.position ?? [0, 64, 0],
        players: bridge.info.players ?? [],
      },
      rcon: {
        connected: bridge.connected,
        avgLatencyMs: bridge.avgLatencyMs,
        sent: bridge.stats.commands,
        received: bridge.stats.requests,
        failed: bridge.stats.failures,
        reconnects: 0,
      },
      minecraft: { host: bridge.url, port: 0 },
      mode: 'plugin',
      plugin: bridge.info,
    }),
  });

  const port = await http.listen();
  const query = httpToken ? `?token=${encodeURIComponent(httpToken)}` : '';
  console.log(`  dashboard   http://${httpHost}:${port}${query}`);
  console.log(`\n  In game: ${HELP}\n`);

  service.log(`Plugin mode ready — ${listPrefabs().length} structures, ${Object.keys(PALETTES).length} styles`);

  const shutdown = async () => { await http.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
