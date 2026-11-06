#!/usr/bin/env node
// Generates engine/data/physics-26.3.json (the simulation's "registry physics", ARCHITECTURE §5)
// from the Probe.java dump of the REAL 26.3 server classes — the same facts the mod sends in hello.
//
//   node tools/vanilla-diff/gen-physics.mjs [--check]     (--check: fail if the file is out of date)
//
// Property value order follows engine/data/registry-26.3.json (the table is self-describing, so the
// order only has to be consistent inside the file).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPhysicsTable, PF } from '../../engine/src/core/physics.ts';
import { parseBlockState } from '../../engine/src/core/blockstate.ts';
import { ROOT } from './lib.mjs';
import { loadProbe } from './probe.mjs';

export const PHYSICS_FILE = join(ROOT, 'engine/data/physics-26.3.json');

/** probe line → physics class tuple (field order of engine/src/core/physics.ts) */
export function classOfProbe(v) {
  let flags = 0;
  if (v.solidRender) flags |= PF.SOLID_RENDER;
  if (v.legacySolid) flags |= PF.LEGACY_SOLID;
  if (v.conductor) flags |= PF.CONDUCTOR;
  if (v.replaceable) flags |= PF.REPLACEABLE;
  if (v.colFull) flags |= PF.COLLISION_FULL;
  if (v.signal) flags |= PF.SIGNAL_SOURCE;
  if (v.colUp) flags |= PF.COLLISION_TOP;
  if (v.skylight) flags |= PF.SKYLIGHT;
  if (v.wallPost) flags |= PF.WALL_POST;
  // probe wallArms uses direction bits (north=2, south=3, west=4, east=5) → flag bits 9..12
  for (let i = 2; i < 6; i++) if ((v.wallArms >> i) & 1) flags |= 1 << (9 + i - 2);
  return [v.full, v.center, v.rigid, v.colFace, v.supFace, flags];
}

export function generatePhysics(probe, registry) {
  const byId = new Map();
  for (const [s, v] of probe) {
    const p = parseBlockState(s);
    let l = byId.get(p.name);
    if (!l) byId.set(p.name, (l = []));
    l.push({ props: p.props, cls: classOfProbe(v) });
  }
  const blocks = [];
  for (const id of Object.keys(registry.blocks).sort()) {
    const states = byId.get(id);
    if (!states) continue;
    const info = registry.blocks[id];
    const props = Object.keys(info.properties).sort().map((n) => [n, info.properties[n]]);
    blocks.push({ id, props, states });
  }
  return buildPhysicsTable(blocks);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const probe = loadProbe();
  const registry = JSON.parse(readFileSync(join(ROOT, 'engine/data/registry-26.3.json'), 'utf8'));
  const table = generatePhysics(probe, registry);
  const json = JSON.stringify(table);
  if (process.argv.includes('--check')) {
    const cur = readFileSync(PHYSICS_FILE, 'utf8').trim();
    if (cur !== json) { console.error('engine/data/physics-26.3.json is out of date — run node tools/vanilla-diff/gen-physics.mjs'); process.exit(1); }
    console.log('physics-26.3.json up to date');
  } else {
    writeFileSync(PHYSICS_FILE, json + '\n');
    console.log(`wrote ${PHYSICS_FILE}: ${Object.keys(table.blocks).length} blocks, ${table.classes.length} classes, ${json.length} bytes`);
  }
}
