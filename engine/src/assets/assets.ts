// AssetStore: block states → baked geometry + one texture atlas (+ tints, average colors).
// See docs/ENGINE-API.md (assets-render-sim).
import { PNG } from 'pngjs';
import { parseBlockState } from '../core/blockstate.ts';
import { openSource, type AssetSource, type RawTexture } from './sources.ts';
import { ModelBaker, selectModels } from './models.ts';
import { synthesize, specialTextures, bannerTint } from './special.ts';
import { flatGeometry } from './fallback.ts';
import { loadRegistryData } from './registry-lite.ts';
import {
  biomeClimate, emission, fixedTint, isInvisible, paletteColor, renderLayer, tintKindOf, DEFAULT_WATER,
} from './classify.ts';
import { DIRS, matVec, type BlockGeometry, type GeoCuboid } from './geometry.ts';

export type { BlockGeometry, GeoCuboid, GeoFace, Dir, RenderLayer } from './geometry.ts';

export interface AtlasData {
  width: number;
  height: number;
  rgba: Uint8Array;
  names: string[];
  /** per texture index: x, y, w, h (pixels) */
  rects: Int32Array;
  index: Map<string, number>;
  /** per texture: bit0 = has cut-out texels (alpha < 128), bit1 = has semi-transparent texels */
  flags: Uint8Array;
  /** per texture: average rgba (alpha-weighted color) */
  avg: Uint8Array;
}

const ALWAYS_WATER = /^(kelp|kelp_plant|seagrass|tall_seagrass|bubble_column)$/;

export class AssetStore {
  private static opening = new Map<string, Promise<AssetStore>>();

  /** Downloads (once) and caches assets; prefers a local client jar. Rejects if unavailable. */
  static open(version = '26.3', cacheDir?: string): Promise<AssetStore> {
    const key = `${version}|${cacheDir ?? ''}`;
    let p = AssetStore.opening.get(key);
    if (!p) {
      p = openSource(version, cacheDir).then((src) => new AssetStore(src, version));
      p.catch(() => AssetStore.opening.delete(key));
      AssetStore.opening.set(key, p);
    }
    return p;
  }

  /** like open() but resolves to null instead of throwing */
  static async tryOpen(version = '26.3', cacheDir?: string): Promise<AssetStore | null> {
    try {
      return await AssetStore.open(version, cacheDir);
    } catch {
      return null;
    }
  }

  readonly version: string;
  readonly source: AssetSource;
  private baker: ModelBaker;
  private geo = new Map<string, BlockGeometry>();
  private avg = new Map<string, [number, number, number, number]>();
  private referenced = new Set<string>();
  private atlas: AtlasData | null = null;
  private atlasPng: Buffer | null = null;
  private colormaps = new Map<string, RawTexture | null>();
  private texCache = new Map<string, RawTexture | null>();

  constructor(source: AssetSource, version = '26.3') {
    this.source = source;
    this.version = version;
    this.baker = new ModelBaker(source);
  }

  private tex(name: string): RawTexture | undefined {
    if (!name) return undefined;
    let t = this.texCache.get(name);
    if (t === undefined) {
      t = this.source.texture(name) ?? null;
      this.texCache.set(name, t);
    }
    return t ?? undefined;
  }

  private texSize = (name: string): [number, number] => {
    const t = this.tex(name);
    return t ? [t.w, t.h] : [16, 16];
  };

  private texOpaque(name: string): boolean {
    const t = this.tex(name);
    if (!t) return false;
    for (let i = 3; i < t.data.length; i += 4) if (t.data[i] < 250) return false;
    return true;
  }

  /** Resolved geometry for a block state (canonical or not; missing properties use registry defaults). */
  geometry(state: string): BlockGeometry {
    const hit = this.geo.get(state);
    if (hit) return hit;
    const g = this.build(state);
    this.geo.set(state, g);
    return g;
  }

