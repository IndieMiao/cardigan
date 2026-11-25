import { existsSync } from "node:fs";
import { readdir, rm, writeFile } from "node:fs/promises";
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
      branch_head_sha: await git(work, "rev-parse", "HEAD"),
      tree_sha: await git(work, "rev-parse", `${sha}^{tree}`),
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
  const older = await verify(sha);
  expect(older.ok).toBe(true);
  if (!older.ok) throw new Error(older.error.message);
  expect(older.value.find((e) => e.kind === "commit")?.details).toMatchObject({
    sha,
    branch_head_sha: next,
  });
  expect((await refs("candidates")).split("\n")).toHaveLength(2);
  expect(await git(f.source, "rev-parse", "main")).toBe(f.initial);
});
test("C-642: staging a branch imports its tip without any ref or leftover stage", async () => {
  const sha = await commit(work, "staged");
  const before = await git(repo, "for-each-ref", "--format=%(refname)");
  const address = { kind: "host-local" as const, path: base };
  expect(await f.transport.fetchBranchTip(repo, address, "agent/C-1/W-1")).toBe(
    sha,
  );
  expect(await f.transport.objectType(repo, sha)).toBe("commit");
  expect(await git(repo, "for-each-ref", "--format=%(refname)")).toBe(before);
  expect(existsSync(join(repo, "FETCH_HEAD"))).toBe(false);
  for (const branch of ["missing", "main:refs/heads/evil", "../escape"])
    await expect(
      f.transport.fetchBranchTip(repo, address, branch),
    ).rejects.toThrow();
  expect(
    (await readdir(join(repo, ".."))).filter((name) => name.startsWith(".")),
  ).toEqual([]);
});
test("C-642: a late publication of an older read never moves the incoming tip back", async () => {
  const first = await commit(work, "first");
  const late = await verifier.prepareVerify(
    { kind: "git_head", value: first },
    assignment,
  );
  const second = await commit(work, "second");
  expect((await verify(second)).ok).toBe(true);
  expect(await f.transport.readRef(repo, "refs/cardigan/incoming/A-1")).toBe(
    second,
  );
  if ("value" in late) throw new Error("Expected a publication");
  const result = await late.publish();
  expect(result.ok).toBe(true);
  if (result.ok)
    expect(
      result.value.find((e) => e.kind === "commit")?.details.branch_head_sha,
    ).toBe(first);
  expect(await f.transport.readRef(repo, "refs/cardigan/incoming/A-1")).toBe(
    second,
  );
  expect(await refs("candidates")).toBe(
    [
      `refs/cardigan/candidates/A-1/${first}:${first}`,
      `refs/cardigan/candidates/A-1/${second}:${second}`,
    ]
      .sort()
      .join("\n"),
  );
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
      branch_head_sha: await git(work, "rev-parse", "HEAD"),
      tree_sha: await git(work, "rev-parse", `${f.initial}^{tree}`),
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
    expect(verified.value.map((e) => e.kind)).toEqual([
      "diff",
      "diff",
      "commit",
    ]);
    expect(verified.value.find((e) => e.kind === "commit")?.details).toEqual({
      sha,
      branch_head_sha: await git(work, "rev-parse", "HEAD"),
      tree_sha: await git(work, "rev-parse", `${sha}^{tree}`),
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
    branch_head_sha: await git(work, "rev-parse", "HEAD"),
    tree_sha: await git(work, "rev-parse", `${sha}^{tree}`),
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

const previousDelivery = (
  sha: string,
): import("@cardigan/domain").Delivery => ({
  id: "D-1" as never,
  work_item_id: "W-1" as never,
  run_id: "R-1" as never,
  kind: "code",
  subject: { kind: "git_head", value: sha },
  summary: "Reviewed",
  status: "accepted",
  requested_verifiers: [],
  attachments: [],
  evidence: [],
  known_gaps: [],
});
async function writeCommit(path: string, contents: string) {
  await writeFile(join(work, path), contents);
  await git(work, "add", path);
  await git(work, "commit", "-m", "Update fixture");
  return git(work, "rev-parse", "HEAD");
}
async function equivalence(old: string, next: string) {
  const result = await verifier.verify(
    { kind: "git_head", value: next },
    assignment,
    previousDelivery(old),
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.value.find((e) => e.details.review_equivalence)?.details
    .review_equivalence;
}

test("Flow Lite: merging main preserves the author's already reviewed changes", async () => {
  const old = await writeCommit("app.ts", "export const answer = 42;\n");
  await import("node:fs/promises").then((fs) =>
    fs.mkdir(join(f.source, ".github/workflows"), { recursive: true }),
  );
  await writeFile(join(f.source, ".github/workflows/main.yml"), "name: main\n");
  await git(f.source, "add", ".github");
  await git(f.source, "commit", "-m", "Advance main");
  await central.syncFromSource(f.project);
  await git(work, "fetch", repo, "main");
  await git(work, "merge", "--no-edit", "FETCH_HEAD");
  const next = await git(work, "rev-parse", "HEAD");
  expect(await equivalence(old, next)).toMatchObject({
    old_sha: old,
    new_sha: next,
    kind: "baseline",
  });
  const verified = await verifier.verify(
    { kind: "git_head", value: next },
    assignment,
    previousDelivery(old),
  );
  if (!verified.ok) throw new Error(verified.error.message);
  expect(
    verified.value.find((e) => e.details.own_path_inventory)?.details
      .own_path_inventory,
  ).toMatchObject({
    base_sha: await git(f.source, "rev-parse", "HEAD"),
    assignment_base_sha: f.initial,
    paths: ["app.ts"],
  });
  expect(await git(repo, "rev-parse", "main")).toBe(
    await git(f.source, "rev-parse", "HEAD"),
  );
});

test.each([
  ["export const answer = 'a b';\n", 'export const answer = "a b"\n', true],
  ["export const answer = 'a b';\n", "export const answer = 'ab';\n", false],
  ["function f(){return 1;}\n", "function f() { return\n1; }\n", false],
  [
    "// @ts-ignore\nconst x: number = 'x';\nconst y: number = 'y';\n",
    "const x: number = 'x';\n// @ts-ignore\nconst y: number = 'y';\n",
    false,
  ],
  ["export const pattern = /a b/;\n", "export const pattern = /ab/;\n", false],
  [
    "export const template = `a b`;\n",
    "export const template = `ab`;\n",
    false,
  ],
])(
  "Flow Lite: syntax proof handles literals, ASI and directives (%s)",
  async (before, after, reuse) => {
    const old = await writeCommit("app.ts", before as string);
    const next = await writeCommit("app.ts", after as string);
    expect(!!(await equivalence(old, next))).toBe(reuse);
  },
);

test("Flow Lite: unprovable conflict resolution requires review", async () => {
  const old = await commit(work, "author change");
  await commit(f.source, "different main change");
  await central.syncFromSource(f.project);
  await git(work, "fetch", repo, "main");
  try {
    await git(work, "merge", "--no-edit", "FETCH_HEAD");
  } catch {
    /* expected conflict */
  }
  await writeFile(join(work, "file"), "resolved manually");
  await git(work, "add", "file");
  await git(work, "commit", "-m", "Resolve conflict");
  expect(
    await equivalence(old, await git(work, "rev-parse", "HEAD")),
  ).toBeUndefined();
});

test("Flow Lite: a conflict resolution retaining exactly the reviewed author side is reusable", async () => {
  const old = await commit(work, "reviewed author change\n");
  await commit(f.source, "different main change");
  await central.syncFromSource(f.project);
  await git(work, "fetch", repo, "main");
  try {
    await git(work, "merge", "--no-edit", "FETCH_HEAD");
  } catch {
    /* expected conflict */
  }
  await writeFile(join(work, "file"), "reviewed author change\n");
  await git(work, "add", "file");
  await git(work, "commit", "-m", "Resolve conflict retaining reviewed change");
  expect(
    await equivalence(old, await git(work, "rev-parse", "HEAD")),
  ).toMatchObject({ kind: "conflict" });
});

test.each([false, true])(
  "Flow Lite: snapshot proof accepts data-only snapshot updates and rejects executable code (%s)",
  async (malicious) => {
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(join(work, "__snapshots__"), { recursive: true }),
    );
    const old = await writeCommit(
      "__snapshots__/example.test.ts.snap",
      "// Vitest Snapshot v1\nexports[`example 1`] = `before`;\n",
    );
    const next = await writeCommit(
      "__snapshots__/example.test.ts.snap",
      `// Vitest Snapshot v1\n${malicious ? "process.exit(1);\n" : ""}exports[\`example 1\`] = \`after\`;\n`,
    );
    expect(!!(await equivalence(old, next))).toBe(!malicious);
  },
);

test.each([
  [
    "export const data = {a: 1, b: 2};\n",
    "export const data = {\n a: 1,\n b: 2,\n};\n",
    true,
  ],
  [
    "'use strict';\nfunction f(){ return this; }\n",
    "'use\\x20strict';\nfunction f(){ return this; }\n",
    false,
  ],
])(
  "Flow Lite: formatting proof preserves strict directive semantics and handles trailing commas",
  async (before, after, reuse) => {
    const old = await writeCommit("app.ts", String(before));
    const next = await writeCommit("app.ts", String(after));
    expect(!!(await equivalence(old, next))).toBe(reuse);
  },
);

test("worker sources reject object/branch forgeries and object format mismatches using a bound pack stream", async () => {
  // The opaque worker path deliberately does not exist on the controller.
  const remote = new CentralRepositoryService(f.transport, {
    dataDir: f.dataDir,
    agentSource: async (project, machine) => ({
      address: {
        kind: "worker-remote",
        root: "/worker-fixture",
        path: `/worker-fixture/repos/${project.project_id}`,
        project_id: project.project_id,
        machine_id: machine,
      },
      uploadPack: `sh -c 'exec git-upload-pack "${base}"' --`,
    }),
  });
  const v = new GitDeliveryVerifier(remote, f.project);
  const a = {
    ...assignment,
    machine_id: "worker-a",
    worktree_path: "/worker-fixture/worktrees/project/A-1",
  };
  const own = await commit(work, "remote own");
  await git(f.source, "checkout", "-b", "other");
  const foreign = await commit(f.source, "other branch");
  await f.transport.fetchRefs(repo, f.source, [
    "refs/heads/other:refs/cardigan/source/other",
  ]);
  await git(work, "tag", "-a", "remote-tag", "-m", "tag");
  await f.transport.fetchRefs(repo, base, [
    "refs/tags/remote-tag:refs/tags/remote-tag",
  ]);
  for (const value of [
    "f".repeat(40),
    "a".repeat(64),
    own.slice(0, 8),
    own.toUpperCase(),
    foreign,
    await git(work, "rev-parse", "HEAD^{tree}"),
    await git(work, "rev-parse", "HEAD:file"),
    await git(work, "rev-parse", "refs/tags/remote-tag"),
  ])
    expect((await v.verify({ kind: "git_head", value }, a)).ok).toBe(false);
  for (const branch of ["missing", "main:refs/heads/evil"])
    expect(
      (await v.verify({ kind: "git_head", value: own }, { ...a, branch })).ok,
    ).toBe(false);
  expect(await refs("candidates")).toBe("");
  expect((await v.verify({ kind: "git_head", value: own }, a)).ok).toBe(true);
  expect(await v.head(a)).toBe(own);
  // A source with a different object format cannot feed this SHA-1 center.
  const incompatible = join(f.root, "incompatible");
  await git(
    f.root,
    "init",
    "--object-format=sha256",
    "-b",
    "agent/C-1/W-1",
    incompatible,
  );
  await commit(incompatible, "sha256");
  const mismatch = new CentralRepositoryService(f.transport, {
    dataDir: f.dataDir,
    agentSource: async () => ({
      address: {
        kind: "worker-remote",
        root: "/worker-fixture",
        path: "/worker-fixture/repos/project",
        project_id: "project",
        machine_id: "worker-a",
      },
      uploadPack: `sh -c 'exec git-upload-pack "${incompatible}"' --`,
    }),
  });
  await expect(
    new GitDeliveryVerifier(mismatch, f.project).head(a),
  ).rejects.toMatchObject({ name: "CheckHeadFailure" });
  const wrongTarget = new CentralRepositoryService(f.transport, {
    dataDir: f.dataDir,
    agentSource: async () => ({
      address: {
        kind: "worker-remote",
        root: "/worker-fixture",
        path: "/worker-fixture/repos/project",
        project_id: "project",
        machine_id: "worker-b",
      },
      uploadPack: "false",
    }),
  });
  // C-632: the host classifies the stage; the raw cause stays server-side.
  const wrong = await new GitDeliveryVerifier(wrongTarget, f.project)
    .head(a)
    .catch((error: unknown) => error);
  expect(wrong).toMatchObject({
    name: "CheckHeadFailure",
    reason: "environment_unavailable",
    cause: expect.objectContaining({
      message: expect.stringMatching(/binding mismatch/),
    }),
  });
  expect(await git(repo, "rev-parse", "main")).toBe(f.initial);
});
