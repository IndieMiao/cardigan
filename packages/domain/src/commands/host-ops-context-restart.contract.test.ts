import { expect, test } from "vitest";
import type { ContextObservation } from "../context-usage.js";
import type { Assignment, Event } from "../entities.js";
import {
  HOST_OPS_ROLE_TOOLS,
  hostOpsPending,
  pendingHostOpsActions,
} from "../host-ops.js";
import { recordContextUsageNotices } from "./context-usage.js";
import { completeHumanAction } from "./coordination.js";
import type { CommandState } from "./core.js";
import {
  beginHostOpsAction,
  finishHostOpsAction,
  untouchedStallSuccessor,
  withdrawUnstartedStallRestart,
} from "./host-ops-actions.js";
import {
  automaticContextRestartReady,
  beginAutomaticContextRestart,
  beginStalledPatrolRestart,
  beginSystemTurnRestart,
  nudgeStalledPatrol,
  patrolNudges,
  recordAutomaticContextRestartResult,
  systemTurnOwner,
} from "./host-ops-context-restart.js";
import { acknowledgeRun, dispatchRun, queueRun } from "./launch.js";
import { setProjectPreferences } from "./preferences.js";
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
  run,
  value,
} from "./test-fixtures.js";

const system = { kind: "system", project_id: human.project_id } as const;
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture");
  return value;
}
const snapshot = { model: "fixture", agent_cli_version: "fixture" };
const ref = {
  machine_id: "local",
  runtime_machine: "local",
  terminal_ref: "fixture",
  agent_name: "fixture",
  agent_session_id: "current",
};
function setup() {
  const io = ports();
  const { work_item_id: _work, ...fields } = assignment(10, "host_ops");
  const ops: Assignment = {
    ...fields,
    scope: "standing",
    runtime_ref: ref,
    session_ref: "current",
  };
  const s = fixture();
  let state: CommandState = {
    ...s,
    assignments: [...s.assignments, ops],
    roles: [
      ...s.roles,
      { ...role("host_ops"), allowed_tools: HOST_OPS_ROLE_TOOLS },
    ],
  };
  const usage: ContextObservation = {
    assignment_id: ops.id,
    agent: "pi",
    session_id: "current",
    runtime_key: JSON.stringify(ref),
    cwd: "/fixture",
    transcript_path: null,
    model: "fixture",
    context_tokens: 850,
    context_window_size: 1000,
    used_percentage: 85,
    updated_at: now,
    source: "fixture",
  };
  const notice = () =>
    recordContextUsageNotices(state, system, usage, 60_000, io);
  const handoff = value(notice());
  state = apply(state, handoff);
  const restart = value(notice());
  state = apply(state, restart);
  const begin = () =>
    beginAutomaticContextRestart(
      state,
      system,
      { usage, stale_after_ms: 60_000, snapshot },
      io,
    );
  return {
    get state() {
      return state;
    },
    set state(s) {
      state = s;
    },
    ops,
    io,
    usage,
    handoff,
    restart,
    begin,
  };
}

test("system records one idle self-restart, retains handoff notices and fences new Runs and operator actions", () => {
  const f = setup();
  expect(f.handoff.data[0]).toMatchObject({
    recipient: f.ops.id,
    notify_pm_ops: true,
  });
  expect(f.restart.data[0]).toMatchObject({
    recipient: f.ops.id,
    notify_pm_ops: true,
  });
  const effect = value(f.begin());
  expect(effect.data).toBeDefined();
  expect(effect.events[0]).toMatchObject({
    type: "host_ops_action_taken",
    actor: system,
    payload: { automatic_context_restart: true, context_usage: f.usage },
  });
  f.state = apply(f.state, effect);
  expect(value(f.begin()).events).toHaveLength(0);
  expect(
    queueRun(f.state, system, { assignment_id: f.ops.id, ...snapshot }, f.io)
      .ok,
  ).toBe(false);
  expect(
    beginHostOpsAction(
      f.state,
      actor(10, "host_ops"),
      {
        tool: "host_ops_restart_assignment",
        target_id: id("assignment", 1),
        reason: "late operation",
        snapshot,
      },
      f.io,
    ).ok,
  ).toBe(false);
});

test.each(["queued", "dispatched", "running", "unknown"] as const)(
  "waits for a %s Run without consuming the attempt",
  (status) => {
    const f = setup();
    const busy = {
      ...required(f.state.runs[0]),
      id: id("run", 90),
      assignment_id: f.ops.id,
      status,
    };
    f.state = { ...f.state, runs: [...f.state.runs, busy] };
    expect(value(f.begin()).events).toHaveLength(0);
    f.state = {
      ...f.state,
      runs: f.state.runs.filter((r) => r.id !== busy.id),
    };
    expect(value(f.begin()).data).toBeDefined();
  },
);

test("waits for an operation the host operator is still handling on another Assignment", () => {
  const f = setup();
  const other = value(
    beginHostOpsAction(
      f.state,
      actor(10, "host_ops"),
      {
        tool: "host_ops_restart_assignment",
        target_id: id("assignment", 1),
        reason: "recover",
        snapshot,
      },
      f.io,
    ),
  );
  f.state = apply(f.state, other);
  expect(value(f.begin()).events).toHaveLength(0);
  f.state = apply(
    f.state,
    value(finishHostOpsAction(f.state, system, other.data.action_id, f.io)),
  );
  expect(value(f.begin()).data).toBeDefined();
});

