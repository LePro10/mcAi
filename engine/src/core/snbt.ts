// SNBT <-> prismarine-nbt tag conversion (used for block entity data in block state strings).
// Tags use the prismarine-nbt shape: { type: 'int', value: 1 }, compounds { type:'compound', value: {k: tag} },
// lists { type: 'list', value: { type: elemType, value: elemValues[] } }, longs [hi, lo].

export type NbtTag =
  | { type: 'byte' | 'short' | 'int' | 'float' | 'double'; value: number }
  | { type: 'long'; value: [number, number] }
  | { type: 'string'; value: string }
  | { type: 'byteArray' | 'shortArray' | 'intArray'; value: number[] }
  | { type: 'longArray'; value: [number, number][] }
  | { type: 'list'; value: { type: string; value: unknown[] } }
  | { type: 'compound'; value: Record<string, NbtTag | undefined> };

export class SnbtError extends Error {
  override name = 'SnbtError';
}

// ------------------------------------------------------------------ long helpers

export function longToBig(v: [number, number] | bigint | number): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  return BigInt.asIntN(64, (BigInt(v[0] | 0) << 32n) | BigInt(v[1] >>> 0));
}

export function bigToLong(b: bigint): [number, number] {
  const u = BigInt.asUintN(64, b);
  return [Number(BigInt.asIntN(32, u >> 32n)), Number(BigInt.asIntN(32, u & 0xffffffffn))];
}

// ------------------------------------------------------------------ stringify

const BARE_KEY = /^[A-Za-z0-9._+-]+$/;

