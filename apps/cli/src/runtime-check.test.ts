import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeRef } from "@cardigan/domain";
import { RuntimeTargets } from "@cardigan/host";
import {
  type ExecutionConfig,
  writeRegisteredRuntime,
} from "@cardigan/runtime-herdr";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CliError, EXIT } from "./errors.js";
import type { CliIo } from "./io.js";
import { launchExecution, terminalExecution } from "./runtime-check.js";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "runtime-check-"));
});
afterEach(() => {
  chmodSync(dataDir, 0o700);
  rmSync(dataDir, { recursive: true, force: true });
});

// Only `env` is read by runtime-check.
const io = (env: Record<string, string | undefined>) => ({ env }) as CliIo;

const agentEnv = {
  CARDIGAN_RUNTIME_MODE: "agent-ssh",
  CARDIGAN_AGENT_ROOT: "/srv/agent",
  CARDIGAN_AGENT_IDENTITY: "/keys/id",
  CARDIGAN_AGENT_KNOWN_HOSTS: "/keys/known_hosts",
  CARDIGAN_AGENT_GID: "900",
  CARDIGAN_AGENT_MACHINE: "cardigan-agent",
};
const agent = (): ExecutionConfig => ({
  mode: "agent-ssh",
  dataDir,
  agentRoot: "/srv/agent",
  identityFile: "/keys/id",
  knownHostsFile: "/keys/known_hosts",
  gid: 900,
  machine: "cardigan-agent",
});

const ref = (runtime_machine: string, terminal_ref: string) =>
  ({ machine_id: "local", runtime_machine, terminal_ref }) as RuntimeRef;

async function rejection(promise: Promise<unknown>): Promise<CliError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CliError);
  return error as CliError;
}

test("CLI terminal preflight rejects stale session fingerprints and cross-project bindings before hc IO", async () => {
  const store = Store.open({ dataDir });
  try {
    store.createProject({ id: "fixture", name: "Fixture" });
    store.createProject({ id: "other", name: "Other" });
    const execution: ExecutionConfig = { mode: "local", dataDir };
    await writeRegisteredRuntime(dataDir, execution, "bound");
    const result = await RuntimeTargets.create({
      execution,
      session: "bound",
      store,
      project: "fixture",
      workers: () => [],
    });
    if (!result.ok) throw new Error("Invalid fixture");
    const target = result.value.resolve("fixture", "local").execution.target;
    if (!target) throw new Error("Missing fixture binding");
    const bound = { ...ref("local", "t1"), target };
    await expect(
      terminalExecution(io({}), dataDir, bound, "A-1", undefined, {
        store,
        project: "fixture",
      }),
    ).resolves.toMatchObject({ session: "bound" });
    await expect(
      terminalExecution(io({}), dataDir, bound, "A-1", undefined, {
        store,
        project: "other",
      }),
    ).rejects.toThrow("绑定不匹配");
    await writeRegisteredRuntime(dataDir, execution, "changed");
    await expect(
      terminalExecution(io({}), dataDir, bound, "A-1", undefined, {
        store,
        project: "fixture",
      }),
    ).rejects.toThrow("绑定不匹配");
  } finally {
    store.close();
  }
});

test("launch passes when the shell matches the server's registration", async () => {
  await writeRegisteredRuntime(dataDir, agent(), "cardigan");
  await expect(launchExecution(io(agentEnv), dataDir)).resolves.toEqual(
    agent(),
  );
  await writeRegisteredRuntime(dataDir, { mode: "local", dataDir }, "work");
  await expect(
    launchExecution(io({ CARDIGAN_RUNTIME_MODE: "local" }), dataDir, "work"),
  ).resolves.toEqual({ mode: "local", dataDir });
});

test("launch refuses a shell that differs from the registration and lists every difference", async () => {
  await writeRegisteredRuntime(dataDir, agent(), "cardigan");
  const error = await rejection(
    launchExecution(
      io({ ...agentEnv, CARDIGAN_AGENT_MACHINE: "other-agent" }),
      dataDir,
      "elsewhere",
    ),
  );
  expect(error.exitCode).toBe(EXIT.usage);
  expect(error.message).toContain("和 server 登记的不一致");
  expect(error.details).toEqual(
    expect.arrayContaining([
      "CARDIGAN_HC_SESSION（或 --hc-session）：server 登记为 cardigan，当前 shell 为 elsewhere",
      "CARDIGAN_AGENT_MACHINE：server 登记为 cardigan-agent，当前 shell 为 other-agent",
    ]),
  );
  // A shell that switched to local is a difference too, not a fallback.
  const local = await rejection(
    launchExecution(io({ CARDIGAN_RUNTIME_MODE: "local" }), dataDir),
  );
  expect(local.details).toContain(
    "CARDIGAN_RUNTIME_MODE：server 登记为 agent-ssh，当前 shell 为 local",
  );
});

test("launch refuses a shell without runtime.env against an agent-ssh registration", async () => {
  await writeRegisteredRuntime(dataDir, agent(), "cardigan");
  const error = await rejection(launchExecution(io({}), dataDir));
  expect(error.exitCode).toBe(EXIT.usage);
  expect(error.message).toContain("CARDIGAN_RUNTIME_MODE 未设置");
});

test("launch without a registration refuses implicit local mode", async () => {
  const error = await rejection(launchExecution(io({}), dataDir));
  expect(error.exitCode).toBe(EXIT.usage);
  expect(error.message).toContain("不会默认按本机模式");
  expect(error.details.join("\n")).toContain("CARDIGAN_RUNTIME_MODE=local");
  // Naming the mode explicitly is the operator's choice.
  await expect(
    launchExecution(io({ CARDIGAN_RUNTIME_MODE: "local" }), dataDir),
  ).resolves.toEqual({ mode: "local", dataDir });
});

test.each([
  ["corrupt", () => writeFileSync(join(dataDir, "runtime.json"), "{not json")],
  ["not a regular file", () => mkdirSync(join(dataDir, "runtime.json"))],
  [
    "unreadable",
    () => {
      writeFileSync(join(dataDir, "runtime.json"), "{}");
      chmodSync(join(dataDir, "runtime.json"), 0o000);
    },
  ],
])(
  "a %s registration is an error, never treated as unregistered",
  async (kind, prepare) => {
    // Root ignores file modes; the unreadable case needs a regular user.
    if (kind === "unreadable" && process.getuid?.() === 0) return;
    prepare();
    // Create each promise only when it is awaited: building both up front
    // leaves the second rejection unhandled while the first one is awaited.
    for (const attempt of [
      () => launchExecution(io({ CARDIGAN_RUNTIME_MODE: "local" }), dataDir),
      () => terminalExecution(io({}), dataDir, null, "A-1"),
    ]) {
      const error = await rejection(attempt());
      expect(error.exitCode).toBe(EXIT.failure);
      expect(error.message).toContain("无法读取 server 登记的运行时配置");
    }
  },
);

test("terminal commands follow the registration and explain a foreign terminal", async () => {
  await writeRegisteredRuntime(dataDir, agent(), "srv-session");
  // A plain shell reaches terminals of the registered runtime and session.
  await expect(
    terminalExecution(io({}), dataDir, ref("cardigan-agent", "t1"), "A-1"),
  ).resolves.toEqual({ execution: agent(), session: "srv-session" });
  await expect(
    terminalExecution(io({}), dataDir, ref("elsewhere", "t2"), "A-2"),
  ).rejects.toThrow(/A-2 的终端 t2 记录在运行时机器 elsewhere/);
});