test("current session, full reference, sample freshness, role, scope and human thresholds are mandatory", () => {
  const f = setup();
  for (const usage of [
    { ...f.usage, session_id: "old" },
    {
      ...f.usage,
      runtime_key: JSON.stringify({ ...ref, runtime_machine: "other" }),
    },
    { ...f.usage, updated_at: "2000-01-01T00:00:00.000Z" },
    { ...f.usage, updated_at: "2099-01-01T00:00:00.000Z" },
    { ...f.usage, assignment_id: id("assignment", 999) },
    { ...f.usage, used_percentage: 84.9, context_tokens: 849 },
  ])
    expect(automaticContextRestartReady(f.state, usage, now, 60_000)).toBe(
      false,
    );
  for (const patch of [
    { status: "released" as const },
    { external: true },
    { role_id: "coder" },
    { runtime_ref: null },
  ]) {
    const state = {
      ...f.state,
      assignments: f.state.assignments.map((a) =>
        a.id === f.ops.id ? { ...a, ...patch } : a,
      ),
    };
    expect(automaticContextRestartReady(state, f.usage, now, 60_000)).toBe(
      false,
    );
  }
  f.state = apply(
    f.state,
    value(
      setProjectPreferences(
        f.state,
        human,
        { context_restart_remaining_pct: 10 },
        f.io,
      ),
    ),
  );
  expect(value(f.begin()).events).toHaveLength(0);
  expect(
    beginAutomaticContextRestart(
      f.state,
      actor(10, "host_ops"),
      { usage: f.usage, stale_after_ms: 60000, snapshot },
      f.io,
    ).ok,
  ).toBe(false);
  expect(
    beginAutomaticContextRestart(
      f.state,
      { ...system, project_id: "other" },
      { usage: f.usage, stale_after_ms: 60000, snapshot },
      f.io,
    ).ok,
  ).toBe(false);
});

test("failure persists once, blocks dispatch after reload, and only actual human completion releases the fence", () => {
  const f = setup();
  const begun = value(f.begin());
  f.state = apply(f.state, begun);
  const action_id = required(begun.data).action_id;
  const fail = () =>
    recordAutomaticContextRestartResult(
      f.state,
      system,
      { action_id, result: "failed", reason: "exit unknown" },
      f.io,
    );
  f.state = apply(f.state, value(fail()));
  f.state = JSON.parse(JSON.stringify(f.state));
  expect(pendingHostOpsActions(f.state.events)).toHaveLength(0);
  expect(hostOpsPending(f.state.events, f.ops.id)).toBe(true);
  expect(value(fail()).events).toHaveLength(0);
  expect(value(f.begin()).events).toHaveLength(0);
  const request = required(f.state.human_actions.at(-1));
  expect(request).toMatchObject({
    triage: "human",
    status: "open",
    instructions: expect.stringContaining("current"),
  });
  const fake: Event = {
    ...required(f.state.events.at(-1)),
    type: "human_action_completed",
    actor: actor(4, "pm"),
    payload: { human_action_id: request.id },
  };
  expect(hostOpsPending([...f.state.events, fake], f.ops.id)).toBe(true);
  const complete = () =>
    completeHumanAction(
      f.state,
      human,
      {
        human_action_id: request.id,
        text: "Confirmed exact terminal exited",
      },
      f.io,
    );
  // C-741: marking it done alone does not close it while the old session stays.
  expect(complete()).toMatchObject({
    ok: false,
    error: {
      code: "illegal_transition",
      message: expect.stringContaining("cardigan host-ops restart"),
    },
  });
  f.state = {
    ...f.state,
    assignments: f.state.assignments.map((a) =>
      a.id === f.ops.id
        ? { ...a, runtime_ref: { ...ref, terminal_ref: "replacement" } }
        : a,
    ),
  };
  f.state = apply(f.state, value(complete()));
  expect(hostOpsPending(f.state.events, f.ops.id)).toBe(false);
  expect(value(f.begin()).events).toHaveLength(0);
});

test("new-session queue is not success; dispatch records replacement, actual start wins over late failure", () => {
  const f = setup();
  const begun = value(f.begin());
  f.state = apply(f.state, begun);
  const action_id = required(begun.data).action_id;
  const finished = value(finishHostOpsAction(f.state, system, action_id, f.io));
  f.state = apply(f.state, finished);
  const result = (outcome: "failed" | "succeeded") =>
    recordAutomaticContextRestartResult(
      f.state,
      system,
      { action_id, result: outcome, reason: "fixture" },
      f.io,
    );
  expect(value(result("succeeded")).events).toHaveLength(0);
  expect(f.state.assignments.find((a) => a.id === f.ops.id)).toMatchObject({
    id: f.ops.id,
    runtime_ref: null,
  });
  expect(
    f.state.assignments.find((a) => a.id === f.ops.id)?.session_ref,
  ).toBeUndefined();
  const run = required(finished.data.run);
  const dispatched = value(
    dispatchRun(
      f.state,
      system,
      {
        run_id: run.id,
        runtime_ref: { ...ref, terminal_ref: "new", agent_session_id: "new" },
      },
      f.io,
    ),
  );
  expect(dispatched.events).toContainEqual(
    expect.objectContaining({
      type: "session_replaced",
      payload: expect.objectContaining({
        old_runtime_ref: ref,
        reason: "context_usage",
      }),
    }),
  );
  f.state = apply(f.state, dispatched);
  f.state = apply(
    f.state,
    value(
      acknowledgeRun(f.state, actor(10, "host_ops"), { run_id: run.id }, f.io),
    ),
  );
  const success = value(result("failed"));
  expect(success.events.at(-1)).toMatchObject({
    type: "context_session_restart_result",
    payload: { result: "succeeded" },
  });
  expect(success.changes.some((c) => c.collection === "human_actions")).toBe(
    false,
  );
});

