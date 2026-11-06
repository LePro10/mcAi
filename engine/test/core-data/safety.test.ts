import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCommand } from '../../src/server/commands.ts';
import { blockStateProblem } from '../../src/core/safety.ts';
import { EditSession } from '../../src/core/session.ts';
import { runScript } from '../../src/core/script.ts';
import { MemBackend, reg } from './helpers.ts';

const box = { min: [0, 0, 0] as [number, number, number], max: [20, 100, 20] as [number, number, number] };

test('summon NBT: nested Passengers must be decorative; no command blocks or run_command anywhere', () => {
  const ok = (c: string) => assert.equal(checkCommand(c, { allowedBox: box }), null, c);
  const bad = (c: string, re: RegExp) => assert.match(checkCommand(c, { allowedBox: box }) ?? 'ALLOWED', re, c);
  ok('summon armor_stand 5 64 5 {ShowArms:1b,Passengers:[{id:"minecraft:armor_stand",Small:1b}]}');
  ok('summon item_frame 5 64 5 {Facing:2b,Item:{id:"minecraft:spyglass",count:1}}');
  bad('summon armor_stand 5 64 5 {Passengers:[{id:"minecraft:tnt",fuse:1}]}', /nested entity 'tnt'/);
  bad('summon horse 5 64 5 {Passengers:[{id:armor_stand,Passengers:[{id:"creeper"}]}]}', /nested entity 'creeper'/);
  bad('summon armor_stand 5 64 5 {Passengers:[{id:"wither"}]}', /nested entity 'wither'/);
  bad('summon minecart 5 64 5 {Passengers:[{id:"command_block_minecart",Command:"op @p"}]}', /not allowed/);
  bad('summon item_frame 5 64 5 {Item:{id:"minecraft:command_block",count:1}}', /command_block is not allowed/);
  bad('summon text_display 5 64 5 {text:{text:"hi",click_event:{action:"run_command",command:"/op x"}}}', /run_command/);
  bad('summon armor_stand 5 64 5 {Passengers:[{id:"tnt"', /could not parse|not allowed/);
});

test('command blocks and run_command click events are rejected before anything is built', async () => {
  assert.match(blockStateProblem('minecraft:command_block[conditional=false,facing=north]')!, /command blocks are disabled/);
  assert.match(blockStateProblem('minecraft:oak_sign[rotation=0,waterlogged=false]{front_text:{messages:[{text:"x",click_event:{action:"run_command",command:"/op a"}},"","",""]}}')!, /run_command/);
  assert.equal(blockStateProblem('minecraft:oak_sign[rotation=0,waterlogged=false]{front_text:{messages:["hello","","",""]}}'), null);
  const s = new EditSession(new MemBackend(), reg());
  assert.throws(() => s.set(0, 0, 0, 'repeating_command_block'), /not allowed/);
  assert.throws(() => s.set(0, 0, 0, 'chain_command_block'), /not allowed/);
  const r = await runScript({ code: 'set(0,0,0,"command_block")' }, reg());
  // the sandbox may produce it; the session/tool rejects it on set
  const s2 = new EditSession(new MemBackend(), reg());
  assert.throws(() => { for (const [x, y, z, st] of r.entries) s2.set(x, y, z, st); }, /not allowed/);
});
