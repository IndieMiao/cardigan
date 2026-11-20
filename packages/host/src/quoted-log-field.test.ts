import { expect, test } from "vitest";
import { QuotedLogField } from "./quoted-log-field.js";

// A scanner block can start anywhere inside a name, separator or value. Test
// every two-piece split plus one-character blocks, without relying on IO sizes.
function fragments(line: string) {
  return [
    [...line],
    ...Array.from({ length: line.length + 1 }, (_, i) => [
      line.slice(0, i),
      line.slice(i),
    ]),
  ];
}

test.each([
  ["label=encoded=", false],
  ["label=encoded==", false],
  [`label=atom:sub/k='not-a-field`, false],
  ['label="encoded="', false],
  ["label=encoded= next=  ", true],
  [`label=encoded==,'TOKEN': 'open`, true],
  [String.raw`label=plain;password="escaped\"`, true],
] as const)("value boundaries across scan blocks: %s", (line, continued) => {
  for (const parts of fragments(line)) {
    const field = new QuotedLogField();
    for (const part of parts) field.scan(part);
    field.endLine();
    expect(field.active).toBe(continued);
    const next = "FAIL following case";
    expect(field.scan(next)).toBe(continued ? 0 : next.length);
  }
});
