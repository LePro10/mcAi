// Iteration 2 (real-Minecraft play-test): selection + margin allowed box, readBox clamping,
// isWater / groundY fallback, the per-job world cache (round trips), floating lily pads,
// support messages naming the support cell, find_blocks item hints.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { tmpHome, testConfig, MemBackend, FakeRunner } from './helpers.ts';
import { Hub, resolveAllowedBox } from '../../src/server/hub.ts';
import type { Job } from '../../src/agent/jobs.ts';
import type { HeightmapResult } from '../../src/core/types.ts';
import { Registry } from '../../src/core/registry.ts';
import type { JobWorldCache } from '../../src/server/tools/world-cache.ts';

tmpHome();
process.env.MCAI_NO_ASSETS = '1';

/** MemBackend counting real round trips */
class CountingBackend extends MemBackend {
  gets = 0;
  heights = 0;
  override async getBlocks(box: Parameters<MemBackend['getBlocks']>[0]) {
    this.gets++;
    return super.getBlocks(box);
  }
  override async heightmap(x0: number, z0: number, x1: number, z1: number, kind?: string): Promise<HeightmapResult> {
    this.heights++;
    const h = await super.heightmap(x0, z0, x1, z1);
    if (kind === 'ocean_floor') {
      // like the real game: skip fluids
      const w = x1 - x0 + 1;
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          let y = h.data[(z - z0) * w + (x - x0)]!;
          while (y > -64 && /water/.test(this.at(x, y, z))) y--;
          h.data[(z - z0) * w + (x - x0)] = y;
        }
    }
    return h;
  }
}

let hub: Hub;
let mem: CountingBackend;
let job: Job;
let client: Client;
const reg = Registry.loadDefault();
const C = (s: string) => reg.canonical(s);
// selection: world x 0..9, y 64..67 (a low 4-high box), z -9..0; anchor [0,64,0] facing north
const SEL = { min: [0, 64, -9] as [number, number, number], max: [9, 67, 0] as [number, number, number] };

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
  return { ...r, text: r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') };
}
const put = (x: number, y: number, z: number, s: string) => {
  mem.edits.set(x, 64 + y, z, C(s));
  (job.scratch.get('world') as JobWorldCache | undefined)?.invalidate();
};
const at = (x: number, y: number, z: number) => mem.at(x, 64 + y, z);

