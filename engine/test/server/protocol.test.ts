import { test } from 'node:test';
import assert from 'node:assert/strict';
import { b64encode, b64ToInt16, b64ToInt32, b64ToUint16, concatBatches, decodeBatch, encodeBatch, ProtocolError, splitBatch } from '../../src/server/protocol.ts';
import { checkCommand } from '../../src/server/commands.ts';
import { parseConfig, ConfigError } from '../../src/server/config.ts';
import { defaultAllowedBox } from '../../src/server/hub.ts';

test('typed arrays round-trip through little-endian base64', () => {
  const a = Int32Array.from([0, -1, 2147483647, -2147483648, 123456]);
  assert.deepEqual(b64ToInt32(b64encode(a)), a);
  const b = Uint16Array.from([0, 1, 65535, 300]);
  assert.deepEqual(b64ToUint16(b64encode(b)), b);
  const c = Int16Array.from([-64, 319, -32768]);
  assert.deepEqual(b64ToInt16(b64encode(c)), c);
  // explicit LE check: 1 → 01 00
  assert.equal(Buffer.from(b64encode(Uint16Array.from([1])), 'base64').toString('hex'), '0100');
  // subarray views encode only their window
  const big = Int32Array.from([9, 8, 7, 6]);
  assert.deepEqual(b64ToInt32(b64encode(big.subarray(1, 3))), Int32Array.from([8, 7]));
  assert.equal(b64ToUint16('').length, 0);
  assert.throws(() => b64ToInt32(Buffer.from([1, 2, 3]).toString('base64')), ProtocolError);
});

test('batches encode/decode and validate', () => {
  const batch = { palette: ['minecraft:air', 'minecraft:stone'], positions: Int32Array.from([1, 2, 3, 4, 5, 6]), states: Uint16Array.from([1, 0]) };
  const w = encodeBatch(batch);
  const back = decodeBatch(w);
  assert.deepEqual(back.positions, batch.positions);
  assert.deepEqual(back.states, batch.states);
  assert.throws(() => decodeBatch({ palette: ['a'], positions: w.positions, states: w.states }), /out of palette/);
  assert.throws(() => decodeBatch({ palette: batch.palette, positions: b64encode(Int32Array.from([1, 2, 3])), states: w.states }), /2 states but 1 positions/);
});

test('splitBatch compacts palettes and concatBatches restores', () => {
  const n = 2500;
  const pos = new Int32Array(n * 3);
  const st = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    pos.set([i, 64, -i], i * 3);
    st[i] = i < 1000 ? 0 : i < 2000 ? 1 : 2;
  }
  const b = { palette: ['minecraft:stone', 'minecraft:dirt', 'minecraft:glass'], positions: pos, states: st };
  const parts = splitBatch(b, 1000);
  assert.equal(parts.length, 3);
  assert.deepEqual(parts.map((p) => p.palette), [['minecraft:stone'], ['minecraft:dirt'], ['minecraft:glass']]);
  const all = concatBatches(parts);
  assert.equal(all.states.length, n);
  for (let i = 0; i < n; i += 97) assert.equal(all.palette[all.states[i]!], b.palette[b.states[i]!]);
  assert.deepEqual(all.positions, pos);
});

test('command allowlist', () => {
  const box = { min: [0, 60, 0] as [number, number, number], max: [20, 90, 20] as [number, number, number] };
  assert.equal(checkCommand('summon armor_stand 5 64 5 {ShowArms:1b}', { allowedBox: box }), null);
  assert.match(checkCommand('summon tnt 5 64 5', { allowedBox: box })!, /not allowed/);
  assert.match(checkCommand('summon armor_stand 500 64 5', { allowedBox: box })!, /outside/);
  assert.match(checkCommand('summon armor_stand ~ ~ ~', { allowedBox: box })!, /relative/);
  assert.match(checkCommand('op Steve', { allowedBox: box })!, /not allowed/);
  assert.match(checkCommand('execute as @a run kill @s', { allowedBox: box })!, /not allowed|selectors/);
  assert.match(checkCommand('time set day', { allowedBox: box })!, /disabled/);
  assert.equal(checkCommand('time set day', { allowedBox: box, extra: ['time set'] }), null);
  assert.equal(checkCommand('fillbiome 0 60 0 10 70 10 minecraft:cherry_grove', { allowedBox: box }), null);
});

test('config defaults and validation', () => {
  const c = parseConfig({});
  assert.equal(c.model, 'opus');
  assert.equal(c.effort, 'medium');
  assert.equal(c.concurrency, 2);
  assert.equal(c.maxBlocksPerJob, 2_000_000);
  assert.throws(() => parseConfig({ concurrency: 0 }), ConfigError);
  assert.throws(() => parseConfig({ effort: 'huge' }), /effort/);
});

test('default allowed box rotates with facing and puts the site in front of the player', () => {
  const w = { minY: -64, maxY: 319 };
  const size = { x: 10, y: 20, z: 30 };
  const north = defaultAllowedBox([100, 64, 100], 'north', size, 5, w);
  // site extends to -z (north) of the anchor, 5 blocks front margin toward the player (+z)
  assert.deepEqual(north, { min: [95, 59, 76], max: [104, 83, 105] });
  const east = defaultAllowedBox([100, 64, 100], 'east', size, 5, w);
  // facing east: forward = +x
  assert.equal(east.max[0], 100 + 24);
  assert.equal(east.min[0], 100 - 5);
  assert.equal(east.max[2] - east.min[2] + 1, 10);
  const clamp = defaultAllowedBox([0, 310, 0], 'south', size, 5, w);
  assert.equal(clamp.max[1], 319);
});
