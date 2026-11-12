import { spawnSync } from "node:child_process";
import {
  chmod,
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

/**
 * The test account owns its temporary directories, so it can never satisfy
 * the real "lock and ancestors are not the account's" rule. `operator`
 * simulates an operator-provisioned layout by stubbing exactly that rule;
 * `ancestors` stubs only the ancestor walk. Tests without a stub run the
 * script unmodified.
 */
type Stub = "operator" | "ancestors";
const remote = (
  args: readonly string[],
  stub?: Stub,
  edit: (script: string) => string = (script) => script,
) => {
  let script = edit(args.at(-1) as string);
  if (stub) {
    const anchored = "anchored() {";
    expect(script).toContain(anchored);
    script = script.replace(anchored, `${anchored} return 0;`);
  }
  if (stub === "operator") {
    const foreign = 'foreign() { [ ! -O "$1" ]; }';
    expect(script).toContain(foreign);
    script = script.replace(foreign, "foreign() { :; }");
  }
  const result = spawnSync("sh", ["-c", script], {
    env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    encoding: "utf8",
  });
  return { code: result.status, stdout: result.stdout };
};
const input = { project: "project", attempt: "attempt-1", alias: "aAlias_-1" };
/** Operator provisioning: an empty, read-only lock the account cannot write. */
const provisionLock = async (name = "merge-check.lock") => {
  const path = join(execution.agentRoot, name);
  await writeFile(path, "", { mode: 0o444 });
  await chmod(path, 0o444);
  return path;
};
const leaves = async () => ({
  checks: await readdir(join(execution.agentRoot, "checks")).catch(() => []),
  s: await readdir(join(execution.agentRoot, "s")).catch(() => []),
});

test.skipIf(process.platform !== "linux")(
  "preparation runs on the executor through the pinned SSH entry, creates private leaves and uses the provisioned slot lock",
  async () => {
    const lock = await provisionLock("merge-check-2.lock");
    const inode = (await lstat(lock)).ino;
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
      lock,
    });
    expect(remote(command.args, "operator")).toEqual({
      code: 0,
      stdout: command.expect,
    });
    for (const path of [command.paths.container, command.paths.alias]) {
      const info = await lstat(path);
      expect(info.isDirectory()).toBe(true);
      expect(info.mode & 0o7777).toBe(0o700);
    }
    // The provisioned inode is used as is, never replaced or modified.
    const after = await lstat(lock);
    expect([after.ino, after.size, after.mode & 0o777]).toEqual([
      inode,
      0,
      0o444,
    ]);

    // A check never reuses an attempt; the new alias is rolled back.
    const again = await agentPrepareCheckCommand(execution, {
      ...input,
      alias: "aOther",
      slot: 2,
    });
    expect(remote(again.args, "operator").code).toBe(5);
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

test("V-405: a missing or unlinked slot lock is never created or recreated; preparation fails", async () => {
  const command = await agentPrepareCheckCommand(execution, {
    ...input,
    slot: 0,
  });
  // Never provisioned.
  expect(remote(command.args, "operator").code).toBe(7);
  expect(await readdir(execution.agentRoot)).toEqual([]);
  // Provisioned, used, then unlinked (as a candidate could if the agent root
  // were the account's): the next attempt must not get a fresh inode.
  const lock = await provisionLock();
  expect(remote(command.args, "operator").code).toBe(0);
  await rm(lock);
  const next = await agentPrepareCheckCommand(execution, {
    ...input,
    attempt: "attempt-2",
    alias: "aNext",
    slot: 0,
  });
  expect(remote(next.args, "operator").code).toBe(7);
  await expect(lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await leaves()).toEqual({ checks: ["project"], s: ["aAlias_-1"] });
  expect(await readdir(join(execution.agentRoot, "checks", "project"))).toEqual(
    ["attempt-1"],
  );
});

test("V-405: an agent root the account owns (so it could unlink or replace the lock) is refused for serialized checks", async () => {
  await provisionLock();
  const command = await agentPrepareCheckCommand(execution, {
    ...input,
    slot: 0,
  });
  // Unmodified script: the test account owns the agent root and its parent.
  expect(remote(command.args).code).toBe(4);
  expect(await leaves()).toEqual({ checks: [], s: [] });
  // Even read-only, an owned directory can be chmod-ed back by its owner.
  await chmod(execution.agentRoot, 0o555);
  try {
    expect(remote(command.args).code).toBe(4);
  } finally {
    await chmod(execution.agentRoot, 0o755);
  }
});

test.runIf(
  process.platform === "linux" &&
    process.getuid?.() !== 0 &&
    spawnSync("sh", ["-c", "[ ! -O /usr ] && [ ! -w /usr ] && [ ! -w / ]"])
      .status === 0,
)(
  "an ancestor chain the account neither owns nor can write passes the walk (unmodified script)",
  async () => {
    const command = await agentPrepareCheckCommand(
      { ...execution, agentRoot: "/usr" },
      { ...input, slot: 0 },
    );
    // The walk succeeds; /usr has no provisioned merge-check lock.
    expect(remote(command.args).code).toBe(7);
  },
);

test("an unserialized check needs no lock", async () => {
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
  [
    "checks",
    3,
    (r: string) => symlink(join(r, "elsewhere"), join(r, "checks")),
  ],
  [
    "project",
    3,
    async (r: string) => {
      await mkdir(join(r, "checks"));
      await symlink(join(r, "elsewhere"), join(r, "checks", "project"));
    },
  ],
  [
    "alias parent",
    3,
    (r: string) => symlink(join(r, "elsewhere"), join(r, "s")),
  ],
  ["file parent", 3, (r: string) => writeFile(join(r, "checks"), "x")],
  [
    "lock",
    7,
    async (r: string) => {
      await rm(join(r, "merge-check.lock"));
      await symlink(join(r, "elsewhere", "f"), join(r, "merge-check.lock"));
    },
  ],
  [
    "non-empty lock",
    7,
    async (r: string) => {
      await rm(join(r, "merge-check.lock"));
      await writeFile(join(r, "merge-check.lock"), "x", { mode: 0o444 });
    },
  ],
  [
    "writable lock",
    7,
    (r: string) => chmod(join(r, "merge-check.lock"), 0o644),
  ],
  [
    "directory lock",
    7,
    async (r: string) => {
      await rm(join(r, "merge-check.lock"));
      await mkdir(join(r, "merge-check.lock"));
    },
  ],
] as const)(
  "a symlinked or unsafe %s fails preparation without creating leaves",
  async (_name, code, plant) => {
    await mkdir(join(root, "elsewhere", "project"), { recursive: true });
    await provisionLock();
    await plant(execution.agentRoot);
    const command = await agentPrepareCheckCommand(execution, {
      ...input,
      slot: 0,
    });
    expect(remote(command.args, "operator").code).toBe(code);
    expect(await readdir(join(root, "elsewhere", "project"))).toEqual([]);
    await expect(lstat(command.paths.alias)).rejects.toMatchObject({
      code: expect.stringMatching(/ENOENT|ENOTDIR/u),
    });
  },
);

test("the lock owner check itself is not stubbed by the ancestor stub", async () => {
  // The test account owns this lock: only the operator stub can accept it.
  await provisionLock();
  const command = await agentPrepareCheckCommand(execution, {
    ...input,
    slot: 0,
  });
  expect(remote(command.args, "ancestors").code).toBe(7);
  expect(remote(command.args, "operator").code).toBe(0);
});

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

/** Insert shell text before a unique line of the remote script (a race window). */
const before = (anchor: string, text: string) => (script: string) => {
  expect(script.split(anchor)).toHaveLength(2);
  return script.replace(anchor, `${text}\n${anchor}`);
};

test("C-130#15: a level swapped for a symlink right before the attempt is created cannot redirect it", async () => {
  const elsewhere = join(root, "elsewhere");
  await mkdir(elsewhere);
  const command = await agentPrepareCheckCommand(execution, input);
  // A concurrent same-account check renames the validated level and plants a symlink.
  const swap = `mv "$R/checks/$project" "$R/checks/$project.old" && ln -s ${elsewhere} "$R/checks/$project"`;
  const result = remote(
    command.args,
    undefined,
    before('mkdir -m 0700 -- "$attempt" || exit 5', swap),
  );
  expect(result.code).toBe(8);
  expect(await readdir(elsewhere)).toEqual([]);
  // Created in the pinned, validated directory, not through the symlink.
  expect(
    await readdir(join(execution.agentRoot, "checks", "project.old")),
  ).toEqual(["attempt-1"]);
});

test("C-130#15: a level swapped between its check and entering it is refused", async () => {
  const elsewhere = join(root, "elsewhere");
  await mkdir(elsewhere);
  const command = await agentPrepareCheckCommand(execution, input);
  const swap = `[ "$1" = project ] && mv project project.old && ln -s ${elsewhere} project`;
  const result = remote(command.args, undefined, before("  h=$(pwd -P)", swap));
  expect(result.code).toBe(3);
  expect(await readdir(elsewhere)).toEqual([]);
  expect(await leaves()).toEqual({
    checks: ["project", "project.old"],
    s: [],
  });
});

test("C-130#15: cleanup never removes through a swapped intermediate level", async () => {
  const command = await agentPrepareCheckCommand(execution, input);
  expect(remote(command.args).code).toBe(0);
  const project = join(execution.agentRoot, "checks", "project"),
    elsewhere = join(root, "elsewhere");
  await mkdir(join(elsewhere, "attempt-1"), { recursive: true });
  await rm(join(project, "attempt-1"), { recursive: true });
  await rm(project, { recursive: true });
  await symlink(elsewhere, project);
  const cleanup = await agentCleanupCheckCommand(execution, command.paths);
  expect(remote(cleanup.args).code).toBe(6);
  expect(await readdir(elsewhere)).toEqual(["attempt-1"]);
  // The alias, under an intact parent, is still removed.
  expect(await readdir(join(execution.agentRoot, "s"))).toEqual([]);
});
