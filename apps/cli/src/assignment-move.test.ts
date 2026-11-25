import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Assignment, type ToolName, toolNames } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { main } from "./index.js";
import type { CliIo } from "./io.js";
import {
  openHumanCardTemplates,
  registerTemplateRoles,
} from "./template-fixtures.js";

const project = "move-project";
let dir: string;
let store: Store;
let io: CliIo;
let output: string[];
let errors: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "cardigan-assignment-move-"));
  store = Store.open({ dataDir: dir });
  store.createProject({ id: project, name: "Move fixture" });
  store.uow.run((tx) => {
    tx.roles.put(project, {
      role_id: "pm",
      role_version: 1,
      allowed_tools: toolNames,
      capabilities: [],
    });
    const local = tx.machines.get(project, "local");
    if (!local) throw new Error("missing local");
    for (const [id, status] of [
      ["mac-mini", "online"],
      ["retired", "draining"],
    ] as const)
      tx.machines.put(project, {
        ...local,
        id,
        label: id,
        herdr_machine: id,
        status,
      });
    tx.employees.put({
      id: "E-1" as never,
      name: "Alice",
      title: "开发",
      bio: "",
      avatar: null,
      role_id: "coder",
      launch_profile_ref: null,
      status: "active",
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
    });
  });
  registerTemplateRoles(store, project);
  openHumanCardTemplates(store, project, ["dev"]);
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
      throw new Error("assignment move must not spawn");
    },
    captureCommand: async () => {
      throw new Error("assignment move must not capture");
    },
  };
  expect(
    await run([
      "card",
      "create",
      "--template",
      "dev",
      "--title",
      "Fixture",
      "--goal",
      "Move",
      "--acceptance",
      "Moves",
      "--repo",
      "example/repo",
    ]),
  ).toBe(0);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function run(args: string[], input = io) {
  output.length = 0;
  errors.length = 0;
  return main(args, input);
}

const assignments = () =>
  store.uow
    .read((tx) => tx.assignments.list(project))
    .filter((a) => a.scope === "work_item" && a.work_item_id === "W-1");

/** A first producer on local with one queued Run that never dispatched. */
async function queuedFirst(patch: Partial<Assignment> = {}) {
  expect(
    await run([
      "assign",
      "W-1",
      "--role",
      "coder",
      "--employee",
      "E-1",
      "--machine",
      "local",
    ]),
  ).toBe(0);
  const [target] = assignments();
  if (!target) throw new Error("Missing target Assignment");
  store.uow.run((tx) => {
    tx.assignments.put(project, { ...target, ...patch });
    tx.runs.put(project, {
      id: tx.ids.next(project, "run"),
      assignment_id: target.id,
      trigger_event_id: tx.ids.nextEventId(),
      kind: "initial",
      status: "queued",
      role_version: target.role_version,
      model: "fixture",
      agent_cli_version: "1",
      outcome: null,
      summary: "",
    });
  });
  return target;
}

function opsToken(allowed_tools: readonly ToolName[]) {
  const ops = store.uow.run((tx) => {
    const row: Assignment = {
      id: tx.ids.next(project, "assignment"),
      scope: "standing",
      standing_mode: "ops",
      role_id: "pm",
      role_version: 1,
      status: "active",
      runtime_state: "not_provisioned",
      runtime_ref: null,
      machine_id: "local",
      mcp_token_id: "fixture",
      created_at: new Date().toISOString(),
    };
    tx.assignments.put(project, row);
    return row;
  });
  return store.issueToken({
    project_id: project,
    assignment_id: ops.id,
    role: { role_version: 1, allowed_tools },
  }).token;
}

test("C-716 move cancels the unstarted queue and reassigns the same employee and role to the named machine", async () => {
  const target = await queuedFirst();
  expect(
    await run(["assignment", "move", target.id, "--machine", "mac-mini"]),
  ).toBe(0);
  const [before, after] = assignments();
  expect(before).toMatchObject({ id: target.id, status: "released" });
  expect(after).toMatchObject({
    status: "active",
    machine_id: "mac-mini",
    employee_id: "E-1",
    role_id: target.role_id,
    role_version: target.role_version,
    recovery: { previous_assignment_id: target.id },
  });
  expect(
    store.uow.read((tx) => tx.work_items.get(project, "W-1"))?.assignment_id,
  ).toBe(after?.id);
  expect(
    store.uow
      .read((tx) => tx.runs.list(project))
      .filter((r) => r.assignment_id === target.id)
      .map((r) => r.status),
  ).toEqual(["cancelled"]);
  expect(output.join("\n")).toContain(
    `从 local（${target.id}）换到 mac-mini（${after?.id}）`,
  );
});

test.each([
  ["an ineligible machine", ["--machine", "retired"], {}, "draining"],
  ["an unknown machine", ["--machine", "nowhere"], {}, ""],
  ["the same machine", ["--machine", "local"], {}, "已在 local 上"],
  ["no machine", [], {}, "--machine"],
  [
    "a started assignment",
    ["--machine", "mac-mini"],
    { worktree_path: "/tmp/started" },
    "不跨机迁移",
  ],
] as const)(
  "C-716 move refuses %s and changes nothing",
  async (_, flags, patch, reason) => {
    const target = await queuedFirst(patch);
    const runsBefore = store.uow.read((tx) => tx.runs.list(project));
    expect(await run(["assignment", "move", target.id, ...flags])).toBe(2);
    expect(errors.join("\n")).toContain(reason);
    expect(assignments()).toEqual([{ ...target, ...patch }]);
    expect(store.uow.read((tx) => tx.runs.list(project))).toEqual(runsBefore);
  },
);

test("C-716 a refused reassignment rolls back the release: PM Ops needs both tools", async () => {
  const target = await queuedFirst();
  const partial = {
    ...io,
    env: { ...io.env, CARDIGAN_TOKEN: opsToken(["release_assignment"]) },
  };
  expect(
    await run(
      ["assignment", "move", target.id, "--machine", "mac-mini"],
      partial,
    ),
  ).toBe(2);
  // The release step passed; only the second step was refused.
  expect(errors.join("\n")).toMatch(/forbidden_tool|assign/);
  expect(errors.join("\n")).not.toContain("release_assignment");
  expect(assignments()).toEqual([target]);
  const full = {
    ...io,
    env: {
      ...io.env,
      CARDIGAN_TOKEN: opsToken(["release_assignment", "assign"]),
    },
  };
  expect(
    await run(["assignment", "move", target.id, "--machine", "mac-mini"], full),
  ).toBe(0);
  expect(assignments().map((a) => [a.status, a.machine_id])).toEqual([
    ["released", "local"],
    ["active", "mac-mini"],
  ]);
});
