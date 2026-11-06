import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import nbt from 'prismarine-nbt';
import { readSchematic, writeSponge, writeStructureNbt, StructureLibrary, structureSlug } from '../../src/core/schematic.ts';
import { nbtToSnbt, snbtToNbt, normalizeSnbt, bigToLong, longToBig } from '../../src/core/snbt.ts';
import { createVolume, volGet, volSet, boxSize } from '../../src/core/volume.ts';
import type { Clipboard } from '../../src/core/clipboard.ts';
import { reg } from './helpers.ts';

const CHEST = 'minecraft:chest[facing=west,type=single,waterlogged=false]';
const CHEST_NBT = '{CustomName:"\\"Loot\\"",Items:[{Slot:0b,count:3,id:"minecraft:diamond"},{Slot:5b,count:64,id:"minecraft:oak_log"}],Lock:{},xs:[I;1,2,3],zs:[L;5L,-7L],f:1.5f,d:-2.25d,s:7s,big:9007199254740993L}';

function bigClipboard(): Clipboard {
  const v = createVolume({ min: [0, 0, 0], max: [6, 4, 5] });
  // > 128 palette entries → multi-byte varints
  const ids = reg()
    .ids()
    .filter((id) => /_(wool|concrete|terracotta|planks|log|stairs|slab|glass)$/.test(id))
    .slice(0, 150);
  let k = 0;
  for (let y = 0; y < 5; y++)
    for (let z = 0; z < 6; z++)
      for (let x = 0; x < 7; x++) {
        if ((x + y + z) % 5 === 0) continue; // keep some air
        volSet(v, x, y, z, reg().canonical(ids[k++ % ids.length]));
      }
  volSet(v, 3, 2, 1, `${CHEST}${normalizeSnbt(CHEST_NBT)}`);
  return { volume: v, origin: [3, 0, 2], entities: [{ id: 'minecraft:armor_stand', pos: [1.5, 1, 2.5], snbt: '{Invisible:1b}' }] };
}

function assertSameBlocks(a: Clipboard, b: Clipboard): void {
  assert.deepEqual(boxSize(a.volume.box), boxSize(b.volume.box));
  const [sx, sy, sz] = boxSize(a.volume.box);
  for (let y = 0; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++) {
        const s1 = volGet(a.volume, a.volume.box.min[0] + x, a.volume.box.min[1] + y, a.volume.box.min[2] + z);
        const s2 = volGet(b.volume, b.volume.box.min[0] + x, b.volume.box.min[1] + y, b.volume.box.min[2] + z);
        assert.equal(s2, s1, `at ${x},${y},${z}`);
      }
}

test('SNBT parse/stringify round trip incl. typed numbers, arrays, longs, quoting', () => {
  const t = snbtToNbt(CHEST_NBT);
  assert.equal(t.value.f!.type, 'float');
  assert.equal(t.value.d!.type, 'double');
  assert.equal(t.value.s!.type, 'short');
  assert.equal(t.value.xs!.type, 'intArray');
  assert.equal(t.value.zs!.type, 'longArray');
  assert.equal(t.value.CustomName!.value, '"Loot"');
  assert.equal(longToBig((t.value.big as { value: [number, number] }).value), 9007199254740993n);
  const s = nbtToSnbt(t);
  assert.equal(normalizeSnbt(s), s, 'stable');
  assert.deepEqual(snbtToNbt(s), t);
  assert.deepEqual(snbtToNbt("{'a b':'x',n:true,e:[],l:[1,2],w:hello}").value, {
    'a b': { type: 'string', value: 'x' },
    n: { type: 'byte', value: 1 },
    e: { type: 'list', value: { type: 'end', value: [] } },
    l: { type: 'list', value: { type: 'int', value: [1, 2] } },
    w: { type: 'string', value: 'hello' },
  });
  assert.equal(longToBig(bigToLong(-5n)), -5n);
  assert.throws(() => snbtToNbt('{a:'), /SNBT|expected/);
  assert.throws(() => snbtToNbt('[1,2]'), /compound/);
});

test('Sponge v3 write → read round trip (palette > 128, block entity SNBT, origin, entities)', async () => {
  const c = bigClipboard();
  const buf = await writeSponge(c);
  assert.equal(buf[0], 0x1f, 'gzip');
  const back = await readSchematic(buf, reg());
  assert.equal(back.meta?.format, 'sponge');
  assert.deepEqual(back.meta?.warnings, []);
  assertSameBlocks(c, back);
  assert.deepEqual(back.origin, [3, 0, 2]);
  assert.equal(volGet(back.volume, 3, 2, 1), `${CHEST}${normalizeSnbt(CHEST_NBT)}`);
  assert.deepEqual(back.entities, [{ id: 'minecraft:armor_stand', pos: [1.5, 1, 2.5], snbt: '{Invisible:1b}' }]);
});

