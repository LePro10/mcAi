/**
 * The command the plugin spawns, end to end.
 *
 * `EngineProcess.java` starts exactly:
 *
 *     node dist/cli/main.js serve --plugin --port <dashboard>
 *
 * with `MCAI_BRIDGE_URL` and `MCAI_BRIDGE_TOKEN` in the environment. If that
 * contract drifts — a renamed flag, a missing case in the CLI switch — the
 * plugin installs cleanly and then does nothing, with no error a player could
 * act on. Unit tests would not catch it, because the break is in the wiring.
 *
 * So this spawns the real process against the stand-in plugin server and
 * drives a build through it the way `/mcai build` does.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { SimWorld } from '../sim/world.js';
import { SimPluginServer } from '../sim/plugin-server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRY = path.join(ROOT, 'dist/cli/main.js');
const TOKEN = 'test-token-9f3a';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('plugin mode', () => {
  let world: SimWorld;
  let plugin: SimPluginServer;
  let engine: ChildProcess;
  let output = '';
  let dashboard = 0;

  const api = (route: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${dashboard}${route}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-mcai-token': TOKEN, ...(init.headers ?? {}) },
    });

  before(async () => {
    world = new SimWorld({ relief: 6, seed: 7, enforceChunkLoading: true });
    plugin = new SimPluginServer(world, {
      token: TOKEN,
      player: { name: 'Steve', position: [0, world.surfaceY(0, 0) + 1, 0], yaw: 0 },
    });
    const bridgePort = await plugin.listen();

    // Port 0 would be simplest, but the plugin passes a fixed port, so pass
    // one too and take the small risk of a collision over testing a path the
    // plugin does not use.
    dashboard = 8790 + (process.pid % 100);

    engine = spawn(process.execPath, [ENTRY, 'serve', '--plugin', '--port', String(dashboard)], {
      cwd: ROOT,
      env: {
        ...process.env,
        MCAI_BRIDGE_URL: `http://127.0.0.1:${bridgePort}`,
        MCAI_BRIDGE_TOKEN: TOKEN,
        MCAI_HTTP_PORT: String(dashboard),
        // Never let a developer's real provider key turn this into a paid
        // request: the prefab path is what is under test.
        MCAI_PROVIDER: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    engine.stdout?.on('data', (d) => { output += String(d); });
    engine.stderr?.on('data', (d) => { output += String(d); });

    const deadline = Date.now() + 20_000;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`engine never came up. Output:\n${output}`);
      await sleep(200);
      try {
        if ((await api('/api/state')).ok) break;
      } catch { /* not listening yet */ }
    }
  });

  after(async () => {
    engine?.kill();
    await plugin?.close();
  });

  it('starts from `serve --plugin` and finds the plugin', () => {
    assert.match(output, /plugin mode/);
    // The stand-in reports a version and world, so reaching it proves the
    // bridge handshake succeeded rather than merely that the process started.
    assert.match(output, /world "world"/);
  });

  it('guards the dashboard with the token the plugin generated', async () => {
    const res = await fetch(`http://127.0.0.1:${dashboard}/api/state`);
    assert.equal(res.status, 401, 'an unauthenticated request must not reach the engine');
  });

  it('builds where the plugin says the player is standing', async () => {
    const ground = world.surfaceY(0, 0);
    const before = world.stats.blocksChanged;

    const res = await api('/api/build', {
      method: 'POST',
      body: JSON.stringify({
        prompt: 'cottage',
        at: { name: 'Steve', position: [0, ground + 1, 0], yaw: 0 },
      }),
    });
    assert.equal(res.status, 202, await res.text());

    const deadline = Date.now() + 60_000;
    for (;;) {
      assert.ok(Date.now() < deadline, `the build never finished. Output:\n${output}`);
      await sleep(200);
      const state = await (await api('/api/state')).json() as { current: unknown };
      if (!state.current) break;
    }

    const placed = world.stats.blocksChanged - before;
    assert.ok(placed > 200, `expected a cottage, got ${placed} blocks changed`);
    assert.equal(world.stats.failures, 0, 'no command should have failed');
  });

  it('sends the whole build through the plugin in batches', () => {
    const commands = plugin.batches.reduce((a, b) => a + b, 0);
    assert.ok(commands > 0, 'no commands reached the plugin');
    assert.ok(
      plugin.batches.length < commands / 20,
      `${commands} commands in ${plugin.batches.length} requests is not batching`,
    );
  });

  it('tells the player what happened, in chat', () => {
    const said = plugin.chat.map((c) => c.message);
    assert.ok(said.some((m) => /Building/i.test(m)), `no start message in ${JSON.stringify(said)}`);
    assert.ok(said.some((m) => /Done/i.test(m)), `no finish message in ${JSON.stringify(said)}`);
    // Progress and outcome go to the one player who asked, not to everyone.
    assert.ok(plugin.chat.every((c) => c.player === 'Steve'), 'chat should be addressed to the builder');
  });

  it('undoes through the same path', async () => {
    const res = await api('/api/undo', { method: 'POST', body: '{}' });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const body = JSON.parse(text) as { blocks: number };
    assert.ok(body.blocks > 0, `undo restored nothing: ${text}`);
  });
});
