import { expect, test } from "vitest";
import type { Assignment, Event, Run } from "../entities.js";
import { hostOpsPending, pendingHostOpsActions } from "../host-ops.js";
import type { Notification } from "../notification.js";
import type { CommandState } from "./core.js";
import { beginHostOpsAction, finishHostOpsAction } from "./host-ops-actions.js";
import { notices } from "./notices.js";
import {
  beginStandingPmStallRestart,
  DEFAULT_STANDING_PM_STALL_POLICY,
  deliverStandingPmStallHandoff,
  escalateStandingPmStall,
  planStandingPmStall,
  recordStandingPmStallRedelivery,
  STANDING_PM_STALL_EVENTS,
  waitingStandingPmStallHandoffs,
} from "./standing-pm-stall.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  ports,
  role,
  value,
} from "./test-fixtures.js";

const system = { kind: "system", project_id: human.project_id } as const;
const snapshot = { model: "fixture", agent_cli_version: "fixture" };
const MIN = 60_000;
const t0 = Date.parse("2026-11-22T15:53:20.000Z");
const at = (ms: number) => new Date(t0 + ms).toISOString();
const ref = {
  machine_id: "local",
  runtime_machine: "local",
  terminal_ref: "pm-ops",
  agent_name: "pm",
};

/** A-31 replay: R-388 ended by the system at t0, a delivery notice at +43 min. */
function setup() {
  let time = 0;
  const io = { ...ports(), clock: { now: () => at(time) } };
  const s = fixture();
  const pm = s.assignments.find((a) => a.scope === "standing") as Assignment;
  const owner = {
    ...pm,
    standing_mode: "ops",
    runtime_state: "idle",
    runtime_ref: ref,
    session_ref: "old-session",
  } as Assignment;
  const ended: Run = {
    id: id("run", 388),
    assignment_id: owner.id,
    trigger_event_id: (s.runs[0] as Run).trigger_event_id,
    kind: "followup",
    status: "completed",
    role_version: 1,
    model: "fixture",
    agent_cli_version: "fixture",
    outcome: "blocked",
    summary: "system ended",
    started_at: at(-10 * MIN),
    finished_at: at(0),
  };
  let state: CommandState = {
    ...s,
    assignments: s.assignments.map((a) => (a.id === owner.id ? owner : a)),
    runs: [...s.runs, ended],
  };
  const note = (n: number, minutes: number, over: Partial<Notification> = {}) =>
    ({
      id: `n-${n}`,
      project_id: human.project_id,
      event_id: `${"0".repeat(24)}${String(n).padStart(2, "0")}`,
      recipient: { kind: "pm_ops" },
      card_id: id("card", 1),
      seq: n,
      kind: "assignment",
      status: "pending",
      attempts: 0,
      created_at: at(minutes * MIN),
      updated_at: at(minutes * MIN),
      ...over,
    }) as Notification;
  return {
    io,
    owner,
    ended,
    note,
    get state() {
      return state;
    },
    set state(v) {
      state = v;
    },
    set time(v: number) {
      time = v;
    },
    get time() {
      return time;
    },
    plan: (notes: readonly Notification[]) =>
      planStandingPmStall(state, current(state, owner), notes, at(time)),
  };
}
const current = (s: CommandState, a: Assignment) =>
  s.assignments.find((v) => v.id === a.id) as Assignment;

