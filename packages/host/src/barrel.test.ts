import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// C-782: named re-export lists were a frequent merge conflict (two cards adding
// names to the same block). One `export *` line per module leaves only adding
// or removing a module as an edit, and the compiler rejects ambiguous names.
test("the host barrel re-exports whole modules, one line each", () => {
  const lines = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean);
  expect(
    lines.filter((l) => !/^export \* from "\.\/[\w./-]+\.js";$/u.test(l)),
  ).toEqual([]);
  expect(new Set(lines).size).toBe(lines.length);
});
