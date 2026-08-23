#!/usr/bin/env node
/**
 * Build on install.
 *
 * npm runs `prepare` after `npm install` in a git clone, which is what makes
 * `git clone && npm install && npm run sim` a two-step setup instead of three.
 * It also runs when installing the published package, where `dist/` already
 * exists and TypeScript does not — so skip quietly in that case rather than
 * failing someone's install.
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hasSources = existsSync(path.join(root, 'src', 'cli', 'main.ts'));
const hasCompiler = existsSync(path.join(root, 'node_modules', 'typescript'));

if (!hasSources || !hasCompiler) process.exit(0);

const result = spawnSync(process.execPath, [
  path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
  '-p', path.join(root, 'tsconfig.json'),
], { stdio: 'inherit', cwd: root });

if (result.status !== 0) {
  console.error('\nmcAI: the build failed. Run "npm run build" to see the errors.\n');
  process.exit(result.status ?? 1);
}
