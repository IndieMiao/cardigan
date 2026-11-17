import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { centralFixture, git } from "../test-support/git.js";

/** P2a-13 A1: read-only tree access in the center, full commit SHAs only. */
let f: Awaited<ReturnType<typeof centralFixture>>;
let repo: string;
let next: string;
beforeEach(async () => {
  f = await centralFixture();
  await mkdir(join(f.source, "packages", "a"), { recursive: true });
  await mkdir(join(f.source, "docs"), { recursive: true });
  await writeFile(join(f.source, "packages", "a", "package.json"), "{}\n");
  await writeFile(join(f.source, "docs", "with space.md"), "x\n");
  await symlink("/etc/hostname", join(f.source, "packages", "a", "link.json"));
  await git(f.source, "add", "-A");
  await git(f.source, "commit", "-m", "tree");
  next = await git(f.source, "rev-parse", "HEAD");
  repo = await f.central.ensureCentral(f.project);
});
afterEach(() => f.close());

test("changedPaths lists every changed path between two full commit SHAs", async () => {
  expect(await f.transport.changedPaths(repo, f.initial, next)).toEqual([
    "docs/with space.md",
    "packages/a/link.json",
    "packages/a/package.json",
  ]);
  expect(await f.transport.changedPaths(repo, next, next)).toEqual([]);
});

test("refs, short SHAs and tree ids are refused", async () => {
  const tree = await git(repo, "rev-parse", `${next}^{tree}`);
  for (const bad of ["main", "HEAD", next.slice(0, 12), tree, `${next}~1`]) {
    await expect(
      f.transport.changedPaths(repo, f.initial, bad),
    ).rejects.toThrow(/full commit SHA/);
    await expect(f.transport.changedPaths(repo, bad, next)).rejects.toThrow(
      /full commit SHA/,
    );
    await expect(f.transport.listTree(repo, bad, "")).rejects.toThrow(
      /full commit SHA/,
    );
    await expect(
      f.transport.readTreeFile(repo, bad, "packages/a/package.json"),
    ).rejects.toThrow(/full commit SHA/);
  }
});

test("listTree and readTreeFile read only the commit's tree", async () => {
  expect(
    (await f.transport.listTree(repo, next, "")).map((e) => [e.type, e.path]),
  ).toEqual([
    ["tree", "docs"],
    ["blob", "file"],
    ["tree", "packages"],
  ]);
  expect(
    (await f.transport.listTree(repo, next, "packages")).map((e) => [
      e.type,
      e.path,
    ]),
  ).toEqual([["tree", "packages/a"]]);
  expect(await f.transport.listTree(repo, next, "missing")).toEqual([]);
  expect(
    await f.transport.readTreeFile(repo, next, "packages/a/package.json"),
  ).toBe("{}");
  // Absent at the older commit even though present at the newer one.
  expect(
    await f.transport.readTreeFile(repo, f.initial, "packages/a/package.json"),
  ).toBeUndefined();
  // A symlink is never followed, and directories are not files.
  await expect(
    f.transport.readTreeFile(repo, next, "packages/a/link.json"),
  ).rejects.toThrow(/not a regular file/);
  await expect(
    f.transport.readTreeFile(repo, next, "packages/a"),
  ).rejects.toThrow(/not a regular file/);
});

test("tree paths are literal and cannot escape", async () => {
  for (const bad of [
    "",
    "/etc/passwd",
    "../x",
    "packages/../x",
    "packages//a",
    "./x",
    "a\nb",
  ])
    await expect(f.transport.readTreeFile(repo, next, bad)).rejects.toThrow(
      /Invalid tree path/,
    );
  // Pathspec magic is not interpreted.
  expect(
    await f.transport.readTreeFile(
      repo,
      next,
      ":(glob)packages/*/package.json",
    ),
  ).toBeUndefined();
  expect(await f.transport.listTree(repo, next, "pack*")).toEqual([]);
});
