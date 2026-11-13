import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { piTrustedWorktreePath } from "./pi-trust.js";

let root: string;
beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), "cardigan-pi-trust-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** What pi 1.4 looks up: canonicalizePath(resolvePath(process.cwd())). */
function piLookupKey(dir: string): string {
  const child = spawnSync(
    process.execPath,
    ["-e", "process.stdout.write(process.cwd())"],
    { cwd: dir, encoding: "utf8" },
  );
  expect(child.status).toBe(0);
  return realpathSync(resolve(child.stdout));
}

test("C-235 a worktree under a symlinked ancestor is keyed by the path pi looks up", async () => {
  const real = join(root, "data", "worktrees", "p-demo");
  await mkdir(join(real, "A-1"), { recursive: true });
  await symlink(join(root, "data"), join(root, "srv"));
  const configured = join(root, "srv", "worktrees", "p-demo", "A-1");

  const key = await piTrustedWorktreePath(configured);
  expect(key).toBe(join(real, "A-1"));
  expect(key).not.toBe(configured);
  expect(key).toBe(piLookupKey(configured));
});

test("C-235 a plain worktree keeps its own path", async () => {
  const worktree = join(root, "worktrees", "A-1");
  await mkdir(worktree, { recursive: true });
  expect(await piTrustedWorktreePath(worktree)).toBe(worktree);
  expect(await piTrustedWorktreePath(`${worktree}/`)).toBe(worktree);
  expect(piLookupKey(worktree)).toBe(worktree);
});

test("C-235 a symlinked worktree leaf is never trusted, wherever it points", async () => {
  const worktrees = join(root, "worktrees");
  const otherRepo = join(root, "repos", "other");
  await mkdir(worktrees, { recursive: true });
  await mkdir(otherRepo, { recursive: true });
  await mkdir(join(worktrees, "A-real"));
  // Leaf links: to its parent folder, to the filesystem root, to another
  // repository, and even to a sibling worktree. None is the folder Cardigan
  // created, so none gets pre-trust (pi shows its prompt instead).
  for (const [name, target] of [
    ["A-parent", worktrees],
    ["A-root", "/"],
    ["A-other", otherRepo],
    ["A-sibling", join(worktrees, "A-real")],
    ["A-relative", ".."],
  ] as const) {
    await symlink(target, join(worktrees, name));
    expect(await piTrustedWorktreePath(join(worktrees, name))).toBeUndefined();
  }
});

test("C-235 unusable worktree paths get no pre-trust (fail closed)", async () => {
  const file = join(root, "file");
  await writeFile(file, "");
  await symlink(join(root, "missing"), join(root, "dangling"));
  for (const path of [
    join(root, "missing"),
    join(root, "dangling"),
    file,
    "relative/A-1",
    "/",
  ])
    expect(await piTrustedWorktreePath(path)).toBeUndefined();
});
