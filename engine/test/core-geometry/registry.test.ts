import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Registry, RegistryError, levenshtein } from '../../src/core/registry.ts';
import { parseBlockState } from '../../src/core/blockstate.ts';
import { reg } from './helpers.ts';

test('loadDefault is a cached singleton with all blocks', () => {
  assert.equal(Registry.loadDefault(), reg);
  assert.equal(reg.version, '26.3');
  assert.ok(reg.ids().length > 1200);
  assert.ok(reg.has('stone') && reg.has('minecraft:stone') && reg.has('oak_stairs[facing=east]'));
  assert.ok(!reg.has('oak_plank'));
  assert.deepEqual(reg.info('minecraft:oak_stairs')?.default.facing, 'north');
});

test('canonical: namespace, all properties, sorted, defaults filled', () => {
  assert.equal(reg.canonical('stone'), 'minecraft:stone');
  assert.equal(reg.canonical('oak_stairs'), 'minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]');
  assert.equal(
    reg.canonical('minecraft:oak_stairs[waterlogged=false,half=top,facing=east]'),
    'minecraft:oak_stairs[facing=east,half=top,shape=straight,waterlogged=false]',
  );
  assert.equal(reg.canonical(' OAK_STAIRS[ FACING = East ] '), 'minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]');
  assert.equal(reg.canonical('oak_log[]'), 'minecraft:oak_log[axis=y]');
});

test('canonical keeps SNBT verbatim (case, commas, brackets)', () => {
  const nbt = '{Items:[{Slot:0b,id:"minecraft:Diamond",count:3}],CustomName:\'"A, B"\'}';
  assert.equal(reg.canonical('chest[facing=east]' + nbt), 'minecraft:chest[facing=east,type=single,waterlogged=false]' + nbt);
  assert.equal(reg.canonical('stone{}'), 'minecraft:stone{}');
});

test('canonical is idempotent and cached for every block default', () => {
  for (const id of reg.ids()) {
    const c = reg.canonical(id);
    assert.equal(reg.canonical(c), c, id);
    const p = parseBlockState(c);
    assert.deepEqual(Object.keys(p.props), Object.keys(reg.info(id)!.properties).sort(), id);
    assert.equal(reg.canonical(id), c); // cache hit returns same string
  }
});

test('unknown ids: did-you-mean suggestions', () => {
  const cases: [string, string][] = [
    ['oak_plank', 'oak_planks'],
    ['stone_brick', 'stone_bricks'],
    ['cobble', 'cobblestone'],
    ['oak_stair', 'oak_stairs'],
    ['glas', 'glass'],
    ['grass', 'short_grass'],
    ['stone_bricks_stairs', 'stone_brick_stairs'],
    ['spruce_log_stairs', 'spruce_stairs'],
    ['dark_oak_plank', 'dark_oak_planks'],
    ['chain', 'iron_chain'],
    ['white_concrete_block', 'white_concrete'],
    ['mossy_cobble', 'mossy_cobblestone'],
  ];
  for (const [q, want] of cases) {
    assert.throws(
      () => reg.canonical(q),
      (e: unknown) => {
        assert.ok(e instanceof RegistryError);
        assert.match(e.message, /Unknown block/);
        assert.match(e.message, /Did you mean/);
        assert.equal(e.suggestions[0], want, `${q}: got ${e.suggestions.join(',')}`);
        return true;
      },
    );
  }
});

test('bad property / value errors list valid options', () => {
  assert.throws(() => reg.canonical('oak_stairs[facin=north]'), /no property "facin". Valid properties: facing=north\|south\|west\|east, half=top\|bottom/);
  assert.throws(() => reg.canonical('oak_stairs[facing=up]'), /Invalid value "up" for property "facing".*Valid values: north, south, west, east/);
  assert.throws(() => reg.canonical('stone[axis=y]'), /has no properties/);
  assert.throws(() => reg.canonical('oak_stairs[facing]'), /syntax/);
  assert.throws(() => reg.canonical('oak_stairs[facing=north'), /syntax/);
  const r = reg.tryCanonical('oak_plank');
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.error.includes('oak_planks'));
  assert.deepEqual(reg.tryCanonical('stone'), { ok: true, state: 'minecraft:stone' });
});