  private build(state: string): BlockGeometry {
    let id: string, props: Record<string, string>;
    try {
      const p = parseBlockState(state);
      id = p.name;
      const info = loadRegistryData(this.version)?.blocks[id];
      props = info ? { ...info.default, ...p.props } : p.props;
    } catch {
      return flatGeometry(state, 'minecraft:stone', {});
    }
    const n = id.slice(id.indexOf(':') + 1);
    const def = this.source.blockstates[n];
    if (isInvisible(id) || (!def && n === 'air')) {
      const g = flatGeometry(state, id, props);
      g.invisible = true;
      g.cuboids = [];
      return g;
    }
    if (!def) return flatGeometry(state, id, props);

    const layer = renderLayer(id);
    const isWater = n === 'water' || n === 'bubble_column';
    const isLava = n === 'lava';
    const fluid: BlockGeometry['fluid'] =
      isWater || props.waterlogged === 'true' || ALWAYS_WATER.test(n) ? 'water' : isLava ? 'lava' : null;
    let cuboids: GeoCuboid[] = [];
    let ao = true;
    let particle = '';
    if (!isWater && !isLava) {
      for (const a of selectModels(def, props)) {
        const b = this.baker.bake(a);
        if (!b) continue;
        cuboids.push(...b.cuboids);
        ao &&= b.ao;
        particle ||= b.particle;
      }
    }
    let synthetic = false;
    const syn = isWater || isLava ? null : (cuboids.length === 0 || n === 'bell') ? synthesize(id, props, this.texSize) : null;
    if (syn) {
      const b = this.baker.bakeJson(syn.json, { model: '', ...syn.applied });
      cuboids.push(...b.cuboids);
      ao &&= syn.json.ambientocclusion !== false;
      synthetic = true;
    }
    if (!cuboids.length && !fluid) {
      // unknown entity-rendered block: cube with the particle texture so it is at least visible
      const t = particle && this.tex(particle) ? particle : '';
      const g = flatGeometry(state, id, props);
      if (t) for (const c of g.cuboids) for (const f of Object.values(c.faces)) if (f) f.texture = t;
      g.flat = !t;
      g.synthetic = true;
      return g;
    }
    for (const c of cuboids) for (const f of Object.values(c.faces)) if (f && f.texture) this.referenced.add(f.texture);
    if (isWater || fluid === 'water') this.referenced.add('block/water_still');
    if (isLava) this.referenced.add('block/lava_still');

    // full opaque cube?
    let fullCube = false;
    if (layer !== 'translucent') {
      for (const c of cuboids) {
        if (DIRS.some((d) => !c.faces[d] || !this.texOpaque(c.faces[d]!.texture))) continue;
        const a = matVec(c.m, c.from), b = matVec(c.m, c.to);
        let ok = true;
        for (let i = 0; i < 3; i++) {
          const lo = Math.min(a[i], b[i]) + c.t[i], hi = Math.max(a[i], b[i]) + c.t[i];
          if (Math.abs(lo) > 1e-6 || Math.abs(hi - 16) > 1e-6) ok = false;
        }
        if (ok) {
          fullCube = true;
          break;
        }
      }
    }
    const tintKind = bannerTint(id) ? 'fixed' : tintKindOf(id);
    let tint: [number, number, number] | null = null;
    if (tintKind === 'fixed') tint = bannerTint(id) ?? fixedTint(id, props);
    else if (tintKind) tint = this.tint(tintKind, 'plains');
    // blocks not in the explicit BlockColors table (cherry/azalea/pale oak leaves, …) stay untinted
    return {
      state,
      cuboids,
      ao,
      layer,
      fluid,
      fluidLevel: Number(props.level ?? 0),
      fullCube,
      emission: emission(id, props),
      tint,
      tintKind,
      synthetic,
      flat: false,
      color: paletteColor(id),
      invisible: false,
    };
  }

