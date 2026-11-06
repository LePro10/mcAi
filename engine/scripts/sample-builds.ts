// Procedural test builds used for sample renders (docs/renders) and render tests.
import type { BlockVolume, Box } from '../src/core/types.ts';
import { createVolume, volSet, volGet } from '../src/core/volume.ts';
import { Registry } from '../src/core/registry.ts';

const reg = Registry.loadDefault();
const C = (s: string) => reg.canonical(s);

export class Builder {
  v: BlockVolume;
  private cache = new Map<string, string>();
  constructor(box: Box) {
    this.v = createVolume(box);
  }
  set(x: number, y: number, z: number, s: string): void {
    const b = this.v.box;
    if (x < b.min[0] || y < b.min[1] || z < b.min[2] || x > b.max[0] || y > b.max[1] || z > b.max[2]) return;
    let c = this.cache.get(s);
    if (!c) {
      c = C(s);
      this.cache.set(s, c);
    }
    volSet(this.v, x, y, z, c);
  }
  get(x: number, y: number, z: number): string {
    return volGet(this.v, x, y, z);
  }
  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, s: string): void {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
      for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++)
        for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) this.set(x, y, z, s);
  }
}

function rand(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function oakTree(b: Builder, x: number, y: number, z: number, h = 5): void {
  for (let i = 0; i < h; i++) b.set(x, y + i, z, 'oak_log[axis=y]');
  for (let dy = h - 3; dy <= h; dy++) {
    const r = dy >= h - 1 ? 1 : 2;
    for (let dx = -r; dx <= r; dx++)
      for (let dz = -r; dz <= r; dz++) {
        if (Math.abs(dx) === r && Math.abs(dz) === r && (dy === h || (dx + dz + dy) % 2 === 0)) continue;
        if (dx === 0 && dz === 0 && dy < h) continue;
        b.set(x + dx, y + dy, z + dz, 'oak_leaves[persistent=true]');
      }
  }
  b.set(x, y + h, z, 'oak_leaves[persistent=true]');
}

/** Cozy cottage on a grass island with pond, garden and tree. Footprint ~ 30×30. */
export function cottage(): BlockVolume {
  const b = new Builder({ min: [0, 60, 0], max: [31, 76, 31] });
  const rnd = rand(7);
  // ground
  b.fill(0, 60, 0, 31, 61, 31, 'dirt');
  b.fill(0, 62, 0, 31, 62, 31, 'grass_block[snowy=false]');
  // pond
  for (let x = 20; x <= 29; x++)
    for (let z = 19; z <= 29; z++) {
      const d = Math.hypot((x - 24.5) / 4.6, (z - 24) / 4.6);
      if (d < 1) {
        b.set(x, 61, z, 'sand');
        b.set(x, 62, z, 'water');
        if (d < 0.6) {
          b.set(x, 60, z, 'sand');
          b.set(x, 61, z, 'water');
        }
      } else if (d < 1.25) b.set(x, 62, z, 'sand');
    }
  b.set(23, 63, 23, 'lily_pad');
  b.set(26, 62, 25, 'seagrass');
  // house 11 x 9 (x 6..16, z 5..13), floor y=63
  const X0 = 6, X1 = 16, Z0 = 5, Z1 = 13, Y = 63;
  b.fill(X0, Y, Z0, X1, Y, Z1, 'cobblestone');
  b.fill(X0 + 1, Y, Z0 + 1, X1 - 1, Y, Z1 - 1, 'spruce_planks');
  for (let y = Y + 1; y <= Y + 4; y++) {
    for (let x = X0; x <= X1; x++) {
      b.set(x, y, Z0, 'oak_planks');
      b.set(x, y, Z1, 'oak_planks');
    }
    for (let z = Z0; z <= Z1; z++) {
      b.set(X0, y, z, 'oak_planks');
      b.set(X1, y, z, 'oak_planks');
    }
    for (const [x, z] of [[X0, Z0], [X1, Z0], [X0, Z1], [X1, Z1]]) b.set(x, y, z, 'stripped_spruce_log[axis=y]');
  }
  // beam
  for (let x = X0; x <= X1; x++) {
    b.set(x, Y + 4, Z0, 'stripped_spruce_log[axis=x]');
    b.set(x, Y + 4, Z1, 'stripped_spruce_log[axis=x]');
  }
  for (let z = Z0; z <= Z1; z++) {
    b.set(X0, Y + 4, z, 'stripped_spruce_log[axis=z]');
    b.set(X1, Y + 4, z, 'stripped_spruce_log[axis=z]');
  }
  // windows (front = +z facade at Z1)
  for (const x of [X0 + 2, X0 + 3, X1 - 3, X1 - 2]) {
    b.set(x, Y + 2, Z1, 'glass_pane[east=true,west=true]');
    b.set(x, Y + 2, Z0, 'glass_pane[east=true,west=true]');
  }
  for (const z of [Z0 + 3, Z0 + 5]) {
    b.set(X0, Y + 2, z, 'glass_pane[north=true,south=true]');
    b.set(X1, Y + 2, z, 'light_blue_stained_glass');
  }
  // door
  const DX = 11;
  b.set(DX, Y + 1, Z1, 'oak_door[facing=south,half=lower,hinge=left]');
  b.set(DX, Y + 2, Z1, 'oak_door[facing=south,half=upper,hinge=left]');
  b.set(DX, Y + 3, Z1 + 1, 'lantern[hanging=false]');
  b.set(DX - 1, Y + 3, Z1 + 1, 'wall_torch[facing=south]');
  b.set(DX + 1, Y + 3, Z1 + 1, 'wall_torch[facing=south]');
  b.set(DX, Y, Z1 + 1, 'spruce_stairs[facing=north]');
  // flower boxes
  for (const x of [X0 + 2, X0 + 3, X1 - 3, X1 - 2]) {
    b.set(x, Y + 1, Z1 + 1, 'spruce_trapdoor[facing=south,half=bottom,open=true]');
  }
  // gable roof along x (ridge parallel to x), overhang 1
  const H = 5;
  for (let i = 0; i <= H; i++) {
    const zf = Z1 + 1 - i, zb = Z0 - 1 + i, y = Y + 5 + i;
    if (zf < zb) break;
    for (let x = X0 - 1; x <= X1 + 1; x++) {
      if (zf === zb) b.set(x, y, zf, 'dark_oak_slab[type=bottom]');
      else {
        b.set(x, y, zf, 'dark_oak_stairs[facing=north,half=bottom]');
        b.set(x, y, zb, 'dark_oak_stairs[facing=south,half=bottom]');
      }
    }
    // gable walls
    for (let z = zb + 1; z <= zf - 1; z++) {
      b.set(X0, y, z, i % 2 ? 'oak_planks' : 'stripped_oak_log[axis=z]');
      b.set(X1, y, z, i % 2 ? 'oak_planks' : 'stripped_oak_log[axis=z]');
    }
  }
  b.set(X0, Y + 7, Z0 + 4, 'glass_pane[north=true,south=true]');
  b.set(X1, Y + 7, Z0 + 4, 'glass_pane[north=true,south=true]');
  // chimney
  b.fill(X1 - 2, Y + 1, Z0 + 1, X1 - 2, Y + 10, Z0 + 1, 'bricks');
  b.set(X1 - 2, Y + 11, Z0 + 1, 'campfire[lit=true]');
  // interior
  b.set(X0 + 1, Y + 1, Z0 + 1, 'chest[facing=south]');
  b.set(X0 + 2, Y + 1, Z0 + 1, 'crafting_table');
  b.set(X0 + 3, Y + 1, Z0 + 1, 'furnace[facing=south,lit=true]');
  b.set(X1 - 1, Y + 1, Z1 - 1, 'red_bed[facing=north,part=foot]');
  b.set(X1 - 1, Y + 1, Z1 - 2, 'red_bed[facing=north,part=head]');
  b.set(X0 + 4, Y + 1, Z0 + 4, 'oak_fence');
  b.set(X0 + 4, Y + 2, Z0 + 4, 'white_carpet');
  b.set(X0 + 2, Y + 4, Z0 + 4, 'lantern[hanging=true]');
  // path
  for (let z = Z1 + 2; z <= 31; z++) {
    b.set(DX, 62, z, 'dirt_path');
    if (rnd() < 0.5) b.set(DX + (rnd() < 0.5 ? -1 : 1), 62, z, 'dirt_path');
  }
  // fence garden
  for (let x = 1; x <= 5; x++) {
    b.set(x, 63, 16, 'oak_fence[east=true,west=true]');
    b.set(x, 63, 24, 'oak_fence[east=true,west=true]');
  }
  for (let z = 16; z <= 24; z++) {
    b.set(1, 63, z, 'oak_fence[north=true,south=true]');
    b.set(5, 63, z, 'oak_fence[north=true,south=true]');
  }
  for (const [x, z, n] of [[1, 16, 'oak_fence[east=true,south=true]'], [5, 16, 'oak_fence[west=true,south=true]'], [1, 24, 'oak_fence[east=true,north=true]'], [5, 24, 'oak_fence[west=true,north=true]']] as [number, number, string][])
    b.set(x, 63, z, n);
  b.set(5, 63, 20, 'oak_fence_gate[facing=east]');
  for (let x = 2; x <= 4; x++)
    for (let z = 17; z <= 23; z++) {
      b.set(x, 62, z, 'farmland[moisture=7]');
      b.set(x, 63, z, z % 2 ? `wheat[age=${(x + z) % 8}]` : `carrots[age=${(x * z) % 8}]`);
    }
  // flowers & grass
  const flowers = ['poppy', 'dandelion', 'cornflower', 'oxeye_daisy', 'azure_bluet', 'allium', 'pink_tulip'];
  for (let i = 0; i < 90; i++) {
    const x = Math.floor(rnd() * 32), z = Math.floor(rnd() * 32);
    if (b.get(x, 62, z) !== C('grass_block[snowy=false]') || b.get(x, 63, z) !== 'minecraft:air') continue;
    if (x >= X0 - 1 && x <= X1 + 1 && z >= Z0 - 1 && z <= Z1 + 2) continue;
    b.set(x, 63, z, rnd() < 0.35 ? flowers[Math.floor(rnd() * flowers.length)] : 'short_grass');
  }
  b.set(28, 63, 4, 'tall_grass[half=lower]');
  b.set(28, 64, 4, 'tall_grass[half=upper]');
  oakTree(b, 24, 63, 8, 5);
  oakTree(b, 3, 63, 4, 4);
  return b.v;
}

/** A single red wool cube on a grass platform (render tests). */
export function redCube(): BlockVolume {
  const b = new Builder({ min: [0, 0, 0], max: [8, 4, 8] });
  b.fill(0, 0, 0, 8, 0, 8, 'grass_block[snowy=false]');
  b.fill(3, 1, 3, 5, 3, 5, 'red_wool');
  return b.v;
}

/** Stone castle tower with walls, banners, water moat (≈ 40×28×40). */
export function tower(): BlockVolume {
  const b = new Builder({ min: [-20, 60, -20], max: [20, 92, 20] });
  b.fill(-20, 60, -20, 20, 62, 20, 'stone');
  b.fill(-20, 63, -20, 20, 63, 20, 'grass_block[snowy=false]');
  // moat ring
  for (let x = -20; x <= 20; x++)
    for (let z = -20; z <= 20; z++) {
      const r = Math.hypot(x, z);
      if (r > 14.5 && r < 17.5) {
        b.set(x, 63, z, 'water');
        b.set(x, 62, z, 'water');
        b.set(x, 61, z, 'gravel');
      }
    }
  // round tower
  for (let y = 64; y <= 84; y++)
    for (let x = -7; x <= 7; x++)
      for (let z = -7; z <= 7; z++) {
        const r = Math.hypot(x, z);
        if (r <= 6.5 && r > 5.3) b.set(x, y, z, (x * 7 + y * 3 + z * 5) % 5 === 0 ? 'mossy_stone_bricks' : (x + y + z) % 7 === 0 ? 'cracked_stone_bricks' : 'stone_bricks');
        else if (r <= 5.3 && y === 64) b.set(x, y, z, 'polished_andesite');
      }
  // crenellations
  for (let x = -8; x <= 8; x++)
    for (let z = -8; z <= 8; z++) {
      const r = Math.hypot(x, z);
      if (r <= 7.5 && r > 6.2) {
        b.set(x, 85, z, 'stone_bricks');
        if ((Math.round(Math.atan2(z, x) * 8) & 1) === 0) b.set(x, 86, z, 'stone_brick_wall');
      } else if (r <= 6.2) b.set(x, 85, z, 'spruce_planks');
    }
  // cone roof
  for (let y = 86; y <= 92; y++) {
    const rr = 6.2 - (y - 86) * 1.0;
    for (let x = -7; x <= 7; x++)
      for (let z = -7; z <= 7; z++) {
        const r = Math.hypot(x, z);
        if (r <= rr && r > rr - 1.4) b.set(x, y, z, 'deepslate_tiles');
      }
  }
  // windows
  for (const y of [68, 74, 80]) {
    b.set(0, y, 6, 'glass_pane[east=true,west=true]');
    b.set(0, y + 1, 6, 'glass_pane[east=true,west=true]');
    b.set(6, y, 0, 'glass_pane[north=true,south=true]');
    b.set(-6, y, 0, 'glass_pane[north=true,south=true]');
  }
  // door + bridge
  b.set(0, 65, 6, 'air');
  b.set(0, 66, 6, 'air');
  b.set(0, 65, 7, 'spruce_door[facing=south,half=lower]');
  b.set(0, 66, 7, 'spruce_door[facing=south,half=upper]');
  for (let z = 8; z <= 19; z++) for (let x = -1; x <= 1; x++) b.set(x, 64, z, 'spruce_planks');
  for (let z = 8; z <= 19; z++) {
    b.set(-2, 65, z, 'spruce_fence[north=true,south=true]');
    b.set(2, 65, z, 'spruce_fence[north=true,south=true]');
  }
  b.set(-1, 67, 8, 'red_wall_banner[facing=south]');
  b.set(1, 67, 8, 'red_wall_banner[facing=south]');
  b.set(0, 68, 8, 'lantern[hanging=false]');
  b.set(-2, 66, 19, 'torch');
  b.set(2, 66, 19, 'torch');
  oakTree(b, -14, 64, -10, 6);
  oakTree(b, 12, 64, -13, 5);
  return b.v;
}

/** A showcase of block-entity blocks and special models in a row. */
export function showcase(): BlockVolume {
  const b = new Builder({ min: [0, 0, 0], max: [17, 3, 6] });
  b.fill(0, 0, 0, 17, 0, 6, 'smooth_stone');
  const items = [
    'chest[facing=south]', 'ender_chest[facing=south]', 'red_shulker_box[facing=up]', 'white_banner[rotation=0]',
    'skeleton_skull[rotation=0]', 'creeper_head[rotation=0]', 'player_head[rotation=0]', 'decorated_pot[facing=south]',
    'bell[attachment=floor,facing=north]', 'oak_sign[rotation=0]', 'brewing_stand', 'anvil[facing=north]',
    'cauldron', 'lectern[facing=south]', 'enchanting_table', 'campfire[lit=true]', 'grindstone[face=floor,facing=north]', 'lantern',
  ];
  items.forEach((s, i) => b.set(i, 1, 3, s));
  b.set(0, 1, 5, 'chest[facing=south,type=right]');
  b.set(1, 1, 5, 'chest[facing=south,type=left]');
  b.fill(3, 1, 1, 5, 3, 1, 'stone_bricks');
  b.set(4, 2, 2, 'blue_wall_banner[facing=south]');
  b.set(3, 2, 2, 'zombie_wall_head[facing=south]');
  b.set(5, 2, 2, 'oak_wall_sign[facing=south]');
  return b.v;
}

/** 96×64×96 performance scene: 3×3 cottages + a tall tower in the middle. */
export function bigScene(): BlockVolume {
  const out = createVolume({ min: [0, 60, 0], max: [95, 123, 95] });
  const c = cottage();
  const t = tower();
  const copy = (src: BlockVolume, dx: number, dy: number, dz: number) => {
    const sx = src.box.max[0] - src.box.min[0] + 1, sz = src.box.max[2] - src.box.min[2] + 1;
    const sy = src.box.max[1] - src.box.min[1] + 1;
    for (let y = 0; y < sy; y++)
      for (let z = 0; z < sz; z++)
        for (let x = 0; x < sx; x++) {
          const s = src.palette[src.data[(y * sz + z) * sx + x]];
          if (s === 'minecraft:air') continue;
          const wx = src.box.min[0] + x + dx, wy = src.box.min[1] + y + dy, wz = src.box.min[2] + z + dz;
          if (wx < 0 || wx > 95 || wy < 60 || wy > 123 || wz < 0 || wz > 95) continue;
          volSet(out, wx, wy, wz, s);
        }
  };
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (i !== 1 || j !== 1) copy(c, i * 32, 0, j * 32);
  copy(t, 48, -1, 48);
  // extra tall spire to use the full height
  for (let y = 92; y <= 123; y++)
    for (let x = -2; x <= 2; x++)
      for (let z = -2; z <= 2; z++) {
        const r = Math.hypot(x, z);
        if (r <= 2.2 - (y - 92) * 0.07) volSet(out, 48 + x, y, 48 + z, y % 4 === 0 ? 'minecraft:gold_block' : 'minecraft:quartz_block');
      }
  return out;
}
