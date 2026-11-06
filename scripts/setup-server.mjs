#!/usr/bin/env node
// Install / update a Fabric 26.3 dedicated server with mcAI into a directory (default <repo>/server).
//
//   node scripts/setup-server.mjs --dir <dir> [--offline|--online] [--port N] [--accept-eula] [--dry-run]
//
// * server.jar: from the verified mc-fetch cache (~/.mcai-tools/mc) or Mojang, always sha1-checked against
//   the version JSON (whose own sha1 comes from Mojang's manifest / the cache's content address).
// * Fabric server launcher: meta.fabricmc.net (cached under ~/.mcai/cache/fabric; ~/.mcai-tools/fabric fallback).
// * mods/: fabric-api, lithium, ferrite-core (Modrinth, sha512-verified) + mod/build/libs/mcai-<v>.jar.
// * EULA: never accepted on your behalf — only with --accept-eula or MCAI_ACCEPT_EULA=1, which means YOU accept
//   https://aka.ms/MinecraftEULA. Exit code 5 if it is not accepted.
// * server.properties: created with defaults on first install; later runs only change what you pass.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  REPO_ROOT, MC_VERSION, c, log, UserError, mcaiHome, modVersion, readJson, writeFileAtomic, hashFile, cloneFile, fetchJson,
  downloadVerified, resolveModrinth, fetchPick, syncManagedDir, fabricModInfo, readZipEntry,
} from './lib/common.mjs';

const { values: opt } = parseArgs({
  options: {
    dir: { type: 'string' }, offline: { type: 'boolean' }, online: { type: 'boolean' }, port: { type: 'string' },
    'accept-eula': { type: 'boolean' }, 'dry-run': { type: 'boolean' }, quiet: { type: 'boolean' },
  },
});
const DRY = !!opt['dry-run'];
const DIR = path.resolve(opt.dir ?? path.join(REPO_ROOT, 'server'));
const TOOLS = path.join(os.homedir(), '.mcai-tools');
const SERVER_MODS = [
  { slug: 'fabric-api', why: 'required by mcAI' },
  { slug: 'lithium', why: 'server tick optimisations' },
  { slug: 'ferrite-core', why: 'lower memory use' },
];

// ------------------------------------------------------------------ vanilla server.jar

async function serverJar() {
  const dest = path.join(DIR, 'server.jar');
  // 1. verified cache: piston-meta/v1/packages/<sha1>/26.3.json (content-addressed)
  const cache = process.env.MCAI_MC_CACHE ?? path.join(TOOLS, 'mc');
  const pkg = path.join(cache, 'piston-meta', 'v1', 'packages');
  let vjson = null;
  if (fs.existsSync(pkg)) {
    for (const sha of fs.readdirSync(pkg)) {
      const f = path.join(pkg, sha, `${MC_VERSION}.json`);
      if (fs.existsSync(f) && hashFile(f, 'sha1') === sha) {
        vjson = readJson(f);
        break;
      }
    }
  }
  // 2. Mojang (manifest → version JSON, sha1-checked)
  if (!vjson) {
    const m = await fetchJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', {}, { tries: 2, timeoutMs: 15000 }).catch(() => null);
    const e = m?.versions?.find((v) => v.id === MC_VERSION);
    if (!e) throw new UserError(`cannot get the Minecraft ${MC_VERSION} version info (Mojang unreachable, no verified cache).\n    On a filtered network: node tools/mc-fetch.mjs ${MC_VERSION}`);
    const tmp = path.join(mcaiHome(), 'cache', 'mc', `${e.sha1}-${MC_VERSION}.json`);
    await downloadVerified(e.url, tmp, { sha1: e.sha1 });
    vjson = readJson(tmp);
  }
  const want = vjson.downloads.server;
  if (fs.existsSync(dest) && hashFile(dest, 'sha1') === want.sha1) return { sha1: want.sha1, src: 'up to date' };
  if (DRY) return { sha1: want.sha1, src: 'would install' };
  const cached = path.join(cache, 'piston-data', 'v1', 'objects', want.sha1, 'server.jar');
  if (fs.existsSync(cached) && hashFile(cached, 'sha1') === want.sha1) {
    cloneFile(cached, dest);
    return { sha1: want.sha1, src: 'verified cache' };
  }
  await downloadVerified(want.url, dest, { sha1: want.sha1, size: want.size });
  return { sha1: want.sha1, src: 'Mojang' };
}

// ------------------------------------------------------------------ Fabric server launcher

async function fabricLauncher(loader) {
  const name = `fabric-server-${MC_VERSION}-${loader}-1.1.2.jar`;
  const cacheDir = path.join(mcaiHome(), 'cache', 'fabric');
  const candidates = [path.join(cacheDir, name), path.join(TOOLS, 'fabric', name)];
  const valid = (f) => {
    try {
      const mf = readZipEntry(f, 'META-INF/MANIFEST.MF')?.toString('utf8') ?? '';
      return /Main-Class:\s*net\.fabricmc\.(installer\.ServerLauncher|loader\.impl\.launch\.server\.FabricServerLauncher)\b/.test(mf);
    } catch {
      return false;
    }
  };
  let src = candidates.find((f) => fs.existsSync(f) && valid(f));
  if (!src && !DRY) {
    // meta generates this jar; it publishes no checksum, so we validate its manifest instead
    const url = `https://meta.fabricmc.net/v2/versions/loader/${MC_VERSION}/${loader}/1.1.2/server/jar`;
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) }).catch(() => null);
    if (r?.ok) {
      const tmp = path.join(cacheDir, `${name}.part`);
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
      if (valid(tmp)) {
        fs.renameSync(tmp, candidates[0]);
        src = candidates[0];
      } else fs.rmSync(tmp, { force: true });
    }
  }
  if (!src && !DRY) throw new UserError(`Fabric server launcher not cached and meta.fabricmc.net unreachable (${name})`);
  if (!DRY) {
    cloneFile(src, path.join(DIR, 'fabric-server-launch.jar'));
    writeFileAtomic(path.join(DIR, 'fabric-server-launcher.properties'), 'serverJar=server.jar\n');
  }
  return src ?? 'meta.fabricmc.net (on install)';
}

