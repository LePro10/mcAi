// Server-side helpers for the bundled three.js web viewer (engine/src/viewer):
//   GET  /api/viewer/info                → asset availability, atlas size, fluid uvs, job box defaults
//   GET  /api/viewer/atlas.png           → the block texture atlas (frame 0 of animated textures)
//   POST /api/viewer/geometry {states}   → compact, pre-baked quads per block state (see CompactGeometry)
//   GET  /api/viewer/geometry?s=…&s=…    → same, for a few states
//   GET  /api/viewer/biomes?box=…&step=4 → 2D biome grid + per-biome grass/foliage/water tints
//   GET  /vendor/three/…                 → three.js ES modules from node_modules (offline, no CDN)
// The hub registers these with two clearly marked lines (hub.ts → "viewer assets").

import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { Box, WorldBackend } from '../core/types.ts';
import { blockId } from '../core/blockstate.ts';
import type { AssetStore, AtlasData } from '../assets/assets.ts';
import type { BlockGeometry, Dir } from '../assets/geometry.ts';
import { DIRS, DIR_VEC, dirFromVec, matInverse, matVec } from '../assets/geometry.ts';
import { flatGeometry } from '../assets/fallback.ts';
import { stateProps } from '../assets/registry-lite.ts';
import { selfCulls } from '../assets/classify.ts';
import { b64encode, normalizeBox } from './protocol.ts';
import { ENGINE_ROOT, ENGINE_VERSION, type Config } from './config.ts';

/** Floats per quad in CompactGeometry.q: header (8) + 4 corners × (x, y, z, u, v). */
export const QUAD_STRIDE = 28;
// header: [0] cull dir index (-1 = none, else DIRS index, block space)
//         [1] tinted (0/1)  [2] shade (0/1)  [3] face layer (0 opaque, 1 cutout, 2 translucent)
//         [4..6] normal (block space, unit)  [7] face dir index (dominant axis of the normal)
// corners: [8 + k*5 ..] x, y, z (block units 0..1), u, v (atlas 0..1, top-left origin; u < 0 = untextured)

/** Geometry flags (CompactGeometry.f) */
export const G_OCCLUDES = 1, G_AO = 2, G_TRANSLUCENT = 4, G_WATER = 8, G_LAVA = 16, G_FLAT = 32, G_INVISIBLE = 64, G_CUTOUT = 128;

export interface CompactGeometry {
  /** flags, see G_* */
  f: number;
  /** flat rgba (sRGB 0..255) for untextured faces / fallback */
  c: [number, number, number, number];
  /** default tint (sRGB 0..255) for tinted faces, or null */
  t: [number, number, number] | null;
  /** tint kind for biome re-tinting */
  k: 'grass' | 'foliage' | 'dry_foliage' | 'water' | 'fixed' | null;
  /** light emission 0..15 */
  e: number;
  /** fluid level (vanilla 'level' property) */
  l: number;
  /** self-cull group (block id for glass/leaves/ice…, '' = none) */
  g: string;
  /** flat quad list, QUAD_STRIDE floats per quad */
  q: number[];
}

export interface ViewerAssetsOptions {
  assets: () => Promise<AssetStore | null>;
  backend: () => WorldBackend;
  config: Config;
}

// element-space corners per face (unit cube selectors), any winding (fixed afterwards)
const CORNERS: Record<Dir, [number, number, number][]> = {
  down: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
  up: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
  north: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]],
  south: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
  west: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
  east: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
};

const r5 = (v: number) => Math.round(v * 100000) / 100000;

/** face-local texture coordinates (0..1) of an element-space corner, same convention as render/trace.ts */
function faceST(d: number, ex: number, ey: number, ez: number): [number, number] {
  switch (d) {
    case 0: return [ex, 1 - ez];
    case 1: return [ex, ez];
    case 2: return [1 - ex, 1 - ey];
    case 3: return [ex, 1 - ey];
    case 4: return [ez, 1 - ey];
    default: return [1 - ez, 1 - ey];
  }
}

export interface AtlasLookup {
  width: number;
  height: number;
  /** texture name → [x, y, w, h] pixels and flags (bit0 cutout, bit1 semi-transparent) */
  rect(name: string): { x: number; y: number; w: number; h: number; flags: number } | null;
}

