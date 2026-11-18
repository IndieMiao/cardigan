import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assignment, Delivery, ProjectId } from "@cardigan/domain";
import type { RepositoryLock } from "@cardigan/git-service";
import { CentralGitTransport } from "@cardigan/git-transport";
import { RuntimeTargets, type RuntimeWorker } from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
import * as runtime from "@cardigan/runtime-herdr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ServerGit } from "./git.js";
import { type M4Fixture, m4Fixture, m4Scenario } from "./m4-fixtures.js";
import { ReconcileExecutor } from "./reconcile-loop.js";
import { lastSuccessfulWorkerBackup } from "./worker-backup.js";

const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error("Missing fixture value");
  return value;
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
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
const commit = (path: string, text: string) => {
  writeFileSync(join(path, "file"), text);
  git(path, "add", "file");
  git(path, "commit", "-qm", text);
  return git(path, "rev-parse", "HEAD");
};
let root: string,
  dataDir: string,
  source: string,
  initial: string,
  f: M4Fixture;
let service: ServerGit, workers: RuntimeWorker[], assignments: Assignment[];
let repositories: Map<string, string>, unavailable: Set<string>;
const key = (project: string, machine: string) => `${project}/${machine}`;
const events = (project = f.project_id) =>
  f.store.uow.read((tx) =>
    tx.events
      .listAfter(project, undefined, 0)
      .filter((e) => e.type === "assignment_branch_backed_up"),
  );
const center = (project = f.project_id) =>
  join(dataDir, "central", `${project}.git`);

beforeEach(async () => {
  f = m4Fixture();
  root = mkdtempSync(join(tmpdir(), "cg-worker-delivery-"));
  dataDir = join(root, "data");
  source = join(root, "source");
  git(root, "init", "-q", "-b", "main", source);
  initial = commit(source, "initial");
  const scenario = m4Scenario(f, "auto");
  workers = [];
  assignments = [];
  repositories = new Map();
  unavailable = new Set();
  const machine = required(
    f.store.uow.read((tx) => tx.machines.get(f.project_id, "local")),
  );
  for (const [i, machineId] of ["worker-a", "worker-b"].entries()) {
    f.store.uow.run((tx) =>
      tx.machines.put(f.project_id, {
        ...machine,
        id: machineId,
        label: machineId,
        herdr_machine: machineId,
      }),
    );
    const execution: runtime.AgentExecution = {
      mode: "agent-ssh",
      dataDir,
      agentRoot: "/worker-fixture",
      machine: machineId,
      user: `account${i}`,
      host: "worker.invalid",
      path: "/usr/bin:/bin",
      gid: 1000,
      identityFile: join(root, "identity"),
      knownHostsFile: join(root, "known_hosts"),
      gitHelper: { python: "/usr/bin/python3", path: "/opt/worker/git.py" },
    };
    workers.push({
      project_id: f.project_id,
      machine_id: machineId,
      os: machine.os,
      arch: machine.arch,
      session: "fixture",
      generation: "one",
      execution,
    });
    const a: Assignment = {
      ...scenario.coder,
      id: `A-${i + 101}` as never,
      machine_id: machineId,
      branch: "agent/C-1/W-1",
      worktree_path: `/worker-fixture/worktrees/${f.project_id}/A-${i + 101}`,
      base_sha: initial,
    };
    assignments.push(a);
    f.store.uow.run((tx) => tx.assignments.put(f.project_id, a));
    const path = join(root, machineId);
    git(root, "clone", "-q", source, path);
    git(path, "checkout", "-qb", required(a.branch));
    commit(path, machineId);
    repositories.set(key(f.project_id, machineId), path);
  }
  f.store.setProjectRepo({
    project_id: f.project_id,
    repo_path: source,
    base_branch: "main",
  });
  const targets = await RuntimeTargets.create({
    execution: { mode: "local", dataDir },
    store: f.store,
    workers: () => workers,
  });
  if (!targets.ok) throw new Error("fixture targets");
  // Only the SSH pack seam is replaced; selection, Git transfer, validation,
  // candidate refs, SQLite transactions and pin reconciliation are real.
  vi.spyOn(runtime, "workerGitPack").mockImplementation(
    async (config, request) => {
      const id = key(request.project, required(config.target).machine_id);
      expect(required(config.target).project_id).toBe(request.project);
      expect(request.repository).toBe(
        `/worker-fixture/repos/${request.project}`,
      );
      expect(request.source).toBe(`cardigan-central:${request.project}`);
      expect(request.format).toBe("sha1");
      if (unavailable.has(id)) return "false";
      const path = repositories.get(id);
      if (!path) throw new Error("No fixture target");
      return `sh -c ${quote(`exec git-upload-pack ${quote(path)}`)} --`;
    },
  );
  service = new ServerGit({ dataDir, store: f.store, targets: targets.value });
});
afterEach(() => {
  vi.restoreAllMocks();
  f.close();
  rmSync(root, { recursive: true, force: true });
});

