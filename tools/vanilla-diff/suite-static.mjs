// Suite "static": per-state facts of the real 26.3 classes (Probe.java) vs the engine — the
// registry physics table itself, registry.isFullSolid / isTransparent, connect.ts sturdy faces,
// connection exceptions, conductors and wall coverage, support.ts face table (FULL / CENTER /
// RIGID). Exhaustive over every block state of the registry (no sampling, no server needed).
// The engine reads these facts from the physics table, so this suite is the regression test for
// engine/data/physics-26.3.json and for the mod's hello physics (the "live" registry).
import { Registry } from '../../engine/src/core/registry.ts';
import { connectorFor } from '../../engine/src/core/connect.ts';
import { faceSupport, FULL, CENTER, RIGID } from '../../engine/src/core/support.ts';
import { bit, DIR_ORDER } from './probe.mjs';
import { classOfProbe } from './gen-physics.mjs';

const H = ['north', 'east', 'south', 'west'];

/** group per (check, block id): count states, keep 2 examples */
class Groups {
  constructor() { this.m = new Map(); this.tested = 0; }
  add(check, state, detail) {
    const id = state.replace(/\[.*$/, '');
    const k = `${check}|${id}`;
    let g = this.m.get(k);
    if (!g) this.m.set(k, (g = { check, id, states: 0, examples: [] }));
    g.states++;
    if (g.examples.length < 2) g.examples.push({ state, ...detail });
  }
  list() { return [...this.m.values()].sort((a, b) => a.check.localeCompare(b.check) || b.states - a.states || a.id.localeCompare(b.id)); }
}

export function runStatic({ probe, reg = Registry.loadDefault(), log = console.log }) {
  const conn = connectorFor(reg);
  const g = new Groups();
  const counts = {};
  const inc = (k) => (counts[k] = (counts[k] ?? 0) + 1);
  let states = 0;
  for (const [s, v] of probe) {
    if (!reg.has(s)) { g.add('missing-in-engine-registry', s, {}); continue; }
    states++;
    // 0. the registry physics (hello table or bundled engine/data/physics-26.3.json) = the real facts
    inc('physics');
    const ph = reg.physics(s);
    const want = classOfProbe(v);
    if (!ph || ph.join(',') !== want.join(',')) g.add('physics', s, { engine: ph, vanilla: want });
    // 1. isFullSolid = "occupies the full cube": every face FULL-sturdy or a full-cube collision shape
    const vFull = v.full === 63 || v.colFull;
    const eFull = reg.isFullSolid(s);
    inc('isFullSolid');
    if (vFull !== eFull) g.add('isFullSolid', s, { engine: eFull, vanilla: vFull, vanillaSturdyFaces: DIR_ORDER.filter((d) => bit(v.full, d)).join(',') || 'none', colFull: v.colFull });
    // 2. isTransparent = !isSolidRender (vanilla: a solid-render block hides the neighbour's faces)
    const eTr = reg.isTransparent(s);
    inc('isTransparent');
    if (eTr === v.solidRender) g.add('isTransparent', s, { engine: eTr, vanillaSolidRender: v.solidRender, occlude: v.occlude });
    // 3. connect.ts sturdy faces (FenceBlock/IronBarsBlock/WallBlock use isFaceSturdy(…, FULL))
    for (const d of [...H, 'up', 'down']) {
      inc('connect.sturdyFace');
      const e = conn.sturdyFace(s, d);
      const vv = bit(v.full, d);
      if (e !== vv) g.add(`connect.sturdyFace.${H.includes(d) ? 'side' : d}`, s, { face: d, engine: e, vanilla: vv });
    }
    // 4. connection exceptions (Block.isExceptionForConnection)
    inc('connect.exception');
    const ex = conn.classify(s).exception;
    if (ex !== v.exception) g.add('connect.exception', s, { engine: ex, vanilla: v.exception });
    // 5. support.ts face table: FULL / CENTER / RIGID bits ⇔ isFaceSturdy(FULL / CENTER / RIGID)
    for (const d of DIR_ORDER) {
      const f = faceSupport(s, d, reg);
      const side = d === 'up' || d === 'down' ? d : 'side';
      inc('support.face');
      const vF = bit(v.full, d), vC = bit(v.center, d), vR = bit(v.rigid, d);
      if (((f & FULL) === FULL) !== vF) g.add(`support.faceFULL.${side}`, s, { face: d, engine: f, vanillaFull: vF, vanillaCenter: vC, vanillaRigid: vR });
      if (((f & CENTER) === CENTER) !== vC) g.add(`support.faceCENTER.${side}`, s, { face: d, engine: f, vanillaFull: vF, vanillaCenter: vC });
      if (((f & RIGID) === RIGID) !== vR) g.add(`support.faceRIGID.${side}`, s, { face: d, engine: f, vanillaRigid: vR });
    }
    // 6. redstone conductor (connect.ts) and signal sources (wire side connections)
    inc('conductor');
    const eCond = conn.isConductor(s);
    if (eCond !== v.conductor) g.add('conductor', s, { engine: eCond, vanilla: v.conductor });
    // 7. walls: tall arms / post under this block (bottom collision face vs WallBlock test shapes)
    inc('wall.cover');
    const cov = conn.wallCover(s);
    const vArms = H.filter((d) => bit(v.wallArms, d)).join(',');
    const eArms = H.filter((d) => cov.arms[d]).join(',');
    if (cov.post !== v.wallPost || vArms !== eArms) g.add('wall.cover', s, { engine: { post: cov.post, arms: eArms }, vanilla: { post: v.wallPost, arms: vArms } });
  }
  const groups = g.list();
  const byCheck = {};
  for (const x of groups) {
    const c = (byCheck[x.check] ??= { blocks: 0, states: 0 });
    c.blocks++;
    c.states += x.states;
  }
  log(`  static: ${states} states compared${reg.hasPhysics() ? '' : ' (registry WITHOUT physics → heuristics)'}`);
  if (!groups.length) log('    no differences');
  for (const [k, c] of Object.entries(byCheck)) log(`    ${k.padEnd(34)} ${String(c.blocks).padStart(4)} blocks / ${String(c.states).padStart(6)} states differ`);
  return { states, checks: counts, byCheck, groups };
}
