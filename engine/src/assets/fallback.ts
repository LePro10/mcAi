// Flat-colored approximate geometry used when no assets are available (rendering never fails).
import { cuboid, DIRS, type BlockGeometry, type Dir, type GeoCuboid } from './geometry.ts';
import { emission, isInvisible, paletteColor, renderLayer } from './classify.ts';

type V3 = [number, number, number];
const F = (exclude: Dir[] = []) => {
  const o: Partial<Record<Dir, { texture: string }>> = {};
  for (const d of DIRS) if (!exclude.includes(d)) o[d] = { texture: '' };
  return o;
};
const box = (a: V3, b: V3) => cuboid(a, b, F());

function shape(n: string, p: Record<string, string>): GeoCuboid[] {
  if (/_slab$/.test(n)) {
    if (p.type === 'top') return [box([0, 8, 0], [16, 16, 16])];
    if (p.type === 'double') return [box([0, 0, 0], [16, 16, 16])];
    return [box([0, 0, 0], [16, 8, 16])];
  }
  if (/_stairs$/.test(n)) {
    const top = p.half === 'top';
    const base = top ? box([0, 8, 0], [16, 16, 16]) : box([0, 0, 0], [16, 8, 16]);
    const [y0, y1] = top ? [0, 8] : [8, 16];
    const half: Record<string, [V3, V3]> = {
      north: [[0, y0, 0], [16, y1, 8]], south: [[0, y0, 8], [16, y1, 16]],
      west: [[0, y0, 0], [8, y1, 16]], east: [[8, y0, 0], [16, y1, 16]],
    };
    const h = half[p.facing ?? 'north'];
    return [base, box(h[0], h[1])];
  }
  if (/carpet$|pressure_plate$|^moss_carpet$/.test(n)) return [box([0, 0, 0], [16, 1, 16])];
  if (n === 'snow') return [box([0, 0, 0], [16, Math.min(16, 2 * Number(p.layers ?? 1)), 16])];
  if (/_fence$|_wall$|pane$|^iron_bars$|_bars$/.test(n)) {
    const thin = /pane$|bars$/.test(n);
    const r = thin ? 1 : n.endsWith('_wall') ? 4 : 2;
    const out = [box([8 - r, 0, 8 - r], [8 + r, 16, 8 + r])];
    const a = thin ? 1 : n.endsWith('_wall') ? 3 : 1;
    const y0 = thin ? 0 : 6, y1 = thin ? 16 : n.endsWith('_wall') ? 14 : 15;
    const on = (v?: string) => v !== undefined && v !== 'false' && v !== 'none';
    if (on(p.north)) out.push(box([8 - a, y0, 0], [8 + a, y1, 8 - r]));
    if (on(p.south)) out.push(box([8 - a, y0, 8 + r], [8 + a, y1, 16]));
    if (on(p.west)) out.push(box([0, y0, 8 - a], [8 - r, y1, 8 + a]));
    if (on(p.east)) out.push(box([8 + r, y0, 8 - a], [16, y1, 8 + a]));
    return out;
  }
  if (/torch$/.test(n)) return [box([7, 0, 7], [9, 10, 9])];
  if (/lantern$/.test(n) && !/sea_lantern|jack/.test(n)) return [box([5, 0, 5], [11, 7, 11])];
  if (/_door$/.test(n)) {
    const s: Record<string, [V3, V3]> = {
      north: [[0, 0, 13], [16, 16, 16]], south: [[0, 0, 0], [16, 16, 3]],
      west: [[13, 0, 0], [16, 16, 16]], east: [[0, 0, 0], [3, 16, 16]],
    };
    const v = s[p.facing ?? 'north'];
    return [box(v[0], v[1])];
  }
  if (/trapdoor$/.test(n)) return p.half === 'top' ? [box([0, 13, 0], [16, 16, 16])] : [box([0, 0, 0], [16, 3, 16])];
  if (/button$/.test(n)) return [box([5, 0, 6], [11, 2, 10])];
  if (/sapling$|flower$|^(dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|short_grass|fern|dead_bush|sweet_berry_bush|torchflower|.*_tulip|.*_mushroom|.*_roots|.*_fungus)$/.test(n))
    return [box([4, 0, 4], [12, 11, 12])];
  if (/^(tall_grass|large_fern|sunflower|lilac|rose_bush|peony)$/.test(n)) return [box([3, 0, 3], [13, 16, 13])];
  if (/_sign$|_banner$/.test(n)) return [box([7, 0, 7], [9, 10, 9]), box([1, 8, 7], [15, 16, 9])];
  if (/_bed$/.test(n)) return [box([0, 0, 0], [16, 9, 16])];
  if (/chest$/.test(n)) return [box([1, 0, 1], [15, 14, 15])];
  if (/rail$|redstone_wire|lily_pad/.test(n)) return [box([0, 0, 0], [16, 1, 16])];
  if (/chain$/.test(n)) return [box([7, 0, 7], [9, 16, 9])];
  return [box([0, 0, 0], [16, 16, 16])];
}

export function flatGeometry(state: string, id: string, props: Record<string, string>): BlockGeometry {
  const n = id.startsWith('minecraft:') ? id.slice(10) : id;
  const color = paletteColor(id);
  const isWater = n === 'water' || n === 'bubble_column';
  const isLava = n === 'lava';
  const invisible = isInvisible(id);
  const cuboids = invisible || isWater || isLava ? [] : shape(n, props);
  const full = cuboids.length === 1 && cuboids[0].from.every((v) => v === 0) && cuboids[0].to.every((v) => v === 16);
  const layer = renderLayer(id);
  const waterlogged = props.waterlogged === 'true' || /^(kelp|kelp_plant|seagrass|tall_seagrass)$/.test(n);
  return {
    state,
    cuboids,
    ao: true,
    layer,
    fluid: isWater || waterlogged ? 'water' : isLava ? 'lava' : null,
    fluidLevel: Number(props.level ?? 0),
    fullCube: full && layer !== 'translucent' && color[3] === 255,
    emission: emission(id, props),
    tint: null,
    tintKind: null,
    synthetic: false,
    flat: true,
    color,
    invisible,
  };
}
