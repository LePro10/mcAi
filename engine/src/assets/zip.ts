// Minimal read-only ZIP reader (stored + deflate), enough for a Minecraft client jar.
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

export class ZipReader {
  readonly entries = new Map<string, ZipEntry>();
  private buf: Buffer;

  constructor(bufOrPath: Buffer | string) {
    this.buf = typeof bufOrPath === 'string' ? readFileSync(bufOrPath) : bufOrPath;
    const b = this.buf;
    // find End Of Central Directory record (scan backwards, comment ≤ 64 KiB)
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
      if (b.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('not a zip file (no EOCD)');
    let count = b.readUInt16LE(eocd + 10);
    let cdSize = b.readUInt32LE(eocd + 12);
    let cdOffset = b.readUInt32LE(eocd + 16);
    // ZIP64 locator
    if (cdOffset === 0xffffffff || count === 0xffff) {
      const loc = eocd - 20;
      if (loc >= 0 && b.readUInt32LE(loc) === 0x07064b50) {
        const z64 = Number(b.readBigUInt64LE(loc + 8));
        count = Number(b.readBigUInt64LE(z64 + 32));
        cdSize = Number(b.readBigUInt64LE(z64 + 40));
        cdOffset = Number(b.readBigUInt64LE(z64 + 48));
      }
    }
    let p = cdOffset;
    const end = cdOffset + cdSize;
    while (p < end && b.readUInt32LE(p) === 0x02014b50) {
      const method = b.readUInt16LE(p + 10);
      let compressedSize = b.readUInt32LE(p + 20);
      let size = b.readUInt32LE(p + 24);
      const nameLen = b.readUInt16LE(p + 28);
      const extraLen = b.readUInt16LE(p + 30);
      const commentLen = b.readUInt16LE(p + 32);
      let localOffset = b.readUInt32LE(p + 42);
      const name = b.toString('utf8', p + 46, p + 46 + nameLen);
      if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
        let q = p + 46 + nameLen;
        const qe = q + extraLen;
        while (q + 4 <= qe) {
          const id = b.readUInt16LE(q);
          const len = b.readUInt16LE(q + 2);
          if (id === 1) {
            let r = q + 4;
            if (size === 0xffffffff) { size = Number(b.readBigUInt64LE(r)); r += 8; }
            if (compressedSize === 0xffffffff) { compressedSize = Number(b.readBigUInt64LE(r)); r += 8; }
            if (localOffset === 0xffffffff) { localOffset = Number(b.readBigUInt64LE(r)); r += 8; }
          }
          q += 4 + len;
        }
      }
      this.entries.set(name, { name, method, compressedSize, size, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  names(prefix = ''): string[] {
    const out: string[] = [];
    for (const k of this.entries.keys()) if (k.startsWith(prefix)) out.push(k);
    return out;
  }

  read(name: string): Buffer | undefined {
    const e = this.entries.get(name);
    if (!e) return undefined;
    const b = this.buf;
    const lp = e.localOffset;
    if (b.readUInt32LE(lp) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const nameLen = b.readUInt16LE(lp + 26);
    const extraLen = b.readUInt16LE(lp + 28);
    const start = lp + 30 + nameLen + extraLen;
    const raw = b.subarray(start, start + e.compressedSize);
    if (e.method === 0) return Buffer.from(raw);
    if (e.method === 8) return inflateRawSync(raw);
    throw new Error(`unsupported zip method ${e.method} for ${name}`);
  }
}
