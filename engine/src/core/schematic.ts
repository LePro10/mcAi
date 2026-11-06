// Schematic I/O: read Sponge .schem (v1/v2/v3), vanilla structure .nbt and Litematica
// .litematic; write Sponge v3 and vanilla .nbt. Plus a StructureLibrary on disk.
// Block entity data travels inside block state strings as SNBT: `id[props]{snbt}`.

import { gzipSync } from 'node:zlib';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import nbt from 'prismarine-nbt';
import type { Vec3, BlockVolume } from './types.ts';
import type { Registry } from './registry.ts';
import type { Clipboard, ClipboardEntity } from './clipboard.ts';
import { AIR, parseBlockState, formatBlockState, blockId } from './blockstate.ts';
import { createVolume, paletteIndex, boxSize } from './volume.ts';
import { nbtToSnbt, snbtToNbt, bigToLong, type NbtTag } from './snbt.ts';
import { clipboardBlockCount } from './clipboard.ts';

/** DataVersion written into files. 26.3's exact data version is unverified; readers (WorldEdit,
 *  vanilla) run DataFixers for older versions, so we use a recent known one. */
export const DEFAULT_DATA_VERSION = 5023; // Minecraft 26.3 (misode/mcmeta 26.3-summary version.json)

export class SchematicError extends Error {
  override name = 'SchematicError';
}

type Compound = Record<string, NbtTag | undefined>;

// ------------------------------------------------------------------ helpers

/** negate without producing -0 */
function neg(v: number): number {
  return v === 0 ? 0 : -v;
}

function tagVal<T = unknown>(c: Compound | undefined, k: string): T | undefined {
  return c?.[k]?.value as T | undefined;
}

function num(c: Compound | undefined, k: string, d = 0): number {
  const t = c?.[k];
  if (!t) return d;
  return typeof t.value === 'number' ? t.value : d;
}

function listOf<T = unknown>(c: Compound | undefined, k: string): T[] {
  const t = c?.[k];
  if (!t || t.type !== 'list') return [];
  return (t.value.value ?? []) as T[];
}

function readVarints(bytes: number[], count: number): Uint32Array {
  const out = new Uint32Array(count);
  let i = 0;
  let p = 0;
  while (i < count) {
    let v = 0;
    let shift = 0;
    for (;;) {
      if (p >= bytes.length) throw new SchematicError(`block data truncated (${i}/${count} entries)`);
      const b = bytes[p++] & 0xff;
      v |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
      if (shift > 28) throw new SchematicError('varint too long in block data');
    }
    out[i++] = v >>> 0;
  }
  return out;
}

function writeVarints(values: Uint16Array | number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    let v = values[i];
    while (v & ~0x7f) {
      out.push(((v & 0x7f) | 0x80) << 24 >> 24);
      v >>>= 7;
    }
    out.push((v << 24) >> 24);
  }
  return out;
}

/** Make a canonical state from an arbitrary file state; collects warnings for unknown blocks. */
class StateResolver {
  readonly reg: Registry;
  readonly warnings: string[] = [];
  private cache = new Map<string, string>();
  constructor(reg: Registry) {
    this.reg = reg;
  }
  resolve(raw: string): string {
    let c = this.cache.get(raw);
    if (c !== undefined) return c;
    const r = this.reg.tryCanonical(raw);
    if (r.ok) c = r.state;
    else {
      // retry with the bare id (property names/values might differ between versions)
      let id = raw;
      try {
        id = parseBlockState(raw).name;
      } catch {
        /* ignore */
      }
      const r2 = this.reg.tryCanonical(id);
      if (r2.ok) {
        c = r2.state;
        this.warnings.push(`"${raw}": ${r.error} — used default state ${c}`);
      } else {
        c = AIR;
        this.warnings.push(`unknown block "${raw}" replaced with air`);
      }
    }
    this.cache.set(raw, c);
    return c;
  }
}

function stateFromNameProps(name: string, props: Compound | undefined): string {
  const p: Record<string, string> = {};
  if (props) for (const k of Object.keys(props)) p[k] = String(props[k]?.value);
  return formatBlockState({ name: name.includes(':') ? name : `minecraft:${name}`, props: p });
}