export function atlasLookup(a: AtlasData | null): AtlasLookup | null {
  if (!a) return null;
  return {
    width: a.width,
    height: a.height,
    rect(name: string) {
      const i = a.index.get(name);
      if (i === undefined) return null;
      return { x: a.rects[i * 4]!, y: a.rects[i * 4 + 1]!, w: a.rects[i * 4 + 2]!, h: a.rects[i * 4 + 3]!, flags: a.flags[i]! };
    },
  };
}

/** Bake a BlockGeometry into the compact quad format the viewer's mesher consumes. */
export function compactGeometry(g: BlockGeometry, atlas: AtlasLookup | null): CompactGeometry {
  let f = 0;
  if (g.fullCube) f |= G_OCCLUDES;
  if (g.ao) f |= G_AO;
  if (g.layer === 'translucent') f |= G_TRANSLUCENT;
  if (g.fluid === 'water') f |= G_WATER;
  if (g.fluid === 'lava') f |= G_LAVA;
  if (g.flat || !atlas) f |= G_FLAT;
  if (g.invisible) f |= G_INVISIBLE;
  const q: number[] = [];
  const id = blockId(g.state);
  for (const c of g.cuboids) {
    const Minv = matInverse(c.m);
    for (let d = 0; d < 6; d++) {
      const face = c.faces[DIRS[d]!];
      if (!face) continue;
      // block-space corners
      const pts = CORNERS[DIRS[d]!].map((s) => {
        const e: [number, number, number] = [
          c.from[0] + s[0] * (c.to[0] - c.from[0]),
          c.from[1] + s[1] * (c.to[1] - c.from[1]),
          c.from[2] + s[2] * (c.to[2] - c.from[2]),
        ];
        const b = matVec(c.m, e);
        return { s, p: [(b[0] + c.t[0]) / 16, (b[1] + c.t[1]) / 16, (b[2] + c.t[2]) / 16] as [number, number, number] };
      });
      // normal = Minv^T · n (handles the rescaled 45° plant planes)
      const n = DIR_VEC[d]!;
      let nx = Minv[0]! * n[0] + Minv[3]! * n[1] + Minv[6]! * n[2];
      let ny = Minv[1]! * n[0] + Minv[4]! * n[1] + Minv[7]! * n[2];
      let nz = Minv[2]! * n[0] + Minv[5]! * n[1] + Minv[8]! * n[2];
      const L = Math.hypot(nx, ny, nz) || 1;
      nx /= L; ny /= L; nz /= L;
      // make the winding counter-clockwise seen from the normal side
      const a = pts[0]!.p, b = pts[1]!.p, cc = pts[2]!.p;
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = cc[0] - a[0], vy = cc[1] - a[1], vz = cc[2] - a[2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      if (cx * nx + cy * ny + cz * nz < 0) pts.reverse();
      const wd = DIRS.indexOf(dirFromVec(nx, ny, nz));
      // texture rect
      const r = atlas && face.texture && !g.flat ? atlas.rect(face.texture) : null;
      let layer = 0;
      if (g.layer === 'translucent') layer = 2;
      else if (r && (r.flags & 3) !== 0) layer = 1;
      if (layer === 1) f |= G_CUTOUT;
      q.push(face.cullface ? DIRS.indexOf(face.cullface) : -1, face.tint >= 0 ? 1 : 0, c.shade ? 1 : 0, layer, r5(nx), r5(ny), r5(nz), wd);
      for (const { s, p } of pts) {
        let u = -1, v = -1;
        if (r) {
          let fs: number, ft: number;
          if (face.uvlock) {
            // world-aligned uv from the block-space position (trace.ts convention)
            const [wx, wy, wz] = p;
            switch (wd) {
              case 0: fs = wx; ft = 1 - wz; break;
              case 1: fs = wx; ft = wz; break;
              case 2: fs = 1 - wx; ft = 1 - wy; break;
              case 3: fs = wx; ft = 1 - wy; break;
              case 4: fs = wz; ft = 1 - wy; break;
              default: fs = 1 - wz; ft = 1 - wy; break;
            }
          } else {
            let [s0, t0] = faceST(d, s[0], s[1], s[2]);
            const rot = face.rotation / 90;
            if (rot === 1) { const t = s0; s0 = t0; t0 = 1 - t; }
            else if (rot === 2) { s0 = 1 - s0; t0 = 1 - t0; }
            else if (rot === 3) { const t = s0; s0 = 1 - t0; t0 = t; }
            fs = (face.uv[0] + s0 * (face.uv[2] - face.uv[0])) / 16;
            ft = (face.uv[1] + t0 * (face.uv[3] - face.uv[1])) / 16;
          }
          // tiny inset against atlas bleeding at texel-exact edges
          const eps = 0.002;
          fs = Math.min(1 - eps, Math.max(eps, fs));
          ft = Math.min(1 - eps, Math.max(eps, ft));
          u = (r.x + fs * r.w) / atlas!.width;
          v = (r.y + ft * r.h) / atlas!.height;
        }
        q.push(r5(p[0]), r5(p[1]), r5(p[2]), r5(u), r5(v));
      }
    }
  }
  return {
    f,
    c: [g.color[0], g.color[1], g.color[2], g.color[3]],
    t: g.tint ? [g.tint[0], g.tint[1], g.tint[2]] : null,
    k: g.tintKind,
    e: g.emission,
    l: g.fluidLevel,
    g: selfCulls(id) ? id : '',
    q,
  };
}

export class ViewerAssets {
  private o: ViewerAssetsOptions;
  private cache = new Map<string, CompactGeometry>();
  private cacheAtlas: AtlasLookup | null = null;
  private cacheAtlasData: AtlasData | null | undefined = undefined;
  private threeRoot = path.join(ENGINE_ROOT, 'node_modules', 'three');

  constructor(o: ViewerAssetsOptions) {
    this.o = o;
  }

  /** compact geometry for a list of states (assets if available, flat fallback otherwise) */
  async geometry(states: string[]): Promise<Record<string, CompactGeometry>> {
    const assets = await this.o.assets();
    const list = states.filter((s) => typeof s === 'string' && s.length > 0 && s.length < 4096);
    // resolve geometry first: synthesized models may reference textures → atlas rebuild
    const geos = new Map<string, BlockGeometry>();
    for (const s of list) {
      if (this.cache.has(s) && assets) continue;
      geos.set(s, assets ? assets.geometry(s) : flatFor(s));
    }
    const data = assets ? assets.atlasData() : null;
    if (data !== this.cacheAtlasData) {
      // atlas (re)built → uvs changed; recompute everything requested
      this.cache.clear();
      this.cacheAtlasData = data;
      this.cacheAtlas = atlasLookup(data);
      for (const s of list) if (!geos.has(s)) geos.set(s, assets ? assets.geometry(s) : flatFor(s));
    }
    const out: Record<string, CompactGeometry> = {};
    for (const s of list) {
      let cg = this.cache.get(s);
      if (!cg) {
        cg = compactGeometry(geos.get(s) ?? (assets ? assets.geometry(s) : flatFor(s)), this.cacheAtlas);
        this.cache.set(s, cg);
      }
      out[s] = cg;
    }
    return out;
  }

  async info() {
    const assets = await this.o.assets();
    const a = assets ? assets.atlasData() : null;
    const lk = atlasLookup(a);
    const fluid = (name: string) => {
      const r = lk?.rect(name);
      return r ? [r.x / lk!.width, r.y / lk!.height, (r.x + r.w) / lk!.width, (r.y + r.h) / lk!.height] : null;
    };
    const be = this.o.backend();
    return {
      version: ENGINE_VERSION,
      backend: be.kind,
      assets: !!assets,
      atlas: a ? { width: a.width, height: a.height, textures: a.names.length, rev: atlasRev(a) } : null,
      fluids: { water: fluid('block/water_still'), lava: fluid('block/lava_still') },
      waterTint: assets ? assets.tint('water') : [0x3f, 0x76, 0xe4],
      defaultSize: this.o.config.defaultSize,
      depthBelow: this.o.config.depthBelow,
      quadStride: QUAD_STRIDE,
    };
  }

  async biomes(box: Box, step: number) {
    const be = this.o.backend();
    const y = Math.round((box.min[1] + box.max[1]) / 2);
    const st = Math.max(1, Math.min(32, Math.floor(step) || 4));
    const flat: Box = { min: [box.min[0], y, box.min[2]], max: [box.max[0], y, box.max[2]] };
    const nx = Math.ceil((flat.max[0] - flat.min[0] + 1) / st), nz = Math.ceil((flat.max[2] - flat.min[2] + 1) / st);
    if (nx * nz > 1_000_000) throw Object.assign(new Error('biome area too large'), { status: 400 });
    const b = await be.biomes(flat, st);
    const assets = await this.o.assets();
    const tints: Record<string, { grass: number[]; foliage: number[]; dry_foliage: number[]; water: number[] }> = {};
    for (const name of b.palette) {
      tints[name] = assets
        ? { grass: assets.tint('grass', name), foliage: assets.tint('foliage', name), dry_foliage: assets.tint('dry_foliage', name), water: assets.tint('water', name) }
        : { grass: [0x91, 0xbd, 0x59], foliage: [0x77, 0xab, 0x2f], dry_foliage: [0xa0, 0x8a, 0x5a], water: [0x3f, 0x76, 0xe4] };
    }
    return { x0: flat.min[0], z0: flat.min[2], nx, nz, step: b.step, palette: b.palette, data: b64encode(b.data.subarray(0, nx * nz)), tints };
  }

  /**
   * Handle /api/viewer/* (auth already checked by the hub for POSTs). Returns false if the path is not ours.
   */
  async handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    if (!p.startsWith('/api/viewer/')) return false;
    const m = req.method ?? 'GET';
    const json = (obj: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    try {
      if (m === 'GET' && p === '/api/viewer/info') {
        json(await this.info());
        return true;
      }
      if ((m === 'GET' || m === 'HEAD') && p === '/api/viewer/atlas.png') {
        const assets = await this.o.assets();
        if (!assets) {
          json({ error: 'assets unavailable (flat colors)' }, 404);
          return true;
        }
        const a = assets.textureAtlas();
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': a.png.length, 'cache-control': 'no-cache', etag: `"${atlasRev(assets.atlasData())}"` });
        res.end(m === 'HEAD' ? undefined : a.png);
        return true;
      }
      if (p === '/api/viewer/geometry' && (m === 'GET' || m === 'POST')) {
        let states: unknown;
        if (m === 'POST') states = ((await readBody(req, 4 * 1024 * 1024)) as { states?: unknown } | undefined)?.states;
        else states = url.searchParams.getAll('s');
        if (!Array.isArray(states) || states.length > 8192) {
          json({ error: 'states: string[] (max 8192) required' }, 400);
          return true;
        }
        const geometry = await this.geometry(states.map(String));
        const assets = await this.o.assets();
        json({ atlasRev: assets ? atlasRev(assets.atlasData()) : null, geometry });
        return true;
      }
      if (m === 'GET' && p === '/api/viewer/biomes') {
        const n = (url.searchParams.get('box') ?? '').split(',').map(Number);
        if (n.length !== 6 || n.some((v) => !Number.isFinite(v))) {
          json({ error: 'box=x1,y1,z1,x2,y2,z2 required' }, 400);
          return true;
        }
        const box = normalizeBox({ min: [n[0]!, n[1]!, n[2]!], max: [n[3]!, n[4]!, n[5]!] });
        json(await this.biomes(box, Number(url.searchParams.get('step')) || 4));
        return true;
      }
      json({ error: `unknown viewer endpoint ${m} ${p}` }, 404);
      return true;
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      if (!res.headersSent) json({ error: (e as Error).message }, status);
      else res.end();
      return true;
    }
  }

  /** GET /vendor/three/<build|examples/jsm>/… → node_modules/three. Returns false if not a vendor path. */
  serveVendor(res: ServerResponse, p: string): boolean {
    if (!p.startsWith('/vendor/three/')) return false;
    let rel: string;
    try {
      rel = decodeURIComponent(p.slice('/vendor/three/'.length));
    } catch {
      rel = '';
    }
    const root = path.resolve(this.threeRoot);
    const file = path.resolve(root, rel);
    const allowed = [path.join(root, 'build') + path.sep, path.join(root, 'examples', 'jsm') + path.sep];
    const send = (status: number, msg: string) => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(msg);
    };
    if (!rel || !allowed.some((a) => file.startsWith(a)) || !/\.(js|mjs|wasm)$/.test(file)) {
      send(403, 'forbidden');
      return true;
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      send(404, 'not found');
      return true;
    }
    if (!st.isFile()) {
      send(404, 'not found');
      return true;
    }
    res.writeHead(200, {
      'content-type': file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8',
      'content-length': st.size,
      'cache-control': 'public, max-age=3600',
    });
    fs.createReadStream(file).pipe(res);
    return true;
  }
}

function flatFor(s: string): BlockGeometry {
  let id: string, props: Record<string, string>;
  try {
    ({ id, props } = stateProps(s));
  } catch {
    id = blockId(s);
    props = {};
  }
  return flatGeometry(s, id, props);
}

function atlasRev(a: AtlasData): string {
  return `${a.width}x${a.height}-${a.names.length}`;
}

function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > limit) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!n) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}
