import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Assignment } from "@cardigan/domain";
import {
  CentralRepositoryService,
  GitDeliveryVerifier,
} from "@cardigan/git-service";
import { afterEach, beforeEach, expect, test } from "vitest";
import { centralFixture, commit, git } from "../test-support/git.js";
import { LocalGitTransport } from "./index.js";

let f: Awaited<ReturnType<typeof centralFixture>>,
  central: CentralRepositoryService,
  verifier: GitDeliveryVerifier,
  repo: string,
  base: string,
  work: string,
  assignment: Assignment;
beforeEach(async () => {
  f = await centralFixture();
  central = f.central;
  repo = await central.ensureCentral(f.project);
  base = join(f.dataDir, "agent", "repos", f.project.project_id);
  work = join(f.dataDir, "agent", "worktrees", f.project.project_id, "A-1");
  const local = new LocalGitTransport();
  await local.ensureClone(repo, base);
  await local.addWorktree(base, work, f.initial, "agent/C-1/W-1");
  assignment = {
    id: "A-1" as never,
    scope: "work_item",
    work_item_id: "W-1" as never,
    role_id: "coder",
    role_version: 1,
    status: "active",
    runtime_state: "not_provisioned",
    machine_id: "local",
    runtime_ref: null,
    mcp_token_id: "reserved",
    created_at: "2030-01-01T00:00:00.000Z",
    branch: "agent/C-1/W-1",
    worktree_path: work,
    base_sha: f.initial,
  };
  verifier = new GitDeliveryVerifier(central, f.project);
});
afterEach(async () => f.close());
const verify = (sha: string, a = assignment) =>
  verifier.verify({ kind: "git_head", value: sha }, a);
const refs = (prefix: string) =>
  git(
    repo,
    "for-each-ref",
    "--format=%(refname):%(objectname)",
    `refs/cardigan/${prefix}`,
  );