const BE_STRIP = new Set(['id', 'Id', 'x', 'y', 'z', 'Pos', 'keepPacked']);

function blockEntitySnbt(data: Compound): string | undefined {
  const c: Compound = {};
  let any = false;
  for (const k of Object.keys(data)) {
    if (BE_STRIP.has(k)) continue;
    c[k] = data[k];
    any = true;
  }
  return any ? nbtToSnbt({ type: 'compound', value: c }) : undefined;
}

function splitNbt(state: string): { base: string; snbt?: string } {
  const i = state.indexOf('{');
  if (i < 0) return { base: state };
  return { base: state.slice(0, i), snbt: state.slice(i) };
}

function setWithEntity(v: BlockVolume, idx: number, state: string, snbt: string | undefined): void {
  v.data[idx] = paletteIndex(v.palette, snbt ? state + snbt : state);
}

function readEntities(list: Compound[], posKey: string, rel: Vec3 = [0, 0, 0]): ClipboardEntity[] {
  const out: ClipboardEntity[] = [];
  for (const e of list) {
    const id = (tagVal<string>(e, 'Id') ?? tagVal<string>(e, 'id')) as string | undefined;
    const data = (e.Data?.type === 'compound' ? (e.Data.value as Compound) : e) as Compound;
    const posT = e[posKey];
    let pos: [number, number, number] = [0, 0, 0];
    if (posT?.type === 'list') pos = (posT.value.value as number[]).slice(0, 3) as [number, number, number];
    else if (posT && Array.isArray(posT.value)) pos = (posT.value as number[]).slice(0, 3) as [number, number, number];
    const eid = id ?? tagVal<string>(data, 'id') ?? 'unknown';
    const rest: Compound = {};
    for (const k of Object.keys(data)) if (!['Id', 'id', 'Pos', 'pos', 'blockPos', 'UUID'].includes(k)) rest[k] = data[k];
    out.push({
      id: eid,
      pos: [pos[0] - rel[0], pos[1] - rel[1], pos[2] - rel[2]],
      snbt: Object.keys(rest).length ? nbtToSnbt({ type: 'compound', value: rest }) : undefined,
    });
  }
  return out;
}

// ------------------------------------------------------------------ read

export type SchematicFormat = 'sponge' | 'structure' | 'litematic';

export async function readSchematic(buf: Buffer, reg: Registry): Promise<Clipboard> {
  let parsed: { parsed: { name: string; value: Compound } };
  try {
    parsed = (await nbt.parse(buf, 'big')) as unknown as typeof parsed;
  } catch (e) {
    throw new SchematicError(`not a valid NBT file: ${(e as Error).message}`);
  }
  const root = parsed.parsed.value;
  const res = new StateResolver(reg);
  let c: Clipboard;
  let format: SchematicFormat;
  if (root.Schematic?.type === 'compound') {
    c = readSponge(root.Schematic.value as Compound, res);
    format = 'sponge';
  } else if (root.Regions?.type === 'compound') {
    c = readLitematic(root, res);
    format = 'litematic';
  } else if (root.BlockData || root.Palette || (root.Width && root.Length)) {
    c = readSponge(root, res);
    format = 'sponge';
  } else if (root.size && root.blocks) {
    c = readStructure(root, res);
    format = 'structure';
  } else {
    throw new SchematicError('unrecognized schematic format (expected Sponge .schem, structure .nbt or .litematic)');
  }
  c.meta = { ...(c.meta ?? {}), format, warnings: res.warnings };
  return c;
}

