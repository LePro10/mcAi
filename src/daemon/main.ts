#!/usr/bin/env node
/**
 * The daemon: bot + RCON + build service + dashboard, wired together.
 *
 * Configuration is entirely environment driven and every value has a working
 * default, so `npx mcai serve` against a local server with RCON on needs no
 * config file at all.
 */

import process from 'node:process';

import { VERSION, listPrefabs } from '../core/index.js';
import { McBot, type ChatCommand } from './bot.js';
import { ResilientRcon } from './rcon.js';
import { BuildService } from './service.js';
import { createServer } from './server.js';
import { configFromEnv } from '../agent/llm.js';

export interface DaemonConfig {
  mcHost: string;
  mcPort: number;
  rconPort: number;
  rconPassword: string;
  username: string;
  httpHost: string;
  httpPort: number;
  httpToken?: string;
  version?: string;
  batchSize: number;
  batchPauseMs: number;
}

export function configFromEnvironment(env = process.env): DaemonConfig {
  const password = env.RCON_PASSWORD ?? env.MCAI_RCON_PASSWORD ?? '';
  return {
    mcHost: env.MC_HOST ?? '127.0.0.1',
    mcPort: Number(env.MC_PORT ?? 25565),
    rconPort: Number(env.RCON_PORT ?? 25575),
    rconPassword: password,
    username: env.MC_USERNAME ?? 'mcAI',
    httpHost: env.MCAI_HTTP_HOST ?? '127.0.0.1',
    httpPort: Number(env.MCAI_HTTP_PORT ?? 8765),
    httpToken: env.MCAI_TOKEN,
    version: env.MC_VERSION,
    batchSize: Number(env.MCAI_BATCH_SIZE ?? 192),
    batchPauseMs: Number(env.MCAI_BATCH_PAUSE_MS ?? 40),
  };
}

const HELP_LINE = 'Commands: !build <what> · !undo · !cancel · !status · !styles · !style <name>';