test("alive/unknown after a system-ended turn: threshold, redelivery, restart, then single executor", () => {
  const f = setup();
  const notes = [f.note(1, 43), f.note(2, 47)];
  // Before the threshold: nothing, however old the ended Run is.
  f.time = 57 * MIN;
  expect(f.plan(notes)).toBeUndefined();
  f.time = 58 * MIN;
  expect(f.plan(notes)).toMatchObject({
    stage: "redeliver",
    notification_ids: ["n-1", "n-2"],
    since: at(43 * MIN),
    card_id: id("card", 1),
  });
  const params = { assignment_id: f.owner.id, notes };
  // Agent tokens and the human cannot drive system recovery.
  expect(
    recordStandingPmStallRedelivery(f.state, actor(4, "pm"), params, f.io).ok,
  ).toBe(false);
  expect(recordStandingPmStallRedelivery(f.state, human, params, f.io).ok).toBe(
    false,
  );
  const redelivered = value(
    recordStandingPmStallRedelivery(f.state, system, params, f.io),
  );
  f.state = apply(f.state, redelivered);
  expect(redelivered.events[0]).toMatchObject({
    type: STANDING_PM_STALL_EVENTS.redeliver,
    card_id: id("card", 1),
    payload: { assignment_id: f.owner.id, notification_ids: ["n-1", "n-2"] },
  });
  expect(redelivered.timeline).toHaveLength(1);
  // The same stage cannot be recorded twice; restart waits for the grace.
  expect(
    recordStandingPmStallRedelivery(f.state, system, params, f.io).ok,
  ).toBe(false);
  f.time = 62 * MIN;
  expect(f.plan(notes)).toBeUndefined();
  f.time = 63 * MIN;
  expect(f.plan(notes)).toMatchObject({
    stage: "restart",
    episode_id: redelivered.events[0]?.id,
  });
  expect(escalateStandingPmStall(f.state, system, params, f.io).ok).toBe(false);
  const restart = value(
    beginStandingPmStallRestart(f.state, system, { ...params, snapshot }, f.io),
  );
  f.state = apply(f.state, restart);
  const action = pendingHostOpsActions(f.state.events).find(
    (a) => a.action_id === restart.data.action_id,
  );
  expect(action).toMatchObject({
    tool: "host_ops_restart_standing_pm",
    assignment_id: f.owner.id,
    runtime_ref: ref,
  });
  expect(action).not.toHaveProperty("dispatch_stall_id");
  expect(restart.events.map((e) => e.type)).toEqual([
    "host_ops_action_taken",
    STANDING_PM_STALL_EVENTS.restart,
  ]);
  // One executor: no second restart, and the planner waits on the fence.
  expect(hostOpsPending(f.state.events, f.owner.id)).toBe(true);
  expect(
    beginStandingPmStallRestart(f.state, system, { ...params, snapshot }, f.io)
      .ok,
  ).toBe(false);
  expect(f.plan(notes)).toBeUndefined();
  // Settlement after the proved exit queues a fresh session; nothing moves.
  const before = JSON.stringify([f.state.decisions, f.state.human_actions]);
  const settled = value(
    finishHostOpsAction(f.state, system, restart.data.action_id, f.io),
  );
  f.state = apply(f.state, settled);
  expect(settled.data.run).toMatchObject({
    assignment_id: f.owner.id,
    status: "queued",
  });
  expect(current(f.state, f.owner)).toMatchObject({
    runtime_ref: null,
    status: "active",
  });
  expect(current(f.state, f.owner)).not.toHaveProperty("session_ref");
  expect(JSON.stringify([f.state.decisions, f.state.human_actions])).toBe(
    before,
  );
  // Human is informed in Needs You; the redelivery stays on the timeline only.
  expect(notices(f.state)).toMatchObject([
    {
      option: "常驻 PM 停滞，已自动重开会话",
      resolved_by: "system",
      card_id: id("card", 1),
      body: expect.stringContaining("等同 pm restart"),
    },
  ]);
});

test("restart that never confirms exit escalates to host operations once", () => {
  const f = setup();
  const notes = [f.note(1, 0)];
  const params = { assignment_id: f.owner.id, notes };
  f.time = 15 * MIN;
  f.state = apply(
    f.state,
    value(recordStandingPmStallRedelivery(f.state, system, params, f.io)),
  );
  f.time = 20 * MIN;
  f.state = apply(
    f.state,
    value(
      beginStandingPmStallRestart(
        f.state,
        system,
        { ...params, snapshot },
        f.io,
      ),
    ),
  );
  f.time = 24 * MIN;
  expect(f.plan(notes)).toBeUndefined();
  f.time = 25 * MIN;
  expect(f.plan(notes)).toMatchObject({
    stage: "escalate",
    reason: "restart_unconfirmed",
  });
  const escalated = value(
    escalateStandingPmStall(f.state, system, params, f.io),
  );
  f.state = apply(f.state, escalated);
  expect(escalated.events[0]?.payload).toMatchObject({
    reason: "restart_unconfirmed",
    notice: expect.stringContaining("主机运维"),
  });
  expect(f.plan(notes)).toBeUndefined();
  // No human action is created by any stage.
  expect(f.state.human_actions).toEqual([]);
});

