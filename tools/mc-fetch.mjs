#!/usr/bin/env node
// mc-fetch — download + verify a Minecraft version (version JSON, client/server jars,
// libraries, optionally assets) into a local cache (default ~/.mcai-tools/mc).
//
// Trust chain:
//   1. Anchor sha1 of the version JSON, from (first available):
//        --sha1 <hex>  |  Mojang version manifest (HTTPS)  |  misode/mcmeta "<v>-summary/version.json"
//        (GitHub HTTPS)  |  pinned value in this file.
//   2. The version JSON (from Mojang or the BMCLAPI mirror) must hash to the anchor.
//   3. Every jar / library / asset is verified against the sha1 (+ size) listed in that
//      JSON (or the asset index it references, itself sha1-verified).
//   Anything that does not verify is discarded; the script never disables TLS checks.
//
// Usage: node tools/mc-fetch.mjs [version=26.3] [--sha1 <hex>] [--assets] [--import <dir>] [--quiet]
//   --import <dir>  take files from a local directory (any layout) when their sha1 matches,
//                   e.g. client.jar/server.jar downloaded on another network.
// Idempotent: files already present with the right sha1 are skipped.

import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { CACHE_DIR, sha1File, urlToCachePath } from './lib/mccache.mjs';

const PINNED = { '26.3': '96c00d95a31328714d3811cfade2804bb050e455' };
const BMCL = 'https://bmclapi2.bangbang93.com/';
const MOJANG_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const MISODE = (v) => `https://raw.githubusercontent.com/misode/mcmeta/${v}-summary/version.json`;

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const VERSION = args.find((a, i) => !a.startsWith('--') && !['--sha1', '--import'].includes(args[i - 1])) || '26.3';
const QUIET = flag('--quiet');
const log = (...m) => { if (!QUIET) console.log(...m); };

// ---------------------------------------------------------------- networking

const deadHosts = new Map();          // host → consecutive connection failures
const pauseUntil = new Map();         // host → back-off deadline after HTTP 429
const ROUNDS = Number(process.env.MCAI_FETCH_ROUNDS || 40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Mojang's own hosts: when a mirror redirects there and they are blocked, retrying is pointless. */
const isBlockedHost = (host) => /(^|\.)(mojang\.com|minecraft\.net)$/.test(host);

class HttpError extends Error {
  constructor(status, url) { super(`HTTP ${status} ${url}`); this.status = status; }
}

/** GET with manual redirect handling so the failing hop (mirror node) is known. */
async function get(url, { timeout = 120_000 } = {}) {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    const host = new URL(current).host;
    if (hop > 0 && isBlockedHost(host) && (deadHosts.get(host) || 0) >= 2) {
      const err = new Error(`${new URL(url).host} redirects to ${host}, which is unreachable from this network`);
      err.permanent = true;
      throw err;
    }
    const wait = (pauseUntil.get(host) || 0) - Date.now();
    if (wait > 0) await sleep(wait);
    let res;
    try {
      res = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      const cause = e.cause?.code || e.cause?.message || e.message;
      // Count failures per host; a mirror node with a broken cert only affects that node.
      deadHosts.set(host, (deadHosts.get(host) || 0) + 1);
      const err = new Error(`${host}: ${cause}`);
      err.permanent = hop > 0 && isBlockedHost(host);
      throw err;
    }
    deadHosts.delete(host);
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel();
      current = new URL(res.headers.get('location'), current).href;
      continue;
    }
    if (res.status === 429) {
      await res.body?.cancel();
      pauseUntil.set(host, Math.max(pauseUntil.get(host) || 0, Date.now() + 30_000));   // BMCLAPI rate limit
      throw new HttpError(429, current);
    }
    if (!res.ok) {
      await res.body?.cancel();
      const err = new HttpError(res.status, current);
      err.permanent = res.status === 404 || res.status === 403;
      throw err;
    }
    return res;
  }
  throw new Error(`too many redirects: ${url}`);
}

