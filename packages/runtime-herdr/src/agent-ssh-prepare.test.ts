import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  agentCleanupCheckCommand,
  agentPrepareCheckCommand,
} from "./agent-ssh.js";
import type { ExecutionConfig } from "./execution.js";

/**
 * C-130: a remote executor prepares and removes a merge check's lock,
 * container and alias itself, over the pinned SSH entry. These tests run the
 * remote half of the generated SSH command locally (no SSH connection).
 */
let root: string, execution: Extract<ExecutionConfig, { mode: "agent-ssh" }>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cg-ssh-prepare-"));
  const identityFile = join(root, "identity"),
    knownHostsFile = join(root, "known_hosts");
  await writeFile(identityFile, "fixture-only", { mode: 0o600 });
  await writeFile(knownHostsFile, "fixture-only", { mode: 0o600 });
  await mkdir(join(root, "agent"));
  execution = {
    mode: "agent-ssh",
    dataDir: join(root, "private"),
    agentRoot: join(root, "agent"),
    // Not the host's group: remote preparation never consults it.
    gid: 2_000_001,
    machine: "cardigan-ci",
    identityFile,
    knownHostsFile,
    host: "cardigan-ci",
    port: 22,
    user: "agent",
    hostKeyAlias: "cardigan-ci",
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const remote = (args: readonly string[]) => {
  const result = spawnSync("sh", ["-c", args.at(-1) as string], {
    env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    encoding: "utf8",
  });
  return { code: result.status, stdout: result.stdout };
};
const input = { project: "project", attempt: "attempt-1", alias: "aAlias_-1" };

test.skipIf(process.platform !== "linux")(
  "preparation runs on the executor through the pinned SSH entry and creates private leaves and the slot lock",
  async () => {
    const command = await agentPrepareCheckCommand(execution, {
      ...input,
      slot: 2,
    });
    expect(command.file).toBe("ssh");
    expect(command.args).toEqual(
      expect.arrayContaining([
        "-F",
        "/dev/null",
        "StrictHostKeyChecking=yes",
        "HostKeyAlias=cardigan-ci",
        "agent@cardigan-ci",
      ]),
    );
    expect(command.args.at(-1)).toMatch(/^'env' '-i' /u);
    expect(command.paths).toEqual({
      container: join(execution.agentRoot, "checks", "project", "attempt-1"),
      alias: join(execution.agentRoot, "s", "aAlias_-1"),
      lock: join(execution.agentRoot, "merge-check-2.lock"),
    });
    expect(remote(command.args)).toEqual({ code: 0, stdout: command.expect });
    for (const path of [command.paths.container, command.paths.alias]) {
      const info = await lstat(path);
      expect(info.isDirectory()).toBe(true);
      expect(info.mode & 0o7777).toBe(0o700);
    }
    const lock = await lstat(command.paths.lock as string);
    expect(lock.isFile() && lock.size === 0).toBe(true);
    expect(lock.mode & 0o777).toBe(0o600);

    // A check never reuses an attempt; the new alias is rolled back.
    const again = await agentPrepareCheckCommand(execution, {
      ...input,
      alias: "aOther",
      slot: 2,
    });
    expect(remote(again.args).code).toBe(5);
    expect(await readdir(join(execution.agentRoot, "s"))).toEqual([
      "aAlias_-1",
    ]);

    const cleanup = await agentCleanupCheckCommand(execution, command.paths);
    expect(remote(cleanup.args)).toEqual({ code: 0, stdout: cleanup.expect });
    expect(
      await readdir(join(execution.agentRoot, "checks", "project")),
    ).toEqual([]);
    expect(await readdir(join(execution.agentRoot, "s"))).toEqual([]);
    // Removing already-absent leaves is not an error.
    expect(remote(cleanup.args).code).toBe(0);
  },
);

test("an unserialized check prepares no lock", async () => {
  const command = await agentPrepareCheckCommand(execution, input);
  expect(command.paths.lock).toBeUndefined();
  expect(remote(command.args).code).toBe(0);
  expect(
    (await readdir(execution.agentRoot)).filter((n) => n.endsWith(".lock")),
  ).toEqual([]);
});

test("cleanup never removes contents: a non-empty leaf is reported", async () => {
  const command = await agentPrepareCheckCommand(execution, input);
  expect(remote(command.args).code).toBe(0);
  await writeFile(join(command.paths.container, "left"), "x");
  const cleanup = await agentCleanupCheckCommand(execution, command.paths);
  expect(remote(cleanup.args).code).toBe(6);
  expect(await readdir(command.paths.container)).toEqual(["left"]);
});

test.each([
  ["checks", (r: string) => symlink(join(r, "elsewhere"), join(r, "checks"))],
  [
    "project",
    async (r: string) => {
      await mkdir(join(r, "checks"));
      await symlink(join(r, "elsewhere"), join(r, "checks", "project"));
    },
  ],
  ["alias parent", (r: string) => symlink(join(r, "elsewhere"), join(r, "s"))],
  [
    "lock",
    (r: string) =>
      symlink(join(r, "elsewhere", "f"), join(r, "merge-check.lock")),
  ],
  [
    "non-empty lock",
    (r: string) => writeFile(join(r, "merge-check.lock"), "x"),
  ],
  ["file parent", (r: string) => writeFile(join(r, "checks"), "x")],
])(
  "a symlinked or unsafe %s fails preparation without creating leaves",
  async (_name, plant) => {
    await mkdir(join(root, "elsewhere", "project"), { recursive: true });
    await plant(execution.agentRoot);
    const command = await agentPrepareCheckCommand(execution, {
      ...input,
      slot: 0,
    });
    expect(remote(command.args).code).not.toBe(0);
    expect(await readdir(join(root, "elsewhere", "project"))).toEqual([]);
    await expect(lstat(command.paths.alias)).rejects.toMatchObject({
      code: expect.stringMatching(/ENOENT|ENOTDIR/u),
    });
  },
);

test("a missing agent root is never recreated", async () => {
  await rm(execution.agentRoot, { recursive: true });
  const command = await agentPrepareCheckCommand(execution, input);
  expect(remote(command.args).code).toBe(3);
  await expect(lstat(execution.agentRoot)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("injection counterexamples in joined path components are rejected before any SSH command", async () => {
  const bad = [
    "../escape",
    "..",
    ".hidden",
    "a/b",
    "a;touch /tmp/pwn",
    "a$(id)",
    "a`id`",
    "a b",
    "a\nb",
    "a'b",
    '"a"',
    "-rf",
    "",
  ];
  for (const project of bad)
    await expect(
      agentPrepareCheckCommand(execution, { ...input, project }),
    ).rejects.toThrow(/check path component/u);
  for (const attempt of [...bad, "a.b", "a".repeat(81)])
    await expect(
      agentPrepareCheckCommand(execution, { ...input, attempt }),
    ).rejects.toThrow(/check path component/u);
  for (const alias of [...bad, "a.b", "a".repeat(33)])
    await expect(
      agentPrepareCheckCommand(execution, { ...input, alias }),
    ).rejects.toThrow(/check path component/u);
  for (const slot of [-1, 64, 1.5, Number.NaN])
    await expect(
      agentPrepareCheckCommand(execution, { ...input, slot }),
    ).rejects.toThrow(/slot/u);
  for (const agentRoot of [
    "/srv/agent;rm -rf ~",
    "/srv/agent$(id)",
    "/srv/agent`id`",
    "/srv/agent/../etc",
    "/srv/a b",
    "/srv/a'b",
    "/srv/agent/",
  ]) {
    await expect(
      agentPrepareCheckCommand({ ...execution, agentRoot }, input),
    ).rejects.toThrow(/SSH agent root path/u);
    await expect(
      agentCleanupCheckCommand(
        { ...execution, agentRoot },
        {
          container: `${agentRoot}/checks/project/attempt-1`,
          alias: `${agentRoot}/s/aAlias`,
        },
      ),
    ).rejects.toThrow(/SSH agent root path/u);
  }
});

test("cleanup only accepts the exact leaves preparation returns", async () => {
  const r = execution.agentRoot;
  for (const paths of [
    { container: `${r}/checks/project`, alias: `${r}/s/aAlias` },
    { container: `${r}/checks/project/a/b`, alias: `${r}/s/aAlias` },
    { container: `${r}/checks/project/../x`, alias: `${r}/s/aAlias` },
    { container: `${r}/repos/project/a`, alias: `${r}/s/aAlias` },
    { container: "/etc/checks/project/a", alias: `${r}/s/aAlias` },
    { container: `${r}/checks/project/a`, alias: `${r}/s` },
    { container: `${r}/checks/project/a`, alias: `${r}/s/a;id` },
    { container: `${r}/checks/project/a$(id)`, alias: `${r}/s/aAlias` },
  ])
    await expect(agentCleanupCheckCommand(execution, paths)).rejects.toThrow(
      /check path component/u,
    );
});
