import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  acknowledgeRun,
  queueRun,
  type Run,
  type Runtime,
  releaseAssignment,
} from "@cardigan/domain";
import {
  CentralRepositoryService,
  GitWorktreeService,
} from "@cardigan/git-service";
import {
  CentralGitTransport,
  LocalGitTransport,
} from "@cardigan/git-transport";
import {
  launchEntities,
  prepareRoleWorktree,
  sessionFingerprint,
  VERIFIER_LAUNCH_REVISION,
  withPreparationQueue,
  worktreeBaselinePrompt,
  worktreeProvider,
} from "@cardigan/host";
import { parseLaunchConfig } from "@cardigan/roles";
import { executionPaths } from "@cardigan/runtime-herdr";
import { moveNotification, recordNotification } from "@cardigan/store";
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
  // Dependency installs in the build copy from the shared store (no hardlinks).
  expect(script).toContain("export pnpm_config_package_import_method='copy'");
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
  await cleanup().sweep(f.project_id);
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
  await cleanup().sweep(f.project_id);
  expect(existsSync(build)).toBe(true);
  f.endRun(s.reviewer);
  await cleanup().sweep(f.project_id);
  expect(existsSync(build)).toBe(false);
  // Idempotent: a second round finds nothing to do.
  await cleanup().sweep(f.project_id);
  expect(existsSync(build)).toBe(false);
});

