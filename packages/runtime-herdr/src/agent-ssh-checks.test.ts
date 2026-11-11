import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  type AgentListRunner,
  agentListChecks,
  agentProcessCommand,
  agentReceivePack,
  agentSshCommand,
  agentUploadPack,
} from "./agent-ssh.js";
import { type ExecutionConfig, resolveExecutionConfig } from "./execution.js";

/**
 * P2a-12 C: identity/agent_root literal-path rules (C-118#27, C-119#28) and
 * the read-only SSH check listing used by reconciliation.
 */
let root: string, execution: Extract<ExecutionConfig, { mode: "agent-ssh" }>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cg-ssh-checks-"));
  const identity = join(root, "identity"),
    hosts = join(root, "known_hosts");
  await writeFile(identity, "fixture-only", { mode: 0o600 });
  await writeFile(hosts, "fixture-only", { mode: 0o600 });
  const resolved = resolveExecutionConfig({
    CARDIGAN_RUNTIME_MODE: "agent-ssh",
    CARDIGAN_DATA_DIR: join(root, "private"),
    CARDIGAN_AGENT_ROOT: join(root, "agent"),
    CARDIGAN_AGENT_GID: "2001",
    CARDIGAN_AGENT_IDENTITY: identity,
    CARDIGAN_AGENT_KNOWN_HOSTS: hosts,
  });
  if (resolved.mode !== "agent-ssh") throw new Error("Wrong mode");
  execution = resolved;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const unsafePaths = [
  "",
  "relative",
  "/",
  "-key",
  "/tmp/key other",
  "/tmp/key\nother",
  "/tmp/key\rother",
  "/tmp/key\tother",
  "/tmp/key\0other",
  "/tmp/key\u0085other",
  "/tmp/key​other",
  '/tmp/"key"',
  "/tmp/'key'",
  "/tmp/key\\other",
  "/tmp/%d/key",
  "/tmp/%h",
  `/tmp/\${HOME}/key`,
  "/tmp/$HOME",
];

async function rejectsEverywhere(invalid: typeof execution, pattern: RegExp) {
  expect(() => agentSshCommand(invalid)).toThrow(pattern);
  await expect(agentProcessCommand(invalid, ["true"])).rejects.toThrow(pattern);
  for (const pack of [agentUploadPack, agentReceivePack])
    await expect(
      pack(invalid, join(execution.agentRoot, "repos", "project")),
    ).rejects.toThrow(pattern);
  await expect(agentListChecks(invalid, "project")).rejects.toThrow(pattern);
}

test("identityFile with %, $, whitespace, quotes or control characters is rejected before any SSH command", async () => {
  for (const identityFile of unsafePaths)
    await rejectsEverywhere(
      { ...execution, identityFile },
      /SSH identity path/,
    );
});

test("agent_root injection counterexamples are rejected before being joined into a remote command", async () => {
  for (const agentRoot of [
    ...unsafePaths,
    "/srv/agent;rm -rf ~",
    "/srv/agent$(id)",
    "/srv/agent`id`",
    "/srv/agent/../etc",
    "/srv/./agent",
    "/srv//agent",
    "/srv/agent/",
  ])
    await rejectsEverywhere({ ...execution, agentRoot }, /SSH agent root path/);
});

test("an IPv6 literal stays a bare destination; ssh splits user at the last @ and the port only travels in -p", async () => {
  const { args } = await agentProcessCommand(
    { ...execution, host: "fd7a:115c:a1e0::1", port: 2222 },
    ["true"],
  );
  expect(args.slice(-5, -1)).toEqual([
    "-p",
    "2222",
    "--",
    "agent@fd7a:115c:a1e0::1",
  ]);
  // OpenSSH keeps brackets in a user@host destination literally, so a
  // bracketed IPv6 address would never resolve.
  expect(args.join(" ")).not.toContain("[");
  const probe = spawnSync("ssh", ["-G", "-F", "/dev/null", ...args.slice(-3)], {
    encoding: "utf8",
  });
  if (probe.status === 0) {
    expect(probe.stdout).toMatch(/^hostname fd7a:115c:a1e0::1$/mu);
    expect(probe.stdout).toMatch(/^user agent$/mu);
  }
});

