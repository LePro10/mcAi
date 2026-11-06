#!/usr/bin/env node
// mc-mirror — serves the verified mc-fetch cache on 127.0.0.1 so that Fabric Loom / Gradle
// can build without reaching Mojang hosts. Only files already verified by mc-fetch exist in
// the cache; this server never downloads anything.
//
//   GET /piston-meta/mc/game/version_manifest_v2.json   generated from <cache>/versions.json
//   GET /piston-meta/v1/packages/<sha1>/<v>.json         version JSON, Mojang URLs rewritten
//                                                        to this mirror (manifest lists the sha1
//                                                        of the *rewritten* document)
//   GET /piston-data/...  /libraries/...  /resources/... verbatim files from the cache
//
// Usage: node tools/mc-mirror.mjs [--port 8790]     (env MCAI_MC_MIRROR_PORT also works)
// Loom wiring: see mod/settings.gradle + tools/README.md (env MCAI_MC_MIRROR=http://127.0.0.1:8790).

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';
import { CACHE_DIR, rewriteUrls, sha1, sha1File } from './lib/mccache.mjs';

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = Number(portArg >= 0 ? args[portArg + 1] : process.env.MCAI_MC_MIRROR_PORT || 8790);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOTS = ['piston-meta/', 'piston-data/', 'libraries/', 'resources/'];

async function loadIndex() {
  try { return JSON.parse(await readFile(join(CACHE_DIR, 'versions.json'), 'utf8')).versions; }
  catch { return []; }
}

async function rewrittenVersionJson(rel) {
  return rewriteUrls(await readFile(join(CACHE_DIR, rel), 'utf8'), BASE);
}

async function manifest() {
  const versions = [];
  for (const v of await loadIndex()) {
    const text = await rewrittenVersionJson(v.path);
    versions.push({
      id: v.id, type: v.type, url: `${BASE}/${v.path}`, time: v.time, releaseTime: v.releaseTime,
      sha1: sha1(Buffer.from(text, 'utf8')), complianceLevel: v.complianceLevel,
    });
  }
  versions.sort((a, b) => b.releaseTime.localeCompare(a.releaseTime));
  const rel = versions.find((v) => v.type === 'release')?.id;
  return JSON.stringify({ latest: { release: rel, snapshot: versions[0]?.id ?? rel }, versions });
}

function send(res, status, body, type = 'text/plain') {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

async function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
  const path = decodeURIComponent(new URL(req.url, BASE).pathname).replace(/^\/+/, '');
  if (path === '' || path === 'status') return send(res, 200, JSON.stringify({ ok: true, cache: CACHE_DIR, versions: (await loadIndex()).map((v) => v.id) }), 'application/json');
  if (path === 'piston-meta/mc/game/version_manifest_v2.json' || path === 'piston-meta/mc/game/version_manifest.json') {
    return send(res, 200, await manifest(), 'application/json');
  }
  if (!ROOTS.some((r) => path.startsWith(r))) return send(res, 404, 'not found');
  const file = normalize(join(CACHE_DIR, path));
  if (!file.startsWith(CACHE_DIR + sep)) return send(res, 400, 'bad path');

  // Maven checksum requests: answer from the actual file (Gradle may ask for them).
  const sum = path.match(/^(libraries\/.+)\.sha1$/);
  if (sum) {
    try { return send(res, 200, await sha1File(join(CACHE_DIR, sum[1]))); } catch { return send(res, 404, 'not found'); }
  }
  let st;
  try { st = await stat(file); } catch { return send(res, 404, 'not found'); }
  if (!st.isFile() || file.endsWith('.part')) return send(res, 404, 'not found');
  if (path.startsWith('piston-meta/') && path.endsWith('.json')) {
    return send(res, 200, await rewrittenVersionJson(path), 'application/json');
  }
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': st.size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => { if (!res.headersSent) send(res, 500, String(e?.message || e)); else res.destroy(); });
});
server.on('error', (e) => { console.error(`mc-mirror: ${e.message}`); process.exit(1); });
server.listen(PORT, '127.0.0.1', () => console.log(`mc-mirror serving ${CACHE_DIR} at ${BASE}`));
