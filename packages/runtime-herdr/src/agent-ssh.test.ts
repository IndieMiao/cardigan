import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeRef } from "@cardigan/domain";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
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
