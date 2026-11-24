/**
 * C-705: a minimal QR Code encoder (ISO/IEC 18004) for the device pairing
 * link: byte mode, error correction level M, versions 1–6 (up to 106 bytes,
 * no version information blocks). The device prints the returned rows, so the
 * new machine needs nothing beyond Python's standard library.
 */

// Data codewords per block and blocks per version at level M (versions 1–6
// split into equally sized blocks).
const LEVEL_M: readonly { blocks: number; data: number; ec: number }[] = [
  { blocks: 1, data: 16, ec: 10 },
  { blocks: 1, data: 28, ec: 16 },
  { blocks: 1, data: 44, ec: 26 },
  { blocks: 2, data: 32, ec: 18 },
  { blocks: 2, data: 43, ec: 24 },
  { blocks: 4, data: 27, ec: 16 },
];
/** Bytes that fit in the largest supported version. */
export const QR_MAX_BYTES = 106;

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}
function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j] as number, root);
      if (j + 1 < degree)
        result[j] = (result[j] as number) ^ (result[j + 1] as number);
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}
/** Reed–Solomon error correction codewords for one block. */
export function reedSolomon(data: readonly number[], degree: number): number[] {
  const divisor = rsDivisor(degree);
  const result = new Array<number>(degree).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    for (let i = 0; i < degree; i++)
      result[i] =
        (result[i] as number) ^ gfMultiply(divisor[i] as number, factor);
  }
  return result;
}
/** The 15 format bits for level M and `mask`, already XOR-masked. */
export function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask; // level M is 00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** Data and error correction codewords, interleaved, for `bytes` in `version`. */
export function qrCodewords(bytes: Uint8Array, version: number): number[] {
  const spec = LEVEL_M[version - 1];
  if (!spec) throw new RangeError("unsupported QR version");
  const capacity = spec.blocks * spec.data;
  const bits: number[] = [];
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, 8);
  for (const b of bytes) put(b, 8);
  if (bits.length > capacity * 8) throw new RangeError("data too long");
  put(0, Math.min(4, capacity * 8 - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8)
    data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11)
    data.push(pad);
  const blocks: number[][] = [],
    ecs: number[][] = [];
  for (let b = 0; b < spec.blocks; b++) {
    const block = data.slice(b * spec.data, (b + 1) * spec.data);
    blocks.push(block);
    ecs.push(reedSolomon(block, spec.ec));
  }
  const out: number[] = [];
  for (let i = 0; i < spec.data; i++)
    for (const block of blocks) out.push(block[i] as number);
  for (let i = 0; i < spec.ec; i++)
    for (const ec of ecs) out.push(ec[i] as number);
  return out;
}

