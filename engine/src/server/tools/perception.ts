// Perception tools: get_context, scan_region, render_view, find_blocks, block_info, heightmap.

import { z } from 'zod';
import type { BlockVolume, Box, Vec3 } from '../../core/types.ts';
import { boxIntersect, boxVolume, volGet } from '../../core/volume.ts';
import { blockId, isAir } from '../../core/blockstate.ts';
import { summarize, surfaceMap, findDarkSpots, classifyDarkSpots } from '../../core/analysis.ts';
import { findFloating } from '../../core/trees.ts';
import { renderVolume, type RenderOptions } from '../../render/render.ts';
import { builtMask, expandToComponents } from '../../render/expand.ts';
import { analyzeColumns, terrainStats } from '../terrain.ts';
import {
  BoxIn,
  SpaceIn,
  ToolError,
  defineTool,
  fmtBox,
  fmtV,
  frameOf,
  jobEditBounds,
  normBoxIn,
  readSpaceVolume,
  short,
  toLocalBox,
  toWorldBox,
  type ToolCtx,
  type ToolDef,
} from './common.ts';

const MAX_SCAN_VOLUME = 2_000_000;
const MAX_RENDER_VOLUME = 6_000_000;

function cardinal(yaw: number): string {
  // Minecraft yaw: 0 = south (+z), 90 = west, 180 = north, -90 = east
  const a = ((Math.round(yaw / 90) % 4) + 4) % 4;
  return ['south', 'west', 'north', 'east'][a]!;
}

/** ground offsets (ground y - anchor y) sampled on a coarse local grid */
function localGrid(ctx: ToolCtx, ground: (wx: number, wz: number) => number, lbox: Box, cells = 8): string[] {
  const rows: string[] = [];
  const f = frameOf(ctx);
  const ay = ctx.job.req.anchor[1];
  const sx = lbox.max[0] - lbox.min[0] + 1, sz = lbox.max[2] - lbox.min[2] + 1;
  const nx = Math.min(cells, sx), nz = Math.min(cells, sz);
  for (let r = 0; r < nz; r++) {
    const lz = Math.round(lbox.min[2] + ((r + 0.5) * sz) / nz - 0.5);
    const vals: string[] = [];
    for (let c = 0; c < nx; c++) {
      const lx = Math.round(lbox.min[0] + ((c + 0.5) * sx) / nx - 0.5);
      const w = f.toWorld([lx, 0, lz]);
      const g = ground(w[0], w[2]);
      vals.push(Number.isNaN(g) ? '  ?' : String(g - ay).padStart(3));
    }
    rows.push(`z=${String(lz).padStart(4)}: ${vals.join(' ')}`);
  }
  return rows;
}

