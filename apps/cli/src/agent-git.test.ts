import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  Assignment,
  Card,
  Role,
  Runtime,
  WorkItem,
} from "@cardigan/domain";
import {
  CentralRepositoryService,
  type EnsureWorktreeInput,
  GitDeliveryVerifier,
  GitWorktreeService,
} from "@cardigan/git-service";
import { CentralGitTransport } from "@cardigan/git-transport";
import {
  AgentGitTransport,
  WorkerGitTransport,
  worktreeProvider,
} from "@cardigan/host";
import {
  type AgentExecution,
  agentUploadPack,
  workerGit,
  workerGitPack,
} from "@cardigan/runtime-herdr";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { workerGitFixture } from "../test-support/worker-git.js";

const exec = promisify(execFile);
const git = async (args: readonly string[], env = process.env) =>
  (await exec("git", [...args], { env })).stdout;
describe.skipIf(process.platform !== "linux")("Agent workspace Git", () => {
  let root: string,
    source: string,
    center: string,
    repository: string,
    worktree: string,
    config: AgentExecution;
  let calls: string[][], transport: AgentGitTransport;
  let hostCalls: { cwd: string; args: readonly string[] }[];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cg-agent-git-"));
    source = join(root, "source");
    config = {
      mode: "agent-ssh",
      dataDir: join(root, "data"),
      agentRoot: join(root, "agent"),
      gid: process.getgid?.() ?? 0,
      machine: "cardigan-agent",
      identityFile: join(root, "key"),
      knownHostsFile: join(root, "known"),
    };
    await mkdir(config.dataDir, { mode: 0o700 });
    await mkdir(config.agentRoot, { mode: 0o2750 });
    await chmod(config.agentRoot, 0o2750);
    await git(["init", "-b", "main", source]);
    await chmod(source, 0o700);
    await writeFile(join(source, "file"), "first");
    await git(["-C", source, "add", "file"]);
    await git([
      "-C",
      source,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "initial",
    ]);
    repository = join(config.agentRoot, "repos", "project");
    worktree = join(config.agentRoot, "worktrees", "project", "A-1");
    calls = [];
    hostCalls = [];
    center = await new CentralRepositoryService(
      new CentralGitTransport({ dataDir: config.dataDir }),
      { dataDir: config.dataDir },
    ).ensureCentral({
      project_id: "project",
      source_repo: source,
      base_branch: "main",
    });
    for (const path of [config.identityFile, config.knownHostsFile])
      await writeFile(path, "fixture-only", { mode: 0o600 });
    const bin = join(root, "default-bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "ssh"),
      `#!/usr/bin/env node
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2), at = args.indexOf('--');
if (args[at + 1] !== 'agent@localhost') process.exit(99);
const child = spawnSync('sh', ['-c', args.slice(at + 2).join(' ')], {cwd: ${JSON.stringify(config.agentRoot)}, env: {...process.env, CARDIGAN_TEST_GIT_CONTEXT:'agent'}, stdio:'inherit'});
process.exit(child.status ?? 98);
`,
      { mode: 0o700 },
    );
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    transport = new AgentGitTransport(
      config,
      "project",
      "A-1",
      async (args) => {
        calls.push([...args]);
        // No SSH/sudo in this test. This injected runner represents the agent identity.
        return git(args, {
          ...process.env,
          CARDIGAN_TEST_GIT_CONTEXT: "agent",
        });
      },
      { onHostCommand: (cwd, args) => hostCalls.push({ cwd, args }) },
    );
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });
  const mode = async (path: string) => (await lstat(path)).mode & 0o7777;
  const initialize = async () => {
    await transport.ensureClone(center, repository);
    await transport.fetch(repository, center);
    const sha = await transport.resolveCommit(
      repository,
      "refs/remotes/origin/main",
    );
    await transport.addWorktree(repository, worktree, sha, "agent/C-1/W-1");
    return sha;
  };
  test("private center pushes into an empty Agent repository without generating a bundle", async () => {
    const head = await initialize();
    expect(await mode(config.dataDir)).toBe(0o700);
    expect(await mode(repository)).toBe(0o2770);
    expect(await mode(worktree)).toBe(0o2770);
    const bundle = join(config.agentRoot, "inputs", "project", "source.bundle");
    await expect(lstat(bundle)).rejects.toMatchObject({ code: "ENOENT" });
    expect(hostCalls.some((call) => call.args.includes("push"))).toBe(true);
    expect(
      hostCalls.every(
        (call) =>
          call.cwd === center &&
          call.args.includes("transfer.fsckObjects=true"),
      ),
    ).toBe(true);
    expect(await transport.listWorktrees(repository)).toContainEqual({
      path: worktree,
      head,
      branch: "agent/C-1/W-1",
    });
    expect(await transport.isDirty(worktree)).toBe(false);
    expect(calls.some((args) => args.includes("init"))).toBe(true);
    expect(
      calls.some((args) => args.includes(`safe.directory=${repository}`)),
    ).toBe(true);
    expect(calls.every((args) => !args.includes(source))).toBe(true);
    expect(
      calls.every(
        (args) =>
          args.includes("protocol.allow=never") &&
          args.includes("protocol.file.allow=always"),
      ),
    ).toBe(true);
    expect((await git(["-C", source, "branch", "--show-current"])).trim()).toBe(
      "main",
    );
    expect((await git(["-C", source, "rev-parse", "HEAD"])).trim()).toBe(head);
  });
  test("M4.2 pushes pinned deliveries incrementally from the private center", async () => {
    const hostCalls: string[] = [];
    const io = new CentralGitTransport({
      dataDir: config.dataDir,
      agentRoot: config.agentRoot,
      onCommand: (cwd) => hostCalls.push(cwd),
    });
    const central = new CentralRepositoryService(io, {
      dataDir: config.dataDir,
    });
    const project = {
      project_id: "project",
      source_repo: source,
      base_branch: "main",
    };
    const center = await central.ensureCentral(project);
    await transport.ensureClone(center, repository);
    const original = await transport.resolveCommit(
      repository,
      "refs/remotes/origin/main",
    );
    await transport.addWorktree(repository, worktree, original);
    await git(["-C", source, "switch", "-c", "candidate"]);
    await writeFile(join(source, "file"), "delivery");
    await git([
      "-C",
      source,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-am",
      "delivery",
    ]);
    const sha = (await git(["-C", source, "rev-parse", "HEAD"])).trim();
    await io.fetchRefs(center, source, [
      "refs/heads/candidate:refs/cardigan/deliveries/D-1",
    ]);
    await transport.fetch(repository, center);
    expect(
      await transport.resolveCommit(repository, "refs/cardigan/deliveries/D-1"),
    ).toBe(sha);
    await transport.checkoutDetached(worktree, sha);
    expect(await transport.listWorktrees(repository)).toContainEqual({
      path: worktree,
      head: sha,
    });
    expect(
      calls.some(
        (args) => args.includes("checkout") && args.includes("--detach"),
      ),
    ).toBe(true);
    await expect(transport.checkoutDetached(source, sha)).rejects.toThrow(
      /Unexpected Agent Git path/,
    );
    await expect(
      lstat(join(config.agentRoot, "inputs", "project", "source.bundle")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      calls.every(
        (args) =>
          !args.includes(source) && args[args.indexOf("-C") + 1] !== center,
      ),
    ).toBe(true);
    expect(
      hostCalls.every((cwd) => cwd.startsWith(join(config.dataDir, "central"))),
    ).toBe(true);
  });
  test("M4.2 refuses a legacy Agent clone instead of rewriting its source", async () => {
    await initialize();
    await writeFile(
      join(config.agentRoot, "inputs", "project", "source.path"),
      source,
    );
    const central = new CentralRepositoryService(
      new CentralGitTransport({ dataDir: config.dataDir }),
      { dataDir: config.dataDir },
    );
    const center = await central.ensureCentral({
      project_id: "project",
      source_repo: source,
      base_branch: "main",
    });
    await expect(transport.ensureClone(center, repository)).rejects.toThrow(
      /rebuild/,
    );
    expect(
      await readFile(
        join(config.agentRoot, "inputs", "project", "source.path"),
        "utf8",
      ),
    ).toBe(source);
  });
  test("M4.2 verification and backup use streaming Agent upload-pack, never host Git in shared repositories", async () => {
    // C-127: paths with quotes or whitespace are refused before any SSH
    // command is built (identity: literal-path rule; agent root: also the
    // [A-Za-z0-9._/-] charset), so they never reach shell quoting.
    for (const unsafe of [
      { agentRoot: join(root, "agent's workspace") },
      { identityFile: join(root, "key's file") },
      { identityFile: join(root, "key file") },
    ])
      await expect(
        agentUploadPack(
          { ...config, ...unsafe },
          join(unsafe.agentRoot ?? config.agentRoot, "repos", "project"),
        ),
      ).rejects.toThrow(/Invalid SSH (identity|agent root) path/);
    config = {
      ...config,
      agentRoot: join(root, "agent-workspace"),
      identityFile: join(root, "key-file"),
    };
    await mkdir(config.agentRoot);
    await chmod(config.agentRoot, 0o2750);
    for (const path of [config.identityFile, config.knownHostsFile])
      await writeFile(path, "fixture-only", { mode: 0o600 });
    repository = join(config.agentRoot, "repos", "project");
    worktree = join(config.agentRoot, "worktrees", "project", "A-1");
    transport = new AgentGitTransport(
      config,
      "project",
      "A-1",
      (args) =>
        git(args, { ...process.env, CARDIGAN_TEST_GIT_CONTEXT: "agent" }),
      { onHostCommand: (cwd, args) => hostCalls.push({ cwd, args }) },
    );
    const bin = join(root, "bin"),
      trace = join(root, "ssh-trace"),
      unavailable = join(root, "ssh-down");
    await mkdir(bin);
    await writeFile(
      join(bin, "ssh"),
      String.raw`#!/usr/bin/env node
const { appendFileSync, existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2), at = args.indexOf('--');
if (args[at + 1] !== 'agent@localhost') process.exit(99);
appendFileSync(${JSON.stringify(trace)}, JSON.stringify({args, cwd:${JSON.stringify(config.agentRoot)}}) + '\n');
if (existsSync(${JSON.stringify(unavailable)})) process.exit(97);
const remote = args.slice(at + 2).join(' ');
const child = spawnSync('sh', ['-c', remote], { cwd: ${JSON.stringify(config.agentRoot)}, env: {...process.env, CARDIGAN_TEST_GIT_CONTEXT:'agent'}, stdio: 'inherit' });
process.exit(child.status ?? 98);
`,
      { mode: 0o700 },
    );
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    const hostCalls: { cwd: string; args: readonly string[] }[] = [];
    const io = new CentralGitTransport({
      dataDir: config.dataDir,
      agentRoot: config.agentRoot,
      onCommand: (cwd, args) => hostCalls.push({ cwd, args }),
    });
    const options = {
      dataDir: config.dataDir,
      repositoriesRoot: join(config.agentRoot, "repos"),
    };
    const project = {
      project_id: "project",
      source_repo: source,
      base_branch: "main",
    };
    const central = new CentralRepositoryService(io, {
      ...options,
      uploadPack: (path) => agentUploadPack(config, path),
    });
    const center = await central.ensureCentral(project);
    await transport.ensureClone(center, repository);
    await transport.fetch(repository, center);
    const escaped = join(config.agentRoot, "repos", "escape");
    await symlink(source, escaped);
    await expect(
      io.fetchRefs(
        center,
        escaped,
        ["refs/heads/main:refs/cardigan/backups/local/escaped"],
        undefined,
        true,
      ),
    ).rejects.toThrow(/Agent upload-pack/);
    const initial = await transport.resolveCommit(
      repository,
      "refs/remotes/origin/main",
    );
    await transport.addWorktree(repository, worktree, initial, "agent/C-1/W-1");
    await writeFile(join(worktree, "file"), "Agent delivery");
    await git([
      "-C",
      worktree,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-am",
      "delivery",
    ]);
    const sha = (await git(["-C", worktree, "rev-parse", "HEAD"])).trim();
    const a: Assignment = {
      id: "A-1" as never,
      scope: "work_item",
      work_item_id: "W-1" as never,
      role_id: "coder",
      role_version: 1,
      status: "active",
      runtime_state: "not_provisioned",
      runtime_ref: null,
      machine_id: "local",
      mcp_token_id: "reserved",
      created_at: "2030-01-01T00:00:00.000Z",
      branch: "agent/C-1/W-1",
      worktree_path: worktree,
      base_sha: initial,
    };
    const subject = { kind: "git_head" as const, value: sha };
    expect(
      (
        await new GitDeliveryVerifier(
          new CentralRepositoryService(io, options),
          project,
        ).verify(subject, a)
      ).ok,
    ).toBe(false);
    const verified = await new GitDeliveryVerifier(central, project).verify(
      subject,
      a,
    );
    expect(verified.ok, verified.ok ? "verified" : verified.error.message).toBe(
      true,
    );
    if (!verified.ok) throw new Error(verified.error.message);
    expect(verified.value.map((e) => e.kind)).toEqual(["diff", "commit"]);
    expect(verified.value.find((e) => e.kind === "commit")?.details).toEqual({
      sha,
      branch_head_sha: sha,
      tree_sha: (
        await git(["-C", worktree, "rev-parse", `${sha}^{tree}`])
      ).trim(),
      branch: a.branch,
      base_sha: initial,
      commits_ahead: 1,
    });
    expect(
      verified.value.find((e) => e.kind === "diff")?.details
        .role_rule_inventory,
    ).toMatchObject({
      version: 1,
      complete: true,
      base_sha: initial,
      sha,
      changes: [{ category: "ordinary" }],
    });
    await central.backupAgentBranches(project, "local");
    expect(
      await io.readRef(center, "refs/cardigan/backups/local/agent/C-1/W-1"),
    ).toBe(sha);
    const ssh = (await readFile(trace, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; cwd: string });
    expect(
      ssh.filter(({ args }) => args.some((a) => a.includes("upload-pack"))),
    ).toHaveLength(2);
    expect(
      hostCalls.some(
        ({ args }) => args.includes(repository) && args.includes("ls-remote"),
      ),
    ).toBe(false);
    expect(
      ssh.filter(({ args }) => args.some((a) => a.includes("receive-pack"))),
    ).toHaveLength(2);
    expect(
      ssh.every(
        ({ args, cwd }) =>
          cwd === config.agentRoot &&
          args.includes("IdentitiesOnly=yes") &&
          args.includes("StrictHostKeyChecking=yes"),
      ),
    ).toBe(true);
    expect(
      hostCalls.every(
        (call) =>
          call.cwd.startsWith(join(config.dataDir, "central")) &&
          call.args.includes("transfer.fsckObjects=true"),
      ),
    ).toBe(true);
    expect(
      hostCalls
        .filter((call) => call.args.includes(repository))
        .every((call) =>
          call.args.some(
            (arg) =>
              arg.startsWith("--upload-pack=") ||
              arg.startsWith("--receive-pack="),
          ),
        ),
    ).toBe(true);
    await writeFile(unavailable, "down");
    await expect(
      central.backupAgentBranches(project, "local"),
    ).rejects.toThrow();
    expect(
      await io.readRef(center, "refs/cardigan/backups/local/agent/C-1/W-1"),
    ).toBe(sha);
    expect((await readFile(trace, "utf8")).trim().split("\n")).toHaveLength(5);
    expect(await central.syncFromSource(project)).toBe("up_to_date");
  });
  test("fetch advances the baseline without overwriting an existing branch or dirty worktree", async () => {
    const initial = await initialize();
    await git([
      "-C",
      repository,
      "switch",
      "-c",
      "personal",
      "refs/remotes/origin/main",
    ]);
    await writeFile(join(repository, "file"), "base uncommitted");
    await git([
      "-C",
      repository,
      "remote",
      "set-url",
      "origin",
      join(config.agentRoot, "inputs", "project", "source.bundle"),
    ]);
    await writeFile(join(worktree, "file"), "agent uncommitted");
    await writeFile(join(source, "file"), "host next");
    await git([
      "-C",
      source,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-am",
      "next",
    ]);
    await new CentralRepositoryService(
      new CentralGitTransport({ dataDir: config.dataDir }),
      { dataDir: config.dataDir },
    ).syncFromSource({
      project_id: "project",
      source_repo: source,
      base_branch: "main",
    });
    await transport.ensureClone(center, repository);
    await transport.fetch(repository, center);
    expect(
      await transport.resolveCommit(repository, "refs/remotes/origin/main"),
    ).not.toBe(initial);
    expect(
      await transport.resolveCommit(repository, "refs/heads/agent/C-1/W-1"),
    ).toBe(initial);
    expect(await readFile(join(worktree, "file"), "utf8")).toBe(
      "agent uncommitted",
    );
    expect(await transport.isDirty(worktree)).toBe(true);
    expect(calls.filter((args) => args.includes("init"))).toHaveLength(1);
    expect(
      calls.some((args) => args.includes("bundle") || args.includes("clone")),
    ).toBe(false);
    expect((await git(["-C", repository, "rev-parse", "HEAD"])).trim()).toBe(
      initial,
    );
    expect(
      (await git(["-C", repository, "branch", "--show-current"])).trim(),
    ).toBe("personal");
    expect(await readFile(join(repository, "file"), "utf8")).toBe(
      "base uncommitted",
    );
    await expect(
      lstat(join(config.agentRoot, "inputs", "project", "source.bundle")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  test("workspace configuration executes only inside the agent runner, never host Git", async () => {
    await initialize();
    const hook = join(repository, "monitor.sh"),
      marker = join(root, "execution-context");
    await writeFile(
      hook,
      `#!/bin/sh\nprintf '%s' "$CARDIGAN_TEST_GIT_CONTEXT" > '${marker}'\nprintf 'token\\0'\n`,
      { mode: 0o700 },
    );
    await git(["-C", repository, "config", "core.fsmonitor", hook]);
    await transport.ensureClone(center, repository);
    await transport.fetch(repository, center);
    await transport.isDirty(worktree);
    expect(await readFile(marker, "utf8")).toBe("agent");
  });
  test("M4.3 worktree status, diff, removal and branch deletion run as the Agent", async () => {
    const hostCalls: { cwd: string; args: readonly string[] }[] = [];
    const io = new CentralGitTransport({
      dataDir: config.dataDir,
      agentRoot: config.agentRoot,
      onCommand: (cwd, args) => hostCalls.push({ cwd, args }),
    });
    const project = {
      project_id: "project",
      source_repo: source,
      base_branch: "main",
    };
    const central = new CentralRepositoryService(io, {
      dataDir: config.dataDir,
      repositoriesRoot: join(config.agentRoot, "repos"),
      uploadPack: async () => "git-upload-pack",
    });
    const center = await central.ensureCentral(project);
    // The base clone comes from the private center, like M4.2's real wiring.
    await transport.ensureClone(center, repository);
    await transport.fetch(repository, center);
    const initial = await transport.resolveCommit(
      repository,
      "refs/remotes/origin/main",
    );
    await transport.addWorktree(repository, worktree, initial, "agent/C-1/W-1");
    const service = new GitWorktreeService(transport, central, {
      dataDir: config.dataDir,
      repositoriesRoot: join(config.agentRoot, "repos"),
      worktreesRoot: join(config.agentRoot, "worktrees"),
    });
    const a = {
      id: "A-1",
      scope: "work_item",
      work_item_id: "W-1",
      role_id: "coder",
      role_version: 1,
      status: "active",
      runtime_state: "not_provisioned",
      runtime_ref: null,
      machine_id: "local",
      mcp_token_id: "reserved",
      created_at: "2030-01-01T00:00:00.000Z",
      branch: "agent/C-1/W-1",
      worktree_path: worktree,
      base_sha: initial,
    } as unknown as Assignment;
    await writeFile(join(worktree, "file"), "uncommitted");
    const diff = await service.diffWorktree({ project, assignment: a });
    expect(diff).toMatchObject({
      worktree_path: worktree,
      tracked: ["file"],
      untracked: [],
      reachable: true,
    });
    expect(diff.patch).toContain("+uncommitted");

    const outcome = await service.removeWorktree({
      project,
      assignment: a,
      force: true,
    });
    if (outcome.status !== "removed" || outcome.patch_path === undefined)
      throw new Error("expected a forced clean with a patch");
    expect((await lstat(outcome.patch_path)).mode & 0o777).toBe(0o600);
    expect(
      await readFile(outcome.patch_path, "utf8").then((text) =>
        text.includes("+uncommitted"),
      ),
    ).toBe(true);

    // The worktree and branch are gone, deleted through the Agent entry.
    await expect(lstat(worktree)).rejects.toThrow();
    expect(await transport.listWorktrees(repository)).not.toContainEqual(
      expect.objectContaining({ path: worktree }),
    );
    expect(
      calls.some(
        (args) =>
          args.includes("worktree") &&
          args.includes("remove") &&
          args.includes(worktree),
      ),
    ).toBe(true);
    expect(
      calls.some((args) => args.includes("branch") && args.includes("-D")),
    ).toBe(true);
    expect(
      calls.some(
        (args) =>
          args.includes("-C") &&
          args.includes(worktree) &&
          args.includes("status"),
      ),
    ).toBe(true);
    // Host Git only ever ran inside the private central repository.
    expect(hostCalls).not.toHaveLength(0);
    expect(
      hostCalls.every(
        (call) =>
          call.cwd.startsWith(join(config.dataDir, "central")) &&
          call.args.includes("transfer.fsckObjects=true"),
      ),
    ).toBe(true);
    expect(
      hostCalls.some((call) =>
        call.args.some(
          (arg) =>
            arg === worktree ||
            arg === repository ||
            arg.startsWith(join(config.agentRoot, "worktrees")),
        ),
      ),
    ).toBe(true);
    expect(
      hostCalls.every(
        (call) =>
          !call.args.includes("-C") ||
          call.args[call.args.indexOf("-C") + 1]?.startsWith(
            join(config.dataDir, "central"),
          ),
      ),
    ).toBe(true);
  });
  test("Agent baseline push honors the transfer timeout and names its configuration", async () => {
    const limited = new AgentGitTransport(
      config,
      "project",
      "A-1",
      (args) => git(args),
      { transferTimeoutMs: 1 },
    );
    await expect(limited.ensureClone(center, repository)).rejects.toThrow(
      /push timed out.*CARDIGAN_GIT_TRANSFER_TIMEOUT_MS/,
    );
    await expect(lstat(repository)).rejects.toMatchObject({ code: "ENOENT" });
  });
  test("P2a-3 places a detached build checkout in its protected leaf, never with a branch", async () => {
    const sha = await initialize();
    const build = join(config.agentRoot, "builds", "project", "A-1");
    await expect(
      transport.addWorktree(repository, build, sha, "agent/C-1/W-2"),
    ).rejects.toThrow(/must be detached/);
    await expect(
      transport.addWorktree(
        repository,
        join(config.agentRoot, "builds", "project", "A-2"),
        sha,
      ),
    ).rejects.toThrow(/Unexpected/);
    await transport.addWorktree(repository, build, sha);
    // Host-protected parent and shared leaf, like the Assignment worktree.
    expect(await mode(join(config.agentRoot, "builds", "project"))).toBe(
      0o2750,
    );
    expect(await mode(build)).toBe(0o2770);
    const listed = (await transport.listWorktrees(repository)).find(
      (entry) => entry.path === build,
    );
    expect(listed).toEqual({ path: build, head: sha });
    // Only the Agent identity ran Git in the build leaf.
    expect(
      hostCalls.some((call) => call.cwd.startsWith(config.agentRoot)),
    ).toBe(false);
    await transport.removeWorktree(repository, build, { force: true });
    expect(
      (await transport.listWorktrees(repository)).some(
        (entry) => entry.path === build,
      ),
    ).toBe(false);
  });
  test("rejects changed sources, escaped paths and shared source repositories", async () => {
    await initialize();
    await expect(transport.ensureClone(repository, repository)).rejects.toThrow(
      /Host Git source/,
    );
    await expect(transport.ensureClone(root, repository)).rejects.toThrow(
      /local source/,
    );
    await expect(transport.isDirty(source)).rejects.toThrow(/Unexpected/);
    await expect(
      transport.addWorktree(repository, source, "a".repeat(40)),
    ).rejects.toThrow(/Unexpected/);
    await expect(transport.ensureClone("relative", repository)).rejects.toThrow(
      /absolute/,
    );
    await expect(
      transport.ensureClone(source, join(config.agentRoot, "repos", "other")),
    ).rejects.toThrow(/Unexpected/);
  });
  test("refuses a namespace symlink and never falls back to host Git when agent execution fails", async () => {
    await symlink(config.dataDir, join(config.agentRoot, "repos"), "dir");
    await expect(transport.ensureClone(source, repository)).rejects.toThrow();
    expect(await readdir(config.dataDir)).toEqual(["central"]);
    expect(calls).toEqual([]);
    await rm(join(config.agentRoot, "repos"));
    const unavailable = new AgentGitTransport(
      config,
      "project",
      "A-1",
      async () => {
        throw new Error("agent unavailable");
      },
    );
    await expect(unavailable.ensureClone(source, repository)).rejects.toThrow(
      /agent unavailable/,
    );
    await expect(lstat(repository)).rejects.toThrow();
    expect(await readdir(join(config.agentRoot, "repos"))).toEqual([]);
  });
  test("synthetic Darwin writer and Linux reviewer clone, build and return deliveries on independent disks", async () => {
    const bin = join(root, "default-bin");
    await writeFile(
      join(bin, "ssh"),
      `#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
const args=process.argv.slice(2), command=args.at(-1);
const result=spawnSync('sh',['-c',command],{stdio:'inherit'});
process.exit(result.status ?? 98);
`,
      { mode: 0o700 },
    );
    const a = await workerGitFixture(root, config, "worker-a", "darwin");
    const b = await workerGitFixture(root, config, "worker-b");
    const commands: string[] = [];
    let valid = true;
    const first = new WorkerGitTransport(a.config, "project", "A-1", {
      onHostCommand: (cwd) => commands.push(cwd),
      validateTarget: () => {
        if (!valid) throw new Error("target changed");
      },
    });
    const second = new WorkerGitTransport(b.config, "project", "A-1");
    const repo = "/worker-fixture/repos/project";
    const path = "/worker-fixture/worktrees/project/A-1";
    const build = "/worker-fixture/builds/project/A-1";
    await expect(lstat(repo)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(first.ensureClone(source, repo)).rejects.toThrow(
      /registered private center/,
    );
    // Readiness and IO share the installed layout: protected 0750 parents and
    // pre-created 0700 project leaves. The fixture substitutes ownership only.
    for (const worker of [a, b]) {
      expect((await worker.readiness()).failures).toEqual([]);
      expect(
        await workerGit(worker.config, {
          operation: "check",
          project: "project",
          assignment: "A-1",
          timeout_ms: 15000,
        }),
      ).toBe(true);
      for (const kind of ["repos", "worktrees", "builds"]) {
        expect((await lstat(join(worker.disk, kind))).mode & 0o777).toBe(0o750);
        expect(
          (await lstat(join(worker.disk, kind, "project"))).mode & 0o777,
        ).toBe(0o700);
      }
    }
    const installed = await lstat(join(a.disk, "repos/project"));
    await first.ensureClone(center, repo);
    await second.ensureClone(center, repo);
    expect((await lstat(join(a.disk, "repos/project"))).ino).toBe(
      installed.ino,
    );
    expect(await readdir(join(a.disk, "repos"))).toEqual(["project"]);
    for (const key of ["receive.fsckObjects", "fetch.fsckObjects"]) {
      await git(["-C", join(a.disk, "repos/project"), "config", key, "false"]);
      const effective = await workerGit<string>(a.config, {
        operation: "git",
        project: "project",
        assignment: "A-1",
        timeout_ms: 15000,
        args: ["-C", repo, "config", "--get", key],
      });
      expect(effective.trim()).toBe("true");
    }
    const initial = await first.resolveCommit(repo, "refs/remotes/origin/main");
    const central = new CentralRepositoryService(
      new CentralGitTransport({ dataDir: config.dataDir }),
      { dataDir: config.dataDir },
    );
    const makeService = (worker: WorkerGitTransport, machineId: string) =>
      new GitWorktreeService(worker, central, {
        dataDir: config.dataDir,
        machineId,
        files: worker.files,
        repositoriesRoot: "/worker-fixture/repos",
        worktreesRoot: "/worker-fixture/worktrees",
        buildsRoot: "/worker-fixture/builds",
      });
    const request = (
      machine_id: string,
      readonly: boolean,
    ): EnsureWorktreeInput => ({
      project_id: "project",
      source_repo: source,
      assignment: {
        id: "A-1",
        status: "active",
        scope: "work_item",
        machine_id,
        role_id: "coder",
        role_version: 1,
        work_item_id: "W-1",
      } as Assignment,
      role: {
        role_id: "coder",
        version: 1,
        worktree: readonly ? "readonly" : "write",
      } as Role,
      card: {
        id: "C-1",
        project_id: "project",
        repo: source,
        base_branch: "main",
      } as Card,
      work_item: {
        id: "W-1",
        card_id: "C-1",
        assignment_id: "A-1",
        kind: readonly ? "verify" : "produce",
      } as WorkItem,
      ...(readonly ? { target_sha: initial } : {}),
    });
    const writer = makeService(first, "worker-a"),
      reviewer = makeService(second, "worker-b");
    const [placed, repeated] = await Promise.all([
      writer.ensureWorktree(request("worker-a", false)),
      makeService(first, "worker-a").ensureWorktree(request("worker-a", false)),
    ]);
    expect(repeated?.base_sha).toBe(placed?.base_sha);
    expect(placed?.base_sha).toBe(initial);
    await expect(
      writer.ensureWorktree(request("worker-b", false)),
    ).rejects.toThrow(/target Assignment/);
    await reviewer.ensureWorktree(request("worker-b", true));
    await reviewer.ensureBuildCheckout(request("worker-b", true));
    await writeFile(join(a.disk, "worktrees/project/A-1/file"), "dirty writer");
    await writeFile(join(b.disk, "builds/project/A-1/file"), "dirty build");
    await writeFile(join(source, "file"), "new baseline");
    await git(["-C", source, "add", "."]);
    await git([
      "-C",
      source,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=f@example.invalid",
      "commit",
      "-m",
      "advance",
    ]);
    await central.syncFromSource({
      project_id: "project",
      source_repo: source,
      base_branch: "main",
    });
    const resumed = await writer.ensureWorktree({
      ...request("worker-a", false),
      assignment: {
        ...request("worker-a", false).assignment,
        worktree_path: path,
        branch: "agent/C-1/W-1",
        base_sha: initial,
      },
    });
    expect(resumed?.base_sha).toBe(initial);
    const prepared = await worktreeProvider(
      a.config,
      {} as Runtime,
    )(request("worker-a", false));
    expect(prepared?.path).toBe(path);
    expect(
      await first.resolveCommit(repo, "refs/remotes/origin/main"),
    ).not.toBe(initial);
    expect(await second.resolveCommit(repo, "refs/remotes/origin/main")).toBe(
      initial,
    );
    expect(
      (await first.listWorktrees(repo)).find((w) => w.path === path)?.head,
    ).toBe(initial);
    expect(await first.changes(path)).toEqual({
      tracked: ["file"],
      untracked: [],
    });
    expect(
      await readFile(join(b.disk, "worktrees/project/A-1/file"), "utf8"),
    ).toBe("first");
    await reviewer.ensureBuildCheckout(request("worker-b", true));
    expect(
      await readFile(join(b.disk, "builds/project/A-1/file"), "utf8"),
    ).toBe("first");
    expect(
      (await second.listWorktrees(repo))
        .filter((w) => [path, build].includes(w.path))
        .every((w) => w.head === initial && !w.branch),
    ).toBe(true);
    await reviewer.removeBuildCheckout({
      project: {
        project_id: "project",
        source_repo: source,
        base_branch: "main",
      },
      assignment_id: "A-1",
      idle: () => true,
    });
    expect(await second.files.exists(build)).toBe(false);
    const address = {
      kind: "worker-remote" as const,
      path: repo,
      root: a.config.agentRoot,
      project_id: "project",
      machine_id: "worker-a",
    };
    const io = new CentralGitTransport({ dataDir: config.dataDir });
    await expect(
      io.fetchRefs(center, address, [
        "refs/heads/agent/C-1/W-1:refs/cardigan/incoming/A-1",
      ]),
    ).rejects.toThrow(/upload-pack/);
    await io.fetchRefs(
      center,
      address,
      ["refs/heads/agent/C-1/W-1:refs/cardigan/incoming/A-1"],
      await workerGitPack(a.config, {
        operation: "upload-pack",
        project: "project",
        assignment: "A-1",
        repository: repo,
        source: "cardigan-central:project",
        format: "sha1",
        timeout_ms: 15000,
      }),
    );
    expect(await io.readRef(center, "refs/cardigan/incoming/A-1")).toBe(
      initial,
    );
    await central.pinDelivery(
      { project_id: "project", source_repo: source, base_branch: "main" },
      "D-1",
      initial,
    );
    await second.fetch(repo, center);
    expect(
      await second.resolveCommit(repo, "refs/cardigan/deliveries/D-1"),
    ).toBe(initial);
    const outside = join(root, "outside-worker");
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, join(b.disk, "builds/project/A-1"), "dir");
    await expect(second.files.exists(build)).rejects.toThrow(/Worker Git/);
    await expect(
      second.files.prepareWorktree("/worker-fixture/worktrees/project/A-2"),
    ).rejects.toThrow(/Worker Git/);
    await expect(
      workerGit(a.config, {
        operation: "validate",
        project: "project",
        assignment: "A-1",
        repository: repo,
        source: "cardigan-central:project",
        format: "sha256",
        timeout_ms: 15000,
      }),
    ).rejects.toThrow(/Worker Git/);
    await first.ensureClone(center, repo); // Idempotent after a successful publication.
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((cwd) => cwd === center)).toBe(true);
    valid = false;
    await expect(first.fetch(repo, center)).rejects.toThrow(/target changed/);
    valid = true;
    await git([
      "-C",
      join(a.disk, "repos/project"),
      "config",
      "remote.origin.url",
      "wrong",
    ]);
    await expect(first.ensureClone(center, repo)).rejects.toThrow(/Worker Git/);
  }, 20_000);

  test("worker publication failure retains its stage and never replaces the clone", async () => {
    const bin = join(root, "default-bin");
    await writeFile(
      join(bin, "ssh"),
      `#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
const command=process.argv.at(-1);
const result=spawnSync('sh',['-c',command],{stdio:'inherit'});
process.exit(command.includes('receive-pack') ? 255 : result.status ?? 98);
`,
      { mode: 0o700 },
    );
    const a = await workerGitFixture(root, config, "worker-a");
    const worker = new WorkerGitTransport(a.config, "project", "A-1");
    await expect(
      worker.ensureClone(center, worker.repository),
    ).rejects.toThrow();
    const entries = await readdir(join(a.disk, "repos/project"));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^\.clone-project-/u);
    await expect(
      lstat(join(a.disk, "repos/project/.git")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  test("production worker helper refuses unprotected namespaces and missing target bindings", async () => {
    const a = await workerGitFixture(root, config, "worker-a");
    await expect(
      exec("/usr/bin/python3", [
        "-I",
        "-B",
        "deploy/worker-git.py",
        JSON.stringify({
          operation: "exists",
          root: a.disk,
          project: "project",
          assignment: "A-1",
          path: "/usr/bin:/bin",
          timeout_ms: 1000,
        }),
      ]),
    ).rejects.toMatchObject({ stderr: "worker_git_rejected\n" });
    expect(
      () => new AgentGitTransport(a.config, "project", "A-1", async () => ""),
    ).toThrow(/worker transport/);
    expect(
      () =>
        new WorkerGitTransport(
          { ...a.config, target: undefined } as unknown as AgentExecution,
          "project",
          "A-1",
        ),
    ).toThrow(/trusted project/);
    await expect(
      workerGit(
        { ...a.config, gitHelper: undefined } as unknown as AgentExecution,
        {
          operation: "exists",
          project: "project",
          assignment: "A-1",
          timeout_ms: 1000,
        },
      ),
    ).rejects.toThrow(/unavailable/);
  });

  test("readiness and Git preparation both reject changed namespaces and preserve unrelated files", async () => {
    await writeFile(
      join(root, "default-bin", "ssh"),
      `#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
const result=spawnSync('sh',['-c',process.argv.at(-1)],{stdio:'inherit'});
process.exit(result.status ?? 98);
`,
      { mode: 0o700 },
    );
    const a = await workerGitFixture(root, config, "worker-a");
    const worker = new WorkerGitTransport(a.config, "project", "A-1");
    const check = () =>
      workerGit(a.config, {
        operation: "check",
        project: "project",
        assignment: "A-1",
        timeout_ms: 15000,
      });
    await expect(check()).resolves.toBe(true);
    expect((await a.readiness()).failures).toEqual([]);
    await chmod(join(a.disk, "repos"), 0o700);
    expect((await a.readiness()).failures).toContain("worker_directories");
    await expect(check()).rejects.toThrow("Worker Git operation failed");
    await expect(worker.ensureClone(center, worker.repository)).rejects.toThrow(
      "Worker Git operation failed",
    );
    await chmod(join(a.disk, "repos"), 0o750);
    await writeFile(join(a.disk, "repos/project/keep"), "unrelated data");
    await expect(worker.ensureClone(center, worker.repository)).rejects.toThrow(
      "Worker Git operation failed",
    );
    expect(await readFile(join(a.disk, "repos/project/keep"), "utf8")).toBe(
      "unrelated data",
    );
    await rm(join(a.disk, "repos/project/keep"));
    await worker.ensureClone(center, worker.repository);
    const head = await worker.resolveCommit(
      worker.repository,
      "refs/remotes/origin/main",
    );
    await expect(
      workerGit(a.config, {
        operation: "stage",
        project: "project",
        assignment: "A-1",
        timeout_ms: 15000,
        source: "cardigan-central:project",
        format: "sha1",
      }),
    ).rejects.toThrow("Worker Git operation failed");
    expect(
      await worker.resolveCommit(worker.repository, "refs/remotes/origin/main"),
    ).toBe(head);
  });

  test("staged Git metadata is published atomically and never replaces an existing entry", async () => {
    const { stdout } = await exec("python3", [
      "-I",
      "-B",
      "-c",
      `
import importlib.util,os,pathlib,sys
spec=importlib.util.spec_from_file_location('worker','deploy/worker-git.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=pathlib.Path(sys.argv[1])
for kind in ('directory','file','absent'):
    source=root/(kind+'-source');source.mkdir()
    destination=root/(kind+'-destination');destination.mkdir()
    (source/'.git').mkdir();(source/'.git'/'evidence').write_text('staged')
    if kind=='directory': (destination/'.git').mkdir()
    if kind=='file': (destination/'.git').write_text('existing')
    a=os.open(source,m.DIRECTORY);b=os.open(destination,m.DIRECTORY)
    try:
        try:
            m.publish(a,'.git',b,'.git')
            assert kind=='absent'
        except OSError:
            assert kind!='absent'
        if kind=='absent':
            assert not (source/'.git').exists()
            assert (destination/'.git'/'evidence').read_text()=='staged'
        else:
            assert (source/'.git'/'evidence').read_text()=='staged'
            assert list((destination/'.git').iterdir())==[] if kind=='directory' else (destination/'.git').read_text()=='existing'
    finally: os.close(a);os.close(b)
print('atomic publication checked')
`,
      root,
    ]);
    expect(stdout.trim()).toBe("atomic publication checked");
  });
});
