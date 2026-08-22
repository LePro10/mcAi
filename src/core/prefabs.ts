/**
 * Parametric prefabs.
 *
 * Two jobs. First, `!build castle` should produce a real castle instantly with
 * zero model tokens — most requests are for things people ask for constantly.
 * Second, these are the few-shot examples in the system prompt: the model learns
 * the DSL by reading buildings that already work, which is far cheaper and more
 * reliable than a prose spec of every op.
 *
 * Convention: `[0,0,0]` is the min corner at ground level. y=0 is the floor,
 * y<0 is foundation, structures rise from y=1.
 */

import type { Blueprint, Part, Vec3 } from './types.js';

type Params = Record<string, unknown>;

const num = (p: Params, key: string, def: number, min = 1, max = 512): number => {
  const v = Number(p[key]);
  return Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : def;
};

const str = (p: Params, key: string, def: string): string =>
  typeof p[key] === 'string' && p[key] ? String(p[key]) : def;

export interface PrefabDef {
  name: string;
  /** One line, shown to the model and in `mcai list`. */
  summary: string;
  /** Tunable parameters with their defaults. */
  params: Record<string, number | string>;
  build(p: Params): Blueprint;
}

// ── Shared pieces ─────────────────────────────────────────────────────────

/** Foundation pad plus floor, the opening of nearly every building. */
function pad(w: number, d: number, at: Vec3 = [0, 0, 0]): Part[] {
  return [
    { op: 'foundation', at, size: [w, d], depth: 4, block: '@base' },
    { op: 'box', at: [at[0], at[1], at[2]], size: [w, 1, d], block: '@floor' },
  ];
}

/** A round tower with a conical cap — the castle silhouette in one helper. */
function roundTower(at: Vec3, r: number, h: number, cap: 'cone' | 'battlement' = 'cone'): Part[] {
  const d = r * 2 + 1;
  const parts: Part[] = [
    { op: 'cylinder', at, r, h, block: '@wall', hollow: true, thickness: 1 },
    { op: 'cylinder', at: [at[0], at[1], at[2]], r: r - 1, h: 1, block: '@floor' },
  ];
  if (cap === 'cone') {
    parts.push(
      { op: 'cylinder', at: [at[0] - 1, at[1] + h, at[2] - 1], r: r + 1, h: 1, block: '@trim' },
      { op: 'cone', at: [at[0] - 1, at[1] + h + 1, at[2] - 1], r: r + 1, h: r + 3, block: '@roof' },
    );
  } else {
    parts.push(
      { op: 'cylinder', at: [at[0] - 1, at[1] + h, at[2] - 1], r: r + 1, h: 1, block: '@trim' },
      { op: 'battlements', at: [at[0] - 1, at[1] + h + 1, at[2] - 1], size: [d + 2, 2, d + 2], height: 2, width: 1, gap: 1, block: '@wall' },
    );
  }
  // Arrow slits, every other level.
  parts.push({
    op: 'repeat', count: Math.max(1, Math.floor((h - 3) / 3)), step: [0, 3, 0],
    of: [
      { op: 'set', at: [at[0], at[1] + 3, at[2] + r], block: 'air' },
      { op: 'set', at: [at[0] + d - 1, at[1] + 3, at[2] + r], block: 'air' },
      { op: 'set', at: [at[0] + r, at[1] + 3, at[2]], block: 'air' },
      { op: 'set', at: [at[0] + r, at[1] + 3, at[2] + d - 1], block: 'air' },
    ],
  });
  return parts;
}

// ── Prefabs ───────────────────────────────────────────────────────────────

