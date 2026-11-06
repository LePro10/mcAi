import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listPrefabs, placePrefab, resolvePrefabName } from '../../src/core/prefabs.ts';
import { blockId } from '../../src/core/blockstate.ts';
import { RecordingSink, reg } from './helpers.ts';

/** flat grass world: ground (grass_block) at y = 63, air above */
const ground = (_x: number, y: number, _z?: number) => (y < 63 ? 'minecraft:dirt' : y === 63 ? 'minecraft:grass_block[snowy=false]' : 'minecraft:air');

function place(name: string, seed: number, params: Record<string, unknown> = {}, at: [number, number, number] = [0, 64, 0]) {
  const sink = new RecordingSink(ground);
  const n = placePrefab(name, at, params, sink, reg(), seed);
  return { sink, n };
}

test('listPrefabs describes every prefab with params', () => {
  const list = listPrefabs();
  assert.ok(list.length >= 25);
  for (const p of list) {
    assert.ok(p.name && p.description.length > 10, p.name);
    assert.equal(typeof p.params, 'object');
  }
  for (const n of ['oak_tree', 'birch_tree', 'spruce_tree', 'dark_oak_tree', 'cherry_tree', 'jungle_tree', 'acacia_tree', 'pale_oak_tree', 'mangrove_tree', 'giant_oak', 'willow_tree', 'palm_tree', 'maple_tree', 'bush', 'boulder', 'flower_patch', 'lamp_post', 'bench', 'well', 'fountain', 'market_stall', 'campfire_seating', 'hay_pile', 'crate_pile']) {
    assert.ok(list.some((p) => p.name === n), n);
  }
  assert.equal(resolvePrefabName('Weeping Willow'), 'willow_tree');
  assert.equal(resolvePrefabName('palm'), 'palm_tree');
});

test('every prefab emits only canonical registry states; leaves are persistent', () => {
  const r = reg();
  for (const { name } of listPrefabs()) {
    for (const seed of [1, 2, 3, 77]) {
      for (const facing of [undefined, 'east', 'south']) {
        const sizes = name.endsWith('_tree') || name === 'giant_oak' ? ['small', 'large'] : [undefined];
        for (const size of sizes) {
          const params: Record<string, unknown> = {};
          if (facing) params.facing = facing;
          if (size) params.size = size;
          const { sink, n } = place(name, seed, params);
          assert.ok(n > 0, `${name} placed nothing`);
          for (const [, , , s] of sink.order) {
            const c = r.tryCanonical(s);
            assert.ok(c.ok, `${name}: ${s} ${!c.ok ? c.error : ''}`);
            assert.equal(c.ok && c.state, s, `${name}: not canonical: ${s}`);
            if (blockId(s).endsWith('_leaves')) assert.match(s, /persistent=true/, `${name}: ${s}`);
          }
        }
      }
    }
  }
});

test('prefabs are deterministic per seed and vary between seeds / positions', () => {
  for (const name of ['oak_tree', 'giant_oak', 'boulder', 'flower_patch', 'willow_tree', 'market_stall']) {
    const a = place(name, 5);
    const b = place(name, 5);
    const c = place(name, 6);
    assert.deepEqual(a.sink.order, b.sink.order, `${name} deterministic`);
    assert.notDeepEqual(a.sink.order, c.sink.order, `${name} varies with seed`);
  }
  // default seed derives from the position: two trees at different places differ
  const s1 = new RecordingSink(ground);
  const s2 = new RecordingSink(ground);
  placePrefab('oak_tree', [0, 64, 0], {}, s1, reg());
  placePrefab('oak_tree', [50, 64, 0], {}, s2, reg());
  const norm = (s: RecordingSink, dx: number) => s.order.map(([x, y, z, st]) => `${x - dx},${y},${z},${st}`).sort();
  assert.notDeepEqual(norm(s1, 0), norm(s2, 50));
});

test('trees: trunk at the base, sensible sizes; giant oak is big', () => {
  const oak = place('oak_tree', 3).sink;
  assert.match(oak.get(0, 64, 0), /^minecraft:oak_log\[axis=y\]/);
  const giant = place('giant_oak', 3, { size: 'medium' }).sink;
  const ys = giant.order.map(([, y]) => y);
  assert.ok(Math.max(...ys) - 64 >= 14, `giant oak height ${Math.max(...ys) - 64}`);
  assert.ok(giant.order.length > 800);
  const spruce = place('spruce_tree', 9, { height: 14 }).sink;
  assert.ok(spruce.order.some(([x, y, z, s]) => x === 0 && z === 0 && y === 64 + 13 && s.startsWith('minecraft:spruce_log')));
});

test('soft placement: leaves and flowers never overwrite existing builds', () => {
  // a stone wall right next to the tree
  const base = (x: number, y: number, z: number) => (x >= 2 && x <= 6 && y >= 64 && y <= 80 ? 'minecraft:stone_bricks' : ground(x, y, z));
  const sink = new RecordingSink(base);
  placePrefab('oak_tree', [0, 64, 0], { size: 'large' }, sink, reg(), 4);
  for (const [x, y, , s] of sink.order) {
    if (x >= 2 && x <= 6 && y >= 64 && y <= 80) assert.ok(!blockId(s).endsWith('_leaves'), `leaves overwrote the wall at ${x},${y}`);
  }
  const fp = new RecordingSink(base);
  placePrefab('flower_patch', [0, 64, 0], { radius: 6, density: 1 }, fp, reg(), 4);
  assert.ok(fp.order.length > 10);
  assert.ok(fp.order.every(([x, y, z]) => base(x, y - 1, z).startsWith('minecraft:grass_block') || fp.get(x, y - 1, z).includes('half=lower') || y > 64));
});

test('flower patches are biome appropriate and double plants get both halves', () => {
  const { sink } = place('flower_patch', 12, { biome: 'cherry_grove', radius: 5, density: 1 });
  assert.ok(sink.order.some(([, , , s]) => s.startsWith('minecraft:pink_petals')));
  const g = place('flower_patch', 3, { biome: 'garden', radius: 6, density: 1 }).sink;
  for (const [x, y, z, s] of g.order) {
    if (/half=lower/.test(s)) assert.match(g.get(x, y + 1, z), /half=upper/);
  }
  assert.throws(() => place('flower_patch', 1, { biome: 'moon' }), /invalid value "moon" for "biome"/);
});

test('oriented prefabs rotate with facing', () => {
  const north = place('bench', 1, { facing: 'north', length: 3 }).sink;
  const east = place('bench', 1, { facing: 'east', length: 3 }).sink;
  assert.ok(north.order.some(([, , , s]) => /_stairs\[facing=north/.test(s)));
  assert.ok(east.order.some(([, , , s]) => /_stairs\[facing=east/.test(s)));
  assert.throws(() => place('bench', 1, { facing: 'up' }), /invalid facing/);
});

test('unknown prefab names give a helpful error', () => {
  assert.throws(() => place('spaceship', 1), /unknown prefab "spaceship"\. Available: .*oak_tree/);
});
