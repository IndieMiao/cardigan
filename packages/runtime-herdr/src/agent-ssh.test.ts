import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeRef } from "@cardigan/domain";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  agentProcessCommand,
  agentReceivePack,
  agentSshCommand,
  agentUploadPack,
} from "./agent-ssh.js";
import { agentCommandError, type HcClient, processClient } from "./client.js";
import {
  type ExecutionConfig,
  executionPaths,
  executionPermissions,
  resolveExecutionConfig,
  shellQuote,
} from "./execution.js";
import { HerdrRuntime } from "./index.js";
import { assignment, launch, machine, role, value } from "./test-support.js";

let root: string,
  execution: Extract<ExecutionConfig, { mode: "agent-ssh" }>,
  client: HcClient;
const ref: RuntimeRef = {
  machine_id: "local",
  runtime_machine: "cardigan-agent",
  terminal_ref: "cardigan-agent/t1",
  agent_name: launch.agent_name,
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cg-ssh-"));
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
  client = {
    available: async () => true,
    exec: vi.fn(async (args: readonly string[]) => {
      if (args[0] === "--version") return "hc 0.1.18";
      if (args[0] === "machine")
        return JSON.stringify(
          args[1] === "ls" ? { machines: [] } : { version: "0.1.18" },
        );
      return JSON.stringify({
        address: ref.terminal_ref,
        state: "live",
        status: { state: "idle" },
      });
    }),
    async *lines() {
      yield JSON.stringify({
        seq: 1,
        terminals: [
          {
            address: ref.terminal_ref,
            state: "live",
            status: { state: "idle" },
          },
        ],
      });
    },
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("local defaults and agent paths/permission policy keep private data separate", () => {
  expect(resolveExecutionConfig({ CARDIGAN_DATA_DIR: root })).toEqual({
    mode: "local",
    dataDir: root,
  });
  expect(executionPaths(execution, "project", "A-1")).toEqual({
    runDir: join(root, "agent", "runs", "project", "A-1"),
    repositoriesRoot: join(root, "agent", "repos"),
    worktreesRoot: join(root, "agent", "worktrees"),
    buildsRoot: join(root, "agent", "builds"),
  });
  expect(executionPaths(execution, "other", "A-1").runDir).not.toBe(
    executionPaths(execution, "project", "A-1").runDir,
  );
  expect(executionPermissions(execution)).toEqual({
    parent: 0o2750,
    directory: 0o2770,
    file: 0o660,
    executable: 0o770,
  });
  expect(executionPermissions({ mode: "local", dataDir: root })).toEqual({
    parent: 0o700,
    directory: 0o700,
    file: 0o600,
    executable: 0o700,
  });
});

test("unknown modes, missing settings and overlapping private/shared roots fail closed", () => {
  const env = {
    CARDIGAN_RUNTIME_MODE: "agent-ssh",
    CARDIGAN_DATA_DIR: execution.dataDir,
    CARDIGAN_AGENT_ROOT: execution.agentRoot,
    CARDIGAN_AGENT_GID: "2001",
    CARDIGAN_AGENT_IDENTITY: execution.identityFile,
    CARDIGAN_AGENT_KNOWN_HOSTS: execution.knownHostsFile,
  };
  for (const patch of [
    { CARDIGAN_RUNTIME_MODE: "ssh" },
    { CARDIGAN_AGENT_ROOT: "relative" },
    { CARDIGAN_AGENT_GID: "0" },
    { CARDIGAN_AGENT_GID: "" },
    { CARDIGAN_AGENT_MACHINE: "local" },
    { CARDIGAN_AGENT_MACHINE: "host/other" },
    { CARDIGAN_AGENT_ROOT: execution.dataDir },
    { CARDIGAN_DATA_DIR: join(execution.agentRoot, "data") },
    { CARDIGAN_AGENT_IDENTITY: join(execution.agentRoot, "..key") },
  ])
    expect(() => resolveExecutionConfig({ ...env, ...patch })).toThrow();
  expect(() =>
    resolveExecutionConfig({ CARDIGAN_RUNTIME_MODE: "agent-ssh" }),
  ).toThrow();
  for (const project of ["..", "", "x/y", "-project"])
    expect(() => executionPaths(execution, project, "A-1")).toThrow();
});

test("Agent niceness is configurable in both modes and rejects unsafe values", () => {
  const env = {
    CARDIGAN_DATA_DIR: execution.dataDir,
    CARDIGAN_AGENT_ROOT: execution.agentRoot,
    CARDIGAN_AGENT_GID: "2001",
    CARDIGAN_AGENT_IDENTITY: execution.identityFile,
    CARDIGAN_AGENT_KNOWN_HOSTS: execution.knownHostsFile,
  };
  for (const mode of ["local", "agent-ssh"]) {
    for (const value of ["0", "10", "19"])
      expect(
        resolveExecutionConfig({
          ...env,
          CARDIGAN_RUNTIME_MODE: mode,
          CARDIGAN_AGENT_NICE: value,
        }).agentNice,
      ).toBe(Number(value));
    for (const value of ["", "-1", "20", "1.5", "NaN", "10; echo bad"])
      expect(() =>
        resolveExecutionConfig({
          ...env,
          CARDIGAN_RUNTIME_MODE: mode,
          CARDIGAN_AGENT_NICE: value,
        }),
      ).toThrow(/CARDIGAN_AGENT_NICE/);
  }
});

// The pre-P2a-12 argv is deliberately fixed, including ordering and no -p flag.
function legacySshArguments() {
  return [
    "-F",
    "/dev/null",
    "-T",
    "-i",
    execution.identityFile,
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "IdentityAgent=none",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${execution.knownHostsFile}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "HostKeyAlias=cardigan-agent-local",
    "-o",
    "HostKeyAlgorithms=ssh-ed25519",
    "-o",
    "ConnectTimeout=10",
    "--",
    "agent@localhost",
  ];
}
const expectedAgentPath =
  "PATH=/var/lib/cardigan-agent/.local/bin:/usr/local/bin:/usr/bin:/bin";

test("omitted target fields preserve SSH command bytes and streaming argv", async () => {
  for (const key of ["host", "port", "user", "hostKeyAlias"])
    expect(execution).not.toHaveProperty(key);
  expect(agentSshCommand(execution)).toBe(
    ["ssh", ...legacySshArguments(), "env", expectedAgentPath]
      .map(shellQuote)
      .join(" "),
  );
  expect(
    await agentProcessCommand(execution, ["printf", "a 'quoted' value"]),
  ).toEqual({
    file: "ssh",
    args: [
      "-o",
      "ServerAliveInterval=5",
      "-o",
      "ServerAliveCountMax=3",
      ...legacySshArguments(),
      ["env", "-i", expectedAgentPath, "printf", "a 'quoted' value"]
        .map(shellQuote)
        .join(" "),
    ],
  });
});

test("remote targets use the selected credentials, port and pinned alias in every SSH entry", async () => {
  const remote = {
    ...execution,
    host: "worker.example.test",
    port: 2222,
    user: "check-runner",
    hostKeyAlias: "check-host",
    knownHostsFile: join(root, "remote_known_hosts"),
  };
  await writeFile(remote.knownHostsFile, "fixture-only", { mode: 0o600 });
  const expected = legacySshArguments()
    .slice(0, -2)
    .map((arg) => {
      if (arg.startsWith("UserKnownHostsFile="))
        return `UserKnownHostsFile=${remote.knownHostsFile}`;
      if (arg.startsWith("HostKeyAlias=")) return "HostKeyAlias=check-host";
      return arg;
    });
  expected.push("-p", "2222", "--", "check-runner@worker.example.test");
  const entry = ["ssh", ...expected, "env", expectedAgentPath]
    .map(shellQuote)
    .join(" ");
  expect(agentSshCommand(remote)).toBe(entry);
  expect((await agentProcessCommand(remote, ["true"])).args).toEqual([
    "-o",
    "ServerAliveInterval=5",
    "-o",
    "ServerAliveCountMax=3",
    ...expected,
    ["env", "-i", expectedAgentPath, "true"].map(shellQuote).join(" "),
  ]);
  for (const pack of [agentUploadPack, agentReceivePack]) {
    const command = await pack(
      remote,
      join(remote.agentRoot, "repos", "project"),
    );
    expect(command).toContain(shellQuote(entry).slice(1, -1));
  }
  await chmod(remote.knownHostsFile, 0o644);
  await expect(agentProcessCommand(remote, ["true"])).rejects.toThrow(/0600/);
});

test.each([
  [
    { host: "worker.example.test" },
    "agent@worker.example.test",
    "cardigan-agent-local",
  ],
  [{ host: "::1" }, "agent@::1", "cardigan-agent-local"],
  [{ user: "check-runner" }, "check-runner@localhost", "cardigan-agent-local"],
  [{ hostKeyAlias: "check-host" }, "agent@localhost", "check-host"],
] as const)(
  "partial target %j retains other defaults",
  async (target, destination, alias) => {
    const { args } = await agentProcessCommand({ ...execution, ...target }, [
      "true",
    ]);
    expect(args.at(-2)).toBe(destination);
    expect(args).toContain(`HostKeyAlias=${alias}`);
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).not.toContain("-p");
  },
);

test.each([1, 22, 65535])("explicit SSH port %s is emitted", async (port) => {
  const { args } = await agentProcessCommand({ ...execution, port }, ["true"]);
  expect(args.slice(-5, -1)).toEqual([
    "-p",
    String(port),
    "--",
    "agent@localhost",
  ]);
});

test("unsafe targets, ports and known_hosts paths fail before command generation or execution", async () => {
  const patches: Record<string, unknown>[] = [];
  for (const field of ["host", "user", "hostKeyAlias"]) {
    for (const value of [
      "",
      "-oProxyCommand=bad",
      "x y",
      "x\n",
      "x\r",
      "x\ny",
      "x\ry",
      "x\ty",
      "x\0y",
      "x\u00a0y",
      "x\u200by",
      "user@host",
      "x;bad",
      "$(bad)",
      "`bad`",
      "'bad'",
      '"bad"',
      "x\\y",
      null,
    ])
      patches.push({ [field]: value });
  }
  for (const port of [
    0,
    -1,
    65536,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "22",
    "22 -oStrictHostKeyChecking=no",
    null,
  ])
    patches.push({ port });
  for (const knownHostsFile of [
    "",
    "relative",
    "/",
    "/tmp/..",
    "-hosts",
    "/tmp/hosts other",
    "/tmp/hosts\nother",
    "/tmp/hosts\0other",
    '/tmp/"hosts"',
    "/tmp/'hosts'",
    "/tmp/hosts\\other",
    "/tmp/%h",
    `/tmp/\${HOSTS}`,
  ])
    patches.push({ knownHostsFile });
  for (const patch of patches) {
    const invalid = { ...execution, ...patch } as typeof execution;
    expect(() => agentSshCommand(invalid)).toThrow(/SSH/);
    await expect(agentProcessCommand(invalid, ["true"])).rejects.toThrow(/SSH/);
    for (const pack of [agentUploadPack, agentReceivePack])
      await expect(
        pack(invalid, join(execution.agentRoot, "repos", "project")),
      ).rejects.toThrow(/SSH/);
  }
});

test("agent registration uses only the dedicated key and pinned host; arbitrary existing endpoints are refused", async () => {
  const runtime = await HerdrRuntime.create({
    client,
    execution,
    session: "cardigan-test",
  });
  expect(runtime.ok).toBe(true);
  const add = vi
    .mocked(client.exec)
    .mock.calls.find(
      ([args]) => args[0] === "machine" && args[1] === "add",
    )?.[0];
  expect(add).toEqual([
    "machine",
    "add",
    "--name",
    "cardigan-agent",
    "--session",
    "cardigan-test",
    "--via",
    agentSshCommand(execution),
    "--json",
  ]);
  for (const option of [
    "agent@localhost",
    "IdentitiesOnly=yes",
    "IdentityAgent=none",
    "ForwardAgent=no",
    "StrictHostKeyChecking=yes",
    "GlobalKnownHostsFile=/dev/null",
    "-F",
    "/dev/null",
  ])
    expect(agentSshCommand(execution)).toContain(option);
  vi.mocked(client.exec).mockImplementation(async (args) =>
    args[0] === "--version"
      ? "hc 0.1.18"
      : JSON.stringify({
          machines: [
            {
              name: execution.machine,
              target: "other@elsewhere",
              via: true,
              session: "cardigan-test",
            },
          ],
        }),
  );
  expect(
    await HerdrRuntime.create({ client, execution, session: "cardigan-test" }),
  ).toMatchObject({ ok: false, error: { code: "invalid_launch" } });
});

test("all Runtime operations route to the configured agent machine using supported hc syntax", async () => {
  const runtime = value(await HerdrRuntime.create({ client, execution }));
  const agentLaunch = {
    ...launch,
    cwd: join(execution.agentRoot, "worktrees", "project", "A-1"),
  };
  expect(
    await runtime.provision(assignment, role, machine, agentLaunch),
  ).toMatchObject({ ok: true, value: ref });
  value(await runtime.wake(ref, "task", { if_idle: true }));
  value(await runtime.status(ref));
  value(await runtime.interrupt(ref));
  const entry = value(await runtime.human_entry(ref));
  expect(entry).toContain("attach 'cardigan-agent/t1'");
  value(await runtime.resume_or_replace(ref, agentLaunch));
  value(await runtime.release(ref, { force: true }));
  const calls = vi.mocked(client.exec).mock.calls.map(([args]) => args);
  for (const args of calls.filter((a) => a[0] === "run")) {
    expect(args.slice(0, 3)).toEqual(["run", "--on", "cardigan-agent"]);
    expect(args.indexOf("--on")).toBeLessThan(args.indexOf("--"));
  }
  for (const args of calls.filter((a) =>
    ["get", "send", "kill", "rm", "interrupt"].includes(a[0] ?? ""),
  ))
    expect(args).toContain(ref.terminal_ref);
  value(await runtime.captureAgent("git", ["status"], 1234));
  expect(client.exec).toHaveBeenLastCalledWith(
    ["exec", "--on", "cardigan-agent", "--", "git", "status"],
    1234,
  );
  value(await runtime.captureAgent("pi", ["--version"]));
  expect(client.exec).toHaveBeenLastCalledWith([
    "exec",
    "--on",
    "cardigan-agent",
    "--",
    "pi",
    "--version",
  ]);
});

test("bound local methods and subscriptions keep the exact target; hc alias rebinding cannot kill a new terminal", async () => {
  const target = {
    project_id: "fixture",
    machine_id: "local",
    session: "bound",
    generation: "one",
    fingerprint: "fixture-fingerprint",
  };
  const config = { ...execution, target, path: "/fixture/bin:/usr/bin:/bin" };
  const runtime = value(
    await HerdrRuntime.create({
      client,
      execution: config,
      session: target.session,
    }),
  );
  const agentLaunch = {
    ...launch,
    cwd: join(config.agentRoot, "worktrees", "fixture", "A-1"),
  };
  const bound = value(
    await runtime.provision(assignment, role, machine, agentLaunch),
  );
  expect(bound.target).toEqual(target);
  value(await runtime.wake(bound, "task"));
  value(await runtime.status(bound));
  value(await runtime.interrupt(bound));
  value(await runtime.resume_or_replace(bound, agentLaunch));
  value(await runtime.human_entry(bound));
  for await (const event of runtime.events(bound)) {
    value(event);
    break;
  }
  value(await runtime.release(bound, { force: true }));
  expect(agentSshCommand(config)).toContain("PATH=/fixture/bin:/usr/bin:/bin");
  for (const option of [
    "StrictHostKeyChecking=yes",
    "ForwardAgent=no",
    "ClearAllForwardings=yes",
    "IdentityAgent=none",
    "IdentitiesOnly=yes",
  ])
    expect(agentSshCommand(config)).toContain(option);
  const prior = client.exec;
  client.exec = vi.fn(async (args) =>
    args[0] === "machine" && args[1] === "ls"
      ? JSON.stringify({
          machines: [
            {
              name: config.machine,
              target: "different SSH target",
              via: true,
              session: target.session,
              version: "0.1.18",
            },
          ],
        })
      : prior(args),
  );
  expect(await runtime.release(bound, { force: true })).toMatchObject({
    ok: false,
    error: { code: "invalid_launch" },
  });
  expect(vi.mocked(client.exec).mock.calls.map(([args]) => args[0])).toEqual([
    "machine",
  ]);
  expect(await runtime.human_entry(bound)).toMatchObject({
    ok: false,
    error: { code: "invalid_launch" },
  });
});

test("a remote binding supports get/events checks but no provision, wake or replacement even with an injected hc client", async () => {
  const target = {
    project_id: "fixture",
    machine_id: "worker-a",
    session: "remote",
    generation: "one",
    fingerprint: "fixture-fingerprint",
  };
  const runtime = value(
    await HerdrRuntime.create({
      client,
      execution: { ...execution, target },
      session: target.session,
    }),
  );
  const remoteRef = { ...ref, machine_id: "worker-a", target };
  value(await runtime.status(remoteRef));
  const count = vi.mocked(client.exec).mock.calls.length;
  expect(
    await runtime.provision(
      { ...assignment, machine_id: "worker-a" },
      role,
      { ...machine, id: "worker-a" },
      launch,
    ),
  ).toMatchObject({ ok: false });
  expect(await runtime.wake(remoteRef, "task")).toMatchObject({ ok: false });
  expect(await runtime.resume_or_replace(remoteRef, launch)).toMatchObject({
    ok: false,
  });
  expect(vi.mocked(client.exec).mock.calls).toHaveLength(count);
  expect(
    await runtime.status({
      ...remoteRef,
      target: { ...target, generation: "old" },
    }),
  ).toMatchObject({ ok: false });
  expect(
    await HerdrRuntime.create({
      client,
      execution: { ...execution, target },
      session: "wrong",
    }),
  ).toMatchObject({ ok: false });
});

test("foreign/local refs and work directories cannot escape agent-ssh mode", async () => {
  const runtime = value(await HerdrRuntime.create({ client, execution }));
  const before = vi.mocked(client.exec).mock.calls.length;
  for (const wrong of [
    { ...ref, runtime_machine: "other" },
    { ...ref, terminal_ref: "t1" },
    { ...ref, terminal_ref: "other/t1" },
  ]) {
    for (const answer of [
      await runtime.wake(wrong, "x"),
      await runtime.status(wrong),
      await runtime.interrupt(wrong),
      await runtime.human_entry(wrong),
      await runtime.release(wrong, { force: true }),
      await runtime
        .events(wrong)
        .next()
        .then((x) => x.value),
    ])
      expect(answer).toMatchObject({
        ok: false,
        error: { code: "invalid_launch" },
      });
  }
  expect(
    await runtime.provision(assignment, role, machine, launch),
  ).toMatchObject({ ok: false, error: { code: "invalid_launch" } });
  expect(client.exec).toHaveBeenCalledTimes(before);
});

test("credential permissions and the remote hc version are validated before launching", async () => {
  await chmod(execution.identityFile, 0o644);
  expect(await HerdrRuntime.create({ client, execution })).toMatchObject({
    ok: false,
    error: { code: "invalid_launch" },
  });
  await chmod(execution.identityFile, 0o600);
  const original = client.exec;
  client.exec = async (args) =>
    args[0] === "machine" && args[1] === "add"
      ? JSON.stringify({ version: "0.1.17" })
      : original(args);
  expect(await HerdrRuntime.create({ client, execution })).toMatchObject({
    ok: false,
    error: { code: "version_mismatch" },
  });
  await rm(execution.knownHostsFile);
  await symlink(execution.identityFile, execution.knownHostsFile);
  expect(await HerdrRuntime.create({ client, execution })).toMatchObject({
    ok: false,
    error: { code: "invalid_launch" },
  });
});

test.each([agentUploadPack, agentReceivePack])(
  "M4 pack services use the dedicated SSH policy and reject unbound paths or unsafe credentials: %s",
  async (pack) => {
    const command = await pack(
      execution,
      join(execution.agentRoot, "repos", "project"),
    );
    for (const option of [
      pack === agentUploadPack ? "upload-pack" : "receive-pack",
      "agent@localhost",
      "IdentitiesOnly=yes",
      "IdentityAgent=none",
      "ForwardAgent=no",
      "StrictHostKeyChecking=yes",
      "GIT_CONFIG_GLOBAL=/dev/null",
    ])
      expect(command).toContain(option);
    for (const path of [
      "relative",
      execution.dataDir,
      join(execution.agentRoot, "worktrees", "project", "A-1"),
    ])
      await expect(pack(execution, path)).rejects.toThrow(/base repository/);
    await chmod(execution.identityFile, 0o644);
    await expect(
      pack(execution, join(execution.agentRoot, "repos", "project")),
    ).rejects.toThrow(/0600/);
  },
);

test("a failed Agent Git command keeps its exit status and stderr through the real hc client", async () => {
  // A stand-in hc: `exec` runs a "git" that fails like a real ref lock.
  const hc = join(root, "hc");
  await writeFile(
    hc,
    `#!/bin/sh\nif [ "$1" = exec ]; then\n  echo "fatal: cannot lock ref 'refs/remotes/origin/main': File exists" >&2\n  exit 128\nfi\necho '{"error":{"kind":"not_found"}}' >&2\nexit 1\n`,
    { mode: 0o700 },
  );
  const real = processClient(hc, { PATH: "/usr/bin:/bin" }, root, 5_000);
  const runtime = value(
    await HerdrRuntime.create({
      client: {
        ...client,
        exec: (args, timeout) =>
          args[0] === "exec" ? real.exec(args, timeout) : client.exec(args),
      },
      execution,
    }),
  );
  const failed = await runtime.captureAgent("git", ["fetch"], 1234);
  expect(failed).toEqual({
    ok: false,
    error: {
      code: "runtime_unavailable",
      message: "hc refused the operation (unavailable)",
      detail: {
        exit_code: 128,
        stderr:
          "fatal: cannot lock ref 'refs/remotes/origin/main': File exists\n",
      },
    },
  });
  if (failed.ok) throw new Error("expected failure");
  expect(agentCommandError(failed.error)).toMatchObject({
    code: 128,
    stderr: expect.stringContaining("cannot lock ref"),
  });
  // A structured hc refusal is the runtime's own error, with no program detail.
  await expect(real.exec(["get", "x"])).rejects.toMatchObject({
    code: "runtime_not_found",
    detail: undefined,
  });
});
