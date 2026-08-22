/**
 * Offline preview rendering.
 *
 * Being able to look at a build before it touches a world is what makes this
 * system safe to iterate on: the compiler is deterministic, so the preview is
 * exactly what the server will produce. Used by the CLI, the dashboard, and the
 * screenshots in the docs.
 */

import type { CompiledBuild, Voxel } from './types.js';
import { parseBlock } from './blocks.js';

// ── Colour ────────────────────────────────────────────────────────────────

/** Approximate top-face colours, matched by substring, most specific first. */
const COLOR_RULES: Array<[RegExp, string]> = [
  [/air/, '#00000000'],
  [/water/, '#3b6ede'],
  [/lava|magma/, '#e2591b'],
  [/glass|ice$|packed_ice/, '#a8d8e8'],
  [/blue_ice/, '#74a8e0'],
  [/sea_lantern|glowstone|shroomlight|lantern|torch|redstone_lamp|end_rod|beacon/, '#ffd98a'],
  [/gold/, '#f2c144'],
  [/copper|weathered|oxidized/, '#7fb8a0'],
  [/exposed_c/, '#b08064'],
  [/iron/, '#d8d8d8'],
  [/diamond/, '#5ce0d8'],
  [/emerald/, '#3fd07a'],
  [/lapis/, '#2b52a8'],
  [/amethyst|purpur|purple/, '#9a6cc4'],
  [/quartz|calcite|bone_block|white_concrete|white_terracotta|snow|smooth_quartz/, '#ece8dd'],
  [/deepslate|blackstone|obsidian|basalt/, '#39383f'],
  [/black_/, '#1d1d21'],
  [/nether_brick/, '#4a2327'],
  [/netherrack|crimson/, '#8b3a3a'],
  [/warped/, '#2c8577'],
  [/prismarine/, '#5aa396'],
  [/sandstone|sand$/, '#dcd0a0'],
  [/red_sand/, '#b9603a'],
  [/terracotta/, '#9a5b3f'],
  [/brick/, '#96594a'],
  [/moss|leaves|vine|lichen|grass_block|azalea/, '#5d8a3c'],
  [/podzol|dirt|mud|coarse/, '#7a5636'],
  [/gravel|andesite|cobblestone|stone_brick|stone$|smooth_stone|tuff/, '#8d8d8d'],
  [/mossy/, '#77855e'],
  [/granite/, '#a5715c'],
  [/diorite/, '#d5d3d0'],
  [/dark_oak|spruce/, '#54371f'],
  [/birch|bamboo/, '#d9c89a'],
  [/oak/, '#b08a52'],
  [/jungle|acacia/, '#9a6338'],
  [/cherry/, '#d4849a'],
  [/hay|wheat/, '#d4b03c'],
  [/wool|carpet|concrete|wood|planks|log/, '#a9793f'],
  [/fence|wall$|stairs|slab/, '#8d8d8d'],
];

const colorCache = new Map<string, string>();