export async function main(): Promise<void> {
  const cfg = configFromEnvironment();
  const llm = configFromEnv();

  console.log(`mcAI ${VERSION}`);
  console.log(`  minecraft   ${cfg.mcHost}:${cfg.mcPort}  (rcon ${cfg.rconPort})`);
  console.log(`  model       ${llm ? `${llm.model} via ${llm.provider}` : 'none — prefabs only'}`);

  if (!cfg.rconPassword) {
    console.error('\nRCON_PASSWORD is not set.');
    console.error('Enable RCON in server.properties and export the password:');
    console.error('  enable-rcon=true');
    console.error('  rcon.port=25575');
    console.error('  rcon.password=<something>\n');
    process.exit(1);
  }

  const rcon = new ResilientRcon({
    host: cfg.mcHost, port: cfg.rconPort, password: cfg.rconPassword, window: 24,
  });
  const bot = new McBot({
    host: cfg.mcHost, port: cfg.mcPort, username: cfg.username, version: cfg.version,
  });

  const service = new BuildService(
    bot,
    { send: (c) => rcon.send(c), get connected() { return rcon.connected; } },
    (name) => bot.player(name),
    () => bot.position(),
    {
      llm,
      batchSize: cfg.batchSize,
      batchPauseMs: cfg.batchPauseMs,
    },
  );

  // ── Chat surface ──
  bot.on('spawn', () => {
    service.log(`Bot ${cfg.username} joined at ${bot.position().join(', ')}`);
    bot.say(`mcAI ${VERSION} ready. ${HELP_LINE}`);
  });
  bot.on('disconnected', (reason: string) => service.log(`Bot disconnected: ${reason}`, 'warn'));
  bot.on('error', (err: Error) => service.log(`Bot error: ${err.message}`, 'error'));

  bot.on('command', (cmd: ChatCommand) => { void handleChatCommand(cmd); });

  async function handleChatCommand(cmd: ChatCommand): Promise<void> {
    switch (cmd.command) {
      case 'build': case 'b': {
        if (!cmd.args) { bot.say(`Say what to build, e.g. !build a huge castle on the hill`); return; }
        if (service.busy) { bot.say(`Still building. !cancel to stop, or wait.`); return; }
        const job = service.submit(cmd.player, cmd.args);
        if (!job) { bot.say('Queue is full, try again shortly.'); return; }
        bot.say(`Planning "${cmd.args.slice(0, 60)}"…`);
        return;
      }
      case 'undo': case 'u': {
        bot.say('Undoing…');
        const r = await service.undo();
        bot.say(r.ok ? `Restored ${r.blocks.toLocaleString()} blocks (${r.label}).` : `Undo failed: ${r.error}`);
        return;
      }
      case 'cancel': case 'stop':
        bot.say(service.cancel() ? 'Cancelling.' : 'Nothing is running.');
        return;
      case 'status': case 's': {
        const job = service.currentJob;
        if (job) {
          bot.say(`${job.phase} · ${Math.round(job.progress * 100)}% · ${job.blocks.toLocaleString()} blocks placed`);
        } else {
          const t = service.totals;
          bot.say(`Idle. ${t.builds} builds, ${t.blocks.toLocaleString()} blocks, ${service.costSoFar()} spent.`);
        }
        return;
      }
      case 'styles':
        bot.say(`Styles: ${Object.keys(await import('../core/palette.js').then((m) => m.PALETTES)).join(', ')}`);
        return;
      case 'style': {
        if (!cmd.args) { bot.say(`Style is ${service.style ?? 'automatic (from biome)'}. !style <name> or !style auto`); return; }
        const next = cmd.args.toLowerCase() === 'auto' ? null : cmd.args.toLowerCase();
        bot.say(service.setStyle(next) ? `Style set to ${next ?? 'automatic'}.` : `Unknown style "${cmd.args}".`);
        return;
      }
      case 'list':
        bot.say(`Instant builds: ${listPrefabs().map((p) => p.name).join(', ')}`);
        return;
      case 'help': case 'h':
        bot.say(HELP_LINE);
        return;
      default:
        return;
    }
  }

  // ── Chat feedback from the service ──
  let lastPercent = -1;
  service.on('state', (s: { current: { progress: number; blocks: number } | null }) => {
    if (!s.current) { lastPercent = -1; return; }
    const pct = Math.floor(s.current.progress * 4) * 25;
    if (pct > lastPercent && pct > 0 && pct < 100) {
      lastPercent = pct;
      bot.say(`${pct}% · ${s.current.blocks.toLocaleString()} blocks`);
    }
  });

  service.on('build_start', (b: { name: string; blocks: number; commands: number; size: number[] }) => {
    bot.say(`Building ${b.name}: ${b.blocks.toLocaleString()} blocks, ${b.size.join('×')}, ${b.commands} commands.`);
  });

  service.on('finished', (job: { status: string; summary?: string; error?: string; blocks: number; costUsd: number; tokensIn: number; tokensOut: number }) => {
    lastPercent = -1;
    if (job.status === 'done') {
      const cost = job.costUsd > 0 ? ` · $${job.costUsd.toFixed(4)}` : '';
      bot.say(`Done. ${job.blocks.toLocaleString()} blocks${cost}. !undo if you hate it.`);
      if (job.summary) bot.say(job.summary.slice(0, 200));
    } else if (job.status === 'cancelled') {
      bot.say('Cancelled. !undo to remove what landed.');
    } else {
      bot.say(`Failed: ${(job.error ?? 'unknown error').slice(0, 150)}`);
    }
  });

  // ── Start everything ──
  const http = createServer(service, {
    host: cfg.httpHost, port: cfg.httpPort, token: cfg.httpToken,
    status: () => ({
      bot: { connected: bot.connected, username: cfg.username, position: bot.position(), players: bot.onlinePlayers() },
      rcon: { connected: rcon.connected, avgLatencyMs: rcon.avgLatencyMs, ...rcon.stats },
      minecraft: { host: cfg.mcHost, port: cfg.mcPort },
    }),
  });

  const port = await http.listen();
  console.log(`  dashboard   http://${cfg.httpHost}:${port}${cfg.httpToken ? `?token=${cfg.httpToken}` : ''}`);

  rcon.events.on('ready', () => service.log('RCON connected'));
  rcon.events.on('disconnected', (err: Error) => service.log(`RCON lost: ${err.message}`, 'warn'));

  try {
    await rcon.connect();
  } catch (err) {
    service.log(`RCON connect failed: ${(err as Error).message} — retrying in the background`, 'warn');
  }

  bot.connect();
  console.log(`\n  Join the server and type: !build a huge castle\n`);

  const shutdown = async () => {
    console.log('\nShutting down…');
    bot.quit();
    rcon.close();
    await http.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isEntry = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[/\\]/, ''));
if (isEntry) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