export const getContext = defineTool({
  name: 'get_context',
  title: 'Get job context',
  readOnly: true,
  description:
    'Call this FIRST. Returns the build request, the player (name, position, facing), the anchor and coordinate frame, ' +
    'the allowed build box (edits outside are rejected), world info, biome, a terrain summary of the site ' +
    '(ground height min/max/avg relative to the anchor, water/vegetation %, surface blocks, coarse local height grid), ' +
    'block limits, budget and a suggested building origin. ' +
    "LOCAL SPACE (default for all tools): origin = anchor, +x = player's right, +y = up, -z = forward into the site, +z = toward the player; " +
    'the front facade should face +z. Local y=0 is the anchor block level (the ground block the player targeted).',
  input: z.object({}),
  async run(_args, ctx) {
    const { job, env } = ctx;
    const be = env.backend();
    const reg = env.registry();
    const info = await be.info();
    const f = frameOf(ctx);
    const ab = job.allowedBox;
    const lb = toLocalBox(ctx, ab);
    const players = await be.players().catch(() => []);
    const p = players.find((pl) => pl.name === job.player) ?? (job.req.player as any);
    // terrain analysis over the footprint of the allowed box
    const foot: Box = { min: [ab.min[0], 0, ab.min[2]], max: [ab.max[0], 0, ab.max[2]] };
    const hm = await be.heightmap(foot.min[0], foot.min[2], foot.max[0], foot.max[2], 'surface', job.dimension);
    let hlo = Infinity, hhi = -Infinity;
    for (const h of hm.data) {
      if (h < hlo) hlo = h;
      if (h > hhi) hhi = h;
    }
    const ylo = Math.max(info.minY, hlo - 24);
    const area = (foot.max[0] - foot.min[0] + 1) * (foot.max[2] - foot.min[2] + 1);
    let groundAt: (x: number, z: number) => number;
    let stats: ReturnType<typeof terrainStats> | null = null;
    if (area * (hhi - ylo + 1) <= 6_000_000) {
      const vol = await be.getBlocks({ min: [foot.min[0], ylo, foot.min[2]], max: [foot.max[0], hhi, foot.max[2]] }, job.dimension);
      const cols = analyzeColumns((x, y, z) => (y < ylo || y > hhi ? 'minecraft:air' : volGet(vol, x, y, z)), { min: [foot.min[0], ylo, foot.min[2]], max: [foot.max[0], hhi, foot.max[2]] }, ylo, hhi, reg);
      stats = terrainStats(cols);
      groundAt = (x, z) => cols.ground[(z - cols.z0) * cols.w + (x - cols.x0)] ?? NaN;
    } else {
      groundAt = (x, z) => hm.data[(z - hm.z0) * (hm.x1 - hm.x0 + 1) + (x - hm.x0)] ?? NaN;
    }
    const ay = job.req.anchor[1];
    const anchorGround = groundAt(job.req.anchor[0], job.req.anchor[2]);
    let biome = 'unknown';
    try {
      const b = await be.biomes({ min: [ab.min[0], ay, ab.min[2]], max: [ab.max[0], ay, ab.max[2]] }, 4, job.dimension);
      const counts = new Map<string, number>();
      for (const i of b.data) counts.set(b.palette[i]!, (counts.get(b.palette[i]!) ?? 0) + 1);
      biome = [...counts].sort((a, c) => c[1] - a[1]).slice(0, 3).map(([k, n]) => `${short(k)} ${Math.round((n / b.data.length) * 100)}%`).join(', ');
    } catch {}
    const depth = lb.max[2] - lb.min[2] + 1;
    const suggestedLocal: Vec3 = [0, 0, Math.round(lb.min[2] + depth / 2)];
    const sw = f.toWorld(suggestedLocal);
    const sg = groundAt(sw[0], sw[2]);
    const ctxObj = {
      job: { id: job.id, prompt: job.req.prompt, mode: job.req.options?.mode ?? 'build', style: job.req.options?.style },
      player: {
        name: job.player,
        pos: p?.pos ? fmtV(p.pos) : 'unknown',
        lookingAt: job.req.facing,
        localPos: p?.pos ? fmtV(f.toLocal([Math.floor(p.pos[0]), Math.floor(p.pos[1]), Math.floor(p.pos[2])])) : undefined,
        facingNow: typeof p?.yaw === 'number' ? cardinal(p.yaw) : undefined,
      },
      frame: {
        anchorWorld: fmtV(job.req.anchor),
        facing: job.req.facing,
        localAxes: `local -z (forward) = world ${job.req.facing}; local +x (right) = world ${['east', 'south', 'west', 'north'][f.turns]}`,
      },
      allowedBox: { world: fmtBox(ab), local: fmtBox(lb), fromSelection: !!job.req.selection },
      world: { kind: be.kind, name: info.name, mc: info.mcVersion, registry: reg.version, dimension: job.dimension, minY: info.minY, maxY: info.maxY, seaLevel: info.seaLevel },
      site: {
        biome,
        anchorGroundOffset: Number.isNaN(anchorGround) ? 'unknown' : anchorGround - ay,
        ground: stats
          ? { minOffset: stats.min - ay, maxOffset: stats.max - ay, avgOffset: Math.round((stats.avg - ay) * 10) / 10, waterPct: stats.waterPct, vegetationPct: stats.vegPct, surface: stats.tops.map(([k, n]) => `${short(k)} ${Math.round((n / area) * 100)}%`).join(', ') }
          : { surfaceMinOffset: hlo - ay, surfaceMaxOffset: hhi - ay },
        heightGridLocal: {
          note: 'ground y minus anchor y; rows from far (-z) to near (+z), columns left (-x) to right (+x)',
          rows: localGrid(ctx, groundAt, lb),
        },
      },
      limits: {
        blocksPerCall: env.config.maxBlocksPerCall,
        blocksPerJob: env.config.maxBlocksPerJob,
        usedThisJob: job.blocksChanged,
        budgetUsd: job.req.budgetUsd ?? env.config.budgetUsd,
      },
      suggestedOrigin: {
        local: fmtV(suggestedLocal),
        world: fmtV(sw),
        groundOffset: Number.isNaN(sg) ? 'unknown' : sg - ay,
        note: 'center of the allowed area; front of the building toward +z (the player)',
      },
      time: new Date().toISOString(),
    };
    return JSON.stringify(ctxObj, null, 1);
  },
});

