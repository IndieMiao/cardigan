import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  Assignment,
  Card,
  ProjectId,
  Role,
  WorkItem,
} from "@cardigan/domain";
import { RepositoryLockTimeoutError } from "@cardigan/git-service";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  acquireRepositoryFlock,
  hostRepositoryLock,
  repositoryLockPath,
} from "./repository-lock.js";
import { worktreeProvider } from "./worktree.js";

const exec = promisify(execFile);
const git = async (path: string, ...args: string[]) =>
  (
    await exec(
      "git",
      [
        "-C",
        path,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { timeout: 20_000 },
    )
  ).stdout.trim();

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cardigan-repo-lock-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe.runIf(process.platform === "linux")("flock layer", () => {
  test("a second holder waits at most its budget, then gets the lock after release", async () => {
    const path = repositoryLockPath(join(root, "data"), "p");
    const release = await acquireRepositoryFlock(path, 1_000);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const started = Date.now();
    await expect(acquireRepositoryFlock(path, 200)).rejects.toBeInstanceOf(
      RepositoryLockTimeoutError,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    await release();
    const again = await acquireRepositoryFlock(path, 1_000);
    await again();
  });

  test("an unexpected flock exit is not reported as a timeout", async () => {
    const path = repositoryLockPath(join(root, "data"), "p");
    await expect(
      acquireRepositoryFlock(path, 100, async () => 64),
    ).rejects.toThrow("flock exited with 64");
  });

  test("the host lock times out against a holder in another process slot", async () => {
    const dataDir = join(root, "data");
    const held = await acquireRepositoryFlock(
      repositoryLockPath(dataDir, "p"),
      1_000,
    );
    try {
      await expect(
        hostRepositoryLock(dataDir, { waitMs: 200 })(
          { project_id: "p", repository: join(root, "repos", "p") },
          async () => "never",
        ),
      ).rejects.toMatchObject({ code: "repository_lock_timeout" });
    } finally {
      await held();
    }
  });
});

test("rejects a project id that is not a path component", () => {
  expect(() => repositoryLockPath("/data", "../x")).toThrow(/Invalid/);
});

const project = "proj" as ProjectId;
const role = {
  role_id: "coder",
  version: 1,
  worktree: "write",
} as Role;
const card = {
  id: "C-1",
  project_id: project,
  repo: "example/repo",
  base_branch: "main",
} as Card;
const writer = (n: number) => {
  const assignment = {
    id: `A-${n}`,
    scope: "work_item",
    work_item_id: `W-${n}`,
    role_id: "coder",
    role_version: 1,
    status: "active",
    runtime_state: "not_provisioned",
    machine_id: "local",
    runtime_ref: null,
    mcp_token_id: "fixture",
    created_at: "2026-01-01T00:00:00Z",
  } as unknown as Assignment;
  const work_item = {
    id: `W-${n}`,
    card_id: "C-1",
    assignment_id: `A-${n}`,
  } as WorkItem;
  return { assignment, work_item };
};

test("several Assignments of one project prepare and refresh worktrees concurrently on a real repository", async () => {
  const source = join(root, "source"),
    dataDir = join(root, "data");
  await mkdir(source, { recursive: true });
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await git(source, "init", "-b", "main");
  await writeFile(join(source, "README.md"), "one\n");
  await git(source, "add", "README.md");
  await git(source, "commit", "-m", "initial");
  const provide = worktreeProvider(
    { mode: "local", dataDir },
    {} as Parameters<typeof worktreeProvider>[1],
  );
  const writers = [1, 2, 3, 4, 5].map(writer);
  const prepare = (w: ReturnType<typeof writer>, placed?: string) =>
    provide({
      project_id: project,
      source_repo: source,
      assignment: placed
        ? {
            ...w.assignment,
            worktree_path: placed,
            branch: `agent/C-1/${w.work_item.id}`,
          }
        : w.assignment,
      role,
      card,
      work_item: w.work_item,
    });
  // First start: every Assignment adds its worktree to the shared clone.
  const created = await Promise.all(writers.map((w) => prepare(w)));
  expect(created.every((p) => p?.baseline?.ref === "origin/main")).toBe(true);
  // Wake: every live session refreshes the same base clone at once. Another
  // host process (simulated by holding the project flock) blocks all of them.
  const held =
    process.platform === "linux"
      ? await acquireRepositoryFlock(
          repositoryLockPath(dataDir, project),
          1_000,
        )
      : undefined;
  let settled = 0;
  const waking = Promise.all(
    writers.map((w, i) =>
      prepare(w, created[i]?.path).finally(() => {
        settled += 1;
      }),
    ),
  );
  if (held) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(0);
    await held();
  }
  const woken = await waking;
  expect(woken.map((p) => p?.path)).toEqual(created.map((p) => p?.path));
  expect(new Set(woken.map((p) => p?.baseline?.sha)).size).toBe(1);
  const listed = await git(
    join(dataDir, "agent", "repos", project),
    "worktree",
    "list",
    "--porcelain",
  );
  for (const w of writers)
    expect(listed).toContain(`branch refs/heads/agent/C-1/${w.work_item.id}`);
}, 60_000);
