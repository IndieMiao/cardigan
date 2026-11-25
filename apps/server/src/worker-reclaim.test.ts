/**
 * C-664: released Assignments' build checkouts and worktrees on a remote
 * darwin worker are reclaimed through that worker's Git helper.
 *
 * The worker disk is a real temporary directory addressed as `/worker-fixture`
 * on the worker side; the host cannot `access()` that path, as in production.
 * Only the helper seam (`workerGit` / `workerGitPack`) is emulated, with the
 * real helper's rule that a request may only touch its own Assignment's leaves
 * (deploy/worker-git.py `Workspace.allowed`). Git, the store, the domain
 * commands and the cleanup loop are real.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Assignment,
  type AssignmentId,
  type Runtime,
  recordDecision,
} from "@cardigan/domain";
import { RuntimeTargets, type RuntimeWorker } from "@cardigan/host";
import * as runtime from "@cardigan/runtime-herdr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CleanupExecutor } from "./cleanup-loop.js";
import { ServerGit } from "./git.js";
import {
  type M4Fixture,
  type M4Scenario,
  m4Fixture,
  m4Scenario,
} from "./m4-fixtures.js";

const REMOTE = "/worker-fixture";
const MACHINE = "mac-mini";
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
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error("Missing fixture value");
  return value;
};

let f: M4Fixture;
let scenario: M4Scenario;
let root: string;
let disk: string;
let service: ServerGit;
let failListing: boolean;
let requests: { operation: string; assignment: string; path?: string }[];

const local = (path: string) =>
  path === REMOTE || path.startsWith(`${REMOTE}/`)
    ? disk + path.slice(REMOTE.length)
    : path;
const remote = (text: string) => text.replaceAll(disk, REMOTE);
const repo = () => `${REMOTE}/repos/${f.project_id}`;
const worktreeOf = (id: string) => `${REMOTE}/worktrees/${f.project_id}/${id}`;
const buildOf = (id: string) => `${REMOTE}/builds/${f.project_id}/${id}`;

/** The worker helper's operations, restricted like deploy/worker-git.py. */
function helper(request: runtime.WorkerGitRequest): unknown {
  const leaves = [worktreeOf(request.assignment), buildOf(request.assignment)];
  const allowed = (path: string) => {
    if (path !== repo() && !leaves.includes(path))
      throw new Error(`helper refused ${path} for ${request.assignment}`);
  };
  const path = request.repository ?? repo();
  requests.push({
    operation: request.operation,
    assignment: request.assignment,
    path,
  });
  switch (request.operation) {
    case "directories": {
      if (failListing) throw new Error("worker unreachable");
      const roots = [
        `${REMOTE}/repos`,
        `${REMOTE}/worktrees/${f.project_id}`,
        `${REMOTE}/builds/${f.project_id}`,
        `${REMOTE}/checks/${f.project_id}`,
      ];
      if (!roots.includes(path)) throw new Error("helper refused listing");
      if (!existsSync(local(path))) return [];
      return readdirSync(local(path))
        .filter((name) => statSync(join(local(path), name)).isDirectory())
        .map((name) => `${path}/${name}`)
        .sort();
    }
    case "exists":
      allowed(path);
      return path === repo()
        ? existsSync(join(local(path), ".git"))
        : existsSync(local(path));
    case "remove-empty":
      if (leaves.some((leaf) => path === leaf.slice(0, leaf.lastIndexOf("/"))))
        return null;
      allowed(path);
      if (!existsSync(local(path))) return null;
      rmdirSync(local(path));
      return null;
    case "prepare":
      if (!leaves.includes(path)) throw new Error("helper refused prepare");
      mkdirSync(local(path), { recursive: true });
      return null;
    case "git": {
      const args = required(request.args);
      const at = args.indexOf("-C");
      const target = required(args[at + 1]);
      allowed(target);
      const rest = [...args.slice(0, at), ...args.slice(at + 2)];
      return remote(
        execFileSync("git", ["-C", local(target), ...rest.map(local)], {
          encoding: "utf8",
        }),
      );
    }
    default:
      throw new Error(`unexpected helper operation ${request.operation}`);
  }
}

