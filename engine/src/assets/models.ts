// Blockstate → model selection and model baking (parents, texture variables, element +
// model rotations) into GeoCuboids.
import type { AssetSource } from './sources.ts';
import { normModelName } from './sources.ts';
import {
  DIRS, IDENTITY_M, defaultUv, dirFromVec, matMul, matVec, rotMat, DIR_VEC, DIR_INDEX,
  type Dir, type GeoCuboid, type GeoFace,
} from './geometry.ts';

export interface AppliedModel {
  model: string;
  x: number;
  y: number;
  uvlock: boolean;
}

function pick(v: any): AppliedModel {
  const a = Array.isArray(v) ? v[0] : v; // weighted lists: deterministic first entry
  return { model: normModelName(a.model), x: a.x ?? 0, y: a.y ?? 0, uvlock: !!a.uvlock };
}

function matchVariantKey(key: string, props: Record<string, string>): boolean {
  if (!key) return true;
  for (const part of key.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (props[part.slice(0, eq)] !== part.slice(eq + 1)) return false;
  }
  return true;
}

export function matchWhen(when: any, props: Record<string, string>): boolean {
  if (!when) return true;
  if (Array.isArray(when.OR)) return when.OR.some((c: any) => matchWhen(c, props));
  if (Array.isArray(when.AND)) return when.AND.every((c: any) => matchWhen(c, props));
  for (const [k, v] of Object.entries(when)) {
    const cur = props[k];
    let want = String(v);
    let neg = false;
    if (want.startsWith('!')) {
      neg = true;
      want = want.slice(1);
    }
    const hit = want.split('|').includes(cur);
    if (hit === neg) return false;
  }
  return true;
}

export function selectModels(def: any, props: Record<string, string>): AppliedModel[] {
  if (!def) return [];
  if (def.variants) {
    for (const [k, v] of Object.entries(def.variants)) if (matchVariantKey(k, props)) return [pick(v)];
    return [];
  }
  if (def.multipart) {
    const out: AppliedModel[] = [];
    for (const part of def.multipart) if (matchWhen(part.when, props)) out.push(pick(part.apply));
    return out;
  }
  return [];
}

interface ResolvedModel {
  elements: any[] | null;
  textures: Record<string, string>;
  ao: boolean;
}

export class ModelBaker {
  private resolved = new Map<string, ResolvedModel | null>();
  private src: AssetSource;
  constructor(src: AssetSource) {
    this.src = src;
  }

  resolve(name: string, depth = 0): ResolvedModel | null {
    const n = normModelName(name);
    const hit = this.resolved.get(n);
    if (hit !== undefined) return hit;
    const m = this.src.model(n);
    let out: ResolvedModel | null = null;
    if (m && depth < 32) {
      const parent = m.parent ? this.resolve(m.parent, depth + 1) : null;
      const textures: Record<string, string> = { ...(parent?.textures ?? {}) };
      for (const [k, v] of Object.entries(m.textures ?? {})) textures[k] = String(v);
      out = {
        elements: m.elements ?? parent?.elements ?? null,
        textures,
        ao: m.ambientocclusion ?? parent?.ao ?? true,
      };
    }
    this.resolved.set(n, out);
    return out;
  }

  static resolveTexture(textures: Record<string, string>, ref: string): string {
    let r = ref;
    for (let i = 0; i < 16 && r.startsWith('#'); i++) {
      const next = textures[r.slice(1)];
      if (next === undefined) return '';
      r = next;
    }
    if (r.startsWith('#')) return '';
    r = normModelName(r);
    if (!r.includes('/')) r = 'block/' + r;
    return r;
  }

  /** bake an applied model into cuboids; returns null if the model has no elements */
  bake(a: AppliedModel): { cuboids: GeoCuboid[]; ao: boolean; particle: string } | null {
    const rm = this.resolve(a.model);
    if (!rm) return null;
    return this.bakeResolved(rm, a);
  }