  /** biome tint color */
  tint(kind: 'grass' | 'foliage' | 'dry_foliage' | 'water', biome?: string): [number, number, number] {
    const c = biomeClimate(biome);
    const hex = (v: number): [number, number, number] => [(v >> 16) & 255, (v >> 8) & 255, v & 255];
    if (kind === 'water') return hex(c.water ?? DEFAULT_WATER);
    if (kind === 'grass' && c.grass !== undefined) return hex(c.grass);
    if (kind === 'foliage' && c.foliage !== undefined) return hex(c.foliage);
    if (kind === 'dry_foliage' && c.dry !== undefined) return hex(c.dry);
    let cm = this.colormaps.get(kind);
    if (cm === undefined) {
      cm = this.source.colormap(kind) ?? null;
      this.colormaps.set(kind, cm);
    }
    if (!cm) return kind === 'grass' ? [0x91, 0xbd, 0x59] : kind === 'foliage' ? [0x77, 0xab, 0x2f] : [0xa0, 0x8a, 0x5a];
    const t = Math.max(0, Math.min(1, c.temp));
    const d = Math.max(0, Math.min(1, c.down)) * t;
    const x = Math.min(cm.w - 1, Math.floor((1 - t) * (cm.w - 1)));
    const y = Math.min(cm.h - 1, Math.floor((1 - d) * (cm.h - 1)));
    const i = (y * cm.w + x) * 4;
    return [cm.data[i], cm.data[i + 1], cm.data[i + 2]];
  }

  /** tint color of a geometry for a given biome */
  tintFor(g: BlockGeometry, biome?: string): [number, number, number] | null {
    if (!g.tint) return null;
    if (!biome || !g.tintKind || g.tintKind === 'fixed') return g.tint;
    return this.tint(g.tintKind, biome);
  }

  /** all textures referenced by any block model (+ synthesized models) */
  private allTextures(): string[] {
    const names = new Set<string>(specialTextures());
    for (const def of Object.values(this.source.blockstates)) {
      const applies: any[] = [];
      if (def.variants) for (const v of Object.values(def.variants)) applies.push(...(Array.isArray(v) ? v : [v]));
      if (def.multipart) for (const p of def.multipart) applies.push(...(Array.isArray(p.apply) ? p.apply : [p.apply]));
      for (const a of applies) {
        const rm = this.baker.resolve(a.model);
        if (!rm) continue;
        for (const el of rm.elements ?? [])
          for (const f of Object.values<any>(el.faces ?? {})) {
            const t = ModelBaker.resolveTexture(rm.textures, f.texture ?? '');
            if (t) names.add(t);
          }
        if (rm.textures.particle) {
          const t = ModelBaker.resolveTexture(rm.textures, rm.textures.particle);
          if (t) names.add(t);
        }
      }
    }
    for (const r of this.referenced) names.add(r);
    return [...names].filter((n) => this.tex(n)).sort();
  }

  /** Packed atlas for the renderer (built once; rebuilt if new textures were referenced). */
  atlasData(): AtlasData {
    if (this.atlas) {
      let stale = false;
      for (const r of this.referenced) if (!this.atlas.index.has(r) && this.tex(r)) stale = true;
      if (!stale) return this.atlas;
    }
    const names = this.allTextures();
    const items = names.map((n) => ({ n, t: this.tex(n)! }));
    const order = items.map((_, i) => i).sort((a, b) => items[b].t.h - items[a].t.h || items[b].t.w - items[a].t.w);
    const W = 1024;
    const rects = new Int32Array(names.length * 4);
    let x = 0, y = 0, rowH = 0;
    for (const i of order) {
      const { w, h } = items[i].t;
      if (x + w > W) {
        x = 0;
        y += rowH;
        rowH = 0;
      }
      rects.set([x, y, w, h], i * 4);
      x += w;
      rowH = Math.max(rowH, h);
    }
    const H = y + rowH;
    const rgba = new Uint8Array(W * H * 4);
    const flags = new Uint8Array(names.length);
    const avg = new Uint8Array(names.length * 4);
    for (let i = 0; i < items.length; i++) {
      const { t } = items[i];
      const rx = rects[i * 4], ry = rects[i * 4 + 1];
      let f = 0, r = 0, g = 0, b = 0, a = 0, cnt = 0;
      for (let j = 0; j < t.h; j++) {
        rgba.set(t.data.subarray(j * t.w * 4, (j + 1) * t.w * 4), ((ry + j) * W + rx) * 4);
        for (let k = 0; k < t.w; k++) {
          const p = (j * t.w + k) * 4;
          const al = t.data[p + 3];
          if (al < 128) f |= 1;
          else if (al < 250) f |= 2;
          r += t.data[p] * al;
          g += t.data[p + 1] * al;
          b += t.data[p + 2] * al;
          a += al;
          cnt++;
        }
      }
      flags[i] = f;
      if (a > 0) avg.set([Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(a / cnt)], i * 4);
    }
    this.atlas = { width: W, height: H, rgba, names, rects, index: new Map(names.map((n, i) => [n, i])), flags, avg };
    this.atlasPng = null;
    return this.atlas;
  }

