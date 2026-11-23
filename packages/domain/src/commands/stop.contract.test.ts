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
import { dispatchRun } from "./launch.js";
import {
  humanStopRecorded,
  openStopEpisodeStart,
  pausedByHuman,
  stopExitConfirmed,
  stoppedByHuman,
  stopWorkItemAssignment,
} from "./stop.js";
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
  extra: {
    released_runtime_ref?: RuntimeRef;
    exit_confirmed_ref?: RuntimeRef;
    hold?: boolean;
  } = {},
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
    expect(!refused.ok && refused.error.message).toMatch(
      /待处理的主机运维操作/,
    );
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

/**
 * C-235: fix the guarantees between a stop and a start already in flight.
 * The host launch flow only lets an Agent start after `dispatchRun` commits;
 * these cases pin that the domain refuses that commit once the stop won.
 */
const freshRef: RuntimeRef = {
  ...ref,
  terminal_ref: "t-new",
  agent_name: "a-new",
};
const dispatch = (s: CommandState, runtime_ref?: RuntimeRef) =>
  dispatchRun(
    s,
    human,
    {
      run_id: id("run", 9),
      launch_snapshot: { model: "test", agent_cli_version: "test" },
      ...(runtime_ref === undefined ? {} : { runtime_ref }),
    },
    ports(),
  );
/** Assignment 1 between Runs: the previous Run finished, its terminal idles. */
function idle(): CommandState {
  const s = base();
  return {
    ...s,
    assignments: s.assignments.map((a) =>
      a.id === id("assignment", 1)
        ? ({ ...a, runtime_state: "idle" } as Assignment)
        : a,
    ),
    runs: s.runs.map((r) =>
      r.id === id("run", 1)
        ? { ...r, status: "completed", outcome: "completed" as never }
        : r,
    ),
  };
}

test("C-235 a Run the stop already cancelled is never dispatched, on a fresh or the existing terminal", () => {
  const s = idle();
  // Control: before the stop the same queued Run can be dispatched both ways.
  expect(dispatch(s, freshRef).ok).toBe(true);
  expect(dispatch(s).ok).toBe(true);

  const stopped = apply(s, (stop(s) as { ok: true; value: never }).value);
  expect(stopped.runs.find((r) => r.id === id("run", 9))?.status).toBe(
    "cancelled",
  );
  for (const attempt of [dispatch(stopped, freshRef), dispatch(stopped)]) {
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error.code).toBe("illegal_transition");
  }
  // Nothing about the refused dispatch lifts the stop or records a terminal.
  expect(stoppedByHuman(stopped.events, id("assignment", 1))).toBe(true);
  expect(
    stopped.events.some(
      (e) =>
        e.type === "run_dispatched" &&
        (e.payload as { run_id?: string }).run_id === id("run", 9),
    ),
  ).toBe(false);
});

test("C-235 a wake dispatched before the stop is cancelled and its terminal released", () => {
  const s = idle();
  // The bell path dispatches the queued Run onto the existing terminal...
  const woken = apply(s, (dispatch(s) as { ok: true; value: never }).value);
  expect(woken.runs.find((r) => r.id === id("run", 9))?.status).toBe(
    "dispatched",
  );
  expect(stoppedByHuman(woken.events, id("assignment", 1))).toBe(false);

  // ...then the human stops. Step 1 records the stop; the dispatched Run
  // keeps its slot because its terminal has not been released yet.
  const first = stop(woken);
  expect(first.ok && first.value.data.cancelled).toBe(0);
  const stopped = apply(woken, (first as { ok: true; value: never }).value);
  expect(stoppedByHuman(stopped.events, id("assignment", 1))).toBe(true);
  expect(stopped.runs.find((r) => r.id === id("run", 9))?.status).toBe(
    "dispatched",
  );

  // Step 2, after the host released that terminal: the Run is cancelled and
  // the Assignment no longer points at any terminal.
  const settled = stop(stopped, { released_runtime_ref: ref });
  expect(settled.ok && settled.value.data.cancelled).toBe(1);
  const next = apply(stopped, (settled as { ok: true; value: never }).value);
  expect(next.runs.find((r) => r.id === id("run", 9))).toMatchObject({
    status: "cancelled",
    summary: "stopped by host",
  });
  expect(
    next.assignments.find((x) => x.id === id("assignment", 1)),
  ).toMatchObject({ runtime_ref: null });
  expect(stoppedByHuman(next.events, id("assignment", 1))).toBe(true);
  // The cancelled Run cannot be dispatched again by a late wake either.
  expect(dispatch(next).ok).toBe(false);
  expect(dispatch(next, freshRef).ok).toBe(false);
});

