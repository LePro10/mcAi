// Public renderer API: renderVolume (PNG), renderImage (Img), contactSheet, renderLayers.
// See docs/ENGINE-API.md (assets-render-sim).
import type { BlockVolume, Box } from '../core/types.ts';
import type { AssetStore } from '../assets/assets.ts';
import { compileScene, sceneBoundsBox, type SceneData } from './scene.ts';
import { createTracer, type RenderParams } from './trace.ts';
import { makeCamera, makeLighting, project, type Camera, type ViewName } from './camera.ts';
import { renderParallel } from './pool.ts';
import { Img, type RGBA } from './image.ts';

export { renderLayers } from './layers.ts';
export type { ViewName } from './camera.ts';

export interface RenderOptions {
  width?: number;
  height?: number;
  view?: ViewName;
  /** orbit: Minecraft yaw of the look direction (0 = looking south, 90 = west, 180 = north); top: image-up = north rotated clockwise */
  yaw?: number;
  /** elevation in degrees (positive = looking down); iso default 30, elevations 0, orbit 28 */
  pitch?: number;
  zoom?: number;
  /** frame this box instead of the non-air bounds */
  focus?: Box;
  shadows?: boolean;
  time?: 'day' | 'sunset' | 'night';
  highlight?: Box;
  /** draw view name, size and a north arrow */
  labels?: boolean;
  /** supersampling factor (1 or 2), default 1 */
  supersample?: number;
  ao?: boolean;
  /** ground grid plane at the bottom of the volume, default true */
  ground?: boolean;
  /** biome for grass/foliage/water tints, default plains */
  biome?: string;
  /** 'camera' (default): key light from the camera's upper left; 'world': fixed sun */
  sun?: 'camera' | 'world';
  /** depth haze, default true */
  fog?: boolean;
  /** use worker threads for large images (default true) */
  parallel?: boolean;
  /** label text override (shown when labels=true) */
  title?: string;
}

export const VIEW_LABEL: Record<string, string> = {
  iso_se: 'ISO SE', iso_sw: 'ISO SW', iso_ne: 'ISO NE', iso_nw: 'ISO NW', front: 'FRONT (S)', back: 'BACK (N)',
  left: 'LEFT (W)', right: 'RIGHT (E)', top: 'TOP', orbit: 'ORBIT',
};

interface Prepared {
  scene: SceneData;
  frame: Box;
}

function prepare(v: BlockVolume, assets: AssetStore | null, opts: RenderOptions): Prepared {
  const scene = compileScene(v, assets, opts.biome);
  const frame = opts.focus ?? sceneBoundsBox(scene) ?? v.box;
  return { scene, frame };
}

async function trace(prep: Prepared, cam: Camera, opts: RenderOptions): Promise<Float32Array> {
  const L = makeLighting(opts.time ?? 'day', cam, opts.sun ?? 'camera');
  const s = prep.scene;
  const fx0 = prep.frame.min[0], fz0 = prep.frame.min[2], fx1 = prep.frame.max[0] + 1, fz1 = prep.frame.max[2] + 1;
  const diag = Math.hypot(fx1 - fx0, prep.frame.max[1] - prep.frame.min[1] + 1, fz1 - fz0);
  const params: RenderParams = {
    W: cam.W, H: cam.H, ortho: cam.ortho, c: cam.c, f: cam.f, r: cam.r, u: cam.u, scale: cam.scale,
    sun: L.sun, sunCol: L.sunCol, ambCol: L.ambCol, blockCol: L.blockCol, skyTop: L.skyTop, skyHor: L.skyHor,
    shadows: opts.shadows ?? true, ao: opts.ao ?? true,
    ground: opts.ground ?? true, groundY: s.oy,
    groundBox: [Math.min(fx0, s.ox), Math.min(fz0, s.oz), Math.max(fx1, s.ox + s.sx), Math.max(fz1, s.oz + s.sz)],
    fogDepth: opts.fog === false ? 0 : Math.max(12, diag * 2.5), fogStart: fogStart(cam, prep.frame), fogCol: L.fogCol, night: L.night,
  };
  const fb = new Float32Array(new SharedArrayBuffer(cam.W * cam.H * 3 * 4));
  let done = false;
  if ((opts.parallel ?? true) && cam.W * cam.H >= 160_000) done = await renderParallel(s, params, fb);
  if (!done) createTracer(s, params).renderRows(0, cam.H, fb);
  // exposure baked into the framebuffer for tone mapping
  const e = L.exposure;
  if (e !== 1) for (let i = 0; i < fb.length; i++) fb[i] *= e;
  return fb;
}

