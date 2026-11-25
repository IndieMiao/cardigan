import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  compare,
  receiptHint,
  scenes,
} from "../../test-support/page-skeleton-visual.mjs";

const seed = JSON.parse(
  readFileSync(
    new URL(
      "../../test-support/page-skeleton-approvals/seed.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const baseline = seed as Record<string, string>;
const pixels = (hash: string) => ({ ...baseline, [board]: hash });
const board = "board-1440-light.png",
  list = "list-390-dark.png",
  detail = "detail-390-light.png";
const a = "a".repeat(64),
  b = "b".repeat(64),
  c = "c".repeat(64);

test("requires the complete approved set and rejects stale or unknown pixels", () => {
  expect(scenes).toHaveLength(44);
  expect(compare({ seed }, baseline)).toEqual({});
  expect(() => compare({ seed }, {})).toThrow("Incomplete capture");
  expect(() => compare({}, baseline)).toThrow("Incomplete seed");
  const accepted = compare({ seed }, pixels(a));
  expect(compare({ seed, "C-1": accepted }, baseline)).toHaveProperty(
    [board, "hash"],
    baseline[board],
  );
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
      compare({ seed }, { ...pixels(a), [list]: b }),
      compare({ seed }, { ...pixels(a), [detail]: c }),
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
      compare(
        { seed, "C-1": read("C-1.json"), "C-2": read("C-2.json") },
        {
          ...baseline,
          [board]: a,
          [list]: b,
          [detail]: c,
        },
      ),
    ).toEqual({});
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a longer approved chain cannot retire an unseen concurrent branch", () => {
  const first = { seed, "C-1": compare({ seed }, pixels(a)) };
  const main = { ...first, "C-2": compare(first, pixels(b)) };
  const concurrent = compare({ seed }, pixels(c));
  expect(compare(main, pixels(b))).toEqual({});
  expect(compare({ seed, "C-3": concurrent }, pixels(c))).toEqual({});
  const merged = { ...main, "C-3": concurrent };
  for (const hash of [a, b, c]) {
    const reviewed = compare(merged, pixels(hash));
    expect(reviewed[board]?.replaces).toHaveLength(2);
    expect(compare({ ...merged, "C-4": reviewed }, pixels(hash))).toEqual({});
    expect(
      compare({ ...merged, "C-4": reviewed }, pixels(hash === b ? c : b)),
    ).not.toEqual({});
  }
  // Independent receipts with identical final pixels do not require re-review.
  expect(
    compare({ ...main, "C-3": compare({ seed }, pixels(b)) }, pixels(b)),
  ).toEqual({});
});

test("a missing or replaced parent cannot stand in for the reviewed record", () => {
  const first = { seed, "C-1": compare({ seed }, pixels(a)) };
  const second = compare(first, pixels(b));
  expect(() => compare({ seed, "C-2": second }, pixels(b))).toThrow(
    "Missing parent approval",
  );
  expect(() =>
    compare(
      { seed, "C-1": compare({ seed }, pixels(c)), "C-2": second },
      pixels(b),
    ),
  ).toThrow("Missing parent approval");
});

test("approving a revert does not retire unseen branches with the original pixels", () => {
  const first = { seed, "C-1": compare({ seed }, pixels(a)) };
  const reverted = { ...first, "C-2": compare(first, baseline) };
  expect(compare(reverted, baseline)).toEqual({});
  const later = { ...reverted, "C-3": compare(reverted, pixels(b)) };
  // C-4 independently approved identical pixels to C-1, but C-2 never saw it.
  const merged = { ...later, "C-4": compare({ seed }, pixels(a)) };
  expect(compare(merged, pixels(b))[board]?.replaces).toHaveLength(2);
});

// C-737: a failing remote check prints the receipt `--update` would write.
const receiptIn = (hint: string) => {
  const match = hint.match(
    /--- page-skeleton receipt begin ---\n([\s\S]*)\n--- page-skeleton receipt end ---/,
  );
  if (!match?.[1]) throw new Error(`No receipt in: ${hint}`);
  return `${match[1]}\n`;
};

test("a printed receipt only passes once committed as the card's own record", () => {
  const actual = { ...pixels(a), [list]: b };
  const hint = receiptHint({ seed }, actual, "C-9");
  expect(hint).toContain(
    "save the receipt between the markers as apps/web/test-support/page-skeleton-approvals/C-9.json",
  );
  // Printing a receipt does not approve it: without the file the check still fails.
  expect(Object.keys(compare({ seed }, actual)).sort()).toEqual(
    [board, list].sort(),
  );
  const receipt = JSON.parse(receiptIn(hint));
  expect(receipt).toEqual(compare({ seed }, actual));
  expect(compare({ seed, "C-9": receipt }, actual)).toEqual({});
  // The receipt matches only these pixels.
  expect(compare({ seed, "C-9": receipt }, pixels(c))).not.toEqual({});
});

test("a reworked card's receipt replaces its own earlier record", () => {
  const first = compare({ seed }, pixels(a));
  const hint = receiptHint({ seed, "C-9": first }, pixels(b), "C-9");
  const rework = JSON.parse(receiptIn(hint));
  expect(rework).toEqual(compare({ seed }, pixels(b)));
  expect(compare({ seed, "C-9": rework }, pixels(b))).toEqual({});
  // Restoring the original pixels means the card needs no receipt.
  expect(receiptHint({ seed, "C-9": first }, baseline, "C-9")).toContain(
    "delete apps/web/test-support/page-skeleton-approvals/C-9.json",
  );
  // Without a valid card name the receipt is computed against every record.
  for (const card of [undefined, "", "C-0", "../C-9", "C-9 "])
    expect(receiptHint({ seed }, pixels(a), card)).toContain(
      "page-skeleton-approvals/C-<card>.json",
    );
  expect(receiptHint({ seed }, {}, "C-9")).toBe(
    "No page-skeleton receipt can be derived: Incomplete capture",
  );
});

test("the printed receipt reproduces a committed receipt byte for byte", () => {
  const dir = new URL(
    "../../test-support/page-skeleton-approvals/",
    import.meta.url,
  );
  const files = readdirSync(dir).filter((file) => file.endsWith(".json"));
  const committed = Object.fromEntries(
    files.map((file) => [
      file.slice(0, -5),
      JSON.parse(readFileSync(new URL(file, dir), "utf8")),
    ]),
  );
  // Recover the pixels main currently approves from the receipts themselves.
  const approved: Record<string, string> = { ...baseline };
  const candidates = new Map(
    scenes.map((scene) => [
      scene,
      Object.values(committed).map(
        (receipt) =>
          (receipt[scene]?.hash ?? receipt[scene]) as string | undefined,
      ),
    ]),
  );
  for (const scene of Object.keys(compare(committed, approved)))
    approved[scene] =
      candidates
        .get(scene)
        ?.find(
          (hash) =>
            hash &&
            !(scene in compare(committed, { ...approved, [scene]: hash })),
        ) ?? "";
  expect(compare(committed, approved)).toEqual({});
  // Every receipt no other record builds upon can be regenerated exactly.
  const latest = files.filter((file) => {
    const card = file.slice(0, -5);
    if (card === "seed") return false;
    const rest = { ...committed };
    delete rest[card];
    try {
      compare(rest, approved);
      return true;
    } catch {
      return false;
    }
  });
  expect(latest).toContain("C-695.json");
  for (const file of latest) {
    const card = file.slice(0, -5);
    expect(
      receiptIn(receiptHint(committed, approved, card)),
      `${card} must be reproducible`,
    ).toBe(readFileSync(new URL(file, dir), "utf8"));
  }
});
