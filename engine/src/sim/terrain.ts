// Deterministic, lazy terrain generator for the simulation (per chunk, seeded).
// Rolling hills, mountains, rivers, oceans/lakes at sea level 63, beaches, biomes with
// matching surface blocks, vegetation and simple trees. Ore-free stone/deepslate below.
import { Noise2, rand3, smoothstep } from './noise.ts';

export const MIN_Y = -64;
export const MAX_Y = 319;
export const SEA = 63;
export const GEN_VERSION = 1;

export type Biome =
  | 'plains' | 'forest' | 'birch_forest' | 'taiga' | 'snowy_plains' | 'snowy_taiga' | 'desert' | 'savanna'
  | 'cherry_grove' | 'swamp' | 'beach' | 'river' | 'ocean' | 'frozen_ocean' | 'stony_peaks' | 'snowy_slopes' | 'meadow';

export interface Column {
  h: number;
  biome: Biome;
  /** steep slope → bare stone */
  steep: boolean;
}

/** callback used to place blocks while generating (only called for positions inside the chunk) */
export type Put = (x: number, y: number, z: number, state: string) => void;
export type Get = (x: number, y: number, z: number) => string;

const S = (s: string) => `minecraft:${s}`;
// canonical states used by the generator (all properties, sorted)
const B = {
  air: S('air'), bedrock: S('bedrock'), stone: S('stone'), deepslate: S('deepslate[axis=y]'), dirt: S('dirt'),
  grass: S('grass_block[snowy=false]'), grassSnowy: S('grass_block[snowy=true]'), sand: S('sand'), sandstone: S('sandstone'),
  gravel: S('gravel'), clay: S('clay'), water: S('water[level=0]'), ice: S('ice'), snow: S('snow[layers=1]'),
  snowBlock: S('snow_block'), coarse: S('coarse_dirt'), podzol: S('podzol[snowy=false]'), mud: S('mud'),
  shortGrass: S('short_grass'), fern: S('fern'), deadBush: S('dead_bush'), lily: S('lily_pad'),
  tallLo: S('tall_grass[half=lower]'), tallHi: S('tall_grass[half=upper]'),
  cactus: S('cactus[age=0]'), petals: (n: number, f: string) => S(`pink_petals[facing=${f},flower_amount=${n}]`),
};
const log = (w: string) => S(`${w}_log[axis=y]`);
const leaves = (w: string) => S(`${w}_leaves[distance=7,persistent=true,waterlogged=false]`);
const FLOWERS = ['dandelion', 'poppy', 'cornflower', 'oxeye_daisy', 'azure_bluet', 'allium', 'red_tulip', 'white_tulip', 'orange_tulip'].map(S);

export class TerrainGen {
  readonly seed: number;
  private hN: Noise2; private dN: Noise2; private mN: Noise2; private rN: Noise2; private cN: Noise2;
  private tN: Noise2; private wN: Noise2; private vN: Noise2;
  constructor(seed: number) {
    this.seed = seed | 0;
    const s = this.seed;
    this.hN = new Noise2(s ^ 0x1234567);
    this.dN = new Noise2(s ^ 0x2345678);
    this.mN = new Noise2(s ^ 0x3456789);
    this.rN = new Noise2(s ^ 0x456789a);
    this.cN = new Noise2(s ^ 0x56789ab);
    this.tN = new Noise2(s ^ 0x6789abc);
    this.wN = new Noise2(s ^ 0x789abcd);
    this.vN = new Noise2(s ^ 0x89abcde);
  }

  /** raw (fractional) terrain height and river factor */
  private raw(x: number, z: number): { h: number; river: number; ocean: number } {
    const cont = this.cN.fbm(x / 900, z / 900, 3);
    const ocean = smoothstep(-0.25, -0.45, cont);
    let h = 67 + 7 * this.hN.fbm(x / 160, z / 160, 4) + 3 * this.dN.fbm(x / 40, z / 40, 2);
    const hills = smoothstep(-0.1, 0.5, this.dN.fbm(x / 420, z / 420, 2));
    h += hills * 16 * Math.max(0, this.hN.fbm(x / 90 + 100, z / 90, 3) + 0.3);
    const mount = smoothstep(0.25, 0.6, this.mN.fbm(x / 700, z / 700, 2));
    h += mount * 75 * this.mN.ridged(x / 160, z / 160, 4);
    h = h * (1 - ocean) + (46 + 6 * this.dN.fbm(x / 60, z / 60, 2)) * ocean;
    // rivers: narrow band around the zero line of a low-frequency noise
    const rv = Math.abs(this.rN.fbm(x / 380, z / 380, 3));
    const river = (1 - smoothstep(0.012, 0.045, rv)) * (1 - mount * 0.9) * (1 - ocean);
    if (river > 0) h = h * (1 - river) + 57 * river;
    return { h, river, ocean };
  }