const FALLBACK_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@$&?!;<>(){}[]^~*+=%/|';

/** ASCII layers with ONE legend for all layers ('.' = air). Rows = z ascending, columns = x ascending. */
export function formatLayers(vol: BlockVolume, yFrom: number, yTo: number, maxChars: number): string {
  const charOf = new Map<string, string>();
  const used = new Set<string>(['.', ' ']);
  const pick = (id: string): string => {
    let c = charOf.get(id);
    if (c) return c;
    const name = short(id);
    const words = name.split('_');
    const cands = [words[words.length - 1]![0]!, words[0]![0]!, words[words.length - 1]![0]!.toUpperCase(), words[0]![0]!.toUpperCase()];
    c = cands.find((x) => x && !used.has(x)) ?? [...FALLBACK_CHARS].find((x) => !used.has(x)) ?? '#';
    used.add(c);
    charOf.set(id, c);
    return c;
  };
  const sx = vol.box.max[0] - vol.box.min[0] + 1, sz = vol.box.max[2] - vol.box.min[2] + 1;
  const out: string[] = [];
  let used2 = 0;
  let truncatedAt: number | null = null;
  const idOf = vol.palette.map((st) => (isAir(st) ? '' : blockId(st)));
  for (let y = yFrom; y <= yTo; y++) {
    const off = (y - vol.box.min[1]) * sx * sz;
    const rows: string[] = [];
    let any = false;
    for (let z = 0; z < sz; z++) {
      let r = '';
      for (let x = 0; x < sx; x++) {
        const id = idOf[vol.data[off + z * sx + x]!]!;
        if (!id) r += '.';
        else {
          r += pick(id);
          any = true;
        }
      }
      rows.push(r);
    }
    const block = any ? `y=${y}\n${rows.join('\n')}` : `y=${y} (all air)`;
    if (used2 + block.length > maxChars) {
      truncatedAt = y;
      break;
    }
    used2 += block.length + 1;
    out.push(block);
  }
  const legend = [...charOf].map(([id, c]) => `${c}=${short(id)}`).join('  ');
  let text = out.join('\n') + `\nlegend: ${legend || '(only air)'}`;
  if (truncatedAt !== null) text += `\n[truncated at y=${truncatedAt} — request fewer layers (yFrom/yTo) or a smaller box]`;
  return text;
}

