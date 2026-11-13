import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acknowledgeRun,
  queueRun,
  type Run,
  type Runtime,
} from "@cardigan/domain";
import {
  CentralRepositoryService,
  GitWorktreeService,
} from "@cardigan/git-service";
import {
  CentralGitTransport,
  LocalGitTransport,
} from "@cardigan/git-transport";
import { launchEntities, worktreeBaselinePrompt } from "@cardigan/host";
import { parseLaunchConfig } from "@cardigan/roles";
import { executionPaths } from "@cardigan/runtime-herdr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildCheckoutFacts, buildCheckoutIdle } from "./build-checkouts.js";
import { CleanupExecutor } from "./cleanup-loop.js";
import { ServerGit } from "./git.js";
import { startQueuedRun } from "./host-start.js";
import { m4Fixture, m4Scenario } from "./m4-fixtures.js";
import { ReconcileExecutor } from "./reconcile-loop.js";

/**
 * P2a-3: a readonly verifier gets a writable build checkout of the delivery it
 * verifies, next to (not instead of) its readonly worktree. The checkout lives
 * only as long as the verifier's Run, is never backed up and creates no ref.
 */
let f: ReturnType<typeof m4Fixture>, s: ReturnType<typeof m4Scenario>;
let source: string, sha: string, runtime: Runtime;
const git = (path: string, ...args: string[]) =>
  execFileSync(
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
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
const ok = <T>(value: T) => ({ ok: true as const, value });
const launch = {
  config: parseLaunchConfig({
    profiles: { fixture: { harness: "pi", model: "fixture-model" } },
  }),
  secrets: {},
};
beforeEach(async () => {
  f = m4Fixture({ reviewer_worktree: "readonly", pm_worktree: "readonly" });
  s = m4Scenario(f);
  source = join(f.dataDir, "source");
  mkdirSync(source);
  git(source, "init", "-qb", "main");
  writeFileSync(join(source, "version"), "one");
  git(source, "add", ".");
  git(source, "commit", "-qm", "one");
  sha = git(source, "rev-parse", "HEAD");
  f.store.setProjectRepo({ project_id: f.project_id, repo_path: source });
  f.startRun(s.coder);
  await f.deliver(s.coder, s.development.id, {
    subject: sha,
    verifiers: [s.codeReview.id],
  });
  f.endRun(s.coder);
  runtime = {
    provision: vi.fn(async (_a, _r, _m, desc) =>
      ok({
        machine_id: "local",
        runtime_machine: "local",
        terminal_ref: "t-review",
        agent_name: desc.agent_name,
      }),
    ),
    status: async () =>
      ok({ process: "alive", agent: "idle", observed_seq: 1 }),
    wake: vi.fn(async () => ok({ sent: true })),
    release: async () => ok(undefined),
    interrupt: async () => ok(undefined),
    human_entry: async () => ok("attach"),
    resume_or_replace: async () => ({
      ok: false,
      error: { code: "runtime_unavailable", message: "unused" },
    }),
  };
});
afterEach(() => f.close());

const root = () => join(f.dataDir, "agent");
const buildPath = () => join(root(), "builds", f.project_id, s.reviewer.id);
const clone = () => join(root(), "repos", f.project_id);
const central = () => join(f.dataDir, "central", `${f.project_id}.git`);
const refs = (repository: string) =>
  git(repository, "for-each-ref", "--format=%(refname) %(objectname)");

async function startReviewer(): Promise<Run> {
  const run = f.apply((state, actor, ports) =>
    queueRun(
      state,
      actor,
      {
        assignment_id: s.reviewer.id,
        model: "fixture-model",
        agent_cli_version: "pi fixture",
      },
      ports,
    ),
  );
  await startQueuedRun(
    {
      store: f.store,
      runtime,
      launch,
      mcpUrl: "http://localhost/mcp",
      dataDir: f.dataDir,
    },
    {
      project: f.project_id,
      assignment: s.reviewer,
      run,
      bell: "review current delivery",
    },
  );
  return f.apply(
    (state, actor, ports) =>
      acknowledgeRun(state, actor, { run_id: run.id }, ports),
    f.actorFor(s.reviewer),
  );
}
const serverGit = () => new ServerGit({ store: f.store, dataDir: f.dataDir });
const cleanup = () =>
  new CleanupExecutor({
    store: f.store,
    git: serverGit(),
    runtime,
    clock: f.clock,
    report: (message) => {
      throw new Error(message);
    },
  });

test("a readonly verifier gets a writable, detached checkout of the delivery SHA", async () => {
  await startReviewer();
  const build = buildPath();
  // Separate from the readonly review worktree, which stays where it was.
  const review = join(root(), "worktrees", f.project_id, s.reviewer.id);
  expect(git(review, "rev-parse", "HEAD")).toBe(sha);
  expect(git(build, "rev-parse", "HEAD")).toBe(sha);
  expect(() => git(build, "symbolic-ref", "HEAD")).toThrow();
  expect(readFileSync(join(build, "version"), "utf8")).toBe("one");
  // Writable: a build may create outputs and even edit tracked files.
  writeFileSync(join(build, "version"), "built");
  mkdirSync(join(build, "node_modules"));
  expect(readFileSync(join(review, "version"), "utf8")).toBe("one");
  // The Agent is told where it is, on start and on every later wake.
  const first = readFileSync(
    join(
      executionPaths(
        { mode: "local", dataDir: f.dataDir },
        f.project_id,
        s.reviewer.id,
      ).runDir,
      "first.md",
    ),
    "utf8",
  );
  expect(first).toContain(`可写构建目录：${build}`);
  expect(first).toContain(sha);
  // Git safety exceptions include the build path, so `git` works inside it.
  const script = readFileSync(
    join(
      executionPaths(
        { mode: "local", dataDir: f.dataDir },
        f.project_id,
        s.reviewer.id,
      ).runDir,
      "launch.sh",
    ),
    "utf8",
  );
  expect(script).toContain(build);
});

test("the build checkout creates no branch, never touches the central repository and is not backed up", async () => {
  await startReviewer();
  const centralBefore = refs(central());
  const branchesBefore = git(clone(), "for-each-ref", "refs/heads");
  const build = buildPath();
  // Registered detached: placing the build created no branch at all.
  expect(git(clone(), "worktree", "list", "--porcelain")).toContain(
    `worktree ${build}\nHEAD ${sha}\ndetached`,
  );
  // A verifier commit in its build stays local to the disposable checkout.
  writeFileSync(join(build, "version"), "tampered");
  git(build, "commit", "-qam", "verifier experiment");
  const tampered = git(build, "rev-parse", "HEAD");
  expect(git(clone(), "for-each-ref", "refs/heads")).toBe(branchesBefore);
  f.endRun(s.reviewer);
  await cleanup().tick(f.project_id);
  expect(existsSync(build)).toBe(false);
  expect(git(clone(), "worktree", "list", "--porcelain")).not.toContain(build);
  // Removal neither backs the commit up nor moves any central ref.
  expect(refs(central())).toBe(centralBefore);
  expect(git(clone(), "for-each-ref", "refs/heads")).toBe(branchesBefore);
  expect(() =>
    git(central(), "cat-file", "-e", `${tampered}^{commit}`),
  ).toThrow();
});

test("cleanup keeps the checkout while the Run is unfinished and removes it after", async () => {
  await startReviewer();
  const build = buildPath();
  await cleanup().tick(f.project_id);
  expect(existsSync(build)).toBe(true);
  f.endRun(s.reviewer);
  await cleanup().tick(f.project_id);
  expect(existsSync(build)).toBe(false);
  // Idempotent: a second round finds nothing to do.
  await cleanup().tick(f.project_id);
  expect(existsSync(build)).toBe(false);
});

test("removal re-checks idleness under the repository lock", async () => {
  await startReviewer();
  const git = serverGit();
  const project = git.projectOf(f.project_id);
  if (!project) throw new Error("missing project");
  expect(
    await git.removeBuildCheckout({
      project,
      assignment_id: s.reviewer.id,
      idle: () => false,
    }),
  ).toEqual({ status: "in_use" });
  expect(existsSync(buildPath())).toBe(true);
  expect(await git.listBuildCheckouts(project)).toEqual([s.reviewer.id]);
});

test("a later Run at a new delivery replaces the checkout; the same SHA keeps it", async () => {
  await startReviewer();
  const build = buildPath();
  mkdirSync(join(build, "node_modules"));
  f.endRun(s.reviewer);
  // Same SHA, cleanup not yet run: the next Run keeps the installed deps.
  await startReviewer();
  expect(existsSync(join(build, "node_modules"))).toBe(true);
  f.endRun(s.reviewer);
  writeFileSync(join(source, "version"), "two");
  git(source, "add", ".");
  git(source, "commit", "-qm", "two");
  const next = git(source, "rev-parse", "HEAD");
  await new CentralRepositoryService(
    new CentralGitTransport({ dataDir: f.dataDir }),
    { dataDir: f.dataDir },
  ).syncFromSource({
    project_id: f.project_id,
    source_repo: source,
    base_branch: "main",
  });
  f.startRun(s.coder);
  await f.deliver(s.coder, s.development.id, {
    subject: next,
    verifiers: [s.codeReview.id],
  });
  f.endRun(s.coder);
  await startReviewer();
  expect(git(build, "rev-parse", "HEAD")).toBe(next);
  expect(existsSync(join(build, "node_modules"))).toBe(false);
});

test("reconcile does not report a build checkout in use or within the cleanup grace", async () => {
  await startReviewer();
  const reconcile = new ReconcileExecutor({
    store: f.store,
    git: serverGit(),
    clock: f.clock,
  });
  await reconcile.tick(f.project_id);
  const findings = () =>
    f.store.database
      .prepare(
        "SELECT kind, path FROM reconcile_findings WHERE project_id = ? AND resolved_at IS NULL",
      )
      .all(f.project_id) as { kind: string; path: string | null }[];
  expect(findings().filter((row) => row.path?.includes("builds"))).toEqual([]);
  f.endRun(s.reviewer);
  await reconcile.tick(f.project_id);
  expect(findings().filter((row) => row.path?.includes("builds"))).toEqual([]);
  // A checkout the cleanup loop failed to remove is reported after the grace.
  const later = new Date(Date.parse(f.clock.now()) + 3_600_000).toISOString();
  await new ReconcileExecutor({
    store: f.store,
    git: serverGit(),
    clock: { now: () => later },
  }).tick(f.project_id);
  expect(findings().filter((row) => row.path?.includes("builds"))).toEqual([
    { kind: "orphan_worktree", path: buildPath() },
  ]);
});

test("Run facts: queued and unknown keep the checkout; finished Runs report their latest end", () => {
  const run = (id: string, status: Run["status"], finished_at?: string): Run =>
    ({
      id,
      assignment_id: "A-1",
      status,
      ...(finished_at ? { finished_at } : {}),
    }) as Run;
  for (const status of [
    "queued",
    "dispatched",
    "acked",
    "running",
    "unknown",
  ] as const)
    expect(buildCheckoutIdle([run("R-1", status)], "A-1")).toBe(false);
  expect(
    buildCheckoutIdle([run("R-1", "completed", "2026-01-01T00:00:00Z")], "A-1"),
  ).toBe(true);
  expect(buildCheckoutIdle([run("R-1", "running")], "A-2")).toBe(true);
  expect(
    buildCheckoutFacts([
      run("R-1", "completed", "2026-01-01T00:00:00Z"),
      run("R-2", "failed", "2026-01-02T00:00:00Z"),
    ]),
  ).toEqual([
    {
      assignment_id: "A-1",
      unfinished: false,
      finished_at: "2026-01-02T00:00:00Z",
    },
  ]);
});

test("only a readonly verifier at a delivery SHA gets a build checkout", async () => {
  const service = new GitWorktreeService(
    new LocalGitTransport(),
    new CentralRepositoryService(
      new CentralGitTransport({ dataDir: f.dataDir }),
      { dataDir: f.dataDir },
    ),
    { dataDir: f.dataDir },
  );
  const entities = (assignment: typeof s.coder) => {
    const found = launchEntities(f.store, f.project_id, assignment.id);
    return {
      project_id: f.project_id,
      source_repo: source,
      assignment: found.assignment,
      role: found.role,
      card: found.card,
      work_item: found.workItem,
    };
  };
  // A writer never gets one, even when asked with a SHA.
  expect(
    await service.ensureBuildCheckout({
      ...(entities(s.coder) as object),
      target_sha: sha,
    } as never),
  ).toBeUndefined();
  await expect(
    service.ensureBuildCheckout({
      ...(entities(s.reviewer) as object),
      target_sha: "main",
    } as never),
  ).rejects.toThrow(/delivery commit SHA/);
  expect(existsSync(join(root(), "builds"))).toBe(false);
});

test("the prompt names the build checkout, or says it is unavailable", () => {
  expect(
    worktreeBaselinePrompt({
      path: "/w",
      base_sha: sha,
      build: { path: "/b", sha },
    }),
  ).toBe(
    `可写构建目录：/b（交付 ${sha} 的独立检出，可安装依赖、构建和跑测试；只读 worktree 保持不动。本次 Run 结束后主机会删除它，里面的改动不会保留，也不会被拉取、交付或合并）。`,
  );
  expect(
    worktreeBaselinePrompt({
      path: "/w",
      base_sha: sha,
      build: { unavailable: true },
    }),
  ).toContain("本次没有可写构建目录");
  expect(worktreeBaselinePrompt({ path: "/w", base_sha: sha })).toBeUndefined();
});
