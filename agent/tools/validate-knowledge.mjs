#!/usr/bin/env node
// Validates every block id / block state mentioned in the agent knowledge base against
// engine/data/registry-26.3.json (ids, property names and property values).
//
//   node agent/tools/validate-knowledge.mjs [--verbose]
//
// What is checked:
//   * knowledge/palettes.json   — every string leaf (keys starting with "_" are skipped).
//                                 Weighted pattern strings ("60%a,40%b") are split.
//   * knowledge/styles/*.md     — every `backtick` span must be a block id/state or a
//                                 weighted pattern (convention: only blocks go in backticks).
//   * all other *.md + SYSTEM.md + agents.json — only "state-like" tokens are checked:
//                                 anything with a `minecraft:` prefix, or `id[prop=value]`.
//   * knowledge/script-cookbook.md — additionally every quoted string literal inside code
//                                 blocks that looks like a block id (contains "_" or "[")
//                                 and is not in the ignore list.
// Ignore words per file with an HTML comment:  <!-- validate-ignore: word other_word -->
// Exit code 1 if anything is invalid.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const agentDir = join(here, '..');
const root = join(agentDir, '..');
const verbose = process.argv.includes('--verbose');
const reg = JSON.parse(readFileSync(join(root, 'engine/data/registry-26.3.json'), 'utf8'));
const blocks = reg.blocks;

const problems = [];
let checked = 0;

// Non-block block-like words that are allowed in "state-like" positions (global).
const GLOBAL_IGNORE = new Set(['keep', 'air', 'solid', 'liquid', '!air']);

function splitTop(s, sep) {
  // split on sep at bracket/brace depth 0
  const out = []; let depth = 0; let cur = '';
  for (const ch of s) {
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

function stripSnbt(state) {
  // remove a trailing {snbt} (balanced) from a state string
  const i = state.search(/\{/);
  return i < 0 ? state : state.slice(0, i);
}

/** returns error string or null */
function checkState(raw) {
  let s = raw.trim();
  if (!s) return 'empty';
  s = stripSnbt(s);
  const m = /^(?:(minecraft):)?([a-z0-9_]+)(?:\[([^\]]*)\])?$/.exec(s);
  if (!m) return `unparseable block state "${raw}"`;
  const id = `minecraft:${m[2]}`;
  const info = blocks[id];
  checked++;
  if (!info) {
    const near = Object.keys(blocks).filter((k) => k.includes(m[2]) || m[2].includes(k.slice(10))).slice(0, 4);
    return `unknown block id "${m[2]}"` + (near.length ? ` (did you mean ${near.map((k) => k.slice(10)).join(', ')}?)` : '');
  }
  if (m[3] !== undefined && m[3].trim() !== '') {
    for (const part of m[3].split(',')) {
      const [k, v] = part.split('=').map((x) => x?.trim());
      if (!k) return `bad property syntax "${part}" in "${raw}"`;
      const vals = info.properties?.[k];
      if (v === undefined) { // documentation form: bare property name
        if (!vals) return `"${m[2]}" has no property "${k}"`;
        continue;
      }
      if (!vals) return `"${m[2]}" has no property "${k}" (has: ${Object.keys(info.properties || {}).join(', ') || 'none'})`;
      // documentation forms: a|b|c (alternatives) and 0..15 (range) — check every alternative / both ends
      const range = /^(\d+)\.\.(\d+)$/.exec(v);
      const alts = range ? [range[1], range[2]] : v.split('|');
      for (const a of alts) if (!vals.includes(a)) return `"${m[2]}[${k}=${a}]": invalid value (allowed: ${vals.join('|')})`;
    }
  }
  return null;
}

/** a pattern string: "a" | "60%a,40%b[x=y]" ; returns list of errors */
function checkPattern(raw) {
  const errs = [];
  for (let part of splitTop(raw, ',')) {
    part = part.trim().replace(/^\d+(\.\d+)?%/, '');
    if (GLOBAL_IGNORE.has(part)) continue;
    const e = checkState(part);
    if (e) errs.push(e);
  }
  return errs;
}

function report(file, where, errs) {
  for (const e of errs) problems.push(`${file}: ${where}: ${e}`);
}

function ignoresOf(text) {
  const set = new Set(GLOBAL_IGNORE);
  for (const m of text.matchAll(/<!--\s*validate-ignore:([^>]*)-->/g)) for (const w of m[1].trim().split(/\s+/)) set.add(w);
  return set;
}

// ---------- palettes.json
const PATTERN_META = new Set(['type', 'axis', 'size', 'scale', 'seed', 'dither', 'weight']);
function walkJson(node, path, file) {
  if (typeof node === 'string') { report(file, path, checkPattern(node)); return; }
  if (Array.isArray(node)) { node.forEach((x, i) => walkJson(x, `${path}[${i}]`, file)); return; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) if (!k.startsWith('_') && !PATTERN_META.has(k)) walkJson(v, path ? `${path}.${k}` : k, file);
  }
}
const palPath = join(agentDir, 'knowledge/palettes.json');
if (existsSync(palPath)) {
  const rel = relative(root, palPath);
  try { walkJson(JSON.parse(readFileSync(palPath, 'utf8')), '', rel); } catch (e) { problems.push(`${rel}: invalid JSON: ${e.message}`); }
}

// ---------- markdown helpers
const STATE_LIKE = /(?:minecraft:[a-z0-9_]+(?:\[[^\]\s]*\])?)|(?:(?<![\w>*:])[a-z][a-z0-9_]*\[[a-z_0-9]+=[^\]\s]*\])/g;

