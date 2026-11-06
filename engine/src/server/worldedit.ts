// Non-AI WorldEdit-style operations requested by players through the mod (`tool_request`).
// World space, per-player clipboards, one undo record per operation (same History as AI jobs).

import type { Box, Vec3, WorldBackend } from '../core/types.ts';
import type { Registry } from '../core/registry.ts';
import { EditSession, type History } from '../core/session.ts';
import { copyFromSink, pasteBox, pasteInto, stackRegion, moveRegion, transformClipboard, clipboardBlockCount, type Clipboard } from '../core/clipboard.ts';
import type { QuarterTurns } from '../core/transform.ts';
import { compilePattern } from '../core/pattern.ts';
import { compileMask } from '../core/mask.ts';
import { boxUnion, boxVolume } from '../core/volume.ts';
import type { StructureLibrary } from '../core/schematic.ts';
import type { EditBatch } from '../core/types.ts';
import { isBox, isVec3, normalizeBox } from './protocol.ts';

export interface WorldEditDeps {
  backend(): WorldBackend;
  registry(): Registry;
  history: History;
  structures: StructureLibrary;
  maxBlocks: number;
  onWorldChange?(batch: EditBatch, dimension: string): void;
}

export class WorldEditError extends Error {}

const DIRS: Record<string, Vec3> = { north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0], up: [0, 1, 0], down: [0, -1, 0] };

export class WorldEdit {
  private deps: WorldEditDeps;
  private clips = new Map<string, Clipboard>();

  constructor(deps: WorldEditDeps) {
    this.deps = deps;
  }

  private sel(args: Record<string, unknown>): Box {
    const s = args.selection ?? args.box;
    if (!isBox(s)) throw new WorldEditError('no selection — mark two corners with the wand first');
    const b = normalizeBox(s);
    if (boxVolume(b) > this.deps.maxBlocks) throw new WorldEditError(`selection has ${boxVolume(b)} blocks (limit ${this.deps.maxBlocks})`);
    return b;
  }

