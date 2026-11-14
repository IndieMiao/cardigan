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
import { beginHostOpsAction, finishHostOpsAction } from "./host-ops-actions.js";
import {
  automaticContextRestartReady,
  beginAutomaticContextRestart,
  recordAutomaticContextRestartResult,
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
