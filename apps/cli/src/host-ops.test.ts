import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_OPS_ROLE_TOOLS, queueRun } from "@cardigan/domain";
import { RuntimeTargets } from "@cardigan/host";
import { defaultRoleDefinition } from "@cardigan/roles";
import {
  executionPaths,
  HerdrRuntime,
  prepareAgentProject,
} from "@cardigan/runtime-herdr";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { roleConfig } from "../../../test-support/launch-fixture.js";
import type { StartById } from "./assignment.js";
import { CLI_TOOLS } from "./command-access.js";
import { issueTokenForAssignment, runCommand } from "./host.js";
import { main } from "./index.js";
import type { CliIo } from "./io.js";
import { runWorkflowCommand } from "./workflow.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}

let dir: string;
let store: Store;
let io: CliIo;
let output: string[];
let errors: string[];
const project = "host-ops-fixture";
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "cardigan-host-ops-"));
  store = Store.open({ dataDir: dir });
  store.createProject({ id: project, name: "Host operations fixture" });
  output = [];
  errors = [];
  io = {
    cwd: dir,
    env: {
      CARDIGAN_CONFIG_DIR: roleConfig(dir, "fixture"),
      CARDIGAN_DATA_DIR: dir,
      CARDIGAN_RUNTIME_MODE: "local",
    },
    platform: "linux",
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
    signals: { on: () => undefined, off: () => undefined },
    spawnInherit: () => {
      throw new Error("Unexpected process launch");
    },
    captureCommand: async () => {
      throw new Error("Unexpected command");
    },
  };
  expect(
    await main(
      [
        "role",
        "copy",
        "host_ops",
        "host_ops",
        "--from-default",
        "--harness",
        "codex",
        "--launch-profile",
        "fixture",
      ],
      io,
    ),
  ).toBe(0);
  output = [];
  errors = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
function assignments() {
  return store.uow.read((tx) => tx.assignments.list(project));
}
function fixtureToken(): string {
  const a = assignments()[0];
  if (!a) throw new Error("Missing fixture Assignment");
  return store.uow.run(
    (tx) =>
      issueTokenForAssignment(tx, project, a.id, {
        role_version: a.role_version,
        allowed_tools: HOST_OPS_ROLE_TOOLS,
      }).token,
  );
}

test("create binds the sole employee without issuing credentials or revoking a running session", async () => {
  expect(
    await main(
      [
        "employee",
        "add",
        "--name",
        "Operator",
        "--title",
        "Operations",
        "--role",
        "host_ops",
      ],
      io,
    ),
  ).toBe(0);
  output = [];
  expect(await main(["host-ops", "create"], io)).toBe(0);
  expect(
    store.uow.run((tx) =>
      tx.tokensForAssignment(
        project,
        required(tx.assignments.list(project)[0]).id,
      ),
    ),
  ).toEqual([]);
  const token = fixtureToken();
  expect(output.join("\n")).not.toContain(token);
  expect(errors.join("\n").includes(token)).toBe(false);
  const [assignment] = assignments();
  expect(assignment).toMatchObject({
    scope: "standing",
    role_id: "host_ops",
    employee_id: "E-1",
  });
  expect(assignment?.standing_mode).toBeUndefined();
  expect(store.verifyToken(token)?.allowed_tools).toEqual(HOST_OPS_ROLE_TOOLS);
  const events = store.getUpdates({ project_id: project, since_seq: 0 }).events;
  expect(events.some((e) => e.type === "host_ops_assignment_created")).toBe(
    true,
  );
  expect(JSON.stringify(events).includes(token)).toBe(false);
  output = [];
  expect(await main(["host-ops", "create"], io)).toBe(0);
  expect(assignments()).toHaveLength(1);
  expect(assignments()[0]?.id).toBe(assignment?.id);
  expect(store.verifyToken(token)?.role_version).toBe(1);
  expect(output.join("\n")).not.toContain(token);
});