test("system turn recovery binds the ended Run, target and expiry; uncertain exit keeps the intent and never creates a HumanAction", () => {
  const f = setup(),
    a = required(f.state.assignments[0]),
    prior = required(f.state.runs[0]);
  const finish: Event = {
    id: f.io.ids.nextEventId(),
    actor: actor(1, "coder"),
    seq: 1,
    type: "run_finished",
    created_at: now,
    payload: { finished_by: "system", run_id: prior.id },
  };
  const due: Event = {
    ...finish,
    id: f.io.ids.nextEventId(),
    actor: system,
    seq: 2,
    type: "bell_turn_recovery_due",
    payload: { run_id: prior.id, assignment_id: a.id },
  };
  const state: CommandState = {
    ...f.state,
    assignments: f.state.assignments.map((v) =>
      v.id === a.id
        ? {
            ...v,
            runtime_ref: {
              ...ref,
              terminal_ref: "target",
              agent_name: "target",
            },
          }
        : v,
    ),
    runs: f.state.runs.map((r) =>
      r.id === prior.id
        ? {
            ...r,
            status: "completed",
            outcome: "blocked",
            started_at: now,
            finished_at: now,
          }
        : r,
    ),
    events: [finish, due],
  };
  const begin = (
    s: CommandState,
    who: Parameters<typeof beginSystemTurnRestart>[1] = system,
  ) =>
    beginSystemTurnRestart(
      s,
      who,
      { assignment_id: a.id, cause_id: due.id, snapshot },
      f.io,
    );
  expect(begin(state, human).ok).toBe(false);
  expect(begin({ ...state, events: [due] }).ok).toBe(false);
  expect(
    begin({ ...state, events: [finish, { ...due, actor: human }] }).ok,
  ).toBe(false);
  expect(
    begin({
      ...state,
      runs: [...state.runs, { ...prior, id: id("run", 99), status: "queued" }],
    }).ok,
  ).toBe(false);
  const started = value(begin(state));
  const pending = apply(state, started);
  // A proven pre-signal refusal frees the assignment; a durable signal fence
  // is never cleared by the same withdrawal, even after a service restart.
  const withdraw = (s: CommandState) =>
    value(
      withdrawUnstartedStallRestart(
        s,
        system,
        started.data.action_id,
        f.io,
        "terminal_busy",
      ),
    );
  expect(
    pendingHostOpsActions(apply(pending, withdraw(pending)).events),
  ).toHaveLength(0);
  // The withdrawal reports whether this attempt wrote its writer receipt;
  // omitted when the caller cannot say (later receipts then cannot stand).
  expect(withdraw(pending).events[0]?.payload).not.toHaveProperty(
    "backup_recorded",
  );
  for (const recorded of [false, true])
    expect(
      value(
        withdrawUnstartedStallRestart(
          pending,
          system,
          started.data.action_id,
          f.io,
          "workspace_backup_unconfirmed",
          recorded,
        ),
      ).events[0]?.payload,
    ).toMatchObject({
      result: "withdrawn_stall_changed",
      backup_recorded: recorded,
    });
  // A pre-signal withdrawal leaves the incident to Ops, never to a second
  // automatic attempt; a signalled or in-flight attempt still consumes it.
  const withdrawn = apply(pending, withdraw(pending));
  const takeover = (s: CommandState) =>
    beginHostOpsAction(
      s,
      actor(10, "host_ops"),
      {
        tool: "host_ops_restart_assignment",
        target_id: a.id,
        reason: "evidence recovered",
        dispatch_stall_id: due.id,
        snapshot,
      },
      f.io,
    );
  expect(begin(withdrawn).ok).toBe(false);
  expect(takeover(pending).ok).toBe(false);
  expect(value(takeover(withdrawn)).events).toMatchObject([
    {
      type: "host_ops_action_taken",
      payload: { assignment_id: a.id, dispatch_stall_id: due.id },
    },
  ]);
  const stopping: CommandState = {
    ...pending,
    events: [
      ...pending.events,
      {
        ...due,
        id: f.io.ids.nextEventId(),
        type: "host_ops_action_deferred",
        payload: {
          action_id: started.data.action_id,
          reason: "automatic_context_stop_started",
        },
      },
    ],
  };
  expect(withdraw(stopping).events).toEqual([]);
  const result = value(
    recordAutomaticContextRestartResult(
      pending,
      system,
      {
        action_id: started.data.action_id,
        result: "failed",
        reason: "terminal_exit_unconfirmed",
      },
      f.io,
    ),
  );
  expect(result.events).toMatchObject([
    { type: "host_ops_action_deferred", payload: { notify_pm: true } },
  ]);
  expect(result.changes).toEqual([]);
  expect(pendingHostOpsActions(apply(pending, result).events)).toHaveLength(1);
  expect(begin(apply(pending, result)).ok).toBe(false);
  expect(takeover(apply(pending, result)).ok).toBe(false);
  const stopped = value(
    finishHostOpsAction(pending, system, started.data.action_id, f.io, {
      cause_id: due.id,
      card_id: null,
    }),
  );
  const preserved = apply(pending, stopped);
  // A settled recovery whose successor launch refused the preserved checkout
  // is left to Ops on the same incident; the system never retries it.
  const refused: CommandState = {
    ...preserved,
    events: [
      ...preserved.events,
      {
        ...due,
        id: f.io.ids.nextEventId(),
        seq: 99,
        type: "retained_writer_refused",
        payload: {
          assignment_id: a.id,
          run_id: required(stopped.data.run).id,
          action_id: started.data.action_id,
          system_finished_run_id: prior.id,
        },
      },
    ],
  };
  expect(takeover(preserved).ok).toBe(false);
  expect(begin(refused).ok).toBe(false);
  expect(takeover(refused).ok).toBe(true);
  const successor = required(stopped.data.run);
  expect(stopped.timeline.filter((e) => e.type === "handoff")).toEqual([]);
  const replacement = {
    run_id: successor.id,
    runtime_ref: { ...ref, terminal_ref: "new" },
  };
  const launched = value(dispatchRun(preserved, system, replacement, f.io));
  expect(launched.events).toContainEqual(
    expect.objectContaining({
      type: "session_replaced",
      payload: expect.objectContaining({
        reason: "dispatch_stall",
        last_run_id: prior.id,
        last_outcome: "blocked",
      }),
    }),
  );
  expect(launched.timeline.filter((e) => e.type === "handoff")).toMatchObject([
    { body: expect.stringContaining(`最近 Run：${prior.id}`) },
  ]);
  expect(
    dispatchRun(apply(preserved, launched), system, replacement, f.io).ok,
  ).toBe(false);
  const failed = value(
    recordAutomaticContextRestartResult(
      apply(pending, stopped),
      system,
      {
        action_id: started.data.action_id,
        result: "failed",
        reason: "replacement_launch_unconfirmed",
      },
      f.io,
    ),
  );
  const fenced = apply(apply(pending, stopped), failed);
  expect(fenced.human_actions.at(-1)).toMatchObject({ triage: "pm_ops" });
  expect(hostOpsPending(fenced.events, a.id)).toBe(true);
});