test('hasTag accepts #, namespace and states', () => {
  assert.ok(reg.hasTag('oak_stairs', 'minecraft:stairs'));
  assert.ok(reg.hasTag('minecraft:oak_stairs', '#stairs'));
  assert.ok(reg.hasTag('oak_stairs[facing=east]', '#minecraft:wooden_stairs'));
  assert.ok(!reg.hasTag('stone', 'stairs'));
  assert.ok(!reg.hasTag('nope', 'stairs'));
  assert.ok(reg.tagMembers('#logs').includes('minecraft:oak_log'));
});

test('search by words and tag', () => {
  assert.equal(reg.search('red wool')[0], 'minecraft:red_wool');
  assert.equal(reg.search('stone brick')[0], 'minecraft:stone_bricks');
  assert.equal(reg.search('glass pane')[0], 'minecraft:glass_pane');
  assert.equal(reg.search('dark oak plank')[0], 'minecraft:dark_oak_planks');
  const stairs = reg.search('spruce', { tag: 'stairs' });
  assert.deepEqual(stairs, ['minecraft:spruce_stairs']);
  const all = reg.search('', { tag: '#stairs', limit: 1000 });
  assert.ok(all.length > 90 && all.every((id) => reg.hasTag(id, 'stairs')));
  assert.ok(reg.search('stairs', { limit: 5 }).length === 5);
  // nothing matches all words → fuzzy fallback
  assert.equal(reg.search('cobble')[0], 'minecraft:cobblestone');
});

test('isFullSolid / isTransparent heuristics', () => {
  const full = ['stone', 'oak_planks', 'glass', 'oak_leaves', 'grass_block', 'sea_lantern', 'jack_o_lantern', 'mud', 'shulker_box', 'crimson_stem', 'mushroom_stem', 'oak_slab[type=double]', 'snow[layers=8]', 'piston', 'barrier', 'tinted_glass', 'bookshelf'];
  const notFull = ['air', 'water', 'oak_stairs', 'oak_slab', 'oak_fence', 'oak_fence_gate', 'cobblestone_wall', 'glass_pane', 'iron_bars', 'copper_bars', 'oak_door', 'oak_trapdoor', 'oak_sign', 'oak_wall_sign', 'white_banner', 'torch', 'wall_torch', 'lantern', 'iron_chain', 'chest', 'red_bed', 'poppy', 'short_grass', 'tall_grass', 'oak_sapling', 'white_carpet', 'rail', 'snow', 'farmland', 'dirt_path', 'piston[extended=true]', 'flower_pot', 'potted_poppy', 'ladder', 'vine', 'cactus', 'sugar_cane', 'bamboo', 'end_rod', 'skeleton_skull', 'cake', 'cauldron', 'anvil', 'oak_button', 'stone_pressure_plate', 'brewing_stand', 'campfire', 'candle', 'kelp', 'cobweb', 'lightning_rod', 'oak_shelf', 'moss_carpet'];
  for (const s of full) assert.equal(reg.isFullSolid(reg.canonical(s)), true, s);
  for (const s of notFull) assert.equal(reg.isFullSolid(reg.canonical(s)), false, s);
  for (const s of ['air', 'glass', 'oak_leaves', 'glass_pane', 'poppy', 'oak_stairs', 'ice', 'water', 'spawner']) assert.equal(reg.isTransparent(reg.canonical(s)), true, s);
  for (const s of ['stone', 'oak_planks', 'grass_block', 'packed_ice', 'sea_lantern']) assert.equal(reg.isTransparent(reg.canonical(s)), false, s);
  // every block classifies without throwing; a sane majority are full cubes
  let n = 0;
  for (const id of reg.ids()) if (reg.isFullSolid(reg.canonical(id))) n++;
  assert.ok(n > 400 && n < 800, `full solids: ${n}`);
});

test('levenshtein', () => {
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(levenshtein('', 'abc'), 3);
  assert.equal(levenshtein('abc', 'abc'), 0);
  assert.ok(levenshtein('aaaaaaaa', 'bbbbbbbb', 2) > 2);
});

test('canonical is fast (cached)', () => {
  const t0 = performance.now();
  for (let i = 0; i < 1_000_000; i++) reg.canonical('oak_stairs[facing=east]');
  assert.ok(performance.now() - t0 < 1500);
});
