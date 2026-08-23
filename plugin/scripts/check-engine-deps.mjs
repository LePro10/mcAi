/**
 * Fail the plugin build if the engine grows a dependency.
 *
 * The engine rides inside mcAI.jar as plain JavaScript, with no node_modules
 * beside it. That works only because everything reachable from the plugin
 * entry point imports nothing but Node's standard library. If an import of a
 * package slips into that graph, the jar still builds, still installs, and
 * then dies at the first build with a module-not-found the server owner has no
 * way to fix — so it is caught here instead.
 *
 * Usage: node check-engine-deps.mjs <engine-dir> <entry> [entry…]
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const [dir, ...entries] = process.argv.slice(2);
if (!dir || entries.length === 0) {
  console.error('usage: check-engine-deps.mjs <engine-dir> <entry…>');
  process.exit(2);
}

const IMPORT = /(?:^|[\s;{(])(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const seen = new Set();
/** package specifier → the files that import it */
const external = new Map();

function resolve(from, spec) {
  const target = path.resolve(path.dirname(from), spec);
  for (const candidate of [target, `${target}.js`, path.join(target, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function walk(file) {
  const full = path.resolve(file);
  if (seen.has(full)) return;
  seen.add(full);

  let source;
  try { source = fs.readFileSync(full, 'utf8'); } catch { return; }

  for (const match of source.matchAll(IMPORT)) {
    const spec = match[1] ?? match[2];
    if (!spec) continue;
    if (spec.startsWith('.')) {
      const next = resolve(full, spec);
      if (next) walk(next);
      else console.error(`  warning: ${path.relative(dir, full)} imports "${spec}", which is not in the engine`);
      continue;
    }
    if (spec.startsWith('node:')) continue;
    if (!external.has(spec)) external.set(spec, new Set());
    external.get(spec).add(path.relative(dir, full));
  }
}

for (const entry of entries) walk(path.join(dir, entry));

if (external.size > 0) {
  console.error('\n  The engine now needs packages the jar cannot ship:\n');
  for (const [spec, importers] of external) {
    console.error(`    ${spec}  <-  ${[...importers].join(', ')}`);
  }
  console.error('\n  Plugin mode must stay dependency-free. Move the import behind a');
  console.error('  dynamic import on a path the plugin never takes, or vendor it.\n');
  process.exit(1);
}

console.log(`  engine: ${seen.size} modules reachable, no dependencies`);