export const scanRegion = defineTool({
  name: 'scan_region',
  title: 'Scan a region',
  readOnly: true,
  description:
    'Read existing blocks in a box. Modes: ' +
    "'summary' (block counts, non-air bounds — cheap, any size up to 2M blocks); " +
    "'layers' (ASCII map per y level; rows = z ascending (local: far→near), columns = x ascending; '.'=air, legend maps chars to blocks; boxes ≤ 64x64 footprint); " +
    "'surface' (top non-air block + height per column, ≤ 64x64); " +
    "'blocks' (explicit list of non-air blocks grouped by state, ≤ 4096 blocks — use for precise detail work); " +
    "'dark' (spots where hostile mobs could spawn: solid floor, 2 high, block light 0 — classified interior (roof + walls) / covered (eaves, canopy) / outdoor; roof-surface spots are skipped; include filters, default interior+covered) — use it to place lights; " +
    "'floating' (small block clusters connected to nothing — junk, cut-off branches, stray blocks; with sizes and positions; leaf blobs within 6 of a log count as canopy). " +
    'Output is capped (maxChars); narrow the box or the y range if truncated. Coordinates in results use the requested space.',
  input: z.object({
    box: BoxIn,
    space: SpaceIn,
    mode: z.enum(['summary', 'layers', 'surface', 'blocks', 'dark', 'floating']).default('summary'),
    include: z.array(z.enum(['interior', 'covered', 'outdoor'])).min(1).default(['interior', 'covered']).describe('dark mode: which spot classes to list'),
    yFrom: z.number().int().optional().describe('layers mode: first y (default box.min.y)'),
    yTo: z.number().int().optional().describe('layers mode: last y (default box.max.y)'),
    maxChars: z.number().int().min(500).max(40000).default(12000),
  }),
  async run(a, ctx) {
    const box = normBoxIn(a.box);
    const n = boxVolume(box);
    if (n > MAX_SCAN_VOLUME) throw new ToolError(`box has ${n.toLocaleString('en')} blocks; scan_region reads at most ${MAX_SCAN_VOLUME.toLocaleString('en')}. Use heightmap for large areas or a smaller box.`);
    const sx = box.max[0] - box.min[0] + 1, sz = box.max[2] - box.min[2] + 1;
    if ((a.mode === 'layers' || a.mode === 'surface') && (sx > 64 || sz > 64)) {
      throw new ToolError(`${a.mode} mode needs a footprint ≤ 64x64 (got ${sx}x${sz}). Use mode 'summary' or split the box.`);
    }
    const reg = ctx.env.registry();
    const { vol } = await readSpaceVolume(ctx, box, a.space);
    const head = `${a.space} box ${fmtBox(box)}`;
    switch (a.mode) {
      case 'summary': {
        const s = summarize(vol, reg);
        const counts = Object.entries(s.counts).filter(([k]) => !isAir(k)).sort((x, y) => y[1] - x[1]);
        const lines = counts.slice(0, 40).map(([k, c]) => `${c}\t${short(k)}`);
        if (counts.length > 40) lines.push(`… ${counts.length - 40} more states`);
        // occupancy per y (non-air count) to show where things are
        const perY: string[] = [];
        const sxz = sx * sz;
        for (let y = box.min[1]; y <= box.max[1]; y++) {
          let c = 0;
          const off = (y - box.min[1]) * sxz;
          for (let i = 0; i < sxz; i++) if (vol.data[off + i] !== 0 && !isAir(vol.palette[vol.data[off + i]!]!)) c++;
          if (c) perY.push(`${y}:${c}`);
        }
        const text = `${head}\nnon-air: ${s.nonAir} of ${n}${s.bounds ? `, non-air bounds ${fmtBox(s.bounds)}` : ''}\nnon-air per y: ${perY.join(' ') || 'none'}\nblocks:\n${lines.join('\n') || '(only air)'}`;
        return text.length > a.maxChars ? text.slice(0, a.maxChars) + '\n[truncated]' : text;
      }
      case 'layers': {
        const y0 = Math.max(box.min[1], a.yFrom ?? box.min[1]);
        const y1 = Math.min(box.max[1], a.yTo ?? box.max[1]);
        return `${head}\nrows: z=${box.min[2]}..${box.max[2]} (top→bottom), cols: x=${box.min[0]}..${box.max[0]} (left→right)\n` + formatLayers(vol, y0, y1, a.maxChars);
      }
      case 'surface': {
        const m = surfaceMap(vol, reg);
        const legend = new Map<string, string>();
        const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&*+=?@';
        const hRows: string[] = [];
        const tRows: string[] = [];
        for (let z = 0; z < m.d; z++) {
          const hs: string[] = [];
          let tr = '';
          for (let x = 0; x < m.w; x++) {
            const i = z * m.w + x;
            const h = m.heights[i]!;
            const top = m.tops[i] ?? '';
            hs.push(h < box.min[1] ? ' --' : String(h).padStart(3));
            if (!top || isAir(top)) {
              tr += '.';
              continue;
            }
            const id = short(blockId(top));
            let c = legend.get(id);
            if (!c) {
              c = chars[legend.size % chars.length]!;
              legend.set(id, c);
            }
            tr += c;
          }
          hRows.push(hs.join(''));
          tRows.push(tr);
        }
        const text = `${head}\nheights (absolute y of top non-air block; rows z=${box.min[2]}..${box.max[2]}, cols x=${box.min[0]}..${box.max[0]}):\n${hRows.join('\n')}\ntop blocks:\n${tRows.join('\n')}\nlegend: ${[...legend].map(([k, c]) => `${c}=${k}`).join(' ')}`;
        return text.length > a.maxChars ? text.slice(0, a.maxChars) + '\n[truncated — use a smaller box]' : text;
      }
      case 'dark': {
        // read with a margin: roofs/walls/lights just outside the box matter
        const ext: Box = { min: [box.min[0] - 8, box.min[1] - 1, box.min[2] - 8], max: [box.max[0] + 8, box.max[1] + 16, box.max[2] + 8] };
        const { vol: xv } = await readSpaceVolume(ctx, boxVolume(ext) <= 6_000_000 ? ext : box, a.space);
        const inBox = ([x, y, z]: Vec3) => x >= box.min[0] && x <= box.max[0] && y >= box.min[1] && y <= box.max[1] && z >= box.min[2] && z <= box.max[2];
        const all = findDarkSpots(xv, reg, { maxResults: 60000 }).filter(inBox);
        const cls = classifyDarkSpots(xv, reg, all);
        const want = new Set<string>(a.include);
        const counts: Record<string, number> = { interior: 0, covered: 0, outdoor: 0, roof: 0 };
        const groups: Record<string, Map<number, string[]>> = { interior: new Map(), covered: new Map(), outdoor: new Map() };
        let listed = 0;
        const order = ['interior', 'covered', 'outdoor'];
        const byClass = order.map((c) => all.filter((_, i) => cls[i] === c));
        all.forEach((_, i) => counts[cls[i]!]!++);
        for (let k = 0; k < order.length; k++) {
          const c = order[k]!;
          if (!want.has(c)) continue;
          for (const [x, y, z] of byClass[k]!) {
            if (listed >= 600) break;
            let l = groups[c]!.get(y);
            if (!l) groups[c]!.set(y, (l = []));
            l.push(`${x},${z}`);
            listed++;
          }
        }
        const total = order.filter((c) => want.has(c)).reduce((n, c) => n + counts[c]!, 0);
        const tally = `interior ${counts.interior}, covered ${counts.covered}, outdoor ${counts.outdoor}, roof-surface ${counts.roof} (skipped)`;
        if (!total) return `${head}\nno dark spawnable spots of class ${a.include.join('/')} — ${tally}. Lights within 8 blocks outside the box are considered.`;
        let text = `${head}\n${total} dark spawnable spots (${tally})${total > listed ? `, first ${listed} listed` : ''}. A torch/lantern makes ~6 blocks around it safe; place lights until nothing interior is listed.\n`;
        for (const c of order) {
          if (!want.has(c) || !groups[c]!.size) continue;
          text += `${c.toUpperCase()}:\n`;
          for (const [y, ps] of [...groups[c]!].sort((p, q) => p[0] - q[0])) text += `  y=${y} (x,z): ${ps.join(' ')}\n`;
        }
        return text.length > a.maxChars ? text.slice(0, a.maxChars) + '\n[truncated]' : text;
      }
      case 'floating': {
        const ext: Box = { min: [box.min[0] - 6, box.min[1] - 4, box.min[2] - 6], max: [box.max[0] + 6, box.max[1] + 2, box.max[2] + 6] };
        const { vol: xv } = await readSpaceVolume(ctx, boxVolume(ext) <= 6_000_000 ? ext : box, a.space);
        const cl = findFloating(xv, reg, { within: box });
        if (!cl.length) return `${head}\nno floating clusters — everything connects to the ground (or reaches past the box)`;
        const big = cl.filter((c) => c.size > 64);
        const small = cl.filter((c) => c.size <= 64);
        const fmtC = (c: (typeof cl)[number]) => `${c.size} × ${short(c.block)} at ${fmtV(c.sample)} (bounds ${fmtV(c.bounds.min)}..${fmtV(c.bounds.max)})`;
        let text = `${head}\n${cl.length} floating cluster(s) (6-connected, touching nothing): ${small.length} small (≤ 64 blocks), ${big.length} large.\n`;
        for (const c of small.slice(0, 60)) text += `  ${fmtC(c)}\n`;
        if (small.length > 60) text += `  … ${small.length - 60} more small clusters\n`;
        if (big.length) text += `large floating masses (intended? e.g. floating island, or support missing):\n${big.slice(-10).map((c) => `  ${fmtC(c)}`).join('\n')}\n`;
        text += `Fix: delete junk with clear (mode all / tree_debris), or connect it (posts, chains, brackets).`;
        return text.length > a.maxChars ? text.slice(0, a.maxChars) + '\n[truncated]' : text;
      }
      case 'blocks': {
        const groups = new Map<string, string[]>();
        let count = 0;
        let i = 0;
        for (let y = box.min[1]; y <= box.max[1]; y++)
          for (let z = box.min[2]; z <= box.max[2]; z++)
            for (let x = box.min[0]; x <= box.max[0]; x++, i++) {
              const s = vol.palette[vol.data[i]!]!;
              if (isAir(s)) continue;
              count++;
              if (count > 4096) continue;
              let g = groups.get(s);
              if (!g) groups.set(s, (g = []));
              g.push(`${x},${y},${z}`);
            }
        let text = `${head}\n${count} non-air blocks${count > 4096 ? ' (showing first 4096 — use a smaller box)' : ''}\n`;
        for (const [s, ps] of groups) text += `${short(s)}: ${ps.join(' ')}\n`;
        return text.length > a.maxChars ? text.slice(0, a.maxChars) + '\n[truncated — use a smaller box]' : text;
      }
    }
  },
});

