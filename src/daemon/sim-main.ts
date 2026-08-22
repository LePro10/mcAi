/**
 * The daemon, wired to the simulated world instead of a Minecraft server.
 *
 * Same service, same dashboard, same agent — only the world underneath differs.
 * It means someone can run `npx mcai serve --sim`, open the dashboard and watch
 * builds happen before deciding whether to set up a server, and it means the
 * dashboard can be developed and screenshotted without Java in the loop.
 */

import { VERSION } from '../core/index.js';
import { SimWorld } from '../sim/world.js';
import { SimSiteWorld } from '../sim/host.js';
import { BuildService } from './service.js';
import { createServer } from './server.js';
import { configFromEnv } from '../agent/llm.js';
import type { PlayerInfo } from './site.js';

export interface SimDaemonOptions {
  port?: number;
  host?: string;
  seed?: number;
  relief?: number;
  token?: string;
  /** Slow the executor down so progress is visible in the dashboard. */
  batchPauseMs?: number;
}

export async function simMain(opts: SimDaemonOptions = {}): Promise<void> {
  const world = new SimWorld({
    relief: opts.relief ?? 6,
    seaLevel: 64,
    seed: opts.seed ?? 7,
    enforceChunkLoading: true,
  });
  const site = new SimSiteWorld(world);
  const llm = configFromEnv();

  const player: PlayerInfo = {
    name: 'you',
    position: [0, world.surfaceY(0, 0) + 1, 0],
    yaw: 0,
    facing: 'south',
  };

  const service = new BuildService(
    site,
    { connected: true, send: async (c) => world.execute(c).message },
    () => player,
    () => player.position,
    {
      llm,
      // A real server takes seconds; without a pause the simulator finishes
      // before a progress bar can render, which makes the dashboard look broken.
      batchPauseMs: opts.batchPauseMs ?? 60,
      batchSize: 96,
    },
  );

  const http = createServer(service, {
    host: opts.host ?? '127.0.0.1',
    port: opts.port ?? 8765,
    token: opts.token,
    status: () => ({
      bot: { connected: true, username: 'simulator', position: player.position, players: [player.name] },
      rcon: { connected: true, avgLatencyMs: 0, sent: world.stats.commands, received: world.stats.commands, failed: world.stats.failures, reconnects: 0 },
      minecraft: { host: 'simulator', port: 0 },
      simulated: true,
    }),
  });

  const port = await http.listen();
  service.log(`Simulated world ready (seed ${opts.seed ?? 7}, ground ${world.surfaceY(0, 0)})`);
  service.log(llm ? `Model: ${llm.model} via ${llm.provider}` : 'No model configured — library builds only');

  console.log(`mcAI ${VERSION} — simulated world`);
  console.log(`  dashboard   http://${opts.host ?? '127.0.0.1'}:${port}${opts.token ? `?token=${opts.token}` : ''}`);
  console.log(`  model       ${llm ? `${llm.model} via ${llm.provider}` : 'none — library builds only'}`);
  console.log('\n  No Minecraft server needed. Builds run in memory and render in the dashboard.\n');

  const shutdown = async () => { await http.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