test("reconciliation probes each bound worker even when host and worker paths match", async () => {
  const agentRoot = join(dataDir, "agent");
  workers = workers.map((w) => ({
    ...w,
    execution: { ...w.execution, agentRoot },
  }));
  const a = required(assignments[0]);
  const path = join(agentRoot, "worktrees", f.project_id, a.id);
  const local = { ...a, machine_id: "local", worktree_path: path };
  const remote = assignments.map((a) => ({
    ...a,
    id: local.id,
    worktree_path: path,
  }));
  mkdirSync(path, { recursive: true });
  const probe = vi
    .spyOn(runtime, "workerGit")
    .mockImplementation(async (config, request) => {
      expect(request).toMatchObject({
        operation: "exists",
        project: f.project_id,
        assignment: a.id,
        repository: path,
      });
      return config.target?.machine_id === "worker-a";
    });
  expect(
    await service.reconcile(
      required(service.projectOf(f.project_id)),
      [local, ...remote],
      [],
    ),
  ).toEqual([
    expect.objectContaining({
      kind: "missing_worktree",
      assignment_id: a.id,
      path: `worker-b:${path}`,
    }),
  ]);
  expect(probe).toHaveBeenCalledTimes(2);
});

test.each([
  "unconfigured",
  "offline",
  "no-helper",
  "error",
  "invalid-response",
  "changed-target",
  "invalid-path",
])(
  "reconciliation records remote unchecked for %s and continues other workers",
  async (failure) => {
    const a = required(assignments[0]);
    const probe = vi
      .spyOn(runtime, "workerGit")
      .mockImplementation(async (config) => {
        if (config.target?.machine_id === a.machine_id) {
          if (failure === "error") throw new Error("private SSH diagnostic");
          if (failure === "invalid-response") return null;
          if (failure === "changed-target")
            workers = workers.map((w) =>
              w.machine_id === a.machine_id
                ? { ...w, generation: "changed" }
                : w,
            );
        }
        return false;
      });
    if (failure === "unconfigured")
      workers = workers.filter((w) => w.machine_id !== a.machine_id);
    if (failure === "no-helper")
      workers = workers.map((w) => {
        if (w.machine_id !== a.machine_id || w.execution.mode !== "agent-ssh")
          return w;
        const { gitHelper: _, ...execution } = w.execution;
        return { ...w, execution };
      });
    if (failure === "offline")
      f.store.uow.run((tx) => {
        const machine = required(tx.machines.get(f.project_id, a.machine_id));
        tx.machines.put(f.project_id, { ...machine, status: "offline" });
      });
    const checked =
      failure === "invalid-path"
        ? [
            { ...a, worktree_path: `${a.worktree_path}/unexpected` },
            required(assignments[1]),
          ]
        : assignments;
    const findings = await service.reconcile(
      required(service.projectOf(f.project_id)),
      checked,
      [],
    );
    expect(findings).toEqual([
      expect.objectContaining({
        kind: "worker_unchecked",
        assignment_id: a.id,
        detail: expect.stringContaining("远程未核"),
      }),
      expect.objectContaining({
        kind: "missing_worktree",
        assignment_id: assignments[1]?.id,
      }),
    ]);
    expect(JSON.stringify(findings)).not.toContain("private SSH diagnostic");
    expect(probe).toHaveBeenCalledTimes(
      ["error", "invalid-response", "changed-target"].includes(failure) ? 2 : 1,
    );
  },
);

test("unconfigured legacy binding skips released and unplaced workers and never guesses remote absence", async () => {
  const legacy = new ServerGit({ dataDir, store: f.store });
  const a = required(assignments[0]);
  const { worktree_path: _, ...unplaced } = required(assignments[1]);
  const probe = vi.spyOn(runtime, "workerGit");
  expect(
    await legacy.reconcile(
      required(legacy.projectOf(f.project_id)),
      [a, { ...a, status: "released" }, unplaced],
      [],
    ),
  ).toEqual([
    expect.objectContaining({ kind: "worker_unchecked", assignment_id: a.id }),
  ]);
  expect(probe).not.toHaveBeenCalled();
});