test("verification creates a candidate from the recorded branch and produces immutable commit evidence", async () => {
  const sha = await commit(work, "delivered");
  const verified = await verify(sha);
  expect(verified.ok).toBe(true);
  if (!verified.ok) throw new Error(verified.error.message);
  expect(verified.value.map((e) => e.kind)).toEqual(["diff", "commit"]);
  expect(verified.value.find((e) => e.kind === "commit")).toEqual({
    kind: "commit",
    details: {
      sha,
      branch: assignment.branch,
      base_sha: f.initial,
      commits_ahead: 1,
    },
  });
  expect(
    verified.value.find((e) => e.kind === "diff")?.details.role_rule_inventory,
  ).toMatchObject({
    version: 1,
    complete: true,
    base_sha: f.initial,
    sha,
    tree_sha: await git(work, "rev-parse", "HEAD^{tree}"),
    changes: [{ path: "file", category: "ordinary" }],
  });
  expect(await refs("candidates")).toBe(
    `refs/cardigan/candidates/A-1/${sha}:${sha}`,
  );
  expect(await refs("deliveries")).toBe("");
  const next = await commit(work, "new version");
  expect((await verify(next)).ok).toBe(true);
  expect((await verify(sha)).ok).toBe(true);
  expect((await refs("candidates")).split("\n")).toHaveLength(2);
  expect(await git(f.source, "rev-parse", "main")).toBe(f.initial);
});
test.each(["missing", "tree", "blob", "foreign", "tag"])(
  "rejects %s objects without candidate or delivery refs",
  async (kind) => {
    const own = await commit(work, "own");
    let sha = "0".repeat(40);
    if (kind === "tree") sha = await git(work, "rev-parse", "HEAD^{tree}");
    if (kind === "blob") sha = await git(work, "rev-parse", "HEAD:file");
    if (kind === "foreign" || kind === "tag") {
      await git(f.source, "switch", "-c", "other");
      sha = await commit(f.source, "foreign");
      if (kind === "tag") {
        await git(f.source, "tag", "-a", "annotated", "-m", "tag");
        sha = await git(f.source, "rev-parse", "refs/tags/annotated");
      }
      await f.transport.fetchRefs(repo, f.source, [
        kind === "tag"
          ? "refs/tags/annotated:refs/tags/annotated"
          : "refs/heads/other:refs/cardigan/backups/local/agent/other",
      ]);
    }
    const result = await verify(sha);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.message).toMatch(
        kind === "foreign"
          ? /not on the recorded Assignment branch/
          : /not a commit/,
      );
    expect(await refs("candidates")).toBe("");
    expect(await refs("deliveries")).toBe("");
    expect(await f.transport.readRef(repo, "refs/cardigan/incoming/A-1")).toBe(
      own,
    );
  },
);
test("rejects abbreviated/uppercase SHAs, missing writing metadata and a missing recorded branch", async () => {
  for (const sha of [f.initial.slice(0, 10), "A".repeat(40), "a".repeat(64)])
    expect((await verify(sha)).ok).toBe(false);
  for (const a of [
    { ...assignment, branch: undefined },
    { ...assignment, worktree_path: undefined },
    { ...assignment, branch: "missing" },
    { ...assignment, branch: "main:refs/heads/evil" },
  ])
    expect((await verify(f.initial, a as Assignment)).ok).toBe(false);
  expect(await refs("candidates")).toBe("");
  expect(await refs("deliveries")).toBe("");
});
test("non-Git subjects perform no Git IO; an absent base SHA uses the recorded central baseline", async () => {
  const count = f.calls.length;
  for (const kind of ["artifact_sha256", "doc_version"] as const)
    expect(
      await verifier.verify({ kind, value: "fixture" }, assignment),
    ).toEqual({ ok: true, value: [] });
  expect(f.calls).toHaveLength(count);
  const { base_sha: _base, ...a } = assignment;
  const verified = await verify(f.initial, a);
  expect(verified.ok).toBe(true);
  if (!verified.ok) throw new Error(verified.error.message);
  expect(verified.value.map((e) => e.kind)).toEqual(["diff", "commit"]);
  expect(verified.value.find((e) => e.kind === "commit")).toEqual({
    kind: "commit",
    details: {
      sha: f.initial,
      branch: a.branch,
      base_sha: f.initial,
      commits_ahead: 0,
    },
  });
  expect(
    verified.value.find((e) => e.kind === "diff")?.details.role_rule_inventory,
  ).toEqual({
    version: 1,
    complete: true,
    base_sha: f.initial,
    sha: f.initial,
    tree_sha: await git(work, "rev-parse", `${f.initial}^{tree}`),
    changes: [],
  });
});
test("pinning is create-only and idempotent, including concurrent identical pins", async () => {
  const sha = await commit(work, "delivery");
  expect((await verify(sha)).ok).toBe(true);
  await Promise.all([
    central.pinDelivery(f.project, "D-1", sha),
    central.pinDelivery(f.project, "D-1", sha),
  ]);
  await expect(
    central.pinDelivery(f.project, "D-1", f.initial),
  ).rejects.toThrow(/different SHA/);
  expect(await f.transport.readRef(repo, "refs/cardigan/deliveries/D-1")).toBe(
    sha,
  );
  const race = await Promise.allSettled([
    central.pinDelivery(f.project, "D-2", sha),
    central.pinDelivery(f.project, "D-2", f.initial),
  ]);
  expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(await f.transport.readRef(repo, "refs/cardigan/deliveries/D-2")).toBe(
    race[0]?.status === "fulfilled" ? sha : f.initial,
  );
});
test("failed/partially invalid backups preserve every old backup and never prune deleted branches", async () => {
  await central.backupAgentBranches(f.project, "local");
  const before = await refs("backups");
  await commit(work, "new unverified work");
  await writeFile(
    join(base, ".git", "refs", "heads", "agent", "broken"),
    `${"f".repeat(40)}\n`,
  );
  await expect(
    central.backupAgentBranches(f.project, "local"),
  ).rejects.toThrow();
  expect(await refs("backups")).toBe(before);
  await rm(join(base, ".git", "refs", "heads", "agent", "broken"));
  await central.backupAgentBranches(f.project, "local");
  const newer = await refs("backups");
  expect(newer).not.toBe(before);
  await git(work, "checkout", "--detach");
  await git(base, "branch", "-D", "agent/C-1/W-1");
  await git(repo, "config", "fetch.prune", "true");
  await central.backupAgentBranches(f.project, "local");
  expect(await refs("backups")).toBe(newer);
});
test("SHA-256 repositories require the full 64-character SHA", async () => {
  const source = join(f.root, "sha256");
  await git(f.root, "init", "--object-format=sha256", "-b", "main", source);
  const sha = await commit(source, "sha256");
  const project = { ...f.project, project_id: "sha256", source_repo: source };
  const center = await central.ensureCentral(project),
    clone = join(f.dataDir, "agent", "repos", "sha256");
  const worktree = join(f.dataDir, "agent", "worktrees", "sha256", "A-1"),
    local = new LocalGitTransport();
  await local.ensureClone(center, clone);
  await local.addWorktree(clone, worktree, sha, "agent/C-1/W-1");
  const v = new GitDeliveryVerifier(central, project),
    a = { ...assignment, base_sha: sha, worktree_path: worktree };
  expect(
    (await v.verify({ kind: "git_head", value: sha.slice(0, 40) }, a)).ok,
  ).toBe(false);
  expect((await v.verify({ kind: "git_head", value: sha }, a)).ok).toBe(true);
  await central.pinDelivery(project, "D-1", sha);
  expect(
    await f.transport.readRef(center, "refs/cardigan/deliveries/D-1"),
  ).toBe(sha);
});