// camera direction vectors (x,z) where the camera sits relative to the target
const VIEW_DIRS: Record<string, [number, number]> = {
  front: [0, 1], back: [0, -1], left: [-1, 0], right: [1, 0],
  iso_se: [1, 1], iso_sw: [-1, 1], iso_ne: [1, -1], iso_nw: [-1, -1],
};

/** Convert a view named in local space (front = the +z facade) into the renderer's world view. */
export function worldView(view: string, turns: number): string {
  const d = VIEW_DIRS[view];
  if (!d || turns === 0) return view;
  let [x, z] = d;
  for (let t = 0; t < turns; t++) [x, z] = [-z, x];
  for (const [k, v] of Object.entries(VIEW_DIRS)) if (v[0] === x && v[1] === z) return k;
  return view;
}

/**
 * World box of this job's built blocks (26-connected components) that the requested box cuts through,
 * grown sideways and downward only (cutting off what is above keeps interiors visible). Null if nothing.
 */
export function renderExpansion(ctx: ToolCtx, wbox: Box, maxExtra = 24): Box | null {
  const ids = new Set(ctx.job.undoIds);
  const recs = ctx.env.history.list(ctx.job.player).filter((r) => ids.has(r.id));
  if (!recs.length) return null;
  const built = builtMask(recs.map((r) => r.after));
  if (!built.size) return null;
  const limit: Box = { min: [-Infinity, -Infinity, -Infinity] as unknown as Vec3, max: [Infinity, wbox.max[1], Infinity] as unknown as Vec3 };
  return expandToComponents(wbox, built, { maxExtra, limit });
}

