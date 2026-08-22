import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadBlueprints, loadStyles, parsePalette, exportBuiltinStyles, searchPaths } from '../daemon/library.js';
import { compile, resolvePalette, PALETTES, getPrefab } from '../core/index.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcai-lib-'));
}

test('parsePalette accepts plain ids and weighted mixes', () => {
  const { palette, error } = parsePalette('test', {
    slots: { wall: 'stone_bricks', roof: { mix: ['oak_planks', 'spruce_planks'], weights: [0.7, 0.3] } },
  });
  assert.equal(error, undefined);
  assert.equal(palette!.slots.wall, 'stone_bricks');
  assert.deepEqual((palette!.slots.roof as { mix: string[] }).mix, ['oak_planks', 'spruce_planks']);
});

test('parsePalette rejects a file with no slots, and says why', () => {
  const { error } = parsePalette('bad', { description: 'nothing here' });
  assert.match(error ?? '', /slots/);
});

test('parsePalette rejects a malformed slot value by name', () => {
  const { error } = parsePalette('bad', { slots: { wall: 42 } });
  assert.match(error ?? '', /"wall"/);
});

test('a custom palette can extend a built-in and override only what differs', () => {
  const { palette, error } = parsePalette('mine', { extends: 'medieval', slots: { wall: 'diamond_block' } });
  assert.equal(error, undefined);
  assert.equal(palette!.slots.wall, 'diamond_block');
  assert.deepEqual(palette!.slots.roof, PALETTES.medieval.slots.roof, 'inherited slots survive');
});

test('extending a style that does not exist is an error, not a silent default', () => {
  const { error } = parsePalette('mine', { extends: 'not_a_style', slots: { wall: 'stone' } });
  assert.match(error ?? '', /unknown style/i);
});

test('loadStyles reads a directory and skips bad files without failing', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify({ slots: { wall: 'gold_block' } }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
  fs.writeFileSync(path.join(dir, 'ignored.txt'), 'nope');

  const result = loadStyles(dir);
  assert.ok(result.items.good, 'the valid style loaded');
  assert.equal(result.items.good.slots.wall, 'gold_block');
  assert.equal(result.errors.length, 1, 'the broken file is reported');
  assert.match(result.errors[0], /broken\.json/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a custom palette actually changes what gets built', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'gaudy.json'), JSON.stringify({
    extends: 'medieval',
    slots: { wall: 'gold_block', stone: 'gold_block' },
  }));
  const { items } = loadStyles(dir);

  const built = compile(getPrefab('keep')!, { origin: [0, 64, 0], palettes: items, detail: 'off' });
  // Compile against the same blueprint with the custom palette selected.
  const custom = compile({ ...getPrefab('keep')!, palette: 'gaudy' }, {
    origin: [0, 64, 0], palettes: items, detail: 'off',
  });
  assert.ok((custom.stats.blockCounts.gold_block ?? 0) > 500, 'the override reached the compiler');
  assert.ok(!(built.stats.blockCounts.gold_block > 500), 'and does not leak into other builds');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolvePalette prefers a custom style over a built-in of the same name', () => {
  const custom = {
    medieval: { name: 'medieval', description: 'mine', slots: { wall: 'bedrock' } },
  };
  const p = resolvePalette('medieval', undefined, 0, custom);
  assert.equal(p.at('@wall', 0, 0, 0), 'bedrock');
});

test('loadBlueprints validates and reports the offending field', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'ok.json'), JSON.stringify({
    parts: [{ op: 'box', at: [0, 0, 0], size: [4, 4, 4], block: 'stone' }],
  }));
  fs.writeFileSync(path.join(dir, 'nosize.json'), JSON.stringify({
    parts: [{ op: 'box', at: [0, 0, 0] }],
  }));

  const result = loadBlueprints(dir);
  assert.ok(result.items.ok);
  assert.equal(result.items.ok.name, 'ok', 'the filename becomes the name');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /size/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('searchPaths puts the working directory ahead of the package', () => {
  const paths = searchPaths('styles');
  assert.ok(paths.length >= 1);
  assert.equal(paths[0], path.resolve(process.cwd(), 'styles'), 'the working directory wins');
  assert.equal(new Set(paths).size, paths.length, 'no duplicates');
  // In a dev checkout the working directory *is* the package, so an explicit
  // extra directory is the reliable way to prove precedence.
  const withExtra = searchPaths('styles', '/tmp/mcai-custom');
  assert.equal(withExtra[0], path.resolve('/tmp/mcai-custom'));
});

test('exportBuiltinStyles writes files that load back identically', () => {
  const dir = tmpdir();
  const written = exportBuiltinStyles(dir);
  assert.equal(written.length, Object.keys(PALETTES).length);

  const { items, errors } = loadStyles(dir);
  assert.deepEqual(errors, []);
  for (const [name, palette] of Object.entries(PALETTES)) {
    assert.ok(items[name], `${name} round-tripped`);
    assert.deepEqual(items[name].slots, palette.slots, `${name} slots survived the round trip`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the shipped style and blueprint files are all valid', () => {
  const styles = loadStyles();
  assert.deepEqual(styles.errors, [], 'shipped styles must parse');
  assert.ok(Object.keys(styles.items).length >= 16);

  const blueprints = loadBlueprints();
  assert.deepEqual(blueprints.errors, [], 'shipped blueprints must validate');
  for (const [name, bp] of Object.entries(blueprints.items)) {
    const built = compile(bp, { origin: [0, 64, 0], palettes: styles.items });
    assert.ok(built.stats.voxels > 100, `${name} produced only ${built.stats.voxels} blocks`);
    const unknown = built.stats.warnings.filter((w) => /Unrecognised block/.test(w));
    assert.deepEqual(unknown, [], `${name}: ${unknown.join()}`);
  }
});
