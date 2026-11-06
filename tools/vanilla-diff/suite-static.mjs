// Suite "static": per-state facts of the real 26.3 classes (Probe.java) vs the engine's
// heuristics — registry.isFullSolid / isTransparent, connect.ts sturdy faces + connection
// exceptions, support.ts face table (FULL / CENTER), redstone conductors. Exhaustive over every
// block state of the registry (no sampling, no server needed).
import { Registry } from '../../engine/src/core/registry.ts';
import { connectorFor } from '../../engine/src/core/connect.ts';
import { faceSupport, FULL, CENTER } from '../../engine/src/core/support.ts';
import { bit, DIR_ORDER } from './probe.mjs';

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
    // 1. isFullSolid = "full cube with a sturdy (FULL) face on every side"
    const vFull = v.full === 63;
    const eFull = reg.isFullSolid(s);
    inc('isFullSolid');
    if (vFull !== eFull) g.add('isFullSolid', s, { engine: eFull, vanilla: vFull, vanillaSturdyFaces: DIR_ORDER.filter((d) => bit(v.full, d)).join(',') || 'none', colFull: v.colFull });
    // 2. isTransparent ≈ !isSolidRender (vanilla: a solid-render block hides the neighbour's faces)
    const eTr = reg.isTransparent(s);
    inc('isTransparent');
    if (eTr === v.solidRender) g.add('isTransparent', s, { engine: eTr, vanillaSolidRender: v.solidRender, occlude: v.occlude });
    // 3. connect.ts sturdy faces (FenceBlock/IronBarsBlock/WallBlock use isFaceSturdy(…, FULL)) — horizontal faces matter
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
    // 5. support.ts face table: FULL ⇔ isFaceSturdy FULL, ≥CENTER ⇔ isFaceSturdy CENTER
    for (const d of DIR_ORDER) {
      const f = faceSupport(s, d, reg);
      inc('support.face');
      const vF = bit(v.full, d), vC = bit(v.center, d);
      if ((f >= FULL) !== vF) g.add(`support.faceFULL.${d === 'up' || d === 'down' ? d : 'side'}`, s, { face: d, engine: f, vanillaFull: vF, vanillaCenter: vC, vanillaRigid: bit(v.rigid, d) });
      if ((f >= CENTER) !== vC) g.add(`support.faceCENTER.${d === 'up' || d === 'down' ? d : 'side'}`, s, { face: d, engine: f, vanillaFull: vF, vanillaCenter: vC });
    }
    // 5b. rule-specific support types: rails/repeaters/comparators need RIGID up (engine: FULL);
    //     vines/glow lichen/sculk vein/resin and snow layers use Block.isFaceFull(collision shape)
    {
      const f = faceSupport(s, 'up', reg);
      inc('support.rule');
      if ((f >= FULL) !== bit(v.rigid, 'up')) g.add('support.rule.RIGID-up(rails,diodes)', s, { engine: f, vanillaRigid: bit(v.rigid, 'up'), vanillaFull: bit(v.full, 'up') });
      for (const d of DIR_ORDER) {
        const fd = faceSupport(s, d, reg);
        if ((fd >= FULL) !== bit(v.colFace, d)) g.add(`support.rule.collisionFace(multiface,snow).${d === 'up' || d === 'down' ? d : 'side'}`, s, { face: d, engine: fd, vanillaCollisionFaceFull: bit(v.colFace, d) });
      }
    }
    // 6. redstone conductor (connect.ts: full && !transparent)
    inc('conductor');
    const eCond = eFull && !eTr;
    if (eCond !== v.conductor) g.add('conductor', s, { engine: eCond, vanilla: v.conductor });
  }
  const groups = g.list();
  const byCheck = {};
  for (const x of groups) {
    const c = (byCheck[x.check] ??= { blocks: 0, states: 0 });
    c.blocks++;
    c.states += x.states;
  }
  log(`  static: ${states} states compared`);
  for (const [k, c] of Object.entries(byCheck)) log(`    ${k.padEnd(34)} ${String(c.blocks).padStart(4)} blocks / ${String(c.states).padStart(6)} states differ`);
  return { states, checks: counts, byCheck, groups };
}