test
  .skipIf(process.platform !== "linux")
  .each(["identityFile", "knownHostsFile"] as const)(
  "missing host %s leaves remote worktree existence unchecked through the real worker channel",
  async (missingFile) => {
    // Exercise RuntimeTargets -> WorkerGitTransport -> workerGitCommand without
    // replacing the channel: a local prerequisite fails before any SSH process.
    vi.restoreAllMocks();
    const a = required(assignments[0]);
    const execution = required(workers[0]).execution;
    if (execution.mode !== "agent-ssh") throw new Error("fixture worker");
    if (missingFile === "knownHostsFile")
      writeFileSync(execution.identityFile, "fixture only", {
        mode: 0o600,
        flag: "wx",
      });
    expect(existsSync(execution[missingFile])).toBe(false);
    const project = required(service.projectOf(f.project_id));
    expect(await service.reconcile(project, [a], [])).toEqual([
      expect.objectContaining({
        kind: "worker_unchecked",
        assignment_id: a.id,
        path: `${a.machine_id}:${a.worktree_path}`,
        detail: expect.stringContaining("远程未核"),
      }),
    ]);
    // A failed prerequisite is not a fresh observation of an already missing directory.
    f.store.recordReconcileFindings(f.project_id, [
      {
        kind: "missing_worktree",
        detail: "Previously confirmed missing on worker",
        assignment_id: a.id,
        path: `${a.machine_id}:${a.worktree_path}`,
      },
    ]);
    const previous = f.store.listReconcileFindings(f.project_id)[0];
    vi.spyOn(f.clock, "now").mockReturnValue("2040-01-01T00:00:00.000Z");
    await new ReconcileExecutor({
      store: f.store,
      git: service,
      clock: f.clock,
    }).tick(f.project_id);
    expect(
      f.store
        .listReconcileFindings(f.project_id, { openOnly: true })
        .filter((finding) => finding.kind === "missing_worktree"),
    ).toEqual([previous]);
  },
);

test("worker outage retains confirmed missing evidence, deduplicates warnings and resolves after recovery", async () => {
  const a = required(assignments[0]);
  let status: "missing" | "unreachable" | "present" = "missing";
  vi.spyOn(runtime, "workerGit").mockImplementation(async (config) => {
    if (config.target?.machine_id !== a.machine_id) return true;
    if (status === "unreachable") throw new Error("unreachable");
    return status === "present";
  });
  const executor = new ReconcileExecutor({
    store: f.store,
    git: service,
    clock: f.clock,
  });
  const open = () =>
    f.store.listReconcileFindings(f.project_id, { openOnly: true });
  // The old host-path false positive is retired; new evidence has a machine-qualified path.
  f.store.recordReconcileFindings(f.project_id, [
    {
      kind: "missing_worktree",
      detail: "old local assumption",
      path: required(a.worktree_path),
      assignment_id: a.id,
    },
  ]);
  await executor.tick(f.project_id);
  expect(open()).toEqual([
    expect.objectContaining({
      kind: "missing_worktree",
      path: `${a.machine_id}:${a.worktree_path}`,
    }),
  ]);
  const missing = open()[0];
  status = "unreachable";
  await executor.tick(f.project_id);
  await executor.tick(f.project_id);
  expect(open()).toHaveLength(2);
  expect(open().find((x) => x.kind === "missing_worktree")).toEqual(missing);
  expect(
    f.store.uow
      .read((tx) => tx.events.listAfter(f.project_id, undefined, 0))
      .filter((e) => e.type === "reconcile_finding"),
  ).toHaveLength(2);
  status = "present";
  await executor.tick(f.project_id);
  expect(open()).toEqual([]);
});

test("remote delivery and precheck bind project, machine and account even when paths and Assignment ids match", async () => {
  const a = required(assignments[0]),
    b = {
      ...required(assignments[1]),
      id: a.id,
      worktree_path: a.worktree_path,
    };
  const sha = git(
    required(repositories.get(key(f.project_id, a.machine_id))),
    "rev-parse",
    "HEAD",
  );
  const other = git(
    required(repositories.get(key(f.project_id, b.machine_id))),
    "rev-parse",
    "HEAD",
  );
  const verifier = service.verifierFor(f.project_id);
  expect(await service.checkHead(f.project_id, a)).toBe(sha);
  expect(await service.checkHead(f.project_id, b)).toBe(other);
  expect((await verifier.verify({ kind: "git_head", value: sha }, b)).ok).toBe(
    false,
  );
  expect((await verifier.verify({ kind: "git_head", value: sha }, a)).ok).toBe(
    true,
  );
  const second = "another" as ProjectId;
  expect(f.store.createProject({ id: second, name: "another" }).ok).toBe(true);
  f.store.setProjectRepo({
    project_id: second,
    repo_path: source,
    base_branch: "main",
  });
  const original = required(workers[0]);
  workers.push({
    ...original,
    project_id: second,
    execution: {
      ...original.execution,
      user: "anotheraccount",
    } as runtime.AgentExecution,
  });
  f.store.uow.run((tx) =>
    tx.machines.put(second, {
      ...required(tx.machines.get(f.project_id, a.machine_id)),
      project_id: second,
    } as never),
  );
  repositories.set(
    key(second, a.machine_id),
    required(repositories.get(key(f.project_id, b.machine_id))),
  );
  expect(await service.checkHead(second, a)).toBe(other);
  expect(
    (
      await service
        .verifierFor(second)
        .verify({ kind: "git_head", value: sha }, a)
    ).ok,
  ).toBe(false);
  expect(git(center(), "rev-parse", "main")).toBe(initial);
  expect(git(center(second), "rev-parse", "main")).toBe(initial);
  expect(existsSync("/worker-fixture/repos")).toBe(false);
});

