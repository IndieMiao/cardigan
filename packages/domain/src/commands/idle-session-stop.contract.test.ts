import { expect, test } from "vitest";
import type { Actor, Assignment, Event, Run, RuntimeRef } from "../entities.js";
import { HOST_OPS_ROLE_TOOLS, hostOpsPending } from "../host-ops.js";
import type { CommandState } from "./core.js";
import {
  cancelQueuedHostOpsRun,
  directlyCancellableRun,
} from "./host-ops-queued-cancel.js";
import {
  releaseUnresponsiveSession,
  sessionTurnEnded,
  type UnresponsiveRelease,
  unresponsiveReleaseBlocker,
  untouchedQueuedRun,
} from "./idle-session-retirement.js";
import {
  actor,
  assignment,
  fixture,
  human,
  id,
  ports,
  role,
  value,
} from "./test-fixtures.js";

// C-759: a previous turn's session that is idle but still live blocked a
// queued Run (sensen A-461 on cardigan-ci, 30 minutes; the queued Run held the
// only emulator slot). Host operations can now cancel the queued Run without
// touching the session, stop the idle session like `assignment stop`, and the
// stall patrol releases such a session on its own (`turn_done`).

const system = { kind: "system" as const, project_id: human.project_id };
const { work_item_id: _work, ...opsFields } = assignment(10, "host_ops");
const ops: Assignment = { ...opsFields, scope: "standing" };
const caller = {
  ...actor(10, "host_ops"),
  allowed_tools: HOST_OPS_ROLE_TOOLS,
} as Extract<Actor, { kind: "assignment" }>;

function setup() {
  const s = fixture();
  const [first] = s.runs;
  const [owner] = s.assignments;
  if (!first || !owner) throw new Error("fixture");
  const ref: RuntimeRef = {
    machine_id: "local",
    runtime_machine: "fixture",
    terminal_ref: "t1",
    agent_name: "fixture",
    launch_generation: { run_id: first.id, generation: "g1" },
  };
  const ended = {
    ...first,
    status: "completed",
    outcome: "completed",
    started_at: "2030-01-01T00:00:00Z",
    finished_at: "2030-01-01T00:10:00Z",
  } as Run;
  const queued = {
    ...first,
    id: "R-9" as Run["id"],
    status: "queued",
    outcome: null,
    started_at: undefined,
    finished_at: undefined,
    queue_entered_at: "2030-01-01T00:20:00Z",
  } as unknown as Run;
  const state: CommandState = {
    ...s,
    roles: [
      ...s.roles,
      { ...role("host_ops"), allowed_tools: HOST_OPS_ROLE_TOOLS },
    ],
    assignments: [
      {
        ...owner,
        runtime_ref: ref,
        last_mcp_activity_at: "2030-01-01T00:10:00Z",
      },
      ops,
    ],
    runs: [ended, queued],
  };
  return { state, ref, ended, queued, owner: state.assignments[0]! };
}

const stop: UnresponsiveRelease = {
  trigger: "host_ops",
  requested_by: ops.id,
  tool: "host_ops_stop_assignment",
  reason: "idle session holds the emulator",
};

test("an untouched queued Run is cancelled directly; the live session, its ref and runtime state stay", () => {
  const { state, queued, owner, ref } = setup();
  expect(untouchedQueuedRun(queued)).toBe(true);
  expect(directlyCancellableRun(state, queued)).toBe(true);
  const effect = value(
    cancelQueuedHostOpsRun(
      state,
      caller,
      { run_id: queued.id, reason: "not needed any more" },
      ports(),
    ),
  );
  expect(effect.data).toMatchObject({
    assignment_id: owner.id,
    run_id: queued.id,
    result: "queued_run_cancelled",
  });
  // Only the Run changes: no Assignment (ref, runtime state) is written.
  expect(effect.changes.map((c) => c.collection)).toEqual(["runs"]);
  expect(effect.changes[0]?.entity).toMatchObject({
    id: queued.id,
    status: "cancelled",
    outcome: "failed",
  });
  expect(owner.runtime_ref).toEqual(ref);
  const audit = effect.events.find((e) => e.type === "host_ops_action_taken");
  expect(audit?.payload).toMatchObject({
    tool: "host_ops_cancel_run",
    target_id: queued.id,
    result: "queued_run_cancelled",
  });
  // An audit, not an execution intent: nothing stays pending.
  expect(hostOpsPending([...state.events, ...effect.events], owner.id)).toBe(
    false,
  );
  expect(effect.timeline[0]?.body).toContain("未触碰终端");
});

