# run_script cookbook

Ready-to-adapt generators for organic, curved, repetitive or large-scale forms. Paste the **prelude** plus one
recipe into a single run_script call, edit the PARAMS block, run, then render_view and iterate.

Sandbox API (see the run_script tool description): `set(x,y,z,block)` / `setSoft(...)` where block = state string, weighted string
(`'70%stone,30%andesite'`), pattern-spec object (gradients need `from`/`to` in a script) or function
`(x,y,z) => state|null`; `get(x,y,z)` returns the
state inside readBox (default = the allowed box) **including your own writes**; `fill(x1,y1,z1,x2,y2,z2,block)`;
shape helpers `box/ellipsoid/sphere/cylinder/cone/pyramid/torus/line/curve/polygon/arch/spiral(params, block)`
(params like build ops); `positions(shape, params)`; `roof({...})`; `pattern(spec)` → fn; `block(id,{props})`;
`isAir(state)`; `noise2/noise3` (simplex −1..1), `fbm2/fbm3`; seeded `rand/randInt/chance/choice/shuffle`;
`vec.*` (add, sub, scale, norm, lerp, rotY, …); `log(...)`; `info` (space, readBox, maxBlocks, seed).
Coordinates are **local** by default: origin = anchor, **y=0 = the anchor's ground block**, +x right,
−z forward into the site, +z toward the player; states authored as if looking north.

Rules of thumb
- Ground: built-in `groundY(x,z)` (natural ground inside readBox — ignores plants, leaves, tree logs and this job's
  own builds); `isWater(x,y,z)` (water, waterlogged, underwater plants — e.g. lily pads only on water);
  `setSoft` places only into air/plants; `protect(box)` keeps finished parts safe from later sets.
  readBox is clamped to the allowed box ± 4 (reads far outside stall the real game).
- Reuse: `define('name', function (params) {...})` once, then `call('name', {...})` in this and later scripts of
  the job; `save_generator` keeps it for future jobs (`list_generators`).
- One script ≤ ~200k blocks and ≤ 15 s (raise timeoutMs up to 120000 for big terrain); `log()` key coordinates.
- Leaves always `persistent=true`. Never write outside the allowed box (the whole call is rejected; clip:true drops).
- Same seed → same result. Errors come back with line numbers — fix and rerun.
- Prefer the built-in shape helpers for plain geometry (cylinder, ellipsoid, arch …); use these recipes for the
  organic/parametric stuff the helpers cannot express.

## 0. Prelude (paste first)
```js
// ---------- prelude: helpers used by all recipes ----------
// built-ins: groundY(x,z) = natural ground (ignores plants, leaves, tree logs and your own builds);
// setSoft(x,y,z,b) = place only into air/grass/flowers; protect(box) = later sets inside are ignored
const soft = setSoft;
const emptyAt = (x, y, z) => isAir(get(x, y, z));
function ball(cx, cy, cz, r, b, ry = r, fn = set) {  // ellipsoid; fn = set | soft
  const R = Math.ceil(Math.max(r, ry));
  for (let x = -R; x <= R; x++) for (let y = -R; y <= R; y++) for (let z = -R; z <= R; z++)
    if ((x * x + z * z) / (r * r) + (y * y) / (ry * ry) <= 1) fn(cx + x, cy + y, cz + z, b);
}
function blob(cx, cy, cz, r, b, rough = 0.35, fn = set) { // noisy sphere (leaf clusters, rocks)
  const R = Math.ceil(r * (1 + rough));
  for (let x = -R; x <= R; x++) for (let y = -R; y <= R; y++) for (let z = -R; z <= R; z++) {
    const d = Math.hypot(x, y, z), n = noise3((cx + x) * 0.3, (cy + y) * 0.3, (cz + z) * 0.3);
    if (d <= r * (1 + rough * n)) fn(cx + x, cy + y, cz + z, b);
  }
}
function seg(a, b, r0, r1, blk) {                    // tapered tube from a to b
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) * 2));
  for (let i = 0; i <= n; i++) {
    const t = i / n, r = r0 + (r1 - r0) * t;
    const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    if (r < 0.75) set(p[0], p[1], p[2], blk); else ball(Math.round(p[0]), Math.round(p[1]), Math.round(p[2]), r, blk);
  }
}
function towardFacing(dx, dz) {                      // stair facing that rises toward direction (dx,dz)
  return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north');
}
const lerp = (a, b, t) => a + (b - a) * t;
// ---------- end prelude ----------
```