export const PREFABS: Record<string, PrefabDef> = {
  cottage: {
    name: 'cottage',
    summary: 'Small one-room home with a gable roof, windows, door and furnished interior.',
    params: { w: 9, d: 11, h: 5 },
    build: (p) => {
      const w = num(p, 'w', 9, 5, 40), d = num(p, 'd', 11, 5, 40), h = num(p, 'h', 5, 3, 12);
      return {
        name: 'cottage',
        parts: [
          ...pad(w, d),
          { op: 'walls', at: [0, 1, 0], size: [w, h, d], block: '@wall', thickness: 1 },
          // Corner posts read as timber framing.
          { op: 'frame', at: [0, 1, 0], size: [w, h, d], thickness: 1, block: '@trim', mode: 'keep' },
          { op: 'windows', at: [0, 1, 0], size: [w, h, d], win: [1, 2], spacing: 3, glass: '@glass' },
          { op: 'door', at: [Math.floor(w / 2), 1, d - 1], facing: 'south', door: '@door' },
          { op: 'roof', at: [0, 1 + h, 0], size: [w, 1, d], kind: 'gable', axis: 'z', pitch: 1, overhang: 1, block: '@roof_stairs', gableBlock: '@wall', ridge: '@roof' },
          { op: 'set', at: [1, 1, 1], block: 'crafting_table' },
          { op: 'set', at: [2, 1, 1], block: 'furnace' },
          { op: 'set', at: [w - 2, 1, 1], block: 'chest' },
          { op: 'set', at: [1, 1, d - 2], block: 'red_bed' },
          { op: 'set', at: [Math.floor(w / 2), h, Math.floor(d / 2)], block: '@light' },
          { op: 'scatter', at: [-2, 1, d], size: [w + 4, 1, 3], density: 0.25, block: '@detail' },
        ],
      };
    },
  },

  house: {
    name: 'house',
    summary: 'Two-storey house with a floor divider, staircase gap, balcony and hip roof.',
    params: { w: 11, d: 13, h: 4, floors: 2 },
    build: (p) => {
      const w = num(p, 'w', 11, 6, 40), d = num(p, 'd', 13, 6, 40);
      const h = num(p, 'h', 4, 3, 8), floors = num(p, 'floors', 2, 1, 6);
      const parts: Part[] = [...pad(w, d)];
      const total = h * floors;
      parts.push(
        { op: 'walls', at: [0, 1, 0], size: [w, total, d], block: '@wall', thickness: 1 },
        { op: 'frame', at: [0, 1, 0], size: [w, total, d], thickness: 1, block: '@trim', mode: 'keep' },
      );
      for (let f = 1; f < floors; f++) {
        parts.push(
          { op: 'box', at: [1, f * h, 1], size: [w - 2, 1, d - 2], block: '@floor' },
          // Stair well.
          { op: 'clear', at: [1, f * h, 1], size: [2, 1, 3] },
          { op: 'spiral', at: [1, (f - 1) * h + 1, 1], r: 1, h, turn: 8, stairs: '@roof_stairs' },
        );
      }
      parts.push(
        { op: 'windows', at: [0, 1, 0], size: [w, total, d], win: [2, 2], spacing: 4, glass: '@glass' },
        { op: 'door', at: [Math.floor(w / 2), 1, d - 1], facing: 'south', door: '@door' },
        { op: 'roof', at: [0, 1 + total, 0], size: [w, 1, d], kind: 'hip', pitch: 1, overhang: 1, block: '@roof', stairs: '@roof_stairs' },
        { op: 'set', at: [1, 1, 1], block: 'crafting_table' },
        { op: 'set', at: [w - 2, 1, 1], block: 'chest' },
        { op: 'repeat', count: floors, step: [0, h, 0], of: [{ op: 'set', at: [Math.floor(w / 2), h - 1, Math.floor(d / 2)], block: '@light' }] },
      );
      return { name: 'house', parts };
    },
  },

  tower: {
    name: 'tower',
    summary: 'Round tower with an internal spiral stair, arrow slits and a conical roof.',
    params: { r: 4, h: 20, cap: 'cone' },
    build: (p) => {
      const r = num(p, 'r', 4, 2, 20), h = num(p, 'h', 20, 5, 120);
      const cap = str(p, 'cap', 'cone') === 'battlement' ? 'battlement' : 'cone';
      const d = r * 2 + 1;
      return {
        name: 'tower',
        parts: [
          { op: 'foundation', at: [0, 0, 0], size: [d, d], depth: 4, block: '@base' },
          ...roundTower([0, 0, 0], r, h, cap),
          { op: 'spiral', at: [1, 1, 1], r: r - 1, h: h - 2, turn: 10, stairs: '@roof_stairs' },
          { op: 'door', at: [r, 1, 0], facing: 'north', door: '@door' },
          { op: 'repeat', count: Math.max(1, Math.floor(h / 5)), step: [0, 5, 0], of: [{ op: 'set', at: [r, 4, r], block: '@light' }] },
        ],
      };
    },
  },

  castle: {
    name: 'castle',
    summary: 'Curtain walls with battlements, four corner towers, a gatehouse and a central keep.',
    params: { size: 41, wallH: 10, towerH: 18 },
    build: (p) => {
      const size = Math.max(21, num(p, 'size', 41, 21, 160) | 1);
      const wallH = num(p, 'wallH', 10, 5, 40);
      const towerH = num(p, 'towerH', 18, wallH + 2, 60);
      const tr = 4, td = tr * 2 + 1;
      const mid = Math.floor(size / 2);
      const keepW = Math.max(9, Math.floor(size / 3) | 1);
      const keepH = Math.max(8, Math.floor(wallH * 1.4));
      const k0 = mid - Math.floor(keepW / 2);

      const parts: Part[] = [
        { op: 'foundation', at: [0, 0, 0], size: [size, size], depth: 5, block: '@base' },
        { op: 'box', at: [0, 0, 0], size: [size, 1, size], block: '@path' },
        // Curtain wall: a thick shell with a walkway and crenellations on top.
        { op: 'walls', at: [0, 1, 0], size: [size, wallH, size], block: '@wall', thickness: 2 },
        { op: 'battlements', at: [0, 1 + wallH, 0], size: [size, 2, size], height: 2, width: 2, gap: 2, block: '@wall' },
        { op: 'walls', at: [1, 1 + wallH, 1], size: [size - 2, 1, size - 2], block: '@floor', thickness: 1 },
      ];

      // Corner towers, placed by mirroring one definition into all four corners.
      parts.push({
        op: 'symmetry', axis: 'xz', about: mid,
        of: roundTower([-2, 0, -2], tr, towerH, 'battlement'),
      });

      // Gatehouse on the south face.
      parts.push(
        { op: 'box', at: [mid - 5, 1, size - 4], size: [11, wallH + 4, 5], block: '@wall' },
        { op: 'arch', at: [mid - 2, 1, size - 4], span: 5, h: 7, depth: 5, axis: 'x', cut: true },
        { op: 'battlements', at: [mid - 5, 1 + wallH + 4, size - 4], size: [11, 2, 5], height: 2, width: 1, gap: 1, block: '@wall' },
        { op: 'box', at: [mid - 1, 1, size - 1], size: [3, 5, 1], block: 'air' },
        { op: 'set', at: [mid - 3, 5, size - 5], block: '@light' },
        { op: 'set', at: [mid + 3, 5, size - 5], block: '@light' },
      );

      // Central keep with a hip roof and its own small towers.
      parts.push(
        { op: 'box', at: [k0, 0, k0], size: [keepW, 1, keepW], block: '@floor' },
        { op: 'walls', at: [k0, 1, k0], size: [keepW, keepH, keepW], block: '@wall', thickness: 1 },
        { op: 'frame', at: [k0, 1, k0], size: [keepW, keepH, keepW], thickness: 1, block: '@pillar', mode: 'keep' },
        { op: 'windows', at: [k0, 1, k0], size: [keepW, keepH, keepW], win: [1, 2], spacing: 3, glass: '@glass' },
        { op: 'door', at: [mid, 1, k0 + keepW - 1], facing: 'south', door: '@door' },
        { op: 'roof', at: [k0, 1 + keepH, k0], size: [keepW, 1, keepW], kind: 'hip', pitch: 1, overhang: 1, block: '@roof', stairs: '@roof_stairs' },
        { op: 'spiral', at: [k0 + 1, 1, k0 + 1], r: 2, h: keepH - 1, turn: 10, stairs: '@roof_stairs' },
      );

      // Courtyard: a path from the gate to the keep, and torches along the wall.
      parts.push(
        { op: 'box', at: [mid - 1, 0, k0 + keepW], size: [3, 1, size - 4 - (k0 + keepW)], block: '@path' },
        { op: 'repeat', count: Math.max(2, Math.floor((size - 8) / 8)), step: [8, 0, 0], of: [{ op: 'set', at: [4, wallH, 3], block: '@light' }] },
      );

      return { name: 'castle', palette: 'medieval', parts };
    },
  },

  keep: {
    name: 'keep',
    summary: 'Square fortified keep: thick walls, corner turrets, battlements, no outer wall.',
    params: { w: 17, h: 16 },
    build: (p) => {
      const w = num(p, 'w', 17, 9, 60), h = num(p, 'h', 16, 6, 60);
      return {
        name: 'keep',
        parts: [
          { op: 'foundation', at: [0, 0, 0], size: [w, w], depth: 5, block: '@base' },
          { op: 'box', at: [0, 0, 0], size: [w, 1, w], block: '@floor' },
          { op: 'walls', at: [0, 1, 0], size: [w, h, w], block: '@wall', thickness: 2 },
          { op: 'windows', at: [0, 1, 0], size: [w, h, w], win: [1, 3], spacing: 4, glass: '@glass' },
          { op: 'door', at: [Math.floor(w / 2), 1, w - 1], facing: 'south', width: 2, door: '@door' },
          { op: 'battlements', at: [0, 1 + h, 0], size: [w, 2, w], height: 2, width: 2, gap: 2, block: '@wall' },
          { op: 'symmetry', axis: 'xz', about: Math.floor(w / 2), of: [{ op: 'box', at: [-1, 1, -1], size: [4, h + 5, 4], block: '@pillar' }] },
          { op: 'spiral', at: [2, 1, 2], r: 2, h: h - 1, turn: 10, stairs: '@roof_stairs' },
          { op: 'repeat', count: Math.max(1, Math.floor(h / 5)), step: [0, 5, 0], of: [{ op: 'set', at: [Math.floor(w / 2), 4, Math.floor(w / 2)], block: '@light' }] },
        ],
      };
    },
  },

  lighthouse: {
    name: 'lighthouse',
    summary: 'Tapered tower with a glass lantern room and a light beacon on top.',
    params: { r: 5, h: 26 },
    build: (p) => {
      const r = num(p, 'r', 5, 3, 16), h = num(p, 'h', 26, 10, 90);
      const d = r * 2 + 1;
      const parts: Part[] = [
        { op: 'foundation', at: [0, 0, 0], size: [d + 4, d + 4], depth: 5, block: '@base' },
        { op: 'cylinder', at: [-2, 0, -2], r: r + 2, h: 1, block: '@base' },
      ];
      // Taper: stack shrinking cylinders instead of one shape, so the profile
      // stays readable at any height.
      const bands = Math.max(2, Math.floor(h / 5));
      for (let i = 0; i < bands; i++) {
        const rr = Math.max(2, r - Math.floor((i * (r - 2)) / bands));
        const off = r - rr;
        parts.push({
          op: 'cylinder', at: [off, 1 + i * 5, off], r: rr, h: 5,
          block: i % 2 === 0 ? '@wall' : '@accent', hollow: true, thickness: 1,
        });
      }
      const topY = 1 + bands * 5;
      parts.push(
        { op: 'cylinder', at: [0, topY, 0], r: r - 1, h: 1, block: '@trim' },
        { op: 'cylinder', at: [1, topY + 1, 1], r: r - 2, h: 4, block: '@glass', hollow: true, thickness: 1 },
        { op: 'box', at: [r - 1, topY + 2, r - 1], size: [3, 1, 3], block: 'sea_lantern' },
        { op: 'cone', at: [0, topY + 5, 0], r: r - 1, h: r, block: '@roof' },
        { op: 'spiral', at: [1, 1, 1], r: r - 2, h: topY - 1, turn: 12, stairs: '@roof_stairs' },
        { op: 'door', at: [r, 1, 0], facing: 'north', door: '@door' },
      );
      return { name: 'lighthouse', parts };
    },
  },

  bridge: {
    name: 'bridge',
    summary: 'Arched stone bridge with railings and lamp posts. Set `len` along +X.',
    params: { len: 31, w: 5, rise: 4 },
    build: (p) => {
      const len = num(p, 'len', 31, 7, 200), w = num(p, 'w', 5, 3, 20), rise = num(p, 'rise', 4, 1, 20);
      const parts: Part[] = [];
      const piers = Math.max(2, Math.round(len / 12));
      for (let i = 0; i < len; i++) {
        // Deck follows a shallow arc so the bridge is walkable end to end.
        const t = (i / (len - 1)) * 2 - 1;
        const y = Math.round(rise * (1 - t * t));
        parts.push({ op: 'box', at: [i, y, 0], size: [1, 1, w], block: '@path' });
        parts.push({ op: 'set', at: [i, y + 1, 0], block: '@fence' });
        parts.push({ op: 'set', at: [i, y + 1, w - 1], block: '@fence' });
        for (let yy = y - 1; yy > y - 3; yy--) {
          parts.push({ op: 'box', at: [i, yy, 0], size: [1, 1, w], block: '@wall', mode: 'keep' });
        }
      }
      for (let s = 0; s < piers; s++) {
        const x = Math.round(((s + 0.5) / piers) * (len - 1));
        const t = (x / (len - 1)) * 2 - 1;
        const y = Math.round(rise * (1 - t * t));
        parts.push({ op: 'box', at: [x - 1, y - 12, 0], size: [3, 12, w], block: '@wall' });
        parts.push({ op: 'set', at: [x, y + 2, 0], block: '@light' });
        parts.push({ op: 'set', at: [x, y + 2, w - 1], block: '@light' });
      }
      return { name: 'bridge', parts };
    },
  },

  windmill: {
    name: 'windmill',
    summary: 'Round stone mill with a cone roof and four sails on the south face.',
    params: { r: 5, h: 14 },
    build: (p) => {
      const r = num(p, 'r', 5, 3, 14), h = num(p, 'h', 14, 8, 40);
      const d = r * 2 + 1;
      const cy = 1 + h - 3;
      return {
        name: 'windmill',
        parts: [
          { op: 'foundation', at: [0, 0, 0], size: [d, d], depth: 4, block: '@base' },
          { op: 'cylinder', at: [0, 0, 0], r, h: 1, block: '@floor' },
          { op: 'cylinder', at: [0, 1, 0], r, h, block: '@wall', hollow: true, thickness: 1 },
          { op: 'cylinder', at: [-1, 1 + h, -1], r: r + 1, h: 1, block: '@trim' },
          { op: 'cone', at: [-1, 2 + h, -1], r: r + 1, h: r + 2, block: '@roof' },
          { op: 'door', at: [r, 1, d - 1], facing: 'south', door: '@door' },
          { op: 'windows', at: [0, 1, 0], size: [d, h, d], win: [1, 2], spacing: 4, glass: '@glass' },
          // Sails: two crossed beams on the south face.
          { op: 'line', from: [r, cy - r, -1], to: [r, cy + r, -1], block: '@trim' },
          { op: 'line', from: [r - r, cy, -1], to: [r + r, cy, -1], block: '@trim' },
          { op: 'line', from: [r - r + 1, cy - r + 1, -1], to: [r + r - 1, cy + r - 1, -1], block: '@accent' },
          { op: 'line', from: [r - r + 1, cy + r - 1, -1], to: [r + r - 1, cy - r + 1, -1], block: '@accent' },
          { op: 'spiral', at: [1, 1, 1], r: r - 2, h: h - 2, turn: 10, stairs: '@roof_stairs' },
        ],
      };
    },
  },

  temple: {
    name: 'temple',
    summary: 'Colonnaded temple on a stepped platform with a pitched roof.',
    params: { w: 15, d: 23, h: 7 },
    build: (p) => {
      const w = num(p, 'w', 15, 9, 60), d = num(p, 'd', 23, 11, 80), h = num(p, 'h', 7, 5, 20);
      const steps = 3;
      const parts: Part[] = [
        { op: 'foundation', at: [-steps, 0, -steps], size: [w + steps * 2, d + steps * 2], depth: 5, block: '@base' },
      ];
      for (let s = 0; s < steps; s++) {
        parts.push({ op: 'box', at: [-s, s - steps + 1, -s], size: [w + s * 2, 1, d + s * 2], block: '@base' });
      }
      parts.push(
        { op: 'box', at: [0, 1, 0], size: [w, 1, d], block: '@floor' },
        // Colonnade around the cella.
        { op: 'repeat', count: Math.floor((w - 1) / 3) + 1, step: [3, 0, 0], of: [
          { op: 'box', at: [0, 1, 0], size: [1, h, 1], block: '@pillar' },
          { op: 'box', at: [0, 1, d - 1], size: [1, h, 1], block: '@pillar' },
        ] },
        { op: 'repeat', count: Math.floor((d - 1) / 3) + 1, step: [0, 0, 3], of: [
          { op: 'box', at: [0, 1, 0], size: [1, h, 1], block: '@pillar' },
          { op: 'box', at: [w - 1, 1, 0], size: [1, h, 1], block: '@pillar' },
        ] },
        { op: 'walls', at: [2, 1, 3], size: [w - 4, h, d - 6], block: '@wall', thickness: 1 },
        { op: 'door', at: [Math.floor(w / 2), 1, d - 4], facing: 'south', width: 2, height: 3, door: '@door' },
        { op: 'box', at: [0, 1 + h, 0], size: [w, 1, d], block: '@trim' },
        { op: 'roof', at: [0, 2 + h, 0], size: [w, 1, d], kind: 'gable', axis: 'z', pitch: 0.5, overhang: 1, block: '@roof', stairs: '@roof_stairs', gableBlock: '@accent' },
        { op: 'repeat', count: 4, step: [0, 0, Math.max(3, Math.floor(d / 4))], of: [
          { op: 'set', at: [1, h, 2], block: '@light' },
          { op: 'set', at: [w - 2, h, 2], block: '@light' },
        ] },
      );
      return { name: 'temple', parts };
    },
  },

  wall: {
    name: 'wall',
    summary: 'Fortified wall segment with a walkway and battlements. Runs along +X.',
    params: { len: 31, h: 8, thickness: 3 },
    build: (p) => {
      const len = num(p, 'len', 31, 5, 400), h = num(p, 'h', 8, 4, 40), t = num(p, 'thickness', 3, 1, 10);
      return {
        name: 'wall',
        parts: [
          { op: 'foundation', at: [0, 0, 0], size: [len, t], depth: 4, block: '@base' },
          { op: 'box', at: [0, 0, 0], size: [len, h, t], block: '@wall' },
          { op: 'box', at: [0, h, 0], size: [len, 1, t], block: '@path' },
          { op: 'battlements', at: [0, h + 1, 0], size: [len, 2, t], height: 2, width: 2, gap: 2, block: '@wall' },
          { op: 'repeat', count: Math.max(1, Math.floor(len / 8)), step: [8, 0, 0], of: [{ op: 'set', at: [2, h + 1, 1], block: '@light' }] },
        ],
      };
    },
  },

  well: {
    name: 'well',
    summary: 'Village well with a roof on posts and a water shaft.',
    params: { r: 2 },
    build: (p) => {
      const r = num(p, 'r', 2, 1, 6);
      const d = r * 2 + 1;
      return {
        name: 'well',
        parts: [
          { op: 'cylinder', at: [0, 0, 0], r: r + 1, h: 1, block: '@path' },
          { op: 'cylinder', at: [0, 1, 0], r, h: 2, block: '@wall', hollow: true, thickness: 1 },
          { op: 'box', at: [1, 0, 1], size: [d - 2, 1, d - 2], block: 'water' },
          { op: 'symmetry', axis: 'xz', about: r, of: [{ op: 'box', at: [0, 3, 0], size: [1, 3, 1], block: '@trim' }] },
          { op: 'roof', at: [0, 6, 0], size: [d, 1, d], kind: 'hip', pitch: 1, overhang: 1, block: '@roof', stairs: '@roof_stairs' },
          { op: 'set', at: [r, 5, r], block: '@light' },
        ],
      };
    },
  },

  gazebo: {
    name: 'gazebo',
    summary: 'Open octagonal pavilion with railings and a pointed roof.',
    params: { r: 4 },
    build: (p) => {
      const r = num(p, 'r', 4, 2, 12);
      const d = r * 2 + 1;
      return {
        name: 'gazebo',
        parts: [
          { op: 'foundation', at: [0, 0, 0], size: [d, d], depth: 3, block: '@base' },
          { op: 'cylinder', at: [0, 0, 0], r, h: 1, block: '@floor' },
          { op: 'cylinder', at: [0, 1, 0], r, h: 1, block: '@fence', hollow: true, thickness: 1 },
          { op: 'symmetry', axis: 'xz', about: r, of: [{ op: 'box', at: [0, 1, 0], size: [1, 4, 1], block: '@pillar' }] },
          { op: 'cylinder', at: [0, 5, 0], r, h: 1, block: '@trim' },
          { op: 'cone', at: [-1, 6, -1], r: r + 1, h: r + 1, block: '@roof' },
          { op: 'set', at: [r, 4, r], block: '@light' },
        ],
      };
    },
  },

  barn: {
    name: 'barn',
    summary: 'Long barn with wide doors, a hayloft and a steep gable roof.',
    params: { w: 13, d: 21, h: 7 },
    build: (p) => {
      const w = num(p, 'w', 13, 7, 40), d = num(p, 'd', 21, 9, 60), h = num(p, 'h', 7, 5, 16);
      return {
        name: 'barn',
        parts: [
          ...pad(w, d),
          { op: 'walls', at: [0, 1, 0], size: [w, h, d], block: '@wall', thickness: 1 },
          { op: 'frame', at: [0, 1, 0], size: [w, h, d], thickness: 1, block: '@trim', mode: 'keep' },
          { op: 'clear', at: [Math.floor(w / 2) - 2, 1, d - 1], size: [5, 5, 1] },
          { op: 'box', at: [1, h - 2, 1], size: [w - 2, 1, Math.floor(d / 2)], block: '@floor' },
          { op: 'roof', at: [0, 1 + h, 0], size: [w, 1, d], kind: 'gable', axis: 'z', pitch: 1.5, overhang: 1, block: '@roof', stairs: '@roof_stairs', gableBlock: '@wall' },
          { op: 'scatter', at: [1, 1, 1], size: [w - 2, 1, d - 2], density: 0.12, block: 'hay_block' },
          { op: 'set', at: [Math.floor(w / 2), h - 1, Math.floor(d / 2)], block: '@light' },
        ],
      };
    },
  },

  pyramid: {
    name: 'pyramid',
    summary: 'Stepped pyramid with a hollow chamber and an entrance corridor.',
    params: { base: 31 },
    build: (p) => {
      const base = Math.max(11, num(p, 'base', 31, 11, 120) | 1);
      const mid = Math.floor(base / 2);
      const chamber = Math.max(5, Math.floor(base / 5) | 1);
      return {
        name: 'pyramid',
        parts: [
          { op: 'foundation', at: [0, 0, 0], size: [base, base], depth: 4, block: '@base' },
          { op: 'pyramid', at: [0, 0, 0], size: [base, Math.ceil(base / 2), base], block: '@wall', step: 1 },
          { op: 'clear', at: [mid - Math.floor(chamber / 2), 1, mid - Math.floor(chamber / 2)], size: [chamber, 4, chamber] },
          { op: 'box', at: [mid - Math.floor(chamber / 2), 0, mid - Math.floor(chamber / 2)], size: [chamber, 1, chamber], block: '@floor' },
          { op: 'clear', at: [mid - 1, 1, mid], size: [3, 3, base - mid] },
          { op: 'set', at: [mid, 1, mid], block: 'chest' },
          { op: 'set', at: [mid, 4, mid], block: '@light' },
          { op: 'set', at: [mid - 2, 3, base - 2], block: '@light' },
          { op: 'set', at: [mid + 2, 3, base - 2], block: '@light' },
        ],
      };
    },
  },

  watchtower: {
    name: 'watchtower',
    summary: 'Slim square tower on stilts with a covered lookout platform.',
    params: { h: 16, w: 5 },
    build: (p) => {
      const h = num(p, 'h', 16, 8, 60), w = num(p, 'w', 5, 3, 12);
      return {
        name: 'watchtower',
        parts: [
          { op: 'foundation', at: [0, 0, 0], size: [w, w], depth: 4, block: '@base' },
          { op: 'symmetry', axis: 'xz', about: Math.floor(w / 2), of: [{ op: 'box', at: [0, 0, 0], size: [1, h, 1], block: '@pillar' }] },
          { op: 'box', at: [-1, h, -1], size: [w + 2, 1, w + 2], block: '@floor' },
          { op: 'walls', at: [-1, h + 1, -1], size: [w + 2, 2, w + 2], block: '@fence', thickness: 1 },
          { op: 'symmetry', axis: 'xz', about: Math.floor(w / 2), of: [{ op: 'box', at: [0, h + 1, 0], size: [1, 4, 1], block: '@trim' }] },
          { op: 'roof', at: [-1, h + 5, -1], size: [w + 2, 1, w + 2], kind: 'hip', pitch: 1, overhang: 1, block: '@roof', stairs: '@roof_stairs' },
          { op: 'spiral', at: [0, 1, 0], r: Math.max(1, Math.floor(w / 2)), h: h - 1, turn: 8, stairs: '@roof_stairs' },
          { op: 'set', at: [Math.floor(w / 2), h + 4, Math.floor(w / 2)], block: '@light' },
        ],
      };
    },
  },
};