  private pos(args: Record<string, unknown>, key = 'at'): Vec3 {
    const p = args[key] ?? args.pos;
    if (!isVec3(p)) throw new WorldEditError(`missing position '${key}'`);
    return [Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[2])];
  }

  private session(player: string, label: string, dimension: string): EditSession {
    return new EditSession(this.deps.backend(), this.deps.registry(), { maxBlocks: this.deps.maxBlocks, dimension, actor: player, label, support: 'off' }); // player tools: exact, no physics
  }

  private async commit(s: EditSession, label: string): Promise<string> {
    const r = await s.flush({ animate: 'none', dimension: s.dimension });
    if (r.record && r.record.after.states.length) {
      this.deps.history.push(r.record);
      this.deps.onWorldChange?.(r.record.after, s.dimension);
    }
    return `${label}: ${r.changed} blocks changed${r.failed.length ? `, ${r.failed.length} failed` : ''}`;
  }

  async handle(player: string, tool: string, args: Record<string, unknown> = {}): Promise<{ message: string; [k: string]: unknown }> {
    const reg = this.deps.registry();
    const dim = typeof args.dimension === 'string' ? args.dimension : 'minecraft:overworld';
    switch (tool) {
      case 'copy':
      case 'cut': {
        const box = this.sel(args);
        const origin = isVec3(args.origin) ? (args.origin as Vec3) : isVec3(args.pos) ? this.pos(args, 'pos') : box.min;
        const s = this.session(player, tool, dim);
        await s.prefetch(box);
        const c = copyFromSink(s, box, origin);
        this.clips.set(player, c);
        if (tool === 'copy') return { message: `copied ${clipboardBlockCount(c)} blocks` };
        for (let y = box.min[1]; y <= box.max[1]; y++) for (let z = box.min[2]; z <= box.max[2]; z++) for (let x = box.min[0]; x <= box.max[0]; x++) s.set(x, y, z, 'minecraft:air');
        return { message: await this.commit(s, 'cut') };
      }
      case 'paste': {
        const c = this.clip(player);
        const at = this.pos(args);
        const s = this.session(player, 'paste', dim);
        await s.prefetch(pasteBox(c, at));
        pasteInto(s, c, at, { ignoreAir: args.ignoreAir === true });
        return { message: await this.commit(s, 'paste') };
      }
      case 'rotate': {
        const deg = Number(args.degrees ?? (Number(args.turns ?? 1) * 90));
        if (![90, 180, 270, -90].includes(deg)) throw new WorldEditError('rotate by 90, 180 or 270 degrees');
        const t = (((deg / 90) % 4) + 4) % 4 as QuarterTurns;
        this.clips.set(player, transformClipboard(this.clip(player), { rotate: t }, reg));
        return { message: `clipboard rotated ${deg}°` };
      }
      case 'flip': {
        const axis = args.axis === 'z' || args.axis === 'north' || args.axis === 'south' ? 'z' : 'x';
        this.clips.set(player, transformClipboard(this.clip(player), { mirror: axis }, reg));
        return { message: `clipboard flipped along ${axis}` };
      }
      case 'undo':
      case 'redo': {
        const be = this.deps.backend();
        const rec = tool === 'undo' ? await this.deps.history.undo(player, be) : await this.deps.history.redo(player, be);
        if (!rec) return { message: `nothing to ${tool}` };
        this.deps.onWorldChange?.(tool === 'undo' ? rec.before : rec.after, rec.dimension);
        return { message: `${tool === 'undo' ? 'undid' : 'redid'} "${rec.label}" (${rec.after.states.length} blocks)` };
      }
      case 'set':
      case 'replace': {
        const box = this.sel(args);
        const pat = compilePattern(String(args.block ?? args.pattern ?? ''), reg, { bounds: box });
        const mask = tool === 'replace' ? compileMask((args.mask ?? args.from ?? '!air') as string, reg) : null;
        const s = this.session(player, tool, dim);
        await s.prefetch(box);
        for (let y = box.min[1]; y <= box.max[1]; y++)
          for (let z = box.min[2]; z <= box.max[2]; z++)
            for (let x = box.min[0]; x <= box.max[0]; x++) {
              if (mask && !mask(x, y, z, s.get(x, y, z))) continue;
              const st = pat(x, y, z);
              if (st !== null) s.set(x, y, z, st);
            }
        return { message: await this.commit(s, tool) };
      }
      case 'clear': {
        const box = this.sel(args);
        const s = this.session(player, 'clear', dim);
        await s.prefetch(box);
        for (let y = box.min[1]; y <= box.max[1]; y++) for (let z = box.min[2]; z <= box.max[2]; z++) for (let x = box.min[0]; x <= box.max[0]; x++) s.set(x, y, z, 'minecraft:air');
        return { message: await this.commit(s, 'clear') };
      }
      case 'stack': {
        const box = this.sel(args);
        const count = Math.max(1, Math.min(64, Number(args.count ?? 1)));
        const dir = DIRS[String(args.direction ?? 'up')];
        if (!dir) throw new WorldEditError('direction must be north/south/east/west/up/down');
        const size = [box.max[0] - box.min[0] + 1, box.max[1] - box.min[1] + 1, box.max[2] - box.min[2] + 1];
        const far: Box = { min: box.min.map((v, i) => v + dir[i]! * size[i]! * count) as Vec3, max: box.max.map((v, i) => v + dir[i]! * size[i]! * count) as Vec3 };
        const s = this.session(player, 'stack', dim);
        await s.prefetch(boxUnion(box, far));
        stackRegion(s, box, count, dir);
        return { message: await this.commit(s, 'stack') };
      }
      case 'move': {
        const box = this.sel(args);
        const off = args.offset;
        if (!isVec3(off)) throw new WorldEditError('missing offset [dx,dy,dz]');
        const dest: Box = { min: box.min.map((v, i) => v + off[i]!) as Vec3, max: box.max.map((v, i) => v + off[i]!) as Vec3 };
        const s = this.session(player, 'move', dim);
        await s.prefetch(boxUnion(box, dest));
        moveRegion(s, box, off as Vec3);
        return { message: await this.commit(s, 'move') };
      }
      case 'save': {
        const name = String(args.name ?? '');
        const m = await this.deps.structures.save(name, this.clip(player), { author: player, description: String(args.description ?? '') });
        return { message: `saved '${m.name}' (${m.size.join('x')})` };
      }
      case 'load': {
        const c = await this.deps.structures.load(String(args.name ?? ''));
        this.clips.set(player, c);
        return { message: `loaded '${args.name}' into your clipboard — paste it` };
      }
      case 'list': {
        const l = await this.deps.structures.list({ query: typeof args.query === 'string' ? args.query : undefined });
        return { message: l.length ? l.slice(0, 30).map((m) => `${m.name} (${m.size.join('x')})`).join(', ') : 'no saved structures', structures: l.slice(0, 200) };
      }
      default:
        throw new WorldEditError(`unknown tool '${tool}' (copy, cut, paste, rotate, flip, undo, redo, set, replace, clear, stack, move, save, load, list)`);
    }
  }

  private clip(player: string): Clipboard {
    const c = this.clips.get(player);
    if (!c) throw new WorldEditError('your clipboard is empty — copy something first');
    return c;
  }
}