  height(x: number, z: number): number {
    return Math.floor(this.raw(x, z).h);
  }

  column(x: number, z: number): Column {
    const { h: hf, river, ocean } = this.raw(x, z);
    const h = Math.floor(hf);
    const T = this.tN.fbm(x / 800, z / 800, 2) - (h > 90 ? (h - 90) / 60 : 0);
    const W = this.wN.fbm(x / 650, z / 650, 2);
    const V = this.vN.fbm(x / 250, z / 250, 2);
    const hx = this.raw(x + 2, z).h - this.raw(x - 2, z).h, hz = this.raw(x, z + 2).h - this.raw(x, z - 2).h;
    const steep = Math.hypot(hx, hz) > 5.5;
    let biome: Biome;
    if (h < SEA - 3 && ocean > 0.4) biome = T < -0.4 ? 'frozen_ocean' : 'ocean';
    else if (river > 0.5 && h < SEA) biome = 'river';
    else if (h >= 118) biome = T < -0.05 ? 'snowy_slopes' : 'stony_peaks';
    else if (h <= SEA + 1 && W < 0.25) biome = T < -0.4 ? 'snowy_plains' : 'beach';
    else if (T < -0.4) biome = W > 0.05 ? 'snowy_taiga' : 'snowy_plains';
    else if (T < -0.15) biome = 'taiga';
    else if (T > 0.38) biome = W < 0.05 ? 'desert' : 'savanna';
    else if (W > 0.3 && h < SEA + 5) biome = 'swamp';
    else if (h > 84 && V < -0.1) biome = 'cherry_grove';
    else if (h > 90) biome = 'meadow';
    else if (W > 0.08) biome = V > 0.25 ? 'birch_forest' : 'forest';
    else biome = V > 0.45 ? 'birch_forest' : 'plains';
    return { h, biome, steep };
  }