before(async () => {
  mem = new CountingBackend();
  // a pond in the selection footprint: bed at world y=56 (local −8)
  for (let x = 2; x <= 4; x++) for (let z = -4; z <= -2; z++) for (let y = 57; y <= 64; y++) mem.edits.set(x, y, z, C('water'));
  hub = new Hub({ config: testConfig({ maxBlocksPerCall: 200_000 }), backend: mem, port: 0, runner: new FakeRunner(), writeEngineJson: false, log: () => {} });
  await hub.start();
  job = await hub.submitJob({ prompt: 'a little pond house', player: 'Steve', anchor: [0, 64, 0], facing: 'north', selection: SEL }, 'test' as any);
  client = new Client({ name: 't', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hub.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${hub.token}`, 'X-Mcai-Job': job.id } } }));
});

after(async () => {
  await client?.close();
  await hub.stop();
});

test('allowed box = selection + margin, extended down to the water bed and up to the minimum height', async () => {
  const ab = job.allowedBox;
  assert.deepEqual([ab.min[0], ab.max[0], ab.min[2], ab.max[2]], [-8, 17, -17, 8]);
  assert.equal(ab.min[1], 54, 'bed y=56 − 2');
  assert.equal(ab.max[1], 64 + 32 - 1, 'low selection grows to 32 above its floor');
  const ctx = JSON.parse((await call('get_context')).text);
  assert.match(ctx.selection.world, /^\[0,64,-9\]\.\.\[9,67,0\]/);
  assert.match(ctx.selection.note, /PRIMARY build area/);
  assert.ok(ctx.allowedBox.notes.some((n: string) => /extended down to y=54/.test(n)));
  // without the extension cap the warning appears when the bed is out of reach
  const deep = await resolveAllowedBox(
    { ...mem, heightmap: async (x0: number, z0: number, x1: number, z1: number) => ({ x0, z0, x1, z1, data: new Int16Array((x1 - x0 + 1) * (z1 - z0 + 1)).fill(10) }) } as any,
    { player: { name: 'a' }, prompt: 'tall tower', anchor: [0, 64, 0], facing: 'north', selection: SEL },
    testConfig(),
    { minY: -64, maxY: 319 },
  );
  assert.equal(deep.box.min[1], 32);
  assert.equal(deep.box.max[1], 64 + 32 + 16 - 1, 'tall prompts get +16');
  assert.ok(deep.notes.some((n) => /WARNING: ground\/water bed below the box/.test(n)));
});

test('per-job world cache: one area read, own edits served from memory, few round trips', async () => {
  const g0 = mem.gets, h0 = mem.heights;
  await call('heightmap', { box: [[0, 0, -9], [9, 0, 0]] });
  await call('scan_region', { box: [[0, 0, -9], [9, 3, 0]], mode: 'summary' });
  const b = await call('build', { ops: [{ op: 'fill', box: [[6, 1, -8], [8, 3, -6]], block: 'stone_bricks', mode: 'walls' }] });
  assert.ok(!b.isError, b.text);
  const sc = await call('scan_region', { box: [[6, 1, -8], [8, 3, -6]], mode: 'blocks' });
  assert.match(sc.text, /stone_bricks/, 'own edit visible through the cache');
  await call('run_script', { code: 'log(groundY(7, -2), isWater(3, -1, -3), isWater(7, 1, -2))' });
  await call('run_script', { code: 'set(8, 1, -2, "lantern")' });
  await call('build', { ops: [{ op: 'set', pos: [7, 1, -2], block: 'oak_planks' }] });
  const gets = mem.gets - g0, heights = mem.heights - h0;
  const stats = (job.scratch.get('world') as JobWorldCache).stats;
  console.log(`# world round trips for 8 tool calls: get_blocks ${gets}, heightmap ${heights}; cache ${JSON.stringify(stats)}`);
  assert.ok(gets <= 4, `${gets} get_blocks round trips (stats ${JSON.stringify(stats)})`);
  assert.ok(heights <= 4, `${heights} heightmap round trips`);
  assert.ok(stats.getBlocksHits >= 5, JSON.stringify(stats));
});

test('run_script: readBox is clamped, isWater, groundY never throws far away', async () => {
  const r = await call('run_script', { code: 'log(isWater(3, -1, -3), isWater(0, 1, 0), groundY(300, 300))', readBox: [[-40, -60, -40], [40, 30, 40]] });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /logs:\ntrue false -?\d+/);
  assert.match(r.text, /readBox clamped to the allowed box ± 4/);
});

test('floating scan treats lily pads on water as supported; support messages name the support cell', async () => {
  put(3, 1, -3, 'lily_pad');
  put(9, 6, -1, 'stone'); // real junk
  const f = await call('scan_region', { box: [[0, -2, -9], [9, 8, 0]], mode: 'floating' });
  assert.ok(!f.isError, f.text);
  assert.match(f.text, /1 × stone/);
  assert.doesNotMatch(f.text, /lily_pad/);
  const l = await call('build', { ops: [
    { op: 'set', pos: [1, 4, -8], block: 'spruce_slab[type=top]' },
    { op: 'set', pos: [1, 3, -8], block: 'lantern[hanging=true]' },
    { op: 'set', pos: [2, 4, -8], block: 'spruce_stairs[half=bottom,facing=north]' },
    { op: 'set', pos: [2, 3, -8], block: 'lantern[hanging=true]' },
  ] });
  assert.match(l.text, /support cell \[1,4,-8\]: spruce_slab\[type=top\]/);
  assert.equal(at(1, 3, -8), 'minecraft:air');
  assert.match(at(2, 3, -8), /lantern/, 'a bottom-half stair holds a hanging lantern');
});

test('find_blocks hints item-only decorations', async () => {
  const r = await call('find_blocks', { query: 'spyglass' });
  assert.match(r.text, /item_frame/);
});

test('build/run_script refuse command blocks with a clear error', async () => {
  const b = await call('build', { ops: [{ op: 'set', pos: [5, 1, -5], block: 'command_block' }] });
  assert.equal(b.isError, true);
  assert.match(b.text, /op #0 \(set\): command_block is not allowed/);
  const s = await call('run_script', { code: 'set(5, 1, -5, "repeating_command_block")' });
  assert.equal(s.isError, true);
  assert.match(s.text, /repeating_command_block is not allowed/);
  const c = await call('command', { command: 'summon armor_stand 5 65 -5 {Passengers:[{id:"tnt"}]}', space: 'world' });
  assert.equal(c.isError, true);
  assert.match(c.text, /nested entity 'tnt'/);
});

test('roof op too tall for the allowed box: the error names the roof top and the box limit', async () => {
  const r = await call('build', { ops: [{ op: 'roof', box: [[0, 25, -8], [8, 25, -1]], style: 'spire', stairs: 'spruce_stairs', pitch: 3 }] });
  assert.equal(r.isError, true);
  assert.match(r.text, /roof reaches y=\d+.*allowed box ends at y=/);
});
