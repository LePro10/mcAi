/**
 * An `AgentHost` backed by the simulated world.
 *
 * This makes the entire product runnable with no Minecraft server, no Java and
 * no network: `mcai sim "build a wizard tower"` runs the real agent, the real
 * compiler and the real executor against an in-memory world and renders the
 * result. It is how the pipeline is tested, and how someone can see what mcAI
 * does before installing anything.
 */

import type { Blueprint, CompiledBuild, Vec3 } from '../core/types.js';
import { getPrefab } from '../core/prefabs.js';
import { Executor, type CommandRunner, type WorldReader } from '../daemon/executor.js';
import { place, sampleTerrain, survey, buildSize, type PlayerInfo, type SiteWorld } from '../daemon/site.js';
import type { AgentHost, BuildOutcome, SurveyResult } from '../agent/agent.js';
import { SimWorld } from './world.js';

export class SimSiteWorld implements SiteWorld {
  constructor(private readonly world: SimWorld) {}
  getBlock(x: number, y: number, z: number): string { return this.world.getBlock(x, y, z); }
  highestY(x: number, z: number, from = 320): number { return this.world.highestY(x, z, from); }
  biomeAt(): string { return 'plains'; }
}

export interface SimHostOptions {
  player?: PlayerInfo;
  batchPauseMs?: number;
  /** Called after each build with the compiled result, for rendering. */
  onBuild?(build: CompiledBuild, outcome: BuildOutcome): void;
  onProgress?(done: number, total: number): void;
}

export class SimHost implements AgentHost {
  readonly world: SimWorld;
  readonly site: SimSiteWorld;
  readonly executor: Executor;
  readonly player: PlayerInfo;
  /** Every build this host has run, newest last. */
  readonly builds: Array<{ build: CompiledBuild; outcome: BuildOutcome }> = [];

  private readonly runner: CommandRunner;
  private readonly reader: WorldReader;

  constructor(world: SimWorld, private readonly opts: SimHostOptions = {}) {
    this.world = world;
    this.site = new SimSiteWorld(world);
    this.player = opts.player ?? { name: 'Player', position: [0, world.surfaceY(0, 0) + 1, 0], yaw: 0 };
    this.runner = {
      connected: true,
      send: async (command: string) => world.execute(command).message,
    };
    this.reader = { getBlock: (x, y, z) => world.getBlock(x, y, z) };
    this.executor = new Executor(this.runner, { batchPauseMs: opts.batchPauseMs ?? 0 });
    if (opts.onProgress) {
      this.executor.on('progress', (p) => opts.onProgress?.(p.done, p.total));
    }
  }

  async survey(radius = 32): Promise<SurveyResult> {
    return survey(this.site, this.player, this.player.position, radius);
  }

  async build(bp: Blueprint, opts: { origin?: Vec3; rotate?: 0 | 90 | 180 | 270; note?: string }): Promise<BuildOutcome> {
    const terrain = sampleTerrain(this.site, this.player.position, 64);
    const origin = opts.origin ?? survey(this.site, this.player, this.player.position, 32).suggestedOrigin;
    const compiled = place(bp, origin, { rotate: opts.rotate, terrain });
    return this.execute(compiled);
  }

  async buildPrefab(
    name: string,
    params: Record<string, unknown>,
    opts: { origin?: Vec3; rotate?: 0 | 90 | 180 | 270; note?: string },
  ): Promise<BuildOutcome> {
    const bp = getPrefab(name, params);
    if (!bp) {
      return {
        ok: false, blocks: 0, commands: 0, seconds: 0,
        origin: [0, 0, 0], size: [0, 0, 0], warnings: [],
        errors: [`Unknown prefab "${name}".`],
      };
    }
    return this.build(bp, opts);
  }

  private async execute(compiled: CompiledBuild): Promise<BuildOutcome> {
    const result = await this.executor.run(compiled, this.reader);
    const outcome: BuildOutcome = {
      ok: result.ok,
      blocks: result.blocksChanged,
      commands: result.commands,
      seconds: result.elapsedMs / 1000,
      origin: compiled.stats.bounds.min,
      size: buildSize(compiled),
      warnings: compiled.stats.warnings,
      errors: result.errors,
    };
    this.builds.push({ build: compiled, outcome });
    this.opts.onBuild?.(compiled, outcome);
    return outcome;
  }
}
