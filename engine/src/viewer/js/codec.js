// Binary helpers shared by the viewer, its worker and node tests (no DOM).
// The engine sends typed arrays as base64 of little-endian bytes (ARCHITECTURE §5).

/** base64 → Uint8Array (works in browsers, workers and node ≥ 16) */
export function b64ToBytes(s) {
  if (!s) return new Uint8Array(0);
  const bin = atob(s);
  const n = bin.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function view(bytes, C) {
  const n = Math.floor(bytes.byteLength / C.BYTES_PER_ELEMENT);
  if (bytes.byteOffset % C.BYTES_PER_ELEMENT === 0) return new C(bytes.buffer, bytes.byteOffset, n);
  return new C(bytes.slice(0, n * C.BYTES_PER_ELEMENT).buffer);
}

export const b64ToUint16 = (s) => view(b64ToBytes(s), Uint16Array);
export const b64ToInt32 = (s) => view(b64ToBytes(s), Int32Array);
export const b64ToInt16 = (s) => view(b64ToBytes(s), Int16Array);

/** Decode a `get_blocks` reply / `/api/blocks` body → { box, palette, data: Uint16Array } */
export function decodeVolume(msg) {
  const box = msg.box;
  const data = b64ToUint16(msg.data);
  const sx = box.max[0] - box.min[0] + 1, sy = box.max[1] - box.min[1] + 1, sz = box.max[2] - box.min[2] + 1;
  if (data.length !== sx * sy * sz) throw new Error(`volume size mismatch: ${data.length} != ${sx}*${sy}*${sz}`);
  return { box, palette: msg.palette, data };
}

/** Decode a `{type:'blocks'}` event → { palette, positions: Int32Array, states: Uint16Array, count } */
export function decodeBlocks(msg) {
  const positions = b64ToInt32(msg.positions);
  const states = b64ToUint16(msg.states);
  const count = Math.min(states.length, Math.floor(positions.length / 3));
  return { palette: msg.palette ?? [], positions, states, count, dimension: msg.dimension ?? 'minecraft:overworld' };
}

/** Bounds of an edit batch (inclusive) or null */
export function batchBounds(positions, count) {
  if (!count) return null;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++)
    for (let a = 0; a < 3; a++) {
      const v = positions[i * 3 + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  return { min, max };
}

/** Same rule as hub.defaultAllowedBox: allowed build box for anchor/facing/size (ARCHITECTURE §8). */
export function defaultAllowedBox(anchor, facing, size, depthBelow = 12, world = { minY: -64, maxY: 319 }) {
  const front = Math.min(8, Math.floor(size.z / 6));
  const lmin = [-Math.floor(size.x / 2), -depthBelow, -(size.z - 1 - front)];
  const lmax = [size.x - Math.floor(size.x / 2) - 1, size.y - 1, front];
  const turns = { north: 0, east: 1, south: 2, west: 3 }[facing] ?? 0;
  const rot = (x, z) => {
    switch (turns) {
      case 1: return [-z, x];
      case 2: return [-x, -z];
      case 3: return [z, -x];
      default: return [x, z];
    }
  };
  const a = rot(lmin[0], lmin[2]);
  const b = rot(lmax[0], lmax[2]);
  return {
    min: [anchor[0] + Math.min(a[0], b[0]), Math.max(world.minY, anchor[1] + lmin[1]), anchor[2] + Math.min(a[1], b[1])],
    max: [anchor[0] + Math.max(a[0], b[0]), Math.min(world.maxY, anchor[1] + lmax[1]), anchor[2] + Math.max(a[1], b[1])],
  };
}

export function parseSize(s) {
  const m = /^(\d+)x(\d+)x(\d+)$/i.exec(String(s ?? '').trim());
  return m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } : null;
}

/** Plain text from a chat string or a JSON text component */
export function plainText(t) {
  if (t == null) return '';
  if (typeof t !== 'string') return componentText(t);
  const s = t.trim();
  if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
    try {
      return componentText(JSON.parse(s));
    } catch {}
  }
  return t.replace(/§[0-9a-fk-or]/gi, '');
}

function componentText(c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(componentText).join('');
  let out = typeof c.text === 'string' ? c.text : typeof c.translate === 'string' ? c.translate : '';
  if (Array.isArray(c.extra)) out += c.extra.map(componentText).join('');
  return out;
}
