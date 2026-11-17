import type {
  Assignment,
  Card,
  GitWorktreePort,
  Role,
  WorkItem,
} from "@cardigan/domain";
import { expect, test, vi } from "vitest";
import { type CentralRepositoryService, GitWorktreeService } from "./index.js";

const original = "a".repeat(40),
  head = "b".repeat(40),
  latest = "c".repeat(40);
const path = "/fixture/worktrees/project/A-1",
  branch = "agent/C-1/W-1";
const input = {
  project_id: "project",
  source_repo: "/fixture/source",
  assignment: {
    id: "A-1",
    status: "active",
    machine_id: "local",
    role_id: "coder",
    role_version: 1,
    scope: "work_item",
    work_item_id: "W-1",
    worktree_path: path,
    branch,
    base_sha: original,
  } as Assignment,
  role: { role_id: "coder", version: 1, worktree: "write" } as Role,
  card: {
    id: "C-1",
    project_id: "project",
    repo: "/fixture/source",
    base_branch: "main",
  } as Card,
  work_item: { id: "W-1", card_id: "C-1", assignment_id: "A-1" } as WorkItem,
};
function fixture() {
  const git = {
    ensureClone: vi.fn(),
    listWorktrees: vi.fn(async () => [{ path, branch, head }]),
    fetch: vi.fn(),
    resolveCommit: vi.fn(async () => latest),
    addWorktree: vi.fn(),
    checkoutDetached: vi.fn(),
    changes: vi.fn(),
  };
  const central = {
    ensureCentral: vi.fn(async () => "/fixture/central.git"),
    syncFromSource: vi.fn(),
  };
  const service = new GitWorktreeService(
    git as unknown as GitWorktreePort,
    central as unknown as CentralRepositoryService,
    { dataDir: "/fixture", worktreesRoot: "/fixture/worktrees" },
  );
  return { service, git, central };
}

test("reusing a writer refreshes the remote baseline each time without moving its HEAD or original base", async () => {
  const { service, git, central } = fixture();
  for (let i = 0; i < 2; i++) {
    expect(await service.ensureWorktree(input)).toEqual({
      worktree_path: path,
      branch,
      base_sha: original,
      baseline: { ref: "origin/main", sha: latest },
    });
  }
  expect(git.fetch).toHaveBeenCalledTimes(2);
  expect(git.fetch).toHaveBeenCalledWith(
    "/fixture/agent/repos/project",
    "/fixture/central.git",
  );
  expect(git.resolveCommit).toHaveBeenCalledWith(
    "/fixture/agent/repos/project",
    "refs/remotes/origin/main",
  );
  expect(central.syncFromSource).not.toHaveBeenCalled();
  for (const operation of [git.addWorktree, git.checkoutDetached, git.changes])
    expect(operation).not.toHaveBeenCalled();
});

test("a failed baseline transfer rejects placement before launch", async () => {
  const { service, git } = fixture();
  git.fetch.mockRejectedValueOnce(new Error("baseline transfer failed"));
  await expect(service.ensureWorktree(input)).rejects.toThrow(
    "baseline transfer failed",
  );
  expect(git.resolveCommit).not.toHaveBeenCalled();
  expect(git.checkoutDetached).not.toHaveBeenCalled();
});

test("concurrent wakes of one project never overlap their base-clone fetches", async () => {
  const { service, git } = fixture();
  let active = 0,
    peak = 0;
  git.fetch.mockImplementation(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  });
  const results = await Promise.all(
    [1, 2, 3, 4].map(() => service.ensureWorktree(input)),
  );
  expect(results.every((r) => r?.baseline?.sha === latest)).toBe(true);
  expect(git.fetch).toHaveBeenCalledTimes(4);
  expect(peak).toBe(1);
});

test("an injected lock binds placement to the machine, project and base clone", async () => {
  const git = fixture().git;
  const lock = vi.fn(
    async <T>(_key: unknown, work: () => Promise<T>): Promise<T> => work(),
  );
  const service = new GitWorktreeService(
    git as unknown as GitWorktreePort,
    {
      ensureCentral: vi.fn(async () => "/fixture/central.git"),
    } as unknown as CentralRepositoryService,
    { dataDir: "/fixture", worktreesRoot: "/fixture/worktrees", lock },
  );
  await service.ensureWorktree(input);
  expect(lock).toHaveBeenCalledWith(
    {
      machine_id: "local",
      project_id: "project",
      repository: "/fixture/agent/repos/project",
    },
    expect.any(Function),
  );
});
