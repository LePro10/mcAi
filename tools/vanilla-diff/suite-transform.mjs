// Suite "transform": engine transform.ts rotateState / mirrorState vs the real 26.3
// BlockState.rotate(Rotation) / mirror(Mirror) for EVERY block state with properties (Probe.java
// executes the vanilla methods — the same ones StructureTemplate / `place template` use).
// Mapping: engine turns 1/2/3 = CLOCKWISE_90 / CLOCKWISE_180 / COUNTERCLOCKWISE_90;
// engine mirror 'x' (flip x, east<->west) = Mirror.FRONT_BACK; 'z' (flip z) = Mirror.LEFT_RIGHT.
import { Registry } from '../../engine/src/core/registry.ts';
import { rotateState, mirrorState } from '../../engine/src/core/transform.ts';
import { parseBlockState } from '../../engine/src/core/blockstate.ts';

function diffProps(a, b) {
  const pa = parseBlockState(a).props, pb = parseBlockState(b).props;
  return Object.keys({ ...pa, ...pb }).filter((k) => pa[k] !== pb[k]);
}

export function runTransform({ probe, reg = Registry.loadDefault(), log = console.log }) {
  const groups = new Map();
  let tested = 0, cases = 0, bad = 0;
  const ops = [
    ['rot90', (s) => rotateState(s, 1, reg), (v) => v.rot[0]],
    ['rot180', (s) => rotateState(s, 2, reg), (v) => v.rot[1]],
    ['rot270', (s) => rotateState(s, 3, reg), (v) => v.rot[2]],
    ['mirrorX(FRONT_BACK)', (s) => mirrorState(s, 'x', reg), (v) => v.mirFB],
    ['mirrorZ(LEFT_RIGHT)', (s) => mirrorState(s, 'z', reg), (v) => v.mirLR],
  ];
  for (const [s, v] of probe) {
    if (!v.rot || !reg.has(s)) continue;
    tested++;
    for (const [op, eng, van] of ops) {
      cases++;
      let e;
      try { e = eng(s); } catch (err) { e = `ERROR ${err.message}`; }
      const want = van(v);
      if (e === want) continue;
      bad++;
      const props = e.startsWith('ERROR') ? ['(error)'] : diffProps(e, want);
      const id = s.replace(/\[.*$/, '');
      const k = `${op}|${id}|${props.join(',')}`;
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { op, id, props, cls: v.cls, states: 0, examples: [] }));
      g.states++;
      if (g.examples.length < 2) g.examples.push({ state: s, engine: e, vanilla: want });
    }
  }
  const list = [...groups.values()].sort((a, b) => b.states - a.states);
  // collapse per block class + op + props for the summary
  const byFamily = new Map();
  for (const x of list) {
    const k = `${x.cls}|${x.op}|${x.props.join(',')}`;
    let f = byFamily.get(k);
    if (!f) byFamily.set(k, (f = { cls: x.cls, op: x.op, props: x.props, blocks: [], states: 0, example: x.examples[0] }));
    f.blocks.push(x.id);
    f.states += x.states;
  }
  const families = [...byFamily.values()].sort((a, b) => b.states - a.states);
  log(`  transform: ${tested} states × 5 ops = ${cases} cases, ${bad} mismatches in ${families.length} families`);
  for (const f of families.slice(0, 25)) log(`    ${f.cls}.${f.op} [${f.props.join(',')}] — ${f.blocks.length} blocks / ${f.states} states, e.g. ${f.example.state} → engine ${f.example.engine} | vanilla ${f.example.vanilla}`);
  return { states: tested, cases, mismatches: bad, families, groups: list };
}
