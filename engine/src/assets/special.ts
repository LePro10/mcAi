// Synthesized geometry for blocks that vanilla draws with block-entity renderers
// (chests, shulker boxes, banners, skulls, decorated pots, bells, conduits, …).
// Output is model JSON (textures already resolved) which goes through the normal baker,
// so facing/rotation are handled by the same code path as vanilla models.
import type { AppliedModel } from './models.ts';

type UvPx = [number, number, number, number];
type FaceSpec = { t: string; uv: UvPx; tint?: number };
interface ElSpec {
  from: number[];
  to: number[];
  faces: Partial<Record<'down' | 'up' | 'north' | 'south' | 'west' | 'east', FaceSpec>>;
  rotation?: { origin: number[]; axis: 'x' | 'y' | 'z'; angle: number };
}

export interface SyntheticModel {
  json: any; // { elements, ambientocclusion }
  applied: Omit<AppliedModel, 'model'>;
}

/** texture sizes of the entity textures (pixel coords → 0..16 model uv units) */
type SizeFn = (tex: string) => [number, number];

function el(spec: ElSpec, size: SizeFn): any {
  const faces: any = {};
  for (const [d, f] of Object.entries(spec.faces)) {
    if (!f) continue;
    const [w, h] = size(f.t);
    faces[d] = {
      texture: f.t,
      uv: [(f.uv[0] * 16) / w, (f.uv[1] * 16) / h, (f.uv[2] * 16) / w, (f.uv[3] * 16) / h],
      ...(f.tint !== undefined ? { tintindex: f.tint } : {}),
    };
  }
  return { from: spec.from, to: spec.to, faces, ...(spec.rotation ? { rotation: spec.rotation } : {}) };
}

/** Mojang entity-model box UV layout: box w×h×d at texture offset (u,v).
 *  front = the face looking toward -z in our authored (north-facing) orientation. */
function boxUv(u: number, v: number, w: number, h: number, d: number, flipV = false) {
  const side = (x0: number, x1: number): UvPx => (flipV ? [x0, v + d + h, x1, v + d] : [x0, v + d, x1, v + d + h]);
  return {
    up: [u + d, v, u + d + w, v + d] as UvPx,
    down: [u + d + w, v, u + d + 2 * w, v + d] as UvPx,
    sideA: side(u, u + d),
    front: side(u + d, u + d + w),
    sideB: side(u + d + w, u + 2 * d + w),
    back: side(u + 2 * d + w, u + 2 * d + 2 * w),
  };
}

const FACING_Y: Record<string, number> = { north: 0, east: 90, south: 180, west: 270 };
const strip = (id: string) => (id.startsWith('minecraft:') ? id.slice(10) : id);

const DYE_RGB: Record<string, number> = {
  white: 0xf9fffe, orange: 0xf9801d, magenta: 0xc74ebd, light_blue: 0x3ab3da, yellow: 0xfed83d, lime: 0x80c71f,
  pink: 0xf38baa, gray: 0x474f52, light_gray: 0x9d9d97, cyan: 0x169c9c, purple: 0x8932b8, blue: 0x3c44aa,
  brown: 0x835432, green: 0x5e7c16, red: 0xb02e26, black: 0x1d1d21,
};
export function dyeColor(id: string): [number, number, number] | null {
  const n = strip(id);
  for (const [d, c] of Object.entries(DYE_RGB)) if (n.startsWith(d + '_')) return [(c >> 16) & 255, (c >> 8) & 255, c & 255];
  return null;
}

/** textures used by synthesized models (so the atlas includes them) */
export function specialTextures(): string[] {
  const out = [
    'entity/chest/normal', 'entity/chest/trapped', 'entity/chest/ender', 'entity/chest/christmas',
    'entity/chest/copper', 'entity/chest/copper_exposed', 'entity/chest/copper_weathered', 'entity/chest/copper_oxidized',
    'entity/banner/banner_base', 'entity/decorated_pot/decorated_pot_base', 'entity/decorated_pot/decorated_pot_side',
    'entity/bell/bell_body', 'entity/conduit/base', 'entity/conduit/cage', 'entity/end_portal/end_portal',
    'entity/skeleton/skeleton', 'entity/skeleton/wither_skeleton', 'entity/zombie/zombie', 'entity/creeper/creeper',
    'entity/player/wide/steve', 'entity/piglin/piglin', 'entity/enderdragon/dragon',
    'block/water_still', 'block/lava_still', 'block/water_flow', 'block/lava_flow',
    'block/copper_block', 'block/exposed_copper', 'block/weathered_copper', 'block/oxidized_copper',
  ];
  for (const c of ['', ...Object.keys(DYE_RGB).map((d) => d + '_')]) out.push(`entity/shulker/shulker${c ? '_' + c.slice(0, -1) : ''}`);
  return out;
}