test.each([
  ["日志和说明使用中文。", "body"],
  ["每周五提交周报。", "unknown"],
])(
  "verification preserves commit and trusted role inventory for %s",
  async (text, category) => {
    await writeFile(join(work, "AGENTS.md"), "日志使用中文。\n");
    await git(work, "add", "AGENTS.md");
    await git(work, "commit", "-m", "existing language instruction");
    const baseSha = await git(work, "rev-parse", "HEAD");
    await writeFile(join(work, "AGENTS.md"), `${text}\n`);
    await git(work, "commit", "-am", "updated instruction");
    const sha = await git(work, "rev-parse", "HEAD");
    const verified = await verify(sha, { ...assignment, base_sha: baseSha });
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error(verified.error.message);
    expect(verified.value.map((e) => e.kind)).toEqual(["diff", "commit"]);
    expect(verified.value.find((e) => e.kind === "commit")?.details).toEqual({
      sha,
      branch: assignment.branch,
      base_sha: baseSha,
      commits_ahead: 1,
    });
    expect(
      verified.value.find((e) => e.kind === "diff")?.details
        .role_rule_inventory,
    ).toMatchObject({
      complete: true,
      base_sha: baseSha,
      sha,
      changes: [
        {
          path: "AGENTS.md",
          category,
          edits: [{ before: "日志使用中文。\n", after: `${text}\n` }],
        },
      ],
    });
  },
);

test("missing diff capability returns an incomplete inventory alongside unchanged commit evidence", async () => {
  const sha = await commit(work, "ordinary delivery");
  const transport = f.transport;
  const withoutDiff = new Proxy(transport, {
    get(target, key) {
      if (key === "fileDiffs") return undefined;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const service = new CentralRepositoryService(withoutDiff, {
    dataDir: f.dataDir,
  });
  const verified = await new GitDeliveryVerifier(service, f.project).verify(
    { kind: "git_head", value: sha },
    assignment,
  );
  expect(verified.ok).toBe(true);
  if (!verified.ok) throw new Error(verified.error.message);
  expect(verified.value.map((e) => e.kind)).toEqual(["diff", "commit"]);
  expect(verified.value.find((e) => e.kind === "commit")?.details).toEqual({
    sha,
    branch: assignment.branch,
    base_sha: f.initial,
    commits_ahead: 1,
  });
  expect(
    verified.value.find((e) => e.kind === "diff")?.details.role_rule_inventory,
  ).toEqual({
    version: 1,
    complete: false,
    base_sha: f.initial,
    sha,
    tree_sha: await git(work, "rev-parse", "HEAD^{tree}"),
    changes: [],
  });
});