test("only the system may replace a stalled patrol, once per cause and never with unfinished work", () => {
  const f = setup();
  const params = { assignment_id: f.ops.id, cause_id: "pending-1", snapshot };
  const begin = (
    state: CommandState,
    who: Parameters<typeof beginStalledPatrolRestart>[1] = system,
  ) => beginStalledPatrolRestart(state, who, params, f.io);
  expect(begin(f.state, human).ok).toBe(false);
  expect(begin(f.state, actor(10, "host_ops")).ok).toBe(false);
  const busy = apply(
    f.state,
    value(
      queueRun(f.state, system, { assignment_id: f.ops.id, ...snapshot }, f.io),
    ),
  );
  expect(begin(busy).ok).toBe(false);
  expect(
    begin({
      ...f.state,
      assignments: f.state.assignments.map((a) =>
        a.id === f.ops.id ? { ...a, worktree_path: "unverified" } : a,
      ),
    }).ok,
  ).toBe(false);
  const effect = value(begin(f.state));
  const pending = apply(f.state, effect);
  expect(begin(pending).ok).toBe(false);
  // An independently confirmed exit is still settled if its cause expired,
  // but no unrelated followup Run is authorized.
  expect(
    value(finishHostOpsAction(pending, system, effect.data.action_id, f.io))
      .data.run,
  ).toBeUndefined();
  const finished = value(
    finishHostOpsAction(pending, system, effect.data.action_id, f.io, {
      cause_id: params.cause_id,
      card_id: null,
    }),
  );
  expect(finished.data.run?.status).toBe("queued");
  expect(finished.data.assignment_id).toBe(f.ops.id);
  expect(
    finished.changes.find(
      (c) => c.collection === "assignments" && c.entity.id === f.ops.id,
    )?.entity,
  ).not.toHaveProperty("session_ref");
});

test("C-669: a stalled patrol restart withdrawn before any signal may be retried by the system only", () => {
  const f = setup();
  const params = { assignment_id: f.ops.id, cause_id: "pending-1", snapshot };
  const begin = (
    state: CommandState,
    who: Parameters<typeof beginStalledPatrolRestart>[1] = system,
  ) => beginStalledPatrolRestart(state, who, params, f.io);
  const first = value(begin(f.state));
  const pending = apply(f.state, first);
  const withdrawn = apply(
    pending,
    value(
      withdrawUnstartedStallRestart(
        pending,
        system,
        first.data.action_id,
        f.io,
        "identity_changed",
      ),
    ),
  );
  expect(pendingHostOpsActions(withdrawn.events)).toHaveLength(0);
  // Only the system entry retries; an agent or human still cannot use it.
  expect(begin(withdrawn, human).ok).toBe(false);
  expect(begin(withdrawn, actor(10, "host_ops")).ok).toBe(false);
  const retry = value(begin(withdrawn));
  expect(retry.events).toMatchObject([
    {
      type: "host_ops_action_taken",
      payload: { assignment_id: f.ops.id, dispatch_stall_id: "pending-1" },
    },
  ]);
  // One executor: never beside the retry's own pending intent.
  expect(begin(apply(withdrawn, retry)).ok).toBe(false);
  // A started stop is not withdrawn: its incident is never retried.
  const stopping: CommandState = {
    ...pending,
    events: [
      ...pending.events,
      {
        id: f.io.ids.nextEventId(),
        seq: 99,
        type: "host_ops_action_deferred",
        actor: system,
        created_at: now,
        payload: {
          action_id: first.data.action_id,
          reason: "automatic_context_stop_started",
        },
      },
    ],
  };
  expect(
    value(
      withdrawUnstartedStallRestart(
        stopping,
        system,
        first.data.action_id,
        f.io,
        "identity_changed",
      ),
    ).events,
  ).toEqual([]);
  // Any other outcome of the earlier attempt still consumes the incident.
  const failed: CommandState = {
    ...pending,
    events: [
      ...pending.events,
      {
        id: f.io.ids.nextEventId(),
        seq: 100,
        type: "host_ops_action_finished",
        actor: system,
        created_at: now,
        payload: {
          action_id: first.data.action_id,
          assignment_id: f.ops.id,
          result: "failed",
        },
      },
    ],
  };
  expect(pendingHostOpsActions(failed.events)).toHaveLength(0);
  expect(begin(failed).ok).toBe(false);
});

