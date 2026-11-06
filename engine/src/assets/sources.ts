// Asset sources: where block definitions, models and textures come from.
//  1. a local Minecraft client jar (preferred when present)
//  2. misode/mcmeta on GitHub (summary + prebuilt atlases), downloaded once and cached
// Mojang assets are never written into the repository; only into the user cache.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';
import { ZipReader } from './zip.ts';

export interface RawTexture {
  w: number;
  h: number;
  /** RGBA, frame 0 only for animated strips */
  data: Uint8Array;
}

export interface AssetSource {
  readonly kind: 'jar' | 'mcmeta';
  readonly where: string;
  /** block id without namespace → blockstate definition JSON ({variants} | {multipart}) */
  blockstates: Record<string, any>;
  /** 'block/stone' → model JSON (or undefined) */
  model(name: string): any;
  /** 'block/stone', 'entity/chest/normal' → texture (frame 0) */
  texture(name: string): RawTexture | undefined;
  colormap(name: 'grass' | 'foliage' | 'dry_foliage'): RawTexture | undefined;
}

export function defaultCacheDir(): string {
  return process.env.MCAI_CACHE || join(homedir(), '.mcai', 'cache');
}

export function decodePng(buf: Buffer): RawTexture {
  const png = PNG.sync.read(buf);
  return { w: png.width, h: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length) };
}

/** crop the first animation frame: square strips taller than wide (w×w at the top) */
export function frame0(t: RawTexture): RawTexture {
  if (t.h > t.w && t.h % t.w === 0) {
    return { w: t.w, h: t.w, data: t.data.slice(0, t.w * t.w * 4) };
  }
  return t;
}

function crop(src: RawTexture, x: number, y: number, w: number, h: number): RawTexture {
  const out = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++) {
    const s = ((y + j) * src.w + x) * 4;
    out.set(src.data.subarray(s, s + w * 4), j * w * 4);
  }
  return { w, h, data: out };
}

export function normModelName(n: string): string {
  return n.startsWith('minecraft:') ? n.slice(10) : n;
}

// ---------------------------------------------------------------------------------- jar

export function findClientJar(version: string): string | undefined {
  const env = process.env.MCAI_MC_JAR;
  if (env && existsSync(env)) return env;
  const home = homedir();
  const roots = [
    join(home, 'Library', 'Application Support', 'minecraft'),
    process.env.APPDATA ? join(process.env.APPDATA, '.minecraft') : '',
    join(home, '.minecraft'),
  ].filter(Boolean);
  for (const r of roots) {
    const p = join(r, 'versions', version, `${version}.jar`);
    if (existsSync(p)) return p;
  }
  return undefined;
}

export class JarSource implements AssetSource {
  readonly kind = 'jar' as const;
  readonly where: string;
  blockstates: Record<string, any> = {};
  private zip: ZipReader;
  private models = new Map<string, any>();
  private textures = new Map<string, RawTexture | null>();

  constructor(path: string) {
    this.where = path;
    this.zip = new ZipReader(path);
    const pre = 'assets/minecraft/blockstates/';
    for (const n of this.zip.names(pre)) {
      if (!n.endsWith('.json')) continue;
      const id = n.slice(pre.length, -5);
      try {
        this.blockstates[id] = JSON.parse(this.zip.read(n)!.toString('utf8'));
      } catch {
        /* ignore broken entries */
      }
    }
    if (!Object.keys(this.blockstates).length) throw new Error(`${path}: no blockstates found (not a client jar?)`);
  }

  model(name: string): any {
    const n = normModelName(name);
    if (this.models.has(n)) return this.models.get(n);
    const buf = this.zip.read(`assets/minecraft/models/${n}.json`);
    const m = buf ? JSON.parse(buf.toString('utf8')) : undefined;
    this.models.set(n, m);
    return m;
  }

  texture(name: string): RawTexture | undefined {
    const n = normModelName(name);
    const hit = this.textures.get(n);
    if (hit !== undefined) return hit ?? undefined;
    const buf = this.zip.read(`assets/minecraft/textures/${n}.png`);
    let t: RawTexture | null = null;
    if (buf) {
      try {
        t = frame0(decodePng(buf));
      } catch {
        t = null;
      }
    }
    this.textures.set(n, t);
    return t ?? undefined;
  }

  colormap(name: 'grass' | 'foliage' | 'dry_foliage'): RawTexture | undefined {
    return this.texture(`colormap/${name}`);
  }
}

// ------------------------------------------------------------------------------- mcmeta

