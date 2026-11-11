import { expect, test } from "vitest";
import {
  type CentralProject,
  type ExecutorCheckState,
  GitWorktreeService,
  type ReconcileChecks,
  reconcileExecutorChecks,
} from "./index.js";

/** P2a-12 C: check directories on a non-local executor, listed over SSH. */
const root = "/srv/cardigan-agent/checks/cardigan";
const dir = (attempt: string) => `${root}/${attempt}/worktree`;
const now = "2026-11-11T12:00:00.000Z";
const checks: ReconcileChecks = {
  now,
  cleanupGraceMs: 600_000,
  attempts: [
    { attempt_id: "running", status: "running", updated_at: now },
    { attempt_id: "queued", status: "queued", updated_at: now },
    {
      attempt_id: "fresh",
      status: "passed",
      updated_at: "2026-11-11T11:55:00.000Z",
    },
    {
      attempt_id: "old",
      status: "failed",
      updated_at: "2026-11-11T11:00:00.000Z",
    },
  ],
};
const listed = (
  directories: readonly string[],
  registered: readonly string[],
): ExecutorCheckState => ({
  executor: "cardigan-ci",
  checks_root: root,
  listing: { status: "listed", directories, registered },
});

test("an unreachable executor is its own finding, never an orphan or a stale registration", () => {
  const findings = reconcileExecutorChecks(
    {
      executor: "cardigan-ci",
      checks_root: root,
      listing: { status: "unreachable" },
    },
    "cardigan",
    checks,
  );
  expect(findings).toEqual([
    expect.objectContaining({
      kind: "executor_unreachable",
      path: `cardigan-ci:${root}`,
    }),
  ]);
  // Even with no Store protection at all, a failed listing reports nothing else.
  expect(
    reconcileExecutorChecks(
      {
        executor: "cardigan-ci",
        checks_root: root,
        listing: { status: "unreachable" },
      },
      "cardigan",
    ).map((f) => f.kind),
  ).toEqual(["executor_unreachable"]);
});

test("listed remote directories are judged by the same Store events and grace as local ones", () => {
  const findings = reconcileExecutorChecks(
    listed(
      [dir("running"), dir("queued"), dir("fresh"), dir("old"), dir("stray")],
      [dir("running"), dir("old"), dir("gone-old"), dir("queued-missing")],
    ),
    "cardigan",
    {
      ...checks,
      attempts: [
        ...checks.attempts,
        {
          attempt_id: "gone-old",
          status: "passed",
          updated_at: "2026-11-11T10:00:00.000Z",
        },
        { attempt_id: "queued-missing", status: "queued", updated_at: now },
      ],
    },
  );
  expect(findings.map((f) => [f.kind, f.path])).toEqual([
    ["orphan_worktree", `cardigan-ci:${dir("old")}`],
    ["orphan_worktree", `cardigan-ci:${dir("stray")}`],
    ["stale_registration", `cardigan-ci:${dir("gone-old")}`],
  ]);
  for (const finding of findings)
    expect(finding.detail).toMatch(/^Executor cardigan-ci: /u);
});

test("an empty listing of a reachable executor reports nothing", () => {
  expect(reconcileExecutorChecks(listed([], []), "cardigan", checks)).toEqual(
    [],
  );
});

test("paths outside the project's remote checks root are ignored", () => {
  expect(
    reconcileExecutorChecks(
      listed(
        ["/srv/cardigan-agent/worktrees/cardigan/A-1", `${root}-other/x`],
        ["/srv/cardigan-agent/worktrees/cardigan/A-2"],
      ),
      "cardigan",
      checks,
    ),
  ).toEqual([]);
});

const project = {
  project_id: "cardigan",
  source_repo: "/unused",
  base_branch: "main",
} as unknown as CentralProject;
const service = new GitWorktreeService({} as never, {} as never, {
  dataDir: "/unused",
});

test("listExecutorChecks turns any listing failure into unreachable", async () => {
  const state = await service.listExecutorChecks(project, {
    name: "cardigan-ci",
    agentRoot: "/srv/cardigan-agent",
    list: async () => {
      throw new Error("ssh: connect to host cardigan-ci port 22: timed out");
    },
  });
  expect(state).toEqual({
    executor: "cardigan-ci",
    checks_root: root,
    listing: { status: "unreachable" },
  });
  expect(JSON.stringify(state)).not.toContain("timed out");
});

test("listExecutorChecks passes a successful listing through for the project", async () => {
  const seen: string[] = [];
  const state = await service.listExecutorChecks(project, {
    name: "cardigan-ci",
    agentRoot: "/srv/cardigan-agent",
    list: async (id) => {
      seen.push(id);
      return { directories: [dir("a")], registered: [] };
    },
  });
  expect(seen).toEqual(["cardigan"]);
  expect(state.listing).toEqual({
    status: "listed",
    directories: [dir("a")],
    registered: [],
  });
});