test("C-680: a withdrawal records the diagnosis that held it", () => {
  const f = setup();
  const params = { assignment_id: f.ops.id, cause_id: "pending-1", snapshot };
  const first = value(beginStalledPatrolRestart(f.state, system, params, f.io));
  const pending = apply(f.state, first);
  const withdrawn = value(
    withdrawUnstartedStallRestart(
      pending,
      system,
      first.data.action_id,
      f.io,
      "agent_busy",
      false,
      { cause: "agent_busy", action: "none", evidence: ["harness_working"] },
    ),
  );
  expect(withdrawn.events).toMatchObject([
    {
      type: "host_ops_action_finished",
      payload: {
        result: "withdrawn_stall_changed",
        reason: "agent_busy",
        blocked_by: {
          cause: "agent_busy",
          action: "none",
          evidence: ["harness_working"],
        },
      },
    },
  ]);
  // Without a diagnosis the payload stays as before.
  expect(
    value(
      withdrawUnstartedStallRestart(
        pending,
        system,
        first.data.action_id,
        f.io,
        "identity_changed",
      ),
    ).events[0]?.payload,
  ).not.toHaveProperty("blocked_by");
});

test("C-680: only the system queues a Run in the patrol's live session, never beside unfinished work, a stop or an operation", () => {
  const f = setup();
  const params = {
    assignment_id: f.ops.id,
    cause_id: "pending-1",
    snapshot,
    attempt: 1,
  };
  const nudge = (
    state: CommandState,
    who: Parameters<typeof nudgeStalledPatrol>[1] = system,
    p: Parameters<typeof nudgeStalledPatrol>[2] = params,
  ) => nudgeStalledPatrol(state, who, p, f.io);
  expect(nudge(f.state, human).ok).toBe(false);
  expect(nudge(f.state, actor(10, "host_ops")).ok).toBe(false);
  expect(nudge(f.state, system, { ...params, attempt: 0 }).ok).toBe(false);
  expect(nudge(f.state, system, { ...params, cause_id: "" }).ok).toBe(false);
  // No live session to wake: never a launch in disguise.
  expect(
    nudge({
      ...f.state,
      assignments: f.state.assignments.map((a) =>
        a.id === f.ops.id ? { ...a, runtime_ref: null } : a,
      ),
    }).ok,
  ).toBe(false);
  const busy = apply(
    f.state,
    value(
      queueRun(f.state, system, { assignment_id: f.ops.id, ...snapshot }, f.io),
    ),
  );
  expect(nudge(busy).ok).toBe(false);
  const stopped: CommandState = {
    ...f.state,
    events: [
      ...f.state.events,
      {
        id: f.io.ids.nextEventId(),
        seq: 98,
        type: "assignment_stopped",
        actor: human,
        created_at: now,
        payload: { assignment_id: f.ops.id, hold: true },
      },
    ],
  };
  expect(nudge(stopped).ok).toBe(false);
  const operating = apply(
    f.state,
    value(beginStalledPatrolRestart(f.state, system, params, f.io)),
  );
  expect(nudge(operating).ok).toBe(false);
  const effect = value(nudge(f.state));
  expect(effect.data).toMatchObject({
    assignment_id: f.ops.id,
    status: "queued",
    kind: "initial",
  });
  const nudged = apply(f.state, effect);
  expect(patrolNudges(nudged, f.ops.id, "pending-1")).toMatchObject([
    {
      type: "dispatch_stall_nudged",
      payload: {
        assignment_id: f.ops.id,
        dispatch_stall_id: "pending-1",
        run_id: effect.data.id,
        attempt: 1,
      },
    },
  ]);
  expect(patrolNudges(nudged, f.ops.id, "other")).toEqual([]);
  // The session and its reference are untouched.
  expect(nudged.assignments.find((a) => a.id === f.ops.id)).toMatchObject({
    runtime_ref: ref,
    session_ref: "current",
  });
  // One Run at a time.
  expect(nudge(nudged, system, { ...params, attempt: 2 }).ok).toBe(false);
});

test.each(["card", "project"] as const)(
  "standing stall settlement keeps its %s stream and rechecks the card hold",
  (stream) => {
    const f = setup();
    const card = required(f.state.cards[0]);
    const params = { assignment_id: f.ops.id, cause_id: "note", snapshot };
    const begun = value(
      beginStalledPatrolRestart(f.state, system, params, f.io),
    );
    const pending = apply(f.state, begun);
    const stall = {
      cause_id: params.cause_id,
      card_id: stream === "card" ? card.id : null,
    };
    const settle = (state: CommandState) =>
      value(
        finishHostOpsAction(state, system, begun.data.action_id, f.io, stall),
      );
    const result = settle(pending).data;
    expect(required(result.run).trigger_event_id).toBe(result.event.id);
    expect(result.event.card_id).toBe(stall.card_id ?? undefined);
    const held = settle({
      ...pending,
      cards: pending.cards.map((c) =>
        c.id === card.id
          ? {
              ...c,
              hold: {
                set_by: "system",
                reason: "paused",
                resume_condition: "test",
                set_at: now,
              },
            }
          : c,
      ),
    });
    expect(Boolean(held.data.run)).toBe(stream === "project");
  },
);