// ------------------------------------------------------------------ server.properties

function properties(first) {
  const file = path.join(DIR, 'server.properties');
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const set = (k, v) => {
    const re = new RegExp(`^${k.replace(/[-.]/g, '\\$&')}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, `${k}=${v}`) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${k}=${v}\n`;
  };
  if (first) {
    set('motd', 'mcAI \\u00b7 AI architect server (Fabric 26.3)');
    set('online-mode', 'true');
    set('view-distance', '10');
    set('simulation-distance', '8');
    set('pause-when-empty-seconds', '0'); // AI build tasks must keep ticking after the player logs off
    set('enable-rcon', 'false');
    set('max-players', '10');
    set('sync-chunk-writes', 'false'); // fewer fsyncs: smoother on laptops; vanilla still saves regularly
  }
  if (opt.offline) set('online-mode', 'false');
  if (opt.online) set('online-mode', 'true');
  if (opt.port) {
    if (!/^\d+$/.test(opt.port) || +opt.port < 1 || +opt.port > 65535) throw new UserError('--port must be 1..65535');
    set('server-port', opt.port);
  }
  if (!DRY) writeFileAtomic(file, text);
  const get = (k) => text.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1];
  return { online: get('online-mode') !== 'false', port: get('server-port') ?? '25565', view: get('view-distance'), sim: get('simulation-distance') };
}

// ------------------------------------------------------------------ main

async function main() {
  const v = modVersion();
  const first = !fs.existsSync(path.join(DIR, 'server.properties'));
  if (!opt.quiet) console.log(c.bold(`mcAI server setup → ${DIR}${DRY ? c.cyan('  (dry run)') : ''}`));
  if (!DRY) fs.mkdirSync(DIR, { recursive: true });

  // EULA first: no point downloading anything if it is not accepted
  const eulaFile = path.join(DIR, 'eula.txt');
  const accepted = fs.existsSync(eulaFile) && /^\s*eula\s*=\s*true\s*$/m.test(fs.readFileSync(eulaFile, 'utf8'));
  if (!accepted) {
    if (opt['accept-eula'] || process.env.MCAI_ACCEPT_EULA === '1') {
      if (!DRY) writeFileAtomic(eulaFile, `# Accepted by the operator (--accept-eula / MCAI_ACCEPT_EULA=1) on ${new Date().toISOString()}\n# https://aka.ms/MinecraftEULA\neula=true\n`);
      log.ok('Minecraft EULA accepted by you (eula.txt written)');
    } else {
      throw new UserError(`To run a Minecraft server you must accept the Minecraft EULA: https://aka.ms/MinecraftEULA
    Read it. If you accept it, run again with --accept-eula (or MCAI_ACCEPT_EULA=1).
    mcAI never accepts it for you.`, 5);
    }
  }

  const sj = await serverJar();
  log.ok(`server.jar ${MC_VERSION} ${c.dim(`sha1 ${sj.sha1.slice(0, 12)}… (${sj.src})`)}`);
  const fl = await fabricLauncher(v.loader);
  log.ok(`Fabric server launcher (loader ${v.loader}) ${c.dim(fl)}`);

  const jar = path.join(REPO_ROOT, 'mod', 'build', 'libs', `mcai-${v.mod}.jar`);
  if (!fs.existsSync(jar)) throw new UserError(`${jar} missing — build the mod first: ./mcai update`);
  if (fabricModInfo(jar)?.id !== 'mcai') throw new UserError(`${jar} is not a valid mcAI mod jar`);
  const picks = await resolveModrinth(SERVER_MODS.map((m) => ({ ...m, loaders: ['fabric'], ext: '.jar' })));
  const wanted = [];
  for (const p of picks) {
    const file = DRY ? null : (await fetchPick(p)).file;
    wanted.push({ name: p.filename, src: file, sha512: p.sha512 });
    log.ok(`${p.slug.padEnd(14)} ${p.versionNumber}  ${c.dim(SERVER_MODS.find((m) => m.slug === p.slug).why)}`);
  }
  wanted.push({ name: path.basename(jar), src: jar });
  log.ok(`${'mcai'.padEnd(14)} ${v.mod}  ${c.dim(path.relative(REPO_ROOT, jar))}`);
  if (!DRY) {
    const acts = syncManagedDir(path.join(DIR, 'mods'), wanted);
    const changed = acts.filter((a) => a.op !== 'keep');
    if (changed.length) log.ok(`mods/: ${changed.map((a) => `${a.op} ${a.file}`).join(', ')}`);
  }
  const p = properties(first);
  log.ok(`server.properties: port ${p.port}, online-mode ${p.online}, view ${p.view}, simulation ${p.sim}${first ? ' (new)' : ''}`);
  if (!p.online) log.warn('online-mode=false: anyone who can reach the port can join with any name — LAN/trusted networks only');
}

main().catch((e) => {
  if (e instanceof UserError) {
    console.error(`\n${c.red('✘')} ${e.message}`);
    process.exit(e.code);
  }
  console.error(`\n${c.red('✘ unexpected error:')} ${e.stack ?? e.message}`);
  process.exit(1);
});