test('vanilla structure .nbt write → read round trip', async () => {
  const c = bigClipboard();
  const buf = await writeStructureNbt(c);
  const back = await readSchematic(buf, reg());
  assert.equal(back.meta?.format, 'structure');
  assertSameBlocks(c, back);
  assert.equal(volGet(back.volume, 3, 2, 1), `${CHEST}${normalizeSnbt(CHEST_NBT)}`);
  assert.equal((back.entities as { id: string }[])[0].id, 'minecraft:armor_stand');
  // the file itself carries an id inside the block nbt, like vanilla
  const parsed = (await nbt.parse(buf)).parsed as unknown as { value: Record<string, any> };
  const withNbt = parsed.value.blocks.value.value.find((b: any) => b.nbt);
  assert.equal(withNbt.nbt.value.id.value, 'minecraft:chest');
  assert.deepEqual(parsed.value.size.value, { type: 'int', value: [7, 5, 6] });
});

function varints(vals: number[]): number[] {
  const out: number[] = [];
  for (let v of vals) {
    while (v > 0x7f) {
      out.push(((v & 0x7f) | 0x80) << 24 >> 24);
      v >>>= 7;
    }
    out.push(v);
  }
  return out;
}

test('reads a hand-made Sponge v2 file (WorldEdit metadata offset, unknown block warning)', async () => {
  const W = 2, H = 1, L = 2;
  const palette = { 'minecraft:air': 0, 'minecraft:stone': 1, 'minecraft:oak_stairs[facing=east]': 200, 'minecraft:not_a_block': 3 };
  const data = varints([1, 200, 0, 3]);
  const root = {
    type: 'compound',
    name: 'Schematic',
    value: {
      Version: { type: 'int', value: 2 },
      DataVersion: { type: 'int', value: 3700 },
      Width: { type: 'short', value: W },
      Height: { type: 'short', value: H },
      Length: { type: 'short', value: L },
      Offset: { type: 'intArray', value: [100, 64, 100] },
      Metadata: { type: 'compound', value: { WEOffsetX: { type: 'int', value: -1 }, WEOffsetY: { type: 'int', value: 0 }, WEOffsetZ: { type: 'int', value: -1 } } },
      PaletteMax: { type: 'int', value: 4 },
      Palette: { type: 'compound', value: Object.fromEntries(Object.entries(palette).map(([k, v]) => [k, { type: 'int', value: v }])) },
      BlockData: { type: 'byteArray', value: data },
      BlockEntities: {
        type: 'list',
        value: { type: 'compound', value: [{ Pos: { type: 'intArray', value: [0, 0, 0] }, Id: { type: 'string', value: 'minecraft:sign' }, Text: { type: 'string', value: 'hi' } }] },
      },
    },
  };
  const buf = gzipSync(nbt.writeUncompressed(root as never));
  const c = await readSchematic(buf, reg());
  assert.equal(volGet(c.volume, 0, 0, 0), 'minecraft:stone{Text:"hi"}');
  assert.equal(volGet(c.volume, 1, 0, 0), 'minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]');
  assert.equal(volGet(c.volume, 0, 0, 1), 'minecraft:air');
  assert.equal(volGet(c.volume, 1, 0, 1), 'minecraft:air');
  assert.deepEqual(c.origin, [1, 0, 1]);
  assert.match((c.meta?.warnings as string[]).join(), /not_a_block/);
});

function packLongs(values: number[], bits: number): [number, number][] {
  const total = values.length * bits;
  const words = new Uint32Array(Math.ceil(total / 64) * 2);
  values.forEach((v, i) => {
    for (let b = 0; b < bits; b++) {
      if ((v >> b) & 1) {
        const bit = i * bits + b;
        words[bit >>> 5] |= 1 << (bit & 31);
      }
    }
  });
  const out: [number, number][] = [];
  for (let i = 0; i < words.length; i += 2) out.push([words[i + 1] | 0, words[i] | 0]);
  return out;
}

