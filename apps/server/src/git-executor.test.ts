/**
 * P2a-12 C: candidate distribution to an explicit execution target and the
 * reconciliation scan of a project's merge-check executor.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentExecution } from "@cardigan/runtime-herdr";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ServerGit } from "./git.js";
import { type M4Fixture, m4Fixture } from "./m4-fixtures.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.test",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.test",
    },
  }).trim();

let f: M4Fixture,
  root: string,
  dataDir: string,
  source: string,
  execution: AgentExecution,
  executor: AgentExecution;
beforeEach(() => {
  f = m4Fixture();
  root = mkdtempSync(join(tmpdir(), "cardigan-executor-"));
  dataDir = join(root, "data");
  source = join(root, "source");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  for (const dir of ["agent", "ci-agent"])
    mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
  git(root, "init", "-q", "-b", "main", source);
  writeFileSync(join(source, "README.md"), "fixture\n");
  git(source, "add", "README.md");
  git(source, "commit", "-qm", "init");
  for (const name of ["identity", "known_hosts", "ci.key", "ci.known_hosts"]) {
    writeFileSync(join(root, name), "fixture\n");
    chmodSync(join(root, name), 0o600);
  }
  execution = {
    mode: "agent-ssh",
    dataDir,
    agentRoot: join(root, "agent"),
    gid: process.getgid?.() ?? 1000,
    machine: "cardigan-agent",
    identityFile: join(root, "identity"),
    knownHostsFile: join(root, "known_hosts"),
  };
  executor = {
    ...execution,
    agentRoot: join(root, "ci-agent"),
    machine: "cardigan-ci",
    identityFile: join(root, "ci.key"),
    knownHostsFile: join(root, "ci.known_hosts"),
    host: "cardigan-ci",
    hostKeyAlias: "cardigan-ci",
  };
  f.store.setProjectRepo({
    project_id: f.project_id,
    repo_path: source,
    base_branch: "main",
  });
});
afterEach(() => {
  f.close();
  rmSync(root, { recursive: true, force: true });
});

const noCapture = async (): Promise<never> => {
  throw new Error("Stream must not use text capture");
};

test("distribute() with an execution override pushes to that target's base clone; without one, to the default", async () => {
  const defaultRepo = join(execution.agentRoot, "repos", f.project_id),
    executorRepo = join(executor.agentRoot, "repos", f.project_id);
  for (const repository of [defaultRepo, executorRepo])
    git(root, "clone", "-q", "--no-local", source, repository);
  const requests: [string, string][] = [];
  const binding = new ServerGit({
    store: f.store,
    dataDir,
    execution,
    captureAgent: noCapture,
    receivePack: async (path, target) => {
      requests.push([path, target.machine]);
      return "git-receive-pack";
    },
  });
  const project = binding.projectOf(f.project_id);
  if (!project) throw new Error("Missing project");
  await binding.sync(project);
  const center = join(dataDir, "central", `${f.project_id}.git`),
    head = git(center, "rev-parse", "main");
  git(center, "update-ref", "refs/cardigan/candidates/A-1/x", head);

  await binding.distribute(project, executor);
  expect(requests).toEqual([[executorRepo, "cardigan-ci"]]);
  expect(git(executorRepo, "rev-parse", "refs/cardigan/candidates/A-1/x")).toBe(
    head,
  );
  // The default (development Agent) base clone was not touched.
  expect(() =>
    git(defaultRepo, "rev-parse", "--verify", "refs/cardigan/candidates/A-1/x"),
  ).toThrow();

  await binding.distribute(project);
  expect(requests).toEqual([
    [executorRepo, "cardigan-ci"],
    [defaultRepo, "cardigan-agent"],
  ]);
  expect(git(defaultRepo, "rev-parse", "refs/cardigan/candidates/A-1/x")).toBe(
    head,
  );
});

test("distribute() without an override keeps the default local layout", async () => {
  const binding = new ServerGit({
    store: f.store,
    dataDir,
    execution: { mode: "local", dataDir },
  });
  const project = binding.projectOf(f.project_id);
  if (!project) throw new Error("Missing project");
  await binding.sync(project);
  await binding.distribute(project);
  const repository = join(dataDir, "agent", "repos", f.project_id);
  expect(git(repository, "rev-parse", "refs/remotes/origin/main")).toBe(
    git(source, "rev-parse", "HEAD"),
  );
});

function reconcileBinding(options: {
  checkExecutor?: (project_id: string) => AgentExecution | undefined;
  listChecks?: ConstructorParameters<typeof ServerGit>[0]["listChecks"];
}) {
  const binding = new ServerGit({
    store: f.store,
    dataDir,
    execution,
    captureAgent: noCapture,
    ...options,
  });
  const project = binding.projectOf(f.project_id);
  if (!project) throw new Error("Missing project");
  return { binding, project };
}
const localStray = () => {
  const path = join(
    execution.agentRoot,
    "checks",
    f.project_id,
    "stray",
    "worktree",
  );
  mkdirSync(path, { recursive: true });
  return path;
};
const now = () => ({ attempts: [], now: new Date().toISOString() });

test("without a project executor, reconciliation only scans the local checks root with readdir", async () => {
  const stray = localStray();
  let listed = 0;
  const { binding, project } = reconcileBinding({
    checkExecutor: () => undefined,
    listChecks: async () => {
      listed++;
      return { directories: [], registered: [] };
    },
  });
  const findings = await binding.reconcile(project, [], [], now);
  expect(listed).toBe(0);
  expect(findings.map((x) => [x.kind, x.path])).toEqual([
    ["orphan_worktree", stray],
  ]);
});

test("a project executor is listed over SSH; orphan, stale registration and unreachable stay distinct", async () => {
  const stray = localStray();
  const remote = `${executor.agentRoot}/checks/${f.project_id}`;
  const calls: [string, string][] = [];
  let result: () => Promise<{
    directories: readonly string[];
    registered: readonly string[];
  }> = async () => ({
    directories: [`${remote}/running/worktree`, `${remote}/orphan/worktree`],
    registered: [`${remote}/running/worktree`, `${remote}/stale/worktree`],
  });
  const { binding, project } = reconcileBinding({
    checkExecutor: (id) => (id === f.project_id ? executor : undefined),
    listChecks: async (target, id) => {
      calls.push([target.machine, id]);
      return result();
    },
  });
  const checks = () => ({
    now: new Date().toISOString(),
    attempts: [
      {
        attempt_id: "running",
        status: "running" as const,
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
  expect(
    (await binding.reconcile(project, [], [], checks)).map((x) => [
      x.kind,
      x.path,
    ]),
  ).toEqual([
    ["orphan_worktree", stray],
    ["orphan_worktree", `cardigan-ci:${remote}/orphan/worktree`],
    ["stale_registration", `cardigan-ci:${remote}/stale/worktree`],
  ]);
  expect(calls).toEqual([["cardigan-ci", f.project_id]]);

  // A failed listing is never read as "the directories are gone".
  result = async () => {
    throw new Error("ssh exited 255");
  };
  expect(
    (await binding.reconcile(project, [], [], checks)).map((x) => [
      x.kind,
      x.path,
    ]),
  ).toEqual([
    ["orphan_worktree", stray],
    ["executor_unreachable", `cardigan-ci:${remote}`],
  ]);
});