test("a generationless loopback owner needs an unambiguous confirmed bell on the entire bound ref", () => {
  const state = fixture(),
    created = run(),
    reused = run(2, 1);
  const bound = {
    ...ref,
    runtime_machine: "worker",
    terminal_ref: "worker/t1",
    target: {
      project_id: state.project_id,
      machine_id: "local",
      session: "fixture",
      generation: "legacy",
      fingerprint: "a".repeat(64),
    },
  };
  const first = {
    ...created,
    bell_delivery: { run_id: created.id, sent_at: now, runtime_ref: bound },
  };
  const later = {
    ...reused,
    bell_delivery: {
      run_id: reused.id,
      sent_at: "2099-01-01T00:00:00.000Z",
      runtime_ref: bound,
    },
  };
  const owner = (runs: typeof state.runs, endedRun = first.id) =>
    systemTurnOwner({ ...state, runs }, created.assignment_id, bound, endedRun);
  expect(owner([later, first], later.id)).toHaveProperty(
    "first_bell_run_id",
    first.id,
  );
  expect(owner([first], later.id)).not.toHaveProperty("first_bell_run_id");
  for (const runs of [
    [],
    [created],
    [
      {
        ...first,
        bell_delivery: {
          ...first.bell_delivery,
          runtime_ref: {
            ...bound,
            target: { ...bound.target, fingerprint: "b".repeat(64) },
          },
        },
      },
    ],
    [{ ...first, assignment_id: id("assignment", 9) }],
    [{ ...first, bell_delivery: { ...first.bell_delivery, run_id: later.id } }],
    [{ ...first, bell_delivery: { runtime_ref: bound, run_id: first.id } }],
    [
      first,
      { ...later, bell_delivery: { ...later.bell_delivery, sent_at: now } },
    ],
  ])
    expect(owner(runs)).not.toHaveProperty("first_bell_run_id");
});

test("stall recovery distinguishes one pristine queue from dispatch evidence or a second executable Run", () => {
  const f = setup(),
    a = f.state.assignments[0]!;
  const r = {
    ...run(),
    id: id("run", 77),
    assignment_id: a.id,
    role_version: a.role_version,
    status: "queued" as const,
    started_at: undefined,
    finished_at: undefined,
  };
  const { started_at: _s, finished_at: _f, ...queued } = r;
  const event: Event = {
    id: f.io.ids.nextEventId(),
    seq: 1,
    type: "run_queued",
    actor: system,
    created_at: now,
    payload: { run_id: r.id, assignment_id: a.id },
  };
  const state = { ...f.state, runs: [queued], events: [event] };
  expect(untouchedStallSuccessor(state, a, queued)).toBe(true);
  expect(untouchedStallSuccessor({ ...state, events: [] }, a, queued)).toBe(
    false,
  );
  expect(
    untouchedStallSuccessor(
      { ...state, events: [event, { ...event, type: "run_dispatched" }] },
      a,
      queued,
    ),
  ).toBe(false);
  expect(
    untouchedStallSuccessor(
      { ...state, runs: [queued, { ...queued, id: id("run", 78) }] },
      a,
      queued,
    ),
  ).toBe(false);
  expect(
    untouchedStallSuccessor(state, a, {
      ...queued,
      bell_delivery: { run_id: r.id },
    }),
  ).toBe(false);
  expect(
    untouchedStallSuccessor(state, a, { ...queued, recovery_runtime: ref }),
  ).toBe(false);
});

test.each(["waiting", "stopping"] as const)(
  "retirement %s transfer settles only the captured fence and reuses the untouched queue",
  (phase) => {
    const f = setup();
    const original = required(f.state.assignments[0]);
    const bound = { ...ref, agent_name: "retiring", terminal_ref: "retiring" };
    const h = {
      phase,
      handoff: true as const,
      started_at: now,
      runtime_ref: bound,
      failures: 3,
      threshold_minutes: 60,
    };
    const a = { ...original, runtime_ref: bound, idle_retirement: h };
    const cause: Event = {
      id: f.io.ids.nextEventId(),
      seq: 44,
      type: "run_queued",
      actor: system,
      created_at: now,
      card_id: id("card", 1),
      payload: { assignment_id: a.id, run_id: id("run", 77) },
    };
    const queued = {
      ...run(),
      id: id("run", 77),
      status: "queued" as const,
      trigger_event_id: cause.id,
    };
    const state = {
      ...f.state,
      assignments: f.state.assignments.map((v) => (v.id === a.id ? a : v)),
      runs: [queued],
      events: [cause],
    };
    const begin = (s: CommandState) =>
      beginSystemTurnRestart(
        s,
        system,
        { assignment_id: a.id, cause_id: cause.id, snapshot },
        f.io,
      );
    const intent = value(begin(state));
    const pending = apply(state, intent);
    expect(begin(pending).ok).toBe(false);
    const finish = (s: CommandState) =>
      finishHostOpsAction(s, system, intent.data.action_id, f.io, {
        cause_id: cause.id,
        card_id: cause.card_id ?? null,
      });
    const complete = value(finish(pending));
    expect(complete.data.run).toEqual(queued);
    const done = apply(pending, complete);
    expect(done.assignments.find((v) => v.id === a.id)).toMatchObject({
      runtime_ref: null,
    });
    expect(
      done.assignments.find((v) => v.id === a.id)?.idle_retirement,
    ).toBeUndefined();
    expect(done.runs).toEqual([queued]);
    for (const raced of [
      { ...pending, runs: [{ ...queued, status: "dispatched" as const }] },
      {
        ...pending,
        cursors: [
          { assignment_id: a.id, card_id: id("card", 1), acked_seq: cause.seq },
        ],
      },
      {
        ...pending,
        assignments: pending.assignments.map((v) =>
          v.id === a.id
            ? { ...a, idle_retirement: { ...h, started_at: "new-claim" } }
            : v,
        ),
      },
      {
        ...pending,
        assignments: pending.assignments.map((v) =>
          v.id === a.id ? { ...a, runtime_ref: ref } : v,
        ),
      },
      {
        ...pending,
        work_items: pending.work_items.map((w) =>
          w.id === a.work_item_id
            ? { ...w, status: "waiting_decision" as const }
            : w,
        ),
      },
    ])
      expect(finish(raced).ok).toBe(false);
  },
);

