#!/usr/bin/env node
// Differential test harness: engine re-implementations of vanilla rules vs the REAL Minecraft 26.3.
// See docs/VANILLA-DIFF.md for method, findings and how to read the report.
//
//   node tools/vanilla-diff.mjs [--suite static|transform|connect|support|all] [--seed N]
//                               [--scenes N] [--keep-server] [--stop-server] [--report FILE]
//                               [--regenerate-probe]
//
// Suites:
//   static     per-state facts executed in the real 26.3 classes (Probe.java: isFaceSturdy
//              FULL/CENTER/RIGID, collision faces, solid render, redstone conductor …) vs
//              registry.isFullSolid / isTransparent, connect.ts sturdy faces, support.ts face table
//   transform  every state's vanilla BlockState.rotate/mirror vs engine transform.ts
//   connect    randomized scenes placed in the real world with vanilla shape updates vs
//              engine solveConnections (needs the test server)
//   support    survival: each attachable placed next to a candidate support, then a real vanilla
//              neighbour update (setblock) decides whether it pops; vs engine support.ts verdicts
//              (needs the test server)
// Server suites start tools/testserver.sh themselves (lock /tmp/mcai-testserver.lock, private
// MCAI_HOME so ~/.mcai/engine.json is never touched, port 25599) and stop it again unless
// --keep-server (then the next run re-attaches to it; --stop-server stops it).
import { writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Registry } from '../engine/src/core/registry.ts';
import { ROOT, LOCK, startServer, prepareWorld, attachServer } from './vanilla-diff/lib.mjs';
import { loadProbe } from './vanilla-diff/probe.mjs';
import { runStatic } from './vanilla-diff/suite-static.mjs';
import { runTransform } from './vanilla-diff/suite-transform.mjs';
import { runConnect, AREA as CONNECT_AREA } from './vanilla-diff/suite-connect.mjs';
import { runSupport, BOUNDS as SUPPORT_BOUNDS } from './vanilla-diff/suite-support.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const flag = (k) => args.includes(k);
const suiteArg = opt('--suite', 'all');
const suites = suiteArg === 'all' ? ['static', 'transform', 'connect', 'support'] : suiteArg.split(',');
const seed = Number(opt('--seed', '1'));
const scenes = Number(opt('--scenes', '0')) || undefined;
const reportFile = opt('--report', join(ROOT, 'tools/vanilla-diff/last-report.json'));

if (flag('--stop-server')) {
  const r = spawnSync(join(ROOT, 'tools/testserver.sh'), ['stop'], { stdio: 'inherit' });
  try { if (JSON.parse(readFileSync(LOCK, 'utf8')).owner?.startsWith('tools/vanilla-diff')) rmSync(LOCK, { force: true }); } catch {}
  process.exit(r.status ?? 0);
}

const report = { generated: new Date().toISOString(), seed, suites: {} };
const t0 = Date.now();
console.log(`vanilla-diff: suites ${suites.join(', ')} (seed ${seed})`);
const probe = loadProbe({ regenerate: flag('--regenerate-probe') });

if (suites.includes('static')) {
  console.log('\n# static');
  report.suites.static = runStatic({ probe, reg: Registry.loadDefault() });
}
if (suites.includes('transform')) {
  console.log('\n# transform');
  report.suites.transform = runTransform({ probe, reg: Registry.loadDefault() });
}

const serverSuites = suites.filter((s) => s === 'connect' || s === 'support');
if (serverSuites.length) {
  console.log('\n# test server');
  const srv = (await attachServer()) ?? (await startServer());
  try {
    const reg = new Registry(srv.hello.registry);
    // forceload both test areas (connect: 16 × 16 scenes of pitch 8; support: BOUNDS) — < 256 chunks
    const area = { x0: Math.min(CONNECT_AREA.x0, SUPPORT_BOUNDS.x0) - 2, z0: Math.min(CONNECT_AREA.z0, SUPPORT_BOUNDS.z0) - 2,
      x1: Math.max(CONNECT_AREA.x0 + CONNECT_AREA.cols * CONNECT_AREA.pitch, SUPPORT_BOUNDS.x1) + 2, z1: SUPPORT_BOUNDS.z1 + 2 };
    for (const line of await prepareWorld(srv.engine, area)) console.log(`  ${line}`);
    report.server = { mod: srv.hello.modVersion, mc: srv.hello.mcVersion };
    if (serverSuites.includes('connect')) {
      console.log('\n# connect');
      report.suites.connect = await runConnect({ engine: srv.engine, reg, probe, seed, scenes: scenes ?? 256 });
    }
    if (serverSuites.includes('support')) {
      console.log('\n# support');
      report.suites.support = await runSupport({ engine: srv.engine, reg, probe, seed, cases: scenes });
    }
  } finally {
    await srv.stop({ keep: flag('--keep-server') });
  }
}

report.seconds = Math.round((Date.now() - t0) / 1000);
writeFileSync(reportFile, JSON.stringify(report, null, 1));
console.log(`\nsummary (${report.seconds} s):`);
const s = report.suites;
if (s.static) console.log(`  static     ${s.static.states} states; ` + Object.entries(s.static.byCheck).map(([k, c]) => `${k}: ${c.blocks} blocks`).join(', '));
if (s.transform) console.log(`  transform  ${s.transform.cases} cases, ${s.transform.mismatches} mismatches in ${s.transform.families.length} families`);
if (s.connect) console.log(`  connect    ${s.connect.scenes} scenes / ${s.connect.compared} positions: ${s.connect.mismatches} mismatches (${s.connect.groups.filter((g) => g.cat === 'connect').length} groups), ${s.connect.unmodelled} unmodelled vanilla changes`);
if (s.support) console.log(`  support    ${s.support.cases} cases: ${s.support.mismatches} mismatches (${s.support.groups.length} groups)`);
console.log(`  report → ${reportFile}`);
