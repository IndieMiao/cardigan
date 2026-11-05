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
import type { Assignment } from "@cardigan/domain";
import {
  CentralRepositoryService,
  GitDeliveryVerifier,
  GitWorktreeService,
} from "@cardigan/git-service";
import { CentralGitTransport } from "@cardigan/git-transport";
import { type AgentExecution, agentUploadPack } from "@cardigan/runtime-herdr";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AgentGitTransport } from "./agent-git.js";

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
    config = {
      ...config,
      agentRoot: join(root, "agent's workspace"),
      identityFile: join(root, "key's file"),
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
      io.fetchRefs(center, escaped, [
        "refs/heads/main:refs/cardigan/backups/local/escaped",
      ]),
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
    expect(
      verified,
      verified.ok ? "verified" : verified.error.message,
    ).toMatchObject({
      ok: true,
      value: [{ details: { sha, commits_ahead: 1 } }],
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
});
