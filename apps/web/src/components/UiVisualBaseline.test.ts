import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compare, scenes } from "../../test-support/page-skeleton-visual.mjs";

const seed = JSON.parse(
  readFileSync(
    new URL(
      "../../test-support/page-skeleton-approvals/seed.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const baseline = Object.fromEntries(
  Object.entries<[number, string]>(seed).map(([scene, [, hash]]) => [
    scene,
    hash,
  ]),
);
const board = "board-1440-light.png",
  list = "list-390-dark.png",
  detail = "detail-390-light.png";
const a = "a".repeat(64),
  b = "b".repeat(64),
  c = "c".repeat(64);

test("requires the complete approved set and rejects stale or unknown pixels", () => {
  expect(scenes).toHaveLength(44);
  expect(compare([seed], baseline)).toEqual({});
  expect(() => compare([seed], {})).toThrow("Incomplete capture");
  expect(() => compare([], baseline)).toThrow("Missing approval");
  expect(compare([seed, { [board]: [1, a] }], baseline)).toEqual({
    [board]: [2, baseline[board]],
  });
});

test("candidate with two concurrent image allocations needs no binary merge", () => {
  const cwd = mkdtempSync(join(tmpdir(), "visual-merge-"));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        ...args,
      ],
      { cwd, encoding: "utf8" },
    ).trim();
  const write = (path: string, data: string) =>
    writeFileSync(join(cwd, path), data);
  const read = (path: string) =>
    JSON.parse(readFileSync(join(cwd, path), "utf8"));
  try {
    git("init", "-q", "-b", "main");
    write(
      ".gitignore",
      readFileSync(new URL("../../../../.gitignore", import.meta.url), "utf8"),
    );
    git("add", ".");
    git("commit", "-qm", "seed");
    git("branch", "second");
    mkdirSync(join(cwd, "apps/web/test-support/page-skeleton-snapshots"), {
      recursive: true,
    });
    const cards = [
      { [board]: [1, a], [list]: [1, b] },
      { [board]: [1, a], [detail]: [1, c] },
    ];
    for (const [i, card] of cards.entries()) {
      if (i) git("checkout", "-q", "second");
      write(`C-${i + 1}.json`, JSON.stringify(card));
      write(
        "apps/web/test-support/page-skeleton-snapshots/board-1440-light.png",
        a,
      );
      git("add", ".");
      git("commit", "-qm", "visual change");
    }
    git("checkout", "-q", "main");
    git("merge", "-q", "--no-edit", "second");
    expect(git("ls-files", "*.png")).toBe("");
    expect(
      compare([seed, read("C-1.json"), read("C-2.json")], {
        ...baseline,
        [board]: a,
        [list]: b,
        [detail]: c,
      }),
    ).toEqual({});
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("competing approvals need a new reviewed generation even if one matches", () => {
  const receipts = [seed, { [board]: [1, a] }, { [board]: [1, b] }];
  const captured = { ...baseline, [board]: c };
  expect(compare(receipts, { ...baseline, [board]: a })).toEqual({
    [board]: [2, a],
  });
  const combined = compare(receipts, captured);
  expect(combined).toEqual({ [board]: [2, c] });
  expect(compare([...receipts, combined], captured)).toEqual({});
});