function readSponge(s: Compound, res: StateResolver): Clipboard {
  const version = num(s, 'Version', 1);
  const w = num(s, 'Width') & 0xffff;
  const h = num(s, 'Height') & 0xffff;
  const l = num(s, 'Length') & 0xffff;
  if (!w || !h || !l) throw new SchematicError(`Sponge schematic has an empty size ${w}x${h}x${l}`);
  const offset = (tagVal<number[]>(s, 'Offset') ?? [0, 0, 0]) as number[];
  let paletteC: Compound | undefined;
  let data: number[] | undefined;
  let bes: Compound[];
  if (version >= 3) {
    const blocks = tagVal<Compound>(s, 'Blocks');
    paletteC = tagVal<Compound>(blocks, 'Palette');
    data = tagVal<number[]>(blocks, 'Data');
    bes = listOf<Compound>(blocks, 'BlockEntities');
  } else {
    paletteC = tagVal<Compound>(s, 'Palette');
    data = tagVal<number[]>(s, 'BlockData');
    bes = [...listOf<Compound>(s, 'BlockEntities'), ...listOf<Compound>(s, 'TileEntities')];
  }
  if (!paletteC || !data) throw new SchematicError('Sponge schematic without Palette/BlockData');
  const fileStates: string[] = [];
  for (const k of Object.keys(paletteC)) fileStates[paletteC[k]!.value as number] = k;
  const vol = createVolume({ min: [0, 0, 0], max: [w - 1, h - 1, l - 1] });
  const remap = fileStates.map((st) => (st === undefined ? 0 : paletteIndex(vol.palette, res.resolve(st))));
  const ids = readVarints(data, w * h * l);
  for (let i = 0; i < ids.length; i++) vol.data[i] = remap[ids[i]] ?? 0;
  for (const be of bes) {
    const pos = tagVal<number[]>(be, 'Pos');
    if (!pos) continue;
    const [x, y, z] = pos;
    if (x < 0 || y < 0 || z < 0 || x >= w || y >= h || z >= l) continue;
    const idx = y * w * l + z * w + x;
    const dataC = version >= 3 ? tagVal<Compound>(be, 'Data') ?? {} : be;
    const snbt = blockEntitySnbt(dataC);
    if (snbt) setWithEntity(vol, idx, vol.palette[vol.data[idx]], snbt);
  }
  // origin: v3 Offset = min - origin; v2 WorldEdit stores it in Metadata.WEOffset*
  let origin: Vec3 = [0, 0, 0];
  const md = tagVal<Compound>(s, 'Metadata');
  if (version >= 3) origin = [neg(offset[0] ?? 0), neg(offset[1] ?? 0), neg(offset[2] ?? 0)];
  else if (md && md.WEOffsetX) origin = [neg(num(md, 'WEOffsetX')), neg(num(md, 'WEOffsetY')), neg(num(md, 'WEOffsetZ'))];
  const ents = listOf<Compound>(s, 'Entities');
  const entities = ents.length ? readEntities(ents, 'Pos') : undefined;
  const meta: Record<string, unknown> = { version, dataVersion: num(s, 'DataVersion') };
  if (md) {
    const name = tagVal<string>(md, 'Name');
    const author = tagVal<string>(md, 'Author');
    if (name) meta.name = name;
    if (author) meta.author = author;
  }
  return { volume: vol, origin, entities, meta };
}

function readStructure(root: Compound, res: StateResolver): Clipboard {
  const size = listOf<number>(root, 'size');
  const [w, h, l] = size;
  if (!w || !h || !l) throw new SchematicError(`structure has an empty size ${size.join('x')}`);
  let palette = listOf<Compound>(root, 'palette');
  if (!palette.length) {
    const palettes = listOf<{ type: string; value: Compound[] }>(root, 'palettes');
    if (palettes.length) palette = (palettes[0].value ?? []) as Compound[];
  }
  const vol = createVolume({ min: [0, 0, 0], max: [w - 1, h - 1, l - 1] });
  const remap = palette.map((p) => {
    const name = tagVal<string>(p, 'Name') ?? 'minecraft:air';
    return res.resolve(stateFromNameProps(name, tagVal<Compound>(p, 'Properties')));
  });
  for (const b of listOf<Compound>(root, 'blocks')) {
    const pos = listOf<number>(b, 'pos');
    const [x, y, z] = pos;
    if (x < 0 || y < 0 || z < 0 || x >= w || y >= h || z >= l) continue;
    const st = remap[num(b, 'state')] ?? AIR;
    const nb = tagVal<Compound>(b, 'nbt');
    const snbt = nb ? blockEntitySnbt(nb) : undefined;
    setWithEntity(vol, y * w * l + z * w + x, st, snbt);
  }
  const ents = listOf<Compound>(root, 'entities').map((e) => {
    const inner = tagVal<Compound>(e, 'nbt') ?? {};
    const pos = listOf<number>(e, 'pos');
    return { Id: { type: 'string', value: tagVal<string>(inner, 'id') ?? 'unknown' }, Pos: { type: 'list', value: { type: 'double', value: pos } }, Data: { type: 'compound', value: inner } } as Compound;
  });
  return {
    volume: vol,
    origin: [0, 0, 0],
    entities: ents.length ? readEntities(ents, 'Pos') : undefined,
    meta: { dataVersion: num(root, 'DataVersion') },
  };
}

