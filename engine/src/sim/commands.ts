// Minimal command interpreter for the simulation (useful subset of vanilla commands).
import type { SimBackend } from './sim-backend.ts';
import type { EntityInfo } from '../core/types.ts';
import { blockId } from '../core/blockstate.ts';

const SUPPORTED = 'time, weather, summon, kill, fillbiome, setblock, fill, particle, playsound, stopsound, say, tellraw, title, gamerule, difficulty';

type R = { ok: boolean; output: string };

/** split respecting [], {}, quotes */
function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = '', depth = 0, q = '';
  for (const ch of s) {
    if (q) {
      cur += ch;
      if (ch === q) q = '';
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (/\s/.test(ch) && depth <= 0) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function coord(t: string | undefined, base: number, int: boolean): number {
  if (t === undefined) throw new Error('missing coordinate');
  let v: number;
  if (t.startsWith('~') || t.startsWith('^')) v = base + (t.length > 1 ? Number(t.slice(1)) : 0);
  else v = Number(t);
  if (!Number.isFinite(v)) throw new Error(`invalid coordinate "${t}"`);
  return int ? Math.floor(v) : v;
}

const TIME_NAMES: Record<string, number> = { day: 1000, noon: 6000, sunset: 12000, night: 13000, midnight: 18000, sunrise: 23000 };

function timeValue(t: string): number {
  if (t in TIME_NAMES) return TIME_NAMES[t];
  const m = /^(\d+(?:\.\d+)?)([dst]?)$/.exec(t);
  if (!m) throw new Error(`invalid time "${t}"`);
  const n = Number(m[1]);
  return Math.round(m[2] === 'd' ? n * 24000 : m[2] === 's' ? n * 20 : n);
}

function nsId(id: string): string {
  return id.includes(':') ? id : `minecraft:${id}`;
}

export function runSimCommand(sim: SimBackend, raw: string, as?: string): R {
  const cmd = raw.trim().replace(/^\//, '');
  const tk = tokenize(cmd);
  const head = (tk[0] ?? '').toLowerCase();
  const base = sim.playerPos(as) ?? [0, 64, 0];
  try {
    switch (head) {
      case 'time': {
        const st = sim.state;
        if (tk[1] === 'set') { st.time = timeValue(tk[2] ?? ''); return { ok: true, output: `Set the time to ${st.time}` }; }
        if (tk[1] === 'add') { st.time += timeValue(tk[2] ?? ''); return { ok: true, output: `Set the time to ${st.time}` }; }
        if (tk[1] === 'query') {
          const v = tk[2] === 'gametime' ? st.time : tk[2] === 'day' ? Math.floor(st.time / 24000) : st.time % 24000;
          return { ok: true, output: `The time is ${v}` };
        }
        return { ok: false, output: 'Usage: time set|add|query <value>' };
      }
      case 'weather': {
        const w = tk[1];
        if (w !== 'clear' && w !== 'rain' && w !== 'thunder') return { ok: false, output: 'Usage: weather clear|rain|thunder [duration]' };
        sim.state.weather = w;
        return { ok: true, output: `Changing to ${w === 'clear' ? 'clear' : w === 'rain' ? 'rain' : 'rain & thunder'}` };
      }
      case 'summon': {
        if (!tk[1]) return { ok: false, output: 'Usage: summon <entity> [x y z] [nbt]' };
        const id = nsId(tk[1].toLowerCase());
        const pos: [number, number, number] = tk.length >= 5
          ? [coord(tk[2], base[0], false), coord(tk[3], base[1], false), coord(tk[4], base[2], false)]
          : [base[0], base[1], base[2]];
        const nbt = tk.slice(5).join(' ');
        const e: EntityInfo = { id, uuid: sim.newUuid(), pos };
        const nm = /CustomName\s*:\s*(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/.exec(nbt);
        if (nm) {
          let name = nm[1] ?? nm[2] ?? '';
          try {
            const j = JSON.parse(name);
            name = typeof j === 'string' ? j : (j?.text ?? name);
          } catch {
            name = name.replace(/^"|"$/g, '');
          }
          e.name = name;
        }
        sim.state.entities.push(e);
        return { ok: true, output: `Summoned new ${id.replace('minecraft:', '')}` };
      }
      case 'kill': {
        const sel = tk[1] ?? '';
        const before = sim.state.entities.length;
        let m: RegExpExecArray | null;
        if ((m = /^@e(?:\[(.*)\])?$/.exec(sel))) {
          const type = /type=([!a-z0-9_:]+)/.exec(m[1] ?? '')?.[1];
          sim.state.entities = sim.state.entities.filter((e) => (type ? (type.startsWith('!') ? e.id === nsId(type.slice(1)) : e.id !== nsId(type)) : false));
        } else sim.state.entities = sim.state.entities.filter((e) => e.uuid !== sel && e.name !== sel);
        const n = before - sim.state.entities.length;
        return n ? { ok: true, output: `Killed ${n} entities` } : { ok: false, output: 'No entity was found' };
      }
      case 'fillbiome': {
        if (tk.length < 8) return { ok: false, output: 'Usage: fillbiome <from> <to> <biome>' };
        const a = [coord(tk[1], base[0], true), coord(tk[2], base[1], true), coord(tk[3], base[2], true)];
        const b = [coord(tk[4], base[0], true), coord(tk[5], base[1], true), coord(tk[6], base[2], true)];
        const biome = nsId(tk[7].toLowerCase());
        const box = { min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])] as [number, number, number], max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])] as [number, number, number] };
        sim.state.biomeOverrides.push({ box, biome });
        const n = (box.max[0] - box.min[0] + 1) * (box.max[1] - box.min[1] + 1) * (box.max[2] - box.min[2] + 1);
        return { ok: true, output: `${n} biome entries set between ${box.min.join(', ')} and ${box.max.join(', ')}` };
      }
      case 'setblock': {
        if (tk.length < 5) return { ok: false, output: 'Usage: setblock <x> <y> <z> <block> [destroy|keep|replace]' };
        const x = coord(tk[1], base[0], true), y = coord(tk[2], base[1], true), z = coord(tk[3], base[2], true);
        const v = sim.reg.tryCanonical(tk[4]);
        if (!v.ok) return { ok: false, output: v.error };
        if (tk[5] === 'keep' && sim.world.get(x, y, z) !== 'minecraft:air') return { ok: false, output: 'Could not set the block' };
        const r = sim.setBlocksSync({ palette: [v.state], positions: new Int32Array([x, y, z]), states: new Uint16Array([0]) });
        if (r.failed.length) return { ok: false, output: r.failed[0].reason };
        return r.placed ? { ok: true, output: `Changed the block at ${x}, ${y}, ${z}` } : { ok: false, output: 'Could not set the block' };
      }
      case 'fill': {
        if (tk.length < 8) return { ok: false, output: 'Usage: fill <from> <to> <block> [destroy|hollow|keep|outline|replace [filter]]' };
        const a = [coord(tk[1], base[0], true), coord(tk[2], base[1], true), coord(tk[3], base[2], true)];
        const b = [coord(tk[4], base[0], true), coord(tk[5], base[1], true), coord(tk[6], base[2], true)];
        const v = sim.reg.tryCanonical(tk[7]);
        if (!v.ok) return { ok: false, output: v.error };
        const mode = tk[8] ?? 'replace';
        const filter = mode === 'replace' && tk[9] ? sim.reg.tryCanonical(tk[9]) : null;
        if (filter && !filter.ok) return { ok: false, output: filter.error };
        const [x0, y0, z0] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
        const [x1, y1, z1] = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
        const n = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
        if (n > 32768) return { ok: false, output: `Too many blocks in the specified area (maximum 32768, specified ${n})` };
        const pos: number[] = [], st: number[] = [];
        const pal = [v.state, 'minecraft:air'];
        for (let y = y0; y <= y1; y++)
          for (let z = z0; z <= z1; z++)
            for (let x = x0; x <= x1; x++) {
              const edge = x === x0 || x === x1 || y === y0 || y === y1 || z === z0 || z === z1;
              const cur = sim.world.get(x, y, z);
              let s = 0;
              if (mode === 'keep' && cur !== 'minecraft:air') continue;
              if (mode === 'outline' && !edge) continue;
              if (mode === 'hollow' && !edge) s = 1;
              if (filter && filter.ok && (tk[9].includes('[') ? cur !== filter.state : blockId(cur) !== blockId(filter.state))) continue;
              pos.push(x, y, z);
              st.push(s);
            }
        const r = sim.setBlocksSync({ palette: pal, positions: new Int32Array(pos), states: new Uint16Array(st) });
        if (r.failed.length && !r.placed) return { ok: false, output: r.failed[0].reason };
        return r.placed ? { ok: true, output: `Successfully filled ${r.placed} block(s)` } : { ok: false, output: 'No blocks were filled' };
      }
      case 'particle': case 'playsound': case 'stopsound':
        return { ok: true, output: `${head}: ok (simulated, no effect)` };
      case 'say': case 'tellraw': case 'title': {
        const text = head === 'say' ? tk.slice(1).join(' ') : tk.slice(head === 'title' ? 3 : 2).join(' ');
        void sim.notify({ target: head === 'say' ? '@a' : (tk[1] ?? '@a'), kind: head === 'title' ? 'title' : 'chat', text });
        return { ok: true, output: text };
      }
      case 'gamerule': case 'difficulty': {
        if (head === 'gamerule' && tk[1]) {
          if (tk[2] !== undefined) sim.state.gamerules[tk[1]] = tk[2];
          return { ok: true, output: `Gamerule ${tk[1]} is ${sim.state.gamerules[tk[1]] ?? 'default'}` };
        }
        if (head === 'difficulty') {
          if (tk[1]) sim.state.gamerules.difficulty = tk[1];
          return { ok: true, output: `The difficulty is ${sim.state.gamerules.difficulty ?? 'normal'}` };
        }
        return { ok: false, output: 'Usage: gamerule <rule> [value]' };
      }
      default:
        return { ok: false, output: `Unsupported command in the simulation: "${head || cmd}". Supported: ${SUPPORTED}` };
    }
  } catch (e) {
    return { ok: false, output: (e as Error).message };
  }
}
