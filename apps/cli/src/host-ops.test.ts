import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_OPS_ROLE_TOOLS, queueRun } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { StartById } from "./assignment.js";
import { CLI_TOOLS } from "./command-access.js";
import { runCommand } from "./host.js";
import { main } from "./index.js";
import type { CliIo } from "./io.js";
import { runWorkflowCommand } from "./workflow.js";

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
    env: { CARDIGAN_DATA_DIR: dir },
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
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
function assignments() {
  return store.uow.read((tx) => tx.assignments.list(project));
}
function printedToken(): string {
  const lines = output.join("\n").split("\n");
  const at = lines.findIndex((line) => line.startsWith("Token（只显示这一次"));
  const token = lines[at + 1];
  if (at < 0 || !token) throw new Error("Expected one-time token output");
  return token;
}

test("create binds the sole operations employee and prints each issued token only once", async () => {
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
  const token = printedToken();
  expect(output.join("\n").split(token).length - 1).toBe(1);
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
  expect(store.verifyToken(token)).toBeUndefined();
  expect(store.verifyToken(printedToken())?.role_version).toBe(1);
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

test.each(["create", "start"])(
  "%s rejects both token inputs before effects or launch",
  async (sub) => {
    expect(
      CLI_TOOLS[`host-ops ${sub}` as "host-ops create" | "host-ops start"],
    ).toBeNull();
    expect(await main(["host-ops", "create"], io)).toBe(0);
    const token = printedToken();
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