function readLitematic(root: Compound, res: StateResolver): Clipboard {
  const regions = tagVal<Compound>(root, 'Regions')!;
  type R = { min: Vec3; size: Vec3; c: Compound; name: string };
  const rs: R[] = [];
  for (const name of Object.keys(regions)) {
    const c = regions[name]!.value as Compound;
    const p = tagVal<Compound>(c, 'Position') ?? {};
    const s = tagVal<Compound>(c, 'Size') ?? {};
    const pos: Vec3 = [num(p, 'x'), num(p, 'y'), num(p, 'z')];
    const size: Vec3 = [num(s, 'x'), num(s, 'y'), num(s, 'z')];
    if (!size[0] || !size[1] || !size[2]) continue;
    const min: Vec3 = [0, 1, 2].map((a) => pos[a] + (size[a] < 0 ? size[a] + 1 : 0)) as Vec3;
    rs.push({ min, size: size.map(Math.abs) as Vec3, c, name });
  }
  if (!rs.length) throw new SchematicError('litematic has no regions');
  const gmin: Vec3 = [0, 1, 2].map((a) => Math.min(...rs.map((r) => r.min[a]))) as Vec3;
  const gmax: Vec3 = [0, 1, 2].map((a) => Math.max(...rs.map((r) => r.min[a] + r.size[a] - 1))) as Vec3;
  const vol = createVolume({ min: [0, 0, 0], max: [gmax[0] - gmin[0], gmax[1] - gmin[1], gmax[2] - gmin[2]] });
  const [W, , L] = boxSize(vol.box);
  const entities: ClipboardEntity[] = [];
  for (const r of rs) {
    const pal = listOf<Compound>(r.c, 'BlockStatePalette').map((p) =>
      res.resolve(stateFromNameProps(tagVal<string>(p, 'Name') ?? 'minecraft:air', tagVal<Compound>(p, 'Properties'))),
    );
    const remap = pal.map((s) => paletteIndex(vol.palette, s));
    const longs = (tagVal<[number, number][]>(r.c, 'BlockStates') ?? []) as [number, number][];
    const bits = Math.max(2, Math.ceil(Math.log2(Math.max(1, pal.length))));
    const words = new Uint32Array(longs.length * 2 + 1);
    for (let i = 0; i < longs.length; i++) {
      words[2 * i] = longs[i][1] >>> 0; // low
      words[2 * i + 1] = longs[i][0] >>> 0; // high
    }
    const mask = (1 << bits) - 1;
    const [sx, sy, sz] = r.size;
    const ox = r.min[0] - gmin[0];
    const oy = r.min[1] - gmin[1];
    const oz = r.min[2] - gmin[2];
    let idx = 0;
    for (let y = 0; y < sy; y++)
      for (let z = 0; z < sz; z++)
        for (let x = 0; x < sx; x++, idx++) {
          const bit = idx * bits;
          const w = bit >>> 5;
          const off = bit & 31;
          let v = words[w] >>> off;
          if (off + bits > 32) v |= words[w + 1] << (32 - off);
          v &= mask;
          const pi = remap[v] ?? 0;
          if (pi === 0) continue;
          vol.data[(oy + y) * W * L + (oz + z) * W + (ox + x)] = pi;
        }
    for (const te of listOf<Compound>(r.c, 'TileEntities')) {
      const x = num(te, 'x') + ox;
      const y = num(te, 'y') + oy;
      const z = num(te, 'z') + oz;
      if (x < 0 || y < 0 || z < 0 || x > vol.box.max[0] || y > vol.box.max[1] || z > vol.box.max[2]) continue;
      const i = y * W * L + z * W + x;
      const snbt = blockEntitySnbt(te);
      if (snbt) setWithEntity(vol, i, splitNbt(vol.palette[vol.data[i]]).base, snbt);
    }
    const ents = listOf<Compound>(r.c, 'Entities');
    for (const e of readEntities(ents, 'Pos', [-ox, -oy, -oz])) entities.push(e);
  }
  const md = tagVal<Compound>(root, 'Metadata');
  return {
    volume: vol,
    origin: [neg(gmin[0]), neg(gmin[1]), neg(gmin[2])],
    entities: entities.length ? entities : undefined,
    meta: {
      name: tagVal<string>(md, 'Name'),
      author: tagVal<string>(md, 'Author'),
      regions: rs.map((r) => r.name),
      dataVersion: num(root, 'MinecraftDataVersion'),
    },
  };
}