  /** Generate one 16×16 chunk column. `put` receives absolute coordinates inside the chunk. */
  generateChunk(cx: number, cz: number, put: Put, get: Get): void {
    const x0 = cx * 16, z0 = cz * 16;
    const M = 4; // margin for trees from neighbouring chunks
    const W = 16 + 2 * M;
    const cols: Column[] = new Array(W * W);
    for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) cols[j * W + i] = this.column(x0 - M + i, z0 - M + j);
    const col = (x: number, z: number) => cols[(z - z0 + M) * W + (x - x0 + M)];
    // ---- terrain
    for (let z = z0; z < z0 + 16; z++)
      for (let x = x0; x < x0 + 16; x++) {
        const c = col(x, z);
        const h = c.h;
        put(x, MIN_Y, z, B.bedrock);
        for (let y = MIN_Y + 1; y <= Math.min(h, 7); y++) {
          const deep = y < 0 || (y < 8 && rand3(x * 7 + y, z, this.seed) < (8 - y) / 8);
          put(x, y, z, deep ? B.deepslate : B.stone);
        }
        let top = B.grass, sub = B.dirt, subDepth = 3, under = '';
        switch (c.biome) {
          case 'desert': top = B.sand; sub = B.sand; subDepth = 4; under = B.sandstone; break;
          case 'beach': top = B.sand; sub = B.sand; subDepth = 3; under = B.sandstone; break;
          case 'river': top = rand3(x, z, this.seed + 5) < 0.3 ? B.clay : B.sand; sub = B.gravel; subDepth = 2; break;
          case 'ocean': case 'frozen_ocean': top = rand3(x, z, this.seed + 6) < 0.5 ? B.gravel : B.sand; sub = B.sand; subDepth = 2; break;
          case 'stony_peaks': top = B.stone; sub = B.stone; break;
          case 'snowy_slopes': top = B.snowBlock; sub = B.snowBlock; subDepth = 2; break;
          case 'snowy_plains': case 'snowy_taiga': top = B.grassSnowy; break;
          case 'swamp': top = h < SEA ? B.mud : B.grass; break;
          case 'taiga': top = rand3(x, z, this.seed + 7) < 0.25 ? B.podzol : B.grass; break;
          case 'savanna': top = rand3(x, z, this.seed + 8) < 0.12 ? B.coarse : B.grass; break;
        }
        if (h < SEA - 1 && (top === B.grass || top === B.grassSnowy)) top = B.dirt;
        if (h < SEA && top === B.grass) top = B.dirt;
        if (c.steep && h > 75 && c.biome !== 'desert') { top = B.stone; sub = B.stone; }
        if (h > 150 && c.biome !== 'desert') top = B.snowBlock;
        for (let y = Math.max(8, MIN_Y + 1); y <= h; y++) {
          const d = h - y;
          let s = B.stone;
          if (d === 0) s = top;
          else if (d <= subDepth) s = sub;
          else if (under && d <= subDepth + 3) s = under;
          put(x, y, z, s);
        }
        // water
        const frozen = c.biome === 'frozen_ocean' || c.biome === 'snowy_plains' || c.biome === 'snowy_taiga';
        for (let y = h + 1; y <= SEA; y++) put(x, y, z, y === SEA && frozen ? B.ice : B.water);
        // snow cover
        if (h >= SEA && (c.biome === 'snowy_plains' || c.biome === 'snowy_taiga' || (c.biome === 'snowy_slopes' && top !== B.snowBlock)))
          put(x, h + 1, z, B.snow);
        if (h >= SEA) this.vegetation(x, h, z, c, put);
        else if (c.biome === 'swamp' && h === SEA - 1 && rand3(x, z, this.seed + 9) < 0.08) put(x, SEA + 1, z, B.lily);
      }
    // ---- trees (from this chunk and neighbours, clipped to the chunk)
    const inChunk = (x: number, z: number) => x >= x0 && x < x0 + 16 && z >= z0 && z < z0 + 16;
    for (let z = z0 - M; z < z0 + 16 + M; z++)
      for (let x = x0 - M; x < x0 + 16 + M; x++) {
        const c = col(x, z);
        const kind = this.treeAt(x, z, c);
        if (!kind) continue;
        this.tree(kind, x, c.h + 1, z, (px, py, pz, s) => {
          if (!inChunk(px, pz) || py > MAX_Y) return;
          const cur = get(px, py, pz);
          const isLog = s.includes('_log');
          if (cur === B.air || cur.includes('short_grass') || cur.includes('tall_grass') || cur.includes('fern') ||
            cur.includes('snow[') || (isLog && cur.includes('_leaves')) || FLOWERS.includes(cur) || cur.includes('pink_petals'))
            put(px, py, pz, s);
        });
      }
  }

  private vegetation(x: number, h: number, z: number, c: Column, put: Put): void {
    const r = rand3(x, z, this.seed + 11);
    const r2 = rand3(x, z, this.seed + 12);
    const y = h + 1;
    if (c.steep && h > 75) return;
    switch (c.biome) {
      case 'plains': case 'meadow':
        if (r < 0.1) put(x, y, z, B.shortGrass);
        else if (r < 0.12) { put(x, y, z, B.tallLo); put(x, y + 1, z, B.tallHi); }
        else if (r < (c.biome === 'meadow' ? 0.24 : 0.15)) put(x, y, z, FLOWERS[Math.floor(r2 * FLOWERS.length)]);
        break;
      case 'forest': case 'birch_forest':
        if (r < 0.14) put(x, y, z, B.shortGrass);
        else if (r < 0.16) put(x, y, z, FLOWERS[Math.floor(r2 * 4)]);
        break;
      case 'taiga': case 'snowy_taiga':
        if (c.biome === 'taiga' && r < 0.12) put(x, y, z, r2 < 0.6 ? B.fern : B.shortGrass);
        break;
      case 'savanna':
        if (r < 0.3) put(x, y, z, B.shortGrass);
        else if (r < 0.33) { put(x, y, z, B.tallLo); put(x, y + 1, z, B.tallHi); }
        break;
      case 'desert':
        if (r < 0.006) put(x, y, z, B.deadBush);
        else if (r < 0.011) {
          const n = 1 + Math.floor(r2 * 3);
          for (let i = 0; i < n; i++) put(x, y + i, z, B.cactus);
        }
        break;
      case 'cherry_grove':
        if (r < 0.2) put(x, y, z, B.petals(1 + Math.floor(r2 * 4), ['north', 'east', 'south', 'west'][Math.floor(r2 * 16) & 3]));
        else if (r < 0.32) put(x, y, z, B.shortGrass);
        break;
      case 'swamp':
        if (r < 0.1) put(x, y, z, B.shortGrass);
        break;
    }
  }

  private treeAt(x: number, z: number, c: Column): string | null {
    if (c.h < SEA || (c.steep && c.h > 75)) return null;
    const r = rand3(x, z, this.seed + 21);
    const dens: Partial<Record<Biome, [number, string]>> = {
      forest: [0.045, 'oak'], birch_forest: [0.05, 'birch'], taiga: [0.04, 'spruce'], snowy_taiga: [0.03, 'spruce'],
      plains: [0.0025, 'oak'], savanna: [0.004, 'acacia'], cherry_grove: [0.02, 'cherry'], swamp: [0.012, 'swamp'],
      meadow: [0.0015, 'birch'], snowy_plains: [0.001, 'spruce'],
    };
    const d = dens[c.biome];
    if (!d || r >= d[0]) return null;
    if (d[1] === 'oak' && c.biome === 'forest' && rand3(x, z, this.seed + 22) < 0.25) return 'birch';
    return d[1];
  }

  /** place a tree with its base log at (x,y,z) */
  tree(kind: string, x: number, y: number, z: number, put: Put): void {
    const r = rand3(x, z, this.seed + 31);
    const blob = (cy: number, rad: number, w: string, skipCorners = true) => {
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -rad; dx <= rad; dx++)
          for (let dz = -rad; dz <= rad; dz++) {
            const rr = dy === 1 ? rad - 1 : rad;
            if (Math.abs(dx) > rr || Math.abs(dz) > rr) continue;
            if (skipCorners && Math.abs(dx) === rr && Math.abs(dz) === rr && rand3(x + dx * 3 + dy, z + dz * 5, this.seed + 41) < 0.6) continue;
            put(x + dx, cy + dy, z + dz, leaves(w));
          }
    };
    switch (kind) {
      case 'oak': case 'birch': case 'swamp': {
        const w = kind === 'birch' ? 'birch' : 'oak';
        const h = (kind === 'birch' ? 5 : 4) + Math.floor(r * 3);
        blob(y + h - 2, 2, w);
        blob(y + h, 1, w, false);
        put(x, y + h + 1, z, leaves(w));
        for (let i = 0; i < h; i++) put(x, y + i, z, log(w));
        if (kind === 'swamp')
          for (const [dx, dz, f] of [[-3, 0, 'east'], [3, 0, 'west'], [0, -3, 'south'], [0, 3, 'north']] as [number, number, string][])
            for (let i = 0; i < 2 + Math.floor(r * 3); i++) put(x + dx, y + h - 2 - i, z + dz, S(`vine[east=${f === 'east'},north=${f === 'north'},south=${f === 'south'},up=false,west=${f === 'west'}]`));
        break;
      }
      case 'spruce': {
        const h = 6 + Math.floor(r * 4);
        for (let i = 2; i <= h; i++) {
          const k = h - i;
          const rad = i === h ? 0 : k % 2 === 0 ? Math.min(3, 1 + Math.floor(k / 3)) : 1;
          for (let dx = -rad; dx <= rad; dx++)
            for (let dz = -rad; dz <= rad; dz++) {
              if (rad > 0 && Math.abs(dx) === rad && Math.abs(dz) === rad) continue;
              put(x + dx, y + i, z + dz, leaves('spruce'));
            }
        }
        put(x, y + h + 1, z, leaves('spruce'));
        for (let i = 0; i < h; i++) put(x, y + i, z, log('spruce'));
        break;
      }
      case 'acacia': {
        const h = 4 + Math.floor(r * 2);
        const dx = r < 0.5 ? 1 : -1;
        for (let i = 0; i < h; i++) put(x + (i >= h - 2 ? dx : 0), y + i, z, log('acacia'));
        const tx = x + dx, ty = y + h;
        for (let ax = -2; ax <= 2; ax++) for (let az = -2; az <= 2; az++) if (Math.abs(ax) + Math.abs(az) < 4) put(tx + ax, ty, z + az, leaves('acacia'));
        for (let ax = -1; ax <= 1; ax++) for (let az = -1; az <= 1; az++) put(tx + ax, ty + 1, z + az, leaves('acacia'));
        break;
      }
      case 'cherry': {
        const h = 5 + Math.floor(r * 2);
        for (let i = 0; i < h; i++) put(x, y + i, z, log('cherry'));
        for (let dy = -1; dy <= 2; dy++) {
          const rad = dy === 2 ? 1 : dy === -1 ? 2 : 3;
          for (let dx = -rad; dx <= rad; dx++)
            for (let dz = -rad; dz <= rad; dz++) {
              if (dx * dx + dz * dz > rad * rad + 1) continue;
              if (dy === -1 && rand3(x + dx, z + dz, this.seed + 51) < 0.5) continue;
              put(x + dx, y + h - 1 + dy, z + dz, leaves('cherry'));
            }
        }
        break;
      }
    }
  }
}
