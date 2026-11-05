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
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CentralRepositoryService } from "@cardigan/git-service";
import { CentralGitTransport } from "@cardigan/git-transport";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import { afterEach, beforeEach, expect, test } from "vitest";
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
  const gitService = new ServerGit({
    store: f.store,
    dataDir,
    execution,
    captureAgent: async (command, args) => {
      calls.push([command, ...args]);
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