  textureAtlas(): { png: Buffer; width: number; height: number; uv(texture: string): [number, number, number, number] } {
    const a = this.atlasData();
    if (!this.atlasPng) {
      const png = new PNG({ width: a.width, height: a.height });
      png.data = Buffer.from(a.rgba.buffer, a.rgba.byteOffset, a.rgba.length);
      this.atlasPng = PNG.sync.write(png);
    }
    return {
      png: this.atlasPng,
      width: a.width,
      height: a.height,
      uv: (texture: string) => {
        let n = texture.startsWith('minecraft:') ? texture.slice(10) : texture;
        if (!n.includes('/')) n = 'block/' + n;
        const i = a.index.get(n);
        if (i === undefined) return [0, 0, 0, 0];
        return [a.rects[i * 4] / a.width, a.rects[i * 4 + 1] / a.height,
          (a.rects[i * 4] + a.rects[i * 4 + 2]) / a.width, (a.rects[i * 4 + 1] + a.rects[i * 4 + 3]) / a.height];
      },
    };
  }

  /** average color (rgba 0..255) of the block's top face (tinted), fallback palette otherwise */
  averageColor(state: string): [number, number, number, number] {
    const hit = this.avg.get(state);
    if (hit) return hit;
    const g = this.geometry(state);
    let out: [number, number, number, number] = g.color;
    if (g.fluid && g.cuboids.length === 0) {
      const t = g.fluid === 'water' ? 'block/water_still' : 'block/lava_still';
      out = this.texAvg(t, g.fluid === 'water' ? this.tint('water') : null) ?? g.color;
      if (g.fluid === 'water') out[3] = 180;
    } else if (!g.flat && !g.invisible) {
      let face = null;
      for (const c of g.cuboids) {
        face = c.faces.up ?? null;
        if (face) break;
      }
      if (!face) for (const c of g.cuboids) for (const d of DIRS) if (!face && c.faces[d]) face = c.faces[d]!;
      if (face) out = this.texAvg(face.texture, face.tint >= 0 ? g.tint : null) ?? g.color;
    } else if (g.invisible) out = [0, 0, 0, 0];
    this.avg.set(state, out);
    return out;
  }

  private texAvg(name: string, tint: [number, number, number] | null): [number, number, number, number] | null {
    const t = this.tex(name);
    if (!t) return null;
    let r = 0, g = 0, b = 0, a = 0;
    for (let i = 0; i < t.data.length; i += 4) {
      const al = t.data[i + 3];
      r += t.data[i] * al;
      g += t.data[i + 1] * al;
      b += t.data[i + 2] * al;
      a += al;
    }
    if (a === 0) return null;
    const k = tint ? tint.map((v) => v / 255) : [1, 1, 1];
    return [Math.round((r / a) * k[0]), Math.round((g / a) * k[1]), Math.round((b / a) * k[2]), Math.round(a / (t.data.length / 4))];
  }
}