// ------------------------------------------------------------------ write

export interface WriteOptions {
  dataVersion?: number;
  name?: string;
  author?: string;
}

function entityTags(c: Clipboard): ClipboardEntity[] {
  return ((c.entities as ClipboardEntity[] | undefined) ?? []).filter((e) => e && typeof e.id === 'string');
}

export async function writeSponge(c: Clipboard, opts: WriteOptions = {}): Promise<Buffer> {
  const v = c.volume;
  const [w, h, l] = boxSize(v.box);
  if (w > 65535 || h > 65535 || l > 65535) throw new SchematicError('schematic dimensions must be ≤ 65535');
  const pal = new Map<string, number>();
  const filePal: string[] = [];
  const remap = new Uint16Array(v.palette.length);
  const beByIdx = new Map<number, string>();
  v.palette.forEach((s, i) => {
    const { base } = splitNbt(s);
    let k = pal.get(base);
    if (k === undefined) {
      k = filePal.length;
      pal.set(base, k);
      filePal.push(base);
    }
    remap[i] = k;
  });
  // air must exist for readers that assume it
  const ids = new Uint16Array(v.data.length);
  const bes: Compound[] = [];
  for (let i = 0; i < v.data.length; i++) {
    ids[i] = remap[v.data[i]];
    const { snbt } = splitNbt(v.palette[v.data[i]]);
    if (snbt) beByIdx.set(i, snbt);
  }
  for (const [i, snbt] of beByIdx) {
    const x = i % w;
    const z = Math.floor(i / w) % l;
    const y = Math.floor(i / (w * l));
    bes.push({
      Pos: { type: 'intArray', value: [x, y, z] },
      Id: { type: 'string', value: blockId(v.palette[v.data[i]]) },
      Data: snbtToNbt(snbt),
    });
  }
  const paletteC: Compound = {};
  filePal.forEach((s, i) => (paletteC[s] = { type: 'int', value: i }));
  const short = (n: number): NbtTag => ({ type: 'short', value: (n << 16) >> 16 });
  const md: Compound = { Date: { type: 'long', value: bigToLong(BigInt(Date.now())) } };
  const nm = opts.name ?? (c.meta?.name as string | undefined);
  const au = opts.author ?? (c.meta?.author as string | undefined);
  if (nm) md.Name = { type: 'string', value: nm };
  if (au) md.Author = { type: 'string', value: au };
  const schem: Compound = {
    Version: { type: 'int', value: 3 },
    DataVersion: { type: 'int', value: opts.dataVersion ?? DEFAULT_DATA_VERSION },
    Metadata: { type: 'compound', value: md },
    Width: short(w),
    Height: short(h),
    Length: short(l),
    Offset: { type: 'intArray', value: [neg(c.origin[0]), neg(c.origin[1]), neg(c.origin[2])] },
    Blocks: {
      type: 'compound',
      value: {
        Palette: { type: 'compound', value: paletteC },
        Data: { type: 'byteArray', value: writeVarints(ids) },
        BlockEntities: { type: 'list', value: { type: bes.length ? 'compound' : 'end', value: bes } },
      },
    },
  };
  const ents = entityTags(c);
  if (ents.length) {
    schem.Entities = {
      type: 'list',
      value: {
        type: 'compound',
        value: ents.map((e) => ({
          Id: { type: 'string', value: e.id },
          Pos: { type: 'list', value: { type: 'double', value: e.pos } },
          Data: e.snbt ? snbtToNbt(e.snbt) : { type: 'compound', value: {} },
        })),
      },
    };
  }
  const root = { type: 'compound', name: '', value: { Schematic: { type: 'compound', value: schem } } };
  return gzipSync(nbt.writeUncompressed(root as never, 'big'));
}

