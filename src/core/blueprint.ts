/**
 * Blueprint validation.
 *
 * The model writes these by hand, so errors have to be actionable: say which
 * part, which field, and what the fix is. A vague "invalid blueprint" costs a
 * whole extra model round trip; a precise one gets repaired on the retry.
 */

import type { Blueprint, Part, Vec3 } from './types.js';

export const OPS = [
  'box', 'shell', 'walls', 'frame', 'cylinder', 'sphere', 'cone', 'pyramid',
  'roof', 'arch', 'battlements', 'spiral', 'line', 'set', 'windows', 'door',
  'scatter', 'clear', 'foundation', 'group', 'repeat', 'symmetry', 'prefab',
] as const;

const OP_SET = new Set<string>(OPS);

/** Fields each op requires, checked before compilation. */
const REQUIRED: Record<string, string[]> = {
  box: ['at', 'size'],
  shell: ['at', 'size'],
  walls: ['at', 'size'],
  frame: ['at', 'size'],
  cylinder: ['at', 'r', 'h'],
  sphere: ['at', 'r'],
  cone: ['at', 'r', 'h'],
  pyramid: ['at', 'size'],
  roof: ['at', 'size'],
  arch: ['at', 'span', 'h'],
  battlements: ['at', 'size'],
  spiral: ['at', 'r', 'h'],
  line: ['from', 'to'],
  set: ['at'],
  windows: ['at', 'size'],
  door: ['at'],
  scatter: ['at', 'size'],
  clear: ['at', 'size'],
  foundation: ['at', 'size'],
  group: ['of'],
  repeat: ['count', 'of'],
  symmetry: ['axis', 'of'],
  prefab: ['name'],
};

export interface ValidationIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