test("repeated stalls: two restarts per window, then escalation instead of a third", () => {
  const f = setup();
  const notes = [f.note(1, 0)];
  const params = { assignment_id: f.owner.id, notes };
  const cycle = () => {
    f.state = apply(
      f.state,
      value(recordStandingPmStallRedelivery(f.state, system, params, f.io)),
    );
    f.time += DEFAULT_STANDING_PM_STALL_POLICY.grace_ms;
    const plan = f.plan(notes);
    if (plan?.stage !== "restart") return plan;
    const begun = value(
      beginStandingPmStallRestart(
        f.state,
        system,
        { ...params, snapshot },
        f.io,
      ),
    );
    f.state = apply(f.state, begun);
    // Exit proved, successor queued, but the new session never starts.
    f.state = apply(
      f.state,
      value(finishHostOpsAction(f.state, system, begun.data.action_id, f.io)),
    );
    f.time += DEFAULT_STANDING_PM_STALL_POLICY.threshold_ms;
    return plan;
  };
  f.time = 15 * MIN;
  expect(cycle()?.stage).toBe("restart");
  expect(f.plan(notes)?.stage).toBe("redeliver");
  expect(cycle()?.stage).toBe("restart");
  const third = cycle();
  expect(third).toMatchObject({ stage: "escalate", reason: "repeated" });
  f.state = apply(
    f.state,
    value(escalateStandingPmStall(f.state, system, params, f.io)),
  );
  // Held until the window passes, then a fresh episode may try again.
  f.time += DEFAULT_STANDING_PM_STALL_POLICY.window_ms - 1;
  expect(f.plan(notes)).toBeUndefined();
  f.time += 1;
  expect(f.plan(notes)?.stage).toBe("redeliver");
  expect(
    notices(f.state)
      .map((n) => n.option)
      .filter((q) => q.includes("升级主机运维")),
  ).toHaveLength(1);
});

test("a started Run closes the episode; execution, human stop, ACK, hold and maintenance are respected", () => {
  const f = setup();
  const notes = [f.note(1, 0)];
  f.time = 15 * MIN;
  const base = f.state;
  const runs = (status: Run["status"]): CommandState => ({
    ...base,
    runs: [
      ...base.runs,
      { ...f.ended, id: id("run", 389), status, started_at: at(14 * MIN) },
    ],
  });
  for (const status of ["dispatched", "acked", "running", "unknown"] as const) {
    f.state = runs(status);
    expect(f.plan(notes)).toBeUndefined();
  }
  // A Run that started and finished after the notice moves the clock.
  f.state = {
    ...runs("completed"),
    runs: runs("completed").runs.map((r) =>
      r.id === id("run", 389) ? { ...r, finished_at: at(14 * MIN) } : r,
    ),
  };
  expect(f.plan(notes)).toBeUndefined();
  f.state = {
    ...base,
    cursors: [
      { assignment_id: f.owner.id, card_id: id("card", 1), acked_seq: 1 },
    ],
  };
  expect(f.plan(notes)).toBeUndefined();
  f.state = {
    ...base,
    cards: base.cards.map((c) =>
      c.id === id("card", 1)
        ? {
            ...c,
            hold: {
              set_by: "system",
              reason: "paused",
              resume_condition: "fixture",
              set_at: at(0),
            },
          }
        : c,
    ),
  };
  expect(f.plan(notes)).toBeUndefined();
  const stop: Event = {
    id: f.io.ids.nextEventId(),
    actor: human,
    seq: 1,
    type: "assignment_stopped",
    created_at: at(1),
    payload: { assignment_id: f.owner.id },
  };
  f.state = { ...base, events: [stop] };
  expect(f.plan(notes)).toBeUndefined();
  f.state = {
    ...base,
    assignments: base.assignments.map((a) =>
      a.id === f.owner.id ? { ...a, external: true } : a,
    ),
  };
  expect(f.plan(notes)).toBeUndefined();
  expect(f.plan([f.note(1, 0, { status: "belled" })])).toBeUndefined();
  // Maintenance owns the session: escalate rather than restart.
  f.state = {
    ...base,
    assignments: base.assignments.map((a) =>
      a.id === f.owner.id
        ? ({
            ...a,
            idle_retirement: {
              phase: "waiting",
              runtime_ref: ref,
              started_at: at(0),
              threshold_minutes: 60,
            },
          } as Assignment)
        : a,
    ),
  };
  const params = { assignment_id: f.owner.id, notes };
  f.state = apply(
    f.state,
    value(recordStandingPmStallRedelivery(f.state, system, params, f.io)),
  );
  f.time += DEFAULT_STANDING_PM_STALL_POLICY.grace_ms;
  expect(f.plan(notes)).toMatchObject({
    stage: "escalate",
    reason: "session_maintenance",
  });
  expect(
    beginStandingPmStallRestart(f.state, system, { ...params, snapshot }, f.io)
      .ok,
  ).toBe(false);
  // A new Run that actually starts ends the episode.
  f.state = {
    ...base,
    events: f.state.events,
    timeline: f.state.timeline,
    runs: [
      ...base.runs,
      {
        ...f.ended,
        id: id("run", 390),
        started_at: at(f.time + 1),
        finished_at: at(f.time + 2),
      },
    ],
  };
  f.time += DEFAULT_STANDING_PM_STALL_POLICY.threshold_ms;
  expect(f.plan(notes)).toBeUndefined();
  f.time += 2;
  expect(f.plan(notes)?.stage).toBe("redeliver");
});

