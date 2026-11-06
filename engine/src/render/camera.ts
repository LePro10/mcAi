// Camera presets, auto-framing and lighting presets.
import type { Box } from '../core/types.ts';

export type ViewName = 'iso_ne' | 'iso_nw' | 'iso_se' | 'iso_sw' | 'front' | 'back' | 'left' | 'right' | 'top' | 'orbit';

export interface Camera {
  ortho: boolean;
  c: number[];
  f: number[];
  r: number[];
  u: number[];
  scale: number;
  W: number;
  H: number;
}

/** camera position direction (x,z) relative to the target for each preset */
export const VIEW_DIR: Record<string, [number, number]> = {
  iso_se: [1, 1], iso_sw: [-1, 1], iso_ne: [1, -1], iso_nw: [-1, -1],
  front: [0, 1], back: [0, -1], left: [-1, 0], right: [1, 0],
};

const norm = (v: number[]) => {
  const L = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / L, v[1] / L, v[2] / L];
};
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const DEG = Math.PI / 180;

export interface CameraOptions {
  view?: ViewName;
  yaw?: number;
  pitch?: number;
  zoom?: number;
  fov?: number;
}

/** world-space inclusive box → its 8 corners (block edges) */
function corners(b: Box): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < 8; i++)
    out.push([i & 1 ? b.max[0] + 1 : b.min[0], i & 2 ? b.max[1] + 1 : b.min[1], i & 4 ? b.max[2] + 1 : b.min[2]]);
  return out;
}

