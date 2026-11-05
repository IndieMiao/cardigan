/** M4.T2: independent expectations from M4 plan §0, §3.5–§3.6 and §16. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { git, type M4Cross, m4Cross } from "../test-support/m4-cross.js";

let f: M4Cross | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
}, 30_000);
async function accepted(two = false, conflict = false) {
  const s = await m4Cross();
  f = s;
  const other = two ? await s.extra() : undefined;
  const first = await s.deliver(
    s.primary,
    await s.change(s.primary.owner, "shared.txt", "first\n"),
  );
  await s.review(s.primary.verifier, first);
  if (other) {
    const second = await s.deliver(
      other,
      await s.change(
        other.owner,
        conflict ? "shared.txt" : "second.txt",
        "second\n",
      ),
    );
    await s.review(other.verifier, second);
  }
  await s.complete(first);
  await s.confirm();
  return s;
}

test("G01 §3.5: two accepted deliveries merge in order, each with two parents; source stays read-only", async () => {
  const s = await accepted(true),
    plan = s.plan();
  const initial = git(s.center, "rev-parse", "main"),
    source = git(s.source, "show-ref");
  const result = await s.central.mergeIntoBase(s.project, plan);
  expect(result.status).toBe("merged");
  const head = git(s.center, "rev-parse", "main"),
    prior = git(s.center, "rev-parse", `${head}^1`);
  expect(
    git(s.center, "rev-list", "--parents", "-n", "1", prior).split(" "),
  ).toEqual([prior, initial, plan.deliveries[0]?.sha]);
  expect(
    git(s.center, "rev-list", "--parents", "-n", "1", head).split(" "),
  ).toEqual([head, prior, plan.deliveries[1]?.sha]);
  expect(git(s.center, "show", `${head}:second.txt`)).toBe("second");
  expect(git(s.center, "show", `${head}:shared.txt`)).toBe("first");
  expect(git(s.center, "show", "-s", "--format=%B", head)).toContain(
    String(plan.deliveries[1]?.delivery_id),
  );
  expect(git(s.source, "show-ref")).toBe(source);
});

test("G02 §3.5: a later conflicting delivery leaves every central ref unchanged", async () => {
  const s = await accepted(true, true),
    before = git(s.center, "show-ref");
  const plan = s.plan(),
    result = await s.central.mergeIntoBase(s.project, plan);
  expect(result).toMatchObject({
    status: "conflicted",
    delivery_id: plan.deliveries[1]?.delivery_id,
    files: ["shared.txt"],
  });
  expect(git(s.center, "show-ref")).toBe(before);
});

test("G03 §3.5: a concurrent baseline advance returns stale and cannot be overwritten", async () => {
  const s = await accepted();
  await writeFile(join(s.source, "concurrent.txt"), "concurrent\n");
  git(s.source, "add", ".");
  git(s.source, "commit", "-qm", "Concurrent user work");
  const concurrent = git(s.source, "rev-parse", "HEAD");
  git(s.center, "fetch", s.source, "refs/heads/main:refs/testing/concurrent");
  let advanced = false;
  s.observe((cwd, args) => {
    if (
      !advanced &&
      args.includes("update-ref") &&
      args.includes("refs/heads/main")
    ) {
      advanced = true;
      git(cwd, "update-ref", "refs/heads/main", concurrent);
    }
  });
  expect(await s.central.mergeIntoBase(s.project, s.plan())).toEqual({
    status: "stale",
  });
  expect(advanced).toBe(true);
  expect(git(s.center, "rev-parse", "main")).toBe(concurrent);
});

test("G04 §3.5: replaying a merged plan is a no-op with no extra merge commit", async () => {
  const s = await accepted();
  const plan = s.plan();
  await s.central.mergeIntoBase(s.project, plan);
  const before = git(s.center, "show-ref");
  expect(await s.central.mergeIntoBase(s.project, plan)).toMatchObject({
    status: "noop",
    branch_sha: git(s.center, "rev-parse", "main"),
  });
  expect(git(s.center, "show-ref")).toBe(before);
});

test("G05 §3.5: a pinned delivery ref disagreeing with the accepted plan refuses the merge", async () => {
  const s = await accepted(),
    plan = s.plan();
  git(
    s.center,
    "update-ref",
    `refs/cardigan/deliveries/${plan.deliveries[0]?.delivery_id}`,
    git(s.center, "rev-parse", "main"),
  );
  const before = git(s.center, "show-ref");
  await expect(s.central.mergeIntoBase(s.project, plan)).rejects.toThrow();
  expect(git(s.center, "show-ref")).toBe(before);
});

async function released() {
  const s = await m4Cross();
  f = s;
  await s.start(s.primary.owner);
  await s.finish(s.primary.owner);
  s.cancel();
  return {
    s,
    assignment: s.release(s.primary.owner),
    path: s.path(s.primary.owner),
  };
}
test("G06 §3.6: clean released worktree and branch are removed after backup", async () => {
  const { s, assignment, path } = await released();
  const head = git(path, "rev-parse", "HEAD");
  expect(
    await s.worktrees.removeWorktree({
      project: s.project,
      assignment,
      force: false,
    }),
  ).toMatchObject({ status: "removed" });
  expect(existsSync(path)).toBe(false);
  expect(
    git(s.repository, "branch", "--list", assignment.branch as string),
  ).toBe("");
  expect(
    git(
      s.center,
      "rev-parse",
      `refs/cardigan/backups/local/${assignment.branch}`,
    ),
  ).toBe(head);
});

test.each(["tracked", "untracked"])(
  "G07 §16: %s changes are never silently removed",
  async (kind) => {
    const { s, assignment, path } = await released();
    const file = kind === "tracked" ? "shared.txt" : "untracked.txt";
    await writeFile(join(path, file), "keep me\n");
    const before = git(s.repository, "show-ref");
    expect(
      await s.worktrees.removeWorktree({
        project: s.project,
        assignment,
        force: false,
      }),
    ).toMatchObject({ status: "needs_decision" });
    expect(await s.worktrees.isDirty(path)).toBe(true);
    expect(readFileSync(join(path, file), "utf8")).toBe("keep me\n");
    expect(git(s.repository, "show-ref")).toBe(before);
  },
);

test("G08 §3.6: force-clean writes a private patch and untracked inventory before deletion", async () => {
  const { s, assignment, path } = await released();
  await writeFile(join(path, "shared.txt"), "retain this patch\n");
  await writeFile(join(path, "loose.txt"), "loose\n");
  // The public Git port observes real removeWorktree without changing its behavior.
  let savedBeforeRemoval = false;
  const remove = s.local.removeWorktree.bind(s.local);
  s.local.removeWorktree = async (...args) => {
    const files = readdirSync(join(s.dataDir, "cleanup", s.project.project_id));
    savedBeforeRemoval = files.some((name) =>
      readFileSync(
        join(s.dataDir, "cleanup", s.project.project_id, name),
        "utf8",
      ).includes("retain this patch"),
    );
    await remove(...args);
  };
  const result = await s.worktrees.removeWorktree({
    project: s.project,
    assignment,
    force: true,
  });
  expect(savedBeforeRemoval).toBe(true);
  expect(result.status).toBe("removed");
  if (result.status !== "removed" || !result.patch_path)
    throw new Error("Missing cleanup patch");
  expect(statSync(result.patch_path).mode & 0o777).toBe(0o600);
  expect(readFileSync(result.patch_path, "utf8")).toContain("loose.txt");
  expect(existsSync(path)).toBe(false);
});

test.each([
  "orphan_worktree",
  "missing_worktree",
  "stale_registration",
  "missing_delivery_ref",
  "failed_clone",
  "source_diverged",
])(
  "G09 §3.6/§16: reconciliation reports %s without deleting data",
  async (kind) => {
    const s = await m4Cross();
    f = s;
    await s.start(s.primary.owner);
    const path = s.path(s.primary.owner),
      branch = s.current(s.primary.owner).branch as string;
    const sentinel = join(s.trees, "orphan");
    await mkdir(sentinel);
    await writeFile(join(sentinel, "keep"), "untouched");
    if (["missing_worktree", "stale_registration"].includes(kind)) {
      await rm(path, { recursive: true });
      if (kind === "missing_worktree") git(s.repository, "worktree", "prune");
    }
    if (kind === "missing_delivery_ref") {
      const d = await s.deliver(s.primary, git(path, "rev-parse", "HEAD"));
      git(s.center, "update-ref", "-d", `refs/cardigan/deliveries/${d.id}`);
    }
    if (kind === "failed_clone")
      await mkdir(join(s.dataDir, "agent", "repos", ".clone-interrupted"));
    if (kind === "source_diverged") {
      const own = await s.change(s.primary.owner, "branch.txt", "central\n");
      git(
        s.center,
        "fetch",
        s.repository,
        `refs/heads/${branch}:refs/heads/main`,
      );
      await writeFile(join(s.source, "source.txt"), "source\n");
      git(s.source, "add", ".");
      git(s.source, "commit", "-qm", "Source diverges");
      expect(git(s.center, "rev-parse", "main")).toBe(own);
    }
    const registeredOrphan = join(s.trees, "registered-orphan");
    if (kind === "orphan_worktree")
      git(
        s.repository,
        "worktree",
        "add",
        "--detach",
        "--",
        registeredOrphan,
        git(s.center, "rev-parse", "main"),
      );
    const baseline = git(s.center, "rev-parse", "main");
    const registered = git(s.repository, "worktree", "list", "--porcelain");
    const before = git(s.repository, "show-ref"),
      state = s.state();
    const findings = await s.worktrees.reconcile(
      s.project,
      state.assignments,
      state.deliveries,
    );
    expect(findings.some((v) => v.kind === kind)).toBe(true);
    expect(readFileSync(join(sentinel, "keep"), "utf8")).toBe("untouched");
    expect(git(s.repository, "show-ref")).toBe(before);
    expect(git(s.center, "rev-parse", "main")).toBe(baseline);
    expect(git(s.repository, "worktree", "list", "--porcelain")).toBe(
      registered,
    );
    if (kind === "failed_clone")
      expect(
        existsSync(join(s.dataDir, "agent", "repos", ".clone-interrupted")),
      ).toBe(true);
    if (kind === "orphan_worktree")
      for (const path of [sentinel, registeredOrphan])
        expect(findings).toContainEqual(
          expect.objectContaining({ kind, path }),
        );
  },
);

// Defect: §3.6 requires an active owner; released Assignments still suppress orphan findings.
test.fails("G10 §3.6: a worktree retained after manual release has no active owner", async () => {
  const s = await m4Cross();
  f = s;
  await s.start(s.primary.owner);
  await s.finish(s.primary.owner);
  s.release(s.primary.owner);
  const state = s.state(),
    path = s.path(s.primary.owner);
  expect(
    await s.worktrees.reconcile(s.project, state.assignments, state.deliveries),
  ).toContainEqual(expect.objectContaining({ kind: "orphan_worktree", path }));
  expect(existsSync(path)).toBe(true);
});

// Defect: an absent active worktree only reports stale_registration while Git still registers it.
test.fails("G11 §3.6: a missing active worktree can also have a stale Git registration", async () => {
  const s = await m4Cross();
  f = s;
  await s.start(s.primary.owner);
  const path = s.path(s.primary.owner);
  await rm(path, { recursive: true });
  const state = s.state(),
    findings = await s.worktrees.reconcile(
      s.project,
      state.assignments,
      state.deliveries,
    );
  for (const kind of ["missing_worktree", "stale_registration"])
    expect(findings).toContainEqual(expect.objectContaining({ kind, path }));
});
