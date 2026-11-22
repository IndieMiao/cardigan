/**
 * M4.4 reconciliation and backup loops (plan §3.6, §3.7; §12.6).
 *
 * Real Git in temporary repositories: findings come from comparing the base
 * clone, the worktree directory and the database, a Git delivery without its
 * fixed ref is repaired from the candidate ref, and the backup fetch moves
 * `agent/*` into the central repository without touching business state.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CardId,
  DeliveryId,
  GitWorkspaceFiles,
  MergeCheckView,
} from "@cardigan/domain";
import {
  type CentralProject,
  CentralRepositoryService,
  GitWorktreeService,
  type ReconcileChecks,
} from "@cardigan/git-service";
import { CentralGitTransport } from "@cardigan/git-transport";
import { PROJECT_EVENT_STREAM } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ServerGit } from "./git.js";
import {
  acceptThroughMergeGate,
  type M4Fixture,
  type M4Scenario,
  m4Fixture,
  m4Scenario,
} from "./m4-fixtures.js";
import { BackupExecutor, ReconcileExecutor } from "./reconcile-loop.js";
import {
  type ProfileLine,
  profileTick,
  setTickProfiler,
  TickProfiler,
} from "./tick-profile.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      ...args,
    ],
    { encoding: "utf8" },
  ).trim();

let f: M4Fixture;
let scenario: M4Scenario;
let root: string;
let source: string;
let base: string;
let project: CentralProject;
let central: CentralRepositoryService;
let errors: string[];

const commitOn = (cwd: string, name: string, text: string) => {
  writeFileSync(join(cwd, name), text);
  git(cwd, "add", name);
  git(cwd, "commit", "-m", text);
  return git(cwd, "rev-parse", "HEAD");
};

beforeEach(() => {
  f = m4Fixture();
  root = mkdtempSync(join(tmpdir(), "cardigan-reconcile-"));
  source = join(root, "source");
  git(root, "init", "-q", "-b", "main", source);
  commitOn(source, "README.md", "fixture\n");
  f.store.setProjectRepo({
    project_id: f.project_id,
    repo_path: source,
    base_branch: "main",
  });
  project = {
    project_id: f.project_id,
    source_repo: source,
    base_branch: "main",
  };
  central = new CentralRepositoryService(
    new CentralGitTransport({ dataDir: f.dataDir }),
    { dataDir: f.dataDir },
  );
  base = join(f.dataDir, "agent", "repos", f.project_id);
  errors = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  f.close();
  rmSync(root, { recursive: true, force: true });
});

test.skipIf(process.env.CARDIGAN_TICK_PROFILE !== "1")(
  "C-245 profiles cold and unchanged reconcile/backup ticks with real Git",
  async () => {
    await centralWithBaseClone();
    git(base, "checkout", "-q", "-b", "agent/C-1/W-1");
    commitOn(base, "work.txt", "profile fixture\n");
    const binding = new ServerGit({ store: f.store, dataDir: f.dataDir });
    const options = { store: f.store, git: binding, clock: f.clock };
    const reconcile = new ReconcileExecutor(options);
    const backup = new BackupExecutor(options);
    const lines: ProfileLine[] = [];
    const profiler = new TickProfiler({
      log: (line) => lines.push(line),
      reportIntervalMs: 0,
    });
    f.store.observe(profiler.storeObserver);
    setTickProfiler(profiler);
    const commands = vi.spyOn(
      CentralGitTransport.prototype as unknown as {
        command: (repository: string, args: string[]) => Promise<unknown>;
      },
      "command",
    );
    try {
      for (let tick = 0; tick < 3; tick++) {
        await profileTick("reconcile", () => reconcile.tick(f.project_id));
        await profileTick("backup", () => backup.tick(f.project_id));
      }
    } finally {
      setTickProfiler(undefined);
      profiler.stop();
    }
    console.log(
      JSON.stringify({
        profile: lines,
        fetches: commands.mock.calls.filter(([, args]) => args[0] === "fetch")
          .length,
        git_commands: commands.mock.calls.length,
      }),
    );
    expect(lines.filter((line) => line.event === "tick_profile")).toHaveLength(
      6,
    );
  },
);

const reconcile = () =>
  new ReconcileExecutor({
    store: f.store,
    git: new ServerGit({ store: f.store, dataDir: f.dataDir }),
    clock: f.clock,
    report: (message) => errors.push(message),
    onError: (error) => errors.push(String(error)),
  });

async function centralWithBaseClone() {
  scenario = m4Scenario(f, "auto");
  const repository = await central.ensureCentral(project);
  mkdirSync(join(f.dataDir, "agent", "repos"), { recursive: true });
  git(root, "clone", "-q", "--no-local", repository, base);
  return repository;
}

test("reconcile consumes new events only, publishes cursors after commit and rebuilds on restart", async () => {
  scenario = m4Scenario(f, "auto");
  const second = m4Scenario(f, "auto");
  const append = (card: CardId, status: string, system = true) =>
    f.store.uow.run((tx) => {
      tx.events.append(f.project_id, {
        id: tx.ids.nextEventId(),
        card_id: card,
        seq: tx.ids.nextEventSequence(f.project_id, card),
        type: "merge_check_finished",
        actor: system ? { kind: "system", project_id: f.project_id } : f.human,
        payload: { attempt_id: card, status },
        created_at: f.clock.now(),
      });
    });
  append(scenario.card.id, "passed");
  append(second.card.id, "running");
  const binding = new ServerGit({ store: f.store, dataDir: f.dataDir });
  let checks: ReconcileChecks | undefined;
  vi.spyOn(binding, "reconcile").mockImplementation(
    async (_project, _assignments, _deliveries, readChecks) => {
      checks = readChecks?.();
      return [];
    },
  );
  const now = vi.fn(() => f.clock.now());
  const options = { store: f.store, git: binding, clock: { now } };
  const executor = new ReconcileExecutor(options);
  const parse = vi.spyOn(JSON, "parse");
  const decoded = () =>
    parse.mock.calls.filter(([text]) =>
      text.includes('"type":"merge_check_finished"'),
    ).length;
  await executor.tick(f.project_id);
  expect(decoded()).toBe(2);
  parse.mockClear();
  expect(checks?.attempts.map((c) => c.status)).toEqual(["passed", "running"]);
  await executor.tick(f.project_id);
  expect(checks?.attempts.map((c) => c.status)).toEqual(["passed", "running"]);
  expect(decoded()).toBe(0);
  append(scenario.card.id, "failed");
  append(second.card.id, "failed", false); // An untrusted event cannot change ownership.
  now.mockImplementationOnce(() => {
    throw new Error("read failed");
  });
  await expect(executor.tick(f.project_id)).rejects.toThrow("read failed");
  await executor.tick(f.project_id);
  expect(checks?.attempts.map((c) => c.status)).toEqual(["failed", "running"]);
  await new ReconcileExecutor(options).tick(f.project_id);
  expect(checks?.attempts.map((c) => c.status)).toEqual(["failed", "running"]);
});

test("reconcile and backup Git IO yields to the event loop outside database transactions", async () => {
  await centralWithBaseClone();
  git(base, "branch", "agent/C-1/W-1");
  const original = CentralGitTransport.prototype.fetchRefs;
  let calls = 0;
  vi.spyOn(CentralGitTransport.prototype, "fetchRefs").mockImplementation(
    async function (this: CentralGitTransport, ...args) {
      calls++;
      expect(f.store.database.isTransaction).toBe(false);
      let served = false;
      const pending = new Promise<void>((resolve) =>
        setImmediate(() => {
          // A request can enter a new write transaction while Git is in flight.
          f.store.uow.run(() => {
            served = true;
          });
          resolve();
        }),
      );
      await original.apply(this, args);
      expect(served).toBe(true);
      await pending;
      expect(f.store.database.isTransaction).toBe(false);
    },
  );
  const options = {
    store: f.store,
    git: new ServerGit({ store: f.store, dataDir: f.dataDir }),
  };
  await new ReconcileExecutor(options).tick(f.project_id);
  await new BackupExecutor(options).tick(f.project_id);
  // Source reconciliation, backup capture and its ref-less local import.
  expect(calls).toBe(3);
});

test.each([0, 251])(
  "local directory probes resume within count and time budgets (%i ms/probe)",
  async (cost) => {
    const binding = new ServerGit({ store: f.store, dataDir: f.dataDir });
    const refresh = vi.spyOn(binding, "refreshLocalMirror");
    const paths = Array.from({ length: 48 }, (_, i) => {
      const group = i < 16 ? "worktrees" : i < 32 ? "checks" : "builds";
      const path = join(
        f.dataDir,
        "agent",
        group,
        f.project_id,
        `leftover-${i}`,
        group === "checks" ? "worktree" : "",
      );
      mkdirSync(path, { recursive: true });
      return path;
    });
    let clock = 0,
      outstanding = 0,
      peak = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    // Instrument the real bound file port; do not substitute fake listings.
    const { files } = (
      binding as unknown as { worktrees: { files: GitWorkspaceFiles } }
    ).worktrees;
    const observe = files.isDirectory.bind(files);
    const probe = vi
      .spyOn(files, "isDirectory")
      .mockImplementation(async (path) => {
        peak = Math.max(peak, ++outstanding);
        try {
          return await observe(path);
        } finally {
          outstanding--;
          clock += cost;
        }
      });
    const executor = new ReconcileExecutor({ store: f.store, git: binding });
    const open = () =>
      f.store.listReconcileFindings(f.project_id, { openOnly: true });
    let count = 0;
    do {
      await executor.tick(f.project_id, true);
      const n = probe.mock.calls.length;
      expect(n - count).toBe(cost ? 1 : 16);
      count = n;
      if (count < paths.length) {
        expect(executor.pending(f.project_id)).toBe(true);
        expect(open()).toEqual([]);
      }
    } while (executor.pending(f.project_id));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(peak).toBe(1);
    expect(probe.mock.calls.map(([path]) => path).sort()).toEqual(paths.sort());
    expect(
      open()
        .map((fact) => fact.path)
        .sort(),
    ).toEqual(paths);
  },
);

test("an orphan directory and a manual project directory are reported", async () => {
  await centralWithBaseClone();
  // A directory nobody owns, plus one left behind in the clone root.
  const orphan = join(f.dataDir, "agent", "worktrees", f.project_id, "A-9");
  mkdirSync(orphan, { recursive: true });
  mkdirSync(join(f.dataDir, "agent", "repos", ".clone-abc"), {
    recursive: true,
  });

  await reconcile().tick(f.project_id);
  const findings = f.store.listReconcileFindings(f.project_id, {
    openOnly: true,
  });
  expect(findings.map((finding) => finding.kind).sort()).toEqual([
    "failed_clone",
    "orphan_worktree",
  ]);
  expect(findings.find((entry) => entry.kind === "orphan_worktree")?.path).toBe(
    orphan,
  );
  // A new finding becomes one project-level event for PM Ops.
  const events = f.store.uow.read((tx) =>
    tx.events
      .listAfter(f.project_id, undefined, 0)
      .filter((event) => event.type === "reconcile_finding"),
  );
  expect(events).toHaveLength(2);
  expect(events.every((event) => event.card_id === undefined)).toBe(true);
  expect(f.store.routerCursor(f.project_id, PROJECT_EVENT_STREAM)).toBe(0);

  // The next pass does not announce the same findings again.
  await reconcile().tick(f.project_id);
  expect(
    f.store.uow.read((tx) =>
      tx.events
        .listAfter(f.project_id, undefined, 0)
        .filter((event) => event.type === "reconcile_finding"),
    ),
  ).toHaveLength(2);
  // Removing one resolves that finding instead of forgetting it.
  rmSync(orphan, { recursive: true, force: true });
  await reconcile().tick(f.project_id);
  const open = f.store.listReconcileFindings(f.project_id, { openOnly: true });
  expect(open.map((entry) => entry.kind)).toEqual(["failed_clone"]);
});

test.each(["local", "agent-ssh"] as const)(
  "%s project-only Git binding protects checks queued during the scan, then reports leftovers after grace",
  async (mode) => {
    await centralWithBaseClone();
    const agentRoot = join(root, "custom-agent");
    const clone =
      mode === "local" ? base : join(agentRoot, "repos", f.project_id);
    if (mode === "agent-ssh") {
      mkdirSync(join(agentRoot, "repos"), { recursive: true });
      git(
        root,
        "clone",
        "-q",
        "--no-local",
        await central.ensureCentral(project),
        clone,
      );
    }
    const binding = new ServerGit({
      store: {
        getProject: (id) => f.store.getProject(id),
        listProjects: () => f.store.listProjects(),
      },
      dataDir: f.dataDir,
      checkCleanupGraceMs: 1000,
      ...(mode === "agent-ssh"
        ? {
            execution: {
              mode,
              dataDir: f.dataDir,
              agentRoot,
              gid: 2001,
              machine: "fixture-agent",
              identityFile: join(root, "no-key"),
              knownHostsFile: join(root, "no-known-hosts"),
            },
            captureAgent: async (_command: "git", args: readonly string[]) => ({
              ok: true as const,
              value: git(root, ...args),
            }),
          }
        : {}),
    });
    const checks = join(
      mode === "local" ? join(f.dataDir, "agent") : agentRoot,
      "checks",
      f.project_id,
    );
    const path = join(checks, "attempt-1", "worktree");
    git(clone, "worktree", "add", "--detach", path, "HEAD");
    let at = f.clock.now();
    const update = (status: MergeCheckView["status"]) =>
      f.store.uow.run((tx) => {
        tx.events.append(f.project_id, {
          id: tx.ids.nextEventId(),
          card_id: scenario.card.id,
          seq: tx.ids.nextEventSequence(f.project_id, scenario.card.id),
          type:
            status === "queued"
              ? "merge_check_queued"
              : status === "running"
                ? "merge_check_started"
                : "merge_check_finished",
          actor: { kind: "system", project_id: f.project_id },
          payload: { attempt_id: "attempt-1", status },
          created_at: at,
        });
      });
    const executor = new ReconcileExecutor({
      store: f.store,
      git: binding,
      clock: { now: () => at },
    });
    const open = () =>
      f.store.listReconcileFindings(f.project_id, { openOnly: true });
    const scan = GitWorktreeService.prototype.listWorktreeStatePages;
    vi.spyOn(
      GitWorktreeService.prototype,
      "listWorktreeStatePages",
    ).mockImplementationOnce(async function* (
      this: GitWorktreeService,
      project,
    ) {
      const snapshot = yield* scan.call(this, project);
      // A check can be queued while filesystem IO is in flight. Its new
      // ownership must be read from the loop's Store after that IO completes.
      update("queued");
      return snapshot;
    });
    await executor.tick(f.project_id);
    expect(open()).toEqual([]);
    update("running");
    await executor.tick(f.project_id);
    expect(open()).toEqual([]);
    update("passed");
    at = new Date(Date.parse(at) + 1000).toISOString();
    await executor.tick(f.project_id);
    expect(open()).toEqual([]);
    at = new Date(Date.parse(at) + 1).toISOString();
    await executor.tick(f.project_id);
    expect(open()).toEqual([
      expect.objectContaining({ kind: "orphan_worktree", path }),
    ]);
    expect(existsSync(path)).toBe(true);
    rmSync(path, { recursive: true });
    await executor.tick(f.project_id);
    expect(open()).toEqual([
      expect.objectContaining({ kind: "stale_registration", path }),
    ]);
    git(clone, "worktree", "prune");
    // A leftover directory without a Git registration is still discovered.
    mkdirSync(path);
    await executor.tick(f.project_id);
    expect(open()).toEqual([
      expect.objectContaining({ kind: "orphan_worktree", path }),
    ]);
    rmSync(path, { recursive: true });
    await executor.tick(f.project_id);
    expect(open()).toEqual([]);
  },
);

test("a Git delivery without a fixed ref is repaired from its candidate", async () => {
  const repository = await centralWithBaseClone();
  const agent = join(root, "agent-clone");
  git(root, "clone", "-q", source, agent);
  git(agent, "checkout", "-q", "-b", "agent/C-1/W-1");
  const sha = commitOn(agent, "feature.txt", "feature\n");
  const { product } = await acceptThroughMergeGate(f, scenario, sha);
  // Publish the object and the candidate ref, but deliberately not the delivery.
  await central.git.fetchRefs(repository, agent, [`+${sha}:${sha}`]);
  await central.createRef(
    repository,
    `refs/cardigan/candidates/${scenario.coder.id}/${sha}`,
    sha,
  );

  await reconcile().tick(f.project_id);
  const pinned = await central.pinnedDeliveries(project);
  expect(pinned.get(product.id)).toBe(sha);
  expect(
    f.store
      .listReconcileFindings(f.project_id, { openOnly: true })
      .some((finding) => finding.kind === "missing_delivery_ref"),
  ).toBe(false);
});

test.each([true, false])(
  "repair pages never announce an unattempted delivery (last pin succeeds: %s)",
  async (allRepairable) => {
    scenario = m4Scenario(f, "auto");
    f.startRun(scenario.coder);
    const product = await f.deliver(scenario.coder, scenario.development.id, {
      subject: git(source, "rev-parse", "HEAD"),
      verifiers: [scenario.codeReview.id],
    });
    const put = (i: number) => {
      const id = `D-${100 + i}` as DeliveryId;
      f.store.uow.run((tx) =>
        tx.deliveries.put(f.project_id, { ...product, id }),
      );
      return id;
    };
    const failed = put(15);
    const ids = [
      product.id,
      ...Array.from({ length: 15 }, (_, i) => put(i)),
      failed,
    ];
    const pinned = new Set<DeliveryId>();
    const binding = new ServerGit({ store: f.store, dataDir: f.dataDir });
    vi.spyOn(binding, "reconcilePages").mockImplementation(
      async function* (_project, _assignments, deliveries) {
        return deliveries
          .filter((d) => !pinned.has(d.id))
          .map((d) => ({
            kind: "missing_delivery_ref" as const,
            delivery_id: d.id,
            detail: "test pin",
          }));
      },
    );
    const repair = vi
      .spyOn(binding, "repairPin")
      .mockImplementation(async (_, d) => {
        if (!allRepairable && d.id === failed) return false;
        pinned.add(d.id);
        return true;
      });
    vi.spyOn(performance, "now").mockReturnValue(0);
    const executor = new ReconcileExecutor({ store: f.store, git: binding });
    const events = () =>
      f.store.uow.read((tx) =>
        tx.events
          .listAfter(f.project_id, undefined, 0)
          .filter((e) => e.type === "reconcile_finding")
          .map((e) => (e.payload as { delivery_id: string }).delivery_id),
      );
    const open = () =>
      f.store
        .listReconcileFindings(f.project_id, { openOnly: true })
        .map((f) => f.delivery_id);
    await executor.tick(f.project_id, true);
    expect(repair).toHaveBeenCalledTimes(16);
    expect(executor.pending(f.project_id)).toBe(true);
    expect(open()).toEqual([]);
    expect(events()).toEqual([]);
    // A delivery added between pages first appears on the rescan. It too must
    // receive its repair attempt before this sweep is allowed to notify PM Ops.
    ids.push(put(20));
    for (let i = 0; i < 5 && executor.pending(f.project_id); i++) {
      expect(events()).toEqual([]);
      await executor.tick(f.project_id, true);
    }
    expect(executor.pending(f.project_id)).toBe(false);
    expect(repair.mock.calls.map(([, d]) => d.id).sort()).toEqual(ids.sort());
    expect(open()).toEqual(allRepairable ? [] : [failed]);
    expect(events()).toEqual(allRepairable ? [] : [failed]);
  },
);

test("C-231: a repair's state re-read and second scan are timed in reconcile.state and reconcile.git", async () => {
  const repository = await centralWithBaseClone();
  const agent = join(root, "agent-clone");
  git(root, "clone", "-q", source, agent);
  git(agent, "checkout", "-q", "-b", "agent/C-1/W-1");
  const sha = commitOn(agent, "feature.txt", "feature\n");
  const { product } = await acceptThroughMergeGate(f, scenario, sha);
  await central.git.fetchRefs(repository, agent, [`+${sha}:${sha}`]);
  await central.createRef(
    repository,
    `refs/cardigan/candidates/${scenario.coder.id}/${sha}`,
    sha,
  );

  // A virtual timer: only the stubs below move it, so every span is exact.
  let t = 0;
  vi.spyOn(performance, "now").mockImplementation(() => t);
  const binding = new ServerGit({ store: f.store, dataDir: f.dataDir });
  const scan = binding.reconcile.bind(binding);
  const scanned: number[] = [];
  vi.spyOn(binding, "reconcile").mockImplementation(async (...args) => {
    t += 100; // the filesystem/Git scan
    const findings = await scan(...args);
    scanned.push(findings.length);
    return findings;
  });
  const pin = binding.repairPin.bind(binding);
  vi.spyOn(binding, "repairPin").mockImplementation(async (...args) => {
    t += 1_000;
    return pin(...args);
  });
  const store = f.store;
  const executor = new ReconcileExecutor({
    store,
    git: binding,
    // `readChecks` asks the clock once per scan: 10 inside reconcile.checks.
    clock: {
      now: () => {
        t += 10;
        return f.clock.now();
      },
    },
    report: (message) => errors.push(message),
  });
  // Each inventory state read costs 1; both scans land in reconcile.state.
  const internals = executor as unknown as {
    state: (project_id: typeof f.project_id) => unknown;
  };
  const state = internals.state.bind(executor);
  vi.spyOn(internals, "state").mockImplementation((project_id) => {
    t += 1;
    return state(project_id);
  });

  const lines: ProfileLine[] = [];
  const profiler = new TickProfiler({
    log: (line) => lines.push(line),
    reportIntervalMs: 0,
  });
  setTickProfiler(profiler);
  try {
    await profileTick("reconcile", () => executor.tick(f.project_id));
  } finally {
    setTickProfiler(undefined);
    profiler.stop();
  }

  expect(errors).toEqual([]);
  expect(scanned).toHaveLength(2); // the repair path scanned twice
  expect((await central.pinnedDeliveries(project)).get(product.id)).toBe(sha);
  const spans = lines.find((line) => line.event === "tick_profile")
    ?.spans as Record<string, number>;
  // Before C-231 the second pass was untimed: git 110, state 1, checks 20.
  expect(spans["reconcile.checks"]).toBe(20);
  expect(spans["reconcile.git"]).toBe(220);
  expect(spans["reconcile.git"]).toBeGreaterThanOrEqual(
    spans["reconcile.checks"] ?? Number.POSITIVE_INFINITY,
  );
  expect(spans["reconcile.state"]).toBe(2);
  expect(spans["reconcile.repair"]).toBeGreaterThanOrEqual(1_000);
});

test("a diverged registered source is reported and moves no ref", async () => {
  const repository = await centralWithBaseClone();
  commitOn(source, "source.txt", "source side\n");
  // Move the central baseline the other way: a direct write, as a merge would.
  writeFileSync(join(base, "central.txt"), "central side\n");
  git(base, "add", "central.txt");
  git(base, "commit", "-m", "central side");
  const centralTip = git(base, "rev-parse", "HEAD");
  await central.git.fetchRefs(repository, base, [
    `+${centralTip}:refs/heads/main`,
  ]);
  await reconcile().tick(f.project_id);
  expect(
    f.store
      .listReconcileFindings(f.project_id, { openOnly: true })
      .map((finding) => finding.kind),
  ).toContain("source_diverged");
});

test("a missing active worktree is reported", async () => {
  await centralWithBaseClone();
  f.startRun(scenario.coder, {
    path: join(
      f.dataDir,
      "agent",
      "worktrees",
      f.project_id,
      scenario.coder.id,
    ),
    branch: "agent/C-1/W-1",
  });
  await reconcile().tick(f.project_id);
  expect(
    f.store
      .listReconcileFindings(f.project_id, { openOnly: true })
      .map((finding) => finding.kind),
  ).toContain("missing_worktree");
});

test("backup moves agent branches into the central repository", async () => {
  const repository = await centralWithBaseClone();
  git(base, "checkout", "-q", "-b", "agent/C-1/W-1");
  const sha = commitOn(base, "work.txt", "in progress\n");
  git(base, "checkout", "-q", "main");

  await new BackupExecutor({
    store: f.store,
    git: new ServerGit({ store: f.store, dataDir: f.dataDir }),
    report: (message) => errors.push(message),
  }).tick(f.project_id);

  expect(
    await central.git.readRef(
      repository,
      "refs/cardigan/backups/local/agent/C-1/W-1",
    ),
  ).toBe(sha);
  expect(errors).toEqual([]);
});

test.each([
  "corrupt clone",
  "missing registered source",
  "dangling clone link",
])("S11 %s is reported and leaves the previous backup alone", async (cause) => {
  const repository = await centralWithBaseClone();
  git(base, "checkout", "-q", "-b", "agent/C-1/W-1");
  const sha = commitOn(base, "work.txt", "in progress\n");
  git(base, "checkout", "-q", "main");
  const backup = new BackupExecutor({
    store: f.store,
    git: new ServerGit({ store: f.store, dataDir: f.dataDir }),
    report: (message) => errors.push(message),
  });
  await backup.tick(f.project_id);
  if (cause === "corrupt clone")
    rmSync(join(base, ".git"), { recursive: true, force: true });
  else if (cause === "missing registered source")
    rmSync(source, { recursive: true, force: true });
  else {
    rmSync(base, { recursive: true, force: true });
    symlinkSync(join(root, "absent-target"), base);
  }
  await backup.tick(f.project_id);
  expect(errors.length).toBeGreaterThan(0);
  expect(
    await central.git.readRef(
      repository,
      "refs/cardigan/backups/local/agent/C-1/W-1",
    ),
  ).toBe(sha);
});

test.each(["local", "agent-ssh"] as const)(
  "S11 %s skips backups before the base clone exists without hiding other errors",
  async (mode) => {
    const binding = new ServerGit({
      store: f.store,
      dataDir: f.dataDir,
      ...(mode === "agent-ssh"
        ? {
            execution: {
              mode,
              dataDir: f.dataDir,
              agentRoot: join(root, "agent"),
              gid: 2001,
              machine: "fixture-agent",
              identityFile: join(root, "no-key"),
              knownHostsFile: join(root, "no-known-hosts"),
            },
            captureAgent: async () => {
              throw new Error("No Agent command before a clone exists");
            },
          }
        : {}),
    });
    const backup = new BackupExecutor({
      store: f.store,
      git: binding,
      report: (m) => errors.push(m),
    });
    await backup.tick(f.project_id);
    await backup.tick(f.project_id);
    expect(errors).toEqual([]);
    expect(existsSync(join(f.dataDir, "central", `${f.project_id}.git`))).toBe(
      false,
    );
  },
);

test.skipIf(process.getuid?.() === 0)(
  "S11 inaccessible clone parent remains an error",
  async () => {
    await centralWithBaseClone();
    const parent = join(f.dataDir, "agent", "repos");
    chmodSync(parent, 0);
    try {
      await new BackupExecutor({
        store: f.store,
        git: new ServerGit({ store: f.store, dataDir: f.dataDir }),
        report: (m) => errors.push(m),
      }).tick(f.project_id);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("EACCES");
    } finally {
      chmodSync(parent, 0o700);
    }
  },
);

test("a project-only binding cannot authorize unbound backup publication", async () => {
  const repository = await centralWithBaseClone();
  git(base, "branch", "agent/unbound");
  const gitService = new ServerGit({
    dataDir: f.dataDir,
    store: {
      getProject: (id) => f.store.getProject(id),
      listProjects: () => f.store.listProjects(),
    },
  });
  await expect(gitService.backup(project)).rejects.toThrow(/Assignment state/);
  expect(
    await central.git.readRef(
      repository,
      "refs/cardigan/backups/local/agent/unbound",
    ),
  ).toBeUndefined();
});