function checkStateLike(text, file, ignore) {
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(STATE_LIKE)) {
      const tok = m[0];
      if (ignore.has(tok) || ignore.has(tok.replace(/^minecraft:/, '').replace(/\[.*$/, ''))) continue;
      // skip tags (#minecraft:logs) and non-block namespaced ids (e.g. minecraft:stripe_top banner patterns)
      const before = line[m.index - 1];
      if (before === '#') continue;
      // "minecraft:..." inside quotes = item / banner pattern / resource id in SNBT, not a block
      if (before === '"' || before === "'") continue;
      const bare = tok.replace(/^minecraft:/, '').replace(/\[.*$/, '');
      if (tok.startsWith('minecraft:') && !tok.includes('[') && ignore.has(bare)) continue;
      const e = checkState(tok);
      if (e) report(file, `line ${i + 1}`, [e]);
    }
  });
}

function checkBackticksStrict(text, file, ignore) {
  const lines = text.split('\n');
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const span = m[1].trim();
      if (ignore.has(span)) continue;
      report(file, `line ${i + 1}`, checkPattern(span));
    }
  });
}

function checkCodeStrings(text, file, ignore) {
  const lines = text.split('\n');
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return; }
    if (!inFence) return;
    for (const m of line.matchAll(/(['"])((?:(?!\1).)*)\1/g)) {
      const s = m[2];
      if (!/^[0-9a-z_:%,.\[\]=]+$/.test(s)) continue;          // not block-ish
      if (!/[_\[:%]/.test(s)) continue;                         // single plain words are ambiguous
      if (ignore.has(s)) continue;
      const errs = checkPattern(s).filter(Boolean);
      report(file, `line ${i + 1} (code string '${s}')`, errs);
    }
  });
}

function mdFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...mdFiles(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

const files = [...mdFiles(join(agentDir, 'knowledge')), join(agentDir, 'SYSTEM.md')].filter(existsSync);
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  const rel = relative(root, f);
  const ignore = ignoresOf(text);
  if (f.includes(`${'/'}styles${'/'}`)) checkBackticksStrict(text, rel, ignore);
  checkStateLike(text, rel, ignore);
  if (f.endsWith('script-cookbook.md')) checkCodeStrings(text, rel, ignore);
}
const agentsJson = join(agentDir, 'agents.json');
if (existsSync(agentsJson)) {
  const rel = relative(root, agentsJson);
  try {
    const a = JSON.parse(readFileSync(agentsJson, 'utf8'));
    for (const [name, def] of Object.entries(a)) {
      if (!def.description || !def.prompt) problems.push(`${rel}: agent "${name}" needs description and prompt`);
      checkStateLike(def.prompt, `${rel}#${name}`, new Set(GLOBAL_IGNORE));
    }
  } catch (e) { problems.push(`${rel}: invalid JSON: ${e.message}`); }
}

// dedupe
const uniq = [...new Set(problems)];
if (verbose || uniq.length) for (const p of uniq) console.log('INVALID', p);
console.log(`checked ${checked} block references in ${files.length + 2} files: ${uniq.length} invalid`);
process.exit(uniq.length ? 1 : 0);