test("a started, dispatched, belled or stopping Run is never cancelled directly", () => {
  const { state, queued } = setup();
  const touched: Partial<Run>[] = [
    { status: "running", started_at: "2030-01-01T00:21:00Z" },
    { status: "dispatched" },
    { bell_delivery: { run_id: queued.id } },
    { recovery_runtime: state.assignments[0]!.runtime_ref! },
    {
      dispatch_stop: {
        attempt_id: "E-1",
        runtime_ref: null,
        lease_until: "2030-01-01T01:00:00Z",
        stopping: false,
        reason: "dispatch_timeout",
      },
    } as Partial<Run>,
  ];
  for (const patch of touched) {
    const run = { ...queued, ...patch } as Run;
    const next = { ...state, runs: [state.runs[0]!, run] };
    expect(directlyCancellableRun(next, run)).toBe(false);
    expect(
      cancelQueuedHostOpsRun(
        next,
        caller,
        { run_id: run.id, reason: "x" },
        ports(),
      ).ok,
    ).toBe(false);
  }
  // Only host_ops with the tool, and a reason.
  for (const who of [
    human,
    actor(1, "coder"),
    {
      ...caller,
      allowed_tools: HOST_OPS_ROLE_TOOLS.filter(
        (t) => t !== "host_ops_cancel_run",
      ),
    },
  ])
    expect(
      cancelQueuedHostOpsRun(
        state,
        who as Actor,
        { run_id: queued.id, reason: "x" },
        ports(),
      ).ok,
    ).toBe(false);
  expect(
    cancelQueuedHostOpsRun(
      state,
      caller,
      { run_id: queued.id, reason: " " },
      ports(),
    ).ok,
  ).toBe(false);
});

test("a host-ops stop needs an ended turn and keeps never-started queued work", () => {
  const { state, ref, queued, owner } = setup();
  expect(sessionTurnEnded(state, owner)).toBe(true);
  expect(unresponsiveReleaseBlocker(state, owner, stop)).toBeUndefined();
  const settled = value(
    releaseUnresponsiveSession(state, system, owner.id, ref, stop, ports()),
  );
  expect(settled.data).toMatchObject({ runtime_ref: null });
  // No Run is cancelled or queued: the waiting Run is started by dispatch.
  expect(settled.changes.filter((c) => c.collection === "runs")).toEqual([]);
  expect(settled.events.at(-1)).toMatchObject({
    type: "session_replaced",
    payload: {
      reason: "idle_session_stopped",
      trigger: "host_ops",
      tool: "host_ops_stop_assignment",
      requested_by: ops.id,
      cancelled_run_ids: [],
      old_runtime_ref: ref,
    },
  });
  expect(settled.timeline[0]?.body).toContain(
    `主机运维 ${ops.id} 请求停止空闲会话`,
  );
  expect(state.runs.find((r) => r.id === queued.id)?.status).toBe("queued");
});