/** ray parameter of the frame corner nearest to the camera */
function fogStart(cam: Camera, b: Box): number {
  let m = Infinity;
  for (let i = 0; i < 8; i++) {
    const p = [i & 1 ? b.max[0] + 1 : b.min[0], i & 2 ? b.max[1] + 1 : b.min[1], i & 4 ? b.max[2] + 1 : b.min[2]];
    m = Math.min(m, (p[0] - cam.c[0]) * cam.f[0] + (p[1] - cam.c[1]) * cam.f[1] + (p[2] - cam.c[2]) * cam.f[2]);
  }
  return (cam.ortho ? 1e4 : 0) + m;
}

function aces(x: number): number {
  const v = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
const GAMMA = new Float32Array(4097);
for (let i = 0; i <= 4096; i++) GAMMA[i] = Math.pow(i / 4096, 1 / 2.2) * 255;

/** downsample (box filter) + tone map into an Img */
function toImage(fb: Float32Array, W: number, H: number, ss: number): Img {
  const w = Math.floor(W / ss), h = Math.floor(H / ss);
  const img = new Img(w, h);
  const k = 1 / (ss * ss);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < ss; j++)
        for (let i = 0; i < ss; i++) {
          const o = ((y * ss + j) * W + x * ss + i) * 3;
          r += fb[o]; g += fb[o + 1]; b += fb[o + 2];
        }
      const d = (y * w + x) * 4;
      img.data[d] = GAMMA[(aces(r * k) * 4096) | 0];
      img.data[d + 1] = GAMMA[(aces(g * k) * 4096) | 0];
      img.data[d + 2] = GAMMA[(aces(b * k) * 4096) | 0];
      img.data[d + 3] = 255;
    }
  return img;
}

function drawBox(img: Img, cam: Camera, b: Box, ss: number, color: RGBA): void {
  const P: [number, number][] = [];
  for (let i = 0; i < 8; i++) {
    const p = [i & 1 ? b.max[0] + 1 : b.min[0], i & 2 ? b.max[1] + 1 : b.min[1], i & 4 ? b.max[2] + 1 : b.min[2]];
    const q = project(cam, p);
    P.push([q[0] / ss, q[1] / ss]);
  }
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  for (const [a, c] of edges) img.line(P[a][0], P[a][1], P[c][0], P[c][1], [0, 0, 0, 140], 4);
  for (const [a, c] of edges) img.line(P[a][0], P[a][1], P[c][0], P[c][1], color, 2);
}

function drawLabels(img: Img, cam: Camera, frame: Box, opts: RenderOptions): void {
  const scale = img.w >= 700 ? 2 : 1;
  const sz = [frame.max[0] - frame.min[0] + 1, frame.max[1] - frame.min[1] + 1, frame.max[2] - frame.min[2] + 1];
  const title = opts.title ?? VIEW_LABEL[opts.view ?? 'iso_se'] ?? String(opts.view);
  img.label(6 * scale, 6 * scale, title, scale);
  const dims = `${sz[0]}x${sz[1]}x${sz[2]}  (${frame.min.join(',')})`;
  img.label(6 * scale, img.h - (11 * scale + 6 * scale) - 2, dims, scale, [230, 230, 230, 255]);
  // north arrow
  const n = [-cam.f[0] * 0, 0, -1];
  const rx = n[0] * cam.r[0] + n[1] * cam.r[1] + n[2] * cam.r[2];
  const uy = n[0] * cam.u[0] + n[1] * cam.u[1] + n[2] * cam.u[2];
  const L = Math.hypot(rx, uy);
  const cx = img.w - 26 * scale, cy = img.h - 26 * scale;
  img.fillRect(cx - 18 * scale, cy - 18 * scale, 36 * scale, 36 * scale, [20, 24, 32, 140]);
  if (L > 0.05) {
    const dx = (rx / L) * 12 * scale, dy = (-uy / L) * 12 * scale;
    img.line(cx - dx * 0.6, cy - dy * 0.6, cx + dx, cy + dy, [255, 80, 70, 255], 2.5 * scale);
    img.text(cx + dx * 1.1 - 2.5 * scale, cy + dy * 1.1 - 3.5 * scale, 'N', scale, [255, 255, 255, 255]);
  } else img.text(cx - 2.5 * scale, cy - 3.5 * scale, 'N', scale);
}

