// SimBackend: in-memory Minecraft-like world implementing WorldBackend (see ARCHITECTURE §4).
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import type {
  BiomeSample, BlockRegistry, BlockVolume, Box, EditBatch, EntityInfo, HeightmapResult, PlayerInfo,
  PlayerNotification, SetBlocksOptions, SetBlocksResult, Vec3, WorldBackend, WorldInfo,
} from '../core/types.ts';
import { Registry } from '../core/registry.ts';
import { solveConnections } from '../core/connect.ts';
import { blockId } from '../core/blockstate.ts';
import { TerrainGen, MIN_Y, MAX_Y, SEA, GEN_VERSION } from './terrain.ts';
import { World, SECTIONS, type Chunk } from './world.ts';
import { runSimCommand } from './commands.ts';

export interface SimOptions {
  seed?: number;
  name?: string;
  /** directory for save()/load() (world.bin.gz); loaded automatically if present */
  persistDir?: string;
  registry?: Registry;
  /** fake players; default one "Steve" at spawn. Pass [] for none. */
  players?: PlayerInfo[];
}

export interface SimState {
  time: number;
  weather: 'clear' | 'rain' | 'thunder';
  gamerules: Record<string, string>;
  entities: EntityInfo[];
  biomeOverrides: { box: Box; biome: string }[];
}

const OVERWORLD = 'minecraft:overworld';
const MAX_GET = 64 * 1024 * 1024;

