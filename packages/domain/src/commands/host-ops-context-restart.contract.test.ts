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
  withdrawUnstartedStallRestart,
} from "./host-ops-actions.js";
import {
  automaticContextRestartReady,
  beginAutomaticContextRestart,
  beginStalledPatrolRestart,
  beginSystemTurnRestart,
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
    { role_id: "pm" },
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
  f.state = apply(
    f.state,
    value(
      completeHumanAction(
        f.state,
        human,
        {
          human_action_id: request.id,
          text: "Confirmed exact terminal exited",
        },
        f.io,
      ),
    ),
  );
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
      v.id === a.id ? { ...v, runtime_ref: ref } : v,
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
  const stopped = value(
    finishHostOpsAction(pending, system, started.data.action_id, f.io, {
      cause_id: due.id,
      card_id: null,
    }),
  );
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