/** Render to an RGBA image (for compositing). */
export async function renderImage(v: BlockVolume, assets: AssetStore | null, opts: RenderOptions = {}, prepared?: Prepared): Promise<Img> {
  const width = Math.max(16, Math.min(4096, Math.round(opts.width ?? 1024)));
  const height = Math.max(16, Math.min(4096, Math.round(opts.height ?? 768)));
  const ss = Math.max(1, Math.min(3, Math.round(opts.supersample ?? 1)));
  const prep = prepared ?? prepare(v, assets, opts);
  const cam = makeCamera(opts, prep.frame, width * ss, height * ss);
  const fb = await trace(prep, cam, opts);
  const img = toImage(fb, width * ss, height * ss, ss);
  if (opts.highlight) drawBox(img, cam, opts.highlight, ss, [255, 214, 40, 255]);
  if (opts.labels) drawLabels(img, cam, prep.frame, opts);
  return img;
}

/** Render a BlockVolume to PNG. Never throws for missing assets (flat-colored fallback). */
export async function renderVolume(v: BlockVolume, assets: AssetStore | null, opts: RenderOptions = {}): Promise<Buffer> {
  return (await renderImage(v, assets, opts)).toPng();
}

export interface ContactSheetOptions extends RenderOptions {
  views?: ViewName[];
}

/** Several views (default 4 isometric corners) in one labelled image (2×2 grid for 4 views). */
export async function contactSheetImage(v: BlockVolume, assets: AssetStore | null, opts: ContactSheetOptions = {}): Promise<Img> {
  const views = opts.views?.length ? opts.views : (['iso_se', 'iso_sw', 'iso_nw', 'iso_ne'] as ViewName[]);
  const W = opts.width ?? 1024, H = opts.height ?? 768;
  const cols = views.length === 1 ? 1 : views.length <= 4 ? 2 : 3;
  const rows = Math.ceil(views.length / cols);
  const gap = 4;
  const tw = Math.floor((W - gap * (cols - 1)) / cols), th = Math.floor((H - gap * (rows - 1)) / rows);
  const prep = prepare(v, assets, opts);
  const sheet = new Img(W, H, [24, 26, 32, 255]);
  for (let i = 0; i < views.length; i++) {
    const img = await renderImage(v, assets, { ...opts, view: views[i], width: tw, height: th, labels: false, title: undefined }, prep);
    const x = (i % cols) * (tw + gap), y = Math.floor(i / cols) * (th + gap);
    sheet.blit(img, x, y);
    const s = tw >= 480 ? 2 : 1;
    sheet.label(x + 5 * s, y + 5 * s, VIEW_LABEL[views[i]] ?? views[i], s);
  }
  if (opts.labels !== false) {
    const f = prep.frame;
    const s = W >= 900 ? 2 : 1;
    const dims = `${f.max[0] - f.min[0] + 1}x${f.max[1] - f.min[1] + 1}x${f.max[2] - f.min[2] + 1}`;
    sheet.label(W - Img.textWidth(dims, s) - 10 * s, H - 16 * s, dims, s, [230, 230, 230, 255]);
  }
  return sheet;
}

export async function contactSheet(v: BlockVolume, assets: AssetStore | null, opts: ContactSheetOptions = {}): Promise<Buffer> {
  return (await contactSheetImage(v, assets, opts)).toPng();
}
