/**
 * C-211 contract: `cardigan assignment stop` on a work-item Assignment cancels
 * every unfinished Run (queued ones included) and keeps the Assignment stopped
 * until the human starts it again; host_ops cannot restart it in between.
 */
import { expect, test } from "vitest";
import type { Assignment, Event, Run, RuntimeRef } from "../entities.js";
import { HOST_OPS_ROLE_TOOLS } from "../host-ops.js";
import { occupiedRunSlots } from "../run-capacity.js";
import type { CommandState } from "./core.js";
import { beginHostOpsAction } from "./host-ops-actions.js";
import { stoppedByHuman, stopWorkItemAssignment } from "./stop.js";
import {
  actor,
  apply,
  assignment,
  fixture,
  human,
  id,
  ports,
  role,
  run,
} from "./test-fixtures.js";

const ref: RuntimeRef = {
  machine_id: "local" as never,
  runtime_machine: "local",
  terminal_ref: "t1",
  agent_name: "a1",
};
const queued: Run = {
  ...run(9, 1),
  status: "queued",
  kind: "followup",
};
function base(): CommandState {
  const s = fixture();
  return {
    ...s,
    assignments: s.assignments.map((a) =>
      a.id === id("assignment", 1)
        ? ({ ...a, runtime_state: "running", runtime_ref: ref } as Assignment)
        : a,
    ),
    runs: [...s.runs, queued],
  };
}
const stop = (
  s: CommandState,
  extra: { released_runtime_ref?: RuntimeRef } = {},
) =>
  stopWorkItemAssignment(
    s,
    human,
    { assignment_id: id("assignment", 1), reason: "stopped by host", ...extra },
    ports(),
  );

test("stop first cancels only queued Runs; the running one keeps its slot until the release", () => {
  const s = base();
  const result = stop(s);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.data.cancelled).toBe(1);
  const next = apply(s, result.value);
  const status = (n: number) =>
    next.runs.find((r) => r.id === id("run", n))?.status;
  expect(status(9)).toBe("cancelled");
  // Still counted as a busy run slot: the terminal is not released yet.
  expect(status(1)).toBe("running");
  expect(occupiedRunSlots(next.assignments, next.runs, "local")).toBe(
    occupiedRunSlots(s.assignments, s.runs, "local"),
  );
  // Other Assignments' Runs are untouched.
  expect(status(2)).toBe("running");
  const a = next.assignments.find((x) => x.id === id("assignment", 1));
  expect(a).toMatchObject({ runtime_state: "running", runtime_ref: ref });
  expect(stoppedByHuman(next.events, id("assignment", 1))).toBe(true);
  expect(stoppedByHuman(next.events, id("assignment", 2))).toBe(false);
  expect(next.events.at(-1)).toMatchObject({
    type: "assignment_stopped",
    card_id: id("card", 1),
    payload: {
      assignment_id: id("assignment", 1),
      cancelled_run_ids: [id("run", 9)],
    },
  });
});

test("after the release the remaining Runs end and only that terminal's ref is cleared", () => {
  const stopped = apply(
    base(),
    (stop(base()) as { ok: true; value: never }).value,
  );
  const other = { ...ref, terminal_ref: "t2" };
  const kept = stop(stopped, { released_runtime_ref: other });
  expect(kept.ok && kept.value.data.assignment.runtime_ref).toEqual(ref);
  expect(kept.ok && kept.value.changes).toEqual([]);
  const settled = stop(stopped, { released_runtime_ref: ref });
  expect(settled.ok).toBe(true);
  if (!settled.ok) return;
  expect(settled.value.data.cancelled).toBe(1);
  const next = apply(stopped, settled.value);
  expect(next.runs.find((r) => r.id === id("run", 1))).toMatchObject({
    status: "cancelled",
    summary: "stopped by host",
  });
  expect(
    next.assignments.find((x) => x.id === id("assignment", 1)),
  ).toMatchObject({ runtime_state: "idle", runtime_ref: null });
  expect(stoppedByHuman(next.events, id("assignment", 1))).toBe(true);
  // Without a holding stop the release step changes nothing.
  const unstopped = stop(base(), { released_runtime_ref: ref });
  expect(unstopped.ok && unstopped.value.changes).toEqual([]);
});

