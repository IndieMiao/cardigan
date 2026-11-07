import {
  lstat,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { Assignment } from "@cardigan/domain";
import { type CentralProject, GitWorktreeService } from "@cardigan/git-service";
import { afterEach, beforeEach, expect, test } from "vitest";
import { centralFixture, git } from "../test-support/git.js";
import { LocalGitTransport } from "./index.js";

/**
 * M4.3 §3.6: a worktree is deleted only when nothing would be lost. Unpushed
 * commits are backed up first, a dirty tree needs a human decision, and a forced
 * clean writes the patch to the host's own directory before deleting.
 */
let f: Awaited<ReturnType<typeof centralFixture>>,
  project: CentralProject,
  repo: string,
  base: string,
  work: string,
  assignment: Assignment,
  service: GitWorktreeService;

const assignmentFor = (path: string, extra: Partial<Assignment> = {}) =>
  ({
    id: "A-1" as never,
    scope: "work_item",
    work_item_id: "W-1" as never,
    role_id: "coder",
    role_version: 1,
    status: "active",
    runtime_state: "not_provisioned",
    runtime_ref: null,
    machine_id: "local",
    mcp_token_id: "reserved",
    created_at: "2030-01-01T00:00:00.000Z",
    branch: "agent/C-1/W-1",
    worktree_path: path,
    base_sha: f.initial,
    ...extra,
  }) as Assignment;

beforeEach(async () => {
  f = await centralFixture();
  project = f.project;
  repo = await f.central.ensureCentral(project);
  const local = new LocalGitTransport();
  base = join(f.dataDir, "agent", "repos", project.project_id);
  work = join(f.dataDir, "agent", "worktrees", project.project_id, "A-1");
  await local.ensureClone(repo, base);
  await local.addWorktree(base, work, f.initial, "agent/C-1/W-1");
  service = new GitWorktreeService(local, f.central, { dataDir: f.dataDir });
  assignment = assignmentFor(work);
});
afterEach(async () => {
  await f.close();
});

const patches = async () => {
  const directory = join(f.dataDir, "cleanup", project.project_id);
  return readdir(directory).then(
    (names) => names.map((name) => join(directory, name)),
    () => [],
  );
};

test("a clean worktree whose commits reached the center is removed with its branch", async () => {
  const outcome = await service.removeWorktree({
    project,
    assignment,
    force: false,
  });

  expect(outcome).toEqual({ status: "removed", head_sha: f.initial });
  await expect(lstat(work)).rejects.toThrow();
  // S18: the last Assignment must not leave an empty project directory.
  await expect(lstat(join(work, ".."))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await git(base, "for-each-ref", "refs/heads/agent/")).toBe("");
  expect(await patches()).toEqual([]);
  // The backup ref exists even when there was nothing to save.
  expect(
    await f.transport.readRef(
      repo,
      "refs/cardigan/backups/local/agent/C-1/W-1",
    ),
  ).toBe(f.initial);
});

test("uncommitted tracked changes need a decision and the worktree is kept", async () => {
  await writeFile(join(work, "file"), "uncommitted");

  const outcome = await service.removeWorktree({
    project,
    assignment,
    force: false,
  });

  expect(outcome).toMatchObject({
    status: "needs_decision",
    summary: {
      worktree_path: work,
      branch: "agent/C-1/W-1",
      tracked: ["file"],
      untracked: [],
      reachable: true,
    },
  });
  expect(await readFile(join(work, "file"), "utf8")).toBe("uncommitted");
  expect(await git(base, "for-each-ref", "refs/heads/agent/")).not.toBe("");
  expect(await patches()).toEqual([]);
});

test.each([false, true])(
  "untracked writer files need a decision even when temporarily detached (%s)",
  async (detached) => {
    if (detached) await git(work, "checkout", "--detach");
    await writeFile(join(work, "notes.txt"), "keep me");
    const outcome = await service.removeWorktree({
      project,
      assignment,
      force: false,
    });
    expect(outcome).toMatchObject({
      status: "needs_decision",
      summary: { tracked: [], untracked: ["notes.txt"] },
    });
    expect(await readFile(join(work, "notes.txt"), "utf8")).toBe("keep me");
  },
);

test("S18 completes Git removal when the Agent leaves an empty host-owned leaf", async () => {
  class PartialRemoval extends LocalGitTransport {
    override async removeWorktree(
      repository: string,
      path: string,
      options: { readonly force: boolean },
    ) {
      await super.removeWorktree(repository, path, options);
      await mkdir(path);
      throw new Error("Agent cannot remove host-owned namespace entry");
    }
  }
  const cleanup = new GitWorktreeService(new PartialRemoval(), f.central, {
    dataDir: f.dataDir,
  });
  await expect(
    cleanup.removeWorktree({ project, assignment, force: false }),
  ).resolves.toMatchObject({ status: "removed" });
  await expect(lstat(work)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(join(work, ".."))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test.each([false, true])(
  "S12 readonly caches are disposable but tracked edits are protected (tracked=%s)",
  async (tracked) => {
    await git(work, "checkout", "--detach");
    const review = assignmentFor(work, {
      branch: undefined,
      role_id: "reviewer",
    });
    await mkdir(join(work, "__pycache__"));
    await writeFile(join(work, "__pycache__", "review.pyc"), "cache");
    if (tracked) await writeFile(join(work, "file"), "review edits");
    const result = await service.removeWorktree({
      project,
      assignment: review,
      force: false,
    });
    expect(result.status).toBe(tracked ? "needs_decision" : "removed");
    if (tracked)
      expect(await readFile(join(work, "file"), "utf8")).toBe("review edits");
    else {
      await expect(lstat(work)).rejects.toThrow();
      expect(await patches()).toEqual([]);
    }
  },
);

test("S18 removes a known empty leftover without deleting a nonempty sibling", async () => {
  await new LocalGitTransport().removeWorktree(base, work, { force: true });
  await mkdir(work);
  const sibling = join(work, "..", "A-2");
  await mkdir(sibling);
  await writeFile(join(sibling, "keep"), "keep");
  await expect(
    service.removeWorktree({ project, assignment, force: false }),
  ).resolves.toMatchObject({ status: "already_removed" });
  await expect(lstat(work)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(sibling, "keep"), "utf8")).toBe("keep");
});

test("S18 never recursively deletes a nonempty unregistered worktree", async () => {
  await new LocalGitTransport().removeWorktree(base, work, { force: true });
  await mkdir(work);
  await writeFile(join(work, "keep"), "preserved");
  await expect(
    service.removeWorktree({ project, assignment, force: true }),
  ).rejects.toThrow();
  expect(await readFile(join(work, "keep"), "utf8")).toBe("preserved");
});

test("a commit the central repository does not have needs a decision", async () => {
  // A detached worktree commit is on no agent/* branch, so the backup misses it.
  const detached = join(
    f.dataDir,
    "agent",
    "worktrees",
    project.project_id,
    "A-2",
  );
  await new LocalGitTransport().addWorktree(base, detached, f.initial);
  await writeFile(join(detached, "file"), "detached work");
  await git(detached, "commit", "-am", "detached commit");
  const head = await git(detached, "rev-parse", "HEAD");

  const outcome = await service.removeWorktree({
    project,
    assignment: assignmentFor(detached, {
      id: "A-2" as never,
      branch: undefined,
    }),
    force: false,
  });

  expect(outcome).toMatchObject({
    status: "needs_decision",
    summary: { head_sha: head, reachable: false },
  });
  expect(await git(detached, "rev-parse", "HEAD")).toBe(head);
});

test("a forced clean writes the patch and untracked list before deleting", async () => {
  await writeFile(join(work, "file"), "forced change");
  await writeFile(join(work, "notes.txt"), "keep me");
  const audit = await service.diffWorktree({ project, assignment });
  expect(audit).toMatchObject({
    tracked: ["file"],
    untracked: ["notes.txt"],
    reachable: true,
  });
  expect(audit.patch).toContain("-initial");
  expect(audit.patch).toContain("+forced change");

  const outcome = await service.removeWorktree({
    project,
    assignment,
    force: true,
  });

  expect(outcome.status).toBe("removed");
  if (outcome.status !== "removed") throw new Error("not removed");
  expect(outcome.head_sha).toBe(f.initial);
  const patchPath = outcome.patch_path;
  if (patchPath === undefined) throw new Error("missing patch");
  expect(patchPath.startsWith(join(f.dataDir, "cleanup"))).toBe(true);
  expect((await stat(patchPath)).mode & 0o777).toBe(0o600);
  const patch = await readFile(patchPath, "utf8");
  expect(patch).toContain(`# assignment: ${assignment.id}`);
  expect(patch).toContain("#   notes.txt");
  expect(patch).toContain("+forced change");
  await expect(lstat(work)).rejects.toThrow();
  expect(await git(base, "for-each-ref", "refs/heads/agent/")).toBe("");
});

test("a forced clean of a clean worktree writes no patch", async () => {
  const outcome = await service.removeWorktree({
    project,
    assignment,
    force: true,
  });
  expect(outcome).toEqual({ status: "removed", head_sha: f.initial });
  expect(await patches()).toEqual([]);
});

test("rejects unsafe or unrecorded worktree locations", async () => {
  const remove = (value: Assignment, target = project) =>
    service.removeWorktree({ project: target, assignment: value, force: true });
  await expect(
    remove(assignmentFor(work), { ...project, project_id: "../escape" }),
  ).rejects.toThrow(/path component/);
  await expect(
    remove(assignmentFor(work, { scope: "standing" } as never)),
  ).rejects.toThrow(/work-item/);
  await expect(remove(assignmentFor("relative/path"))).rejects.toThrow(
    /absolute/,
  );
  await expect(
    remove(
      assignmentFor(join(f.dataDir, "agent", "worktrees", "other", "A-1")),
    ),
  ).rejects.toThrow(/outside its project root/);
  expect(await readdir(work)).not.toHaveLength(0);
});

test("the cleanup root is configurable", async () => {
  const audit = join(f.root, "audit");
  const custom = new GitWorktreeService(new LocalGitTransport(), f.central, {
    dataDir: f.dataDir,
    cleanupRoot: audit,
  });
  await writeFile(join(work, "file"), "changed");
  const outcome = await custom.removeWorktree({
    project,
    assignment,
    force: true,
  });
  if (outcome.status !== "removed" || outcome.patch_path === undefined)
    throw new Error("expected a forced clean with a patch");
  expect(outcome.patch_path.startsWith(audit)).toBe(true);
  expect((await stat(outcome.patch_path)).mode & 0o777).toBe(0o600);
});