export async function writeStructureNbt(c: Clipboard, opts: WriteOptions = {}): Promise<Buffer> {
  const v = c.volume;
  const [w, h, l] = boxSize(v.box);
  const filePal: Compound[] = [];
  const palIdx = new Map<string, number>();
  const remap: number[] = [];
  v.palette.forEach((s, i) => {
    const { base } = splitNbt(s);
    let k = palIdx.get(base);
    if (k === undefined) {
      k = filePal.length;
      palIdx.set(base, k);
      const p = parseBlockState(base);
      const entry: Compound = { Name: { type: 'string', value: p.name } };
      const keys = Object.keys(p.props);
      if (keys.length) {
        const props: Compound = {};
        for (const key of keys) props[key] = { type: 'string', value: p.props[key] };
        entry.Properties = { type: 'compound', value: props };
      }
      filePal.push(entry);
    }
    remap[i] = k;
  });
  const blocks: Compound[] = [];
  let i = 0;
  for (let y = 0; y < h; y++)
    for (let z = 0; z < l; z++)
      for (let x = 0; x < w; x++, i++) {
        const s = v.palette[v.data[i]];
        if (s === 'minecraft:structure_void') continue;
        const b: Compound = {
          pos: { type: 'list', value: { type: 'int', value: [x, y, z] } },
          state: { type: 'int', value: remap[v.data[i]] },
        };
        const { snbt } = splitNbt(s);
        if (snbt) {
          const tag = snbtToNbt(snbt);
          tag.value.id = { type: 'string', value: blockId(s) };
          b.nbt = tag;
        }
        blocks.push(b);
      }
  const ents = entityTags(c).map((e) => {
    const data = e.snbt ? snbtToNbt(e.snbt) : ({ type: 'compound', value: {} } as NbtTag & { type: 'compound' });
    data.value.id = { type: 'string', value: e.id };
    return {
      pos: { type: 'list', value: { type: 'double', value: e.pos } },
      blockPos: { type: 'list', value: { type: 'int', value: e.pos.map(Math.floor) } },
      nbt: data,
    } as Compound;
  });
  const root = {
    type: 'compound',
    name: '',
    value: {
      DataVersion: { type: 'int', value: opts.dataVersion ?? DEFAULT_DATA_VERSION },
      size: { type: 'list', value: { type: 'int', value: [w, h, l] } },
      palette: { type: 'list', value: { type: 'compound', value: filePal } },
      blocks: { type: 'list', value: { type: blocks.length ? 'compound' : 'end', value: blocks } },
      entities: { type: 'list', value: { type: ents.length ? 'compound' : 'end', value: ents } },
    },
  };
  return gzipSync(nbt.writeUncompressed(root as never, 'big'));
}

// ------------------------------------------------------------------ StructureLibrary

export interface StructureMeta {
  name: string;
  /** file-safe slug used on disk */
  slug: string;
  description: string;
  tags: string[];
  size: Vec3;
  blocks: number;
  author: string;
  created: string;
  updated?: string;
  origin: Vec3;
}

export function defaultStructureDir(): string {
  return path.join(os.homedir(), '.mcai', 'structures');
}

/** Turn a user-facing name into a safe file name (no path traversal possible). */
export function structureSlug(name: string): string {
  if (typeof name !== 'string') throw new SchematicError('structure name must be a string');
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 64);
  if (!slug) throw new SchematicError(`invalid structure name "${name}" — use letters, digits, - and _`);
  return slug;
}