  /** bake an in-memory model JSON (textures already resolved names) */
  bakeJson(json: any, a: AppliedModel): { cuboids: GeoCuboid[]; ao: boolean; particle: string } {
    return this.bakeResolved({ elements: json.elements ?? [], textures: json.textures ?? {}, ao: json.ambientocclusion ?? true }, a);
  }

  private bakeResolved(rm: ResolvedModel, a: AppliedModel): { cuboids: GeoCuboid[]; ao: boolean; particle: string } {
    const particle = rm.textures.particle ? ModelBaker.resolveTexture(rm.textures, rm.textures.particle) : '';
    if (!rm.elements) return { cuboids: [], ao: rm.ao, particle };
    // model rotation: x first, then y; both clockwise-positive in vanilla → negative right-handed
    const Mm = matMul(rotMat('y', -a.y), rotMat('x', -a.x));
    const modelRot = a.x !== 0 || a.y !== 0;
    const cuboids: GeoCuboid[] = [];
    for (const el of rm.elements) {
      const from = el.from as [number, number, number];
      const to = el.to as [number, number, number];
      let M = IDENTITY_M.slice();
      let t = [0, 0, 0];
      const r = el.rotation;
      if (r) {
        const o = r.origin ?? [8, 8, 8];
        let R: number[];
        let scale = [1, 1, 1];
        if (r.axis) {
          R = rotMat(r.axis, r.angle ?? 0);
          if (r.rescale && r.angle) {
            const k = 1 / Math.cos((Math.abs(r.angle) * Math.PI) / 180);
            scale = [r.axis === 'x' ? 1 : k, r.axis === 'y' ? 1 : k, r.axis === 'z' ? 1 : k];
          }
        } else {
          R = matMul(matMul(rotMat('x', r.x ?? 0), rotMat('y', r.y ?? 0)), rotMat('z', r.z ?? 0));
        }
        const S = [scale[0], 0, 0, 0, scale[1], 0, 0, 0, scale[2]];
        M = matMul(S, R);
        const Mo = matVec(M, o);
        t = [o[0] - Mo[0], o[1] - Mo[1], o[2] - Mo[2]];
      }
      if (modelRot) {
        const c = [8, 8, 8];
        M = matMul(Mm, M);
        const tc = matVec(Mm, [t[0] - c[0], t[1] - c[1], t[2] - c[2]]);
        t = [tc[0] + c[0], tc[1] + c[1], tc[2] + c[2]];
      }
      let identity = true;
      for (let i = 0; i < 9; i++) if (Math.abs(M[i] - IDENTITY_M[i]) > 1e-9) identity = false;
      if (Math.abs(t[0]) + Math.abs(t[1]) + Math.abs(t[2]) > 1e-9) identity = false;
      for (let i = 0; i < 9; i++) if (Math.abs(M[i]) < 1e-12) M[i] = 0;
      const faces: Partial<Record<Dir, GeoFace>> = {};
      for (const d of DIRS) {
        const f = el.faces?.[d];
        if (!f) continue;
        const texture = ModelBaker.resolveTexture(rm.textures, f.texture ?? '');
        let cull: Dir | null = null;
        if (f.cullface) {
          const cd = (f.cullface === 'bottom' ? 'down' : f.cullface) as Dir;
          const v = DIR_VEC[DIR_INDEX[cd]];
          cull = modelRot ? dirFromVec(...matVec(Mm, v)) : cd;
        }
        faces[d] = {
          texture,
          uv: f.uv ? [f.uv[0], f.uv[1], f.uv[2], f.uv[3]] : defaultUv(d, from, to),
          rotation: (((f.rotation ?? 0) % 360) + 360) % 360 as GeoFace['rotation'],
          tint: f.tintindex ?? -1,
          cullface: cull,
          uvlock: a.uvlock && modelRot,
        };
      }
      cuboids.push({ from: [...from], to: [...to], m: M, t, identity, faces, shade: el.shade !== false });
    }
    return { cuboids, ao: rm.ao, particle };
  }
}
