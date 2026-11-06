import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditSession, History, BoundsError, LimitError, MAX_BATCH, mergeRecords, type FlushResult } from '../../src/core/session.ts';
import { batchEntries } from '../../src/core/volume.ts';
import { MemBackend, reg } from './helpers.ts';

const STONE = 'minecraft:stone';
const DIRT = 'minecraft:dirt';
const AIR = 'minecraft:air';

test('get/set: pending > cache > air (miss counted); canonicalizes', async () => {
  const be = new MemBackend([[1, 1, 1, DIRT]]);
  const s = new EditSession(be, reg());
  assert.equal(s.get(1, 1, 1), AIR);
  assert.equal(s.misses, 1);
  await s.prefetch({ min: [0, 0, 0], max: [3, 3, 3] });
  assert.equal(s.get(1, 1, 1), DIRT);
  assert.equal(s.misses, 1);
  s.set(1, 1, 1, 'stone');
  s.set(2, 1, 1, 'oak_stairs[facing=east]');
  assert.equal(s.get(1, 1, 1), STONE);
  assert.equal(s.get(2, 1, 1), 'minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]');
  assert.equal(s.pending, 2);
  assert.throws(() => s.set(0, 0, 0, 'stone_brikcs'), /stone_bricks/);
});

test('bounds and block limit errors are clear for the AI', () => {
  const s = new EditSession(new MemBackend(), reg(), { bounds: { min: [0, 60, 0], max: [9, 70, 9] }, maxBlocks: 3 });
  assert.throws(
    () => s.set(10, 65, 5, 'stone'),
    (e: Error) =>
      e instanceof BoundsError &&
      e.message === 'position (10,65,5) is outside the allowed build area (0,60,0)..(9,70,9) — the job is limited to the selection',
  );
  s.set(0, 60, 0, 'stone');
  s.set(1, 60, 0, 'stone');
  s.set(1, 60, 0, 'dirt'); // same position: does not count twice
  s.set(2, 60, 0, 'stone');
  assert.throws(() => s.set(3, 60, 0, 'stone'), (e: Error) => e instanceof LimitError && /at most 3 blocks/.test(e.message));
});

test('flush: skips unchanged, writes ≤ 50k per call, builds undo record, emits event', async () => {
  const be = new MemBackend([[0, 0, 0, STONE]]);
  const s = new EditSession(be, reg(), { connect: false, actor: 'alice', label: 'job' });
  await s.prefetch({ min: [0, 0, 0], max: [0, 0, 0] });
  const events: FlushResult[] = [];
  s.on('flush', (r) => events.push(r));
  s.set(0, 0, 0, 'stone'); // unchanged (cached)
  for (let i = 0; i < 120_000; i++) s.set(1 + (i % 400), Math.floor(i / 400) % 300, 5, i % 2 ? 'stone' : 'dirt');
  const r = await s.flush();
  assert.equal(s.pending, 0);
  assert.equal(r.unchanged, 1);
  assert.equal(r.placed, 120_000);
  assert.equal(r.changed, 120_000);
  assert.ok(be.setCalls.every((c) => c.size <= MAX_BATCH));
  assert.equal(be.setCalls.length, 3);
  assert.equal(be.setCalls[0].opts?.updateShapes, true);
  assert.equal(be.setCalls[0].opts?.dimension, 'minecraft:overworld');
  assert.equal(events.length, 1);
  const rec = r.record!;
  assert.equal(rec.actor, 'alice');
  assert.equal(rec.label, 'job');
  assert.equal(rec.before.states.length, 120_000);
  const b = [...batchEntries(rec.before)];
  const a = [...batchEntries(rec.after)];
  assert.deepEqual(b[0], [1, 0, 5, AIR]);
  assert.deepEqual(a[0], [1, 0, 5, DIRT]);
  // second flush of the same content: nothing to do (cache was updated)
  s.set(1, 0, 5, 'dirt');
  const r2 = await s.flush();
  assert.equal(r2.placed, 0);
  assert.equal(r2.unchanged, 1);
  assert.equal(r2.record, null);
  assert.equal(be.setCalls.length, 3);
});

test('flush: backend-reported unchanged blocks and failures are excluded from the undo record', async () => {
  const be = new MemBackend([[5, 5, 5, STONE]]);
  be.failAt.add('6,5,5');
  const s = new EditSession(be, reg(), { connect: false });
  s.set(5, 5, 5, 'stone'); // not cached → sent, backend says unchanged
  s.set(6, 5, 5, 'dirt'); // fails
  s.set(7, 5, 5, 'dirt');
  const r = await s.flush();
  assert.equal(r.failed.length, 1);
  assert.deepEqual(r.failed[0].pos, [6, 5, 5]);
  assert.equal(r.changed, 1);
  assert.deepEqual([...batchEntries(r.record!.after)], [[7, 5, 5, DIRT]]);
  assert.match(r.warnings.join(), /could not be placed/);
});