test("an undelivered resume arriving under the removal lock preserves the original review build", async () => {
  await startReviewer();
  f.endRun(s.reviewer);
  const file = join(buildPath(), "scratch");
  writeFileSync(file, "reviewer-local");
  const before = refs(central());
  const service = serverGit();
  const remove = service.removeBuildCheckout.bind(service);
  const createFailure = () =>
    f.store.uow.run((tx) => {
      const at = f.clock.now(),
        card = s.development.card_id;
      const event = {
        type: "work_item_resume_requested",
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(f.project_id, card),
        card_id: card,
        actor: { kind: "system" as const, project_id: f.project_id },
        created_at: at,
        payload: {
          assignment_id: s.reviewer.id,
          work_item_id: s.codeReview.id,
        },
      };
      tx.events.append(f.project_id, event);
      const { notification } = recordNotification(f.store.database, {
        project_id: f.project_id,
        event_id: event.id,
        card_id: card,
        seq: event.seq,
        at,
        kind: "assignment",
        recipient: { kind: "assignment", assignment_id: s.reviewer.id },
      });
      moveNotification(f.store.database, {
        project_id: f.project_id,
        id: notification.id,
        event: "deliver_failed",
        at,
      });
    });
  const spy = vi
    .spyOn(service, "removeBuildCheckout")
    .mockImplementationOnce((input) => {
      createFailure();
      return remove(input);
    });
  const loop = new CleanupExecutor({
    store: f.store,
    git: service,
    runtime,
    clock: f.clock,
  });
  await loop.tick(f.project_id);
  await loop.tick(f.project_id);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(readFileSync(file, "utf8")).toBe("reviewer-local");
  expect(refs(central())).toBe(before);
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

test("background checkout listing yields to preparation and resumes afterwards", async () => {
  await startReviewer();
  const git = serverGit();
  const project = git.projectOf(f.project_id);
  if (!project) throw new Error("missing project");
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const preparing = withPreparationQueue(f.dataDir, f.project_id, async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await ready;
  try {
    expect(await git.listBuildCheckouts(project)).toBeUndefined();
    expect(existsSync(buildPath())).toBe(true);
  } finally {
    release();
    await preparing;
  }
  expect(await git.listBuildCheckouts(project)).toEqual([s.reviewer.id]);
});

test("Q-489 caches candidate listings for 60 seconds and invalidates on preparation, delivery and cleanup", async () => {
  await startReviewer();
  const service = serverGit(),
    project = service.projectOf(f.project_id);
  if (!project) throw new Error("Missing project");
  const list = vi.spyOn(GitWorktreeService.prototype, "listBuildCheckouts");
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  try {
    expect(await service.listBuildCheckouts(project)).toEqual([s.reviewer.id]);
    now = 59999;
    expect(await service.listBuildCheckouts(project)).toEqual([s.reviewer.id]);
    expect(list).toHaveBeenCalledTimes(1);
    now = 60000;
    await service.listBuildCheckouts(project);
    expect(list).toHaveBeenCalledTimes(2);
    await withPreparationQueue(f.dataDir, f.project_id, async () => undefined);
    await service.listBuildCheckouts(project);
    expect(list).toHaveBeenCalledTimes(3);
    f.store.uow.run((tx) => {
      const delivery = tx.deliveries.list(f.project_id)[0];
      if (!delivery) throw new Error("Missing delivery");
      tx.deliveries.put(f.project_id, { ...delivery, summary: "updated" });
    });
    await service.listBuildCheckouts(project);
    expect(list).toHaveBeenCalledTimes(4);
    await service.removeBuildCheckout({
      project,
      assignment_id: s.reviewer.id,
      idle: () => false,
    });
    await service.listBuildCheckouts(project);
    expect(list).toHaveBeenCalledTimes(5);
    expect(existsSync(buildPath())).toBe(true);
  } finally {
    clock.mockRestore();
    list.mockRestore();
  }
});

test("listing failure is never cached as an empty result", async () => {
  const service = serverGit(),
    project = service.projectOf(f.project_id);
  if (!project) throw new Error("Missing project");
  const list = vi
    .spyOn(GitWorktreeService.prototype, "listBuildCheckouts")
    .mockRejectedValueOnce(new Error("scan failed"))
    .mockResolvedValue([s.reviewer.id]);
  try {
    await expect(service.listBuildCheckouts(project)).rejects.toThrow(
      "scan failed",
    );
    expect(await service.listBuildCheckouts(project)).toEqual([s.reviewer.id]);
    expect(await service.listBuildCheckouts(project)).toEqual([s.reviewer.id]);
    expect(list).toHaveBeenCalledTimes(2);
  } finally {
    list.mockRestore();
  }
});

test("every Run starts from a fresh checkout, even at the same SHA", async () => {
  await startReviewer();
  const build = buildPath();
  // The previous Run edited, staged and added sources and installed deps.
  writeFileSync(join(build, "version"), "patched-by-prior-run");
  writeFileSync(join(build, "staged"), "staged source");
  git(build, "add", "staged");
  writeFileSync(join(build, "extra.ts"), "untracked source");
  mkdirSync(join(build, "node_modules"));
  f.endRun(s.reviewer);
  // Same SHA and the cleanup loop has not run yet.
  await startReviewer();
  expect(git(build, "rev-parse", "HEAD")).toBe(sha);
  expect(readFileSync(join(build, "version"), "utf8")).toBe("one");
  expect(git(build, "status", "--porcelain", "--ignored")).toBe("");
  for (const name of ["staged", "extra.ts", "node_modules"])
    expect(existsSync(join(build, name))).toBe(false);
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
  expect(readFileSync(join(build, "version"), "utf8")).toBe("two");
});

test("C-211 a verifier's own untracked files are cleaned through Git and a blocked removal keeps its registration", async () => {
  await startReviewer();
  const build = buildPath();
  // A dev server the verifier started left caches and dependencies behind.
  const deps = join(build, "apps", "web", ".vite", "deps");
  mkdirSync(deps, { recursive: true });
  writeFileSync(join(deps, "chunk.js"), "cache");
  mkdirSync(join(build, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(build, "node_modules", "pkg", "index.js"), "dep");
  f.endRun(s.reviewer);
  const server = serverGit();
  const project = server.projectOf(f.project_id);
  if (!project) throw new Error("missing project");
  // An entry Git cannot delete yet (e.g. still being written).
  chmodSync(deps, 0o555);
  try {
    await expect(
      server.removeBuildCheckout({
        project,
        assignment_id: s.reviewer.id,
        idle: () => true,
      }),
    ).rejects.toThrow();
    // Still registered: the next round can retry instead of hitting
    // unregistered leftovers the host must not recurse into.
    expect(git(clone(), "worktree", "list", "--porcelain")).toContain(build);
  } finally {
    chmodSync(deps, 0o755);
  }
  expect(
    await server.removeBuildCheckout({
      project,
      assignment_id: s.reviewer.id,
      idle: () => true,
    }),
  ).toEqual({ status: "removed" });
  expect(existsSync(build)).toBe(false);
  expect(git(clone(), "worktree", "list", "--porcelain")).not.toContain(build);
  // The next Run prepares a fresh checkout instead of failing.
  await startReviewer();
  expect(git(build, "rev-parse", "HEAD")).toBe(sha);
  expect(existsSync(join(build, "apps"))).toBe(false);
});

test("C-211 cleaning refuses a directory that is not a registered checkout", async () => {
  await startReviewer();
  const stray = join(root(), "builds", f.project_id, "A-999");
  mkdirSync(join(stray, "keep"), { recursive: true });
  writeFileSync(join(stray, "keep", "file"), "not a checkout");
  await expect(
    new LocalGitTransport().cleanBuildCheckout(clone(), stray),
  ).rejects.toThrow(/not registered/);
  expect(existsSync(join(stray, "keep", "file"))).toBe(true);
});

test("a registration whose directory vanished is rebuilt and also cleaned up", async () => {
  await startReviewer();
  const build = buildPath();
  rmSync(build, { recursive: true, force: true });
  f.endRun(s.reviewer);
  // The next Run recovers instead of returning a directory that is not there.
  await startReviewer();
  expect(git(build, "rev-parse", "HEAD")).toBe(sha);
  expect(readFileSync(join(build, "version"), "utf8")).toBe("one");
  // Without a next Run, cleanup still finds and removes the stale entry.
  rmSync(build, { recursive: true, force: true });
  const project = serverGit().projectOf(f.project_id);
  if (!project) throw new Error("missing project");
  expect(await serverGit().listBuildCheckouts(project)).toEqual([
    s.reviewer.id,
  ]);
  f.endRun(s.reviewer);
  await cleanup().sweep(f.project_id);
  expect(git(clone(), "worktree", "list", "--porcelain")).not.toContain(build);
  expect(await serverGit().listBuildCheckouts(project)).toEqual([]);
});

test("a failed preparation is a diagnosable start failure, on the server and the CLI path", async () => {
  // Unregistered leftovers the host must not recurse into block a fresh build.
  mkdirSync(join(buildPath(), "leftover"), { recursive: true });
  await expect(
    prepareRoleWorktree(
      {
        store: f.store,
        execution: { mode: "local", dataDir: f.dataDir },
        runtime,
      },
      f.project_id,
      s.reviewer.id,
    ),
  ).rejects.toThrow(/unregistered leftover contents/);
  const entities = launchEntities(f.store, f.project_id, s.reviewer.id);
  // `cardigan assignment start` uses this provider directly.
  await expect(
    worktreeProvider(
      { mode: "local", dataDir: f.dataDir },
      runtime,
    )({
      project_id: f.project_id,
      source_repo: source,
      assignment: entities.assignment,
      role: entities.role,
      card: entities.card,
      work_item: entities.workItem,
      target_sha: sha,
    }),
  ).rejects.toThrow(/unregistered leftover contents/);
  // The Dispatcher's start path reports it as a launch failure; no Agent starts.
  await expect(startReviewer()).rejects.toThrow();
  expect(runtime.provision).not.toHaveBeenCalled();
  expect(existsSync(join(buildPath(), "leftover"))).toBe(true);
});

test("a released Assignment keeps its build until its terminal exit is confirmed", async () => {
  await startReviewer();
  f.endRun(s.reviewer);
  f.apply((state, actor, ports) =>
    releaseAssignment(state, actor, { assignment_id: s.reviewer.id }, ports),
  );
  const reports: string[] = [];
  let release = false;
  runtime.release = async () =>
    release
      ? ok(undefined)
      : {
          ok: false as const,
          error: { code: "runtime_unavailable", message: "still alive" },
        };
  runtime.status = async () =>
    ok({ process: "alive", agent: "working", observed_seq: 1 });
  const executor = new CleanupExecutor({
    store: f.store,
    git: serverGit(),
    runtime,
    clock: f.clock,
    report: (message) => reports.push(message),
  });
  await executor.sweep(f.project_id);
  expect(existsSync(buildPath())).toBe(true);
  expect(reports.some((r) => r.includes("terminal release"))).toBe(true);
  release = true;
  await executor.sweep(f.project_id);
  expect(existsSync(buildPath())).toBe(false);
});

test("a push from the build checkout stops at a central repository the Agent account cannot access", async () => {
  await startReviewer();
  const build = buildPath();
  const before = refs(central());
  writeFileSync(join(build, "version"), "pushed by verifier");
  git(build, "commit", "-qam", "attempted push");
  // agent-ssh layout: the center sits in the host's private 0700 data
  // directory, which the agent account cannot enter. Emulate that here.
  const parent = join(f.dataDir, "central");
  chmodSync(parent, 0o000);
  try {
    for (const target of [
      "HEAD:refs/heads/main",
      "HEAD:refs/cardigan/deliveries/D-999",
    ])
      expect(() => git(build, "push", "origin", target)).toThrow(
        /Permission denied|does not appear to be a git repository/,
      );
  } finally {
    chmodSync(parent, 0o700);
  }
  expect(refs(central())).toBe(before);
  // The build's origin is that host-private center, never another Agent path.
  expect(git(build, "config", "--get", "remote.origin.url")).toBe(central());
});

test("preparing and removing a build touches no other Assignment directory or shared cache", async () => {
  // A shared dependency cache and another Assignment's worktree beside it.
  const cache = join(root(), "cache", "pnpm-store");
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "index"), "content-addressed");
  f.startRun(s.coder);
  const coderTree = join(root(), "worktrees", f.project_id, s.coder.id);
  mkdirSync(coderTree, { recursive: true });
  writeFileSync(join(coderTree, "work"), "coder work");
  f.endRun(s.coder);
  const snapshot = () =>
    JSON.stringify(
      [cache, coderTree].map((dir) =>
        readdirSync(dir, { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => {
            const path = join(entry.parentPath, entry.name);
            const info = statSync(path);
            return [path, info.mtimeMs, readFileSync(path, "utf8")];
          }),
      ),
    );
  const before = snapshot();
  await startReviewer();
  // The verifier builds: outputs stay inside its own leaf.
  mkdirSync(join(buildPath(), "node_modules", ".pnpm"), { recursive: true });
  writeFileSync(join(buildPath(), "node_modules", ".pnpm", "lock"), "x");
  f.endRun(s.reviewer);
  await cleanup().sweep(f.project_id);
  expect(existsSync(buildPath())).toBe(false);
  expect(snapshot()).toBe(before);
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

test("the prompt names the fresh build checkout", () => {
  expect(
    worktreeBaselinePrompt({
      path: "/w",
      base_sha: sha,
      build: { path: "/b", sha },
    }),
  ).toBe(
    `可写构建目录：/b（交付 ${sha} 的全新独立检出，可安装依赖、构建和跑测试；只读 worktree 保持不动。本次 Run 结束后主机会删除它，里面的改动不会保留，也不会被拉取、交付或合并）。`,
  );
  expect(worktreeBaselinePrompt({ path: "/w", base_sha: sha })).toBeUndefined();
});

test("a verifier session launched without the build environment is fingerprinted for one replacement", async () => {
  // Sessions launched by this version record the verifier revision...
  await startReviewer();
  const recorded = f
    .state()
    .runs.filter((run) => run.assignment_id === s.reviewer.id)
    .at(-1)?.tool_catalog;
  expect(recorded?.endsWith(`+${VERIFIER_LAUNCH_REVISION}`)).toBe(true);
  // ...which an older session's bare catalog never equals, so the Dispatcher's
  // existing comparison (P2a-10 A) replaces it before its next wake.
  const bare = recorded?.slice(0, -`+${VERIFIER_LAUNCH_REVISION}`.length);
  const reviewer = launchEntities(f.store, f.project_id, s.reviewer.id);
  expect(sessionFingerprint(bare, reviewer.role, reviewer.assignment)).toBe(
    recorded,
  );
  expect(bare).not.toBe(recorded);
  // Writers and standing sessions keep their fingerprint: no replacement.
  const coder = launchEntities(f.store, f.project_id, s.coder.id);
  expect(sessionFingerprint("c", coder.role, coder.assignment)).toBe("c");
  expect(sessionFingerprint("c", reviewer.role, { scope: "standing" })).toBe(
    "c",
  );
  expect(
    sessionFingerprint(undefined, reviewer.role, reviewer.assignment),
  ).toBeUndefined();
});