test("remote fetch, candidate and DB/pin crash boundaries retry without losing the candidate or advancing main", async () => {
  const a = required(assignments[0]),
    sha = git(
      required(repositories.get(key(f.project_id, a.machine_id))),
      "rev-parse",
      "HEAD",
    );
  const subject = { kind: "git_head" as const, value: sha },
    verifier = service.verifierFor(f.project_id);
  unavailable.add(key(f.project_id, a.machine_id));
  expect((await verifier.verify(subject, a)).ok).toBe(false);
  expect(
    git(
      center(),
      "for-each-ref",
      "--format=%(refname)",
      "refs/cardigan/candidates",
    ),
  ).toBe("");
  unavailable.clear();
  // A crash after fetch but before candidate creation leaves no accepted delivery.
  const candidate = `refs/cardigan/candidates/${a.id}/${sha}`;
  mkdirSync(join(center(), candidate, ".."), { recursive: true });
  writeFileSync(join(center(), `${candidate}.lock`), "held");
  expect((await verifier.verify(subject, a)).ok).toBe(false);
  rmSync(join(center(), `${candidate}.lock`));
  expect((await verifier.verify(subject, a)).ok).toBe(true);
  expect(
    git(
      center(),
      "for-each-ref",
      "--format=%(refname)",
      "refs/cardigan/deliveries",
    ),
  ).toBe("");
  const delivery: Delivery = {
      id: "D-1" as never,
      subject,
      work_item_id: required(a.work_item_id),
      run_id: "R-1" as never,
      kind: "code",
      summary: "fixture",
      evidence: [],
      attachments: [],
      known_gaps: [],
      requested_verifiers: [],
      status: "submitted",
    },
    project = required(service.projectOf(f.project_id));
  expect(() =>
    f.store.uow.run((tx) => {
      tx.deliveries.put(f.project_id, delivery);
      throw new Error("DB rollback");
    }),
  ).toThrow("DB rollback");
  expect(
    f.store.uow.read((tx) => tx.deliveries.get(f.project_id, delivery.id)),
  ).toBeUndefined();
  expect((await verifier.verify(subject, a)).ok).toBe(true);
  f.store.uow.run((tx) => tx.deliveries.put(f.project_id, delivery));
  mkdirSync(join(center(), "refs/cardigan/deliveries"), { recursive: true });
  writeFileSync(join(center(), "refs/cardigan/deliveries/D-1.lock"), "held");
  await expect(
    service.pinDelivery({ project_id: f.project_id, delivery_id: "D-1", sha }),
  ).rejects.toThrow();
  rmSync(join(center(), "refs/cardigan/deliveries/D-1.lock"));
  unavailable.add(key(f.project_id, a.machine_id)); // Repair is entirely central.
  expect(await service.repairPin(project, delivery, a)).toBe(true);
  expect(await service.repairPin(project, delivery, a)).toBe(true);
  expect(git(center(), "rev-parse", "refs/cardigan/deliveries/D-1")).toBe(sha);
  expect(git(center(), "rev-parse", "main")).toBe(initial);
});

