// Shared helpers for the mcAI setup scripts (plain Node ≥ 22.18, no dependencies).
//
//   node scripts/lib/common.mjs java-home     → prints JAVA_HOME of a Java ≥ 25 (exit 1 if none)
//   node scripts/lib/common.mjs mc-dir        → prints the Minecraft launcher directory
//   node scripts/lib/common.mjs launcher-running → exit 0 if the Minecraft Launcher runs

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MC_VERSION = '26.3';
export const UA = 'mcai-setup/2.0.0 (+https://github.com/mcai; contact via repository)';

// ------------------------------------------------------------------ output

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const c = { bold: paint('1'), dim: paint('2'), red: paint('31'), green: paint('32'), yellow: paint('33'), blue: paint('34'), cyan: paint('36') };
export const log = {
  step: (s) => console.log(`\n${c.bold(c.blue('==>'))} ${c.bold(s)}`),
  ok: (s) => console.log(`  ${c.green('✔')} ${s}`),
  info: (s) => console.log(`  ${c.dim('•')} ${s}`),
  warn: (s) => console.log(`  ${c.yellow('!')} ${s}`),
  err: (s) => console.error(`  ${c.red('✘')} ${s}`),
  dry: (s) => console.log(`  ${c.cyan('[dry-run]')} ${s}`),
};

export class UserError extends Error {
  constructor(msg, code = 1) {
    super(msg);
    this.code = code;
  }
}

// ------------------------------------------------------------------ paths

export function mcaiHome() {
  return process.env.MCAI_HOME ? path.resolve(process.env.MCAI_HOME) : path.join(os.homedir(), '.mcai');
}

export function ensureMcaiHome() {
  const h = mcaiHome();
  fs.mkdirSync(h, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(h, 0o700);
  } catch {}
  return h;
}

/** Default directory of the official launcher for this OS (MCAI_MC_DIR overrides). */
export function minecraftDir() {
  if (process.env.MCAI_MC_DIR) return path.resolve(process.env.MCAI_MC_DIR);
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'minecraft');
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), '.minecraft');
  return path.join(home, '.minecraft');
}

export function modVersion() {
  const props = fs.readFileSync(path.join(REPO_ROOT, 'mod', 'gradle.properties'), 'utf8');
  const get = (k) => props.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
  return { mod: get('version'), loader: get('loader_version'), fabricApi: get('fabric_api_version'), mc: get('minecraft_version') };
}

// ------------------------------------------------------------------ files

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (fallback !== undefined && e.code === 'ENOENT') return fallback;
    throw e;
  }
}

/** Write atomically (tmp file + rename in the same directory). */
export function writeFileAtomic(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.mcai-tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

export function writeJsonAtomic(file, obj, mode) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n', mode);
}

export function hashFile(file, algo) {
  return crypto.createHash(algo).update(fs.readFileSync(file)).digest('hex');
}

export function hashBuf(buf, algo) {
  return crypto.createHash(algo).update(buf).digest('hex');
}

/** Copy using a copy-on-write clone where the filesystem supports it (APFS, btrfs). */
export function cloneFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.mcai-tmp-${process.pid}`;
  fs.copyFileSync(src, tmp, fs.constants.COPYFILE_FICLONE);
  fs.renameSync(tmp, dest);
}

// ------------------------------------------------------------------ http

export async function fetchRetry(url, init = {}, { tries = 3, timeoutMs = 30000 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...init, headers: { 'user-agent': UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs) });
      if (r.status === 429 || r.status >= 500) {
        last = new Error(`HTTP ${r.status} for ${url}`);
        await new Promise((res) => setTimeout(res, 1000 * (i + 1) * (r.status === 429 ? 3 : 1)));
        continue;
      }
      return r;
    } catch (e) {
      last = e;
      if (i + 1 < tries) await new Promise((res) => setTimeout(res, 800 * (i + 1)));
    }
  }
  throw new Error(`${url}: ${last?.cause?.code ?? last?.message ?? last}`);
}

export async function fetchJson(url, init, opts) {
  const r = await fetchRetry(url, init, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

/**
 * Download into dest and verify. `expect` = { sha512?, sha1?, size? } — at least one hash is required
 * unless `allowUnverified` (never used for mods). An existing file with matching hash is reused.
 */
export async function downloadVerified(url, dest, expect, { allowUnverified = false } = {}) {
  const algo = expect.sha512 ? 'sha512' : expect.sha1 ? 'sha1' : null;
  if (!algo && !allowUnverified) throw new Error(`refusing to download ${url} without a hash`);
  if (algo && fs.existsSync(dest) && hashFile(dest, algo) === expect[algo]) return { cached: true };
  const r = await fetchRetry(url, {}, { timeoutMs: 180000 });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (expect.size != null && buf.length !== expect.size) throw new Error(`size mismatch for ${url}: got ${buf.length}, expected ${expect.size}`);
  if (algo && hashBuf(buf, algo) !== expect[algo]) throw new Error(`${algo} mismatch for ${url} — download rejected`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  writeFileAtomic(dest, buf);
  return { cached: false };
}

// ------------------------------------------------------------------ zip (read one entry)

/** Read a single entry from a zip/jar (stored or deflate). Returns null if absent. */
export function readZipEntry(file, name) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${file}: not a zip file`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`${file}: corrupt central directory`);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const entry = buf.toString('utf8', p + 46, p + 46 + nlen);
    if (entry === name) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`${file}: unsupported compression ${method}`);
    }
    p += 46 + nlen + xlen + clen;
  }
  return null;
}