/**
 * C-620: a managed stop (`hold: false`, the CLI default) fences dispatch only
 * until its terminal release is confirmed; an explicit pause (`hold`, and
 * every legacy stop) keeps holding until the human starts it again.
 */
test("C-620 a managed stop keeps unstarted queued work and stops fencing once its release is confirmed", () => {
  const A1 = id("assignment", 1);
  const s = base();
  const first = stop(s, { hold: false });
  expect(first.ok && first.value.data.cancelled).toBe(0);
  const stopping = apply(s, (first as { ok: true; value: never }).value);
  expect(stopping.events.at(-1)).toMatchObject({
    type: "assignment_stopped",
    payload: { assignment_id: A1, hold: false, cancelled_run_ids: [] },
  });
  // Release not yet confirmed: still fenced, exactly like a pause.
  expect(stoppedByHuman(stopping.events, A1)).toBe(true);
  expect(pausedByHuman(stopping.events, A1)).toBe(false);
  expect(stopping.runs.find((r) => r.id === id("run", 9))?.status).toBe(
    "queued",
  );
  // A release of another terminal settles nothing and keeps the fence.
  const wrong = stop(stopping, {
    released_runtime_ref: { ...ref, terminal_ref: "t2" },
  });
  expect(wrong.ok && wrong.value.changes).toEqual([]);
  const settled = stop(stopping, { released_runtime_ref: ref });
  expect(settled.ok && settled.value.data.cancelled).toBe(1);
  const next = apply(stopping, (settled as { ok: true; value: never }).value);
  const status = (n: number) =>
    next.runs.find((r) => r.id === id("run", n))?.status;
  expect(status(1)).toBe("cancelled");
  expect(status(9)).toBe("queued");
  expect(next.assignments.find((a) => a.id === A1)).toMatchObject({
    runtime_ref: null,
  });
  // Released: no longer stopped, so new work starts a fresh session.
  expect(stoppedByHuman(next.events, A1)).toBe(false);
  expect(pausedByHuman(next.events, A1)).toBe(false);
  // The stop itself is still on record until the next dispatch.
  expect(humanStopRecorded(next.events, A1)).toBe(true);
  // The queued work dispatches onto a fresh terminal.
  expect(dispatch(next, freshRef).ok).toBe(true);
});