test('flush with connect: fences connect, door upper half is added, bounds respected', async () => {
  const be = new MemBackend([[2, 0, 0, 'minecraft:oak_fence[east=false,north=false,south=false,waterlogged=false,west=false]']]);
  const s = new EditSession(be, reg(), { bounds: { min: [0, 0, 0], max: [10, 1, 10] }, support: 'off' });
  s.set(3, 0, 0, 'oak_fence');
  s.set(5, 0, 5, 'oak_door[facing=north]');
  s.set(5, 1, 8, 'oak_door[facing=north]'); // upper half would be at y=2 — outside bounds
  const r = await s.flush();
  assert.equal(be.at(3, 0, 0), 'minecraft:oak_fence[east=false,north=false,south=false,waterlogged=false,west=true]');
  assert.equal(be.at(2, 0, 0), 'minecraft:oak_fence[east=true,north=false,south=false,waterlogged=false,west=false]', 'existing neighbour fence updated');
  assert.match(be.at(5, 1, 5), /^minecraft:oak_door\[facing=north,half=upper/);
  assert.equal(be.at(5, 2, 8), AIR);
  assert.ok(r.multiblock >= 1);
  assert.ok(r.connections >= 1);
  assert.match(r.warnings.join('\n'), /outside the build area/);
  // undo restores the neighbour fence too
  const h = new History();
  h.push(r.record!);
  await h.undo('system', be);
  assert.equal(be.at(2, 0, 0), 'minecraft:oak_fence[east=false,north=false,south=false,waterlogged=false,west=false]');
  assert.equal(be.at(3, 0, 0), AIR);
  assert.equal(be.at(5, 1, 5), AIR);
});

test('connect=false leaves states as given', async () => {
  const be = new MemBackend();
  const s = new EditSession(be, reg(), { connect: false });
  s.set(0, 0, 0, 'oak_fence');
  s.set(1, 0, 0, 'oak_fence');
  s.set(4, 0, 0, 'oak_door');
  await s.flush();
  assert.match(be.at(0, 0, 0), /east=false/);
  assert.equal(be.at(4, 1, 0), AIR);
});

test('history: per-actor undo/redo, limit, push clears redo', async () => {
  const be = new MemBackend();
  const h = new History({ limit: 2 });
  const mk = (actor: string, x: number, st: string) => {
    const s = new EditSession(be, reg(), { actor, connect: false, history: h });
    s.set(x, 0, 0, st);
    return s.flush();
  };
  await mk('a', 0, 'stone');
  await mk('a', 0, 'dirt');
  await mk('b', 9, 'stone');
  await mk('a', 1, 'stone'); // pushes out a's first record (limit 2)
  assert.equal(h.list('a').length, 2);
  assert.equal(h.list('b').length, 1);
  await h.undo('a', be);
  assert.equal(be.at(1, 0, 0), AIR);
  await h.undo('a', be);
  assert.equal(be.at(0, 0, 0), STONE, 'undo of the 2nd edit restores the 1st');
  assert.equal(await h.undo('a', be), null, 'oldest step fell off');
  assert.equal(be.at(9, 0, 0), STONE, "b's edit untouched");
  await h.redo('a', be);
  assert.equal(be.at(0, 0, 0), DIRT);
  await mk('a', 2, 'stone');
  assert.equal(await h.redo('a', be), null, 'new edit clears redo');
  assert.ok(be.setCalls.every((c) => c.opts?.updateShapes === true));
});

test('history.group / groupAfter merge a whole job into one undo step', async () => {
  const be = new MemBackend([[0, 0, 0, DIRT]]);
  const h = new History();
  const s = new EditSession(be, reg(), { actor: 'p', connect: false, history: h });
  s.set(9, 9, 9, 'stone');
  await s.flush(); // before the job
  const mark = h.mark('p');
  s.set(0, 0, 0, 'stone');
  s.set(1, 0, 0, 'stone');
  const first = (await s.flush()).record!;
  s.set(0, 0, 0, 'oak_planks');
  s.set(1, 0, 0, 'air'); // reverted → drops out of the merged record
  await s.flush();
  s.set(2, 0, 0, 'glass');
  await s.flush();
  assert.equal(h.list('p').length, 4);
  const merged = h.groupAfter('p', mark, 'build castle')!;
  assert.equal(h.list('p').length, 2);
  assert.equal(merged.label, 'build castle');
  const after = new Map([...batchEntries(merged.after)].map(([x, y, z, st]) => [`${x},${y},${z}`, st]));
  const before = new Map([...batchEntries(merged.before)].map(([x, y, z, st]) => [`${x},${y},${z}`, st]));
  assert.equal(after.get('0,0,0'), 'minecraft:oak_planks');
  assert.equal(before.get('0,0,0'), DIRT);
  assert.ok(!after.has('1,0,0'));
  assert.equal(after.get('2,0,0'), 'minecraft:glass');
  await h.undo('p', be);
  assert.equal(be.at(0, 0, 0), DIRT);
  assert.equal(be.at(2, 0, 0), AIR);
  assert.equal(be.at(9, 9, 9), STONE, 'edit before the job survives');
  // group() is inclusive of the given record id
  const s2 = new EditSession(be, reg(), { actor: 'q', connect: false, history: h });
  s2.set(5, 0, 0, 'stone');
  const r1 = (await s2.flush()).record!;
  s2.set(6, 0, 0, 'stone');
  await s2.flush();
  h.group('q', r1.id, 'job q');
  assert.equal(h.list('q').length, 1);
  assert.equal(h.list('q')[0].after.states.length, 2);
  assert.throws(() => h.group('q', 'nope', 'x'), /not found/);
  void first;
  assert.equal(mergeRecords([], 'x'), null);
});

test('concurrent flushes on one backend are serialized and history stays consistent', async () => {
  const be = new MemBackend();
  be.delayMs = 15;
  const h = new History();
  const a = new EditSession(be, reg(), { actor: 'a', connect: false, history: h });
  const b = new EditSession(be, reg(), { actor: 'b', connect: false, history: h });
  for (let i = 0; i < 60_000; i++) a.set(i % 300, 0, Math.floor(i / 300), 'stone'); // 2 backend calls
  for (let i = 0; i < 60_000; i++) b.set(i % 300, 0, Math.floor(i / 300), 'dirt');
  const [ra, rb] = await Promise.all([a.flush(), b.flush()]);
  // calls never interleave: start,end,start,end,…
  for (let i = 0; i < be.log.length; i += 2) {
    assert.match(be.log[i], /:start$/);
    assert.match(be.log[i + 1], /:end$/);
  }
  assert.ok(be.log.length >= 8);
  assert.equal(ra.changed, 60_000);
  assert.equal(rb.changed, 60_000);
  // b ran second, so its "before" is a's stone (taken from backend.previous, not a stale cache)
  assert.equal([...batchEntries(rb.record!.before)][0][3], STONE);
  // concurrent undos also serialize; undo b then a → back to air
  await Promise.all([h.undo('b', be), h.undo('a', be)]);
  assert.equal(be.at(0, 0, 0), AIR);
  assert.equal(be.at(299, 0, 199), AIR);
});

test('prefetch splits big boxes into ≤ 1M-block calls', async () => {
  const be = new MemBackend([[100, 300, 100, STONE]]);
  const s = new EditSession(be, reg());
  await s.prefetch({ min: [0, 0, 0], max: [199, 319, 199] }); // 12.8M blocks
  assert.ok(be.getCalls.length >= 13);
  for (const b of be.getCalls) {
    const n = (b.max[0] - b.min[0] + 1) * (b.max[1] - b.min[1] + 1) * (b.max[2] - b.min[2] + 1);
    assert.ok(n <= 1_000_000, `call of ${n}`);
  }
  assert.equal(s.get(100, 300, 100), STONE);
  assert.equal(s.misses, 0);
});

test('placed leaves are persistent unless persistent=false is written explicitly', async () => {
  const { withPersistentLeaves } = await import('../../src/core/session.ts');
  const R = reg();
  assert.equal(withPersistentLeaves('oak_leaves', R), 'oak_leaves[persistent=true]');
  assert.equal(withPersistentLeaves('minecraft:cherry_leaves[distance=1]', R), 'minecraft:cherry_leaves[persistent=true,distance=1]');
  assert.equal(withPersistentLeaves('oak_leaves[]', R), 'oak_leaves[persistent=true]');
  assert.equal(withPersistentLeaves('spruce_leaves[persistent=false]', R), 'spruce_leaves[persistent=false]');
  assert.equal(withPersistentLeaves('oak_log', R), 'oak_log');
  const be = new MemBackend();
  const s = new EditSession(be, R, { support: 'off' });
  s.set(0, 0, 0, 'oak_leaves');
  s.set(1, 0, 0, 'azalea_leaves[waterlogged=false]');
  s.set(2, 0, 0, 'birch_leaves[persistent=false]');
  await s.flush();
  assert.match(be.at(0, 0, 0), /persistent=true/);
  assert.match(be.at(1, 0, 0), /persistent=true/);
  assert.match(be.at(2, 0, 0), /persistent=false/);
});