test("stop is refused while a host operation is pending, so neither is left unfinishable", () => {
  const { work_item_id: _w, ...opsFields } = assignment(10, "host_ops");
  const s0 = { ...base(), runs: fixture().runs };
  const s = {
    ...s0,
    roles: [
      ...s0.roles,
      { ...role("host_ops"), allowed_tools: HOST_OPS_ROLE_TOOLS },
    ],
    assignments: [
      ...s0.assignments,
      { ...opsFields, scope: "standing" } as Assignment,
    ],
  };
  const caller = {
    ...actor(10, "host_ops"),
    allowed_tools: HOST_OPS_ROLE_TOOLS,
  } as never;
  const begun = beginHostOpsAction(
    s,
    caller,
    {
      tool: "host_ops_restart_assignment",
      target_id: id("assignment", 1),
      reason: "Recover",
      snapshot: { model: "test", agent_cli_version: "test" },
    },
    ports(),
  );
  if (!begun.ok) throw new Error(begun.error.message);
  const pending = apply(s, begun.value);
  for (const extra of [{}, { released_runtime_ref: ref }]) {
    const refused = stop(pending, extra);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error.message).toMatch(/待处理的主机运维操作/);
  }
});

test("only the human stops, and only active work-item Assignments", () => {
  const s = base();
  for (const who of [
    actor(1),
    { kind: "system" as const, project_id: human.project_id },
  ])
    expect(
      stopWorkItemAssignment(
        s,
        who,
        { assignment_id: id("assignment", 1), reason: "x" },
        ports(),
      ).ok,
    ).toBe(false);
  expect(
    stopWorkItemAssignment(
      s,
      human,
      { assignment_id: id("assignment", 4), reason: "x" },
      ports(),
    ).ok,
  ).toBe(false);
  const released = {
    ...s,
    assignments: s.assignments.map((a) =>
      a.id === id("assignment", 1) ? { ...a, status: "released" as const } : a,
    ),
  };
  expect(stop(released).ok).toBe(false);
});

test("the stop holds until a later Run of that Assignment is dispatched", () => {
  const event = (type: string, assignment_id: string, seq: number): Event => ({
    id: String(seq).padStart(26, "0") as never,
    seq,
    type,
    actor: human,
    payload: { assignment_id, run_id: "R-1" },
    created_at: "2026-01-01T00:00:00.000Z",
  });
  const A1 = id("assignment", 1);
  expect(stoppedByHuman([], A1)).toBe(false);
  const stopped = [
    event("run_dispatched", A1, 1),
    event("assignment_stopped", A1, 2),
  ];
  expect(stoppedByHuman(stopped, A1)).toBe(true);
  // Another Assignment's dispatch does not resume this one.
  expect(
    stoppedByHuman([...stopped, event("run_dispatched", "A-2", 3)], A1),
  ).toBe(true);
  expect(stoppedByHuman([...stopped, event("run_dispatched", A1, 3)], A1)).toBe(
    false,
  );
});

test("host_ops cannot restart a stopped Assignment", () => {
  const { work_item_id: _w, ...opsFields } = assignment(10, "host_ops");
  const s0 = { ...base(), runs: fixture().runs };
  const s = {
    ...s0,
    roles: [
      ...s0.roles,
      { ...role("host_ops"), allowed_tools: HOST_OPS_ROLE_TOOLS },
    ],
    assignments: [
      ...s0.assignments,
      { ...opsFields, scope: "standing" } as Assignment,
    ],
  };
  const caller = {
    ...actor(10, "host_ops"),
    allowed_tools: HOST_OPS_ROLE_TOOLS,
  } as never;
  const restart = {
    tool: "host_ops_restart_assignment" as const,
    target_id: id("assignment", 1),
    reason: "Recover",
    snapshot: { model: "test", agent_cli_version: "test" },
  };
  const first = beginHostOpsAction(s, caller, restart, ports());
  expect(first.ok ? "ok" : first.error.message).toBe("ok");
  const stopped = apply(s, (stop(s) as { ok: true; value: never }).value);
  const refused = beginHostOpsAction(stopped, caller, restart, ports());
  expect(refused.ok).toBe(false);
  expect(!refused.ok && refused.error.message).toMatch(/stopped by the human/);
});