const MCMETA_FILES = (v: string) => ({
  'block_definition.json': `https://raw.githubusercontent.com/misode/mcmeta/${v}-summary/assets/block_definition/data.min.json`,
  'model.json': `https://raw.githubusercontent.com/misode/mcmeta/${v}-summary/assets/model/data.min.json`,
  'atlas_blocks.png': `https://raw.githubusercontent.com/misode/mcmeta/${v}-atlas/blocks/atlas.png`,
  'atlas_blocks.json': `https://raw.githubusercontent.com/misode/mcmeta/${v}-atlas/blocks/data.min.json`,
  'atlas_entities.png': `https://raw.githubusercontent.com/misode/mcmeta/${v}-atlas/entities/atlas.png`,
  'atlas_entities.json': `https://raw.githubusercontent.com/misode/mcmeta/${v}-atlas/entities/data.min.json`,
  'colormap_grass.png': `https://raw.githubusercontent.com/misode/mcmeta/${v}-assets/assets/minecraft/textures/colormap/grass.png`,
  'colormap_foliage.png': `https://raw.githubusercontent.com/misode/mcmeta/${v}-assets/assets/minecraft/textures/colormap/foliage.png`,
  'colormap_dry_foliage.png': `https://raw.githubusercontent.com/misode/mcmeta/${v}-assets/assets/minecraft/textures/colormap/dry_foliage.png`,
});
const OPTIONAL = new Set(['colormap_dry_foliage.png']);

async function download(url: string, dest: string, timeoutMs = 60_000): Promise<void> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    const buf = Buffer.from(await r.arrayBuffer());
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp`;
    writeFileSync(tmp, buf);
    renameSync(tmp, dest);
  } finally {
    clearTimeout(timer);
  }
}

/** Ensure the mcmeta files for `version` are in the cache. Returns the directory. */
export async function ensureMcmetaCache(version: string, cacheDir = defaultCacheDir()): Promise<string> {
  const dir = join(cacheDir, 'mcmeta', version);
  const files = MCMETA_FILES(version);
  const missing = Object.entries(files).filter(([f]) => !existsSync(join(dir, f)) && !existsSync(join(dir, f + '.missing')));
  if (missing.length) {
    if (process.env.MCAI_OFFLINE === '1') throw new Error(`asset cache incomplete at ${dir} and MCAI_OFFLINE=1`);
    await Promise.all(
      missing.map(async ([f, url]) => {
        try {
          await download(url, join(dir, f));
        } catch (e) {
          if (OPTIONAL.has(f)) {
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, f + '.missing'), String(e));
          } else throw e;
        }
      }),
    );
  }
  return dir;
}

export class McmetaSource implements AssetSource {
  readonly kind = 'mcmeta' as const;
  readonly where: string;
  blockstates: Record<string, any>;
  private models: Record<string, any>;
  private atlases: { img: RawTexture; rects: Record<string, [number, number, number, number]> }[] = [];
  private textures = new Map<string, RawTexture | null>();
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
    this.where = dir;
    this.blockstates = JSON.parse(readFileSync(join(dir, 'block_definition.json'), 'utf8'));
    this.models = JSON.parse(readFileSync(join(dir, 'model.json'), 'utf8'));
    for (const a of ['blocks', 'entities']) {
      const img = decodePng(readFileSync(join(dir, `atlas_${a}.png`)));
      const rects = JSON.parse(readFileSync(join(dir, `atlas_${a}.json`), 'utf8'));
      this.atlases.push({ img, rects });
    }
  }

  model(name: string): any {
    return this.models[normModelName(name)];
  }

  texture(name: string): RawTexture | undefined {
    const n = normModelName(name);
    const hit = this.textures.get(n);
    if (hit !== undefined) return hit ?? undefined;
    let t: RawTexture | null = null;
    for (const a of this.atlases) {
      const r = a.rects[n];
      if (r) {
        t = frame0(crop(a.img, r[0], r[1], r[2], r[3]));
        break;
      }
    }
    this.textures.set(n, t);
    return t ?? undefined;
  }

  colormap(name: 'grass' | 'foliage' | 'dry_foliage'): RawTexture | undefined {
    const p = join(this.dir, `colormap_${name}.png`);
    if (!existsSync(p)) return undefined;
    return decodePng(readFileSync(p));
  }
}

/** Open the best available source: client jar if present, else (download +) mcmeta cache. */
export async function openSource(version: string, cacheDir?: string): Promise<AssetSource> {
  const jar = process.env.MCAI_NO_JAR === '1' ? undefined : findClientJar(version);
  if (jar) {
    try {
      return new JarSource(jar);
    } catch {
      /* fall through to mcmeta */
    }
  }
  const dir = await ensureMcmetaCache(version, cacheDir);
  return new McmetaSource(dir);
}