export function getPrefab(name: string, params?: Params): Blueprint | null {
  const def = PREFABS[name?.toLowerCase?.() ?? ''];
  if (!def) return null;
  const bp = def.build(params ?? {});
  return bp;
}

export function listPrefabs(): Array<{ name: string; summary: string; params: Record<string, number | string> }> {
  return Object.values(PREFABS).map((d) => ({ name: d.name, summary: d.summary, params: d.params }));
}

/**
 * Fuzzy prefab lookup so "a small cottage please" still resolves.
 *
 * Aliases are tried longest-first: "leuchtturm" has to win over the "turm" it
 * contains, or every lighthouse request would build a plain tower.
 */
export function matchPrefab(text: string): string | null {
  const t = text.toLowerCase();
  const aliases: Record<string, string> = {
    burg: 'castle', schloss: 'castle', fortress: 'castle', citadel: 'castle',
    haus: 'house', home: 'house', cabin: 'cottage', hut: 'cottage', hütte: 'cottage',
    turm: 'tower', spire: 'tower', leuchtturm: 'lighthouse',
    brücke: 'bridge', brucke: 'bridge', mühle: 'windmill', muhle: 'windmill', mill: 'windmill',
    tempel: 'temple', shrine: 'temple', mauer: 'wall', rampart: 'wall',
    brunnen: 'well', pavilion: 'gazebo', pavillon: 'gazebo', scheune: 'barn',
    pyramide: 'pyramid', wachturm: 'watchtower', bergfried: 'keep', donjon: 'keep',
  };
  const candidates: Array<[string, string]> = [
    ...Object.keys(PREFABS).map((k) => [k, k] as [string, string]),
    ...Object.entries(aliases),
  ];
  candidates.sort((a, b) => b[0].length - a[0].length);
  for (const [needle, target] of candidates) if (t.includes(needle)) return target;
  return null;
}
