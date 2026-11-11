import { expect, test } from "vitest";
import type { Actor, Assignment } from "../entities.js";
import {
  HOST_OPS_ROLE_TOOLS,
  type HostOpsExecutionTool,
  hostOpsPending,
} from "../host-ops.js";
import type { CommandState } from "./core.js";
import {
  beginHostOpsAction,
  finishHostOpsAction,
  hostOpsReadDiagnostics,
  prepareHostOpsAction,
} from "./host-ops-actions.js";
import { abortDispatch, acknowledgeRun, queueRun } from "./launch.js";
import { pauseStandingAssignment } from "./standing.js";
import {
  actor,
  apply,
  assignment,
  fixture,
  human,
  id,
  now,
  ports,
  role,
  value,
} from "./test-fixtures.js";

const { work_item_id: _work, ...opsFields } = assignment(10, "host_ops");
const ops: Assignment = { ...opsFields, scope: "standing" };
const caller = {
  ...actor(10, "host_ops"),
  allowed_tools: HOST_OPS_ROLE_TOOLS,
} as Extract<Actor, { kind: "assignment" }>;
const snapshot = { model: "test", agent_cli_version: "test" };
function base(): CommandState {
  const s = fixture();
  return {
    ...s,
    roles: [
      ...s.roles,
      { ...role("host_ops"), allowed_tools: HOST_OPS_ROLE_TOOLS },
    ],
    assignments: [...s.assignments, ops],
  };
}
const tools: HostOpsExecutionTool[] = [
  "host_ops_restart_assignment",
  "host_ops_cancel_run",
  "host_ops_restart_standing_pm",
];
const params = (tool: HostOpsExecutionTool) => ({
  tool,
  target_id:
    tool === "host_ops_cancel_run"
      ? id("run", 1)
      : tool === "host_ops_restart_standing_pm"
        ? id("assignment", 4)
        : id("assignment", 1),
  reason: "Recover stalled execution",
  snapshot,
});

test.each(tools)(
  "%s requires this project's active standing host_ops and its exact token/role permission",
  (tool) => {
    const s = base();
    const before = JSON.stringify(s);
    for (const a of [
      human,
      actor(4, "pm"),
      { ...caller, project_id: "other" },
      {
        ...caller,
        allowed_tools: HOST_OPS_ROLE_TOOLS.filter((t) => t !== tool),
      },
    ]) {
      expect(beginHostOpsAction(s, a, params(tool), ports()).ok).toBe(false);
    }
    for (const status of ["suspended", "released"] as const)
      expect(
        beginHostOpsAction(
          {
            ...s,
            assignments: s.assignments.map((a) =>
              a.id === ops.id ? { ...a, status } : a,
            ),
          },
          caller,
          params(tool),
          ports(),
        ).ok,
      ).toBe(false);
    expect(
      beginHostOpsAction(
        {
          ...s,
          roles: s.roles.map((r) =>
            r.role_id === "host_ops" ? { ...r, allowed_tools: [] } : r,
          ),
        },
        caller,
        params(tool),
        ports(),
      ).ok,
    ).toBe(false);
    expect(JSON.stringify(s)).toBe(before);
  },
);

test.each(tools)(
  "%s checks all targets before creating any effects and records one actor-bound audit intent",
  (tool) => {
    const s = base(),
      io = ports();
    const before = JSON.stringify(s);
    expect(
      beginHostOpsAction(
        s,
        caller,
        { ...params(tool), target_id: id("assignment", 99) },
        io,
      ).ok,
    ).toBe(false);
    expect(
      beginHostOpsAction(s, caller, { ...params(tool), reason: " " }, io).ok,
    ).toBe(false);
    expect(
      beginHostOpsAction(
        { ...s, cards: s.cards.map((c) => ({ ...c, project_id: "other" })) },
        caller,
        { ...params("host_ops_restart_assignment") },
        io,
      ).ok,
    ).toBe(false);
    const effect = value(beginHostOpsAction(s, caller, params(tool), io));
    expect(effect.changes).toEqual([]);
    expect(effect.events).toHaveLength(1);
    expect(effect.events[0]).toMatchObject({
      type: "host_ops_action_taken",
      actor: caller,
      payload: {
        tool,
        target_id: params(tool).target_id,
        reason: params(tool).reason,
      },
    });
    expect(JSON.stringify(s)).toBe(before);
    const pending = apply(s, effect);
    expect(beginHostOpsAction(pending, caller, params(tool), io).ok).toBe(
      false,
    );
    const finished = value(
      finishHostOpsAction(
        pending,
        { kind: "system", project_id: s.project_id },
        effect.data.action_id,
        io,
      ),
    );
    const result = apply(pending, finished);
    expect(hostOpsPending(result.events, effect.data.assignment_id)).toBe(
      false,
    );
    expect(finished.data.run?.status).toBe(
      tool === "host_ops_cancel_run" ? undefined : "queued",
    );
    expect(result.runs.find((r) => r.id === id("run", 1))?.status).toBe(
      tool === "host_ops_restart_standing_pm" ? "running" : "cancelled",
    );
  },
);

