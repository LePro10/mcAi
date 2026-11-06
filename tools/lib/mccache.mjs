// Shared helpers for the verified Minecraft download cache (mc-fetch / mc-mirror).
//
// Cache layout mirrors the original Mojang URL structure, so that serving it is a
// pure path mapping:
//   <cache>/piston-meta/v1/packages/<sha1>/<version>.json   (verbatim, sha1-verified)
//   <cache>/piston-data/v1/objects/<sha1>/<file>            (client/server jars, logging config)
//   <cache>/libraries/<maven path>                          (= libraries.minecraft.net)
//   <cache>/resources/<hh>/<hash>                            (= resources.download.minecraft.net)
//   <cache>/versions.json                                    (index of verified versions)

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CACHE_DIR = process.env.MCAI_MC_CACHE || join(homedir(), '.mcai-tools', 'mc');

/** Original host → cache sub directory (and mirror path prefix). */
export const HOSTS = {
  'https://piston-meta.mojang.com/': 'piston-meta/',
  'https://launchermeta.mojang.com/': 'piston-meta/',
  'https://piston-data.mojang.com/': 'piston-data/',
  'https://launcher.mojang.com/': 'piston-data/',
  'https://libraries.minecraft.net/': 'libraries/',
  'https://resources.download.minecraft.net/': 'resources/',
};

/** Map an original Mojang URL to a cache-relative path, or null if unknown host. */
export function urlToCachePath(url) {
  for (const [prefix, dir] of Object.entries(HOSTS)) {
    if (url.startsWith(prefix)) return dir + url.slice(prefix.length);
  }
  return null;
}

/** Replace every known Mojang host in a JSON text by `<base>/<dir>`. */
export function rewriteUrls(text, base) {
  let out = text;
  for (const [prefix, dir] of Object.entries(HOSTS)) {
    out = out.split(prefix).join(`${base.replace(/\/$/, '')}/${dir}`);
  }
  return out;
}

export function sha1(buf) {
  return createHash('sha1').update(buf).digest('hex');
}

export function sha1File(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha1');
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}
