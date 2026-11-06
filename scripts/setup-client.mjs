#!/usr/bin/env node
// Install mcAI into the official Minecraft Launcher (macOS / Windows / Linux), no dependencies.
//
//   node scripts/setup-client.mjs [options]
//     --dry-run            show what would change, write nothing
//     --shaders            also install Iris + the light "MakeUp - Ultra Fast" shader pack
//     --no-shaders         remove them again (the choice is remembered otherwise)
//     --wait[=MIN]         wait (default 15 min) for the launcher to be installed and run once
//     --java PATH          use this java executable (or JAVA_HOME) instead of the launcher's bundled Java
//     --xmx 6G             heap for the game (default: by system RAM)
//     --seed-cache         copy the verified Minecraft 26.3 files from ~/.mcai-tools/mc into the launcher
//                          (for networks that block Mojang; the launcher re-verifies every file)
//     --skip-build         never build the mod (fail if mod/build/libs/mcai-*.jar is missing)
//     --uninstall          remove the profile, the Fabric version and mcAI-managed mods
//         --restore-backup    instead restore the newest launcher_profiles.json backup
//         --purge             also delete the profile's game directory (worlds!) — explicit only
//   env: MCAI_MC_DIR (launcher directory), MCAI_HOME (~/.mcai)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import {
  REPO_ROOT, MC_VERSION, c, log, UserError, mcaiHome, ensureMcaiHome, minecraftDir, modVersion, readJson, writeJsonAtomic, writeFileAtomic,
  hashFile, cloneFile, fetchJson, downloadVerified, resolveModrinth, fetchPick, syncManagedDir, launcherProcesses, gameProcesses, findJavaHome,
  fabricModInfo,
} from './lib/common.mjs';

const PROFILE_KEY = 'mcai-fabric-26.3';
const PROFILE_NAME = 'mcAI · Fabric 26.3';
const TOOLS = path.join(os.homedir(), '.mcai-tools');

const CLIENT_MODS = [
  { slug: 'fabric-api', why: 'required by mcAI and most mods' },
  { slug: 'sodium', why: 'modern renderer — the single biggest FPS gain on Intel iGPUs' },
  { slug: 'lithium', why: 'game logic/tick optimisations (also for the integrated server)' },
  { slug: 'ferrite-core', why: 'lower memory use' },
  { slug: 'immediatelyfast', why: 'faster GUI/text/entity immediate-mode rendering' },
  { slug: 'entityculling', why: 'skips rendering hidden (block-)entities' },
  { slug: 'dynamic-fps', why: 'throttles FPS when unfocused/minimised — saves battery and heat' },
];
const SHADER_MODS = [{ slug: 'iris', why: 'shader loader (works on top of Sodium)' }];
const SHADER_PACKS = [{ slug: 'makeup-ultra-fast-shaders', why: 'very light shader pack, suitable for Intel UHD graphics' }];

