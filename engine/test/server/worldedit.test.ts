import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tmpHome, MemBackend } from './helpers.ts';
import { WorldEdit } from '../../src/server/worldedit.ts';
import { Registry } from '../../src/core/registry.ts';
import { History } from '../../src/core/session.ts';
import { StructureLibrary } from '../../src/core/schematic.ts';

tmpHome();

test('player WorldEdit operations: set, copy/paste/rotate, undo/redo, save/load', async () => {
  const mem = new MemBackend();
  const history = new History();
  const we = new WorldEdit({
    backend: () => mem,
    registry: () => Registry.loadDefault(),
    history,
    structures: new StructureLibrary(fs.mkdtempSync(path.join(os.tmpdir(), 'mcai-st-'))),
    maxBlocks: 100_000,
  });
  const sel = { min: [0, 65, 0], max: [2, 65, 0] };
  let r = await we.handle('Alex', 'set', { selection: sel, block: 'oak_stairs[facing=east]' });
  assert.match(r.message, /3 blocks changed/);
  assert.match(mem.at(1, 65, 0), /oak_stairs\[facing=east/);
  r = await we.handle('Alex', 'copy', { selection: sel, origin: [0, 65, 0] });
  assert.match(r.message, /copied 3/);
  await we.handle('Alex', 'rotate', { degrees: 90 });
  r = await we.handle('Alex', 'paste', { at: [10, 65, 10] });
  assert.match(r.message, /3 blocks changed/);
  // rotated 90° clockwise: a row along +x becomes a column along +z, east-facing stairs face south
  assert.match(mem.at(10, 65, 12) + mem.at(10, 65, 10), /facing=south/);
  r = await we.handle('Alex', 'undo');
  assert.match(r.message, /undid "paste"/);
  assert.equal(mem.at(10, 65, 10), 'minecraft:air');
  r = await we.handle('Alex', 'redo');
  assert.match(r.message, /redid/);
  r = await we.handle('Alex', 'replace', { selection: sel, from: '#minecraft:stairs', block: 'stone' });
  assert.equal(mem.at(0, 65, 0), 'minecraft:stone');
  r = await we.handle('Alex', 'save', { name: 'Row' });
  assert.match(r.message, /saved 'Row'/);
  r = await we.handle('Alex', 'list');
  assert.match(r.message, /Row/);
  await assert.rejects(we.handle('Bob', 'paste', { at: [0, 0, 0] }), /clipboard is empty/);
  await assert.rejects(we.handle('Bob', 'set', {}), /no selection/);
  await assert.rejects(we.handle('Bob', 'explode', {}), /unknown tool/);
});
