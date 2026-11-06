// Command allowlist for the agent's `command` tool (ARCHITECTURE §9).
// Returns an error message (string) if the command is not allowed, otherwise null.

import type { Box, Vec3 } from '../core/types.ts';
import type { Frame } from '../core/frame.ts';

const DECORATIVE_ENTITIES = new Set([
  'armor_stand', 'item_frame', 'glow_item_frame', 'painting', 'block_display', 'item_display', 'text_display', 'interaction',
  'villager', 'wandering_trader', 'cat', 'wolf', 'horse', 'donkey', 'mule', 'llama', 'camel', 'sheep', 'cow', 'mooshroom',
  'pig', 'chicken', 'rabbit', 'fox', 'parrot', 'bee', 'goat', 'frog', 'axolotl', 'turtle', 'panda', 'polar_bear', 'ocelot',
  'iron_golem', 'snow_golem', 'allay', 'tropical_fish', 'cod', 'salmon', 'dolphin', 'squid', 'glow_squid', 'sniffer',
  'armadillo', 'happy_ghast', 'copper_golem', 'leash_knot', 'minecart', 'oak_boat', 'spruce_boat', 'birch_boat', 'cherry_boat',
  'bamboo_raft', 'pale_oak_boat', 'mangrove_boat', 'acacia_boat', 'jungle_boat', 'dark_oak_boat', 'end_crystal',
]);

const FORBIDDEN_WORDS = /\b(op|deop|stop|ban|ban-ip|pardon|kick|whitelist|execute|give|kill|tp|teleport|gamemode|gamerule|difficulty|function|reload|save-all|save-off|data\s+modify\s+storage|scoreboard|forceload|setworldspawn|spawnpoint|clear|enchant|effect|xp|experience|summon\s+\S*(tnt|wither|ender_dragon|lightning|warden|creeper|fireball))\b/i;

function inBox(b: Box, x: number, y: number, z: number): boolean {
  return x >= b.min[0] && x <= b.max[0] + 1 && y >= b.min[1] && y <= b.max[1] + 1 && z >= b.min[2] && z <= b.max[2] + 1;
}

function coords(tokens: string[], at: number, n: number): number[] | string {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = tokens[at + i];
    if (t === undefined) return `missing coordinate #${i + 1}`;
    if (/^[~^]/.test(t)) return 'relative coordinates (~ ^) are not allowed — use absolute world coordinates';
    const v = Number(t);
    if (!Number.isFinite(v)) return `bad coordinate '${t}'`;
    out.push(v);
  }
  return out;
}

export function checkCommand(cmd: string, opts: { allowedBox: Box; extra?: string[] }): string | null {
  const c = cmd.trim().replace(/^\//, '');
  if (!c) return 'empty command';
  if (/[\n\r]/.test(c)) return 'one command per call (no newlines)';
  const tokens = c.split(/\s+/);
  const verb = tokens[0]!.toLowerCase();
  const extra = (opts.extra ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (extra.some((e) => c.toLowerCase().startsWith(e)) && !/\bexecute\b|\bop\b/.test(c.toLowerCase())) return null;
  if (/@[aer]\b|@a\[|@e\[|@r\[/.test(c)) return 'selectors other than @s/@p are not allowed';
  const b = opts.allowedBox;
  switch (verb) {
    case 'summon': {
      const ent = (tokens[1] ?? '').replace(/^minecraft:/, '').toLowerCase();
      if (!DECORATIVE_ENTITIES.has(ent)) return `summon '${ent}' is not allowed. Allowed: ${[...DECORATIVE_ENTITIES].slice(0, 30).join(', ')}, …`;
      const p = coords(tokens, 2, 3);
      if (typeof p === 'string') return `summon needs absolute x y z: ${p}`;
      if (!inBox(b, p[0]!, p[1]!, p[2]!)) return `position ${p.join(' ')} is outside the allowed build box ${b.min.join(',')}..${b.max.join(',')}`;
      if (FORBIDDEN_WORDS.test(tokens.slice(5).join(' ').replace(/\{.*\}/s, ''))) return 'forbidden content in summon arguments';
      if (/Passengers|command_block|CustomNameVisible:1b.*run|"run_command"/i.test(c) && /command/i.test(c)) return 'entity data with commands is not allowed';
      return null;
    }
    case 'fillbiome': {
      const p = coords(tokens, 1, 6);
      if (typeof p === 'string') return `fillbiome needs absolute x1 y1 z1 x2 y2 z2: ${p}`;
      if (!inBox(b, p[0]!, p[1]!, p[2]!) || !inBox(b, p[3]!, p[4]!, p[5]!)) return 'fillbiome region must be inside the allowed build box';
      if (!tokens[7]) return 'fillbiome needs a biome id';
      return null;
    }
    case 'particle':
    case 'playsound':
      if (FORBIDDEN_WORDS.test(c.slice(verb.length))) return 'forbidden content';
      return null;
    case 'time':
    case 'weather':
      return `${verb} is disabled (the server owner can enable it with commandAllowlist: ["${verb}"] in ~/.mcai/config.json)`;
    default:
      return `command '${verb}' is not allowed. Allowed: summon (decorative entities), fillbiome, particle, playsound${extra.length ? `, ${extra.join(', ')}` : ''}. Use build/run_script for blocks.`;
  }
}

const FACING_ROT: Record<number, number> = { 2: 5, 5: 3, 3: 4, 4: 2 }; // north→east→south→west (NBT Facing ids)

function rotPoint(f: Frame, x: number, y: number, z: number): [number, number, number] {
  // rotate a (possibly fractional) local point: block part through the frame, fraction around the block center
  const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
  let fx = x - bx - 0.5, fz = z - bz - 0.5;
  for (let t = 0; t < f.turns; t++) [fx, fz] = [-fz, fx];
  const w: Vec3 = f.toWorld([bx, by, bz]);
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return [r(w[0] + fx + 0.5), r(w[1] + (y - by)), r(w[2] + fz + 0.5)];
}

/** Rotate local coordinates (and Rotation/Facing NBT) of summon/fillbiome/particle/playsound into world space. */
export function localizeCommand(cmd: string, f: Frame): string {
  const tokens = cmd.trim().split(/\s+/);
  const verb = (tokens[0] ?? '').toLowerCase();
  const at: Record<string, number[]> = { summon: [2], fillbiome: [1, 4], particle: [2], playsound: [4] };
  const starts = at[verb];
  if (!starts) return cmd;
  for (const s of starts) {
    const nums = [tokens[s], tokens[s + 1], tokens[s + 2]].map((t) => (t !== undefined && /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN));
    if (nums.some((n) => Number.isNaN(n))) continue;
    let w: number[];
    if (verb === 'fillbiome') w = f.toWorld([nums[0]!, nums[1]!, nums[2]!]);
    else w = rotPoint(f, nums[0]!, nums[1]!, nums[2]!);
    tokens[s] = String(w[0]);
    tokens[s + 1] = String(w[1]);
    tokens[s + 2] = String(w[2]);
  }
  let out = tokens.join(' ');
  if (verb === 'summon' && f.turns) {
    out = out.replace(/Rotation:\[\s*(-?\d+(?:\.\d+)?)f?/g, (_m, yaw) => `Rotation:[${(((Number(yaw) + 90 * f.turns) % 360) + 360) % 360}f`);
    out = out.replace(/\b(Facing|facing):(\d)b/g, (m, k, v) => {
      let n = Number(v);
      if (!FACING_ROT[n]) return m;
      for (let t = 0; t < f.turns; t++) n = FACING_ROT[n]!;
      return `${k}:${n}b`;
    });
  }
  return out;
}