test("backup failures retain prior SHA/time while other machines succeed; deleted branches never refresh old evidence", async () => {
  const project = required(service.projectOf(f.project_id)),
    a = required(assignments[0]),
    b = required(assignments[1]);
  await service.backup(project);
  const old = events().filter(
    (e) => (e.payload as { assignment_id: string }).assignment_id === a.id,
  );
  expect(old).toHaveLength(1);
  const readBackup = () =>
    f.store.uow.read((tx) =>
      lastSuccessfulWorkerBackup(loadCommandState(tx, f.project_id), a),
    );
  const previousBackup = readBackup();
  expect(previousBackup).toEqual({
    sha: (required(old[0]).payload as { sha: string }).sha,
    at: old[0]?.created_at,
    branch: a.branch,
  });
  const ref = `refs/cardigan/backups/${a.machine_id}/${a.branch}`,
    sha = git(center(), "rev-parse", ref);
  commit(
    required(repositories.get(key(f.project_id, a.machine_id))),
    "unavailable",
  );
  const next = commit(
    required(repositories.get(key(f.project_id, b.machine_id))),
    "available",
  );
  unavailable.add(key(f.project_id, a.machine_id));
  await expect(service.backup(project)).rejects.toThrow(/worker-a/);
  expect(
    events().filter(
      (e) => (e.payload as { assignment_id: string }).assignment_id === a.id,
    ),
  ).toEqual(old);
  expect(git(center(), "rev-parse", ref)).toBe(sha);
  expect(readBackup()).toEqual(previousBackup);
  expect(
    git(
      center(),
      "rev-parse",
      `refs/cardigan/backups/${b.machine_id}/${b.branch}`,
    ),
  ).toBe(next);
  unavailable.clear();
  await service.backup(project);
  const succeeded = events().filter(
    (e) => (e.payload as { assignment_id: string }).assignment_id === a.id,
  );
  expect(succeeded).toHaveLength(2);
  expect(readBackup()).toEqual({
    sha: (required(succeeded[1]).payload as { sha: string }).sha,
    at: succeeded[1]?.created_at,
    branch: a.branch,
  });
  const repo = required(repositories.get(key(f.project_id, a.machine_id)));
  git(repo, "checkout", "--detach");
  git(repo, "branch", "-D", required(a.branch));
  const latest = git(center(), "rev-parse", ref);
  await expect(service.backup(project)).rejects.toThrow();
  expect(
    events().filter(
      (e) => (e.payload as { assignment_id: string }).assignment_id === a.id,
    ),
  ).toEqual(succeeded);
  expect(git(center(), "rev-parse", ref)).toBe(latest);
  expect(git(center(), "rev-parse", "main")).toBe(initial);
});

test("missing, changed or disabled remote target never falls back to local", async () => {
  const a = required(assignments[0]),
    sha = git(
      required(repositories.get(key(f.project_id, a.machine_id))),
      "rev-parse",
      "HEAD",
    );
  for (const fault of ["missing", "helper", "offline"]) {
    const saved = [...workers];
    if (fault === "missing") workers = workers.slice(1);
    if (fault === "helper")
      workers = workers.map((w) => ({
        ...w,
        execution: {
          ...w.execution,
          gitHelper: undefined,
        } as runtime.AgentExecution,
      }));
    if (fault === "offline")
      f.store.uow.run((tx) =>
        tx.machines.put(f.project_id, {
          ...required(tx.machines.get(f.project_id, a.machine_id)),
          status: "offline",
        }),
      );
    expect(
      (
        await service
          .verifierFor(f.project_id)
          .verify({ kind: "git_head", value: sha }, a)
      ).ok,
    ).toBe(false);
    await expect(service.checkHead(f.project_id, a)).rejects.toThrow();
    workers = saved;
  }
  expect(runtime.workerGitPack).not.toHaveBeenCalled();
});

test("a target changed during transfer cannot refresh backup evidence or accept a delivery", async () => {
  const a = required(assignments[0]),
    project = required(service.projectOf(f.project_id));
  await service.backup(project);
  const old = events().filter(
    (e) => (e.payload as { assignment_id: string }).assignment_id === a.id,
  );
  const ref = `refs/cardigan/backups/${a.machine_id}/${a.branch}`;
  const oldSha = git(center(), "rev-parse", ref);
  const sha = commit(
    required(repositories.get(key(f.project_id, a.machine_id))),
    "changed target",
  );
  const fetch = CentralGitTransport.prototype.fetchRefs;
  vi.spyOn(CentralGitTransport.prototype, "fetchRefs").mockImplementation(
    async function (...args) {
      await fetch.apply(this, args);
      const source = args[1];
      if (
        typeof source !== "string" &&
        source.kind === "worker-remote" &&
        source.machine_id === a.machine_id
      )
        workers = workers.map((w) =>
          w.machine_id === a.machine_id
            ? { ...w, generation: `${w.generation}-changed` }
            : w,
        );
    },
  );
  expect(
    (
      await service
        .verifierFor(f.project_id)
        .verify({ kind: "git_head", value: sha }, a)
    ).ok,
  ).toBe(false);
  await expect(service.backup(project)).rejects.toThrow();
  expect(
    events().filter(
      (e) => (e.payload as { assignment_id: string }).assignment_id === a.id,
    ),
  ).toEqual(old);
  expect(git(center(), "rev-parse", ref)).toBe(oldSha);
  expect(
    git(
      center(),
      "for-each-ref",
      "--format=%(refname)",
      "refs/cardigan/candidates",
    ),
  ).toBe("");
});

