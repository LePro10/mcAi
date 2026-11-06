// Blueprint images: top-down slices of single layers with grid + coordinates.
import type { BlockVolume } from '../core/types.ts';
import { blockId, isAir } from '../core/blockstate.ts';
import type { AssetStore } from '../assets/assets.ts';
import { flatGeometry } from '../assets/fallback.ts';
import { stateProps } from '../assets/registry-lite.ts';
import { matVec, type BlockGeometry, type GeoFace } from '../assets/geometry.ts';
import { Img, type RGBA } from './image.ts';

export interface LayerOptions {
  /** pixels per block (default: fit into maxWidth, 4..24) */
  cell?: number;
  maxWidth?: number;
  /** grid columns when several layers are requested */
  columns?: number;
  /** show the layer below (dimmed) where the current layer is empty, default true */
  ghost?: boolean;
}

const PAPER: RGBA = [236, 240, 245, 255];

export async function renderLayers(v: BlockVolume, assets: AssetStore | null, ys: number[], opts: LayerOptions = {}): Promise<Buffer> {
  return renderLayersImage(v, assets, ys, opts).toPng();
}

export function renderLayersImage(v: BlockVolume, assets: AssetStore | null, ys: number[], opts: LayerOptions = {}): Img {
  const sx = v.box.max[0] - v.box.min[0] + 1, sy = v.box.max[1] - v.box.min[1] + 1, sz = v.box.max[2] - v.box.min[2] + 1;
  const layers = ys.length ? ys : [v.box.min[1]];
  const columns = Math.max(1, Math.min(layers.length, opts.columns ?? (layers.length <= 2 ? layers.length : layers.length <= 4 ? 2 : 3)));
  const maxW = opts.maxWidth ?? 1600;
  const cell = Math.max(3, Math.min(24, opts.cell ?? Math.floor((maxW / columns - 60) / sx)));
  const mL = 34, mT = 40, mR = 12, mB = 12;
  const tileW = mL + sx * cell + mR, tileH = mT + sz * cell + mB;
  const rows = Math.ceil(layers.length / columns);
  const out = new Img(tileW * columns, tileH * rows, [214, 220, 228, 255]);
  const atlas = assets ? assets.atlasData() : null;
  const geoOf = (s: string): BlockGeometry => {
    if (assets) return assets.geometry(s);
    try {
      const { id, props } = stateProps(s);
      return flatGeometry(s, id, props);
    } catch {
      return flatGeometry(s, blockId(s), {});
    }
  };
  const geoCache = new Map<number, BlockGeometry>();
  const geo = (p: number) => {
    let g = geoCache.get(p);
    if (!g) {
      g = geoOf(v.palette[p]);
      geoCache.set(p, g);
    }
    return g;
  };

  const drawCell = (img: Img, px: number, py: number, p: number, alpha: number) => {
    const g = geo(p);
    if (g.invisible && !g.fluid) return;
    if (g.fluid && g.cuboids.length === 0) {
      const c = assets ? assets.averageColor(g.state) : g.color;
      img.fillRect(px, py, cell, cell, [c[0], c[1], c[2], Math.round(255 * alpha * 0.9)]);
      return;
    }
    if (g.fluid) {
      const c = assets ? assets.averageColor('minecraft:water') : [63, 118, 228, 200];
      img.fillRect(px, py, cell, cell, [c[0], c[1], c[2], Math.round(200 * alpha)]);
    }
    // draw cuboids sorted by top height (footprints)
    const parts = g.cuboids.map((c) => {
      const pts: number[][] = [];
      for (let i = 0; i < 8; i++) {
        const q = matVec(c.m, [i & 1 ? c.to[0] : c.from[0], i & 2 ? c.to[1] : c.from[1], i & 4 ? c.to[2] : c.from[2]]);
        pts.push([q[0] + c.t[0], q[1] + c.t[1], q[2] + c.t[2]]);
      }
      const x0 = Math.min(...pts.map((q) => q[0])), x1 = Math.max(...pts.map((q) => q[0]));
      const z0 = Math.min(...pts.map((q) => q[2])), z1 = Math.max(...pts.map((q) => q[2]));
      const top = Math.max(...pts.map((q) => q[1]));
      const face: GeoFace | undefined = c.faces.up ?? c.faces.north ?? c.faces.south ?? c.faces.east ?? c.faces.west ?? c.faces.down;
      return { x0, x1, z0, z1, top, face, up: !!c.faces.up };
    });
    parts.sort((a, b) => a.top - b.top);
    const anyUp = g.cuboids.some((c) => c.faces.up);
    for (let pi = 0; pi < parts.length; pi++) {
      const part = parts[pi];
      if (anyUp && !part.up) continue;
      const f = part.face;
      const ix0 = Math.max(0, Math.floor((Math.max(0, part.x0) / 16) * cell)), ix1 = Math.min(cell, Math.ceil((Math.min(16, part.x1) / 16) * cell));
      const iz0 = Math.max(0, Math.floor((Math.max(0, part.z0) / 16) * cell)), iz1 = Math.min(cell, Math.ceil((Math.min(16, part.z1) / 16) * cell));
      const ti = f && atlas && f.texture ? atlas.index.get(f.texture) : undefined;
      const tint = f && f.tint >= 0 ? g.tint : null;
      for (let j = Math.max(iz0, 0); j < Math.max(iz1, iz0 + 1); j++)
        for (let i = Math.max(ix0, 0); i < Math.max(ix1, ix0 + 1); i++) {
          let c: RGBA;
          if (ti !== undefined && atlas && f) {
            const fs = (i + 0.5 - ix0) / Math.max(1, ix1 - ix0), ft = (j + 0.5 - iz0) / Math.max(1, iz1 - iz0);
            const u = (f.uv[0] + (f.uv[2] - f.uv[0]) * fs) / 16, vv = (f.uv[1] + (f.uv[3] - f.uv[1]) * ft) / 16;
            const r = ti * 4, w = atlas.rects[r + 2], h = atlas.rects[r + 3];
            const tx = atlas.rects[r] + Math.min(w - 1, Math.max(0, Math.floor(u * w)));
            const ty = atlas.rects[r + 1] + Math.min(h - 1, Math.max(0, Math.floor(vv * h)));
            const o = (ty * atlas.width + tx) * 4;
            c = [atlas.rgba[o], atlas.rgba[o + 1], atlas.rgba[o + 2], atlas.rgba[o + 3]];
            if (tint) c = [(c[0] * tint[0]) / 255, (c[1] * tint[1]) / 255, (c[2] * tint[2]) / 255, c[3]];
          } else c = [...g.color] as RGBA;
          if (c[3] < 40) continue;
          img.blend(px + i, py + j, c, (c[3] / 255) * alpha);
        }
    }
  };

  layers.forEach((y, li) => {
    const tx = (li % columns) * tileW, ty = Math.floor(li / columns) * tileH;
    const tile = new Img(tileW, tileH, [214, 220, 228, 255]);
    tile.fillRect(mL, mT, sx * cell, sz * cell, PAPER);
    const inY = y >= v.box.min[1] && y <= v.box.max[1];
    let count = 0;
    if (inY)
      for (let z = 0; z < sz; z++)
        for (let x = 0; x < sx; x++) {
          const i = ((y - v.box.min[1]) * sz + z) * sx + x;
          const p = v.data[i];
          const px = mL + x * cell, py = mT + z * cell;
          if (p !== 0 && !isAir(v.palette[p])) {
            drawCell(tile, px, py, p, 1);
            count++;
          } else if ((opts.ghost ?? true) && y - 1 >= v.box.min[1]) {
            const pb = v.data[i - sx * sz];
            if (pb !== 0 && !isAir(v.palette[pb])) {
              drawCell(tile, px, py, pb, 0.28);
              tile.fillRect(px, py, cell, cell, [120, 150, 200, 40]);
            }
          }
        }
    // grid
    const minor: RGBA = [90, 110, 140, cell >= 8 ? 60 : 30], major: RGBA = [40, 60, 100, 150];
    for (let x = 0; x <= sx; x++) {
      const wx = v.box.min[0] + x;
      const isMajor = wx % 5 === 0;
      if (cell < 6 && !isMajor) continue;
      tile.fillRect(mL + x * cell - (isMajor ? 1 : 0), mT, isMajor ? 2 : 1, sz * cell, isMajor ? major : minor);
    }
    for (let z = 0; z <= sz; z++) {
      const wz = v.box.min[2] + z;
      const isMajor = wz % 5 === 0;
      if (cell < 6 && !isMajor) continue;
      tile.fillRect(mL, mT + z * cell - (isMajor ? 1 : 0), sx * cell, isMajor ? 2 : 1, isMajor ? major : minor);
    }
    // coordinates every 5 (or 10 when dense)
    const stepL = cell * 5 >= 26 ? 5 : 10;
    for (let x = 0; x < sx; x++) {
      const wx = v.box.min[0] + x;
      if (((wx % stepL) + stepL) % stepL !== 0) continue;
      const s = String(wx);
      tile.text(mL + x * cell + cell / 2 - Img.textWidth(s, 1) / 2, mT - 10, s, 1, [30, 40, 60, 255], null);
    }
    for (let z = 0; z < sz; z++) {
      const wz = v.box.min[2] + z;
      if (((wz % stepL) + stepL) % stepL !== 0) continue;
      const s = String(wz);
      tile.text(mL - 4 - Img.textWidth(s, 1), mT + z * cell + cell / 2 - 3, s, 1, [30, 40, 60, 255], null);
    }
    tile.text(mL, 6, `Y=${y}`, 2, [20, 30, 50, 255], null);
    tile.text(mL + Img.textWidth(`Y=${y}`, 2) + 12, 10, `${count} blocks  x right, z down, north up`, 1, [60, 70, 90, 255], null);
    if (!inY) tile.text(mL + 6, mT + 6, 'outside volume', 1, [160, 40, 40, 255], null);
    tile.strokeRect(mL - 1, mT - 1, sx * cell + 2, sz * cell + 2, [40, 60, 100, 255], 1);
    out.blit(tile, tx, ty);
  });
  void sy;
  return out;
}