/** C-741: a later moment with a fresh sample of the same session. */
function later(f: ReturnType<typeof setup>, ms: number) {
  const at = new Date(Date.parse(now) + ms).toISOString();
  const io = { ...f.io, clock: { now: () => at } };
  const usage = { ...f.usage, updated_at: at };
  return {
    io,
    usage,
    begin: () =>
      beginAutomaticContextRestart(
        f.state,
        system,
        { usage, stale_after_ms: 60_000, snapshot },
        io,
      ),
  };
}
function hold(
  f: ReturnType<typeof setup>,
  io: ReturnType<typeof ports>,
  action_id: Event["id"],
  reason = "upstream_diagnosis_unavailable",
  retry_delays_ms?: readonly number[],
) {
  return value(
    recordAutomaticContextRestartResult(
      f.state,
      system,
      {
        action_id,
        result: "failed",
        reason,
        ...(retry_delays_ms ? { retry_delays_ms } : {}),
      },
      io,
    ),
  );
}

test("C-741: a temporary hold schedules backoff retries (2, 5, 10 min) instead of a human item; PM gets it once they run out", () => {
  const f = setup();
  let at = 0;
  let begun = value(f.begin());
  f.state = apply(f.state, begun);
  const delays = [120_000, 300_000, 600_000];
  for (const [attempt, delay] of delays.entries()) {
    const held = hold(f, later(f, at).io, required(begun.data).action_id);
    expect(held.events).toEqual([
      expect.objectContaining({
        type: "context_session_restart_result",
        payload: expect.objectContaining({
          result: "retry_scheduled",
          reason: "upstream_diagnosis_unavailable",
          attempt: attempt + 1,
          retry_at: new Date(Date.parse(now) + at + delay).toISOString(),
        }),
      }),
    ]);
    f.state = apply(f.state, held);
    expect(f.state.human_actions).toHaveLength(0);
    expect(hostOpsPending(f.state.events, f.ops.id)).toBe(false);
    expect(pendingHostOpsActions(f.state.events)).toHaveLength(0);
    // Not due yet: neither readiness nor the intent accepts another attempt.
    const early = later(f, at + delay - 1);
    expect(
      automaticContextRestartReady(
        f.state,
        early.usage,
        early.io.clock.now(),
        60_000,
      ),
    ).toBe(false);
    expect(value(early.begin()).events).toHaveLength(0);
    // The operator's own tool still cannot repeat a context restart.
    expect(
      beginHostOpsAction(
        f.state,
        actor(4, "pm"),
        {
          tool: "host_ops_restart_assignment",
          target_id: f.ops.id,
          reason: "manual",
          context_usage: early.usage,
          context_stale_after_ms: 60_000,
          snapshot,
        },
        early.io,
      ).ok,
    ).toBe(false);
    at += delay;
    begun = value(later(f, at).begin());
    expect(begun.data).toBeDefined();
    f.state = apply(f.state, begun);
  }
  const final = hold(f, later(f, at).io, required(begun.data).action_id);
  f.state = apply(f.state, final);
  expect(final.events.at(-1)).toMatchObject({
    type: "context_session_restart_result",
    payload: {
      result: "failed",
      disposition: "pm_ops",
      retries: 3,
      reason: "upstream_diagnosis_unavailable",
    },
  });
  expect(f.state.human_actions).toEqual([
    expect.objectContaining({
      triage: "pm_ops",
      status: "open",
      instructions: expect.stringContaining(
        `cardigan host-ops restart --project ${human.project_id}`,
      ),
      why_human: expect.stringContaining("upstream_diagnosis_unavailable"),
    }),
  ]);
  expect(hostOpsPending(f.state.events, f.ops.id)).toBe(true);
  expect(value(later(f, at + 3_600_000).begin()).events).toHaveLength(0);
});

test("C-741: a configured list sets the delays; agent_busy is temporary too", () => {
  const f = setup();
  const begun = value(f.begin());
  f.state = apply(f.state, begun);
  const held = hold(
    f,
    f.io,
    required(begun.data).action_id,
    "agent_busy",
    [30_000],
  );
  expect(held.events[0]).toMatchObject({
    payload: {
      result: "retry_scheduled",
      retry_at: new Date(Date.parse(now) + 30_000).toISOString(),
    },
  });
  f.state = apply(f.state, held);
  const next = value(later(f, 30_000).begin());
  f.state = apply(f.state, next);
  const last = hold(
    f,
    later(f, 30_000).io,
    required(next.data).action_id,
    "agent_busy",
    [30_000],
  );
  expect(last.events.at(-1)).toMatchObject({
    payload: { result: "failed", disposition: "pm_ops", retries: 1 },
  });
});

test("C-741: other failures and holds after a stop may have started keep the single attempt and name the command", () => {
  for (const kind of ["launch", "stop_started"] as const) {
    const f = setup();
    const begun = value(f.begin());
    f.state = apply(f.state, begun);
    const action_id = required(begun.data).action_id;
    if (kind === "stop_started")
      f.state = {
        ...f.state,
        events: [
          ...f.state.events,
          {
            ...required(f.state.events.at(-1)),
            id: "00000000000000000000000999" as Event["id"],
            type: "host_ops_action_deferred",
            payload: { action_id, reason: "automatic_context_stop_started" },
          },
        ],
      };
    const result = hold(
      f,
      f.io,
      action_id,
      kind === "launch" ? "新会话启动失败。" : "upstream_diagnosis_unavailable",
    );
    expect(result.events.at(-1)).toMatchObject({
      payload: { result: "failed", disposition: "human" },
    });
    f.state = apply(f.state, result);
    expect(f.state.human_actions).toEqual([
      expect.objectContaining({
        triage: "human",
        instructions: expect.stringContaining(
          `cardigan host-ops restart --project ${human.project_id}`,
        ),
      }),
    ]);
  }
});