test("failed backup evidence transaction rolls back both success history and the previous backup ref", async () => {
  const a = required(assignments[0]),
    project = required(service.projectOf(f.project_id));
  await service.backup(project);
  const before = events();
  const ref = `refs/cardigan/backups/${a.machine_id}/${a.branch}`;
  const sha = git(center(), "rev-parse", ref);
  commit(
    required(repositories.get(key(f.project_id, a.machine_id))),
    "DB failure",
  );
  const uow = f.store.uow,
    run = uow.run;
  const failure = vi.spyOn(f.store, "uow", "get").mockReturnValue({
    ...uow,
    run: (work) =>
      run((tx) => {
        work(tx);
        throw new Error("backup evidence rollback");
      }),
  });
  await expect(service.backup(project)).rejects.toThrow(/Branch backup failed/);
  expect(events()).toEqual(before);
  expect(git(center(), "rev-parse", ref)).toBe(sha);
  failure.mockRestore();
  await service.backup(project);
  expect(git(center(), "rev-parse", ref)).not.toBe(sha);
});

async function localBackupFixture(configured: boolean) {
  await service.baseline(required(service.projectOf(f.project_id)));
  const original = required(
    f.store.uow
      .read((tx) => tx.assignments.list(f.project_id))
      .find((a) => a.machine_id === "local" && a.role_id === "coder"),
  );
  const path = configured
    ? join(root, "local-account")
    : join(dataDir, "agent", "repos", f.project_id);
  mkdirSync(join(path, ".."), { recursive: true });
  git(root, "clone", "-q", source, path);
  const branch = "agent/C-1/W-1";
  git(path, "checkout", "-qb", branch);
  const a = { ...original, branch, worktree_path: path, base_sha: initial };
  f.store.uow.run((tx) => tx.assignments.put(f.project_id, a));
  if (configured) {
    const first = required(workers[0]);
    workers.push({
      ...first,
      machine_id: "local",
      execution: {
        ...first.execution,
        machine: "local-account",
        user: "localaccount",
      } as runtime.AgentExecution,
    });
    repositories.set(key(f.project_id, "local"), path);
  }
  return { a, path };
}

test.each([false, true])(
  "local wildcard backup cannot overwrite transactional branches on DB failure (configured=%s)",
  async (configured) => {
    const { a, path } = await localBackupFixture(configured);
    if (!configured) {
      // Exercise the exact legacy assembly from the code review reproduction.
      service = new ServerGit({ store: f.store, dataDir });
      f.store.uow.run((tx) => {
        for (const remote of assignments)
          tx.assignments.put(f.project_id, { ...remote, status: "released" });
      });
    }
    const project = required(service.projectOf(f.project_id));
    const first = commit(path, "local successful backup");
    git(path, "branch", "agent/unbound", first);
    await service.backup(project);
    const before = events();
    const ref = `refs/cardigan/backups/local/${a.branch}`;
    expect(git(center(), "rev-parse", ref)).toBe(first);
    // A rewrite means the previous backup cannot rely on the new branch's ancestry.
    git(path, "reset", "--hard", initial);
    const rewritten = commit(path, "rewritten local branch");
    git(path, "branch", "-f", "agent/unbound", rewritten);
    const uow = f.store.uow;
    const failure = vi.spyOn(f.store, "uow", "get").mockReturnValue({
      ...uow,
      run: (work) =>
        uow.run((tx) =>
          work({
            ...tx,
            events: {
              ...tx.events,
              append: () => {
                throw new Error("local evidence rollback");
              },
            },
          }),
        ),
    });
    await expect(service.backup(project)).rejects.toThrow(
      /Branch backup failed/,
    );
    expect(events()).toEqual(before);
    expect(git(center(), "rev-parse", ref)).toBe(first);
    expect(
      git(center(), "rev-parse", "refs/cardigan/backups/local/agent/unbound"),
    ).toBe(rewritten);
    failure.mockRestore();
    await service.backup(project);
    expect(git(center(), "rev-parse", ref)).toBe(rewritten);
    expect(
      events()
        .filter(
          (e) =>
            (e.payload as { assignment_id: string }).assignment_id === a.id,
        )
        .at(-1)?.payload,
    ).toMatchObject({ sha: rewritten });
  },
);