/** Download to `dest`, verifying sha1 (+ size). Tries each source URL in turn, several rounds. */
async function download(sources, dest, expectSha1, expectSize) {
  if (await verifyExisting(dest, expectSha1)) return 'cached';
  await mkdir(dirname(dest), { recursive: true });
  const local = importIndex.get(expectSha1);
  if (local) { await copyFile(local, dest); return 'imported'; }
  const errors = [];
  let hopeless = 0;
  for (let round = 0; round < ROUNDS; round++) {
    let tried = 0, permanent = 0;
    for (const src of sources) {
      const host = new URL(src).host;
      if (isBlockedHost(host) && (deadHosts.get(host) || 0) >= 2) continue;   // e.g. blocked Mojang hosts
      tried++;
      try {
        const res = await get(src);
        const tmp = `${dest}.part`;
        const fh = await open(tmp, 'w');
        const h = createHash('sha1');
        let size = 0;
        try {
          for await (const chunk of res.body) { h.update(chunk); size += chunk.length; await fh.write(chunk); }
        } finally { await fh.close(); }
        const got = h.digest('hex');
        if (got !== expectSha1 || (expectSize != null && size !== expectSize)) {
          await rm(tmp, { force: true });
          throw new Error(`verification failed from ${host}: sha1 ${got} (want ${expectSha1}), size ${size}`);
        }
        await rename(tmp, dest);
        return host;
      } catch (e) {
        errors.push(e.message);
        if (e.permanent) permanent++;
      }
    }
    // Every source is unreachable or definitively lacks the file: stop after a confirmation round.
    if (permanent === tried && ++hopeless >= 2) break;
    await sleep(Math.min(1000 * 2 ** round, 15_000));
  }
  throw new Error(`could not download ${dest} (sha1 ${expectSha1}):\n  ${[...new Set(errors)].slice(-6).join('\n  ')}`);
}

async function verifyExisting(path, expectSha1) {
  try { await stat(path); } catch { return false; }
  return (await sha1File(path)) === expectSha1;
}

/** Alternative sources for an original Mojang URL. Order: original, then mirrors. */
function sourcesFor(url) {
  const u = new URL(url);
  const path = u.pathname.slice(1);
  switch (u.host) {
    case 'libraries.minecraft.net':
      // Maven Central first: most libraries are identical copies (sha1-verified anyway).
      return [`https://repo1.maven.org/maven2/${path}`, url, `${BMCL}maven/${path}`];
    case 'resources.download.minecraft.net':
      return [url, `${BMCL}assets/${path}`];
    case 'piston-data.mojang.com': case 'piston-meta.mojang.com':
    case 'launcher.mojang.com': case 'launchermeta.mojang.com':
      return [url, `${BMCL}${path}`];
    default:
      return [url];
  }
}

async function getJson(url) {
  return (await get(url, { timeout: 20_000 })).json();
}

// ---------------------------------------------------------------- trust anchor

async function resolveAnchor(version) {
  const cli = opt('--sha1');
  if (cli) return { sha1: cli.toLowerCase(), source: 'command line' };
  try {
    const m = await getJson(MOJANG_MANIFEST);
    const v = m.versions.find((x) => x.id === version);
    if (v) return { sha1: v.sha1, source: 'Mojang version manifest', entry: v };
  } catch (e) { log(`  (Mojang manifest unavailable: ${e.message})`); }
  try {
    const s = await getJson(MISODE(version));
    if (s.id === version && /^[0-9a-f]{40}$/.test(s.sha1)) return { sha1: s.sha1, source: 'misode/mcmeta summary' };
  } catch (e) { log(`  (misode/mcmeta unavailable: ${e.message})`); }
  if (PINNED[version]) return { sha1: PINNED[version], source: 'pinned in mc-fetch.mjs' };
  throw new Error(`no trust anchor for version ${version}; pass --sha1 <sha1 of ${version}.json>`);
}

// ---------------------------------------------------------------- main

async function pool(items, n, fn) {
  let i = 0, done = 0;
  const failures = [];
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const item = items[i++];
      try { await fn(item); } catch (e) { failures.push(e.message); }
      done++;
      if (!QUIET && (done % 25 === 0 || done === items.length)) process.stdout.write(`  ${done}/${items.length}\r`);
    }
  }));
  if (!QUIET) process.stdout.write('\n');
  return failures;
}