/** fabric.mod.json of a jar → { id, version } or null (lenient: some mods have raw newlines in strings). */
export function fabricModInfo(jar) {
  let raw;
  try {
    raw = readZipEntry(jar, 'fabric.mod.json');
  } catch {
    return null;
  }
  if (!raw) return null;
  const s = raw.toString('utf8');
  for (const t of [s, s.replace(/[\u0000-\u001f]+/g, ' ')]) {
    try {
      const j = JSON.parse(t);
      return { id: j.id, version: j.version, depends: j.depends ?? {} };
    } catch {}
  }
  const id = s.match(/"id"\s*:\s*"([^"]+)"/)?.[1];
  return id ? { id, version: s.match(/"version"\s*:\s*"([^"]+)"/)?.[1], depends: {} } : null;
}

// ------------------------------------------------------------------ Modrinth

const MODRINTH = 'https://api.modrinth.com/v2';

function versionOk(v, mc, loaders) {
  return v.game_versions?.includes(mc) && loaders.some((l) => v.loaders?.includes(l));
}

function primaryFile(v, ext) {
  const files = (v.files ?? []).filter((f) => f.filename.endsWith(ext));
  return files.find((f) => f.primary) ?? files[0];
}

/**
 * Resolve Modrinth projects to concrete, verifiable files.
 * specs: [{ slug, loaders: ['fabric'], ext: '.jar', kind: 'mod'|'shader' }]
 * Picks the newest *release* that declares `mc` + loader (beta only if no release exists, never alpha),
 * then honours exact version pins of required dependencies inside the set (e.g. Iris → Sodium).
 */
export async function resolveModrinth(specs, mc = MC_VERSION) {
  const picks = new Map(); // slug -> pick
  for (const spec of specs) {
    const qs = new URLSearchParams({ game_versions: JSON.stringify([mc]), loaders: JSON.stringify(spec.loaders), include_changelog: 'false' });
    const all = await fetchJson(`${MODRINTH}/project/${encodeURIComponent(spec.slug)}/version?${qs}`);
    const ok = all.filter((v) => versionOk(v, mc, spec.loaders) && primaryFile(v, spec.ext));
    const byDate = (a, b) => Date.parse(b.date_published) - Date.parse(a.date_published);
    const v = ok.filter((x) => x.version_type === 'release').sort(byDate)[0] ?? ok.filter((x) => x.version_type === 'beta').sort(byDate)[0];
    if (!v) throw new UserError(`Modrinth: no release/beta of '${spec.slug}' for Minecraft ${mc} + ${spec.loaders.join('/')} yet`);
    picks.set(spec.slug, toPick(spec, v));
  }
  // pins: a required dependency with an exact version_id inside our set wins
  for (let round = 0; round < 4; round++) {
    let changed = false;
    for (const p of picks.values()) {
      for (const d of p.deps) {
        if (d.dependency_type !== 'required' || !d.version_id) continue;
        const target = [...picks.values()].find((q) => q.projectId === d.project_id);
        if (!target || target.versionId === d.version_id) continue;
        const v = await fetchJson(`${MODRINTH}/version/${d.version_id}`);
        if (!versionOk(v, mc, target.spec.loaders)) throw new UserError(`${p.slug} pins ${target.slug} ${v.version_number}, which does not support ${mc}`);
        picks.set(target.slug, { ...toPick(target.spec, v), pinnedBy: p.slug });
        changed = true;
      }
    }
    if (!changed) break;
  }
  // required deps present? incompatibilities?
  const ids = new Set([...picks.values()].map((p) => p.projectId));
  for (const p of picks.values()) {
    for (const d of p.deps) {
      if (d.dependency_type === 'required' && d.project_id && !ids.has(d.project_id)) throw new UserError(`${p.slug} requires Modrinth project ${d.project_id}, which is not in the mod set`);
      if (d.dependency_type === 'incompatible' && d.project_id && ids.has(d.project_id)) throw new UserError(`${p.slug} declares itself incompatible with ${d.project_id}`);
    }
  }
  return [...picks.values()];
}