test.each([false, true])(
  "local project backup ignores released terminal identity but delivery still validates it (configured=%s)",
  async (configured) => {
    const { a, path } = await localBackupFixture(configured);
    const sha = commit(path, "unbound local history");
    const stale: Assignment = {
      ...a,
      status: "released",
      runtime_ref: {
        machine_id: "local",
        runtime_machine: "old-host",
        terminal_ref: "old-host/t1",
        agent_name: "old",
      },
    };
    f.store.uow.run((tx) => tx.assignments.put(f.project_id, stale));
    expect(
      f.store.uow.read((tx) => tx.assignments.list(f.project_id))[0]?.id,
    ).toBe(stale.id);
    await expect(
      service.backup(required(service.projectOf(f.project_id))),
    ).resolves.toBeUndefined();
    expect(
      git(center(), "rev-parse", `refs/cardigan/backups/local/${a.branch}`),
    ).toBe(sha);
    expect(
      (
        await service
          .verifierFor(f.project_id)
          .verify({ kind: "git_head", value: sha }, stale)
      ).ok,
    ).toBe(false);
    await expect(service.checkHead(f.project_id, stale)).rejects.toThrow();
  },
);

// Hold a real upload-pack open. The watchdog only releases a regressed test;
// for repeatable before/after measurements use the same fixed delay instead.
test("interactive HEAD finishes while a backup upload-pack is still parked", async () => {
  const project = required(service.projectOf(f.project_id));
  const a = required(assignments[0]);
  await service.baseline(project);
  const marker = join(root, "pack-started"),
    release = join(root, "resume-pack");
  const sample = process.env.CARDIGAN_TEST_BACKUP_SAMPLE === "1";
  const pack = vi.mocked(runtime.workerGitPack);
  const original = required(pack.getMockImplementation());
  pack.mockImplementationOnce(async (...args) => {
    const entry = await original(...args);
    const pause = sample
      ? "sleep 1.5"
      : `while ! test -f ${quote(release)}; do sleep 0.05; done`;
    return `sh -c ${quote(`touch ${quote(marker)}; ${pause}; exec ${entry} "$@"`)} --`;
  });
  const observed = service as unknown as { lock: RepositoryLock };
  const lock = observed.lock;
  let head = false,
    headWait = 0,
    backupHold = 0;
  vi.spyOn(observed, "lock").mockImplementation((key, work) => {
    const reading = head,
      start = performance.now();
    head = false;
    return lock(key, async () => {
      const entered = performance.now();
      if (reading) headWait = entered - start;
      try {
        return await work();
      } finally {
        if (!reading)
          backupHold = Math.max(backupHold, performance.now() - entered);
      }
    });
  });
  const backup = service.backup(project);
  const watchdog = setTimeout(() => writeFileSync(release, ""), 15000);
  try {
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true), {
      timeout: 10000,
    });
    head = true;
    const sha = await service.checkHead(f.project_id, a);
    head = false;
    expect(sha).toBe(
      git(
        required(repositories.get(key(f.project_id, a.machine_id))),
        "rev-parse",
        "HEAD",
      ),
    );
    expect(existsSync(release)).toBe(false);
    if (!sample)
      expect(
        events().filter(
          (e) =>
            (e.payload as { assignment_id: string }).assignment_id === a.id,
        ),
      ).toHaveLength(0);
  } finally {
    clearTimeout(watchdog);
    writeFileSync(release, "");
    await backup;
    if (sample)
      console.info(
        `backup sample: max backup lock hold ${Math.round(backupHold)} ms, HEAD lock wait ${Math.round(headWait)} ms`,
      );
  }
}, 30000);

function interceptWorkerFetch(
  machine: string,
  after: (stage: string) => Promise<void>,
) {
  const fetch = CentralGitTransport.prototype.fetchRefs;
  vi.spyOn(CentralGitTransport.prototype, "fetchRefs").mockImplementation(
    async function (...args) {
      await fetch.apply(this, args);
      const [stage, source] = args;
      if (
        typeof source !== "string" &&
        source.kind === "worker-remote" &&
        source.machine_id === machine
      )
        await after(stage);
    },
  );
}

