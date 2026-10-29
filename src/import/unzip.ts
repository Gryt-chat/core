/* A zip reader with its own inflate (RFC 1951), for Hermes, which has no DecompressionStream.
   Read bit by bit: slow next to zlib, and fine for a package of JSON. No Zip64, no encryption. */

import type { PackageFiles } from "./discordPackage.ts";

class Bits {
  pos = 0;
  bit = 0;
  private readonly data: Uint8Array;
  constructor(data: Uint8Array) {
    this.data = data;
  }

  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (this.pos >= this.data.length) throw new Error("The zip ends in the middle of a file.");
      v |= ((this.data[this.pos] >> this.bit) & 1) << i;
      if (++this.bit === 8) { this.bit = 0; this.pos++; }
    }
    return v;
  }

  align(): void {
    if (this.bit) { this.bit = 0; this.pos++; }
  }
}

interface Tree {
  counts: Uint16Array;
  symbols: Uint16Array;
}

function tree(lengths: ArrayLike<number>): Tree {
  const counts = new Uint16Array(16);
  for (let i = 0; i < lengths.length; i++) counts[lengths[i]]++;
  counts[0] = 0;
  const offsets = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offsets[i] = offsets[i - 1] + counts[i - 1];
  const symbols = new Uint16Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) symbols[offsets[lengths[i]]++] = i;
  return { counts, symbols };
}

function decode(bits: Bits, t: Tree): number {
  let sum = 0;
  let cur = 0;
  let len = 0;
  do {
    cur = 2 * cur + bits.read(1);
    if (++len > 15) throw new Error("The zip has a damaged file in it.");
    sum += t.counts[len];
    cur -= t.counts[len];
  } while (cur >= 0);
  return t.symbols[sum + cur];
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function fixedLength(i: number): number {
  if (i < 144) return 8;
  if (i < 256) return 9;
  return i < 280 ? 7 : 8;
}

const FIXED_LIT = tree(Array.from({ length: 288 }, (_, i) => fixedLength(i)));
const FIXED_DIST = tree(new Array<number>(30).fill(5));

function dynamicTrees(bits: Bits): [Tree, Tree] {
  const hlit = bits.read(5) + 257;
  const hdist = bits.read(5) + 1;
  const hclen = bits.read(4) + 4;
  const codeLengths = new Uint8Array(19);
  for (let i = 0; i < hclen; i++) codeLengths[ORDER[i]] = bits.read(3);
  const codes = tree(codeLengths);
  const lengths = new Uint8Array(hlit + hdist);
  for (let n = 0; n < hlit + hdist;) {
    const sym = decode(bits, codes);
    if (sym < 16) { lengths[n++] = sym; continue; }
    let repeat = 0;
    let value = 0;
    if (sym === 16) {
      if (n === 0) throw new Error("The zip has a damaged file in it.");
      value = lengths[n - 1];
      repeat = 3 + bits.read(2);
    } else if (sym === 17) repeat = 3 + bits.read(3);
    else repeat = 11 + bits.read(7);
    while (repeat-- > 0) lengths[n++] = value;
  }
  return [tree(lengths.subarray(0, hlit)), tree(lengths.subarray(hlit))];
}

/** Raw DEFLATE, as a zip stores it. `size` is the inflated length the zip's header gives. */
export function inflateRaw(data: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let o = 0;
  const bits = new Bits(data);
  let last = 0;
  while (!last) {
    last = bits.read(1);
    const type = bits.read(2);
    if (type === 0) {
      bits.align();
      const len = data[bits.pos] | (data[bits.pos + 1] << 8);
      bits.pos += 4;
      out.set(data.subarray(bits.pos, bits.pos + len), o);
      bits.pos += len;
      o += len;
      continue;
    }
    if (type === 3) throw new Error("The zip has a damaged file in it.");
    const [lit, dist] = type === 1 ? [FIXED_LIT, FIXED_DIST] : dynamicTrees(bits);
    for (;;) {
      const sym = decode(bits, lit);
      if (sym === 256) break;
      if (sym < 256) { out[o++] = sym; continue; }
      const li = sym - 257;
      const length = LENGTH_BASE[li] + bits.read(LENGTH_EXTRA[li]);
      const di = decode(bits, dist);
      const back = DIST_BASE[di] + bits.read(DIST_EXTRA[di]);
      if (back > o || o + length > size) throw new Error("The zip has a damaged file in it.");
      for (let k = 0; k < length; k++, o++) out[o] = out[o - back];
    }
  }
  return o === size ? out : out.subarray(0, o);
}

/** The files in a zip held in memory, read lazily. */
export function openZipBytes(zip: Uint8Array): PackageFiles {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("That file isn't a zip.");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  if (p === 0xffffffff) throw new Error("That zip is too big to read here.");
  const decoder = new TextDecoder();
  const entries = new Map<string, { method: number; compressed: number; size: number; local: number }>();
  for (let n = 0; n < count && view.getUint32(p, true) === 0x02014b50; n++) {
    const nameLength = view.getUint16(p + 28, true);
    const name = decoder.decode(zip.subarray(p + 46, p + 46 + nameLength));
    if (!name.endsWith("/")) {
      entries.set(name, { method: view.getUint16(p + 10, true), compressed: view.getUint32(p + 20, true), size: view.getUint32(p + 24, true), local: view.getUint32(p + 42, true) });
    }
    p += 46 + nameLength + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
  }
  return {
    names: [...entries.keys()],
    async read(name) {
      const e = entries.get(name);
      if (!e) throw new Error(`${name} isn't in the zip.`);
      if (view.getUint32(e.local, true) !== 0x04034b50) throw new Error(`${name} is damaged in the zip.`);
      const start = e.local + 30 + view.getUint16(e.local + 26, true) + view.getUint16(e.local + 28, true);
      const data = zip.subarray(start, start + e.compressed);
      if (e.method === 0) return decoder.decode(data);
      if (e.method !== 8) throw new Error(`${name} is packed in a way this can't read.`);
      return decoder.decode(inflateRaw(data, e.size));
    },
  };
}