test("C-620 a pause and every legacy stop keep holding after release; a managed stop never downgrades a pause", () => {
  const A1 = id("assignment", 1);
  for (const hold of [true, undefined]) {
    const s = base();
    const paused = apply(
      s,
      (
        stop(s, hold === undefined ? {} : { hold }) as {
          ok: true;
          value: never;
        }
      ).value,
    );
    expect(paused.events.at(-1)).toMatchObject({
      payload: { hold: true, cancelled_run_ids: [id("run", 9)] },
    });
    // Retrying a stop without --hold keeps the pause.
    const retried = apply(
      paused,
      (stop(paused, { hold: false }) as { ok: true; value: never }).value,
    );
    expect(retried.events.at(-1)).toMatchObject({ payload: { hold: true } });
    const next = apply(
      retried,
      (
        stop(retried, { released_runtime_ref: ref }) as {
          ok: true;
          value: never;
        }
      ).value,
    );
    expect(stoppedByHuman(next.events, A1)).toBe(true);
    expect(pausedByHuman(next.events, A1)).toBe(true);
  }
  // A legacy event without `hold` is a pause.
  const legacy = (type: string, seq: number, payload = {}): Event => ({
    id: String(seq).padStart(26, "0") as never,
    seq,
    type,
    actor: human,
    payload: { assignment_id: A1, ...payload },
    created_at: "2026-01-01T00:00:00.000Z",
  });
  const events = [
    legacy("assignment_stopped", 1),
    legacy("assignment_stop_released", 2),
  ];
  expect(stoppedByHuman(events, A1)).toBe(true);
  expect(pausedByHuman(events, A1)).toBe(true);
  // A managed stop released, then a new dispatch, then a pause: paused again.
  const replay = [
    legacy("assignment_stopped", 1, { hold: false }),
    legacy("assignment_stop_released", 2),
    legacy("run_dispatched", 3),
    legacy("assignment_stopped", 4, { hold: true }),
    legacy("assignment_stop_released", 5),
  ];
  expect(stoppedByHuman(replay.slice(0, 2), A1)).toBe(false);
  expect(humanStopRecorded(replay.slice(0, 3), A1)).toBe(false);
  expect(stoppedByHuman(replay, A1)).toBe(true);
  // A duplicated release event cannot lift a later pause.
  expect(
    stoppedByHuman([...replay, legacy("assignment_stop_released", 6)], A1),
  ).toBe(true);
});

test("C-620 host_ops can restart a released managed stop, but not one whose release is pending", () => {
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
  const stopping = apply(
    s,
    (stop(s, { hold: false }) as { ok: true; value: never }).value,
  );
  expect(beginHostOpsAction(stopping, caller, restart, ports()).ok).toBe(false);
  const released = apply(
    stopping,
    (
      stop(stopping, { released_runtime_ref: ref }) as {
        ok: true;
        value: never;
      }
    ).value,
  );
  const allowed = beginHostOpsAction(released, caller, restart, ports());
  expect(allowed.ok ? "ok" : allowed.error.message).toBe("ok");
});

test("C-620 a stop episode spans retries; its proven exit is recorded once for the exact session and ends with the release", () => {
  const A1 = id("assignment", 1);
  const step = (
    s: CommandState,
    extra: Parameters<typeof stop>[1],
  ): CommandState => {
    const result = stop(s, extra);
    if (!result.ok) throw new Error(result.error.message);
    return apply(s, result.value);
  };
  const base0 = base();
  // Without a stop there is nothing to confirm.
  expect(stop(base0, { exit_confirmed_ref: ref })).toMatchObject({
    ok: true,
    value: { changes: [] },
  });
  let s = step(base0, { hold: false });
  const first = s.events.length - 1;
  expect(openStopEpisodeStart(s.events, A1)).toBe(first);
  // A retry continues the same episode.
  s = step(s, { hold: false });
  expect(openStopEpisodeStart(s.events, A1)).toBe(first);
  // Only the exact current session can be confirmed, and only once.
  const other = { ...ref, terminal_ref: "t2" };
  expect(stop(s, { exit_confirmed_ref: other })).toMatchObject({
    ok: true,
    value: { changes: [] },
  });
  expect(stopExitConfirmed(s.events, A1, ref)).toBe(false);
  s = step(s, { exit_confirmed_ref: ref });
  expect(s.events.at(-1)).toMatchObject({
    type: "assignment_stop_exit_confirmed",
    payload: { assignment_id: A1, runtime_ref: ref },
  });
  expect(stopExitConfirmed(s.events, A1, ref)).toBe(true);
  expect(stopExitConfirmed(s.events, A1, other)).toBe(false);
  expect(stop(s, { exit_confirmed_ref: ref })).toMatchObject({
    ok: true,
    value: { changes: [] },
  });
  // Confirmation alone neither clears the session nor lifts the fence.
  expect(stoppedByHuman(s.events, A1)).toBe(true);
  expect(s.assignments.find((a) => a.id === A1)?.runtime_ref).toEqual(ref);
  s = step(s, { released_runtime_ref: ref });
  expect(openStopEpisodeStart(s.events, A1)).toBeUndefined();
  expect(stopExitConfirmed(s.events, A1, ref)).toBe(false);
});