export function makeCamera(o: CameraOptions, frame: Box, W: number, H: number): Camera {
  const view = o.view ?? 'iso_se';
  const zoom = o.zoom ?? 1;
  const center = [(frame.min[0] + frame.max[0] + 1) / 2, (frame.min[1] + frame.max[1] + 1) / 2, (frame.min[2] + frame.max[2] + 1) / 2];
  let f: number[], up = [0, 1, 0];
  let ortho = true;
  if (view === 'top') {
    f = [0, -1, 0];
    const yaw = (o.yaw ?? 0) * DEG; // image-up = north rotated clockwise by yaw
    up = [Math.sin(yaw), 0, -Math.cos(yaw)];
  } else if (view === 'orbit') {
    ortho = false;
    const yaw = (o.yaw ?? 135) * DEG; // Minecraft yaw of the look direction (0 = south, 90 = west)
    const pitch = (o.pitch ?? 28) * DEG; // positive = looking down
    f = [-Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
  } else {
    const d = VIEW_DIR[view] ?? VIEW_DIR.iso_se;
    const el = (o.pitch ?? (view.startsWith('iso') ? 30 : 0)) * DEG;
    const h = Math.hypot(d[0], d[1]);
    f = [(-d[0] / h) * Math.cos(el), -Math.sin(el), (-d[1] / h) * Math.cos(el)];
  }
  f = norm(f);
  let r = cross(f, up);
  if (Math.hypot(r[0], r[1], r[2]) < 1e-6) r = [1, 0, 0];
  r = norm(r);
  const u = norm(cross(r, f));
  const cs = corners(frame);
  if (ortho) {
    let r0 = Infinity, r1 = -Infinity, u0 = Infinity, u1 = -Infinity;
    for (const p of cs) {
      const q = [p[0] - center[0], p[1] - center[1], p[2] - center[2]];
      const a = dot(q, r), b = dot(q, u);
      r0 = Math.min(r0, a); r1 = Math.max(r1, a); u0 = Math.min(u0, b); u1 = Math.max(u1, b);
    }
    const margin = 1.1;
    const scale = (Math.max((r1 - r0) / W, (u1 - u0) / H) * margin) / zoom;
    const mr = (r0 + r1) / 2, mu = (u0 + u1) / 2;
    const c = [center[0] + r[0] * mr + u[0] * mu, center[1] + r[1] * mr + u[1] * mu, center[2] + r[2] * mr + u[2] * mu];
    return { ortho, c, f, r, u, scale: Math.max(scale, 1e-4), W, H };
  }
  const fovV = (o.fov ?? 45) * DEG;
  const tanV = Math.tan(fovV / 2), tanH = tanV * (W / H);
  const fits = (D: number) => {
    const eye = [center[0] - f[0] * D, center[1] - f[1] * D, center[2] - f[2] * D];
    for (const p of cs) {
      const q = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
      const z = dot(q, f);
      if (z <= 0.1) return false;
      if (Math.abs(dot(q, r)) / z > tanH * 0.92 || Math.abs(dot(q, u)) / z > tanV * 0.92) return false;
    }
    return true;
  };
  const R = Math.hypot(frame.max[0] - frame.min[0] + 1, frame.max[1] - frame.min[1] + 1, frame.max[2] - frame.min[2] + 1) / 2;
  let lo = 0.2, hi = Math.max(4, R * 20);
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  const D = hi / zoom;
  const eye = [center[0] - f[0] * D, center[1] - f[1] * D, center[2] - f[2] * D];
  return { ortho: false, c: eye, f, r, u, scale: tanV / (H / 2), W, H };
}

/** world point → screen pixel (x, y, depth) */
export function project(cam: Camera, p: number[]): [number, number, number] {
  if (cam.ortho) {
    const q = [p[0] - cam.c[0], p[1] - cam.c[1], p[2] - cam.c[2]];
    return [cam.W / 2 + dot(q, cam.r) / cam.scale, cam.H / 2 - dot(q, cam.u) / cam.scale, dot(q, cam.f)];
  }
  const q = [p[0] - cam.c[0], p[1] - cam.c[1], p[2] - cam.c[2]];
  const z = Math.max(1e-3, dot(q, cam.f));
  return [cam.W / 2 + dot(q, cam.r) / z / cam.scale, cam.H / 2 - dot(q, cam.u) / z / cam.scale, z];
}

const lin = (c: number) => Math.pow(c / 255, 2.2);
const linRgb = (r: number, g: number, b: number) => [lin(r), lin(g), lin(b)];

export interface Lighting {
  sun: number[];
  sunCol: number[];
  ambCol: number[];
  blockCol: number[];
  skyTop: number[];
  skyHor: number[];
  fogCol: number[];
  exposure: number;
  night: boolean;
}

/** lighting preset; the sun is placed relative to the camera (upper left, slightly behind) */
export function makeLighting(time: 'day' | 'sunset' | 'night', cam: Camera, sunMode: 'camera' | 'world' = 'camera'): Lighting {
  const elev = (time === 'sunset' ? 14 : time === 'night' ? 45 : 52) * DEG;
  let fh = [cam.f[0], 0, cam.f[2]];
  if (Math.hypot(fh[0], fh[2]) < 1e-3 || sunMode === 'world') fh = [-0.42, 0, -0.9]; // top view / world: sun from the south-east-ish
  fh = norm(fh);
  const left = [fh[2], 0, -fh[0]]; // rotate fh 90° counter-clockwise (seen from above) = camera left
  const az = (time === 'sunset' ? 75 : 62) * DEG;
  const hx = -fh[0] * Math.cos(az) + left[0] * Math.sin(az);
  const hz = -fh[2] * Math.cos(az) + left[2] * Math.sin(az);
  const sun = norm([hx * Math.cos(elev), Math.sin(elev), hz * Math.cos(elev)]);
  const mk = (l: Omit<Lighting, 'sun'>): Lighting => {
    // sky/fog colors are authored in display space: undo the exposure applied later
    const k = 1 / l.exposure;
    const sc = (c: number[]) => c.map((x) => x * k);
    return { ...l, sun, skyTop: sc(l.skyTop), skyHor: sc(l.skyHor), fogCol: sc(l.fogCol) };
  };
  if (time === 'sunset')
    return mk({
      sunCol: [1.9, 1.0, 0.42], ambCol: [0.44, 0.38, 0.58], blockCol: [1.4, 0.95, 0.45],
      skyTop: linRgb(70, 88, 160), skyHor: linRgb(250, 170, 110), fogCol: linRgb(230, 165, 120), exposure: 0.75, night: false,
    });
  if (time === 'night')
    return mk({
      sunCol: [0.14, 0.17, 0.27], ambCol: [0.08, 0.1, 0.18], blockCol: [2.2, 1.45, 0.75],
      skyTop: linRgb(8, 12, 30), skyHor: linRgb(28, 36, 64), fogCol: linRgb(20, 26, 48), exposure: 1.0, night: true,
    });
  return mk({
    sunCol: [1.55, 1.46, 1.3], ambCol: [0.6, 0.7, 0.92], blockCol: [1.2, 0.9, 0.55],
    skyTop: linRgb(96, 150, 230), skyHor: linRgb(196, 222, 246), fogCol: linRgb(200, 222, 244), exposure: 0.5, night: false,
  });
}