test("start uses the existing launch entry and skips an unfinished Run", async () => {
  const start = vi.fn(async (input: Parameters<StartById>[0]) => {
    runCommand(input.store, {
      project_id: project,
      actor: { kind: "human", project_id: project },
      reduce: (state, actor, ports) =>
        queueRun(
          state,
          actor,
          {
            assignment_id: input.assignment_id,
            model: "fixture",
            agent_cli_version: "fixture",
            reuse_queued: true,
          },
          ports,
        ),
    });
    return 0;
  });
  expect(await main(["host-ops", "start"], io, { start })).toBe(2);
  expect(start).not.toHaveBeenCalled();
  expect(await main(["host-ops", "create"], io)).toBe(0);
  output = [];
  expect(
    await main(
      [
        "host-ops",
        "start",
        "--mcp-url",
        "http://localhost/mcp",
        "--hc-session",
        "fixture-session",
      ],
      io,
      { start },
    ),
  ).toBe(0);
  expect(start.mock.calls[0]?.[0]).toMatchObject({
    assignment_id: assignments()[0]?.id,
    project_id: project,
    mcpUrl: "http://localhost/mcp",
    session: "fixture-session",
  });
  expect(output.join("\n")).not.toContain("Token（");
  expect(await main(["host-ops", "start"], io, { start })).toBe(0);
  expect(start).toHaveBeenCalledTimes(1);
  expect(output.join("\n")).toContain("已在运行，跳过");
});

test.each(["create", "start", "rotate"])(
  "%s rejects both token inputs before effects or launch",
  async (sub) => {
    expect(
      CLI_TOOLS[
        `host-ops ${sub}` as
          | "host-ops create"
          | "host-ops start"
          | "host-ops rotate"
      ],
    ).toBeNull();
    expect(await main(["host-ops", "create"], io)).toBe(0);
    const token = fixtureToken();
    const path = join(dir, "credential");
    writeFileSync(path, token, { mode: 0o600 });
    const before = assignments();
    const start = vi.fn(async () => 0);
    for (const credential of [token, randomBytes(32).toString("hex"), ""]) {
      output = [];
      errors = [];
      const supplied = {
        ...io,
        env: { ...io.env, CARDIGAN_TOKEN: credential },
      };
      expect(await main(["host-ops", sub], supplied, { start })).toBe(2);
      expect(errors.join("\n")).toContain("仅限人类");
      if (credential)
        expect([...output, ...errors].join("\n").includes(credential)).toBe(
          false,
        );
      await expect(
        runWorkflowCommand(["host-ops", sub], supplied, { start }),
      ).rejects.toThrow("仅限人类");
    }
    expect(
      await main(["host-ops", sub, "--token-file", path], io, { start }),
    ).toBe(2);
    expect(start).not.toHaveBeenCalled();
    expect(assignments()).toEqual(before);
    expect(store.verifyToken(token) !== undefined).toBe(true);
  },
);

test("invalid flags and unavailable roles fail without creating assignments or printing tokens", async () => {
  for (const args of [
    ["create", "--ops"],
    ["start", "--employee", "E-1"],
    ["create", "unexpected"],
    ["unknown"],
  ])
    expect(await main(["host-ops", ...args], io)).toBe(2);
  expect(await main(["role", "deactivate", "host_ops"], io)).toBe(0);
  expect(await main(["host-ops", "create"], io)).not.toBe(0);
  expect(assignments()).toEqual([]);
  expect(output.join("\n")).not.toContain("Token（");
});

test("rotate retains the employee, transfers pending work and starts without exposing credentials", async () => {
  expect(
    await main(
      [
        "employee",
        "add",
        "--name",
        "Operator",
        "--title",
        "Operations",
        "--role",
        "host_ops",
      ],
      io,
    ),
  ).toBe(0);
  expect(await main(["host-ops", "create"], io)).toBe(0);
  const previous = required(assignments()[0]);
  const token = fixtureToken();
  const event = required(
    store.getUpdates({ project_id: project, since_seq: 0 }).events.at(-1),
  );
  store.recordNotification({
    project_id: project,
    event_id: event.id,
    seq: event.seq,
    recipient: { kind: "assignment", assignment_id: previous.id },
    kind: "comment",
  });
  const roleFile = join(dir, "role.yaml");
  writeFileSync(
    roleFile,
    JSON.stringify({
      ...defaultRoleDefinition("host_ops", {
        harness: "codex",
        launch_profile_ref: "fixture",
      }),
      instructions: "Updated operations rules",
    }),
  );
  expect(await main(["role", "update", "--file", roleFile], io)).toBe(0);
  output = [];
  const start = vi.fn(async () => 0);
  expect(await main(["host-ops", "rotate"], io, { start })).toBe(0);
  const next = required(assignments().find((a) => a.status === "active"));
  expect(next.id).not.toBe(previous.id);
  expect(next.employee_id).toBe(previous.employee_id);
  expect(next.role_version).toBe(2);
  expect(assignments().find((a) => a.id === previous.id)?.status).toBe(
    "released",
  );
  expect(store.verifyToken(token)).toBeUndefined();
  expect(store.listNotifications({ project_id: project })).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        status: "pending",
        recipient: { kind: "assignment", assignment_id: next.id },
      }),
    ]),
  );
  expect(start).toHaveBeenCalledWith(
    expect.objectContaining({ assignment_id: next.id }),
  );
  expect([...output, ...errors].join("\n")).not.toContain(token);
  expect(output.join("\n")).not.toContain("Token（");
  // Retrying after an unsuccessful start reuses the same replacement.
  expect(await main(["host-ops", "rotate"], io, { start })).toBe(0);
  expect(assignments()).toHaveLength(2);
});