function toPick(spec, v) {
  const f = primaryFile(v, spec.ext);
  if (!f.hashes?.sha512) throw new UserError(`Modrinth: ${spec.slug} ${v.version_number} has no sha512 — refusing`);
  return {
    spec, slug: spec.slug, kind: spec.kind ?? 'mod', projectId: v.project_id, versionId: v.id, versionNumber: v.version_number, versionType: v.version_type,
    filename: f.filename, url: f.url, size: f.size, sha512: f.hashes.sha512, deps: v.dependencies ?? [],
  };
}

/** Download a pick into the shared cache (~/.mcai/cache/modrinth), verified by sha512 + size. */
export async function fetchPick(pick) {
  const dest = path.join(mcaiHome(), 'cache', 'modrinth', pick.sha512.slice(0, 16), pick.filename);
  const r = await downloadVerified(pick.url, dest, { sha512: pick.sha512, size: pick.size });
  return { file: dest, cached: r.cached };
}

// ------------------------------------------------------------------ mods directory sync

/**
 * Make `dir` contain exactly the wanted managed files.
 * wanted: [{ name, src, sha512 }]. Managed files from the previous run that are no longer wanted are
 * deleted; *unmanaged* jars that are another version of a wanted mod (same fabric mod id) are moved to
 * `<dir>/../mods.disabled/` so they cannot clash. Everything else (the user's own mods) is left alone.
 */
export function syncManagedDir(dir, wanted, { dryRun, manifestName = '.mcai-managed.json', fabricIds = true } = {}) {
  const manifestFile = path.join(dir, manifestName);
  const prev = fs.existsSync(manifestFile) ? readJson(manifestFile, {}) : {};
  const prevFiles = new Set(prev.files ?? []);
  const actions = [];
  const wantNames = new Set(wanted.map((w) => w.name));
  const wantIds = new Map();
  if (fabricIds) for (const w of wanted) {
    const info = w.src.endsWith('.jar') ? fabricModInfo(w.src) : null;
    if (info?.id) wantIds.set(info.id, w.name);
  }
  const existing = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !f.startsWith('.')) : [];
  for (const f of existing) {
    if (wantNames.has(f)) continue;
    const full = path.join(dir, f);
    if (!fs.statSync(full).isFile()) continue;
    if (prevFiles.has(f)) {
      actions.push({ op: 'remove', file: f, why: 'old version (installed by mcAI)' });
      continue;
    }
    if (fabricIds && f.endsWith('.jar')) {
      const id = fabricModInfo(full)?.id;
      if (id && wantIds.has(id)) actions.push({ op: 'disable', file: f, why: `another copy of '${id}' (replaced by ${wantIds.get(id)})` });
    }
  }
  for (const w of wanted) {
    const dest = path.join(dir, w.name);
    const same = fs.existsSync(dest) && hashFile(dest, 'sha512') === (w.sha512 ?? hashFile(w.src, 'sha512'));
    actions.push({ op: same ? 'keep' : fs.existsSync(dest) ? 'update' : 'add', file: w.name });
  }
  if (dryRun) return actions;
  fs.mkdirSync(dir, { recursive: true });
  for (const a of actions) {
    const full = path.join(dir, a.file);
    if (a.op === 'remove') fs.rmSync(full, { force: true });
    else if (a.op === 'disable') {
      const dis = path.join(path.dirname(dir), `${path.basename(dir)}.disabled`);
      fs.mkdirSync(dis, { recursive: true });
      fs.renameSync(full, path.join(dis, a.file));
    } else if (a.op === 'add' || a.op === 'update') {
      const w = wanted.find((x) => x.name === a.file);
      cloneFile(w.src, full);
    }
  }
  writeJsonAtomic(manifestFile, { note: 'Files in this directory installed and managed by mcAI (scripts/setup-*.mjs). Do not edit.', files: wanted.map((w) => w.name), updatedAt: new Date().toISOString() });
  return actions;
}