const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Matrix {
  readonly size: number;
  readonly dark: boolean[][];
  readonly reserved: boolean[][];
  readonly version: number;
  constructor(version: number) {
    this.version = version;
    this.size = version * 4 + 17;
    this.dark = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    );
    this.reserved = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    );
    this.drawFunctionPatterns();
  }
  private set(x: number, y: number, dark: boolean) {
    (this.dark[y] as boolean[])[x] = dark;
    (this.reserved[y] as boolean[])[x] = true;
  }
  private drawFunctionPatterns() {
    const { size } = this;
    for (let i = 0; i < size; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [
      [3, 3],
      [size - 4, 3],
      [3, size - 4],
    ] as const)
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx,
            y = cy + dy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          this.set(x, y, d !== 2 && d !== 4);
        }
    if (this.version >= 2) {
      // Versions 2–6 have one alignment pattern, at the far corner.
      const c = size - 7;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          this.set(c + dx, c + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    this.drawFormat(0);
  }
  drawFormat(mask: number) {
    const bits = formatBits(mask),
      bit = (i: number) => ((bits >>> i) & 1) === 1,
      { size } = this;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, size - 15 + i, bit(i));
    this.set(8, size - 8, true);
  }
  drawCodewords(codewords: readonly number[]) {
    const { size } = this;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++)
        for (let j = 0; j < 2; j++) {
          const x = right - j,
            upward = ((right + 1) & 2) === 0,
            y = upward ? size - 1 - vert : vert;
          if ((this.reserved[y] as boolean[])[x]) continue;
          if (i < codewords.length * 8)
            (this.dark[y] as boolean[])[x] =
              (((codewords[i >>> 3] as number) >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
    }
  }
  applyMask(mask: number) {
    const fn = MASKS[mask] as (x: number, y: number) => boolean;
    for (let y = 0; y < this.size; y++)
      for (let x = 0; x < this.size; x++)
        if (!(this.reserved[y] as boolean[])[x] && fn(x, y))
          (this.dark[y] as boolean[])[x] = !(this.dark[y] as boolean[])[x];
  }
  penalty(): number {
    const { size, dark } = this;
    const at = (x: number, y: number) => (dark[y] as boolean[])[x] as boolean;
    let score = 0;
    const lines = (get: (a: number, b: number) => boolean) => {
      for (let a = 0; a < size; a++) {
        let run = 1;
        for (let b = 1; b <= size; b++) {
          if (b < size && get(a, b) === get(a, b - 1)) run++;
          else {
            if (run >= 5) score += 3 + run - 5;
            run = 1;
          }
        }
        for (let b = 0; b + 11 <= size; b++) {
          const s = Array.from({ length: 11 }, (_, k) =>
            get(a, b + k) ? "1" : "0",
          ).join("");
          if (s === "10111010000" || s === "00001011101") score += 40;
        }
      }
    };
    lines((y, x) => at(x, y));
    lines((x, y) => at(x, y));
    for (let y = 0; y + 1 < size; y++)
      for (let x = 0; x + 1 < size; x++) {
        const c = at(x, y);
        if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1))
          score += 3;
      }
    const darkCount = dark.flat().filter(Boolean).length,
      total = size * size;
    score +=
      (Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * 10;
    return score;
  }
}

export interface QrCode {
  readonly version: number;
  readonly mask: number;
  /** Rows top to bottom, `true` for a dark module, without the quiet zone. */
  readonly modules: readonly (readonly boolean[])[];
}

/** Encode `text` as UTF-8 bytes; `undefined` when it is too long. */
export function encodeQr(text: string, mask?: number): QrCode | undefined {
  const bytes = new TextEncoder().encode(text);
  const version =
    LEVEL_M.findIndex((s) => s.blocks * s.data - 2 >= bytes.length) + 1;
  if (version === 0) return undefined;
  const codewords = qrCodewords(bytes, version);
  let best: { matrix: Matrix; mask: number; score: number } | undefined;
  for (const m of mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [mask]) {
    const matrix = new Matrix(version);
    matrix.drawCodewords(codewords);
    matrix.applyMask(m);
    matrix.drawFormat(m);
    const score = matrix.penalty();
    if (!best || score < best.score) best = { matrix, mask: m, score };
  }
  if (!best) return undefined;
  return { version, mask: best.mask, modules: best.matrix.dark };
}

/**
 * Terminal rows with a 4-module quiet zone, two module rows per line using
 * half blocks. Light modules are drawn as blocks for the usual light-on-dark
 * terminal; `pair-device.py --light` swaps them for dark-on-light ones.
 */
export function qrTerminalRows(code: QrCode): string[] {
  const size = code.modules.length,
    quiet = 4,
    dark = (x: number, y: number) =>
      x >= 0 &&
      y >= 0 &&
      x < size &&
      y < size &&
      ((code.modules[y] as readonly boolean[])[x] as boolean);
  const rows: string[] = [];
  for (let y = -quiet; y < size + quiet; y += 2) {
    let line = "";
    for (let x = -quiet; x < size + quiet; x++) {
      const top = !dark(x, y),
        bottom = y + 1 < size + quiet && !dark(x, y + 1);
      line += top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
    }
    rows.push(line);
  }
  return rows;
}
