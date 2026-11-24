/**
 * C-728: a no-merge card's producer gets a detached worktree at its start
 * point. Real Git; the service is assembled like the host assembles it.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Assignment, Card, Role, WorkItem } from "@cardigan/domain";
import {
  CentralRepositoryService,
  type EnsureWorktreeInput,
  GitWorktreeService,
} from "@cardigan/git-service";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CentralGitTransport, LocalGitTransport } from "./index.js";

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
      { timeout: 20000 },
    )
  ).stdout.trim();

async function commit(repo: string, file: string, body: string) {
  await writeFile(join(repo, file), body);
  await git(repo, "add", file);
  await git(repo, "commit", "-qm", file);
  return git(repo, "rev-parse", "HEAD");
}

let root: string, source: string, data: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cardigan-start-point-"));
  source = join(root, "source");
  data = join(root, "data");
  await mkdir(source);
  await git(source, "init", "-qb", "main");
  await commit(source, "README.md", "main\n");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const service = () =>
  new GitWorktreeService(
    new LocalGitTransport(),
    new CentralRepositoryService(new CentralGitTransport({ dataDir: data }), {
      dataDir: data,
    }),
    { dataDir: data },
  );

function input(
  n: number,
  card: Partial<Card>,
  item: Partial<WorkItem> = {},
): EnsureWorktreeInput {
  const a = `A-${n}`,
    w = `W-${n}`;
  return {
    project_id: "p",
    source_repo: source,
    card: {
      id: "C-1",
      project_id: "p",
      title: "Release",
      goal: "Package",
      acceptance_criteria: [],
      source: { kind: "quote", text: "release" },
      out_of_scope: [],
      related_cards: [],
      repo: source,
      base_branch: "main",
      priority: 1,
      status: "todo",
      template: "dev",
      created_by: "human",
      created_at: "2026-01-01T00:00:00Z",
      merge_policy: "none",
      ...card,
    } as Card,
    work_item: {
      id: w,
      card_id: "C-1",
      title: "Package",
      kind: "produce",
      role_id: "coder",
      required: true,
      depends_on: [],
      completion_criteria: [],
      assignment_id: a,
      status: "todo",
      ...item,
    } as WorkItem,
    assignment: {
      id: a,
      scope: "work_item",
      work_item_id: w,
      role_id: "coder",
      role_version: 1,
      status: "active",
      runtime_state: "not_provisioned",
      machine_id: "local",
      runtime_ref: null,
      mcp_token_id: "fixture",
      created_at: "2026-01-01T00:00:00Z",
    } as Assignment,
    role: {
      role_id: "coder",
      version: 1,
      worktree: "write",
      required_machine_tags: [],
    } as unknown as Role,
  };
}
const centralPath = () => join(data, "central", "p.git");

test("a commit only the source has is synced, pinned and checked out detached", async () => {
  // The central repository exists before the release commit is made.
  const first = await service().ensureWorktree(input(1, {}));
  expect(first?.branch).toBe("agent/C-1/W-1");
  await git(source, "checkout", "-qb", "release");
  const release = await commit(source, "VERSION", "0.4.2\n");
  await git(source, "checkout", "-q", "main");
  await expect(git(centralPath(), "cat-file", "-t", release)).rejects.toThrow();

  const placed = await service().ensureWorktree(
    input(2, { start_point: release }),
  );
  const path = join(data, "agent", "worktrees", "p", "A-2");
  expect(placed).toEqual({
    worktree_path: path,
    base_sha: release,
    start_point: { point: release, sha: release },
  });
  expect(await git(path, "rev-parse", "HEAD")).toBe(release);
  await expect(git(path, "symbolic-ref", "-q", "HEAD")).rejects.toThrow();
  expect(await readFile(join(path, "VERSION"), "utf8")).toBe("0.4.2\n");
  // The host pinned it where base clones already receive candidates.
  expect(
    await git(centralPath(), "rev-parse", "refs/cardigan/candidates/start/A-2"),
  ).toBe(release);
  expect(
    await git(
      join(data, "agent", "repos", "p"),
      "rev-parse",
      "refs/cardigan/candidates/start/A-2",
    ),
  ).toBe(release);

  // A later Run reuses the checkout untouched, even after the source moves.
  await writeFile(join(path, "build.log"), "local\n");
  await git(source, "checkout", "-q", "release");
  await commit(source, "NEXT", "x\n");
  expect(
    await service().ensureWorktree({
      ...input(2, { start_point: release }),
      assignment: {
        ...input(2, {}).assignment,
        worktree_path: path,
        base_sha: release,
      },
    }),
  ).toEqual(placed);
  expect(await git(path, "rev-parse", "HEAD")).toBe(release);
  expect(await readFile(join(path, "build.log"), "utf8")).toBe("local\n");
});

test("a branch start point resolves through the source, and the work item's own wins", async () => {
  await git(source, "checkout", "-qb", "release/0.4");
  const tip = await commit(source, "VERSION", "0.4\n");
  await git(source, "checkout", "-q", "main");
  const placed = await service().ensureWorktree(
    input(3, { start_point: "main" }, { start_point: "release/0.4" }),
  );
  expect(placed?.start_point).toEqual({ point: "release/0.4", sha: tip });
  expect(placed?.branch).toBeUndefined();
  expect(
    await git(
      join(data, "agent", "worktrees", "p", "A-3"),
      "rev-parse",
      "HEAD",
    ),
  ).toBe(tip);
});

test("an unknown start point fails preparation without a worktree", async () => {
  await expect(
    service().ensureWorktree(input(4, { start_point: "f".repeat(40) })),
  ).rejects.toThrow(/neither the central repository nor the source/u);
  await expect(
    service().ensureWorktree(input(5, { start_point: "no-such-branch" })),
  ).rejects.toThrow(/no-such-branch/u);
  await expect(
    git(source, "rev-parse", "--verify", "-q", "refs/heads/no-such-branch"),
  ).rejects.toThrow();
});

test("merge cards keep their branch worktree from the baseline", async () => {
  const main = await git(source, "rev-parse", "main");
  await git(source, "checkout", "-qb", "release");
  const release = await commit(source, "VERSION", "1\n");
  for (const [n, merge_policy] of [
    [6, "confirm"],
    [7, "auto"],
    [8, undefined],
  ] as const) {
    const placed = await service().ensureWorktree(
      input(n, { merge_policy, start_point: release }),
    );
    expect(placed).toMatchObject({
      branch: `agent/C-1/W-${n}`,
      base_sha: main,
    });
    expect(placed).not.toHaveProperty("start_point");
  }
});