// ------------------------------------------------------------------ processes

function processList() {
  if (process.platform === 'win32') {
    const r = spawnSync('tasklist', ['/fo', 'csv', '/nh', '/v'], { encoding: 'utf8' });
    return (r.stdout ?? '').split(/\r?\n/).filter(Boolean).map((l) => {
      const cols = l.split('","').map((s) => s.replace(/^"|"$/g, ''));
      return { pid: Number(cols[1]), command: cols[0] ?? '' };
    });
  }
  const r = spawnSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' });
  return (r.stdout ?? '').split('\n').filter(Boolean).map((l) => {
    const m = l.trim().match(/^(\d+)\s+(.*)$/);
    return m ? { pid: Number(m[1]), command: m[2] } : null;
  }).filter(Boolean);
}

/** Running official launcher processes (not the game itself). */
export function launcherProcesses() {
  return processList().filter(({ command }) => {
    if (process.platform === 'darwin') return /\/Minecraft[^/]*\.app\/Contents\/(MacOS|Frameworks)\//i.test(command) && !/\/bin\/java(\s|$)/.test(command);
    if (process.platform === 'win32') return /^(MinecraftLauncher|Minecraft)\.exe$/i.test(command);
    return /(^|\/)minecraft-launcher(\s|$)/.test(command);
  });
}

/** Game processes running with the given game directory. */
export function gameProcesses(gameDir) {
  return processList().filter(({ command }) => /net\.fabricmc\.loader\.impl\.launch\.knot\.KnotClient|net\.minecraft\.client\.main\.Main/.test(command) && command.includes(gameDir));
}

// ------------------------------------------------------------------ java

export function javaMajor(javaBin) {
  const r = spawnSync(javaBin, ['-version'], { encoding: 'utf8', timeout: 20000 });
  const m = `${r.stderr}${r.stdout}`.match(/version "(\d+)(?:\.(\d+))?/);
  if (!m) return 0;
  return m[1] === '1' ? Number(m[2]) : Number(m[1]);
}

/** JAVA_HOME candidates in priority order; returns the first with Java ≥ min. */
export function findJavaHome(min = 25) {
  const bin = (h) => path.join(h, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const cands = [];
  if (process.env.MCAI_JAVA_HOME) cands.push(process.env.MCAI_JAVA_HOME);
  if (process.env.JAVA_HOME) cands.push(process.env.JAVA_HOME);
  const tools = path.join(os.homedir(), '.mcai-tools');
  try {
    for (const d of fs.readdirSync(tools).filter((d) => /^jdk-?\d/.test(d)).sort().reverse()) {
      cands.push(path.join(tools, d, 'Contents', 'Home'), path.join(tools, d));
    }
  } catch {}
  if (process.platform === 'darwin') {
    const r = spawnSync('/usr/libexec/java_home', ['-v', `${min}+`], { encoding: 'utf8' });
    if (r.status === 0) cands.push(r.stdout.trim());
  }
  // the launcher's bundled runtime (Java 25 for MC 26.x)
  const rt = path.join(minecraftDir(), 'runtime');
  for (const comp of ['java-runtime-epsilon', 'java-runtime-delta']) {
    cands.push(
      path.join(rt, comp, 'mac-os', comp, 'jre.bundle', 'Contents', 'Home'),
      path.join(rt, comp, 'mac-os-arm64', comp, 'jre.bundle', 'Contents', 'Home'),
      path.join(rt, comp, 'linux', comp),
      path.join(rt, comp, 'windows-x64', comp),
    );
  }
  const onPath = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['java'], { encoding: 'utf8' });
  if (onPath.status === 0) {
    try {
      cands.push(path.dirname(path.dirname(fs.realpathSync(onPath.stdout.split(/\r?\n/)[0].trim()))));
    } catch {}
  }
  for (const h of cands) {
    if (h && fs.existsSync(bin(h)) && javaMajor(bin(h)) >= min) return h;
  }
  return null;
}

// ------------------------------------------------------------------ CLI (for the bash scripts)

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd === 'java-home') {
    const h = findJavaHome(Number(process.argv[3] ?? 25));
    if (!h) process.exit(1);
    console.log(h);
  } else if (cmd === 'mc-dir') {
    console.log(minecraftDir());
  } else if (cmd === 'launcher-running') {
    process.exit(launcherProcesses().length ? 0 : 1);
  } else {
    console.error('usage: common.mjs java-home [min] | mc-dir | launcher-running');
    process.exit(2);
  }
}