export function blockColor(spec: string): string {
  const cached = colorCache.get(spec);
  if (cached) return cached;
  const id = parseBlock(spec).id;
  let out = '#9b9b9b';
  for (const [re, color] of COLOR_RULES) {
    if (re.test(id)) { out = color; break; }
  }
  if (!/^#[0-9a-fA-F]{6,8}$/.test(out)) out = '#a9793f';
  colorCache.set(spec, out);
  return out;
}

function shade(hex: string, factor: number): string {
  const h = hex.replace('#', '').slice(0, 6);
  const n = parseInt(h, 16);
  const r = Math.max(0, Math.min(255, Math.round(((n >> 16) & 255) * factor)));
  const g = Math.max(0, Math.min(255, Math.round(((n >> 8) & 255) * factor)));
  const b = Math.max(0, Math.min(255, Math.round((n & 255) * factor)));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

// ── Visibility ────────────────────────────────────────────────────────────

/**
 * Drop voxels hidden behind their neighbours.
 *
 * An isometric camera sees the +X, +Y and +Z faces, so a voxel with solid
 * neighbours on all three can never contribute a pixel. On a solid castle this
 * removes well over 90 % of the geometry and turns an unopenable SVG into one
 * that renders instantly.
 */
export function visibleVoxels(voxels: Voxel[]): Voxel[] {
  const solid = new Set<string>();
  for (const v of voxels) {
    if (v.block.startsWith('air')) continue;
    solid.add(`${v.x},${v.y},${v.z}`);
  }
  const out: Voxel[] = [];
  for (const v of voxels) {
    if (v.block.startsWith('air')) continue;
    const hidden =
      solid.has(`${v.x + 1},${v.y},${v.z}`) &&
      solid.has(`${v.x},${v.y + 1},${v.z}`) &&
      solid.has(`${v.x},${v.y},${v.z + 1}`);
    if (!hidden) out.push(v);
  }
  return out;
}

export interface IsoOptions {
  /** Half-width of a block in pixels. */
  scale?: number;
  /** Maximum voxels drawn; beyond this the build is sampled down. */
  maxVoxels?: number;
  background?: string;
  padding?: number;
}

/**
 * Isometric SVG of a compiled build. Self-contained, no scripts, so it can be
 * dropped into a README, a dashboard, or a static page.
 */
export function renderIsoSvg(build: CompiledBuild, opts: IsoOptions = {}): string {
  const scale = opts.scale ?? 6;
  const maxVoxels = opts.maxVoxels ?? 90_000;
  const pad = opts.padding ?? 24;

  let vox = visibleVoxels(build.voxels);
  if (vox.length > maxVoxels) {
    const stride = Math.ceil(vox.length / maxVoxels);
    vox = vox.filter((_, i) => i % stride === 0);
  }
  if (vox.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><text x="12" y="44" font-family="monospace" font-size="14" fill="#888">empty build</text></svg>`;
  }

  const hw = scale;              // half width
  const hh = scale / 2;          // half depth on screen
  const vh = scale;              // block height on screen

  const px = (v: Voxel) => (v.x - v.z) * hw;
  const py = (v: Voxel) => (v.x + v.z) * hh - v.y * vh;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const v of vox) {
    const x = px(v), y = py(v);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const w = Math.ceil(maxX - minX + hw * 2 + pad * 2);
  const h = Math.ceil(maxY - minY + hh * 2 + vh + pad * 2);
  const ox = -minX + hw + pad;
  const oy = -minY + pad;

  // Painter's algorithm: draw far blocks first.
  vox.sort((a, b) => (a.x + a.z - a.y) - (b.x + b.z - b.y) || a.y - b.y);

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">`);
  if (opts.background) parts.push(`<rect width="${w}" height="${h}" fill="${opts.background}"/>`);

  for (const v of vox) {
    const x = px(v) + ox;
    const y = py(v) + oy;
    const c = blockColor(v.block);
    if (c.length === 9 && c.endsWith('00')) continue;
    const top = shade(c, 1.12);
    const left = shade(c, 0.78);
    const right = shade(c, 0.58);
    parts.push(
      `<path d="M${x} ${y}l${hw} ${hh} ${-hw} ${hh} ${-hw} ${-hh}z" fill="${top}"/>` +
      `<path d="M${x - hw} ${y + hh}l${hw} ${hh}v${vh}l${-hw} ${-hh}z" fill="${left}"/>` +
      `<path d="M${x + hw} ${y + hh}l${-hw} ${hh}v${vh}l${hw} ${-hh}z" fill="${right}"/>`,
    );
  }
  parts.push('</svg>');
  return parts.join('');
}

// ── ASCII ─────────────────────────────────────────────────────────────────

const RAMP = ' .:-=+*#%@';

/** Top-down heat map: brighter means taller. Good for terminals and logs. */
export function renderAsciiTop(build: CompiledBuild, maxWidth = 100): string {
  const { min, max } = build.stats.bounds;
  const w = max[0] - min[0] + 1;
  const d = max[2] - min[2] + 1;
  if (w <= 0 || d <= 0) return '(empty)';

  const stride = Math.max(1, Math.ceil(w / maxWidth));
  const cols = Math.ceil(w / stride);
  const rows = Math.ceil(d / stride);
  const height = new Int32Array(cols * rows).fill(-9999);

  for (const v of build.voxels) {
    if (v.block.startsWith('air')) continue;
    const cx = Math.floor((v.x - min[0]) / stride);
    const cz = Math.floor((v.z - min[2]) / stride);
    const i = cz * cols + cx;
    if (v.y > height[i]) height[i] = v.y;
  }

  let lo = Infinity, hi = -Infinity;
  for (const h of height) {
    if (h === -9999) continue;
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  if (!Number.isFinite(lo)) return '(empty)';
  const span = Math.max(1, hi - lo);

  const lines: string[] = [];
  for (let z = 0; z < rows; z++) {
    let line = '';
    for (let x = 0; x < cols; x++) {
      const hgt = height[z * cols + x];
      if (hgt === -9999) { line += ' '; continue; }
      const t = (hgt - lo) / span;
      line += RAMP[Math.min(RAMP.length - 1, Math.max(1, Math.round(t * (RAMP.length - 1))))];
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  return lines.join('\n');
}

/** Front elevation (looking north, along −Z). */
export function renderAsciiFront(build: CompiledBuild, maxWidth = 100): string {
  const { min, max } = build.stats.bounds;
  const w = max[0] - min[0] + 1;
  const h = max[1] - min[1] + 1;
  if (w <= 0 || h <= 0) return '(empty)';
  const stride = Math.max(1, Math.ceil(w / maxWidth));
  const cols = Math.ceil(w / stride);
  const rows = Math.ceil(h / stride);
  const grid = new Uint8Array(cols * rows);

  for (const v of build.voxels) {
    if (v.block.startsWith('air')) continue;
    const cx = Math.floor((v.x - min[0]) / stride);
    const cy = Math.floor((v.y - min[1]) / stride);
    grid[(rows - 1 - cy) * cols + cx] = 1;
  }

  const lines: string[] = [];
  for (let y = 0; y < rows; y++) {
    let line = '';
    for (let x = 0; x < cols; x++) line += grid[y * cols + x] ? '#' : ' ';
    lines.push(line.replace(/\s+$/, ''));
  }
  return lines.join('\n');
}