export function offlineUuid(name: string): string {
  const h = createHash('md5').update(`OfflinePlayer:${name}`).digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

function checkDim(d?: string): void {
  if (d === undefined || d === OVERWORLD || d === 'overworld') return;
  throw new Error(`the simulation only has ${OVERWORLD} (got "${d}")`);
}

export class SimBackend implements WorldBackend {
  readonly kind = 'sim' as const;
  seed: number;
  readonly name: string;
  readonly reg: Registry;
  world: World;
  readonly state: SimState = { time: 1000, weather: 'clear', gamerules: {}, entities: [], biomeOverrides: [] };
  readonly notifications: PlayerNotification[] = [];
  private persistDir?: string;
  private emitter = new EventEmitter();
  private playerList: PlayerInfo[] = [];
  private validCache = new Map<string, { ok: true; state: string } | { ok: false; error: string }>();

  constructor(opts: SimOptions = {}) {
    this.seed = opts.seed ?? 20263;
    this.name = opts.name ?? 'Simulation';
    this.reg = opts.registry ?? Registry.loadDefault();
    this.world = new World(new TerrainGen(this.seed));
    this.persistDir = opts.persistDir;
    this.emitter.setMaxListeners(100);
    let loaded = false;
    if (this.persistDir && existsSync(join(this.persistDir, 'world.bin.gz'))) loaded = this.loadSync();
    if (!loaded) {
      if (opts.players) for (const p of opts.players) this.addPlayer(p);
      else {
        const sp = this.spawnPoint();
        this.addPlayer({ name: 'Steve', uuid: offlineUuid('Steve'), pos: sp, yaw: 180, pitch: 0, dimension: OVERWORLD, gameMode: 'creative' });
      }
    }
  }

  on(event: 'blocks' | 'notify' | 'command', cb: (...a: any[]) => void): void {
    this.emitter.on(event, cb);
  }
  off(event: 'blocks' | 'notify' | 'command', cb: (...a: any[]) => void): void {
    this.emitter.off(event, cb);
  }

  /** first dry land near the origin (surface + 1) */
  spawnPoint(): [number, number, number] {
    const gen = this.world.gen;
    for (let r = 0; r < 512; r += 8)
      for (let a = 0; a < Math.max(1, r); a += 4) {
        const t = (a / Math.max(1, r)) * Math.PI * 2;
        const x = Math.round(Math.cos(t) * r), z = Math.round(Math.sin(t) * r);
        const c = gen.column(x, z);
        if (c.h > SEA && c.h < 110 && c.biome !== 'river' && c.biome !== 'ocean') {
          const y = this.topY(x, z);
          return [x + 0.5, y + 1, z + 0.5];
        }
      }
    return [0.5, this.topY(0, 0) + 1, 0.5];
  }

  addPlayer(p: PlayerInfo): void {
    this.playerList = this.playerList.filter((q) => q.name !== p.name);
    this.playerList.push({ ...p, dimension: p.dimension ?? OVERWORLD });
  }
  removePlayer(name: string): void {
    this.playerList = this.playerList.filter((q) => q.name !== name);
  }

  async info(): Promise<WorldInfo> {
    return { name: this.name, minY: MIN_Y, maxY: MAX_Y, seaLevel: SEA, mcVersion: this.reg.version, dimension: OVERWORLD };
  }

  async registry(): Promise<BlockRegistry> {
    return this.reg.data;
  }

  // ------------------------------------------------------------------------- blocks
  getBlocksSync(box: Box): BlockVolume {
    const [x0, y0, z0] = box.min, [x1, y1, z1] = box.max;
    const sx = x1 - x0 + 1, sy = y1 - y0 + 1, sz = z1 - z0 + 1;
    if (sx <= 0 || sy <= 0 || sz <= 0) throw new RangeError('getBlocks: box is not normalized');
    if (sx * sy * sz > MAX_GET) throw new RangeError(`getBlocks: ${sx * sy * sz} blocks exceeds ${MAX_GET}`);
    const data = new Uint16Array(sx * sy * sz);
    const palette = ['minecraft:air'];
    const W = this.world;
    const map = new Int32Array(W.states.length).fill(-1);
    map[0] = 0;
    const local = (id: number) => {
      let m = map[id];
      if (m < 0) {
        m = palette.length;
        palette.push(W.states[id]);
        map[id] = m;
      }
      return m;
    };
    const layer = sx * sz;
    const ya = Math.max(y0, MIN_Y), yb = Math.min(y1, MAX_Y);
    for (let cz = z0 >> 4; cz <= z1 >> 4; cz++)
      for (let cx = x0 >> 4; cx <= x1 >> 4; cx++) {
        const c = W.chunk(cx, cz);
        const ax = Math.max(x0, cx * 16), bx = Math.min(x1, cx * 16 + 15);
        const az = Math.max(z0, cz * 16), bz = Math.min(z1, cz * 16 + 15);
        for (let y = ya; y <= yb; y++) {
          const ly = y - MIN_Y;
          const sec = c.sections[ly >> 4];
          const rowBase = (y - y0) * layer;
          if (typeof sec === 'number') {
            if (sec === 0) continue;
            const m = local(sec);
            for (let z = az; z <= bz; z++) {
              const o = rowBase + (z - z0) * sx - x0;
              data.fill(m, o + ax, o + bx + 1);
            }
            continue;
          }
          const sb = (ly & 15) << 8;
          for (let z = az; z <= bz; z++) {
            const o = rowBase + (z - z0) * sx - x0;
            const so = sb | ((z & 15) << 4);
            for (let x = ax; x <= bx; x++) {
              const id = sec[so | (x & 15)];
              if (id !== 0) data[o + x] = id < map.length && map[id] >= 0 ? map[id] : local(id);
            }
          }
        }
      }
    return { box: { min: [x0, y0, z0], max: [x1, y1, z1] }, palette, data };
  }

  async getBlocks(box: Box, dimension?: string): Promise<BlockVolume> {
    checkDim(dimension);
    return this.getBlocksSync(box);
  }

  private validate(state: string): { ok: true; state: string } | { ok: false; error: string } {
    let r = this.validCache.get(state);
    if (!r) {
      r = this.reg.tryCanonical(state);
      if (this.validCache.size > 100_000) this.validCache.clear();
      this.validCache.set(state, r);
    }
    return r;
  }

  setBlocksSync(batch: EditBatch, opts: SetBlocksOptions = {}): SetBlocksResult {
    const W = this.world;
    const n = batch.states.length;
    // map batch palette → world ids (validated)
    const pid = new Int32Array(batch.palette.length);
    const perr: string[] = [];
    for (let i = 0; i < batch.palette.length; i++) {
      const v = this.validate(batch.palette[i]);
      if (v.ok) pid[i] = W.id(v.state);
      else {
        pid[i] = -1;
        perr[i] = v.error;
      }
    }
    const prevIds = new Uint16Array(n);
    const failed: { index: number; reason: string }[] = [];
    let placed = 0, unchanged = 0;
    const pos = batch.positions;
    const changed: number[] = [];
    let lastCx = NaN, lastCz = NaN;
    let c: Chunk | null = null;
    for (let i = 0; i < n; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      if (y < MIN_Y || y > MAX_Y) {
        failed.push({ index: i, reason: `y=${y} is outside the world (${MIN_Y}..${MAX_Y})` });
        continue;
      }
      const cx = x >> 4, cz = z >> 4;
      if (cx !== lastCx || cz !== lastCz) {
        c = W.chunk(cx, cz);
        lastCx = cx;
        lastCz = cz;
      }
      const si = batch.states[i];
      const id = pid[si];
      if (id === undefined || id < 0) {
        prevIds[i] = W.readIn(c!, x & 15, y - MIN_Y, z & 15);
        failed.push({ index: i, reason: perr[si] ?? `bad palette index ${si}` });
        continue;
      }
      const prev = W.writeIn(c!, x & 15, y - MIN_Y, z & 15, id);
      prevIds[i] = prev;
      if (prev === id) unchanged++;
      else {
        placed++;
        changed.push(i);
      }
    }
    // previous batch (same positions)
    const ppal: string[] = [];
    const pmap = new Map<number, number>();
    const pstates = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
      const id = prevIds[i];
      let m = pmap.get(id);
      if (m === undefined) {
        m = ppal.length;
        ppal.push(W.states[id]);
        pmap.set(id, m);
      }
      pstates[i] = m;
    }
    const previous: EditBatch = { palette: ppal, positions: new Int32Array(pos.subarray(0, n * 3)), states: pstates };
    // shape updates (fences/panes/walls/stairs...) like the real game's second pass
    const extra: [number, number, number, string][] = [];
    if ((opts.updateShapes ?? true) && changed.length) {
      try {
        const positions: Vec3[] = changed.map((i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
        const upd = solveConnections((x, y, z) => W.get(x, y, z), positions, this.reg);
        for (const [x, y, z, s] of upd) {
          if (y < MIN_Y || y > MAX_Y) continue;
          W.setId(x, y, z, W.id(s));
          extra.push([x, y, z, s]);
        }
      } catch {
        /* connection solving is best effort */
      }
    }
    if (changed.length || extra.length) {
      const palette: string[] = [];
      const m = new Map<string, number>();
      const total = changed.length + extra.length;
      const positions = new Int32Array(total * 3);
      const states = new Uint16Array(total);
      const add = (k: number, x: number, y: number, z: number, s: string) => {
        let j = m.get(s);
        if (j === undefined) {
          j = palette.length;
          palette.push(s);
          m.set(s, j);
        }
        positions[k * 3] = x; positions[k * 3 + 1] = y; positions[k * 3 + 2] = z;
        states[k] = j;
      };
      let k = 0;
      for (const i of changed) add(k++, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], W.get(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]));
      for (const [x, y, z, s] of extra) add(k++, x, y, z, s);
      this.emitter.emit('blocks', { palette, positions, states } satisfies EditBatch);
    }
    return { placed, unchanged, failed, previous };
  }

  async setBlocks(batch: EditBatch, opts?: SetBlocksOptions): Promise<SetBlocksResult> {
    checkDim(opts?.dimension);
    return this.setBlocksSync(batch, opts);
  }

  // ------------------------------------------------------------------------- heightmaps / biomes
  /** y of the highest non-air block (MIN_Y - 1 if none) */
  topY(x: number, z: number, oceanFloor = false): number {
    const W = this.world;
    const c = W.chunk(x >> 4, z >> 4);
    const lx = x & 15, lz = z & 15;
    for (let s = SECTIONS - 1; s >= 0; s--) {
      const sec = c.sections[s];
      if (sec === 0) continue;
      for (let ly = 15; ly >= 0; ly--) {
        const id = typeof sec === 'number' ? sec : sec[(ly << 8) | (lz << 4) | lx];
        if (id === 0) continue;
        if (oceanFloor && !this.isFloor(id)) continue;
        return MIN_Y + s * 16 + ly;
      }
    }
    return MIN_Y - 1;
  }

  private floorCache = new Map<number, boolean>();
  private isFloor(id: number): boolean {
    let v = this.floorCache.get(id);
    if (v === undefined) {
      const s = this.world.states[id];
      const bid = blockId(s);
      v = !/water|lava|bubble_column|seagrass|kelp|lily_pad|short_grass|tall_grass|fern|flower|petals|dead_bush|snow\[|vine|sapling|_leaves/.test(bid) &&
        !/^(minecraft:)?(dandelion|poppy|cornflower|oxeye_daisy|azure_bluet|allium|.*_tulip|air|cave_air)$/.test(bid);
      this.floorCache.set(id, v);
    }
    return v;
  }

  async heightmap(x0: number, z0: number, x1: number, z1: number, kind: 'surface' | 'ocean_floor' = 'surface', dimension?: string): Promise<HeightmapResult> {
    checkDim(dimension);
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1), az = Math.min(z0, z1), bz = Math.max(z0, z1);
    const w = bx - ax + 1, d = bz - az + 1;
    if (w * d > 16_777_216) throw new RangeError('heightmap area too large');
    const data = new Int16Array(w * d);
    for (let z = az; z <= bz; z++) for (let x = ax; x <= bx; x++) data[(z - az) * w + (x - ax)] = this.topY(x, z, kind === 'ocean_floor');
    return { x0: ax, z0: az, x1: bx, z1: bz, data };
  }

  biomeAt(x: number, y: number, z: number): string {
    const o = this.state.biomeOverrides;
    for (let i = o.length - 1; i >= 0; i--) {
      const b = o[i].box;
      if (x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1] && z >= b.min[2] && z <= b.max[2]) return o[i].biome;
    }
    return `minecraft:${this.world.gen.column(x, z).biome}`;
  }

  /** samples at min + i*step on each axis; layout x fastest, then z, then y (ceil(size/step) per axis) */
  async biomes(box: Box, step: number, dimension?: string): Promise<BiomeSample> {
    checkDim(dimension);
    const st = Math.max(1, Math.floor(step || 1));
    const nx = Math.ceil((box.max[0] - box.min[0] + 1) / st), ny = Math.ceil((box.max[1] - box.min[1] + 1) / st), nz = Math.ceil((box.max[2] - box.min[2] + 1) / st);
    if (nx * ny * nz > 16_777_216) throw new RangeError('biome sample grid too large');
    const palette: string[] = [];
    const pm = new Map<string, number>();
    const data = new Uint16Array(nx * ny * nz);
    const colCache = new Map<number, string>();
    const hasOverrides = this.state.biomeOverrides.length > 0;
    for (let j = 0; j < ny; j++)
      for (let k = 0; k < nz; k++)
        for (let i = 0; i < nx; i++) {
          const x = box.min[0] + i * st, y = box.min[1] + j * st, z = box.min[2] + k * st;
          let b: string;
          if (hasOverrides) b = this.biomeAt(x, y, z);
          else {
            const key = k * nx + i;
            b = colCache.get(key) ?? `minecraft:${this.world.gen.column(x, z).biome}`;
            colCache.set(key, b);
          }
          let p = pm.get(b);
          if (p === undefined) {
            p = palette.length;
            palette.push(b);
            pm.set(b, p);
          }
          data[(j * nz + k) * nx + i] = p;
        }
    return { palette, data, step: st };
  }

  // ------------------------------------------------------------------------- entities / players / commands
  async entities(box: Box, dimension?: string): Promise<EntityInfo[]> {
    checkDim(dimension);
    return this.state.entities.filter(
      (e) => e.pos[0] >= box.min[0] && e.pos[0] < box.max[0] + 1 && e.pos[1] >= box.min[1] && e.pos[1] < box.max[1] + 1 &&
        e.pos[2] >= box.min[2] && e.pos[2] < box.max[2] + 1,
    ).map((e) => ({ ...e, pos: [...e.pos] as [number, number, number] }));
  }

  async players(): Promise<PlayerInfo[]> {
    return this.playerList.map((p) => ({ ...p, pos: [...p.pos] as [number, number, number] }));
  }

  playerPos(name?: string): [number, number, number] | undefined {
    return (name ? this.playerList.find((p) => p.name === name) : undefined)?.pos;
  }

  async runCommand(cmd: string, opts?: { as?: string }): Promise<{ ok: boolean; output: string }> {
    const r = runSimCommand(this, cmd, opts?.as);
    this.emitter.emit('command', { command: cmd, as: opts?.as, ...r });
    return r;
  }

  async notify(n: PlayerNotification): Promise<void> {
    this.notifications.push(n);
    if (this.notifications.length > 500) this.notifications.splice(0, this.notifications.length - 500);
    this.emitter.emit('notify', n);
  }

  /** used by commands.ts */
  newUuid(): string {
    return randomUUID();
  }

  // ------------------------------------------------------------------------- persistence
  /** Save modified sections + state to persistDir/world.bin.gz (gzip, compact binary). */
  async save(): Promise<void> {
    if (!this.persistDir) return;
    mkdirSync(this.persistDir, { recursive: true });
    const W = this.world;
    const sections: { cx: number; cz: number; s: number; palette: string[]; wide: boolean; uniform: boolean }[] = [];
    const blobs: Buffer[] = [];
    for (const c of W.chunks.values()) {
      if (!c.dirty) continue;
      for (let s = 0; s < SECTIONS; s++) {
        if (!(c.dirty & (1 << s))) continue;
        const sec = c.sections[s];
        if (typeof sec === 'number') {
          sections.push({ cx: c.cx, cz: c.cz, s, palette: [W.states[sec]], wide: false, uniform: true });
          continue;
        }
        const pm = new Map<number, number>();
        const palette: string[] = [];
        for (let i = 0; i < 4096; i++)
          if (!pm.has(sec[i])) {
            pm.set(sec[i], palette.length);
            palette.push(W.states[sec[i]]);
          }
        const wide = palette.length > 256;
        const out = wide ? new Uint16Array(4096) : new Uint8Array(4096);
        for (let i = 0; i < 4096; i++) out[i] = pm.get(sec[i])!;
        sections.push({ cx: c.cx, cz: c.cz, s, palette, wide, uniform: false });
        blobs.push(Buffer.from(out.buffer, out.byteOffset, out.byteLength));
      }
    }
    const header = Buffer.from(JSON.stringify({
      format: 1, gen: GEN_VERSION, seed: this.seed, name: this.name, state: this.state, players: this.playerList, sections,
    }), 'utf8');
    const head = Buffer.alloc(12);
    head.write('MCAISIM1', 0, 'ascii');
    head.writeUInt32LE(header.length, 8);
    const file = gzipSync(Buffer.concat([head, header, ...blobs]), { level: 6 });
    const p = join(this.persistDir, 'world.bin.gz');
    writeFileSync(p + '.tmp', file);
    renameSync(p + '.tmp', p);
  }

  /** Load persistDir/world.bin.gz (replaces modified sections and state). */
  async load(): Promise<boolean> {
    return this.loadSync();
  }

  private loadSync(): boolean {
    if (!this.persistDir) return false;
    const p = join(this.persistDir, 'world.bin.gz');
    if (!existsSync(p)) return false;
    const buf = gunzipSync(readFileSync(p));
    if (buf.toString('ascii', 0, 8) !== 'MCAISIM1') throw new Error(`${p}: not a simulation save`);
    const hl = buf.readUInt32LE(8);
    const h = JSON.parse(buf.toString('utf8', 12, 12 + hl));
    if (h.seed !== this.world.gen.seed) {
      this.seed = h.seed;
      this.world = new World(new TerrainGen(h.seed));
    }
    Object.assign(this.state, h.state);
    this.playerList = h.players ?? [];
    let off = 12 + hl;
    const W = this.world;
    for (const s of h.sections) {
      const c = W.chunk(s.cx, s.cz);
      const ids = (s.palette as string[]).map((st) => W.id(st));
      if (s.uniform) c.sections[s.s] = ids[0];
      else {
        const n = s.wide ? 8192 : 4096;
        const raw = buf.subarray(off, off + n);
        off += n;
        const arr = new Uint16Array(4096);
        if (s.wide) {
          const src = new Uint16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + n));
          for (let i = 0; i < 4096; i++) arr[i] = ids[src[i]];
        } else for (let i = 0; i < 4096; i++) arr[i] = ids[raw[i]];
        c.sections[s.s] = arr;
      }
      c.dirty |= 1 << s.s;
    }
    return true;
  }
}
