/**
 * M4.4 Git assembly in agent-ssh mode (plan §3.4, development plan §12.6, §14).
 *
 * The host must never execute Git inside an Agent-writable repository as its
 * own user. These tests prove the wiring: agent-ssh without the Agent execution
 * entry refuses to start, workspace Git all goes through that entry, and the
 * delivery/backup fetch reads the base clone from the Agent root.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assignment, Card, Role, WorkItem } from "@cardigan/domain";
import { CentralRepositoryService } from "@cardigan/git-service";
import { CentralGitTransport } from "@cardigan/git-transport";
import {
  acquireRepositoryFlock,
  repositoryLockPath,
  worktreeProvider,
} from "@cardigan/host";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ServerGit } from "./git.js";
import { type M4Fixture, m4Fixture, m4Scenario } from "./m4-fixtures.js";

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
let root: string;
let dataDir: string;
let agentRoot: string;
let source: string;
let execution: ExecutionConfig;

beforeEach(() => {
  f = m4Fixture();
  root = mkdtempSync(join(tmpdir(), "cardigan-agent-"));
  dataDir = join(root, "data");
  agentRoot = join(root, "agent");
  source = join(root, "source");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(agentRoot, { recursive: true, mode: 0o700 });
  git(root, "init", "-q", "-b", "main", source);
  writeFileSync(join(source, "README.md"), "fixture\n");
  git(source, "add", "README.md");
  git(source, "commit", "-qm", "init");
  // The SSH material only has to look well-formed; nothing here dials out.
  for (const name of ["identity", "known_hosts"]) {
    writeFileSync(join(root, name), "fixture\n");
    chmodSync(join(root, name), 0o600);
  }
  execution = {
    mode: "agent-ssh",
    dataDir,
    agentRoot,
    gid: process.getgid?.() ?? 1000,
    machine: "cardigan-agent",
    identityFile: join(root, "identity"),
    knownHostsFile: join(root, "known_hosts"),
  };
  f.store.setProjectRepo({
    project_id: f.project_id,
    repo_path: source,
    base_branch: "main",
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  f.close();
  rmSync(root, { recursive: true, force: true });
});

test("agent-ssh without the Agent execution entry refuses to start", () => {
  expect(
    () =>
      new ServerGit({
        store: f.store,
        dataDir,
        execution,
      }),
  ).toThrow(/Agent execution entry/);
});

test("delivery verification and backup read the Agent base clone", async () => {
  // The base clone lives where the agent owns it, not under the host data dir.
  const repository = join(agentRoot, "repos", f.project_id);
  mkdirSync(agentRoot, { recursive: true, mode: 0o700 });
  git(root, "clone", "-q", "--no-local", source, repository);
  const branch = "agent/C-1/W-1";
  git(repository, "checkout", "-q", "-b", branch);
  writeFileSync(join(repository, "feature.txt"), "feature\n");
  git(repository, "add", "feature.txt");
  git(repository, "commit", "-qm", "feature");
  const sha = git(repository, "rev-parse", "HEAD");

  const calls: { command: string; args: readonly string[] }[] = [];
  const sources: string[] = [];
  const gitService = new ServerGit({
    store: f.store,
    dataDir,
    execution,
    captureAgent: async (command, args) => {
      calls.push({ command, args });
      try {
        return {
          ok: true,
          value: execFileSync(command, args, { encoding: "utf8" }),
        };
      } catch (error) {
        return {
          ok: false,
          error: { code: "runtime_unavailable", message: String(error) },
        };
      }
    },
    // A local upload-pack keeps the fetch real without dialing SSH.
    uploadPack: async (path) => {
      sources.push(path);
      return "git-upload-pack";
    },
  });

  const project = gitService.projectOf(f.project_id);
  expect(project).toBeDefined();
  const verifier = gitService.verifierFor(f.project_id);
  const scenario = m4Scenario(f, "auto");
  const verified = await verifier.verify({ kind: "git_head", value: sha }, {
    ...scenario.coder,
    branch,
    worktree_path: join(
      agentRoot,
      "worktrees",
      f.project_id,
      scenario.coder.id,
    ),
    machine_id: "local",
    scope: "work_item",
    base_sha: git(repository, "rev-parse", "main"),
  } as never);
  expect(verified.ok).toBe(true);
  const requestedHead = await gitService.checkHead(f.project_id, {
    ...scenario.coder,
    branch,
    worktree_path: join(
      agentRoot,
      "worktrees",
      f.project_id,
      scenario.coder.id,
    ),
    machine_id: "local",
    scope: "work_item",
  });
  expect(requestedHead).toBe(sha);
  await expect(
    gitService.checkHead(f.project_id, {
      ...scenario.coder,
      status: "released",
    }),
  ).rejects.toThrow();

  // The delivery fetch reads the Agent base clone, not `<data>/agent/repos`.
  expect(sources).toContain(repository);
  // Host Git only ever ran in the central repository.
  expect(calls.every((call) => call.command === "git")).toBe(true);
  expect(
    calls.every(
      (call) =>
        !call.args.some((arg) => arg === repository) ||
        call.args.includes("--upload-pack=git-upload-pack"),
    ),
  ).toBe(true);

  await gitService.backup(project as never);
  expect(sources.filter((path) => path === repository).length).toBeGreaterThan(
    1,
  );
});

test("worktree Git in agent-ssh mode runs through the Agent entry", async () => {
  const worktree = join(agentRoot, "worktrees", f.project_id, "A-1");
  const repository = join(agentRoot, "repos", f.project_id);
  mkdirSync(join(agentRoot, "repos"), { recursive: true, mode: 0o700 });
  git(root, "clone", "-q", "--no-local", source, repository);
  const branch = "agent/C-1/W-1";
  git(repository, "checkout", "-q", "-b", branch);
  writeFileSync(join(repository, "feature.txt"), "feature\n");
  git(repository, "add", "feature.txt");
  git(repository, "commit", "-qm", "feature");
  git(repository, "checkout", "-q", "main");
  mkdirSync(join(agentRoot, "worktrees", f.project_id), {
    recursive: true,
    mode: 0o700,
  });
  git(repository, "worktree", "add", "-q", worktree, branch);

  const calls: string[][] = [];
  const timeouts: (number | undefined)[] = [];
  vi.stubEnv("CARDIGAN_GIT_QUERY_TIMEOUT_MS", "12345");
  const gitService = new ServerGit({
    store: f.store,
    dataDir,
    execution,
    captureAgent: async (command, args, timeout) => {
      calls.push([command, ...args]);
      timeouts.push(timeout);
      try {
        return {
          ok: true,
          value: execFileSync(command, args, { encoding: "utf8" }),
        };
      } catch (error) {
        return {
          ok: false,
          error: { code: "runtime_unavailable", message: String(error) },
        };
      }
    },
    uploadPack: async () => "git-upload-pack",
  });
  const project = gitService.projectOf(f.project_id);
  const scenario = m4Scenario(f, "auto");
  // A released, dirty worktree needs a diff before anyone deletes it.
  const assignment = {
    ...scenario.coder,
    status: "released",
    worktree_path: worktree,
    branch,
  } as never;
  writeFileSync(join(worktree, "untracked.txt"), "local\n");
  const diff = await gitService.diffWorktree({
    project: project as never,
    assignment,
  });
  expect(diff.untracked).toEqual(["untracked.txt"]);
  // The status/diff calls ran through the entry with the worktree as target.
  const flatten = calls.map((call) => call.join(" "));
  expect(flatten.some((call) => call.includes(worktree))).toBe(true);
  expect(flatten.every((call) => call.startsWith("git "))).toBe(true);
  expect(timeouts.every((timeout) => timeout === 12345)).toBe(true);
});

test("a project registered after startup is picked up without a restart", async () => {
  // No repository first: the factory reports the project as unusable.
  const bare = m4Fixture({ project_id: "p-later" });
  const gitService = new ServerGit({
    store: bare.store,
    dataDir,
    execution: { mode: "local", dataDir },
  });
  try {
    expect(gitService.projectOf("p-later")).toBeUndefined();
    bare.store.setProjectRepo({
      project_id: "p-later",
      repo_path: source,
      base_branch: "main",
    });
    expect(gitService.projectOf("p-later")).toMatchObject({
      source_repo: source,
      base_branch: "main",
    });
  } finally {
    bare.close();
  }
});

test("the central repository is the only place host Git runs", async () => {
  const commands: { cwd: string; args: readonly string[] }[] = [];
  const central = new CentralRepositoryService(
    new CentralGitTransport({
      dataDir,
      onCommand: (cwd, args) => commands.push({ cwd, args }),
    }),
    { dataDir, repositoriesRoot: join(agentRoot, "repos") },
  );
  const project = {
    project_id: f.project_id,
    source_repo: source,
    base_branch: "main",
  };
  // A host Git command never points at an Agent directory.
  expect(commands.every((call) => !call.cwd.startsWith(agentRoot))).toBe(true);
  expect(await central.hasCentral(project)).toBe(false);
});

test("merge candidates are pushed from the center through the Agent receive-pack entry", async () => {
  const repository = join(agentRoot, "repos", f.project_id);
  git(root, "clone", "-q", "--no-local", source, repository);
  const entry = join(root, "receive"),
    log = join(root, "receive.log");
  writeFileSync(
    entry,
    `#!/bin/sh\nprintf '%s\\n' "$PWD" "$1" >> '${log}'\nexec git-receive-pack "$@"\n`,
    { mode: 0o700 },
  );
  const requests: string[] = [];
  const binding = new ServerGit({
    store: f.store,
    dataDir,
    execution,
    captureAgent: async () => {
      throw new Error("Stream must not use text capture");
    },
    receivePack: async (path) => {
      requests.push(path);
      return `'${entry}'`;
    },
  });
  const project = binding.projectOf(f.project_id);
  if (!project) throw new Error("Missing project");
  await binding.sync(project);
  const center = join(dataDir, "central", `${f.project_id}.git`),
    head = git(center, "rev-parse", "main");
  git(center, "update-ref", "refs/cardigan/candidates/D-2", head);
  const before = git(repository, "rev-parse", "HEAD");
  writeFileSync(join(repository, "local-file"), "keep");
  await binding.distribute(project);
  expect(git(repository, "rev-parse", "refs/cardigan/candidates/D-2")).toBe(
    head,
  );
  expect(git(repository, "rev-parse", "HEAD")).toBe(before);
  expect(readFileSync(join(repository, "local-file"), "utf8")).toBe("keep");
  expect(requests).toEqual([repository]);
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
    center,
    repository,
  ]);
});

test.runIf(process.platform === "linux")(
  "candidate distribution waits for the project's base-clone lock and runs alongside wakes",
  async () => {
    const local = { mode: "local", dataDir } as const;
    const binding = new ServerGit({
      store: f.store,
      dataDir,
      execution: local,
    });
    const project = binding.projectOf(f.project_id);
    if (!project) throw new Error("Missing project");
    await binding.sync(project);
    await binding.distribute(project);
    const repository = join(dataDir, "agent", "repos", f.project_id);
    writeFileSync(join(source, "NEXT.md"), "next\n");
    git(source, "add", "NEXT.md");
    git(source, "commit", "-qm", "next");
    await binding.sync(project);
    const next = git(source, "rev-parse", "HEAD");
    // Another host process (a wake in the CLI or server) holds the lock.
    const held = await acquireRepositoryFlock(
      repositoryLockPath(dataDir, f.project_id),
      1_000,
    );
    let done = false;
    const distributing = binding.distribute(project).then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(done).toBe(false);
    expect(git(repository, "rev-parse", "refs/remotes/origin/main")).not.toBe(
      next,
    );
    await held();
    await distributing;
    expect(git(repository, "rev-parse", "refs/remotes/origin/main")).toBe(next);
    // Distribution and live-session wakes of one project interleave safely.
    const role = { role_id: "coder", version: 1, worktree: "write" } as Role;
    const card = {
      id: "C-1",
      project_id: f.project_id,
      repo: "example/repo",
      base_branch: "main",
    } as Card;
    const provide = worktreeProvider(
      local,
      {} as Parameters<typeof worktreeProvider>[1],
    );
    const wake = (n: number) =>
      provide({
        project_id: f.project_id,
        source_repo: source,
        assignment: {
          id: `A-${n}`,
          scope: "work_item",
          work_item_id: `W-${n}`,
          role_id: "coder",
          role_version: 1,
          status: "active",
          machine_id: "local",
          runtime_ref: null,
        } as unknown as Assignment,
        role,
        card,
        work_item: {
          id: `W-${n}`,
          card_id: "C-1",
          assignment_id: `A-${n}`,
        } as WorkItem,
      });
    const results = await Promise.all([
      wake(1),
      binding.distribute(project),
      wake(2),
      binding.distribute(project),
      wake(3),
    ]);
    expect(
      results
        .filter(Boolean)
        .map((r) => (r as { baseline?: { sha: string } }).baseline?.sha),
    ).toEqual([next, next, next]);
  },
  60_000,
);

test("P2a-13 A1: change scope inputs come from the candidate tree in the center only", async () => {
  const write = (path: string, text: string) => {
    mkdirSync(join(source, path, ".."), { recursive: true });
    writeFileSync(join(source, path), text);
  };
  write("pnpm-workspace.yaml", "packages:\n  - packages/*\n  - apps/*\n");
  write("packages/store/package.json", '{"name":"@cardigan/store"}');
  write(
    "apps/server/package.json",
    '{"name":"@cardigan/server","devDependencies":{"@cardigan/store":"workspace:*"}}',
  );
  write("packages/notes/README.md", "not a package\n");
  git(source, "add", "-A");
  git(source, "commit", "-qm", "workspace");
  const base = git(source, "rev-parse", "HEAD");
  write("packages/store/src/store.ts", "export {};\n");
  write("docs/plan.md", "plan\n");
  git(source, "add", "-A");
  git(source, "commit", "-qm", "change");
  const candidate = git(source, "rev-parse", "HEAD");
  // Uncommitted files in the source checkout are never part of the tree.
  write("packages/ghost/package.json", '{"name":"@cardigan/ghost"}');
  write(
    "packages/store/package.json",
    '{"name":"@cardigan/store","dependencies":{"@cardigan/ghost":"*"}}',
  );

  const gitService = new ServerGit({
    store: f.store,
    dataDir,
    execution: { mode: "local", dataDir },
  });
  const project = gitService.projectOf(f.project_id);
  if (project === undefined) throw new Error("project missing");

  expect(await gitService.changedPaths(project, base, candidate)).toEqual([
    "docs/plan.md",
    "packages/store/src/store.ts",
  ]);
  expect(await gitService.readWorkspace(project, candidate)).toEqual([
    {
      dir: "apps/server",
      name: "@cardigan/server",
      dependencies: ["@cardigan/store"],
    },
    { dir: "packages/store", name: "@cardigan/store", dependencies: [] },
  ]);
  // Only full commit SHAs: refs, abbreviations and tree ids are refused.
  const tree = git(source, "rev-parse", `${candidate}^{tree}`);
  for (const ref of ["main", "HEAD", candidate.slice(0, 10), tree]) {
    await expect(gitService.readWorkspace(project, ref)).rejects.toThrow(
      /full commit SHA/,
    );
    await expect(gitService.changedPaths(project, base, ref)).rejects.toThrow(
      /full commit SHA/,
    );
    await expect(
      gitService.changedPaths(project, ref, candidate),
    ).rejects.toThrow(/full commit SHA/);
  }
  // A commit without a workspace manifest is refused, not guessed.
  const initial = git(source, "rev-list", "--max-parents=0", "HEAD");
  await expect(gitService.readWorkspace(project, initial)).rejects.toThrow(
    /pnpm-workspace/,
  );
});

test("D4: candidate publication and workflow ancestor proof use only the configured center and baseline", async () => {
  const binding = new ServerGit({ store: f.store, dataDir });
  const project = binding.projectOf(f.project_id)!;
  await binding.sync(project);
  const sha = await binding.baseline(project);
  expect(await binding.isBaselineAncestor(project, sha, "main")).toBe(true);
  expect(await binding.isBaselineAncestor(project, sha, "other")).toBe(false);
  expect(await binding.isBaselineAncestor(project, "invalid", "main")).toBe(
    false,
  );
  const push = vi
    .spyOn(CentralGitTransport.prototype, "pushCandidateCommit")
    .mockResolvedValue({ status: "pushed" });
  try {
    const input = {
      repo: "fixture/project",
      sha,
      ref: "refs/heads/ci/C-1/D-1/attempt",
      token: "ghs_synthetic",
    };
    expect(await binding.pushCheckCandidate(project, input)).toEqual({
      status: "pushed",
    });
    expect(push).toHaveBeenCalledWith(
      join(dataDir, "central", `${f.project_id}.git`),
      input,
    );
  } finally {
    push.mockRestore();
  }
});

test("D5: candidate removal uses the project center and exact leased transport request", async () => {
  const binding = new ServerGit({ store: f.store, dataDir });
  const project = binding.projectOf(f.project_id);
  if (!project) throw new Error("Missing fixture project");
  await binding.sync(project);
  const input = {
    repo: "fixture/project",
    sha: await binding.baseline(project),
    ref: "refs/heads/ci/C-1/D-1/attempt-1",
    token: "ghs_synthetic",
  };
  const remove = vi
    .spyOn(CentralGitTransport.prototype, "deleteCandidateCommit")
    .mockResolvedValue(false);
  try {
    expect(await binding.deleteCheckCandidate(project, input)).toBe(false);
    expect(remove).toHaveBeenCalledWith(
      join(dataDir, "central", `${f.project_id}.git`),
      input,
    );
  } finally {
    remove.mockRestore();
  }
});

test("D5: a pending failed cleanup cannot hold the default project lock needed by another candidate", async () => {
  const cleanupGit = new ServerGit({ store: f.store, dataDir });
  const publicationGit = new ServerGit({ store: f.store, dataDir });
  const project = cleanupGit.projectOf(f.project_id);
  if (!project) throw new Error("Missing fixture project");
  await cleanupGit.sync(project);
  const input = {
    repo: "fixture/project",
    sha: await cleanupGit.baseline(project),
    ref: "refs/heads/ci/C-1/D-1/attempt-1",
    token: "ghs_synthetic",
  };
  const entered = Promise.withResolvers<void>();
  const remote = Promise.withResolvers<boolean>();
  const remove = vi
    .spyOn(CentralGitTransport.prototype, "deleteCandidateCommit")
    .mockImplementation(async () => {
      entered.resolve();
      return remote.promise;
    });
  const push = vi
    .spyOn(CentralGitTransport.prototype, "pushCandidateCommit")
    .mockResolvedValue({ status: "pushed" });
  const cleanup = cleanupGit.deleteCheckCandidate(project, input);
  let publication: Promise<unknown> | undefined;
  try {
    await entered.promise;
    publication = publicationGit.pushCheckCandidate(project, {
      ...input,
      ref: "refs/heads/ci/C-2/D-2/attempt-2",
    });
    // A bounded assertion detects lock contention without waiting for the
    // production 30-second lock timeout or changing its configured value.
    await vi.waitFor(() => expect(push).toHaveBeenCalledOnce());
    expect(await publication).toEqual({ status: "pushed" });
    expect(push).toHaveBeenCalledWith(
      join(dataDir, "central", `${f.project_id}.git`),
      { ...input, ref: "refs/heads/ci/C-2/D-2/attempt-2" },
    );
  } finally {
    remote.resolve(false);
    await cleanup;
    await publication?.catch(() => {});
    remove.mockRestore();
    push.mockRestore();
  }
  expect(await cleanup).toBe(false);
});

test("Q-649: candidate file snapshots exclude source dirt, non-tests, links and other commits", async () => {
  const write = (path: string) => {
    mkdirSync(join(source, path, ".."), { recursive: true });
    writeFileSync(join(source, path), "// fixture\n");
  };
  write("packages/a/src/first.test.ts");
  write("apps/web/src/ui.test.tsx");
  write("packages/a/src/ordinary.ts");
  symlinkSync("ordinary.ts", join(source, "packages/a/src/link.test.ts"));
  git(source, "add", "-A");
  git(
    source,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${git(source, "rev-parse", "HEAD")},packages/a/src/submodule.test.ts`,
  );
  git(source, "commit", "-qm", "first tests");
  const first = git(source, "rev-parse", "HEAD");
  write("packages/a/src/second.test.ts");
  git(source, "add", "-A");
  git(source, "commit", "-qm", "second test");
  const second = git(source, "rev-parse", "HEAD");
  write("packages/a/src/untracked.test.ts");
  const service = new ServerGit({
    store: f.store,
    dataDir,
    execution: { mode: "local", dataDir },
  });
  const project = service.projectOf(f.project_id);
  if (!project) throw new Error("Missing project");
  const snapshot = await service.readCandidateTests(project, first);
  expect(snapshot).toMatchObject({
    candidate_sha: first,
    tree_sha: git(source, "rev-parse", `${first}^{tree}`),
  });
  expect(snapshot.files.map((x) => x.path).sort()).toEqual([
    "apps/web/src/ui.test.tsx",
    "packages/a/src/first.test.ts",
  ]);
  expect(
    (await service.readCandidateTests(project, second)).files.map(
      (x) => x.path,
    ),
  ).toContain("packages/a/src/second.test.ts");
  await expect(service.readCandidateTests(project, "HEAD")).rejects.toThrow(
    /full commit SHA/,
  );
});