test("an older operation holding the fence is escalated after the grace, never restarted beside", () => {
  const f = setup();
  const notes = [f.note(1, 0)];
  // A system-turn recovery (or operator restart) took the fence at +16 min.
  f.time = 16 * MIN;
  f.state = apply(f.state, operatorRestart(f.state, f.owner, f.io));
  f.time = 20 * MIN;
  expect(f.plan(notes)).toBeUndefined();
  f.time = 21 * MIN;
  const plan = f.plan(notes);
  expect(plan).toMatchObject({
    stage: "escalate",
    reason: "restart_unconfirmed",
  });
  expect(plan).not.toHaveProperty("episode_id");
  const params = { assignment_id: f.owner.id, notes };
  expect(
    beginStandingPmStallRestart(f.state, system, { ...params, snapshot }, f.io)
      .ok,
  ).toBe(false);
  f.state = apply(
    f.state,
    value(escalateStandingPmStall(f.state, system, params, f.io)),
  );
  // Once per window while the same operation still holds the fence.
  f.time += DEFAULT_STANDING_PM_STALL_POLICY.window_ms - 1;
  expect(f.plan(notes)).toBeUndefined();
  f.time += 1;
  expect(f.plan(notes)?.stage).toBe("escalate");
});

test("foreign runtime, an overdue restart and missing host_ops escalate without a human", () => {
  const f = setup();
  const notes = [f.note(1, 0)];
  const params = { assignment_id: f.owner.id, notes };
  f.time = 15 * MIN;
  f.state = apply(
    f.state,
    value(recordStandingPmStallRedelivery(f.state, system, params, f.io)),
  );
  f.time = 20 * MIN;
  const foreign = { foreign_runtime: true };
  expect(
    planStandingPmStall(
      f.state,
      f.owner,
      notes,
      at(f.time),
      undefined,
      foreign,
    ),
  ).toMatchObject({ stage: "escalate", reason: "not_local" });
  expect(
    beginStandingPmStallRestart(
      f.state,
      system,
      { ...params, snapshot, context: foreign },
      f.io,
    ).ok,
  ).toBe(false);
  // A late patrol is not a failure: the due restart is attempted first.
  f.time = 60 * MIN;
  const due = f.plan(notes);
  expect(due?.stage).toBe("restart");
  // Only an actual failure to begin it counts, for one grace from the first.
  const failed = {
    restart_failed: { episode_id: due?.episode_id ?? "", since: at(60 * MIN) },
  };
  const plan = (context: object) =>
    planStandingPmStall(
      f.state,
      f.owner,
      notes,
      at(f.time),
      undefined,
      context,
    );
  f.time = 65 * MIN - 1;
  expect(plan(failed)?.stage).toBe("restart");
  f.time = 65 * MIN;
  expect(plan(failed)).toMatchObject({
    stage: "escalate",
    reason: "restart_unavailable",
  });
  // A failure recorded for another episode does not carry over.
  expect(
    plan({ restart_failed: { ...failed.restart_failed, episode_id: "E-x" } })
      ?.stage,
  ).toBe("restart");
  // A recipient must be this project's active host_ops, not the PM itself.
  expect(
    escalateStandingPmStall(
      f.state,
      system,
      { ...params, context: failed, host_ops_id: f.owner.id },
      f.io,
    ).ok,
  ).toBe(false);
  const waiting = value(
    escalateStandingPmStall(
      f.state,
      system,
      { ...params, context: failed },
      f.io,
    ),
  );
  f.state = apply(f.state, waiting);
  expect(waiting.data.event.payload).toMatchObject({
    handoff: "waiting_host_ops",
    notice: expect.stringContaining("暂无在岗主机运维"),
  });
  expect(waitingStandingPmStallHandoffs(f.state).map((e) => e.id)).toEqual([
    waiting.data.event.id,
  ]);
  // A host_ops coming on duty takes it over exactly once.
  const ops = {
    ...f.owner,
    id: id("assignment", 9),
    role_id: "host_ops",
    standing_mode: undefined,
  } as unknown as Assignment;
  f.state = { ...f.state, assignments: [...f.state.assignments, ops] };
  const handoff = {
    escalation_id: waiting.data.event.id,
    host_ops_id: ops.id,
  };
  expect(deliverStandingPmStallHandoff(f.state, human, handoff, f.io).ok).toBe(
    false,
  );
  f.state = apply(
    f.state,
    value(deliverStandingPmStallHandoff(f.state, system, handoff, f.io)),
  );
  expect(waitingStandingPmStallHandoffs(f.state)).toEqual([]);
  expect(deliverStandingPmStallHandoff(f.state, system, handoff, f.io).ok).toBe(
    false,
  );
  expect(f.state.human_actions).toEqual([]);
});