## 1. Organic broadleaf / hero tree (branching, root flares, clustered canopy)
```js
// PARAMS
const X = 0, Y = 1, Z = -12;       // base cell on top of the ground (Y = ground + 1, local)
const H = 14, R0 = 1.6;            // trunk length, trunk radius (hero tree: H 24-30, R0 3-4)
const DEPTH = 3;                   // branching levels
const WOOD = 'oak_wood';           // bark on all faces; spruce_wood/dark_oak_wood/birch_wood/cherry_wood
const LEAF = pattern('75%oak_leaves[persistent=true],25%azalea_leaves[persistent=true]');
function branch(p, d, len, r, depth) {
  const q = [p[0] + d[0] * len, p[1] + d[1] * len, p[2] + d[2] * len];
  seg(p, q, r, r * 0.75, WOOD);
  if (depth === 0) {                                   // leaf cluster at every tip + a few drooping leaves
    blob(q[0], q[1], q[2], 2.3 + rand() * 1.1, LEAF, 0.45, soft);
    for (let k = 0; k < 5; k++) soft(q[0] + randInt(-2, 2), q[1] - 3, q[2] + randInt(-2, 2), LEAF);
    return;
  }
  const kids = 2 + (rand() < 0.5 ? 1 : 0), yaw0 = rand() * Math.PI * 2;
  for (let k = 0; k < kids; k++) {                     // children fan out sideways and up
    const yaw = yaw0 + (k * Math.PI * 2) / kids + (rand() - 0.5) * 0.9, spread = 0.9 + rand() * 0.5;
    const nd = vec.norm([d[0] * 0.35 + Math.cos(yaw) * spread, d[1] * 0.45 + 0.3, d[2] * 0.35 + Math.sin(yaw) * spread]);
    branch(q, nd, len * (0.7 + rand() * 0.15), Math.max(0.5, r * 0.6), depth - 1);
  }
}
const lean = vec.norm([(rand() - 0.5) * 0.25, 1, (rand() - 0.5) * 0.25]);
branch([X, Y, Z], lean, H * 0.55, R0, DEPTH);
// root flares: 4-6 tapered roots that dive into the ground
const roots = 4 + Math.floor(rand() * 3);
for (let i = 0; i < roots; i++) {
  const a = (i / roots) * Math.PI * 2 + rand() * 0.5, L = R0 * 2.5 + rand() * 2;
  seg([X, Y + R0, Z], [X + Math.cos(a) * L, Y - 1, Z + Math.sin(a) * L], Math.max(0.8, R0 * 0.6), 0.5, WOOD);
}
log('tree at', X, Y, Z);
```