test("C-741: the human restart command replaces the session, closes the failure item and releases the fence", () => {
  const f = setup();
  const begun = value(f.begin());
  f.state = apply(f.state, begun);
  f.state = apply(
    f.state,
    hold(f, f.io, required(begun.data).action_id, "exit unknown"),
  );
  const item = required(f.state.human_actions.at(-1));
  expect(hostOpsPending(f.state.events, f.ops.id)).toBe(true);
  // A restart started by the system or an agent is still fenced.
  expect(
    queueRun(
      f.state,
      system,
      {
        ...snapshot,
        assignment_id: f.ops.id,
        restart_session: true,
        expected_runtime_ref: ref,
      },
      f.io,
    ).ok,
  ).toBe(false);
  const restarted = value(
    queueRun(
      f.state,
      human,
      {
        ...snapshot,
        assignment_id: f.ops.id,
        reuse_queued: true,
        restart_session: true,
        expected_runtime_ref: ref,
      },
      f.io,
    ),
  );
  f.state = apply(f.state, restarted);
  expect(restarted.events.map((e) => e.type)).toEqual(
    expect.arrayContaining([
      "standing_session_restarted",
      "human_action_completed",
      "run_queued",
    ]),
  );
  expect(f.state.human_actions.find((h) => h.id === item.id)).toMatchObject({
    status: "done",
    result: {
      text: expect.stringContaining("cardigan host-ops restart"),
    },
  });
  expect(f.state.assignments.find((a) => a.id === f.ops.id)).toMatchObject({
    id: f.ops.id,
    status: "active",
    runtime_ref: null,
  });
  expect(hostOpsPending(f.state.events, f.ops.id)).toBe(false);
});

test("C-741: a standing PM is restarted automatically with the same retries and points at pm restart", () => {
  const io = ports();
  const pmRef = { ...ref, terminal_ref: "pm", agent_session_id: "pm" };
  const { work_item_id: _w, ...opsFields } = assignment(10, "host_ops");
  const { work_item_id: _p, ...pmFields } = assignment(11, "pm");
  const ops: Assignment = { ...opsFields, scope: "standing", runtime_ref: ref };
  const pm: Assignment = {
    ...pmFields,
    scope: "standing",
    standing_mode: "office",
    runtime_ref: pmRef,
    session_ref: "pm",
  };
  const s = fixture();
  let state: CommandState = {
    ...s,
    assignments: [...s.assignments, ops, pm],
    roles: [
      ...s.roles,
      { ...role("host_ops"), allowed_tools: HOST_OPS_ROLE_TOOLS },
    ],
  };
  const usage: ContextObservation = {
    assignment_id: pm.id,
    agent: "claude",
    session_id: "pm",
    runtime_key: JSON.stringify(pmRef),
    cwd: "/fixture",
    transcript_path: null,
    model: "fixture",
    context_tokens: 850,
    context_window_size: 1000,
    used_percentage: 85,
    updated_at: now,
    source: "fixture",
  };
  for (let i = 0; i < 2; i++)
    state = apply(
      state,
      value(recordContextUsageNotices(state, system, usage, 60_000, io)),
    );
  expect(state.events.at(-1)).toMatchObject({
    type: "context_usage_notice",
    payload: {
      level: "restart",
      body: expect.stringContaining("系统会在该会话空闲"),
    },
  });
  expect(automaticContextRestartReady(state, usage, now, 60_000)).toBe(true);
  const begun = value(
    beginAutomaticContextRestart(
      state,
      system,
      { usage, stale_after_ms: 60_000, snapshot },
      io,
    ),
  );
  expect(begun.events[0]).toMatchObject({
    payload: {
      tool: "host_ops_restart_standing_pm",
      assignment_id: pm.id,
      automatic_context_restart: true,
    },
  });
  state = apply(state, begun);
  const action_id = required(begun.data).action_id;
  const held = value(
    recordAutomaticContextRestartResult(
      state,
      system,
      { action_id, result: "failed", reason: "session_state_unconfirmed" },
      io,
    ),
  );
  expect(held.events[0]).toMatchObject({
    payload: { result: "retry_scheduled", assignment_id: pm.id },
  });
  // A failed attempt on the PM names its own restart command.
  const f2 = apply(
    state,
    value(
      recordAutomaticContextRestartResult(
        state,
        system,
        { action_id, result: "failed", reason: "当前主机无法确认旧会话退出" },
        io,
      ),
    ),
  );
  const item = required(f2.human_actions.at(-1));
  expect(item.instructions).toContain(
    `cardigan pm restart --office --project ${human.project_id}`,
  );
  expect(
    completeHumanAction(
      f2,
      human,
      { human_action_id: item.id, text: "done" },
      io,
    ),
  ).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("cardigan pm restart --office") },
  });
  // The human's pm restart closes it, too.
  const restarted = value(
    queueRun(
      f2,
      human,
      {
        ...snapshot,
        assignment_id: pm.id,
        reuse_queued: true,
        restart_session: true,
        expected_runtime_ref: pmRef,
      },
      io,
    ),
  );
  const after = apply(f2, restarted);
  expect(after.human_actions.find((h) => h.id === item.id)?.status).toBe(
    "done",
  );
  expect(hostOpsPending(after.events, pm.id)).toBe(false);
});