test("a running Run, a session launched for the queued Run or a human stop keeps the session", () => {
  const { state, ref, queued, owner } = setup();
  const running = { ...queued, status: "running" } as Run;
  const stopped: Event = {
    id: "E-900" as Event["id"],
    seq: 900,
    card_id: state.cards[0]!.id,
    type: "assignment_stopped",
    actor: human,
    payload: { assignment_id: owner.id },
    created_at: "2030-01-01T00:30:00Z",
  };
  const launchedFor: Assignment = {
    ...owner,
    runtime_ref: {
      ...ref,
      launch_generation: { run_id: queued.id, generation: "g2" },
    },
  };
  const cases: [CommandState, Assignment, string][] = [
    [{ ...state, runs: [state.runs[0]!, running] }, owner, "run_busy"],
    [
      {
        ...state,
        runs: [state.runs[0]!, { ...queued, status: "dispatched" } as Run],
      },
      owner,
      "run_busy",
    ],
    [{ ...state, assignments: [launchedFor, ops] }, launchedFor, "run_busy"],
    [
      { ...state, events: [...state.events, stopped] },
      owner,
      "stopped_by_human",
    ],
  ];
  for (const [s, a, reason] of cases) {
    expect(unresponsiveReleaseBlocker(s, a, stop)).toBe(reason);
    expect(
      releaseUnresponsiveSession(s, system, a.id, a.runtime_ref!, stop, ports())
        .ok,
    ).toBe(false);
  }
  // The restart/cancel triggers keep their C-730 rules (no ended-turn need).
  expect(
    unresponsiveReleaseBlocker(
      { ...state, runs: [state.runs[0]!, running] },
      owner,
      { ...stop, tool: "host_ops_restart_assignment" },
    ),
  ).toBeUndefined();
});

test("turn_done: the patrol releases an ended turn's idle session for the queued Run it blocks", () => {
  const { state, ref, queued, owner } = setup();
  const request: UnresponsiveRelease = {
    trigger: "turn_done",
    queued_run_id: queued.id,
    waited_ms: 30 * 60_000,
    workspace: "clean",
  };
  expect(unresponsiveReleaseBlocker(state, owner, request)).toBeUndefined();
  const settled = value(
    releaseUnresponsiveSession(state, system, owner.id, ref, request, ports()),
  );
  expect(settled.data).toMatchObject({ runtime_ref: null });
  expect(settled.changes.filter((c) => c.collection === "runs")).toEqual([]);
  expect(settled.events.at(-1)).toMatchObject({
    type: "session_replaced",
    payload: {
      reason: "idle_session_stopped",
      trigger: "turn_done",
      queued_run_id: queued.id,
      waited_ms: 30 * 60_000,
      workspace: "clean",
      idle_basis: "terminal_status",
    },
  });
  expect(settled.timeline[0]?.body).toContain(
    `排队的 ${queued.id} 30 分钟仍未开始`,
  );
  // Another queued Run, a stopping retirement, a system-ended turn, a busy
  // Run or an invalid request keeps the session.
  const systemEnded: CommandState = {
    ...state,
    runs: [{ ...state.runs[0]!, outcome: "blocked" } as Run, queued],
    events: [
      ...state.events,
      {
        id: "E-901" as Event["id"],
        seq: 901,
        card_id: state.cards[0]!.id,
        type: "run_finished",
        actor: system,
        payload: { run_id: state.runs[0]!.id, finished_by: "system" },
        created_at: "2030-01-01T00:10:00Z",
      },
    ],
  };
  const cases: [CommandState, Assignment, UnresponsiveRelease, string][] = [
    [
      state,
      owner,
      { ...request, queued_run_id: "R-77" as Run["id"] },
      "run_changed",
    ],
    [
      state,
      {
        ...owner,
        idle_retirement: { phase: "stopping" },
      } as unknown as Assignment,
      request,
      "session_maintenance",
    ],
    [systemEnded, owner, request, "run_changed"],
    [
      {
        ...state,
        runs: [state.runs[0]!, { ...queued, status: "running" } as Run],
      },
      owner,
      request,
      "run_busy",
    ],
  ];
  for (const [s, a, r, reason] of cases)
    expect(unresponsiveReleaseBlocker(s, a, r)).toBe(reason);
  for (const bad of [
    { ...request, waited_ms: -1 },
    { ...request, workspace: "dirty" as never },
    { ...request, queued_run_id: "nope" as Run["id"] },
  ])
    expect(
      releaseUnresponsiveSession(state, system, owner.id, ref, bad, ports()).ok,
    ).toBe(false);
  expect(
    releaseUnresponsiveSession(state, actor(), owner.id, ref, request, ports())
      .ok,
  ).toBe(false);
  expect(id("run", 9)).toBe(queued.id);
});
