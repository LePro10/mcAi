// Small RGBA image helper: blending, lines, rectangles, bitmap text (5×7 font), PNG encode.
import { PNG } from 'pngjs';

// 5×7 glyphs, each row is 5 bits (MSB = left). Lowercase letters render as uppercase.
const GLYPHS: Record<string, number[]> = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30], E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17], I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16], Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4], U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  '0': [14, 17, 19, 21, 25, 17, 14], '1': [4, 12, 4, 4, 4, 4, 14], '2': [14, 17, 1, 2, 4, 8, 31],
  '3': [31, 2, 4, 2, 1, 17, 14], '4': [2, 6, 10, 18, 31, 2, 2], '5': [31, 16, 30, 1, 1, 17, 14],
  '6': [6, 8, 16, 30, 17, 17, 14], '7': [31, 1, 2, 4, 8, 8, 8], '8': [14, 17, 17, 14, 17, 17, 14],
  '9': [14, 17, 17, 15, 1, 2, 12],
  '.': [0, 0, 0, 0, 0, 12, 12], ',': [0, 0, 0, 0, 12, 4, 8], ':': [0, 12, 12, 0, 12, 12, 0],
  '-': [0, 0, 0, 31, 0, 0, 0], '+': [0, 4, 4, 31, 4, 4, 0], '=': [0, 0, 31, 0, 31, 0, 0],
  '/': [1, 1, 2, 4, 8, 16, 16], '(': [2, 4, 8, 8, 8, 4, 2], ')': [8, 4, 2, 2, 2, 4, 8],
  '[': [14, 8, 8, 8, 8, 8, 14], ']': [14, 2, 2, 2, 2, 2, 14], '_': [0, 0, 0, 0, 0, 0, 31],
  '#': [10, 10, 31, 10, 31, 10, 10], '!': [4, 4, 4, 4, 4, 0, 4], '?': [14, 17, 1, 2, 4, 0, 4],
  "'": [4, 4, 8, 0, 0, 0, 0], '"': [10, 10, 0, 0, 0, 0, 0], '<': [2, 4, 8, 16, 8, 4, 2],
  '>': [8, 4, 2, 1, 2, 4, 8], '*': [0, 4, 21, 14, 21, 4, 0], '%': [24, 25, 2, 4, 8, 19, 3],
  '~': [0, 0, 8, 21, 2, 0, 0], '^': [4, 10, 17, 0, 0, 0, 0], '|': [4, 4, 4, 4, 4, 4, 4],
};

export type RGBA = [number, number, number, number];

export class Img {
  readonly w: number;
  readonly h: number;
  readonly data: Uint8ClampedArray;
  constructor(w: number, h: number, fill?: RGBA) {
    this.w = w;
    this.h = h;
    this.data = new Uint8ClampedArray(w * h * 4);
    if (fill) this.fillRect(0, 0, w, h, fill);
  }

  blend(x: number, y: number, c: RGBA, a = c[3] / 255): void {
    x |= 0;
    y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return;
    const i = (y * this.w + x) * 4;
    const d = this.data;
    if (a >= 1) {
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
      return;
    }
    d[i] = d[i] * (1 - a) + c[0] * a;
    d[i + 1] = d[i + 1] * (1 - a) + c[1] * a;
    d[i + 2] = d[i + 2] * (1 - a) + c[2] * a;
    d[i + 3] = Math.max(d[i + 3], a * 255);
  }

  fillRect(x: number, y: number, w: number, h: number, c: RGBA): void {
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.w, Math.floor(x + w)), y1 = Math.min(this.h, Math.floor(y + h));
    const a = c[3] / 255;
    for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) this.blend(i, j, c, a);
  }

  strokeRect(x: number, y: number, w: number, h: number, c: RGBA, t = 1): void {
    this.fillRect(x, y, w, t, c);
    this.fillRect(x, y + h - t, w, t, c);
    this.fillRect(x, y + t, t, h - 2 * t, c);
    this.fillRect(x + w - t, y + t, t, h - 2 * t, c);
  }

  /** anti-aliased-ish thick line (distance based) */
  line(x0: number, y0: number, x1: number, y1: number, c: RGBA, width = 1.5): void {
    const minX = Math.floor(Math.min(x0, x1) - width - 1), maxX = Math.ceil(Math.max(x0, x1) + width + 1);
    const minY = Math.floor(Math.min(y0, y1) - width - 1), maxY = Math.ceil(Math.max(y0, y1) + width + 1);
    const dx = x1 - x0, dy = y1 - y0;
    const L2 = dx * dx + dy * dy || 1e-9;
    const r = width / 2;
    for (let y = Math.max(0, minY); y <= Math.min(this.h - 1, maxY); y++)
      for (let x = Math.max(0, minX); x <= Math.min(this.w - 1, maxX); x++) {
        const px = x + 0.5 - x0, py = y + 0.5 - y0;
        let t = (px * dx + py * dy) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - t * dx, ey = py - t * dy;
        const d = Math.sqrt(ex * ex + ey * ey);
        const cov = Math.max(0, Math.min(1, r + 0.5 - d));
        if (cov > 0) this.blend(x, y, c, (cov * c[3]) / 255);
      }
  }

  static textWidth(s: string, scale = 2): number {
    return s.length * 6 * scale - scale;
  }

  text(x: number, y: number, s: string, scale = 2, c: RGBA = [255, 255, 255, 255], shadow: RGBA | null = [0, 0, 0, 160]): void {
    if (shadow) this.text(x + scale, y + scale, s, scale, shadow, null);
    let cx = Math.round(x);
    for (const ch of s) {
      const g = GLYPHS[ch] ?? GLYPHS[ch.toUpperCase()] ?? GLYPHS['?'];
      for (let row = 0; row < 7; row++)
        for (let col = 0; col < 5; col++)
          if (g[row] & (16 >> col)) this.fillRect(cx + col * scale, Math.round(y) + row * scale, scale, scale, c);
      cx += 6 * scale;
    }
  }

  /** text on a translucent rounded-ish backdrop */
  label(x: number, y: number, s: string, scale = 2, fg: RGBA = [255, 255, 255, 255], bg: RGBA = [20, 24, 32, 170]): void {
    const w = Img.textWidth(s, scale) + 4 * scale, h = 7 * scale + 4 * scale;
    this.fillRect(x, y, w, h, bg);
    this.text(x + 2 * scale, y + 2 * scale, s, scale, fg, null);
  }

  blit(src: Img, dx: number, dy: number): void {
    for (let y = 0; y < src.h; y++) {
      const ty = dy + y;
      if (ty < 0 || ty >= this.h) continue;
      for (let x = 0; x < src.w; x++) {
        const tx = dx + x;
        if (tx < 0 || tx >= this.w) continue;
        const s = (y * src.w + x) * 4, d = (ty * this.w + tx) * 4;
        const a = src.data[s + 3] / 255;
        if (a >= 1) {
          this.data[d] = src.data[s]; this.data[d + 1] = src.data[s + 1]; this.data[d + 2] = src.data[s + 2]; this.data[d + 3] = 255;
        } else if (a > 0) this.blend(tx, ty, [src.data[s], src.data[s + 1], src.data[s + 2], 255], a);
      }
    }
  }

  toPng(): Buffer {
    const png = new PNG({ width: this.w, height: this.h, colorType: 6 });
    png.data = Buffer.from(this.data.buffer, this.data.byteOffset, this.data.length);
    return PNG.sync.write(png);
  }
}