const runtimeStub: Runtime = {
  provision: async () => {
    throw new Error("not used");
  },
  wake: async () => ({ ok: true, value: { sent: true } }),
  status: async () => ({
    ok: true,
    value: { process: "alive", agent: "idle", observed_seq: 1 },
  }),
  interrupt: async () => ({ ok: true, value: undefined }),
  resume_or_replace: async () => {
    throw new Error("not used");
  },
  human_entry: async () => ({ ok: true, value: "fixture" }),
  release: async () => ({ ok: true, value: undefined }),
} as unknown as Runtime;

const reports: string[] = [];
const cleanup = () =>
  new CleanupExecutor({
    store: f.store,
    git: service,
    runtime: runtimeStub,
    clock: f.clock,
    report: (message) => reports.push(message),
  });

function put(base: Assignment, patch: Partial<Assignment>): Assignment {
  const next = {
    ...base,
    machine_id: MACHINE,
    runtime_ref: null,
    ...patch,
  } as Assignment;
  f.store.uow.run((tx) => tx.assignments.put(f.project_id, next));
  return next;
}
const released = (
  base: Assignment,
  id: string,
  patch: Partial<Assignment> = {},
) => {
  const { worktree_path: _p, branch: _b, ...rest } = base;
  return put(rest as Assignment, {
    id: id as AssignmentId,
    status: "released",
    released_at: "2030-01-01T00:00:00.000Z",
    ...patch,
  });
};
const registered = () =>
  git(local(repo()), "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => remote(line.slice("worktree ".length)));

beforeEach(async () => {
  f = m4Fixture();
  scenario = m4Scenario(f, "auto");
  reports.length = 0;
  failListing = false;
  requests = [];
  root = realpathSync(mkdtempSync(join(tmpdir(), "cg-worker-reclaim-")));
  disk = join(root, "worker-disk");
  const source = join(root, "source");
  git(root, "init", "-q", "-b", "main", source);
  writeFileSync(join(source, "file"), "initial\n");
  git(source, "add", "file");
  git(source, "commit", "-qm", "initial");
  f.store.setProjectRepo({
    project_id: f.project_id,
    repo_path: source,
    base_branch: "main",
  });
  const machine = required(
    f.store.uow.read((tx) => tx.machines.get(f.project_id, "local")),
  );
  f.store.uow.run((tx) =>
    tx.machines.put(f.project_id, {
      ...machine,
      id: MACHINE,
      label: MACHINE,
      herdr_machine: MACHINE,
      os: "darwin",
      arch: "arm64",
    }),
  );
  const execution: runtime.AgentExecution = {
    mode: "agent-ssh",
    dataDir: f.dataDir,
    agentRoot: REMOTE,
    machine: MACHINE,
    user: "sensen",
    host: "worker.invalid",
    path: "/usr/bin:/bin",
    gid: 1000,
    identityFile: join(root, "identity"),
    knownHostsFile: join(root, "known_hosts"),
    gitHelper: { python: "/usr/bin/python3", path: "/opt/worker/git.py" },
  };
  const workers: RuntimeWorker[] = [
    {
      project_id: f.project_id,
      machine_id: MACHINE,
      os: "darwin",
      arch: "arm64",
      session: "fixture",
      generation: "one",
      execution,
    },
  ];
  const targets = await RuntimeTargets.create({
    execution: { mode: "local", dataDir: f.dataDir },
    store: f.store,
    workers: () => workers,
  });
  if (!targets.ok) throw new Error("fixture targets");
  vi.spyOn(runtime, "workerGit").mockImplementation(async (config, request) => {
    expect(config.target?.machine_id).toBe(MACHINE);
    return helper(request) as never;
  });
  vi.spyOn(runtime, "workerGitPack").mockImplementation(
    async (_config, request) =>
      `sh -c ${quote(`exec git-${request.operation} ${quote(local(required(request.repository)))}`)} --`,
  );
  service = new ServerGit({
    dataDir: f.dataDir,
    store: f.store,
    targets: targets.value,
  });
  // The worker's base clone of the central repository.
  const project = required(service.projectOf(f.project_id));
  const central = await service
    .sync(project)
    .then(() => join(f.dataDir, "central", `${f.project_id}.git`));
  mkdirSync(join(disk, "repos"), { recursive: true });
  mkdirSync(join(disk, "worktrees", f.project_id), { recursive: true });
  mkdirSync(join(disk, "builds", f.project_id), { recursive: true });
  git(root, "clone", "-q", "--no-local", central, local(repo()));
});
afterEach(() => {
  vi.restoreAllMocks();
  f.close();
  rmSync(root, { recursive: true, force: true });
});

const head = () => git(local(repo()), "rev-parse", "HEAD");
function writer(id: string, branch: string) {
  git(
    local(repo()),
    "worktree",
    "add",
    "-q",
    "-b",
    branch,
    local(worktreeOf(id)),
    head(),
  );
  return local(worktreeOf(id));
}
function build(id: string) {
  git(
    local(repo()),
    "worktree",
    "add",
    "-q",
    "--detach",
    local(buildOf(id)),
    head(),
  );
  // A Godot import cache / dependency tree the verifier left behind.
  mkdirSync(join(local(buildOf(id)), ".godot", "imported"), {
    recursive: true,
  });
  writeFileSync(join(local(buildOf(id)), ".godot", "imported", "a.ctex"), "x");
  return local(buildOf(id));
}

test("released verifiers' remote build checkouts are removed and pruned; an Assignment mid-Run keeps its build", async () => {
  const gone = released(scenario.reviewer, "A-301");
  const vanished = released(scenario.reviewer, "A-302");
  const goneDir = build(gone.id);
  build(vanished.id);
  // A registration whose directory was already deleted by hand (no prune).
  rmSync(local(buildOf(vanished.id)), { recursive: true, force: true });
  // A verifier mid-Run on the same worker: unfinished Runs protect builds.
  const run = f.startRun(scenario.coder);
  const active = put(scenario.reviewer, { id: "A-305" as AssignmentId });
  f.store.uow.run((tx) =>
    tx.runs.put(f.project_id, {
      ...run,
      id: "R-9001" as typeof run.id,
      assignment_id: active.id,
      status: "running",
    }),
  );
  const activeDir = build(active.id);

  await cleanup().sweep(f.project_id);

  expect(existsSync(goneDir)).toBe(false);
  expect(existsSync(activeDir)).toBe(true);
  expect(registered()).not.toContain(buildOf(gone.id));
  expect(registered()).not.toContain(buildOf(vanished.id));
  expect(registered()).toContain(buildOf(active.id));
  // Every removal went through the owner's own helper leaf.
  for (const r of requests.filter((r) => r.operation === "git"))
    expect([gone.id, vanished.id, active.id]).toContain(r.assignment);
  expect(reports).toEqual([]);
});

test("a released writer's clean, backed-up remote worktree is removed although the host cannot see its path", async () => {
  const a = released(scenario.coder, "A-201", {
    worktree_path: worktreeOf("A-201"),
    branch: "agent/C-1/W-201",
  });
  const dir = writer(a.id, "agent/C-1/W-201");
  writeFileSync(join(dir, "feature.txt"), "feature\n");
  git(dir, "add", "feature.txt");
  git(dir, "commit", "-qm", "feature");
  const sha = git(dir, "rev-parse", "HEAD");
  expect(existsSync(worktreeOf(a.id))).toBe(false); // the host's view

  await cleanup().sweep(f.project_id);

  expect(existsSync(dir)).toBe(false);
  expect(registered()).not.toContain(worktreeOf(a.id));
  // The commit was backed up to the central repository before removal.
  expect(
    git(
      join(f.dataDir, "central", `${f.project_id}.git`),
      "cat-file",
      "-t",
      sha,
    ),
  ).toBe("commit");
  expect(
    f.state().decisions.filter((d) => d.trigger === "worktree_cleanup"),
  ).toEqual([]);
});

test("a released Assignment that lost its worktree_path is located by project, machine and id; dirty work goes to the human first", async () => {
  const a = released(scenario.coder, "A-202");
  expect(a.worktree_path).toBeUndefined();
  expect(a.branch).toBeUndefined();
  const dir = writer(a.id, "agent/C-1/W-202");
  writeFileSync(join(dir, "notes.txt"), "unsaved\n");

  await cleanup().sweep(f.project_id);

  // Not deleted: one data-deletion decision for the human.
  expect(existsSync(join(dir, "notes.txt"))).toBe(true);
  const [decision, ...more] = f
    .state()
    .decisions.filter(
      (d) => d.trigger === "worktree_cleanup" && d.assignment_id === a.id,
    );
  expect(more).toEqual([]);
  expect(decision).toMatchObject({
    category: "data_deletion",
    decider: "human",
    status: "open",
  });
  // The decision names the located directory; the record now keeps it.
  expect(f.state().assignments.find((x) => x.id === a.id)?.worktree_path).toBe(
    worktreeOf(a.id),
  );
  await cleanup().sweep(f.project_id);
  expect(existsSync(dir)).toBe(true);
  expect(
    f.state().decisions.filter((d) => d.trigger === "worktree_cleanup"),
  ).toHaveLength(1);

  f.apply(
    (s, actor, p) =>
      recordDecision(
        s,
        actor,
        {
          decision_id: required(decision).id,
          option: "force_clean",
          rationale: "reviewed",
          raw_quote: "cardigan worktree clean A-202 --force",
        },
        p,
      ),
    f.human,
  );
  await cleanup().sweep(f.project_id);

  expect(existsSync(dir)).toBe(false);
  expect(registered()).not.toContain(worktreeOf(a.id));
  const patches = readdirSync(join(f.dataDir, "cleanup", f.project_id));
  expect(patches).toEqual([expect.stringMatching(/^A-202-.*\.patch$/u)]);
});

test("a failed worker listing judges nothing absent and the next pass reclaims", async () => {
  const a = released(scenario.coder, "A-203", {
    worktree_path: worktreeOf("A-203"),
    branch: "agent/C-1/W-203",
  });
  const dir = writer(a.id, "agent/C-1/W-203");
  const verifier = released(scenario.reviewer, "A-303");
  const buildDir = build(verifier.id);
  failListing = true;

  const executor = cleanup();
  await executor.sweep(f.project_id);
  expect(existsSync(dir)).toBe(true);
  expect(existsSync(buildDir)).toBe(true);
  expect(reports).toEqual([
    expect.stringContaining(
      `worker directory listing for ${f.project_id}/${MACHINE} failed`,
    ),
  ]);

  // Same executor: the failure was not remembered as "already removed".
  failListing = false;
  await executor.sweep(f.project_id);
  expect(existsSync(dir)).toBe(false);
  expect(existsSync(buildDir)).toBe(false);
});

test("an offline worker is not listed and keeps its directories", async () => {
  const machine = required(
    f.store.uow.read((tx) => tx.machines.get(f.project_id, MACHINE)),
  );
  f.store.uow.run((tx) =>
    tx.machines.put(f.project_id, { ...machine, status: "offline" }),
  );
  const verifier = released(scenario.reviewer, "A-304");
  const buildDir = build(verifier.id);

  await cleanup().sweep(f.project_id);

  expect(existsSync(buildDir)).toBe(true);
  expect(requests.filter((r) => r.operation === "directories")).toEqual([]);
});