const ViewIn = z.enum(['iso_ne', 'iso_nw', 'iso_se', 'iso_sw', 'front', 'back', 'left', 'right', 'top']);

export const renderView = defineTool({
  name: 'render_view',
  title: 'Render a view (PNG)',
  readOnly: true,
  description:
    'SEE the world: renders a box to a PNG image (textured software renderer, daylight, soft shadows). ' +
    "Views: iso_se/iso_sw/iso_ne/iso_nw (isometric from that corner), front/back/left/right (elevations), top (plan). " +
    "With space:'local' (default) views are relative to the build: 'front' looks at the +z facade (what the player sees), 'iso_se' = front-right corner. " +
    'Pass up to 4 views for a contact sheet (one image each). Default box = everything you built so far in this job (+ margin), else the allowed box. ' +
    'Terrain cut by the render box is drawn as a flat grey section (not part of the world); elevations cut away natural terrain in front of the box. ' +
    'Use it after each major step to check proportions, gaps and style; ~1k tokens per 800x600 image.',
  input: z.object({
    box: BoxIn.optional().describe('region to render (default: your edits so far)'),
    space: SpaceIn,
    views: z.array(ViewIn).min(1).max(4).default(['iso_se']),
    width: z.number().int().min(128).max(1600).default(800),
    height: z.number().int().min(128).max(1200).default(600),
    time: z.enum(['day', 'sunset', 'night']).default('day'),
    zoom: z.number().min(0.25).max(8).optional(),
    highlight: BoxIn.optional().describe('box to outline in the image (same space)'),
    margin: z.number().int().min(0).max(32).default(4).describe('extra blocks of surroundings around the box'),
    expand: z.boolean().default(true).describe('also load whole parts of your build that the box cuts through (sideways/down, ≤24 blocks; camera still frames box)'),
  }),
  async run(a, ctx) {
    const { job, env } = ctx;
    let wbox: Box;
    let grown: Box | null = null;
    if (a.box) {
      wbox = toWorldBox(ctx, normBoxIn(a.box), a.space);
      if (a.expand) grown = renderExpansion(ctx, wbox);
    } else {
      // default: what this job built so far (else the whole allowed box)
      const eb = jobEditBounds(ctx);
      wbox = eb ? (boxIntersect(eb, job.allowedBox) ?? eb) : job.allowedBox;
    }
    const m = a.margin;
    const info = await env.backend().info();
    let rbox: Box = { min: [wbox.min[0] - m, Math.max(info.minY, wbox.min[1] - Math.max(2, Math.floor(m / 2))), wbox.min[2] - m], max: [wbox.max[0] + m, Math.min(info.maxY, wbox.max[1] + 2), wbox.max[2] + m] };
    if (grown) {
      const big: Box = { min: [Math.min(rbox.min[0], grown.min[0] - 1), Math.max(info.minY, Math.min(rbox.min[1], grown.min[1] - 1)), Math.min(rbox.min[2], grown.min[2] - 1)], max: [Math.max(rbox.max[0], grown.max[0] + 1), rbox.max[1], Math.max(rbox.max[2], grown.max[2] + 1)] };
      if (boxVolume(big) <= MAX_RENDER_VOLUME) rbox = big;
      else grown = null;
    }
    if (boxVolume(rbox) > MAX_RENDER_VOLUME) throw new ToolError(`render box ${fmtBox(rbox)} is too large (max ${MAX_RENDER_VOLUME.toLocaleString('en')} blocks). Pass a smaller box.`);
    const vol = await env.backend().getBlocks(rbox, job.dimension);
    const assets = await env.assets();
    const turns = a.space === 'local' ? frameOf(ctx).turns : 0;
    const images: { data: string; mimeType: string }[] = [];
    for (const view of a.views) {
      const opts: RenderOptions = {
        width: a.width,
        height: a.height,
        view: (view === 'top' ? 'top' : worldView(view, turns)) as RenderOptions['view'],
        time: a.time,
        focus: wbox,
        shadows: true,
        ...(a.zoom ? { zoom: a.zoom } : {}),
        ...(a.highlight ? { highlight: toWorldBox(ctx, normBoxIn(a.highlight), a.space) } : {}),
      };
      if (view === 'top' && turns) opts.yaw = turns * 90;
      const png = await renderVolume(vol, assets, opts);
      images.push({ data: png.toString('base64'), mimeType: 'image/png' });
    }
    if (job.state === 'building') env.jobs.update(job, { state: 'reviewing' });
    const grew = grown && (grown.min.some((v, i) => v < wbox.min[i]!) || grown.max.some((v, i) => v > wbox.max[i]!));
    return { text: `rendered ${a.views.join(', ')} of world ${fmtBox(wbox)}${grew ? ` (+ connected build parts up to ${fmtBox(grown!)})` : ''}${assets ? '' : ' (flat colors: textures unavailable)'}`, images };
  },
});