async function prepareRotation() {
  expect(await main(["host-ops", "create"], io)).toBe(0);
  const roleFile = join(dir, "role.yaml");
  writeFileSync(
    roleFile,
    JSON.stringify({
      ...defaultRoleDefinition("host_ops", {
        harness: "codex",
        launch_profile_ref: "fixture",
      }),
      instructions: "New version",
    }),
  );
  expect(await main(["role", "update", "--file", roleFile], io)).toBe(0);
  return required(assignments()[0]);
}

test("rotation scrubs the bound account credentials and preserves the global base and other Assignment", async () => {
  const previous = await prepareRotation();
  const targetRoot = mkdtempSync(join(tmpdir(), "cg-rotate-target-"));
  try {
    chmodSync(dir, 0o700);
    chmodSync(targetRoot, 0o2750);
    const local = store.uow.read((tx) => tx.machines.get(project, "local"));
    if (!local) throw new Error("Missing local machine");
    const worker = {
      machine_id: "local",
      project_id: project,
      os: local.os,
      arch: local.arch,
      session: "project-session",
      generation: "one",
      execution: {
        mode: "agent-ssh" as const,
        dataDir: dir,
        agentRoot: targetRoot,
        gid: process.getgid?.() ?? 0,
        machine: "project-agent",
        host: "localhost",
        user: "project_a",
        identityFile: "/synthetic/key",
        knownHostsFile: "/synthetic/known_hosts",
        path: "/usr/bin:/bin",
      },
    };
    let released = false;
    const release = vi.fn(async () => {
      released = true;
      return { ok: true, value: undefined };
    });
    const adapter = {
      release,
      status: async () =>
        released
          ? { ok: false, error: { code: "runtime_not_found", message: "gone" } }
          : {
              ok: true,
              value: { process: "alive", agent: "idle", observed_seq: 1 },
            },
    } as unknown as HerdrRuntime;
    const created = await RuntimeTargets.create({
      execution: { mode: "local", dataDir: dir },
      store,
      project,
      workers: () => [worker],
      factory: async () => ({ ok: true, value: adapter }),
    });
    if (!created.ok) throw new Error("Invalid fixture target");
    const selected = created.value.resolve(project, "local").execution;
    const target = selected.target;
    if (!target) throw new Error("Missing fixture binding");
    const ref = {
      machine_id: "local",
      runtime_machine: "project-agent",
      terminal_ref: "project-agent/t1",
      agent_name: "fixture",
      target,
    };
    store.uow.run((tx) =>
      tx.assignments.put(project, { ...previous, runtime_ref: ref }),
    );
    await prepareAgentProject(worker.execution, project, previous.id);
    await prepareAgentProject(worker.execution, project, "A-99");
    const secret = join(
      executionPaths(selected, project, previous.id).runDir,
      "secrets.env",
    );
    const other = join(
      executionPaths(selected, project, "A-99").runDir,
      "secrets.env",
    );
    const baseDir = executionPaths(
      { mode: "local", dataDir: dir },
      project,
      previous.id,
    ).runDir;
    mkdirSync(baseDir, { recursive: true });
    const base = join(baseDir, "secrets.env");
    for (const path of [secret, other, base])
      writeFileSync(path, "SYNTHETIC_ONLY=fixture\n", { mode: 0o600 });
    vi.spyOn(RuntimeTargets, "create").mockResolvedValue(created);
    const start = vi.fn(async () => 0);
    expect(
      await main(["host-ops", "rotate"], io, { start }),
      errors.join("\n"),
    ).toBe(0);
    expect(release).toHaveBeenCalledWith(ref, { force: true });
    expect(existsSync(secret)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(base)).toBe(true);
    expect(assignments().find((a) => a.id === previous.id)?.status).toBe(
      "released",
    );
    expect(start).toHaveBeenCalledOnce();
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test("unconfirmed terminal exit leaves the old Assignment, token and inbox untouched", async () => {
  const previous = await prepareRotation();
  const token = fixtureToken();
  store.uow.run((tx) =>
    tx.assignments.put(project, {
      ...previous,
      runtime_ref: {
        machine_id: "local",
        runtime_machine: "local",
        terminal_ref: "fixture",
        agent_name: "fixture",
      },
    }),
  );
  const runtime = {
    status: vi.fn(async () => ({
      ok: true,
      value: { process: "alive", agent: "idle", observed_seq: 1 },
    })),
    release: vi.fn(async () => ({
      ok: false,
      error: {
        code: "runtime_unavailable",
        message: "sensitive runtime output",
      },
    })),
  } as unknown as HerdrRuntime;
  vi.spyOn(HerdrRuntime, "create").mockResolvedValue({
    ok: true,
    value: runtime,
  });
  const before = assignments();
  const beforeEvents = store.getUpdates({
    project_id: project,
    since_seq: 0,
  }).events;
  const start = vi.fn(async () => 0);
  expect(await main(["host-ops", "rotate"], io, { start })).not.toBe(0);
  expect(assignments()).toEqual(before);
  expect(
    store.getUpdates({ project_id: project, since_seq: 0 }).events,
  ).toEqual(beforeEvents);
  expect(store.verifyToken(token)).toBeDefined();
  expect(start).not.toHaveBeenCalled();
  expect(errors.join("\n")).toContain("旧终端尚未确认退出");
  expect([...output, ...errors].join("\n")).not.toContain(
    "sensitive runtime output",
  );
});

test.each(["exit-code", "exception"])(
  "failed replacement start (%s) preserves the new identity and prints a retry command",
  async (failure) => {
    const previous = await prepareRotation();
    const token = fixtureToken();
    const start = vi.fn(async () => {
      if (failure === "exception")
        throw new Error(`fixture start failure ${token}`);
      return 1;
    });
    expect(await main(["host-ops", "rotate"], io, { start })).not.toBe(0);
    const next = required(assignments().find((a) => a.status === "active"));
    expect(next.id).not.toBe(previous.id);
    expect(store.verifyToken(token)).toBeUndefined();
    expect(errors.join("\n")).toContain("cardigan host-ops start --project");
    expect([...output, ...errors].join("\n")).not.toContain(token);
    const retry = vi.fn(async () => 0);
    expect(await main(["host-ops", "start"], io, { start: retry })).toBe(0);
    expect(retry).toHaveBeenCalledWith(
      expect.objectContaining({ assignment_id: next.id }),
    );
    expect(assignments()).toHaveLength(2);
  },
);

test("rotating an unnamed operator can select a project employee without rewriting history", async () => {
  const previous = await prepareRotation();
  for (const [name, membership] of [
    ["First", project],
    ["Second", project],
    ["Foreign", "other"],
  ] as const) {
    expect(
      await main(
        [
          "employee",
          "add",
          "--name",
          name,
          "--title",
          "Operations",
          "--role",
          "host_ops",
          "--projects",
          membership,
        ],
        io,
      ),
    ).toBe(0);
  }
  const start = vi.fn(async () => 0);
  const rotate = (...flags: string[]) =>
    main(["host-ops", "rotate", ...flags], io, { start });
  expect(await rotate()).toBe(2);
  expect(errors.join("\n")).toContain("--employee");
  expect(await rotate("--employee", "Foreign")).toBe(2);
  expect(errors.join("\n")).toContain("不属于本项目");
  expect(assignments()).toEqual([previous]);
  expect(start).not.toHaveBeenCalled();
  expect(await rotate("--employee", "Second")).toBe(0);
  const after = assignments();
  expect(after.find((a) => a.status === "active")).toMatchObject({
    employee_id: "E-2",
    role_version: 2,
  });
  expect(after.find((a) => a.id === previous.id)).not.toHaveProperty(
    "employee_id",
  );
  expect(await rotate("--employee", "E-1")).toBe(2);
  expect(assignments()).toEqual(after);
});
