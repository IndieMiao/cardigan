import { expect, test } from "vitest";
import {
  encodeQr,
  formatBits,
  QR_MAX_BYTES,
  qrCodewords,
  qrTerminalRows,
  reedSolomon,
} from "./qr.js";

test("Reed–Solomon and codewords match the published HELLO WORLD 1-M example", () => {
  const data = [
    32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17,
  ];
  expect(reedSolomon(data, 10)).toEqual([
    196, 35, 39, 119, 235, 215, 231, 226, 93, 23,
  ]);
  // Byte mode of "A" in version 1: mode 0100, count 00000001, 'A' 01000001.
  const words = qrCodewords(new TextEncoder().encode("A"), 1);
  expect(words.slice(0, 4)).toEqual([0x40, 0x14, 0x10, 0xec]);
  expect(words).toHaveLength(26);
});

test("format bits for level M match the standard table", () => {
  const table = [
    "101010000010010",
    "101000100100101",
    "101111001111100",
    "101101101001011",
    "100010111111001",
    "100000011001110",
    "100111110010111",
    "100101010100000",
  ];
  for (const [mask, bits] of table.entries())
    expect(formatBits(mask).toString(2).padStart(15, "0")).toBe(bits);
});

test("smallest version that fits, finder patterns and both format copies", () => {
  expect(encodeQr("x".repeat(14))?.version).toBe(1);
  expect(encodeQr("x".repeat(15))?.version).toBe(2);
  expect(encodeQr("x".repeat(QR_MAX_BYTES))?.version).toBe(6);
  expect(encodeQr("x".repeat(QR_MAX_BYTES + 1))).toBeUndefined();
  for (let mask = 0; mask < 8; mask++) {
    const code = encodeQr("https://host.example.ts.net/#/pair/ABCD-EFGH", mask);
    if (!code) throw new Error("no code");
    const m = code.modules,
      size = m.length,
      at = (x: number, y: number) => (m[y]?.[x] ? 1 : 0);
    expect(size).toBe(code.version * 4 + 17);
    for (const [cx, cy] of [
      [3, 3],
      [size - 4, 3],
      [3, size - 4],
    ] as const) {
      expect(at(cx, cy)).toBe(1);
      expect(at(cx - 2, cy)).toBe(0);
      expect(at(cx - 3, cy)).toBe(1);
    }
    let first = 0,
      second = 0;
    const one = [
      ...[0, 1, 2, 3, 4, 5, 7, 8].map((y) => at(8, y)),
      ...[7, 5, 4, 3, 2, 1, 0].map((x) => at(x, 8)),
    ];
    const two = [
      ...Array.from({ length: 8 }, (_, i) => at(size - 1 - i, 8)),
      ...Array.from({ length: 7 }, (_, i) => at(8, size - 7 + i)),
    ];
    one.forEach((b, i) => {
      first |= b << i;
    });
    two.forEach((b, i) => {
      second |= b << i;
    });
    expect(first).toBe(formatBits(mask));
    expect(second).toBe(formatBits(mask));
    expect(at(8, size - 8)).toBe(1);
  }
});

test("terminal rows pack two module rows per line with a quiet zone", () => {
  const code = encodeQr("a");
  if (!code) throw new Error("no code");
  const rows = qrTerminalRows(code);
  expect(rows).toHaveLength(Math.ceil((21 + 8) / 2));
  for (const row of rows) expect([...row]).toHaveLength(21 + 8);
  expect(rows[0]).toBe("█".repeat(29));
});