test.each(["absent", "changed", "unchanged"])(
  "overlapping backups isolate their capture and reject the stale publisher (previous=%s)",
  async (previous) => {
    const a = required(assignments[0]),
      project = required(service.projectOf(f.project_id));
    const path = required(repositories.get(key(f.project_id, a.machine_id)));
    const firstHead = git(path, "rev-parse", "HEAD");
    if (previous !== "absent") await service.backup(project);
    const old = commit(path, "first transfer");
    const first = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>();
    const stages: string[] = [];
    interceptWorkerFetch(a.machine_id, async (stage) => {
      stages.push(stage);
      if (stages.length === 1) {
        first.resolve();
        await resume.promise;
        expect(git(stage, "rev-parse", required(a.branch))).toBe(old);
      }
    });
    const stale = service.backup(project);
    const ref = `refs/cardigan/backups/${a.machine_id}/${a.branch}`;
    try {
      await first.promise;
      git(path, "reset", "--hard", firstHead);
      const newer =
        previous === "unchanged"
          ? firstHead
          : commit(path, "rewritten second transfer");
      await service.backup(project);
      expect(stages).toHaveLength(2);
      expect(stages[0]).not.toBe(stages[1]);
      expect(git(center(), "rev-parse", ref)).toBe(newer);
      const before = events().filter(
        (e) => (e.payload as { assignment_id: string }).assignment_id === a.id,
      );
      resume.resolve();
      await expect(stale).rejects.toThrow(/worker-a/);
      expect(git(center(), "rev-parse", ref)).toBe(newer);
      expect(
        events().filter(
          (e) =>
            (e.payload as { assignment_id: string }).assignment_id === a.id,
        ),
      ).toEqual(before);
      expect(
        readdirSync(join(dataDir, "central")).filter((name) =>
          name.startsWith(".backup-"),
        ),
      ).toEqual([]);
    } finally {
      resume.resolve();
      await stale.catch(() => {});
    }
  },
);

test.each(["released", "worktree", "project"])(
  "a change to the %s before publication preserves the valid backup",
  async (change) => {
    const a = required(assignments[0]),
      project = required(service.projectOf(f.project_id));
    await service.backup(project);
    const ref = `refs/cardigan/backups/${a.machine_id}/${a.branch}`,
      before = git(center(), "rev-parse", ref);
    commit(
      required(repositories.get(key(f.project_id, a.machine_id))),
      "after previous backup",
    );
    interceptWorkerFetch(a.machine_id, async () => {
      if (change === "project")
        f.store.setProjectRepo({
          project_id: f.project_id,
          repo_path: source,
          base_branch: "other",
        });
      else
        f.store.uow.run((tx) =>
          tx.assignments.put(
            f.project_id,
            change === "released"
              ? { ...a, status: "released" }
              : { ...a, worktree_path: `${a.worktree_path}-changed` },
          ),
        );
    });
    await expect(service.backup(project)).rejects.toThrow(/worker-a/);
    expect(git(center(), "rev-parse", ref)).toBe(before);
    expect(
      events().filter(
        (e) => (e.payload as { assignment_id: string }).assignment_id === a.id,
      ),
    ).toHaveLength(1);
  },
);

test("a newly bound wildcard branch aborts the whole stale local publication", async () => {
  const { a, path } = await localBackupFixture(true);
  git(path, "branch", "agent/free");
  git(path, "branch", "agent/claimed");
  const project = required(service.projectOf(f.project_id));
  await service.backup(project);
  const next = commit(path, "unbound updates");
  for (const name of ["agent/free", "agent/claimed"])
    git(path, "branch", "-f", name, next);
  interceptWorkerFetch("local", async () => {
    f.store.uow.run((tx) =>
      tx.assignments.put(f.project_id, { ...a, branch: "agent/claimed" }),
    );
  });
  await expect(service.backup(project)).rejects.toThrow();
  for (const name of ["agent/free", "agent/claimed"])
    expect(
      git(center(), "rev-parse", `refs/cardigan/backups/local/${name}`),
    ).toBe(initial);
});

test("failed first evidence commit leaves neither a backup nor its generation", async () => {
  const project = required(service.projectOf(f.project_id));
  const a = required(assignments[0]),
    uow = f.store.uow;
  const fail = vi.spyOn(f.store, "uow", "get").mockReturnValue({
    ...uow,
    run: (work) =>
      uow.run((tx) => {
        work(tx);
        throw new Error("commit failed");
      }),
  });
  await expect(service.backup(project)).rejects.toThrow();
  expect(
    git(
      center(),
      "for-each-ref",
      "--format=%(refname)",
      "refs/cardigan/backups",
      "refs/cardigan/backup-generations",
    ),
  ).toBe("");
  expect(events()).toEqual([]);
  fail.mockRestore();
  await service.backup(project);
  expect(
    git(
      center(),
      "rev-parse",
      `refs/cardigan/backups/${a.machine_id}/${a.branch}`,
    ),
  ).toBe(
    git(
      required(repositories.get(key(f.project_id, a.machine_id))),
      "rev-parse",
      "HEAD",
    ),
  );
});