/** Stand-in for an older turn recovery or operator restart on the same PM. */
function operatorRestart(
  state: CommandState,
  owner: Assignment,
  io: ReturnType<typeof ports>,
) {
  const ops = {
    ...owner,
    id: id("assignment", 10),
    role_id: "host_ops",
    standing_mode: undefined,
    runtime_ref: null,
  } as unknown as Assignment;
  const withOps: CommandState = {
    ...state,
    assignments: [...state.assignments, ops],
    roles: [...state.roles, role("host_ops")],
  };
  const effect = value(
    beginHostOpsAction(
      withOps,
      actor(10, "host_ops"),
      {
        tool: "host_ops_restart_standing_pm",
        target_id: owner.id,
        reason: "operator",
        snapshot,
      },
      io,
    ),
  );
  return { ...effect, changes: [] };
}

test("the automatic restart intent carries its source; operators cannot set it", () => {
  const f = setup();
  const ops = {
    ...f.owner,
    id: id("assignment", 10),
    role_id: "host_ops",
    standing_mode: undefined,
    runtime_ref: null,
  } as unknown as Assignment;
  const withOps: CommandState = {
    ...f.state,
    assignments: [...f.state.assignments, ops],
    roles: [...f.state.roles, role("host_ops")],
  };
  const forged = beginHostOpsAction(
    withOps,
    actor(10, "host_ops"),
    {
      tool: "host_ops_restart_standing_pm",
      target_id: f.owner.id,
      reason: "operator",
      snapshot,
      standing_pm_stall: true,
    },
    f.io,
  );
  expect(forged.ok).toBe(false);
  const notes = [f.note(1, 0)];
  const params = { assignment_id: f.owner.id, notes };
  f.time = 15 * MIN;
  f.state = apply(
    f.state,
    value(recordStandingPmStallRedelivery(f.state, system, params, f.io)),
  );
  f.time = 20 * MIN;
  const begun = value(
    beginStandingPmStallRestart(f.state, system, { ...params, snapshot }, f.io),
  );
  f.state = apply(f.state, begun);
  expect(
    pendingHostOpsActions(f.state.events).find(
      (x) => x.action_id === begun.data.action_id,
    ),
  ).toMatchObject({
    tool: "host_ops_restart_standing_pm",
    standing_pm_stall: true,
  });
});