function quote(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

function fmtFloat(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const s = String(n);
  return /[.eE]/.test(s) ? s : s + '.0';
}

function valueToSnbt(type: string, v: unknown): string {
  switch (type) {
    case 'byte':
      return `${v as number}b`;
    case 'short':
      return `${v as number}s`;
    case 'int':
      return `${v as number}`;
    case 'long':
      return `${longToBig(v as [number, number])}L`;
    case 'float':
      return `${fmtFloat(v as number)}f`;
    case 'double':
      return `${fmtFloat(v as number)}d`;
    case 'string':
      return quote(v as string);
    case 'byteArray':
      return `[B;${(v as number[]).map((x) => `${x}b`).join(',')}]`;
    case 'shortArray':
      return `[S;${(v as number[]).map((x) => `${x}s`).join(',')}]`;
    case 'intArray':
      return `[I;${(v as number[]).join(',')}]`;
    case 'longArray':
      return `[L;${(v as [number, number][]).map((x) => `${longToBig(x)}L`).join(',')}]`;
    case 'list': {
      const l = v as { type: string; value: unknown[] };
      if (!l.value || l.type === 'end') return '[]';
      return `[${l.value.map((e) => valueToSnbt(l.type, e)).join(',')}]`;
    }
    case 'compound': {
      const c = v as Record<string, NbtTag | undefined>;
      const parts: string[] = [];
      for (const k of Object.keys(c)) {
        const t = c[k];
        if (!t) continue;
        parts.push(`${BARE_KEY.test(k) ? k : quote(k)}:${valueToSnbt(t.type, t.value)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new SnbtError(`unknown NBT tag type ${type}`);
  }
}

export function nbtToSnbt(tag: NbtTag): string {
  return valueToSnbt(tag.type, tag.value);
}

// ------------------------------------------------------------------ parse

const NUM_RE = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([bslfd]?)$/i;
const INT_RE = /^[+-]?\d+$/;

class Parser {
  i = 0;
  readonly s: string;
  constructor(s: string) {
    this.s = s;
  }
  err(msg: string): never {
    throw new SnbtError(`${msg} at position ${this.i} in SNBT "${this.s.length > 80 ? this.s.slice(0, 80) + '…' : this.s}"`);
  }
  ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }
  peek(): string {
    this.ws();
    return this.s[this.i];
  }
  expect(c: string): void {
    if (this.peek() !== c) this.err(`expected '${c}'`);
    this.i++;
  }
  quoted(): string {
    const q = this.s[this.i++];
    let out = '';
    while (this.i < this.s.length) {
      const c = this.s[this.i++];
      if (c === '\\') {
        const n = this.s[this.i++];
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      } else if (c === q) return out;
      else out += c;
    }
    this.err('unterminated string');
  }
  bare(): string {
    const st = this.i;
    while (this.i < this.s.length && /[A-Za-z0-9._+\-]/.test(this.s[this.i])) this.i++;
    if (st === this.i) this.err('expected a value');
    return this.s.slice(st, this.i);
  }
  key(): string {
    const c = this.peek();
    return c === '"' || c === "'" ? this.quoted() : this.bare();
  }
  value(): NbtTag {
    const c = this.peek();
    if (c === '{') return this.compound();
    if (c === '[') return this.list();
    if (c === '"' || c === "'") return { type: 'string', value: this.quoted() };
    if (c === undefined) this.err('unexpected end');
    return scalar(this.bare());
  }
  compound(): NbtTag {
    this.expect('{');
    const value: Record<string, NbtTag> = {};
    if (this.peek() === '}') {
      this.i++;
      return { type: 'compound', value };
    }
    for (;;) {
      const k = this.key();
      this.expect(':');
      value[k] = this.value();
      const c = this.peek();
      if (c === ',') {
        this.i++;
        if (this.peek() === '}') {
          this.i++;
          break;
        }
        continue;
      }
      if (c === '}') {
        this.i++;
        break;
      }
      this.err("expected ',' or '}'");
    }
    return { type: 'compound', value };
  }
  list(): NbtTag {
    this.expect('[');
    this.ws();
    const m = /^([BILS])\s*;/.exec(this.s.slice(this.i, this.i + 4));
    if (m) {
      this.i += m[0].length;
      const kind = m[1];
      const nums: string[] = [];
      while (this.peek() !== ']') {
        nums.push(this.bare());
        if (this.peek() === ',') this.i++;
        else if (this.peek() !== ']') this.err("expected ',' or ']'");
      }
      this.i++;
      const strip = (x: string): string => x.replace(/[bslBSL]$/, '');
      if (kind === 'B') return { type: 'byteArray', value: nums.map((x) => scalarNum(x, true)) };
      if (kind === 'S') return { type: 'shortArray', value: nums.map((x) => Number(strip(x))) };
      if (kind === 'I') return { type: 'intArray', value: nums.map((x) => Number(x)) };
      return { type: 'longArray', value: nums.map((x) => bigToLong(BigInt(strip(x)))) };
    }
    const items: NbtTag[] = [];
    while (this.peek() !== ']') {
      items.push(this.value());
      if (this.peek() === ',') this.i++;
      else if (this.peek() !== ']') this.err("expected ',' or ']'");
    }
    this.i++;
    if (!items.length) return { type: 'list', value: { type: 'end', value: [] } };
    const t = items[0].type;
    if (items.every((x) => x.type === t)) return { type: 'list', value: { type: t, value: items.map((x) => x.value) } };
    // heterogeneous numeric list → widen to double; otherwise wrap like vanilla 1.21.5+ does
    if (items.every((x) => typeof x.value === 'number')) {
      return { type: 'list', value: { type: 'double', value: items.map((x) => x.value as number) } };
    }
    return { type: 'list', value: { type: 'compound', value: items.map((x) => (x.type === 'compound' ? x.value : { '': x })) } };
  }
}

function scalarNum(tok: string, isByte: boolean): number {
  if (/^true$/i.test(tok)) return 1;
  if (/^false$/i.test(tok)) return 0;
  const n = Number(isByte ? tok.replace(/[bB]$/, '') : tok);
  return n;
}

function scalar(tok: string): NbtTag {
  if (/^true$/i.test(tok)) return { type: 'byte', value: 1 };
  if (/^false$/i.test(tok)) return { type: 'byte', value: 0 };
  const m = NUM_RE.exec(tok);
  if (m) {
    const num = m[1];
    const suf = m[2].toLowerCase();
    if (suf === 'b' && INT_RE.test(num)) return { type: 'byte', value: Number(num) };
    if (suf === 's' && INT_RE.test(num)) return { type: 'short', value: Number(num) };
    if (suf === 'l' && INT_RE.test(num)) return { type: 'long', value: bigToLong(BigInt(num)) };
    if (suf === 'f') return { type: 'float', value: Number(num) };
    if (suf === 'd') return { type: 'double', value: Number(num) };
    if (suf === '') {
      if (INT_RE.test(num)) {
        const v = Number(num);
        if (v >= -2147483648 && v <= 2147483647) return { type: 'int', value: v };
      } else return { type: 'double', value: Number(num) };
    }
  }
  return { type: 'string', value: tok };
}

/** Parse SNBT (must be a compound, `{...}`) into a prismarine-nbt compound tag. */
export function snbtToNbt(snbt: string): NbtTag & { type: 'compound' } {
  const p = new Parser(snbt);
  const v = p.value();
  p.ws();
  if (p.i !== snbt.length) p.err('trailing characters');
  if (v.type !== 'compound') throw new SnbtError(`SNBT must be a compound {...}: "${snbt}"`);
  return v as NbtTag & { type: 'compound' };
}

/** Re-format SNBT in our canonical style (stable for round-trip comparisons). */
export function normalizeSnbt(snbt: string): string {
  return nbtToSnbt(snbtToNbt(snbt));
}