async function fetchFile(url, sha, size) {
  const rel = urlToCachePath(url);
  if (!rel) throw new Error(`unexpected host in ${url}`);
  return download(sourcesFor(url), join(CACHE_DIR, rel), sha, size);
}

/** --import <dir>: files obtained elsewhere (e.g. copied from another machine); used only if their sha1 matches. */
const importIndex = new Map();
async function indexImportDir(dir) {
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const p = join(e.parentPath ?? e.path, e.name);
    importIndex.set(await sha1File(p), p);
  }
  log(`  import dir ${dir}: ${importIndex.size} files indexed`);
}

async function main() {
  if (opt('--import')) await indexImportDir(opt('--import'));
  log(`mc-fetch ${VERSION} → ${CACHE_DIR}`);
  const anchor = await resolveAnchor(VERSION);
  log(`  trust anchor ${anchor.sha1} (${anchor.source})`);

  const metaUrl = `https://piston-meta.mojang.com/v1/packages/${anchor.sha1}/${VERSION}.json`;
  await fetchFile(metaUrl, anchor.sha1);
  const metaPath = join(CACHE_DIR, urlToCachePath(metaUrl));
  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  if (meta.id !== VERSION) throw new Error(`version JSON id ${meta.id} != ${VERSION}`);
  log(`  version JSON verified`);

  const files = [];
  for (const [name, d] of Object.entries(meta.downloads || {})) files.push({ name, ...d });
  if (meta.logging?.client?.file) files.push({ name: 'logging', ...meta.logging.client.file });
  if (meta.assetIndex) files.push({ name: 'asset index', ...meta.assetIndex });
  for (const lib of meta.libraries || []) {
    const dl = lib.downloads || {};
    if (dl.artifact?.url) files.push({ name: lib.name, ...dl.artifact });
    for (const c of Object.values(dl.classifiers || {})) if (c.url) files.push({ name: lib.name, ...c });
  }
  log(`  ${files.length} files (jars, libraries, metadata)`);
  // Libraries first: most come from Maven Central quickly; the rate-limited mirror goes last.
  files.sort((a, b) => Number(!a.url.includes('libraries.minecraft.net')) - Number(!b.url.includes('libraries.minecraft.net')));
  const failures = await pool(files, 4, (f) => fetchFile(f.url, f.sha1, f.size));

  if (flag('--assets') && meta.assetIndex) {
    const idx = JSON.parse(await readFile(join(CACHE_DIR, urlToCachePath(meta.assetIndex.url)), 'utf8'));
    const objs = [...new Map(Object.values(idx.objects).map((o) => [o.hash, o])).values()];
    log(`  ${objs.length} asset objects`);
    failures.push(...await pool(objs, 6, (o) =>
      fetchFile(`https://resources.download.minecraft.net/${o.hash.slice(0, 2)}/${o.hash}`, o.hash, o.size)));
  }

  if (failures.length) {
    console.error(`FAILED (${failures.length}):\n${failures.join('\n')}`);
    console.error('Hint: download the missing files on another network and pass --import <dir> (verified by sha1).');
    process.exit(1);
  }

  // Index of verified versions (consumed by mc-mirror to build a version manifest).
  const indexPath = join(CACHE_DIR, 'versions.json');
  let index = { versions: [] };
  try { index = JSON.parse(await readFile(indexPath, 'utf8')); } catch {}
  index.versions = index.versions.filter((v) => v.id !== VERSION);
  index.versions.push({
    id: VERSION, type: meta.type, time: meta.time, releaseTime: meta.releaseTime,
    complianceLevel: meta.complianceLevel ?? 1, sha1: anchor.sha1, anchorSource: anchor.source,
    path: urlToCachePath(metaUrl), assets: flag('--assets') || undefined, verifiedAt: new Date().toISOString(),
  });
  await writeFile(indexPath, JSON.stringify(index, null, 2) + '\n');
  log(`OK — ${VERSION} complete and verified (${files.length} files${flag('--assets') ? ' + assets' : ''}).`);
}

main().catch((e) => { console.error(`mc-fetch: ${e.message}`); process.exit(1); });