export const findBlocks = defineTool({
  name: 'find_blocks',
  title: 'Find block ids',
  readOnly: true,
  description:
    'Search the block registry of the connected world (all vanilla 26.3 blocks) by words, e.g. "dark oak stairs", "lantern", "copper", "glass pane". ' +
    "Optional tag filter like 'minecraft:stairs', 'minecraft:logs', 'minecraft:flowers'. Returns ids with their property names. Use block_info for allowed values.",
  input: z.object({
    query: z.string().min(1).max(80),
    tag: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(30),
  }),
  async run(a, ctx) {
    const reg = ctx.env.registry();
    const ids = reg.search(a.query, { tag: a.tag, limit: a.limit });
    if (!ids.length) return `no blocks match "${a.query}"${a.tag ? ` with tag ${a.tag}` : ''}. Try fewer/other words.`;
    return ids
      .map((id) => {
        const info = reg.info(id);
        const props = info ? Object.keys(info.properties) : [];
        return `${short(id)}${props.length ? ` [${props.join(',')}]` : ''}`;
      })
      .join('\n');
  },
});

export const blockInfo = defineTool({
  name: 'block_info',
  title: 'Block properties',
  readOnly: true,
  description:
    'Details for one block id or state: all properties with allowed values and defaults, tags, whether it is a full solid cube / transparent, ' +
    'and the canonical form of the given state (validates your state string; errors list valid values).',
  input: z.object({ block: z.string().min(1).max(300).describe("e.g. 'oak_stairs' or 'oak_stairs[facing=east,half=top]'") }),
  async run(a, ctx) {
    const reg = ctx.env.registry();
    const id = blockId(a.block);
    const info = reg.info(id);
    if (!info) {
      const sug = reg.search(id.replace(/^minecraft:/, '').replace(/_/g, ' '), { limit: 8 });
      throw new ToolError(`unknown block '${a.block}'.${sug.length ? ` Did you mean: ${sug.map(short).join(', ')}?` : ''}`);
    }
    const c = reg.tryCanonical(a.block);
    const props = Object.entries(info.properties).map(([k, vals]) => `  ${k}: ${vals.join('|')} (default ${info.default[k]})`);
    return [
      `${id}`,
      `canonical: ${c.ok ? c.state : `INVALID — ${c.error}`}`,
      props.length ? `properties:\n${props.join('\n')}` : 'properties: none',
      `full solid cube: ${reg.isFullSolid(c.ok ? c.state : id)}, transparent: ${reg.isTransparent(c.ok ? c.state : id)}`,
      info.tags?.length ? `tags: ${info.tags.map(short).join(', ')}` : '',
    ].filter(Boolean).join('\n');
  },
});