test("restart rejects external, wrong standing target, finished Run and competing stop without effects", () => {
  const s = base(),
    p = params("host_ops_restart_assignment");
  expect(
    beginHostOpsAction(
      s,
      caller,
      { ...params("host_ops_restart_standing_pm"), target_id: ops.id },
      ports(),
    ).ok,
  ).toBe(false);
  expect(
    beginHostOpsAction(
      s,
      caller,
      {
        ...params("host_ops_restart_standing_pm"),
        target_id: id("assignment", 1),
      },
      ports(),
    ).ok,
  ).toBe(false);
  expect(
    beginHostOpsAction(
      { ...s, runs: s.runs.map((r) => ({ ...r, status: "completed" })) },
      caller,
      params("host_ops_cancel_run"),
      ports(),
    ).ok,
  ).toBe(false);
  const external = {
    ...s,
    assignments: s.assignments.map((a) =>
      a.id === p.target_id ? { ...a, external: true } : a,
    ),
  };
  expect(prepareHostOpsAction(external, caller, p).ok).toBe(false);
  expect(
    beginHostOpsAction(s, caller, { ...p, snapshot: undefined }, ports()).ok,
  ).toBe(false);
});

test("an accepted stop fences ACK, launch and competing human stop until host settlement", () => {
  const s = base(),
    io = ports(),
    p = params("host_ops_restart_assignment");
  const effect = value(beginHostOpsAction(s, caller, p, io)),
    pending = apply(s, effect);
  expect(
    acknowledgeRun(pending, actor(), { run_id: id("run", 1) }, io).ok,
  ).toBe(false);
  expect(
    queueRun(
      pending,
      human,
      { ...snapshot, assignment_id: id("assignment", 1) },
      io,
    ).ok,
  ).toBe(false);
  expect(
    abortDispatch(
      pending,
      human,
      { run_id: id("run", 1), reason: "competing" },
      io,
    ).ok,
  ).toBe(false);
  expect(
    finishHostOpsAction(pending, caller, effect.data.action_id, io).ok,
  ).toBe(false);
  const closed = {
    ...pending,
    cards: pending.cards.map((c) => ({ ...c, status: "cancelled" as const })),
  };
  expect(
    value(
      finishHostOpsAction(
        closed,
        { kind: "system", project_id: s.project_id },
        effect.data.action_id,
        io,
      ),
    ).data.run,
  ).toBeUndefined();
});

test("standing pause and abort map only their own operational permissions; human behavior remains available", () => {
  const s = base(),
    io = ports();
  for (const a of [human, caller]) {
    expect(
      pauseStandingAssignment(s, a, { assignment_id: id("assignment", 4) }, io)
        .ok,
    ).toBe(true);
    expect(
      abortDispatch(s, a, { run_id: id("run", 1), reason: "stop" }, io).ok,
    ).toBe(true);
  }
  expect(
    pauseStandingAssignment(
      s,
      { ...caller, allowed_tools: ["host_ops_cancel_run"] },
      { assignment_id: id("assignment", 4) },
      io,
    ).ok,
  ).toBe(false);
  expect(
    abortDispatch(
      s,
      { ...caller, allowed_tools: ["host_ops_restart_standing_pm"] },
      { run_id: id("run", 1), reason: "stop" },
      io,
    ).ok,
  ).toBe(false);
  for (const a of [actor(4, "pm"), { ...caller, project_id: "other" }]) {
    expect(
      pauseStandingAssignment(s, a, { assignment_id: id("assignment", 4) }, io)
        .ok,
    ).toBe(false);
    expect(
      abortDispatch(s, a, { run_id: id("run", 1), reason: "stop" }, io).ok,
    ).toBe(false);
  }
  expect(hostOpsReadDiagnostics(s, caller, now).ok).toBe(true);
  expect(hostOpsReadDiagnostics(s, actor(4, "pm"), now).ok).toBe(false);
});

test("preflight refuses a conflicting pending worktree stop and an invalid launch profile before effects", () => {
  const original = base(),
    io = ports();
  const s: CommandState = {
    ...original,
    runs: [],
    assignments: original.assignments.map((a) =>
      a.scope === "work_item" ? { ...a, worktree_path: "/fixture/shared" } : a,
    ),
  };
  const p = params("host_ops_restart_assignment");
  const first = value(beginHostOpsAction(s, caller, p, io));
  const pending = apply(s, first);
  expect(
    beginHostOpsAction(
      pending,
      caller,
      { ...p, target_id: id("assignment", 2) },
      io,
    ).ok,
  ).toBe(false);
  expect(
    queueRun(
      pending,
      human,
      { ...snapshot, assignment_id: id("assignment", 2) },
      io,
    ).ok,
  ).toBe(false);
  expect(
    beginHostOpsAction(
      s,
      caller,
      { ...p, snapshot: { ...snapshot, launch_profile_ref: "" } },
      io,
    ).ok,
  ).toBe(false);
  const settled = value(
    finishHostOpsAction(
      pending,
      { kind: "system", project_id: s.project_id },
      first.data.action_id,
      io,
    ),
  );
  expect(settled.data.run?.status).toBe("queued");
});
