import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Assignment, Delivery } from "@cardigan/domain";
import { type CentralProject, GitWorktreeService } from "@cardigan/git-service";
import { afterEach, beforeEach, expect, test } from "vitest";
import { centralFixture, commit, git } from "../test-support/git.js";
import { LocalGitTransport } from "./index.js";

/**
 * M4.3 §3.6 reconciliation: compare Git's worktree registrations, the real
 * directories, the database and the pinned delivery refs. Findings are reports;
 * nothing here deletes, prunes or moves a ref.
 */
let f: Awaited<ReturnType<typeof centralFixture>>,
  project: CentralProject,
  repo: string,
  base: string,
  work: string,
  service: GitWorktreeService;

const assignmentFor = (path: string, extra: Record<string, unknown> = {}) =>
  ({
    id: "A-1",
    scope: "work_item",
    work_item_id: "W-1",
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
  }) as unknown as Assignment;
const deliveryFor = (id: string, value: string): Delivery =>
  ({
    id,
    work_item_id: "W-1",
    run_id: "R-1",
    kind: "code",
    summary: "fixture",
    subject: { kind: "git_head", value },
    evidence: [],
    attachments: [],
    known_gaps: [],
    requested_verifiers: [],
    status: "accepted",
  }) as unknown as Delivery;

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
});
afterEach(async () => {
  await f.close();
});

test("reconcile reports every finding and deletes nothing", async () => {
  // An owned worktree (A-1), an orphan directory, a stale registration (A-2
  // registered but deleted), a missing worktree (A-3), a failed staging clone,
  // one pinned and one unpinned delivery, and a diverged source.
  const orphan = join(
    f.dataDir,
    "agent",
    "worktrees",
    project.project_id,
    "A-9",
  );
  const stale = join(
    f.dataDir,
    "agent",
    "worktrees",
    project.project_id,
    "A-2",
  );
  const failed = join(f.dataDir, "agent", "repos", ".clone-failed");
  await mkdir(orphan);
  await mkdir(failed);
  const local = new LocalGitTransport();
  await local.addWorktree(base, stale, f.initial, "agent/C-2/W-2");
  await rm(stale, { recursive: true });
  const first = await commit(work, "delivered");
  await f.transport.fetchRefs(repo, work, [
    `+refs/heads/agent/C-1/W-1:refs/cardigan/candidates/A-1/${first}`,
  ]);
  await f.central.pinDelivery(project, "D-1", first);
  await f.transport.fetchRefs(repo, work, [
    "+refs/heads/agent/C-1/W-1:refs/heads/main",
  ]);
  await commit(f.source, "source moved on");
  const registeredBefore = await git(base, "for-each-ref");

  const state = await service.listWorktreeState(project);
  expect(state.source_sync).toBe("diverged");
  expect(state.pinned).toEqual([{ delivery_id: "D-1", sha: first }]);
  expect(state.failed_clones).toEqual([failed]);

  const findings = await service.reconcile(
    project,
    [
      assignmentFor(work),
      // A released Assignment still owns its path, so the stale registration is
      // reported once (not also as an orphan).
      assignmentFor(stale, {
        id: "A-2",
        status: "released",
        branch: "agent/C-2/W-2",
      }),
      assignmentFor(
        join(f.dataDir, "agent", "worktrees", project.project_id, "A-3"),
        { id: "A-3" },
      ),
    ],
    [deliveryFor("D-1", first), deliveryFor("D-2", first)],
  );

  expect(findings.map((finding) => finding.kind).sort()).toEqual([
    "failed_clone",
    "missing_delivery_ref",
    "missing_worktree",
    "orphan_worktree",
    "source_diverged",
    "stale_registration",
  ]);
  expect(findings).toContainEqual(
    expect.objectContaining({ kind: "orphan_worktree", path: orphan }),
  );
  expect(findings).toContainEqual(
    expect.objectContaining({ kind: "stale_registration", path: stale }),
  );
  expect(findings).toContainEqual(
    expect.objectContaining({ kind: "missing_worktree", assignment_id: "A-3" }),
  );
  expect(findings).toContainEqual(
    expect.objectContaining({
      kind: "missing_delivery_ref",
      delivery_id: "D-2",
    }),
  );
  expect(findings).toContainEqual(
    expect.objectContaining({ kind: "failed_clone", path: failed }),
  );
  expect(findings).toContainEqual(
    expect.objectContaining({ kind: "source_diverged" }),
  );

  // Nothing was deleted, nothing was pruned and no ref moved.
  expect(await readdir(orphan)).toEqual([]);
  expect(await readFile(join(work, "file"), "utf8")).toBe("delivered");
  expect(await git(base, "for-each-ref")).toBe(registeredBefore);
  expect(await readdir(join(f.dataDir, "cleanup")).catch(() => [])).toEqual([]);
});

test("a consistent project has no findings", async () => {
  const first = await commit(work, "delivered");
  await f.transport.fetchRefs(repo, work, [
    `+refs/heads/agent/C-1/W-1:refs/cardigan/candidates/A-1/${first}`,
  ]);
  await f.central.pinDelivery(project, "D-1", first);

  expect(
    await service.reconcile(
      project,
      [assignmentFor(work)],
      [deliveryFor("D-1", first)],
    ),
  ).toEqual([]);
  expect((await service.listWorktreeState(project)).source_sync).not.toBe(
    "diverged",
  );
});

test("missing clone and worktree roots reconcile as empty, not as an error", async () => {
  const empty = new GitWorktreeService(new LocalGitTransport(), f.central, {
    dataDir: f.dataDir,
    repositoriesRoot: join(f.root, "empty-repos"),
    worktreesRoot: join(f.root, "empty-trees"),
  });
  expect(await empty.listWorktreeState(project)).toMatchObject({
    registered: [],
    directories: [],
    failed_clones: [],
    source_sync: "up_to_date",
  });
});