export class StructureLibrary {
  readonly dir: string;
  private reg: Registry | undefined;

  constructor(dir: string = defaultStructureDir(), reg?: Registry) {
    this.dir = path.resolve(dir);
    this.reg = reg;
  }

  private file(slug: string, ext: string): string {
    const f = path.join(this.dir, slug + ext);
    if (path.dirname(f) !== this.dir) throw new SchematicError('invalid structure path');
    return f;
  }

  private async registry(): Promise<Registry> {
    if (!this.reg) {
      const { Registry: R } = await import('./registry.ts');
      this.reg = R.loadDefault();
    }
    return this.reg;
  }

  async save(
    name: string,
    c: Clipboard,
    meta: { description?: string; tags?: string[]; author?: string } = {},
  ): Promise<StructureMeta> {
    const slug = structureSlug(name);
    await fsp.mkdir(this.dir, { recursive: true });
    let created = new Date().toISOString();
    let updated: string | undefined;
    try {
      const old = JSON.parse(await fsp.readFile(this.file(slug, '.json'), 'utf8')) as StructureMeta;
      if (old.created) {
        created = old.created;
        updated = new Date().toISOString();
      }
    } catch {
      /* new structure */
    }
    const m: StructureMeta = {
      name: String(name).slice(0, 120),
      slug,
      description: String(meta.description ?? ''),
      tags: (meta.tags ?? []).map(String),
      size: boxSize(c.volume.box),
      blocks: clipboardBlockCount(c),
      author: String(meta.author ?? 'mcai'),
      created,
      origin: [...c.origin],
    };
    if (updated) m.updated = updated;
    const buf = await writeSponge(c, { name: m.name, author: m.author });
    await fsp.writeFile(this.file(slug, '.schem'), buf);
    await fsp.writeFile(this.file(slug, '.json'), JSON.stringify(m, null, 2));
    return m;
  }

  async load(name: string): Promise<Clipboard & { meta: Record<string, unknown> }> {
    const slug = structureSlug(name);
    let buf: Buffer;
    try {
      buf = await fsp.readFile(this.file(slug, '.schem'));
    } catch {
      const known = (await this.list()).map((m) => m.slug);
      throw new SchematicError(`structure "${name}" not found${known.length ? ` (available: ${known.slice(0, 20).join(', ')})` : ''}`);
    }
    const c = await readSchematic(buf, await this.registry());
    let m: Partial<StructureMeta> = {};
    try {
      m = JSON.parse(await fsp.readFile(this.file(slug, '.json'), 'utf8'));
    } catch {
      /* no sidecar */
    }
    return { ...c, meta: { ...(c.meta ?? {}), ...m } };
  }

  async list(filter: { tag?: string; query?: string } = {}): Promise<StructureMeta[]> {
    let names: string[];
    try {
      names = await fsp.readdir(this.dir);
    } catch {
      return [];
    }
    const out: StructureMeta[] = [];
    for (const f of names) {
      if (!f.endsWith('.schem')) continue;
      const slug = f.slice(0, -6);
      let m: StructureMeta | undefined;
      try {
        m = JSON.parse(await fsp.readFile(this.file(slug, '.json'), 'utf8')) as StructureMeta;
      } catch {
        m = { name: slug, slug, description: '', tags: [], size: [0, 0, 0], blocks: 0, author: '', created: '', origin: [0, 0, 0] };
      }
      if (filter.tag && !m.tags.includes(filter.tag)) continue;
      if (filter.query) {
        const q = filter.query.toLowerCase();
        if (!`${m.name} ${m.description} ${m.tags.join(' ')}`.toLowerCase().includes(q)) continue;
      }
      out.push(m);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async has(name: string): Promise<boolean> {
    try {
      await fsp.access(this.file(structureSlug(name), '.schem'));
      return true;
    } catch {
      return false;
    }
  }

  async delete(name: string): Promise<boolean> {
    const slug = structureSlug(name);
    let ok = false;
    for (const ext of ['.schem', '.json']) {
      try {
        await fsp.unlink(this.file(slug, ext));
        ok = true;
      } catch {
        /* missing */
      }
    }
    return ok;
  }
}