## 2. Bridges → use the built-in `bridge` build op (no script needed)
Walkable deck with half-slab steps (never a jump), rails, posts, piers to the ground, lanterns, suspension ropes:
```json
{"op":"bridge","from":[-12,1,-20],"to":[12,1,-20],"width":5,"profile":"arch","rise":3,"deck":"spruce_planks",
 "post":"stripped_spruce_log","supports":"stone_bricks","supportEvery":6,"lantern":"lantern"}
{"op":"bridge","from":[4,18,-26],"to":[24,16,-26],"width":3,"profile":"sag","sag":3,"deck":"spruce_planks","rope":"iron_chain","lantern":"lantern"}
```
`from`/`to` = the standing positions at both ends (deck block below). Curved-in-plan bridges: chain 2–3 straight
bridge ops (each segment's `to` = next `from`). Stone arch underneath: add an `arch` op below the deck.

## 3. Round tower with spiral stair, spiral windows and conical stair roof
```js
// PARAMS
const CX = 0, CZ = -15, Y0 = 0, R = 5, H = 22, PITCH = 1.6, OVER = 1;   // Y0 = ground level
const WALL = pattern({ type: 'gradient', axis: 'y', from: Y0, to: Y0 + H, dither: true, stops: ['mossy_stone_bricks', 'stone_bricks', 'stone_bricks', 'polished_andesite'] });
const STAIR = 'stone_brick_stairs', CORE = 'polished_andesite', GLASS = 'glass_pane';
const ROOF = 'deepslate_tile_stairs', ROOF_FILL = 'deepslate_tiles';
const ring = (d) => d <= R + 0.5 && d > R - 0.5;
for (let x = -R - 1; x <= R + 1; x++) for (let z = -R - 1; z <= R + 1; z++) {
  const d = Math.hypot(x, z);
  for (let y = Y0; y < Y0 + H; y++) {
    if (ring(d)) set(CX + x, y, CZ + z, WALL);
    else if (d <= R - 0.5 && (y === Y0 || y === Y0 + H - 1)) set(CX + x, y, CZ + z, 'spruce_planks'); // floor + top floor
  }
}
// spiral stair: 2 wide, counter-clockwise, one step per block of height, around a 1x1 core
const steps = H - 2, dA = 1 / (R - 2);                                   // ~1 block of arc per step
for (let i = 0; i < steps; i++) {
  const a = i * dA, y = Y0 + 1 + i, tx = -Math.sin(a), tz = Math.cos(a);
  for (const rr of [R - 2.5, R - 1.5]) set(CX + Math.cos(a) * rr, y, CZ + Math.sin(a) * rr, `${STAIR}[facing=${towardFacing(tx, tz)}]`);
  // window in the wall beside every 4th step
  if (i % 4 === 2 && y + 2 < Y0 + H - 1) for (const dy of [1, 2]) {
    const wx = Math.round(CX + Math.cos(a) * R), wz = Math.round(CZ + Math.sin(a) * R);
    set(wx, y + dy, wz, GLASS);
  }
}
for (let y = Y0 + 1; y < Y0 + H - 1; y++) set(CX, y, CZ, CORE);
// plinth (2 high, 1 out) and a corbelled ring under the roof: upside-down stairs facing the wall
for (let x = -R - 2; x <= R + 2; x++) for (let z = -R - 2; z <= R + 2; z++) {
  const d = Math.hypot(x, z); if (d <= R + 0.5 || d > R + 1.5) continue;
  set(CX + x, Y0, CZ + z, 'mossy_cobblestone'); set(CX + x, Y0 + 1, CZ + z, `${STAIR}[facing=${towardFacing(-x, -z)}]`);
  set(CX + x, Y0 + H - 2, CZ + z, `${STAIR}[half=top,facing=${towardFacing(-x, -z)}]`); set(CX + x, Y0 + H - 1, CZ + z, WALL);
}
// conical roof: stairs facing the center on the surface, fill below
const RR = R + 1 + OVER, TOP = Y0 + H;
for (let x = -RR; x <= RR; x++) for (let z = -RR; z <= RR; z++) {
  const d = Math.hypot(x, z); if (d > RR + 0.5) continue;
  const h = TOP + Math.floor((RR + 0.5 - d) * PITCH);
  set(CX + x, h, CZ + z, d < 0.5 ? ROOF_FILL : `${ROOF}[facing=${towardFacing(-x, -z)}]`);
  for (let y = h - 1; y >= Math.max(TOP, h - Math.ceil(PITCH) - 1); y--) set(CX + x, y, CZ + z, ROOF_FILL);
}
set(CX, TOP + Math.floor((RR + 0.5) * PITCH) + 1, CZ, 'lightning_rod[facing=up]');
log('tower top y', TOP, 'spire', TOP + Math.floor((RR + 0.5) * PITCH) + 1);
```

## 4. Ribbed dome on a drum (cathedral / observatory / palace)
```js
// PARAMS
const CX = 0, CY = 16, CZ = -20, R = 9, RIBS = 12, DRUM = 4;   // CY = springing line of the dome
const SHELL = pattern('70%waxed_oxidized_copper,20%waxed_weathered_copper,10%waxed_oxidized_cut_copper');
const RIB = 'smooth_quartz', DRUM_WALL = 'calcite', WIN = 'light_blue_stained_glass_pane';
for (let x = -R; x <= R; x++) for (let z = -R; z <= R; z++) {
  const dh = Math.hypot(x, z), ang = Math.atan2(z, x);
  // drum: vertical ring below the dome with tall windows between ribs
  if (dh <= R + 0.5 && dh > R - 0.5) for (let y = CY - DRUM; y < CY; y++) {
    const ribNear = Math.abs(Math.sin((ang * RIBS) / 2)) * dh < 0.9;
    const win = !ribNear && y > CY - DRUM && y < CY - 1 && Math.abs(Math.sin((ang * RIBS) / 2)) > 0.5;
    set(CX + x, y, CZ + z, ribNear ? RIB : win ? WIN : DRUM_WALL);
  }
  for (let y = 0; y <= R; y++) {
    const d = Math.hypot(x, y, z);
    if (d > R + 0.5 || d <= R - 0.6) continue;
    const onRib = Math.abs(Math.sin((ang * RIBS) / 2)) * dh < 0.75 && y < R - 1;
    set(CX + x, CY + y, CZ + z, onRib ? RIB : SHELL);
  }
}
// lantern cupola with oculus glass
for (let y = 1; y <= 3; y++) for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) set(CX + x, CY + R + y, CZ + z, 'quartz_pillar[axis=y]');
for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) set(CX + x, CY + R + 4, CZ + z, 'smooth_quartz_slab[type=bottom]');
set(CX, CY + R + 5, CZ, 'end_rod[facing=up]');
set(CX, CY + R, CZ, 'glass');
```

## 5. Terrain-following curtain wall with crenellations and corner towers
```js
// PARAMS: polyline (local x,z) — closed if first == last. readBox (default allowed box) must cover it.
const PTS = [[-30, -10], [30, -10], [30, -60], [-30, -60], [-30, -10]];
const H = 8, T = 3, TOPY = 48, BOTY = -32, TOWER_R = 4, TOWER_EXTRA = 5;
const WALL = pattern('50%stone_bricks,20%cracked_stone_bricks,15%mossy_stone_bricks,10%andesite,5%cobblestone');
const BASE = pattern('60%cobblestone,40%mossy_cobblestone');
const cells = new Map();                                  // "x,z" -> offset across the wall
for (let i = 0; i + 1 < PTS.length; i++) {
  const [ax, az] = PTS[i], [bx, bz] = PTS[i + 1], L = Math.hypot(bx - ax, bz - az);
  const ux = (bx - ax) / L, uz = (bz - az) / L;
  for (let t = 0; t <= L; t += 0.5) for (let o = -(T - 1) / 2; o <= (T - 1) / 2; o += 0.5) {
    const k = Math.round(ax + ux * t - uz * o) + ',' + Math.round(az + uz * t + ux * o);
    if (!cells.has(k) || Math.abs(o) > Math.abs(cells.get(k))) cells.set(k, o);
  }
}
for (const [k, o] of cells) {
  const [x, z] = k.split(',').map(Number), g = groundY(x, z), top = g + H;
  for (let y = g - 1; y <= top; y++) set(x, y, z, y <= g + 1 ? BASE : WALL);
  if (o <= -(T - 1) / 2 + 0.01 && (x + z) % 2 === 0) set(x, top + 1, z, WALL);        // merlons on the outer face
  if (o >= (T - 1) / 2 - 0.01) set(x, top + 1, z, 'stone_brick_wall');                  // inner parapet
}
for (const [tx, tz] of PTS) {                               // round towers at every vertex
  let g = 999; for (let a = 0; a < 6.3; a += 0.5) g = Math.min(g, groundY(Math.round(tx + Math.cos(a) * TOWER_R), Math.round(tz + Math.sin(a) * TOWER_R)));
  const top = g + H + TOWER_EXTRA;
  for (let x = -TOWER_R - 1; x <= TOWER_R + 1; x++) for (let z = -TOWER_R - 1; z <= TOWER_R + 1; z++) {
    const d = Math.hypot(x, z); if (d > TOWER_R + 0.5) continue;
    for (let y = g - 1; y <= top; y++) set(tx + x, y, tz + z, d > TOWER_R - 0.5 || y === top ? WALL : 'air');
    if (d > TOWER_R - 0.5 && (x + z) % 2 === 0) set(tx + x, top + 1, tz + z, WALL);
  }
}
log('wall cells', cells.size);
```

## 6. Meandering river with sloped banks
```js
// PARAMS: river runs from Z0 to Z1 around X0 (local). WATER_Y = water surface (local). readBox must cover it.
const X0 = 0, Z0 = 10, Z1 = -90, WIDTH = 7, DEPTH = 3, AMP = 10, WATER_Y = -1, TOPY = 48, BOTY = -32;
const BED = pattern('50%sand,30%gravel,20%clay'), BANK = pattern('55%grass_block,25%coarse_dirt,20%mud');
const path = [];
for (let z = Z0; z >= Z1; z -= 0.5) path.push([X0 + AMP * noise2(z * 0.035, 3.7) + AMP * 0.4 * noise2(z * 0.1, 9.1), z]);
const half = WIDTH / 2, bankW = 4;
for (let z = Math.min(Z0, Z1); z <= Math.max(Z0, Z1); z++) for (let x = X0 - AMP * 1.5 - half - bankW; x <= X0 + AMP * 1.5 + half + bankW; x++) {
  let dmin = 1e9; for (const [px, pz] of path) { if (Math.abs(pz - z) > half + bankW + 1) continue; dmin = Math.min(dmin, Math.hypot(px - x, pz - z)); }
  if (dmin > half + bankW) continue;
  const xi = Math.round(x), g = groundY(xi, z);
  if (dmin <= half) {                                          // channel
    const bottom = WATER_Y - Math.max(1, Math.round(DEPTH * (1 - (dmin / half) ** 2)));
    for (let y = g; y > WATER_Y; y--) set(xi, y, z, 'air');
    for (let y = bottom; y <= WATER_Y; y++) set(xi, y, z, 'water');
    set(xi, bottom - 1, z, BED(xi, bottom - 1, z));
    if (rand() < 0.08) set(xi, bottom, z, rand() < 0.5 ? 'seagrass' : 'tall_seagrass');
  } else {                                                     // banks: slope down to water level + 1
    const target = Math.round(lerp(WATER_Y + 1, g, (dmin - half) / bankW));
    if (g > target) { for (let y = g; y > target; y--) set(xi, y, z, 'air'); set(xi, target, z, BANK(xi, target, z)); }
    else if (g < target) for (let y = g + 1; y <= target; y++) set(xi, y, z, BANK(xi, y, z));
    if (rand() < 0.15) set(xi, target + 1, z, rand() < 0.6 ? 'short_grass' : 'sugar_cane');
  }
}
log('river path points', path.length);
```

## 7. Voronoi cobblestone path (irregular flagstones with mortar)
```js
// PARAMS: path polyline (local x,z), width; readBox must cover it.
const PTS = [[0, 4], [3, -10], [-2, -25], [6, -40]], WIDTH = 4, CELL = 2.6, TOPY = 48, BOTY = -32;
const STONES = ['cobblestone', 'andesite', 'stone', 'polished_andesite', 'tuff', 'mossy_cobblestone'];
const MORTAR = pattern('50%gravel,30%coarse_dirt,20%moss_block');
const seeds = [];
const minX = Math.min(...PTS.map((p) => p[0])) - WIDTH - 3, maxX = Math.max(...PTS.map((p) => p[0])) + WIDTH + 3;
const minZ = Math.min(...PTS.map((p) => p[1])) - WIDTH - 3, maxZ = Math.max(...PTS.map((p) => p[1])) + WIDTH + 3;
for (let x = minX; x <= maxX; x += CELL) for (let z = minZ; z <= maxZ; z += CELL)
  seeds.push([x + rand() * CELL, z + rand() * CELL, STONES[Math.floor(rand() * STONES.length)]]);
function distToPath(x, z) {
  let best = 1e9;
  for (let i = 0; i + 1 < PTS.length; i++) {
    const [ax, az] = PTS[i], [bx, bz] = PTS[i + 1], vx = bx - ax, vz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz)));
    best = Math.min(best, Math.hypot(x - ax - vx * t, z - az - vz * t));
  }
  return best;
}
for (let x = Math.floor(minX); x <= maxX; x++) for (let z = Math.floor(minZ); z <= maxZ; z++) {
  if (distToPath(x, z) > WIDTH / 2 + 0.8 * noise2(x * 0.4, z * 0.4)) continue;   // ragged edge
  let d1 = 1e9, d2 = 1e9, s1 = null;
  for (const s of seeds) { const d = Math.hypot(s[0] - x, s[1] - z); if (d < d1) { d2 = d1; d1 = d; s1 = s; } else if (d < d2) d2 = d; }
  const g = groundY(x, z);
  set(x, g, z, d2 - d1 < 0.55 ? MORTAR(x, g, z) : s1[2]);
  if (!isAir(get(x, g + 1, z))) set(x, g + 1, z, 'air');                           // remove plants on the path
}
```

## 8. Cherry blossom grove (spaced trees, umbrella canopies, petal carpet)
```js
// PARAMS: area (local), number of trees; readBox (default allowed box) must cover it.
const X0 = -20, X1 = 20, Z0 = -50, Z1 = -10, N = 7, MIN_GAP = 9, TOPY = 48, BOTY = -32;
const LEAF = pattern('88%cherry_leaves[persistent=true],12%flowering_azalea_leaves[persistent=true]');
const trees = [];
for (let tries = 0; trees.length < N && tries < 400; tries++) {
  const x = Math.round(lerp(X0 + 4, X1 - 4, rand())), z = Math.round(lerp(Z0 + 4, Z1 - 4, rand()));
  if (trees.every(([a, b]) => Math.hypot(a - x, b - z) >= MIN_GAP)) trees.push([x, z]);
}
const F = ['north', 'east', 'south', 'west'];
for (const [x, z] of trees) {
  const y = groundY(x, z) + 1, h = 5 + Math.floor(rand() * 3), lean = rand() * Math.PI * 2;
  const top = [x + Math.cos(lean) * 2, y + h, z + Math.sin(lean) * 2];
  seg([x, y, z], top, 1, 0.5, 'cherry_wood');
  for (let b = 0; b < 3; b++) {                                     // arching limbs
    const a = lean + (b - 1) * 2.1 + rand() * 0.5, len = 3 + rand() * 2;
    const tip = [top[0] + Math.cos(a) * len, top[1] + 1 + rand() * 2, top[2] + Math.sin(a) * len];
    seg(top, tip, 0.5, 0.5, 'cherry_wood');
    ball(Math.round(tip[0]), Math.round(tip[1]), Math.round(tip[2]), 3.2 + rand(), LEAF, 1.8, soft);   // flattened umbrella
    for (let k = 0; k < 6; k++) soft(tip[0] + randInt(-3, 3), tip[1] - 2, tip[2] + randInt(-3, 3), 'cherry_leaves[persistent=true]'); // drips
  }
  for (let k = 0; k < 40; k++) {                                     // petal carpet under the canopy
    const px = x + Math.round((rand() - 0.5) * 12), pz = z + Math.round((rand() - 0.5) * 12);
    const g = groundY(px, pz);
    if (/grass_block|moss_block|dirt/.test(get(px, g, pz))) soft(px, g + 1, pz, `pink_petals[facing=${F[randInt(0, 3)]},flower_amount=${randInt(1, 4)}]`);
  }
}
log('cherry trees at', JSON.stringify(trees));
```

## 9. Floating island with stalactites and hanging roots
```js
// PARAMS
const CX = 0, CY = 30, CZ = -30, R = 12, DEPTH = 14;    // CY = grass level of the island (local)
const ROCK = pattern({ type: 'gradient', axis: 'y', from: CY - DEPTH, to: CY, dither: true, stops: ['tuff', 'andesite', 'stone', 'stone', 'dirt'] });
const n2 = (x, z, s) => noise2(x * s, z * s);
for (let x = -R - 4; x <= R + 4; x++) for (let z = -R - 4; z <= R + 4; z++) {
  const rr = R * (1 + 0.28 * n2(x, z, 0.12)), d = Math.hypot(x, z); if (d > rr) continue;
  const t = d / rr, top = CY + Math.round(2 * (1 - t) * (0.5 + 0.5 * n2(x + 50, z, 0.15)));
  const bottom = CY - Math.round(DEPTH * (1 - t ** 1.4) * (0.75 + 0.25 * n2(x - 50, z, 0.2)));
  for (let y = bottom; y <= top; y++) set(CX + x, y, CZ + z, y === top ? 'grass_block' : y >= top - 2 ? 'dirt' : ROCK);
  if (t > 0.75 && rand() < 0.25) for (let k = 1; k <= randInt(1, 4); k++) set(CX + x, bottom - k, CZ + z, 'hanging_roots');
  if (t < 0.55 && rand() < 0.05) {                       // dripstone stalactite under the belly
    const len = randInt(2, 5);
    for (let k = 1; k <= len; k++) set(CX + x, bottom - k, CZ + z, `pointed_dripstone[vertical_direction=down,thickness=${k === len ? 'tip' : k === len - 1 ? 'frustum' : k === 1 ? 'base' : 'middle'}]`);
  }
  if (t < 0.8 && rand() < 0.06) set(CX + x, top + 1, CZ + z, rand() < 0.7 ? 'short_grass' : 'poppy');
}
// waterfall: one water source on the rim, e.g. set(CX + R - 1, CY + 1, CZ, 'water') — falls in the real game, static in the sim
log('island bottom tip ~', CY - DEPTH);
```

## 10. Gothic rose window (vertical, in the x/y plane at z = Z)
```js
// PARAMS: center of the window on the facade plane; radius
const CX = 0, CY = 14, Z = -8, R = 7, SPOKES = 12;
const STONE = 'polished_deepslate', COLORS = ['red_stained_glass_pane', 'blue_stained_glass_pane', 'purple_stained_glass_pane', 'yellow_stained_glass_pane'];
for (let x = -R; x <= R; x++) for (let y = -R; y <= R; y++) {
  const d = Math.hypot(x, y); if (d > R + 0.5) continue;
  const a = Math.atan2(y, x), sector = Math.floor(((a + Math.PI) / (2 * Math.PI)) * SPOKES) % SPOKES;
  const spoke = Math.abs(Math.sin((a * SPOKES) / 2)) * d < 0.6 && d > 1.5;
  const rings = d > R - 0.5 || Math.abs(d - 1.5) < 0.5 || Math.abs(d - R * 0.62) < 0.45;
  // petals: small circles between the spokes in the outer band
  const pa = (Math.floor(((a + Math.PI) / (2 * Math.PI)) * SPOKES) + 0.5) * ((2 * Math.PI) / SPOKES) - Math.PI;
  const pr = R * 0.81, pd = Math.hypot(x - Math.cos(pa) * pr, y - Math.sin(pa) * pr);
  const petalEdge = Math.abs(pd - R * 0.17) < 0.45;
  let b;
  if (rings || spoke || petalEdge) b = STONE;
  else if (d < 1.5) b = 'yellow_stained_glass_pane';
  else if (d < R * 0.62) b = COLORS[sector % 2];
  else b = pd < R * 0.17 ? COLORS[2 + (sector % 2)] : COLORS[(sector + 1) % 2];
  set(CX + x, CY + y, Z, b);
}
```

## 11. Sculpted ocean waves (wave field with foam crests)
```js
// PARAMS: a heightfield sculpture / stylized sea around a lighthouse or a decorative plaza
const X0 = -25, X1 = 25, Z0 = -60, Z1 = -20, BASEY = -1, AMP = 3;
for (let x = X0; x <= X1; x++) for (let z = Z0; z <= Z1; z++) {
  const ph = x * 0.35 + 1.2 * noise2(x * 0.05, z * 0.05);
  const w = Math.sin(ph) * 0.65 + Math.sin(z * 0.22 + x * 0.1) * 0.35;          // -1..1
  const h = Math.round(BASEY + AMP * (w + 1) / 2), crest = w > 0.75;
  for (let y = BASEY - 2; y <= h; y++) {
    const rel = (y - BASEY) / (AMP + 0.01);
    set(x, y, z, y === h && crest ? (rand() < 0.6 ? 'white_concrete' : 'snow_block')
      : rel > 0.66 ? 'light_blue_concrete' : rel > 0.33 ? 'cyan_terracotta' : 'blue_concrete');
  }
  if (crest && rand() < 0.3) set(x, h + 1, z, 'white_concrete_slab[type=bottom]');    // spray
}
```

## 12. Procedural village layout (roads + plot boxes for subagents)
```js
// PARAMS: plaza center, road arms, plot size. Outputs plots via log() → brief one subagent per plot.
const CX = 0, CZ = -45, PLAZA_R = 6, ARMS = 4, ARM_LEN = 34, PLOT = [11, 13], GAP = 3, TOPY = 48, BOTY = -32;
const ROAD = pattern('50%dirt_path,25%coarse_dirt,15%gravel,10%packed_mud');
const plots = [];
for (let a = 0; a < ARMS; a++) {
  const ang = (a / ARMS) * Math.PI * 2 + 0.4 + (rand() - 0.5) * 0.4;
  let px = CX + Math.cos(ang) * PLAZA_R, pz = CZ + Math.sin(ang) * PLAZA_R, dir = ang;
  for (let s = 0; s < ARM_LEN; s++) {                                    // wandering road, 3 wide
    dir += (noise2(a * 10, s * 0.08) * 0.08);
    px += Math.cos(dir); pz += Math.sin(dir);
    for (let o = -1; o <= 1; o++) { const x = Math.round(px - Math.sin(dir) * o), z = Math.round(pz + Math.cos(dir) * o); const g = groundY(x, z); set(x, g, z, ROAD(x, g, z)); }
    if (s % (PLOT[0] + GAP) === 8) for (const side of [-1, 1]) {        // plots on both sides, front faces the road
      const off = 2 + GAP + PLOT[1] / 2, cx = Math.round(px - Math.sin(dir) * off * side), cz = Math.round(pz + Math.cos(dir) * off * side);
      const box = { min: [cx - (PLOT[0] >> 1), 0, cz - (PLOT[1] >> 1)], max: [cx + (PLOT[0] >> 1), 0, cz + (PLOT[1] >> 1)] };
      if (plots.some((p) => box.min[0] <= p.box.max[0] + GAP && box.max[0] >= p.box.min[0] - GAP && box.min[2] <= p.box.max[2] + GAP && box.max[2] >= p.box.min[2] - GAP)) continue;
      const g = groundY(cx, cz); box.min[1] = g - 2; box.max[1] = g + 22;
      plots.push({ box, front: towardFacing(px - cx, pz - cz), ground: g });
    }
  }
}
for (let x = -PLAZA_R; x <= PLAZA_R; x++) for (let z = -PLAZA_R; z <= PLAZA_R; z++) if (Math.hypot(x, z) <= PLAZA_R + 0.3) {
  const g = groundY(CX + x, CZ + z); set(CX + x, g, CZ + z, (x + z) % 3 ? 'cobblestone' : 'andesite');
}
log('PLOTS', JSON.stringify(plots));   // front = facade direction (toward the road), in local space
```

## 13. Boulder cluster (one big + satellites, half buried, mossy tops)
```js
const X = 8, Y = 0, Z = -18, BIG = 3.5;                     // Y = ground level (local)
const ROCK = (x, y, z) => (y > Y + BIG * 0.6 && rand() < 0.6 ? 'mossy_cobblestone' : ['stone', 'andesite', 'tuff', 'cobblestone'][Math.floor((noise3(x * 0.4, y * 0.4, z * 0.4) + 1) * 2) % 4]);
blob(X, Y, Z, BIG, ROCK, 0.3);
for (let i = 0; i < 3; i++) { const a = rand() * 6.28, d = BIG + 1 + rand() * 2; blob(Math.round(X + Math.cos(a) * d), Y - 1, Math.round(Z + Math.sin(a) * d), 1.2 + rand() * 1.2, ROCK, 0.3); }
for (let i = 0; i < 10; i++) soft(X + randInt(-6, 6), Y + 1, Z + randInt(-6, 6), rand() < 0.5 ? 'fern' : 'short_grass');
```

## 14. Treehouse kit: platform around a trunk, wrap-around stair with a stairwell (bridges: `bridge` op)
```js
// PARAMS: trunk center + radius (trunk already built, e.g. recipe 1 with R0 3-4), platform height
const TX = 0, TZ = -20, TR = 3, PY = 18, PR = 7, GROUND = groundY(TX + TR + 2, TZ);
const FLOOR = pattern('70%spruce_planks,30%stripped_spruce_wood');
// 1) stair spiralling around the trunk from the ground up to the platform (2 wide, trapdoor undersides)
const rs = TR + 1.5, rise = PY - GROUND, dA = 1 / rs, steps = [];
for (let i = 0; i < rise; i++) {
  const a = i * dA, y = GROUND + 1 + i;
  for (const r of [rs, rs + 1]) { const x = TX + Math.cos(a) * r, z = TZ + Math.sin(a) * r; set(x, y, z, `spruce_stairs[facing=${towardFacing(-Math.sin(a), Math.cos(a))}]`); steps.push([Math.round(x), y, Math.round(z)]); }
  set(TX + Math.cos(a) * (rs + 1), y - 1, TZ + Math.sin(a) * (rs + 1), 'spruce_trapdoor[half=top]');
}
// 2) stairwell: keep 3 blocks of headroom above the top steps, then protect it from the platform
const well = steps.filter(([, y]) => y >= PY - 3);
for (const [x, y, z] of well) for (let h = 1; h <= 3; h++) if (y + h >= PY - 1) { set(x, y + h, z, 'air'); protect({ min: [x, y + h, z], max: [x, y + h, z] }); }
// 3) ring platform with railing, braces and hanging lanterns
for (let x = -PR; x <= PR; x++) for (let z = -PR; z <= PR; z++) {
  const d = Math.hypot(x, z); if (d > PR + 0.5 || d <= TR + 0.5) continue;
  set(TX + x, PY, TZ + z, FLOOR);
  if (d > PR - 0.5) set(TX + x, PY + 1, TZ + z, 'spruce_fence');
}
for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; seg([TX + Math.cos(a) * (TR + 0.5), PY - 4, TZ + Math.sin(a) * (TR + 0.5)], [TX + Math.cos(a) * (PR - 1), PY - 1, TZ + Math.sin(a) * (PR - 1)], 0.5, 0.5, 'stripped_spruce_wood'); }
for (let k = 0; k < 4; k++) { const a = (k / 4) * Math.PI * 2 + 0.4; set(TX + Math.cos(a) * (PR - 1), PY - 1, TZ + Math.sin(a) * (PR - 1), 'lantern[hanging=true]'); }
unprotect();
log('platform y', PY, 'stairwell cells', well.length, '— protect({min:[TX-PR,PY,TZ-PR],max:[TX+PR,PY+6,TZ+PR]}) in later canopy scripts');
```
Connect platforms with `{"op":"bridge","from":[..],"to":[..],"profile":"sag","rope":"iron_chain","deck":"spruce_planks"}`.
In later canopy/branch scripts call `protect(houseBox)` first so leaves and limbs never fill pods, stairs or bridges.

## 15. Swept (concave) roof with lifted corners — japanese / fantasy halls
```js
// PARAMS: wall footprint (local, inclusive), EY = y of the wall top; ridge runs along x
const X0 = -7, X1 = 7, Z0 = -24, Z1 = -14, EY = 8, OVER = 2, RISE = 6, SWEEP = 1.4, LIFT = 1.2;
const ST = 'deepslate_tile_stairs', SL = 'deepslate_tile_slab', FILL = 'deepslate_tiles';
const zc = (Z0 + Z1) / 2, D = (Z1 - Z0) / 2 + OVER, xc = (X0 + X1) / 2, hx = (X1 - X0) / 2;
function hAt(x, z) {                                   // roof surface height (fractional)
  const d = Math.max(0, D - Math.abs(z - zc)) / D;     // 0 at the eave → 1 at the ridge
  const ends = Math.min(1, Math.max(0, Math.abs(x - xc) - (hx - 1)) / (OVER + 1)); // 0..1 toward gable ends
  return EY + RISE * Math.pow(d, SWEEP) + LIFT * ends * (1 - d);   // concave sweep + corner lift
}
for (let x = X0 - OVER; x <= X1 + OVER; x++) for (let z = Z0 - OVER; z <= Z1 + OVER; z++) {
  const yf = hAt(x, z), y = Math.floor(yf), frac = yf - y;
  const outer = z + (z < zc ? -1 : 1), yo = Math.floor(hAt(x, outer));   // neighbour toward the eave
  for (let k = y - 1; k > yo; k--) set(x, k, z, FILL);                    // close vertical gaps on steep parts
  if (Math.abs(z - zc) < 0.6) { set(x, yo + 1, z, FILL); set(x, yo + 2, z, `${SL}[type=bottom]`); continue; } // ridge + cap
  const steep = hAt(x, z + (z < zc ? 1 : -1)) - yf >= 0.75;               // inner neighbour much higher → stair
  set(x, y, z, frac < 0.5 && !steep ? `${SL}[type=bottom]` : `${ST}[facing=${z < zc ? 'south' : 'north'}]`);
}
// finish: gable walls inset 1 block, brackets (stairs half=top facing the wall) under the overhang
```