/** Returns a synthetic model for block-entity blocks, or null. */
export function synthesize(id: string, props: Record<string, string>, size: SizeFn): SyntheticModel | null {
  const n = strip(id).replace(/^waxed_/, '');
  const yOf = (f?: string) => FACING_Y[f ?? 'north'] ?? 0;

  // ---------------------------------------------------------------- chests
  const chestTex: Record<string, string> = {
    chest: 'entity/chest/normal', trapped_chest: 'entity/chest/trapped', ender_chest: 'entity/chest/ender',
    copper_chest: 'entity/chest/copper', exposed_copper_chest: 'entity/chest/copper_exposed',
    weathered_copper_chest: 'entity/chest/copper_weathered', oxidized_copper_chest: 'entity/chest/copper_oxidized',
  };
  if (n in chestTex) {
    const t = chestTex[n];
    // authored facing north (front at -z). Double chests extend toward the partner.
    // authored facing south (front at +z); partner of a 'left' half is clockwise of facing (west)
    let x0 = 1, x1 = 15;
    if (props.type === 'left') x0 = 0;
    if (props.type === 'right') x1 = 16;
    const lid = boxUv(0, 0, 14, 5, 14, true);
    const base = boxUv(0, 19, 14, 10, 14, true);
    // lid: use the upper 4 of 5 rows
    const lidSide = (uv: UvPx): UvPx => [uv[0], uv[1], uv[2], uv[3] + 1];
    const els = [
      el({ from: [x0, 0, 1], to: [x1, 10, 15], faces: {
        down: { t, uv: base.up }, north: { t, uv: base.back }, south: { t, uv: base.front },
        west: { t, uv: base.sideA }, east: { t, uv: base.sideB } } }, size),
      el({ from: [x0, 10, 1], to: [x1, 14, 15], faces: {
        up: { t, uv: lid.down }, north: { t, uv: lidSide(lid.back) },
        south: { t, uv: lidSide(lid.front) }, west: { t, uv: lidSide(lid.sideA) }, east: { t, uv: lidSide(lid.sideB) } } }, size),
    ];
    if (props.type !== 'left' && props.type !== 'right') {
      els.push(el({ from: [7, 7, 15], to: [9, 11, 16], faces: {
        south: { t, uv: [1, 1, 3, 5] }, up: { t, uv: [1, 0, 3, 1] }, down: { t, uv: [3, 0, 5, 1] },
        west: { t, uv: [0, 1, 1, 5] }, east: { t, uv: [3, 1, 4, 5] } } }, size));
    } else {
      const lx = props.type === 'left' ? 0 : 15;
      els.push(el({ from: [lx, 7, 15], to: [lx + 1, 11, 16], faces: {
        south: { t, uv: [1, 1, 2, 5] }, up: { t, uv: [1, 0, 2, 1] }, west: { t, uv: [0, 1, 1, 5] }, east: { t, uv: [3, 1, 4, 5] } } }, size));
    }
    // chest model front faces facing; our authored front is -z (north) → y rotation
    return { json: { elements: els, ambientocclusion: true }, applied: { x: 0, y: (yOf(props.facing) + 180) % 360, uvlock: false } };
  }

  // ---------------------------------------------------------------- shulker boxes
  const sm = /^(?:(.+)_)?shulker_box$/.exec(n);
  if (sm) {
    const t = sm[1] ? `entity/shulker/shulker_${sm[1]}` : 'entity/shulker/shulker';
    const lid = boxUv(0, 0, 16, 12, 16);
    const base = boxUv(0, 28, 16, 8, 16);
    const els = [
      el({ from: [0.05, 0, 0.05], to: [15.95, 8, 15.95], faces: {
        down: { t, uv: base.down }, north: { t, uv: base.front }, south: { t, uv: base.back },
        west: { t, uv: base.sideA }, east: { t, uv: base.sideB } } }, size),
      el({ from: [0, 4, 0], to: [16, 16, 16], faces: {
        up: { t, uv: lid.up }, north: { t, uv: lid.front }, south: { t, uv: lid.back },
        west: { t, uv: lid.sideA }, east: { t, uv: lid.sideB } } }, size),
    ];
    const f = props.facing ?? 'up';
    const rot = { up: [0, 0], down: [180, 0], north: [90, 0], south: [90, 180], west: [90, 270], east: [90, 90] }[f] ?? [0, 0];
    return { json: { elements: els, ambientocclusion: true }, applied: { x: rot[0], y: rot[1], uvlock: false } };
  }

  // ---------------------------------------------------------------- banners
  const bm = /^(.+?)_(wall_)?banner$/.exec(n);
  if (bm) {
    const t = 'entity/banner/banner_base';
    const wall = !!bm[2];
    const els: any[] = [];
    if (!wall) {
      els.push(el({ from: [7, 0, 7], to: [9, 16, 9], faces: {
        north: { t, uv: [46, 2, 48, 44] }, south: { t, uv: [50, 2, 52, 44] }, west: { t, uv: [44, 2, 46, 44] },
        east: { t, uv: [48, 2, 50, 44] }, up: { t, uv: [46, 0, 48, 2] } } }, size));
      els.push(el({ from: [1.5, 14.5, 9], to: [14.5, 15.75, 10], faces: {
        south: { t, uv: [2, 44, 22, 46] }, north: { t, uv: [24, 44, 44, 46] }, up: { t, uv: [2, 42, 22, 44] },
        west: { t, uv: [0, 44, 2, 46] }, east: { t, uv: [22, 44, 24, 46] } } }, size));
      els.push(el({ from: [1.5, 1, 9.5], to: [14.5, 14.5, 10], faces: {
        south: { t, uv: [1, 1, 21, 41], tint: 0 }, north: { t, uv: [22, 1, 42, 41], tint: 0 },
        west: { t, uv: [0, 1, 1, 41], tint: 0 }, east: { t, uv: [21, 1, 22, 41], tint: 0 } } }, size));
      const rot = Number(props.rotation ?? 0) * -22.5;
      for (const e of els) e.rotation = { origin: [8, 8, 8], axis: 'y', angle: rot };
      return { json: { elements: els, ambientocclusion: false }, applied: { x: 0, y: 0, uvlock: false } };
    }
    // wall banner authored facing south (cloth on the north wall side)
    els.push(el({ from: [1.5, 14.5, 0], to: [14.5, 15.75, 1.5], faces: {
      south: { t, uv: [2, 44, 22, 46] }, up: { t, uv: [2, 42, 22, 44] }, down: { t, uv: [22, 42, 42, 44] },
      west: { t, uv: [0, 44, 2, 46] }, east: { t, uv: [22, 44, 24, 46] } } }, size));
    els.push(el({ from: [1.5, 0, 1.5], to: [14.5, 14.5, 2.25], faces: {
      south: { t, uv: [1, 1, 21, 41], tint: 0 }, north: { t, uv: [22, 1, 42, 41], tint: 0 },
      west: { t, uv: [0, 1, 1, 41], tint: 0 }, east: { t, uv: [21, 1, 22, 41], tint: 0 } } }, size));
    return { json: { elements: els, ambientocclusion: false }, applied: { x: 0, y: (yOf(props.facing) + 180) % 360, uvlock: false } };
  }

  // ---------------------------------------------------------------- heads & skulls
  const hm = /^(skeleton|wither_skeleton|zombie|creeper|player|piglin|dragon)_(wall_)?(skull|head)$/.exec(n);
  if (hm) {
    const tex: Record<string, string> = {
      skeleton: 'entity/skeleton/skeleton', wither_skeleton: 'entity/skeleton/wither_skeleton', zombie: 'entity/zombie/zombie',
      creeper: 'entity/creeper/creeper', player: 'entity/player/wide/steve', piglin: 'entity/piglin/piglin', dragon: 'entity/enderdragon/dragon',
    };
    const t = tex[hm[1]];
    const wall = !!hm[2];
    const w = hm[1] === 'piglin' ? 10 : hm[1] === 'dragon' ? 12 : 8;
    const hgt = hm[1] === 'dragon' ? 10 : 8;
    const uv = hm[1] === 'dragon' ? boxUv(112, 30, 16, 16, 16) : boxUv(0, 0, w, 8, 8);
    const x0 = 8 - w / 2, x1 = 8 + w / 2;
    // authored: face looking south (+z), standing on the floor
    const z0 = wall ? 0 : 4, z1 = wall ? 8 : 12;
    const y0 = wall ? 4 : 0;
    const els = [el({ from: [x0, y0, z0], to: [x1, y0 + hgt, z1], faces: {
      south: { t, uv: uv.front }, north: { t, uv: uv.back }, west: { t, uv: uv.sideA }, east: { t, uv: uv.sideB },
      up: { t, uv: uv.up }, down: { t, uv: uv.down } } }, size)];
    if (!wall) {
      const rot = Number(props.rotation ?? 0) * -22.5;
      els[0].rotation = { origin: [8, 0, 8], axis: 'y', angle: rot };
      return { json: { elements: els, ambientocclusion: true }, applied: { x: 0, y: 0, uvlock: false } };
    }
    // wall head facing F: face looks F, back against the opposite wall (authored: looks south, back at z=0)
    return { json: { elements: els, ambientocclusion: true }, applied: { x: 0, y: (yOf(props.facing) + 180) % 360, uvlock: false } };
  }

  // ---------------------------------------------------------------- decorated pot
  if (n === 'decorated_pot') {
    const b = 'entity/decorated_pot/decorated_pot_base';
    const s = 'entity/decorated_pot/decorated_pot_side';
    const els = [
      el({ from: [1, 0, 1], to: [15, 13, 15], faces: {
        north: { t: s, uv: [1, 0, 15, 13] }, south: { t: s, uv: [1, 0, 15, 13] }, west: { t: s, uv: [1, 0, 15, 13] },
        east: { t: s, uv: [1, 0, 15, 13] }, up: { t: b, uv: [0, 13, 14, 27] }, down: { t: b, uv: [14, 13, 28, 27] } } }, size),
      el({ from: [5, 13, 5], to: [11, 16, 11], faces: {
        north: { t: b, uv: [0, 8, 6, 11] }, south: { t: b, uv: [6, 8, 12, 11] }, west: { t: b, uv: [12, 8, 18, 11] },
        east: { t: b, uv: [18, 8, 24, 11] }, up: { t: b, uv: [8, 0, 14, 6] } } }, size),
    ];
    return { json: { elements: els, ambientocclusion: true }, applied: { x: 0, y: yOf(props.facing), uvlock: false } };
  }

  // ---------------------------------------------------------------- bell body (bar/post are vanilla models)
  if (n === 'bell') {
    const t = 'entity/bell/bell_body';
    const body = boxUv(0, 0, 6, 7, 6);
    const lip = boxUv(0, 13, 8, 2, 8);
    const els = [
      el({ from: [5, 6, 5], to: [11, 13, 11], faces: { north: { t, uv: body.front }, south: { t, uv: body.back },
        west: { t, uv: body.sideA }, east: { t, uv: body.sideB }, up: { t, uv: body.up } } }, size),
      el({ from: [4, 4, 4], to: [12, 6, 12], faces: { north: { t, uv: lip.front }, south: { t, uv: lip.back },
        west: { t, uv: lip.sideA }, east: { t, uv: lip.sideB }, up: { t, uv: lip.up }, down: { t, uv: lip.down } } }, size),
    ];
    return { json: { elements: els, ambientocclusion: true, merge: true }, applied: { x: 0, y: 0, uvlock: false } };
  }

  if (n === 'conduit') {
    const t = 'entity/conduit/base';
    const u = boxUv(0, 0, 6, 6, 6);
    return { json: { elements: [el({ from: [5, 5, 5], to: [11, 11, 11], faces: { north: { t, uv: u.front }, south: { t, uv: u.back },
      west: { t, uv: u.sideA }, east: { t, uv: u.sideB }, up: { t, uv: u.up }, down: { t, uv: u.down } } }, size)], ambientocclusion: false },
      applied: { x: 0, y: 0, uvlock: false } };
  }

  if (n === 'end_portal' || n === 'end_gateway') {
    const t = 'entity/end_portal/end_portal';
    const top = n === 'end_portal' ? 12 : 16;
    const f = { t, uv: [0, 0, 64, 64] as UvPx };
    const faces: ElSpec['faces'] = n === 'end_portal' ? { up: f } : { up: f, down: f, north: f, south: f, west: f, east: f };
    return { json: { elements: [el({ from: [0, n === 'end_portal' ? 11.9 : 0, 0], to: [16, top, 16], faces }, size)], ambientocclusion: false },
      applied: { x: 0, y: 0, uvlock: false } };
  }

  const cg = /^(?:(exposed|weathered|oxidized)_)?copper_golem_statue$/.exec(n);
  if (cg) {
    const t = cg[1] ? `block/${cg[1]}_copper` : 'block/copper_block';
    const all = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => el({ from: [x0, y0, z0], to: [x1, y1, z1], faces: {
      north: { t, uv: [x0, 16 - y1, x1, 16 - y0] }, south: { t, uv: [x0, 16 - y1, x1, 16 - y0] }, west: { t, uv: [z0, 16 - y1, z1, 16 - y0] },
      east: { t, uv: [z0, 16 - y1, z1, 16 - y0] }, up: { t, uv: [x0, z0, x1, z1] }, down: { t, uv: [x0, z0, x1, z1] } } }, size);
    return { json: { elements: [all(5, 0, 6, 11, 7, 10), all(4, 7, 5, 12, 13, 11), all(7.5, 13, 7.5, 8.5, 16, 8.5)], ambientocclusion: true },
      applied: { x: 0, y: yOf(props.facing), uvlock: false } };
  }
  return null;
}

/** banner cloth tint (dye color) */
export function bannerTint(id: string): [number, number, number] | null {
  return /banner$/.test(strip(id)) ? dyeColor(id) : null;
}