test('reads a hand-made Litematica file (bit-packed spanning longs, multiple regions, negative size, tile entities)', async () => {
  const pal = ['minecraft:air', 'minecraft:stone', 'minecraft:dirt', 'minecraft:glass', 'minecraft:oak_planks', 'minecraft:chest[facing=north]'];
  const palTag = { type: 'list', value: { type: 'compound', value: pal.map((s) => {
    const m = /^([^[]+)(?:\[(.*)\])?$/.exec(s)!;
    const e: Record<string, unknown> = { Name: { type: 'string', value: m[1] } };
    if (m[2]) e.Properties = { type: 'compound', value: Object.fromEntries(m[2].split(',').map((kv) => { const [k, v] = kv.split('='); return [k, { type: 'string', value: v }]; })) };
    return e;
  }) } };
  // region A: 5x3x5 at (0,0,0), 3 bits per entry → entries straddle long boundaries (64 % 3 != 0)
  const sx = 5, sy = 3, sz = 5;
  const valsA: number[] = [];
  for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) valsA.push((x + 2 * z + 3 * y) % 5);
  // region B: size (-2, 1, 1) at position (10, 0, 0) → occupies x 9..10
  const valsB = [3, 5];
  const xyz = (x: number, y: number, z: number) => ({ type: 'compound', value: { x: { type: 'int', value: x }, y: { type: 'int', value: y }, z: { type: 'int', value: z } } });
  const region = (pos: number[], size: number[], vals: number[], tes: unknown[]) => ({
    type: 'compound',
    value: {
      Position: xyz(pos[0], pos[1], pos[2]),
      Size: xyz(size[0], size[1], size[2]),
      BlockStatePalette: palTag,
      BlockStates: { type: 'longArray', value: packLongs(vals, 3) },
      TileEntities: { type: 'list', value: { type: tes.length ? 'compound' : 'end', value: tes } },
      Entities: { type: 'list', value: { type: 'end', value: [] } },
    },
  });
  const root = {
    type: 'compound',
    name: '',
    value: {
      Version: { type: 'int', value: 6 },
      MinecraftDataVersion: { type: 'int', value: 4000 },
      Metadata: { type: 'compound', value: { Name: { type: 'string', value: 'test' }, Author: { type: 'string', value: 'me' } } },
      Regions: {
        type: 'compound',
        value: {
          A: region([0, 0, 0], [sx, sy, sz], valsA, []),
          B: region([10, 0, 0], [-2, 1, 1], valsB, [
            { x: { type: 'int', value: 1 }, y: { type: 'int', value: 0 }, z: { type: 'int', value: 0 }, id: { type: 'string', value: 'minecraft:chest' }, Lock: { type: 'string', value: 'k' } },
          ]),
        },
      },
    },
  };
  const buf = gzipSync(nbt.writeUncompressed(root as never));
  const c = await readSchematic(buf, reg());
  assert.equal(c.meta?.format, 'litematic');
  assert.deepEqual(boxSize(c.volume.box), [11, 3, 5]);
  const canon = pal.map((s) => reg().canonical(s));
  for (let y = 0; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++) assert.equal(volGet(c.volume, x, y, z), canon[(x + 2 * z + 3 * y) % 5], `${x},${y},${z}`);
  assert.equal(volGet(c.volume, 9, 0, 0), canon[3]);
  assert.equal(volGet(c.volume, 10, 0, 0), canon[5] + '{Lock:"k"}');
  assert.equal(c.meta?.name, 'test');
});

test('rejects non-NBT and unknown formats with a clear error', async () => {
  await assert.rejects(readSchematic(Buffer.from('hello world'), reg()), /NBT|schematic/);
  const buf = nbt.writeUncompressed({ type: 'compound', name: '', value: { foo: { type: 'int', value: 1 } } } as never);
  await assert.rejects(readSchematic(buf, reg()), /unrecognized schematic format/);
});

test('StructureLibrary: save/list/load/delete with sidecar meta and safe names', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcai-lib-'));
  try {
    const lib = new StructureLibrary(dir, reg());
    const c = bigClipboard();
    const m = await lib.save('Fancy Tower #1', c, { description: 'a tower', tags: ['medieval', 'tower'], author: 'tester' });
    assert.equal(m.slug, 'fancy-tower-1');
    assert.deepEqual(m.size, [7, 5, 6]);
    assert.ok(m.blocks > 100);
    assert.ok(Date.parse(m.created));
    assert.deepEqual(readdirSync(dir).sort(), ['fancy-tower-1.json', 'fancy-tower-1.schem']);
    const list = await lib.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].description, 'a tower');
    assert.equal((await lib.list({ tag: 'medieval' })).length, 1);
    assert.equal((await lib.list({ tag: 'modern' })).length, 0);
    assert.equal((await lib.list({ query: 'TOWER' })).length, 1);
    const back = await lib.load('fancy tower 1');
    assertSameBlocks(c, back);
    assert.deepEqual(back.origin, c.origin);
    assert.equal(back.meta.author, 'tester');
    // re-save keeps created and adds updated
    const m2 = await lib.save('Fancy Tower #1', c);
    assert.equal(m2.created, m.created);
    assert.ok(m2.updated);
    // traversal attempts stay inside the directory
    const evil = await lib.save('../../etc/passwd', c);
    assert.equal(evil.slug, 'etc-passwd');
    assert.ok(existsSync(path.join(dir, 'etc-passwd.schem')));
    assert.throws(() => structureSlug('../..'), /invalid structure name/);
    assert.throws(() => structureSlug(''), /invalid structure name/);
    assert.equal(structureSlug('a/b\\c\0d'), 'a-b-c-d');
    await assert.rejects(lib.load('missing'), /not found \(available: /);
    assert.ok(await lib.has('etc-passwd'));
    assert.ok(await lib.delete('etc-passwd'));
    assert.ok(!(await lib.delete('etc-passwd')));
    assert.equal((await lib.list()).length, 1);
    assert.deepEqual(await new StructureLibrary(path.join(dir, 'nope')).list(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