/** Runs the remote half of the SSH command locally, against a real layout. */
const localShell: AgentListRunner = async (_file, args) => {
  const result = spawnSync("sh", ["-c", args.at(-1) as string], {
    env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
  });
  return { code: result.status, stdout: result.stdout };
};

test("the SSH listing reports check directories and their Git registrations below the project's checks root", async () => {
  const checks = join(execution.agentRoot, "checks", "project"),
    clone = join(execution.agentRoot, "repos", "project");
  await mkdir(clone, { recursive: true });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.test",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.test",
      },
    });
  git(clone, "init", "-q");
  git(clone, "commit", "-q", "--allow-empty", "-m", "base");
  // registered + present, registered + missing, present + unregistered
  await mkdir(join(checks, "live"), { recursive: true });
  git(
    clone,
    "worktree",
    "add",
    "-q",
    "--detach",
    join(checks, "live", "worktree"),
  );
  await mkdir(join(checks, "gone"), { recursive: true });
  git(
    clone,
    "worktree",
    "add",
    "-q",
    "--detach",
    join(checks, "gone", "worktree"),
  );
  await rm(join(checks, "gone", "worktree"), { recursive: true });
  await mkdir(join(checks, "stray", "worktree"), { recursive: true });
  await mkdir(join(checks, "empty-attempt"), { recursive: true });
  // A developer worktree of the same clone is not a check registration.
  git(
    clone,
    "worktree",
    "add",
    "-q",
    "--detach",
    join(execution.agentRoot, "worktrees", "project", "A-1"),
  );
  const listing = await agentListChecks(execution, "project", {
    run: localShell,
  });
  expect(listing).toEqual({
    directories: [
      join(checks, "live", "worktree"),
      join(checks, "stray", "worktree"),
    ],
    registered: [
      join(checks, "gone", "worktree"),
      join(checks, "live", "worktree"),
    ],
  });
});

test("a project that never ran checks on the executor lists nothing", async () => {
  await expect(
    agentListChecks(execution, "project", { run: localShell }),
  ).resolves.toEqual({ directories: [], registered: [] });
});

test.each([
  ["ssh connection failure", { code: 255, stdout: Buffer.alloc(0) }],
  [
    "remote command failure after partial output",
    { code: 3, stdout: Buffer.from("/x/checks/project/a/worktree\0") },
  ],
  [
    "truncated output without the trailer",
    { code: 0, stdout: Buffer.from("/x/checks/project/a/worktree\0--\0") },
  ],
  ["killed by the timeout", { code: null, stdout: Buffer.alloc(0) }],
  ["output without a separator", { code: 0, stdout: Buffer.from("--end\0") }],
])("%s throws instead of returning an empty listing", async (_name, out) => {
  await expect(
    agentListChecks(execution, "project", { run: async () => out }),
  ).rejects.toThrow(/listing failed/);
});

test("the listing command is the pinned SSH entry with a fixed read-only script and validated arguments", async () => {
  let seen: readonly string[] = [];
  await agentListChecks(execution, "project", {
    run: async (file, args) => {
      expect(file).toBe("ssh");
      seen = args;
      return { code: 0, stdout: Buffer.from("--\0--end\0") };
    },
  });
  expect(seen).toContain("StrictHostKeyChecking=yes");
  const remote = seen.at(-1) as string;
  expect(remote).toContain(
    `'${join(execution.agentRoot, "checks", "project")}'`,
  );
  expect(remote).toContain(
    `'${join(execution.agentRoot, "repos", "project")}'`,
  );
  expect(remote).not.toMatch(/\brm\b|\bprune\b|\bremove\b/u);
  for (const project of ["../x", "-x", "a b", "a;b", ""])
    await expect(
      agentListChecks(execution, project, {
        run: async () => ({ code: 0, stdout: Buffer.from("--\0--end\0") }),
      }),
    ).rejects.toThrow(/agent-ssh project/);
});
