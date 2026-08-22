#!/usr/bin/env node
/**
 * mcAI command line.
 *
 * The important one is `sim`: it runs the real agent against the simulated
 * world and writes a picture of what came out. You can evaluate the whole
 * system — prompt, blueprint, compiler, executor — without Minecraft, without
 * Java, and without spending a cent if you stick to prefabs.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  compile, getPrefab, listPrefabs, listStyles, matchPrefab, PALETTES,
  renderAsciiFront, renderAsciiTop, renderIsoSvg, validateBlueprint, formatIssues,
  VERSION,
} from '../core/index.js';
import type { Blueprint, CompiledBuild } from '../core/types.js';
import { SimWorld } from '../sim/world.js';
import { SimHost } from '../sim/host.js';
import { Agent } from '../agent/agent.js';
import { LlmClient, configFromEnv, estimateCost } from '../agent/llm.js';
import { buildSystemPrompt } from '../agent/prompt.js';
import { place, sampleTerrain } from '../daemon/site.js';
import { SimSiteWorld } from '../sim/host.js';

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out.flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('-')) out.flags[k] = argv[++i];
      else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

const num = (v: unknown, def: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

function fmt(n: number): string { return n.toLocaleString('en-US'); }

// ── Commands ──────────────────────────────────────────────────────────────

function cmdHelp(): void {
  console.log(`
${C.bold(`mcAI ${VERSION}`)} — natural-language Minecraft builder

${C.bold('USAGE')}
  mcai <command> [options]

${C.bold('COMMANDS')}
  sim <prompt>        Run a build in a simulated world and render the result.
                      Uses an LLM if one is configured, otherwise prefabs only.
  render <what>       Render a prefab or a blueprint file to SVG / ASCII.
  bench               Compile every prefab and report size and compression.
  doctor              Check configuration, provider and server reachability.
  prefabs             List the built-in structures.
  styles              List the style palettes.
  prompt              Print the system prompt sent to the model.
  serve               Start the bot daemon (same as mcai-daemon).

${C.bold('OPTIONS')}
  --out <file>        Write SVG output to a file.
  --ascii             Print ASCII art instead of writing SVG.
  --seed <n>          World and texture seed.
  --relief <n>        Terrain roughness for the simulator (0 = superflat).
  --scale <n>         Pixels per block in the SVG.
  --detail <level>    Texture granularity: off | low | med | high.
  --style <name>      Force a style palette.
  --params <json>     Prefab parameters, e.g. --params '{"size":61}'
  --json              Machine-readable output.

${C.bold('EXAMPLES')}
  mcai sim "a huge medieval castle on a hill" --out castle.svg
  mcai render castle --params '{"size":61}' --ascii
  mcai bench
  mcai doctor
`.trimStart());
}

function cmdPrefabs(args: Args): void {
  const list = listPrefabs();
  if (args.flags.json) { console.log(JSON.stringify(list, null, 2)); return; }
  console.log(C.bold(`\n${list.length} built-in structures\n`));
  for (const p of list) {
    const params = Object.entries(p.params).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`  ${C.cyan(p.name.padEnd(12))} ${p.summary}`);
    console.log(`  ${' '.repeat(12)} ${C.dim(params)}\n`);
  }
}

function cmdStyles(args: Args): void {
  const list = listStyles();
  if (args.flags.json) { console.log(JSON.stringify(list, null, 2)); return; }
  console.log(C.bold(`\n${list.length} style palettes\n`));
  for (const s of list) {
    console.log(`  ${C.cyan(s.name.padEnd(12))} ${s.description}`);
    const hints = PALETTES[s.name]?.hints ?? [];
    for (const h of hints) console.log(`  ${' '.repeat(12)} ${C.dim(h)}`);
    console.log();
  }
}

function cmdBench(args: Args): void {
  const rows: Array<Record<string, unknown>> = [];
  let totalVox = 0, totalCmd = 0, totalMs = 0;

  for (const { name } of listPrefabs()) {
    const bp = getPrefab(name)!;
    const t0 = Date.now();
    const b = compile(bp, { origin: [0, 64, 0], detail: args.flags.detail as never });
    const ms = Date.now() - t0;
    const size = b.stats.bounds.max.map((v, i) => v - b.stats.bounds.min[i] + 1);
    rows.push({
      name, blocks: b.stats.voxels, commands: b.commands.length,
      ratio: b.stats.ratio, ms, size: size.join('x'),
      warnings: b.stats.warnings.length,
    });
    totalVox += b.stats.voxels; totalCmd += b.commands.length; totalMs += ms;
  }

  if (args.flags.json) { console.log(JSON.stringify(rows, null, 2)); return; }

  console.log(C.bold('\n  structure      blocks   commands   blocks/cmd    ms   size'));
  console.log(C.dim('  ' + '─'.repeat(64)));
  for (const r of rows) {
    console.log(
      `  ${String(r.name).padEnd(13)}` +
      `${fmt(r.blocks as number).padStart(7)}` +
      `${fmt(r.commands as number).padStart(11)}` +
      `${String(r.ratio).padStart(13)}` +
      `${String(r.ms).padStart(6)}   ${C.dim(String(r.size))}`,
    );
  }
  console.log(C.dim('  ' + '─'.repeat(64)));
  console.log(
    `  ${'total'.padEnd(13)}${fmt(totalVox).padStart(7)}${fmt(totalCmd).padStart(11)}` +
    `${(totalVox / totalCmd).toFixed(1).padStart(13)}${String(totalMs).padStart(6)}\n`,
  );
  console.log(C.dim(`  ${(totalVox / totalCmd).toFixed(1)} blocks per command means a build lands in one round trip`));
  console.log(C.dim(`  for every ${Math.round(totalVox / totalCmd)} blocks, instead of one per block.\n`));
}

function loadBlueprint(what: string, args: Args): Blueprint | null {
  if (fs.existsSync(what)) {
    try {
      const bp = JSON.parse(fs.readFileSync(what, 'utf8')) as Blueprint;
      const v = validateBlueprint(bp);
      if (!v.ok) {
        console.error(C.red('Blueprint is invalid:\n') + formatIssues(v.errors));
        return null;
      }
      return bp;
    } catch (err) {
      console.error(C.red(`Could not read ${what}: ${(err as Error).message}`));
      return null;
    }
  }
  const name = matchPrefab(what) ?? what;
  let params: Record<string, unknown> = {};
  if (typeof args.flags.params === 'string') {
    try { params = JSON.parse(args.flags.params); } catch {
      console.error(C.red('--params must be valid JSON'));
      return null;
    }
  }
  const bp = getPrefab(name, params);
  if (!bp) {
    console.error(C.red(`Unknown prefab "${what}". Try: ${listPrefabs().map((p) => p.name).join(', ')}`));
    return null;
  }
  if (typeof args.flags.style === 'string') bp.palette = args.flags.style;
  return bp;
}

function emit(build: CompiledBuild, args: Args, label: string): void {
  const stats = build.stats;
  console.log(
    `\n  ${C.bold(label)}  ${fmt(stats.voxels)} blocks  ${C.dim('·')}  ` +
    `${fmt(build.commands.length)} commands  ${C.dim('·')}  ` +
    `${stats.ratio} blocks/cmd  ${C.dim('·')}  ${stats.compileMs}ms`,
  );
  const size = stats.bounds.max.map((v, i) => v - stats.bounds.min[i] + 1);
  console.log(C.dim(`  ${size.join(' x ')} blocks  ·  origin ${stats.bounds.min.join(', ')}`));
  for (const w of stats.warnings) console.log(C.yellow(`  warning: ${w}`));

  if (args.flags.ascii || (!args.flags.out && process.stdout.isTTY)) {
    console.log(C.dim('\n  top-down'));
    console.log(renderAsciiTop(build, Math.min(100, (process.stdout.columns ?? 80) - 4)));
    console.log(C.dim('\n  elevation'));
    console.log(renderAsciiFront(build, Math.min(100, (process.stdout.columns ?? 80) - 4)));
  }

  const out = typeof args.flags.out === 'string' ? args.flags.out : null;
  if (out) {
    const svg = renderIsoSvg(build, {
      scale: num(args.flags.scale, 5),
      background: (args.flags.bg as string) ?? '#12141a',
    });
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, svg);
    console.log(C.green(`\n  wrote ${out} (${fmt(svg.length)} bytes)`));
  }
  console.log();
}

function cmdRender(args: Args): void {
  const what = args._[0];
  if (!what) { console.error(C.red('Usage: mcai render <prefab|blueprint.json>')); process.exit(1); }
  const bp = loadBlueprint(what, args);
  if (!bp) process.exit(1);
  const build = compile(bp, {
    origin: [0, 64, 0],
    seed: num(args.flags.seed, 0),
    detail: args.flags.detail as never,
  });
  emit(build, args, bp.name ?? what);
}

async function cmdSim(args: Args): Promise<void> {
  const prompt = args._.join(' ').trim();
  if (!prompt) { console.error(C.red('Usage: mcai sim "<what to build>"')); process.exit(1); }

  const world = new SimWorld({
    relief: num(args.flags.relief, 6),
    seaLevel: 64,
    seed: num(args.flags.seed, 7),
    enforceChunkLoading: true,
  });
  const site = new SimSiteWorld(world);
  const player = { name: 'you', position: [0, world.surfaceY(0, 0) + 1, 0] as [number, number, number], yaw: 0 };
  const host = new SimHost(world, { player, batchPauseMs: 0 });

  console.log(`\n  ${C.dim('world')}  seed ${world.surfaceY(0, 0)}m ground, relief ${num(args.flags.relief, 6)}`);
  console.log(`  ${C.dim('ask')}    ${C.bold(prompt)}`);

  const config = configFromEnv();
  let built: CompiledBuild | null = null;
  const t0 = Date.now();

  if (config && !args.flags.offline) {
    console.log(`  ${C.dim('model')}  ${config.model} ${C.dim(`via ${config.provider}`)}\n`);
    const agent = new Agent(new LlmClient(config), host);
    agent.on('tool', (t: { name: string }) => process.stdout.write(C.dim(`  → ${t.name}\n`)));
    const result = await agent.run(prompt, player.name);

    if (!result.ok) {
      console.error(C.red(`\n  build failed: ${result.error ?? 'unknown error'}`));
      if (host.builds.length === 0) process.exit(1);
    }
    built = host.builds.at(-1)?.build ?? null;
    const u = result.usage;
    console.log(
      `\n  ${C.dim('tokens')} ${fmt(u.inputTokens)} in ${C.dim('·')} ${fmt(u.outputTokens)} out` +
      `${u.cacheReadTokens ? ` ${C.dim('·')} ${fmt(u.cacheReadTokens)} cached` : ''}` +
      `  ${C.dim('·')}  ${C.green(`$${estimateCost(config.model, u).toFixed(4)}`)}` +
      `  ${C.dim('·')}  ${result.turns} turns`,
    );
    if (result.summary) console.log(`  ${C.dim('says')}   ${result.summary}`);
  } else {
    // No provider configured: fall back to the prefab library. This path still
    // produces a real building, which matters — trying mcAI should not require
    // signing up for anything.
    const name = matchPrefab(prompt);
    if (!name) {
      console.error(C.red(`\n  No LLM configured and "${prompt}" does not match a prefab.`));
      console.error(C.dim(`  Set ANTHROPIC_API_KEY (or OPENAI_API_KEY, DEEPSEEK_API_KEY, OLLAMA_HOST),`));
      console.error(C.dim(`  or try one of: ${listPrefabs().map((p) => p.name).join(', ')}\n`));
      process.exit(1);
    }
    console.log(`  ${C.dim('model')}  ${C.yellow('none configured')} — matched prefab "${name}"\n`);
    const bp = getPrefab(name)!;
    if (typeof args.flags.style === 'string') bp.palette = args.flags.style;
    const terrain = sampleTerrain(site, player.position, 64);
    built = place(bp, [0, player.position[1], 14], { terrain, detail: args.flags.detail } as never);
    const outcome = await host.build(bp, {});
    if (!outcome.ok) console.error(C.red(`  errors: ${outcome.errors.join(' | ')}`));
    built = host.builds.at(-1)?.build ?? built;
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `  ${C.dim('world')}  ${fmt(world.stats.blocksChanged)} blocks placed via ` +
    `${fmt(world.stats.commands)} commands ${C.dim('·')} ` +
    `${world.stats.failures === 0 ? C.green('0 failures') : C.red(`${world.stats.failures} failures`)} ` +
    `${C.dim('·')} ${elapsed}s total`,
  );

  if (built) emit(built, args, 'result');
  if (world.stats.failures > 0) process.exitCode = 1;
}

async function cmdDoctor(args: Args): Promise<void> {
  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  const check = (name: string, ok: boolean, detail: string) => results.push({ name, ok, detail });

  const [major] = process.versions.node.split('.').map(Number);
  check('node', major >= 20, `v${process.versions.node}${major >= 20 ? '' : ' — mcAI needs 20 or newer'}`);

  const config = configFromEnv();
  check('llm provider', !!config,
    config ? `${config.provider} · ${config.model}` : 'none found — prefabs still work, freeform prompts will not');

  if (config) {
    const masked = config.apiKey.length > 8 ? `${config.apiKey.slice(0, 4)}…${config.apiKey.slice(-2)}` : 'set';
    check('api key', config.apiKey !== 'not-needed', `${masked} · ${config.baseUrl}`);
  }

  // Compiler self-test: a real build has to come out the far end.
  try {
    const b = compile(getPrefab('castle')!, { origin: [0, 64, 0] });
    check('compiler', b.stats.voxels > 10_000 && b.commands.length > 0,
      `castle → ${fmt(b.stats.voxels)} blocks in ${fmt(b.commands.length)} commands (${b.stats.compileMs}ms)`);
  } catch (err) {
    check('compiler', false, (err as Error).message);
  }

  // Simulated end-to-end build.
  try {
    const world = new SimWorld({ relief: 4, enforceChunkLoading: true });
    const host = new SimHost(world, { batchPauseMs: 0 });
    const outcome = await host.buildPrefab('cottage', {}, {});
    check('build pipeline', outcome.ok && outcome.blocks > 200,
      `cottage → ${fmt(outcome.blocks)} blocks, ${outcome.errors.length} errors`);
  } catch (err) {
    check('build pipeline', false, (err as Error).message);
  }

  const host = process.env.MC_HOST ?? '127.0.0.1';
  const rconPort = Number(process.env.RCON_PORT ?? 25575);
  const reachable = await probeTcp(host, rconPort, 1500);
  check('minecraft rcon', reachable,
    reachable ? `${host}:${rconPort} is accepting connections`
      : `${host}:${rconPort} unreachable — start a server, or use "mcai sim"`);

  check('system prompt', true, `${fmt(buildSystemPrompt().length)} chars, cached per request`);

  if (args.flags.json) { console.log(JSON.stringify(results, null, 2)); return; }

  console.log(C.bold('\n  mcAI doctor\n'));
  for (const r of results) {
    const mark = r.ok ? C.green('ok  ') : C.yellow('warn');
    console.log(`  ${mark} ${r.name.padEnd(16)} ${C.dim(r.detail)}`);
  }
  const blocking = results.filter((r) => !r.ok && ['node', 'compiler', 'build pipeline'].includes(r.name));
  console.log();
  if (blocking.length) { console.log(C.red('  Something core is broken.\n')); process.exitCode = 1; }
  else console.log(C.green('  Ready to build.\n'));
}

function probeTcp(host: string, port: number, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    void import('node:net').then(({ Socket }) => {
      const s = new Socket();
      const done = (ok: boolean) => { s.destroy(); resolve(ok); };
      s.setTimeout(timeout);
      s.once('connect', () => done(true));
      s.once('timeout', () => done(false));
      s.once('error', () => done(false));
      s.connect(port, host);
    });
  });
}

// ── Entry ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = parseArgs(argv.slice(1));

  switch (command) {
    case 'sim': return cmdSim(args);
    case 'render': return cmdRender(args);
    case 'bench': return cmdBench(args);
    case 'doctor': return cmdDoctor(args);
    case 'prefabs': case 'list': return cmdPrefabs(args);
    case 'styles': return cmdStyles(args);
    case 'prompt': console.log(buildSystemPrompt()); return;
    case 'serve': {
      const { main: daemonMain } = await import('../daemon/main.js');
      return daemonMain();
    }
    case 'version': case '--version': case '-v': console.log(VERSION); return;
    case undefined: case 'help': case '--help': case '-h': return cmdHelp();
    default:
      console.error(C.red(`Unknown command "${command}"`));
      cmdHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(C.red(`\n${err?.stack ?? err}\n`));
  process.exit(1);
});
