// Runs Probe.java against the real 26.3 server classes (unobfuscated) and caches the result:
// one JSON line per block state with face sturdiness (FULL/CENTER/RIGID), collision/support face
// fullness, solid-render/occlusion, legacy isSolid, redstone conductor, replaceable, and the
// vanilla BlockState.rotate / mirror results.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ROOT, TOOLS_HOME } from './lib.mjs';

const SERVER_SHA1 = '33680f5f2ac32864d6d7cf5e56a705fdb3e05f4c';
const JAVA = join(process.env.JAVA_HOME || join(homedir(), '.mcai-tools/jdk-25.0.5+8/Contents/Home'), 'bin/java');
const CACHE = process.env.MCAI_MC_CACHE || join(homedir(), '.mcai-tools/mc');
export const DIR_ORDER = ['down', 'up', 'north', 'south', 'west', 'east']; // Direction.values()

function jars(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) jars(p, out);
    else if (f.endsWith('.jar')) out.push(p);
  }
  return out;
}

// bump PROBE_FORMAT whenever Probe.java gains fields (old caches are then regenerated)
export const PROBE_FORMAT = 2;
export function probeFile() { return join(TOOLS_HOME, `probe-26.3-${SERVER_SHA1.slice(0, 8)}-v${PROBE_FORMAT}.jsonl`); }

/** Load (and if needed generate, ~3 min) the probe dump. Returns Map<state, facts>. */
export function loadProbe({ log = console.log, regenerate = false } = {}) {
  const out = probeFile();
  if (regenerate || !existsSync(out)) {
    const bundle = join(TOOLS_HOME, 'bundle');
    const serverJar = join(bundle, 'META-INF/versions/26.3/server-26.3.jar');
    if (!existsSync(serverJar)) {
      const src = join(CACHE, `piston-data/v1/objects/${SERVER_SHA1}/server.jar`);
      if (!existsSync(src)) throw new Error(`server.jar missing (${src}) — run: node tools/mc-fetch.mjs 26.3`);
      mkdirSync(bundle, { recursive: true });
      execFileSync('unzip', ['-qo', src, 'META-INF/versions/*', 'META-INF/libraries/*', 'META-INF/*.list', '-d', bundle]);
    }
    const cp = [serverJar, ...jars(join(bundle, 'META-INF/libraries'))].join(':');
    log(`  running Probe.java against the real 26.3 classes (≈3 min) → ${out}`);
    execFileSync(JAVA, ['-cp', cp, join(ROOT, 'tools/vanilla-diff/Probe.java'), out], { stdio: ['ignore', 'ignore', 'inherit'], cwd: TOOLS_HOME });
  }
  const map = new Map();
  for (const line of readFileSync(out, 'utf8').split('\n')) {
    if (!line) continue;
    const o = JSON.parse(line);
    map.set(o.s, o);
  }
  return map;
}

export const bit = (mask, dir) => ((mask >> DIR_ORDER.indexOf(dir)) & 1) === 1;