export const heightmapTool = defineTool({
  name: 'heightmap',
  title: 'Terrain heightmap',
  readOnly: true,
  description:
    'Ground/surface heights for an x/z area (box y is ignored). kind: ' +
    "'ground' (top solid terrain block, ignores trees/plants/water — best for foundations), 'surface' (top non-air incl. trees & water), 'ocean_floor'. " +
    'Returns rows of heights relative to `base` (printed) — rows = z ascending (local: far→near), columns = x ascending. ' +
    'Max 128x128 columns; use step>1 to sample larger areas.',
  input: z.object({
    box: BoxIn,
    space: SpaceIn,
    kind: z.enum(['ground', 'surface', 'ocean_floor']).default('ground'),
    step: z.number().int().min(1).max(16).default(1),
  }),
  async run(a, ctx) {
    const { job, env } = ctx;
    const be = env.backend();
    const reg = env.registry();
    const lbox = normBoxIn(a.box);
    const wbox = toWorldBox(ctx, { min: [lbox.min[0], 0, lbox.min[2]], max: [lbox.max[0], 0, lbox.max[2]] }, a.space);
    const sx = Math.ceil((lbox.max[0] - lbox.min[0] + 1) / a.step), sz = Math.ceil((lbox.max[2] - lbox.min[2] + 1) / a.step);
    if (sx > 128 || sz > 128) throw new ToolError(`area gives ${sx}x${sz} samples (max 128x128). Increase step or shrink the box.`);
    const hm = await be.heightmap(wbox.min[0], wbox.min[2], wbox.max[0], wbox.max[2], a.kind === 'ocean_floor' ? 'ocean_floor' : 'surface', job.dimension);
    const hw = hm.x1 - hm.x0 + 1;
    let ground: ((x: number, z: number) => number) = (x, z) => hm.data[(z - hm.z0) * hw + (x - hm.x0)]!;
    if (a.kind === 'ground') {
      let lo = Infinity, hi = -Infinity;
      for (const h of hm.data) {
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
      const info = await be.info();
      const ylo = Math.max(info.minY, lo - 32);
      const area = hw * (hm.z1 - hm.z0 + 1);
      if (area * (hi - ylo + 1) <= 8_000_000) {
        const fb: Box = { min: [hm.x0, ylo, hm.z0], max: [hm.x1, hi, hm.z1] };
        const vol = await be.getBlocks(fb, job.dimension);
        const cols = analyzeColumns((x, y, z) => volGet(vol, x, y, z), fb, ylo, hi, reg);
        ground = (x, z) => cols.ground[(z - cols.z0) * cols.w + (x - cols.x0)]!;
      }
    }
    const f = a.space === 'local' ? frameOf(ctx) : null;
    const vals: number[][] = [];
    let base = Infinity;
    for (let z = lbox.min[2]; z <= lbox.max[2]; z += a.step) {
      const row: number[] = [];
      for (let x = lbox.min[0]; x <= lbox.max[0]; x += a.step) {
        const w = f ? f.toWorld([x, 0, z]) : [x, 0, z];
        const h = ground(w[0]!, w[2]!);
        row.push(h);
        if (!Number.isNaN(h)) base = Math.min(base, h);
      }
      vals.push(row);
    }
    if (!Number.isFinite(base)) base = 0;
    const rows = vals.map((r, i) => `z=${lbox.min[2] + i * a.step}: ${r.map((h) => (Number.isNaN(h) ? '?' : String(h - base))).join(' ')}`);
    const anchorOff = a.space === 'local' ? ` (base-anchorY = ${base - job.req.anchor[1]})` : '';
    return `${a.kind} heights, ${a.space} x=${lbox.min[0]}..${lbox.max[0]} step ${a.step}; base y=${base}${anchorOff}; value = y - base\n${rows.join('\n')}`;
  },
});

export const perceptionTools: ToolDef[] = [getContext, scanRegion, renderView, findBlocks, blockInfo, heightmapTool];