const { values: opt } = parseArgs({
  options: {
    'dry-run': { type: 'boolean' }, shaders: { type: 'boolean' }, 'no-shaders': { type: 'boolean' }, wait: { type: 'string' },
    java: { type: 'string' }, xmx: { type: 'string' }, 'seed-cache': { type: 'boolean' }, 'skip-build': { type: 'boolean' },
    uninstall: { type: 'boolean' }, 'restore-backup': { type: 'boolean' }, purge: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: false,
});
// `--wait` without value
const waitIdx = process.argv.indexOf('--wait');
const waitMin = opt.wait !== undefined ? Number(opt.wait) || 15 : waitIdx >= 0 ? 15 : 0;
const DRY = !!opt['dry-run'];

const MC_DIR = minecraftDir();
function defaultMcDir() {
  const saved = process.env.MCAI_MC_DIR;
  delete process.env.MCAI_MC_DIR;
  const d = path.resolve(minecraftDir());
  if (saved !== undefined) process.env.MCAI_MC_DIR = saved;
  return d;
}
const PROFILES_FILE = path.join(MC_DIR, 'launcher_profiles.json');
const STATE_FILE = () => path.join(mcaiHome(), 'client-install.json');

function usage() {
  const src = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n');
  console.log(src.slice(1, src.findIndex((l) => l.startsWith('import'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}

// ------------------------------------------------------------------ preconditions

async function waitForLauncherDir() {
  if (fs.existsSync(PROFILES_FILE)) return;
  const explain = () => {
    console.log(`
  The official Minecraft Launcher has not been set up yet:
    ${c.dim(PROFILES_FILE)} does not exist.

  1. Install the launcher (https://www.minecraft.net/download) and start it once.
  2. Log in with your Microsoft account (the launcher creates its files now).
  3. Quit the launcher (${process.platform === 'darwin' ? 'Cmd+Q' : 'close it completely'}) and run this again.
     (or run with --wait to let this script wait for it)`);
  };
  if (!waitMin) {
    explain();
    throw new UserError('Minecraft Launcher not set up yet', 3);
  }
  log.info(`waiting up to ${waitMin} min for ${PROFILES_FILE} …`);
  const until = Date.now() + waitMin * 60000;
  while (!fs.existsSync(PROFILES_FILE)) {
    if (Date.now() > until) {
      explain();
      throw new UserError('timed out waiting for the Minecraft Launcher', 3);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  log.ok('launcher files found');
}

async function ensureLauncherClosed(what) {
  // a running launcher only rewrites its own default directory (MCAI_MC_DIR elsewhere = test/portable dir)
  if (path.resolve(MC_DIR) !== defaultMcDir()) return;
  let procs = launcherProcesses();
  if (!procs.length) return;
  const msg = `The Minecraft Launcher is running (pid ${procs.map((p) => p.pid).join(', ')}). It rewrites launcher_profiles.json when it quits, which would undo ${what}.`;
  if (DRY) return log.warn(`${msg} (dry-run: continuing; a real run would stop here)`);
  if (waitMin) {
    log.warn(`${msg}\n    Please quit it (${process.platform === 'darwin' ? 'Cmd+Q' : 'close it'}); waiting …`);
    const until = Date.now() + waitMin * 60000;
    while ((procs = launcherProcesses()).length) {
      if (Date.now() > until) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!procs.length) return log.ok('launcher closed');
  }
  throw new UserError(`${msg}\n    Quit the launcher${process.platform === 'darwin' ? ' (Cmd+Q)' : ''} and run this again.`, 4);
}

// ------------------------------------------------------------------ launcher_profiles.json

function backupProfiles() {
  const dir = path.join(mcaiHome(), 'backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = path.join(dir, `launcher_profiles.${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.copyFileSync(PROFILES_FILE, dest);
  // keep the 10 newest
  const all = fs.readdirSync(dir).filter((f) => f.startsWith('launcher_profiles.')).sort();
  for (const f of all.slice(0, Math.max(0, all.length - 10))) fs.rmSync(path.join(dir, f), { force: true });
  return dest;
}

function readProfiles() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
  } catch (e) {
    throw new UserError(`${PROFILES_FILE} is not valid JSON (${e.message}). Start the launcher once to repair it, or restore a backup.`);
  }
  if (typeof data !== 'object' || !data) throw new UserError(`${PROFILES_FILE}: unexpected content`);
  data.profiles ??= {};
  return data;
}

// ------------------------------------------------------------------ JVM args

function gameXmx() {
  if (opt.xmx) {
    if (!/^\d+[MG]$/i.test(opt.xmx)) throw new UserError('--xmx must look like 6G or 4096M');
    return opt.xmx.toUpperCase();
  }
  const gb = os.totalmem() / 2 ** 30;
  return gb >= 24 ? '6G' : gb >= 12 ? '4G' : gb >= 7 ? '3G' : '2G';
}

/** Mojang's own launcher defaults (G1, tuned for the client) with a right-sized heap. */
function javaArgs(xmx) {
  const xms = Number.parseInt(xmx) >= 4 && xmx.endsWith('G') ? '2G' : '1G';
  return [
    `-Xms${xms}`, `-Xmx${xmx}`,
    '-XX:+UnlockExperimentalVMOptions', '-XX:+UseG1GC', '-XX:G1NewSizePercent=20', '-XX:G1ReservePercent=20',
    '-XX:MaxGCPauseMillis=50', '-XX:G1HeapRegionSize=32M',
  ].join(' ');
}

function iconDataUrl() {
  for (const p of ['mod/src/main/resources/assets/mcai/icon.png', 'mod/src/main/resources/assets/mcai/textures/item/architect_wand.png']) {
    const f = path.join(REPO_ROOT, p);
    if (fs.existsSync(f)) return `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;
  }
  return 'Crafting_Table';
}

// ------------------------------------------------------------------ Fabric version profile

async function fabricClientProfile(loader) {
  const id = `fabric-loader-${loader}-${MC_VERSION}`;
  const valid = (j) => j && j.id === id && j.inheritsFrom === MC_VERSION && j.mainClass === 'net.fabricmc.loader.impl.launch.knot.KnotClient' && Array.isArray(j.libraries)
    && j.libraries.some((l) => l.name === `net.fabricmc:fabric-loader:${loader}`);
  const cacheFile = path.join(mcaiHome(), 'cache', 'fabric', `${id}-client-profile.json`);
  // 1. Fabric meta (official source)
  try {
    const j = await fetchJson(`https://meta.fabricmc.net/v2/versions/loader/${MC_VERSION}/${loader}/profile/json`, {}, { tries: 1, timeoutMs: 8000 });
    if (valid(j)) {
      if (!DRY) writeJsonAtomic(cacheFile, j);
      return { profile: j, source: 'meta.fabricmc.net' };
    }
  } catch {}
  // 2. a previously fetched copy of the meta profile
  for (const f of [cacheFile, path.join(TOOLS, 'fabric', `${id}-client-profile.json`)]) {
    try {
      const j = readJson(f);
      if (valid(j)) return { profile: j, source: f };
    } catch {}
  }
  // 3. derive it from the cached *server* profile: identical libraries; the client profile differs only in
  //    mainClass (KnotClient) and the FabricMcEmu jvm argument (exactly what meta generates for clients).
  for (const f of [path.join(mcaiHome(), 'cache', 'fabric', `fabric-server-${MC_VERSION}-${loader}.json`), path.join(TOOLS, 'fabric', `fabric-server-${MC_VERSION}-${loader}.json`)]) {
    try {
      const s = readJson(f);
      if (s.id !== id || s.inheritsFrom !== MC_VERSION) continue;
      const j = { ...s, mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient', arguments: { game: [], jvm: ['-DFabricMcEmu= net.minecraft.client.main.Main '] } };
      if (valid(j)) return { profile: j, source: `derived from ${f}` };
    } catch {}
  }
  throw new UserError(`cannot get the Fabric ${loader} client profile: meta.fabricmc.net unreachable and no cached copy.\n    Run once on a network that reaches meta.fabricmc.net.`);
}

function mavenPath(name) {
  const [g, a, v, cls] = name.split(':');
  return `${g.replace(/\./g, '/')}/${a}/${v}/${a}-${v}${cls ? `-${cls}` : ''}.jar`;
}

/** Pre-fetch the Fabric libraries into <mc>/libraries, verified (sha1 from the profile or the maven's .sha1). */
async function fetchFabricLibraries(profile) {
  let n = 0;
  for (const lib of profile.libraries) {
    const rel = mavenPath(lib.name);
    const base = (lib.url ?? 'https://maven.fabricmc.net/').replace(/\/?$/, '/');
    let sha1 = lib.sha1;
    if (!sha1) {
      const r = await fetch(`${base}${rel}.sha1`, { signal: AbortSignal.timeout(15000) }).catch(() => null);
      if (r?.ok) sha1 = (await r.text()).trim().slice(0, 40);
    }
    if (!/^[0-9a-f]{40}$/.test(sha1 ?? '')) {
      log.warn(`no checksum for ${lib.name} — the launcher will download it itself`);
      continue;
    }
    await downloadVerified(`${base}${rel}`, path.join(MC_DIR, 'libraries', rel), { sha1, size: lib.size });
    n++;
  }
  return n;
}

// ------------------------------------------------------------------ seeding from the verified cache

function seedFromCache() {
  const cache = process.env.MCAI_MC_CACHE ?? path.join(TOOLS, 'mc');
  const pkgDir = path.join(cache, 'piston-meta', 'v1', 'packages');
  if (!fs.existsSync(pkgDir)) throw new UserError(`--seed-cache: no verified cache at ${cache} (node tools/mc-fetch.mjs ${MC_VERSION} --assets)`);
  // candidates: content-addressed <sha1>/26.3.json, newest first, whose asset index is cached
  const cands = [];
  for (const sha of fs.readdirSync(pkgDir)) {
    const f = path.join(pkgDir, sha, `${MC_VERSION}.json`);
    if (!fs.existsSync(f) || hashFile(f, 'sha1') !== sha) continue;
    const j = readJson(f);
    const idx = path.join(pkgDir, j.assetIndex.sha1, `${j.assetIndex.id}.json`);
    if (fs.existsSync(idx) && hashFile(idx, 'sha1') === j.assetIndex.sha1) cands.push({ f, j, idx });
  }
  cands.sort((a, b) => Date.parse(b.j.time) - Date.parse(a.j.time));
  const pick = cands[0];
  if (!pick) throw new UserError(`--seed-cache: no verified ${MC_VERSION} version JSON with asset index in ${cache}`);
  const { j } = pick;
  let copied = 0, present = 0, missing = 0;
  const put = (src, dest, sha1) => {
    if (fs.existsSync(dest) && fs.statSync(dest).size === fs.statSync(src).size && hashFile(dest, 'sha1') === sha1) return present++;
    if (hashFile(src, 'sha1') !== sha1) throw new UserError(`cache file fails sha1 verification: ${src}`);
    if (!DRY) cloneFile(src, dest);
    copied++;
  };
  const vdir = path.join(MC_DIR, 'versions', MC_VERSION);
  if (!fs.existsSync(path.join(vdir, `${MC_VERSION}.json`))) put(pick.f, path.join(vdir, `${MC_VERSION}.json`), path.basename(path.dirname(pick.f)));
  const jar = path.join(cache, 'piston-data', 'v1', 'objects', j.downloads.client.sha1, 'client.jar');
  if (fs.existsSync(jar)) put(jar, path.join(vdir, `${MC_VERSION}.jar`), j.downloads.client.sha1);
  else missing++;
  for (const lib of j.libraries) {
    const a = lib.downloads?.artifact;
    if (!a) continue;
    const src = path.join(cache, 'libraries', a.path);
    if (fs.existsSync(src)) put(src, path.join(MC_DIR, 'libraries', a.path), a.sha1);
    else missing++;
  }
  put(pick.idx, path.join(MC_DIR, 'assets', 'indexes', `${j.assetIndex.id}.json`), j.assetIndex.sha1);
  for (const { hash } of Object.values(readJson(pick.idx).objects)) {
    const src = path.join(cache, 'resources', hash.slice(0, 2), hash);
    if (fs.existsSync(src)) put(src, path.join(MC_DIR, 'assets', 'objects', hash.slice(0, 2), hash), hash);
    else missing++;
  }
  const lc = j.logging?.client?.file;
  if (lc) {
    const src = path.join(cache, 'piston-data', 'v1', 'objects', lc.sha1, lc.id);
    if (fs.existsSync(src)) put(src, path.join(MC_DIR, 'assets', 'log_configs', lc.id), lc.sha1);
  }
  return { copied, present, missing };
}

// ------------------------------------------------------------------ options.txt

function mcLanguage() {
  let tags = [];
  if (process.platform === 'darwin') {
    const r = spawnSync('defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8' });
    tags = (r.stdout ?? '').match(/[A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*/g) ?? [];
  }
  tags.push(process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG, Intl.DateTimeFormat().resolvedOptions().locale);
  const known = {
    de: 'de_de', en: 'en_us', fr: 'fr_fr', it: 'it_it', es: 'es_es', nl: 'nl_nl', pl: 'pl_pl', pt: 'pt_br', ru: 'ru_ru', sv: 'sv_se', da: 'da_dk',
    nb: 'no_no', no: 'no_no', fi: 'fi_fi', cs: 'cs_cz', tr: 'tr_tr', uk: 'uk_ua', ja: 'ja_jp', ko: 'ko_kr', zh: 'zh_cn', hu: 'hu_hu',
  };
  const regional = { 'en-gb': 'en_gb', 'en-au': 'en_au', 'en-ca': 'en_ca', 'fr-ca': 'fr_ca', 'pt-pt': 'pt_pt', 'es-mx': 'es_mx', 'zh-tw': 'zh_tw', 'zh-hant': 'zh_tw' };
  for (const t of tags) {
    if (!t || /^(C|POSIX)(\.|$)/.test(t)) continue;
    const norm = t.split('.')[0].replace('_', '-').toLowerCase();
    if (regional[norm]) return regional[norm];
    const l = norm.split('-')[0];
    if (known[l]) return known[l]; // German of any region (de-CH, de-AT …) → standard German
  }
  return 'en_us';
}

function optionsTxt(lang) {
  // Keys/values as Minecraft 26.3 writes them (Options.processOptions; enum codecs serialise as JSON strings).
  return [
    'version:5023', // data version of 26.3 → no option DataFixer pass
    `lang:${lang}`,
    'graphicsPreset:"custom"',
    'renderDistance:10',
    'simulationDistance:8',
    'maxFps:60',
    'enableVsync:true',
    'renderClouds:"fast"',
    'ao:true', // smooth lighting
    'entityDistanceScaling:1.0',
    'entityShadows:true',
    'biomeBlendRadius:1', // 3×3 blend: much cheaper chunk meshing than the default 5×5, hardly visible
    'weatherRadius:5',
    'improvedTransparency:false', // order-independent transparency is too heavy for an iGPU
    'guiScale:0', // auto
    'narrator:0', // off
    '',
  ].join('\n');
}

// ------------------------------------------------------------------ mod jar

function modJarPath() {
  const v = modVersion().mod;
  return path.join(REPO_ROOT, 'mod', 'build', 'libs', `mcai-${v}.jar`);
}

function buildMod() {
  const jh = findJavaHome(25);
  if (!jh) throw new UserError('Java 25 not found (needed to build the mod). Install a JDK 25 or set JAVA_HOME.');
  log.info(`building the mod (./gradlew build --offline, JAVA_HOME=${jh}) …`);
  const env = { ...process.env, JAVA_HOME: jh };
  const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
  let r = spawnSync(gradlew, ['build', '--offline', '-q'], { cwd: path.join(REPO_ROOT, 'mod'), env, stdio: 'inherit' });
  if (r.status !== 0 && fs.existsSync(path.join(REPO_ROOT, 'tools', 'mcgradle.sh'))) {
    log.warn('offline build failed — retrying through the local Minecraft mirror (tools/mcgradle.sh)');
    r = spawnSync(path.join(REPO_ROOT, 'tools', 'mcgradle.sh'), ['build', '-q'], { cwd: REPO_ROOT, env, stdio: 'inherit' });
  }
  if (r.status !== 0) r = spawnSync(gradlew, ['build', '-q'], { cwd: path.join(REPO_ROOT, 'mod'), env, stdio: 'inherit' });
  if (r.status !== 0) throw new UserError('mod build failed (see output above)');
}

// ------------------------------------------------------------------ engine-path + engine config

function writeEnginePath() {
  const engineDir = path.join(REPO_ROOT, 'engine');
  const file = path.join(mcaiHome(), 'engine-path');
  // line 1: engine directory (contract, docs/ARCHITECTURE.md); line 2: absolute node binary — apps started
  // from the Finder/launcher do not inherit the shell PATH, so `node` alone would not be found.
  const content = `${engineDir}\n${process.execPath}\n`;
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (cur === content) return { file, changed: false };
  if (!DRY) {
    ensureMcaiHome();
    writeFileAtomic(file, content, 0o600);
  }
  return { file, changed: true };
}

/** The engine spawns `claude`; under a GUI-launched game PATH lacks ~/.local/bin etc. Pin the absolute path once. */
function pinClaudePath() {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' });
  if (r.status !== 0) return { pinned: false, reason: 'claude not on PATH' };
  const abs = r.stdout.split(/\r?\n/)[0].trim();
  const file = path.join(mcaiHome(), 'config.json');
  const cfg = fs.existsSync(file) ? readJson(file) : {};
  if (cfg.claudePath) return { pinned: false, reason: `config already sets claudePath=${cfg.claudePath}` };
  if (!DRY) {
    ensureMcaiHome();
    writeJsonAtomic(file, { ...cfg, claudePath: abs }, 0o600);
  }
  return { pinned: true, path: abs, file };
}

// ------------------------------------------------------------------ install

async function install() {
  const v = modVersion();
  const versionId = `fabric-loader-${v.loader}-${MC_VERSION}`;
  const prevState = readJson(STATE_FILE(), {});
  const shaders = opt['no-shaders'] ? false : opt.shaders ? true : !!prevState.shaders;
  const gameDir = path.join(MC_DIR, 'profiles', 'mcai');

  console.log(c.bold(`mcAI client setup${DRY ? c.cyan('  (dry run — nothing is written)') : ''}`));
  log.info(`launcher directory: ${MC_DIR}`);
  await waitForLauncherDir();
  await ensureLauncherClosed('the new mcAI profile');
  if (gameProcesses(gameDir).length) throw new UserError(`Minecraft is running with the mcAI profile — quit the game first.`, 4);

  // 1. mod jar
  log.step('mcAI mod');
  let jar = modJarPath();
  if (!fs.existsSync(jar)) {
    if (opt['skip-build'] || DRY) {
      if (!DRY) throw new UserError(`${jar} missing — build it: ./mcai update`);
      log.dry(`would build the mod (${path.relative(REPO_ROOT, jar)} missing)`);
    } else buildMod();
  }
  const modInfo = fs.existsSync(jar) ? fabricModInfo(jar) : null;
  if (fs.existsSync(jar) && modInfo?.id !== 'mcai') throw new UserError(`${jar} is not a valid mcAI mod jar`);
  if (modInfo) log.ok(`${path.basename(jar)} (mod ${modInfo.id} ${modInfo.version})`);

  // 2. Fabric loader version
  log.step(`Fabric Loader ${v.loader} for Minecraft ${MC_VERSION}`);
  const { profile, source } = await fabricClientProfile(v.loader);
  log.ok(`client profile ${profile.id} (${source})`);
  const vdir = path.join(MC_DIR, 'versions', versionId);
  const vjson = path.join(vdir, `${versionId}.json`);
  const existingV = fs.existsSync(vjson) ? readJson(vjson, null) : null;
  const createdVersion = prevState.createdVersion || !existingV;
  if (DRY) log.dry(`would write ${vjson} (+ empty ${versionId}.jar, as the Fabric installer does)`);
  else {
    writeJsonAtomic(vjson, profile);
    const ej = path.join(vdir, `${versionId}.jar`);
    if (!fs.existsSync(ej)) fs.writeFileSync(ej, '');
    const n = await fetchFabricLibraries(profile);
    log.ok(`version files written, ${n}/${profile.libraries.length} Fabric libraries pre-fetched & sha1-verified`);
  }
  if (opt['seed-cache']) {
    const s = seedFromCache();
    log.ok(`seeded Minecraft ${MC_VERSION} from the verified cache: ${s.copied} copied, ${s.present} already present${s.missing ? `, ${s.missing} not cached (launcher downloads them)` : ''}`);
  }

  // 3. mods from Modrinth
  log.step('Mods (Modrinth, sha512-verified)');
  const specs = [...CLIENT_MODS, ...(shaders ? SHADER_MODS : [])].map((m) => ({ ...m, loaders: ['fabric'], ext: '.jar', kind: 'mod' }));
  const packSpecs = shaders ? SHADER_PACKS.map((m) => ({ ...m, loaders: ['iris'], ext: '.zip', kind: 'shader' })) : [];
  const picks = await resolveModrinth([...specs, ...packSpecs]);
  const wantedMods = [], wantedPacks = [];
  for (const p of picks) {
    const why = [...CLIENT_MODS, ...SHADER_MODS, ...SHADER_PACKS].find((m) => m.slug === p.slug)?.why;
    let file = null;
    if (!DRY) file = (await fetchPick(p)).file;
    (p.kind === 'shader' ? wantedPacks : wantedMods).push({ name: p.filename, src: file, sha512: p.sha512 });
    log.ok(`${p.slug.padEnd(26)} ${c.bold(p.versionNumber)}${p.versionType !== 'release' ? c.yellow(` (${p.versionType})`) : ''}${p.pinnedBy ? c.dim(` pinned by ${p.pinnedBy}`) : ''}  ${c.dim(why ?? '')}`);
  }
  if (fs.existsSync(jar)) wantedMods.push({ name: path.basename(jar), src: jar, sha512: hashFile(jar, 'sha512') });
  const modsDir = path.join(gameDir, 'mods');
  if (DRY) {
    for (const p of picks) log.dry(`would install ${p.filename} (${(p.size / 1024).toFixed(0)} KB)`);
    if (fs.existsSync(modsDir)) {
      for (const a of syncManagedDir(modsDir, wantedMods.filter((w) => w.src), { dryRun: true }).filter((a) => a.op === 'remove' || a.op === 'disable')) log.dry(`would ${a.op} ${a.file}: ${a.why}`);
    }
  } else {
    const acts = syncManagedDir(modsDir, wantedMods);
    const n = (op) => acts.filter((a) => a.op === op).length;
    log.ok(`mods/: ${n('add')} added, ${n('update')} updated, ${n('keep')} unchanged, ${n('remove')} old removed${n('disable') ? `, ${n('disable')} conflicting moved to mods.disabled/` : ''}`);
    const packAct = syncManagedDir(path.join(gameDir, 'shaderpacks'), wantedPacks, { fabricIds: false });
    if (packAct.some((a) => a.op !== 'keep')) log.ok(`shaderpacks/: ${wantedPacks.map((w) => w.name).join(', ') || 'none'}`);
  }

  // 4. launcher profile
  log.step(`Launcher profile "${PROFILE_NAME}"`);
  const xmx = gameXmx();
  const args = javaArgs(xmx);
  let javaDir;
  if (opt.java) {
    let j = path.resolve(opt.java);
    if (fs.existsSync(j) && fs.statSync(j).isDirectory()) j = path.join(j, 'bin', process.platform === 'win32' ? 'javaw.exe' : 'java');
    if (!fs.existsSync(j)) throw new UserError(`--java: ${j} not found`);
    javaDir = j;
  }
  if (DRY) log.dry(`would back up and merge ${PROFILES_FILE}`);
  const data = readProfiles();
  const now = new Date().toISOString();
  const old = data.profiles[PROFILE_KEY];
  // keep the user's own JVM args if they edited ours in the launcher
  const keepArgs = old?.javaArgs && prevState.javaArgs && old.javaArgs !== prevState.javaArgs;
  const prof = {
    ...(old ?? {}),
    name: PROFILE_NAME,
    type: 'custom',
    created: old?.created ?? now,
    lastUsed: now, // newest lastUsed = pre-selected in the launcher
    icon: iconDataUrl(),
    lastVersionId: versionId,
    gameDir,
    javaArgs: keepArgs ? old.javaArgs : args,
  };
  if (javaDir) prof.javaDir = javaDir;
  else if (prevState.javaDir && old?.javaDir === prevState.javaDir) delete prof.javaDir;
  if (keepArgs) log.info(`keeping your own JVM arguments: ${old.javaArgs}`);
  else log.ok(`JVM: ${args}`);
  log.ok(`game directory: ${gameDir} ${c.dim('(own worlds/mods/settings, separate from your other profiles)')}`);
  log.ok(`Java: ${javaDir ?? "the launcher's bundled Java 25 runtime"}`);
  let backup = null;
  if (!DRY) {
    backup = backupProfiles();
    data.profiles[PROFILE_KEY] = prof;
    writeJsonAtomic(PROFILES_FILE, data);
    log.ok(`profile saved (backup: ${backup})`);
  }

  // 5. options.txt (only if absent)
  log.step('Game settings');
  const optFile = path.join(gameDir, 'options.txt');
  const lang = mcLanguage();
  if (fs.existsSync(optFile)) log.info('options.txt exists — left untouched');
  else if (DRY) log.dry(`would write options.txt (render 10, simulation 8, 60 FPS + VSync, fast clouds, smooth lighting, ${lang})`);
  else {
    writeFileAtomic(optFile, optionsTxt(lang));
    log.ok(`options.txt: render distance 10, simulation 8, 60 FPS + VSync, fast clouds, smooth lighting, GUI auto, narrator off, ${lang}`);
  }
  if (shaders) {
    const irisCfg = path.join(gameDir, 'config', 'iris.properties');
    if (!fs.existsSync(irisCfg) && wantedPacks[0]) {
      if (DRY) log.dry(`would enable shader pack ${wantedPacks[0].name}`);
      else {
        writeFileAtomic(irisCfg, `enableShaders=true\nshaderPack=${wantedPacks[0].name}\n`);
        log.ok(`shaders on: ${wantedPacks[0].name} (toggle in Options → Video → Shader Packs, or press K)`);
      }
    }
  }

  // 6. engine discovery for singleplayer
  log.step('Engine link');
  const ep = writeEnginePath();
  (DRY && ep.changed ? log.dry : log.ok)(`${ep.file} → ${path.join(REPO_ROOT, 'engine')}${ep.changed ? '' : ' (unchanged)'}`);
  const cp = pinClaudePath();
  if (cp.pinned) (DRY ? log.dry : log.ok)(`claudePath = ${cp.path} in ${cp.file} (the game does not see your shell PATH)`);
  else log.info(cp.reason);

  if (!DRY) {
    ensureMcaiHome();
    writeJsonAtomic(STATE_FILE(), {
      mcDir: MC_DIR, profileKey: PROFILE_KEY, versionId, gameDir, javaArgs: prof.javaArgs, javaDir: prof.javaDir ?? null, shaders,
      createdVersion, mods: wantedMods.map((w) => w.name), shaderpacks: wantedPacks.map((w) => w.name), lastBackup: backup, installedAt: now,
    }, 0o600);
  }

  console.log(`\n${c.green(c.bold(DRY ? '✔ Dry run complete.' : '✔ mcAI is installed.'))}`);
  console.log(`  Open the Minecraft Launcher, pick ${c.bold(`'${PROFILE_NAME}'`)} (next to the Play button), press ${c.bold('Play')}.`);
  if (process.platform === 'darwin') console.log(c.dim(`  (./mcai play does all of that for you)`));
}

// ------------------------------------------------------------------ uninstall

async function uninstall() {
  const st = readJson(STATE_FILE(), {});
  const gameDir = st.gameDir ?? path.join(MC_DIR, 'profiles', 'mcai');
  console.log(c.bold(`mcAI client uninstall${DRY ? c.cyan('  (dry run)') : ''}`));
  if (fs.existsSync(PROFILES_FILE)) await ensureLauncherClosed('the removal');
  if (gameProcesses(gameDir).length) throw new UserError('Minecraft is running with the mcAI profile — quit the game first.', 4);

  if (fs.existsSync(PROFILES_FILE)) {
    if (opt['restore-backup']) {
      const dir = path.join(mcaiHome(), 'backups');
      const all = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith('launcher_profiles.')).sort() : [];
      // the oldest backup is the state before mcAI touched the file the first time
      const pick = st.firstBackup ?? (all[0] ? path.join(dir, all[0]) : null);
      if (!pick) throw new UserError('no backup found in ~/.mcai/backups');
      if (DRY) log.dry(`would restore ${pick}`);
      else {
        const cur = backupProfiles();
        fs.copyFileSync(pick, PROFILES_FILE);
        log.ok(`restored ${pick} (current file saved as ${cur})`);
      }
    } else {
      const data = readProfiles();
      if (data.profiles[st.profileKey ?? PROFILE_KEY]) {
        if (DRY) log.dry(`would remove profile '${PROFILE_NAME}'`);
        else {
          const b = backupProfiles();
          delete data.profiles[st.profileKey ?? PROFILE_KEY];
          writeJsonAtomic(PROFILES_FILE, data);
          log.ok(`profile removed (backup: ${b})`);
        }
      } else log.info('no mcAI profile in launcher_profiles.json');
    }
  }
  const versionId = st.versionId ?? `fabric-loader-${modVersion().loader}-${MC_VERSION}`;
  const vdir = path.join(MC_DIR, 'versions', versionId);
  if (fs.existsSync(vdir)) {
    if (st.createdVersion === false) log.info(`${versionId} existed before mcAI — kept`);
    else if (DRY) log.dry(`would remove ${vdir}`);
    else {
      fs.rmSync(vdir, { recursive: true, force: true });
      log.ok(`removed ${vdir}`);
    }
  }
  for (const sub of ['mods', 'shaderpacks']) {
    const d = path.join(gameDir, sub);
    const man = path.join(d, '.mcai-managed.json');
    if (!fs.existsSync(man)) continue;
    const files = readJson(man, {}).files ?? [];
    if (DRY) log.dry(`would remove ${files.length} mcAI-managed files from ${d}`);
    else {
      for (const f of files) fs.rmSync(path.join(d, f), { force: true });
      fs.rmSync(man, { force: true });
      log.ok(`removed ${files.length} managed files from ${sub}/`);
    }
  }
  if (opt.purge) {
    if (DRY) log.dry(`would DELETE ${gameDir} (including worlds in saves/)`);
    else if (fs.existsSync(gameDir)) {
      fs.rmSync(gameDir, { recursive: true, force: true });
      log.ok(`deleted ${gameDir}`);
    }
  } else if (fs.existsSync(gameDir)) log.info(`kept ${gameDir} (your mcAI worlds/settings; --purge deletes it)`);
  const ep = path.join(mcaiHome(), 'engine-path');
  if (fs.existsSync(ep) && fs.readFileSync(ep, 'utf8').split('\n')[0] === path.join(REPO_ROOT, 'engine')) {
    if (DRY) log.dry(`would remove ${ep}`);
    else fs.rmSync(ep, { force: true });
  }
  if (!DRY) fs.rmSync(STATE_FILE(), { force: true });
  console.log(`\n${c.green(c.bold(DRY ? '✔ Dry run complete.' : '✔ mcAI removed from the launcher.'))}`);
}

// ------------------------------------------------------------------ main

async function main() {
  if (opt.help) return usage();
  if (opt.uninstall) return uninstall();
  // remember the very first backup (the pre-mcAI state) for --restore-backup
  const st = readJson(STATE_FILE(), {});
  await install();
  if (!DRY && !st.firstBackup) {
    const now = readJson(STATE_FILE(), {});
    if (now.lastBackup) writeJsonAtomic(STATE_FILE(), { ...now, firstBackup: now.lastBackup }, 0o600);
  } else if (!DRY && st.firstBackup) {
    const now = readJson(STATE_FILE(), {});
    writeJsonAtomic(STATE_FILE(), { ...now, firstBackup: st.firstBackup }, 0o600);
  }
}

main().catch((e) => {
  if (e instanceof UserError) {
    console.error(`\n${c.red('✘')} ${e.message}`);
    process.exit(e.code);
  }
  console.error(`\n${c.red('✘ unexpected error:')} ${e.stack ?? e.message}`);
  process.exit(1);
});