function isVec2(v: unknown): boolean {
  return Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/** Estimated voxel count, used to reject absurd blueprints before compiling. */
function estimateVolume(part: Part): number {
  const p = part as unknown as Record<string, unknown>;
  const size = p.size as number[] | undefined;
  switch (part.op) {
    case 'box': case 'clear': case 'scatter': case 'pyramid':
      return isVec3(size) ? Math.abs(size[0] * size[1] * size[2]) : 1;
    case 'shell': case 'walls': case 'frame': case 'roof': case 'battlements': case 'windows':
      return isVec3(size) ? Math.abs(size[0] * size[1] * size[2]) : 1;
    case 'foundation':
      return isVec2(size) ? Math.abs((size as number[])[0] * (size as number[])[1]) * 8 : 1;
    case 'cylinder': {
      const r = Number(p.r) || 1, h = Number(p.h) || 1;
      return Math.ceil(Math.PI * r * r * Math.abs(h));
    }
    case 'sphere': {
      const r = Array.isArray(p.r) ? Math.max(...(p.r as number[]).map(Number)) : Number(p.r) || 1;
      return Math.ceil((4 / 3) * Math.PI * r * r * r);
    }
    case 'cone': {
      const r = Number(p.r) || 1, h = Number(p.h) || 1;
      return Math.ceil((Math.PI * r * r * Math.abs(h)) / 3);
    }
    case 'spiral': return (Number(p.r) || 1) * Math.abs(Number(p.h) || 1);
    case 'line': return 64;
    case 'set': return 1;
    case 'door': return 8;
    case 'arch': return (Number(p.span) || 3) * (Number(p.h) || 3) * (Number(p.depth) || 1);
    case 'group': return sumChildren(p.of);
    case 'repeat': return sumChildren(p.of) * Math.max(1, Math.min(Number(p.count) || 1, 512));
    case 'symmetry': return sumChildren(p.of) * ((p.axis === 'xz') ? 4 : 2);
    case 'prefab': return 20_000;
    default: return 1;
  }
}

function sumChildren(of: unknown): number {
  if (!Array.isArray(of)) return 0;
  let sum = 0;
  for (const c of of) sum += estimateVolume(c as Part);
  return sum;
}

export function estimateBlueprintVolume(bp: Blueprint): number {
  return sumChildren(bp.parts);
}

function validatePart(part: unknown, path: string, issues: ValidationIssue[], depth: number): void {
  if (depth > 24) {
    issues.push({ path, message: 'Nesting deeper than 24 levels.', severity: 'error' });
    return;
  }
  if (!part || typeof part !== 'object' || Array.isArray(part)) {
    issues.push({ path, message: 'Each part must be an object with an "op" field.', severity: 'error' });
    return;
  }
  const p = part as Record<string, unknown>;
  const op = p.op;
  if (typeof op !== 'string') {
    issues.push({ path, message: 'Missing "op". Expected one of: ' + OPS.join(', '), severity: 'error' });
    return;
  }
  if (!OP_SET.has(op)) {
    issues.push({ path, message: `Unknown op "${op}". Expected one of: ${OPS.join(', ')}`, severity: 'error' });
    return;
  }

  for (const field of REQUIRED[op] ?? []) {
    if (p[field] === undefined || p[field] === null) {
      issues.push({ path: `${path}.${field}`, message: `Op "${op}" requires "${field}".`, severity: 'error' });
    }
  }

  if (p.at !== undefined && !isVec3(p.at)) {
    issues.push({ path: `${path}.at`, message: '"at" must be [x, y, z] numbers.', severity: 'error' });
  }
  if (p.size !== undefined) {
    const wantsVec2 = op === 'foundation';
    const ok = wantsVec2 ? isVec2(p.size) : isVec3(p.size);
    if (!ok) {
      issues.push({
        path: `${path}.size`,
        message: wantsVec2 ? '"size" must be [width, depth].' : '"size" must be [width, height, depth].',
        severity: 'error',
      });
    } else if (!wantsVec2) {
      const s = p.size as Vec3;
      if (s.some((n) => n <= 0)) {
        issues.push({ path: `${path}.size`, message: 'Sizes must be at least 1 on every axis.', severity: 'error' });
      }
    }
  }
  for (const f of ['from', 'to'] as const) {
    if (p[f] !== undefined && !isVec3(p[f])) {
      issues.push({ path: `${path}.${f}`, message: `"${f}" must be [x, y, z] numbers.`, severity: 'error' });
    }
  }
  if (p.rotate !== undefined && ![0, 90, 180, 270].includes(Number(p.rotate))) {
    issues.push({ path: `${path}.rotate`, message: 'Rotation must be 0, 90, 180 or 270.', severity: 'error' });
  }
  if (op === 'repeat') {
    const n = Number(p.count);
    if (!Number.isFinite(n) || n < 1) {
      issues.push({ path: `${path}.count`, message: '"count" must be a positive number.', severity: 'error' });
    } else if (n > 512) {
      issues.push({ path: `${path}.count`, message: 'Counts above 512 are clamped.', severity: 'warning' });
    }
    if (!p.step && !p.rotateStep) {
      issues.push({ path, message: 'A "repeat" without "step" stacks every copy in the same place.', severity: 'warning' });
    }
  }
  if (op === 'symmetry' && !['x', 'z', 'xz'].includes(String(p.axis))) {
    issues.push({ path: `${path}.axis`, message: '"axis" must be "x", "z" or "xz".', severity: 'error' });
  }

  if (Array.isArray(p.of)) {
    p.of.forEach((c, i) => validatePart(c, `${path}.of[${i}]`, issues, depth + 1));
  } else if (['group', 'repeat', 'symmetry'].includes(op)) {
    issues.push({ path: `${path}.of`, message: `Op "${op}" needs an "of" array of child parts.`, severity: 'error' });
  }
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  errors: ValidationIssue[];
  estimatedVoxels: number;
}

export function validateBlueprint(bp: unknown, maxVoxels = 3_000_000): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!bp || typeof bp !== 'object' || Array.isArray(bp)) {
    issues.push({ path: '$', message: 'Blueprint must be a JSON object.', severity: 'error' });
    return { ok: false, issues, errors: issues, estimatedVoxels: 0 };
  }

  const b = bp as Record<string, unknown>;
  if (!Array.isArray(b.parts)) {
    issues.push({ path: '$.parts', message: 'Blueprint needs a "parts" array.', severity: 'error' });
  } else if (b.parts.length === 0) {
    issues.push({ path: '$.parts', message: '"parts" is empty — nothing would be built.', severity: 'error' });
  } else {
    b.parts.forEach((p, i) => validatePart(p, `$.parts[${i}]`, issues, 0));
  }

  if (b.anchor !== undefined && b.anchor !== 'player' && b.anchor !== 'bot' && !isVec3(b.anchor)) {
    issues.push({ path: '$.anchor', message: '"anchor" must be "player", "bot", or [x, y, z].', severity: 'error' });
  }

  const estimatedVoxels = Array.isArray(b.parts) ? sumChildren(b.parts) : 0;
  if (estimatedVoxels > maxVoxels) {
    issues.push({
      path: '$',
      message: `Estimated ${estimatedVoxels.toLocaleString()} blocks, over the ${maxVoxels.toLocaleString()} limit. Shrink the footprint or split the build.`,
      severity: 'error',
    });
  }

  const errors = issues.filter((i) => i.severity === 'error');
  return { ok: errors.length === 0, issues, errors, estimatedVoxels };
}

/** One-line-per-issue summary, small enough to hand straight back to a model. */
export function formatIssues(issues: ValidationIssue[], limit = 12): string {
  return issues.slice(0, limit).map((i) => `${i.severity === 'error' ? 'ERROR' : 'warn'} ${i.path}: ${i.message}`).join('\n');
}
