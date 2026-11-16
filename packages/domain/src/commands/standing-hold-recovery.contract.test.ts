import { expect, test } from "vitest";
import { assignmentCardHeld, assignmentCardId } from "../card-hold.js";
import type { Actor, Run } from "../entities.js";
import { HOST_OPS_ROLE_TOOLS } from "../host-ops.js";
import type { EventId } from "../ids.js";
import type { CommandEffect } from "./core.js";
import { recoverDispatch } from "./dispatch-recovery.js";
import { claimDispatchStop, startDispatchStop } from "./dispatch-stop.js";
import {
  beginHostOpsAction,
  finishHostOpsAction,
  prepareHostOpsAction,
} from "./host-ops-actions.js";
import { acknowledgeRun, dispatchRun, queueRun } from "./launch.js";
import { updateCard } from "./pm.js";
import { finishRun } from "./runtime.js";
import {
  actor,
  apply,
  assignment,
  fixture,
  human,
  id,
  ports,
  role,
  value,
} from "./test-fixtures.js";

function setup() {
  const io = ports();
  let state = fixture();
  const commit = <T>(effect: CommandEffect<T>): T => {
    state = apply(state, effect);
    return effect.data;
  };
  const system: Actor = { kind: "system", project_id: state.project_id };
  const { work_item_id: _work, ...ops } = assignment(10, "host_ops");
  state = {
    ...state,
    assignments: [...state.assignments, { ...ops, scope: "standing" }],
    roles: [
      ...state.roles,
      { ...role("host_ops"), allowed_tools: HOST_OPS_ROLE_TOOLS },
    ],
  };
  const caller: Actor = {
    kind: "assignment",
    project_id: state.project_id,
    assignment_id: ops.id,
    role_id: "host_ops",
    role_version: 1,
    capabilities: [],
    allowed_tools: HOST_OPS_ROLE_TOOLS,
  };
  const changed = value(
    updateCard(
      state,
      human,
      { card_id: id("card", 1), title: "Waiting task" },
      io,
    ),
  );
  commit(changed);
  const trigger = changed.events[0];
  if (!trigger) throw new Error("Missing trigger");
  const params = {
    assignment_id: id("assignment", 4),
    model: "fixture",
    agent_cli_version: "fixture",
  };
  const held = commit(
    value(
      queueRun(state, human, { ...params, trigger_event_id: trigger.id }, io),
    ),
  );
  commit(
    value(
      updateCard(
        state,
        human,
        {
          card_id: id("card", 1),
          hold: { reason: "wait", resume_condition: "ready" },
        },
        io,
      ),
    ),
  );
  const queue = (trigger_event_id?: EventId) =>
    commit(
      value(
        queueRun(
          state,
          system,
          { ...params, ...(trigger_event_id ? { trigger_event_id } : {}) },
          io,
        ),
      ),
    );
  const ref = {
    machine_id: "local",
    runtime_machine: "local",
    terminal_ref: "standing-patrol",
    agent_name: "fixture",
  };
  const dispatch = (run: Run) =>
    commit(
      value(
        dispatchRun(state, system, { run_id: run.id, runtime_ref: ref }, io),
      ),
    );
  const release = () =>
    commit(
      value(
        updateCard(state, human, { card_id: id("card", 1), hold: null }, io),
      ),
    );
  return {
    io,
    system,
    caller,
    commit,
    held,
    params,
    queue,
    dispatch,
    ref,
    release,
    state: () => state,
    legacyEvents: () => {
      state = {
        ...state,
        events: state.events.map((e) => {
          if (
            !["run_dispatch_recovered", "host_ops_action_finished"].includes(
              e.type,
            )
          )
            return e;
          const { card_id: _card, ...rest } = e;
          return rest;
        }),
      };
    },
    alter: (run: Run) => {
      state = {
        ...state,
        runs: state.runs.map((r) => (r.id === run.id ? run : r)),
      };
    },
  };
}

test.each(["host_ops_restart_standing_pm", "host_ops_cancel_run"] as const)(
  "%s settles the running patrol while preserving held queued identity",
  (tool) => {
    const f = setup();
    const patrol = f.dispatch(f.queue());
    f.commit(
      value(
        acknowledgeRun(f.state(), actor(4, "pm"), { run_id: patrol.id }, f.io),
      ),
    );
    const p = {
      tool,
      target_id:
        tool === "host_ops_cancel_run" ? patrol.id : f.params.assignment_id,
      reason: "recover session",
      snapshot: f.params,
    };
    expect(
      value(prepareHostOpsAction(f.state(), f.caller, p)).data.run?.id,
    ).toBe(patrol.id);
    const action = f.commit(
      value(beginHostOpsAction(f.state(), f.caller, p, f.io)),
    );
    const result = f.commit(
      value(finishHostOpsAction(f.state(), f.system, action.action_id, f.io)),
    );
    expect(f.state().runs.find((r) => r.id === f.held.id)).toEqual(f.held);
    expect(f.state().runs.find((r) => r.id === patrol.id)?.status).toBe(
      "cancelled",
    );
    expect(
      f.state().assignments.find((a) => a.id === f.params.assignment_id)
        ?.runtime_ref,
    ).toBeNull();
    if (tool === "host_ops_restart_standing_pm") {
      expect(result.run?.status).toBe("queued");
      expect(result.run?.id).not.toBe(f.held.id);
      expect(result.run?.trigger_event_id).toBe(result.event.id);
      const restart = f
        .state()
        .events.find((e) => e.type === "standing_session_restarted");
      expect(restart?.payload).toMatchObject({ cancelled_run_ids: [] });
    } else expect(result.run).toBeUndefined();
  },
);

test.each(["held", "before", "during"] as const)(
  "idle restart preserves queued identity with hold release %s",
  (release) => {
    const f = setup();
    const p = {
      tool: "host_ops_restart_standing_pm" as const,
      target_id: f.params.assignment_id,
      reason: "refresh idle session",
      snapshot: f.params,
    };
    if (release === "before") f.release();
    expect(
      value(prepareHostOpsAction(f.state(), f.caller, p)).data.run?.id,
    ).toBe(release === "before" ? f.held.id : undefined);
    const action = f.commit(
      value(beginHostOpsAction(f.state(), f.caller, p, f.io)),
    );
    if (release === "during") f.release();
    const result = f.commit(
      value(finishHostOpsAction(f.state(), f.system, action.action_id, f.io)),
    );
    expect(f.state().runs.find((r) => r.id === f.held.id)).toEqual(f.held);
    if (release !== "held") {
      expect(result.run).toEqual(f.held);
      f.dispatch(f.held);
    } else expect(result.run?.id).not.toBe(f.held.id);
  },
);

test("dispatch recovery settles confirmed exit and preserves paused work for its later dispatch", () => {
  const f = setup();
  const patrol = f.dispatch(f.queue());
  const claimed = f.commit(
    value(
      claimDispatchStop(
        f.state(),
        f.system,
        { run_id: patrol.id, reason: "dispatch_timeout", lease_ms: 60000 },
        f.io,
      ),
    ),
  );
  const stop = claimed?.dispatch_stop;
  if (!stop) throw new Error("Missing stop");
  f.commit(
    value(
      startDispatchStop(
        f.state(),
        f.system,
        { run_id: patrol.id, attempt_id: stop.attempt_id },
        f.io,
      ),
    ),
  );
  const params = {
    run_id: patrol.id,
    stop_id: stop.attempt_id,
    stopped_runtime: stop.runtime_ref,
    timeout_ms: 1000,
    failed_attempts: 3,
    max_failures: 3,
  };
  expect(
    recoverDispatch(
      f.state(),
      f.system,
      { ...params, stopped_runtime: { ...f.ref, terminal_ref: "wrong" } },
      f.io,
    ).ok,
  ).toBe(false);
  const recovered = f.commit(
    value(recoverDispatch(f.state(), f.system, params, f.io)),
  );
  expect(recovered?.status).toBe("queued");
  expect(f.state().runs.find((r) => r.id === patrol.id)).toMatchObject({
    status: "cancelled",
  });
  expect(
    f.state().runs.find((r) => r.id === patrol.id)?.dispatch_stop,
  ).toBeUndefined();
  expect(f.state().runs.find((r) => r.id === f.held.id)).toEqual(f.held);
  expect(
    value(recoverDispatch(f.state(), f.system, params, f.io)).data,
  ).toBeUndefined();
  f.release();
  f.dispatch(f.held);
  if (!recovered) throw new Error("Missing recovery");
  expect(
    dispatchRun(
      f.state(),
      f.system,
      { run_id: recovered.id, runtime_ref: f.ref },
      f.io,
    ).ok,
  ).toBe(false);
});

test.each(["dispatched", "started", "stop"] as const)(
  "%s evidence on another queued record still fences recovery and host operations",
  (kind) => {
    const f = setup();
    const patrol = f.dispatch(f.queue());
    const claimed = f.commit(
      value(
        claimDispatchStop(
          f.state(),
          f.system,
          { run_id: patrol.id, reason: "dispatch_timeout", lease_ms: 60000 },
          f.io,
        ),
      ),
    );
    const stop = claimed?.dispatch_stop;
    if (!stop) throw new Error("Missing stop");
    f.commit(
      value(
        startDispatchStop(
          f.state(),
          f.system,
          { run_id: patrol.id, attempt_id: stop.attempt_id },
          f.io,
        ),
      ),
    );
    f.alter({
      ...f.held,
      ...(kind === "dispatched"
        ? { status: "dispatched" }
        : kind === "started"
          ? { started_at: f.io.clock.now() }
          : { dispatch_stop: stop }),
    });
    expect(
      recoverDispatch(
        f.state(),
        f.system,
        {
          run_id: patrol.id,
          stop_id: stop.attempt_id,
          stopped_runtime: stop.runtime_ref,
          timeout_ms: 1000,
          failed_attempts: 3,
          max_failures: 3,
        },
        f.io,
      ).ok,
    ).toBe(false);
    // Remove this operation's stop fence to test the independent host-ops preflight.
    f.alter(patrol);
    expect(
      prepareHostOpsAction(f.state(), f.caller, {
        tool: "host_ops_cancel_run",
        target_id: patrol.id,
        reason: "stop",
      }).ok,
    ).toBe(false);
  },
);

test("human session restart retains held queued work without changing ordinary restart semantics", () => {
  const f = setup();
  const restart = () =>
    f.commit(
      value(
        queueRun(
          f.state(),
          human,
          { ...f.params, restart_session: true, expected_runtime_ref: null },
          f.io,
        ),
      ),
    );
  const first = restart();
  const second = restart();
  expect(first.id).not.toBe(second.id);
  expect(f.state().runs.find((r) => r.id === first.id)?.status).toBe(
    "cancelled",
  );
  expect(f.state().runs.find((r) => r.id === f.held.id)).toEqual(f.held);
});

function sourceTask(f: ReturnType<typeof setup>) {
  const change = value(
    updateCard(
      f.state(),
      human,
      { card_id: id("card", 2), title: "Source task" },
      f.io,
    ),
  );
  f.commit(change);
  const event = change.events[0];
  if (!event) throw new Error("Missing source event");
  return f.queue(event.id);
}
function holdSource(f: ReturnType<typeof setup>, held: boolean) {
  f.commit(
    value(
      updateCard(
        f.state(),
        human,
        {
          card_id: id("card", 2),
          hold: held
            ? { reason: "source paused", resume_condition: "ready" }
            : null,
        },
        f.io,
      ),
    ),
  );
}
function recoverTask(
  f: ReturnType<typeof setup>,
  run: Run,
  mode: "automatic" | "host_ops",
  beforeFinish = () => {},
) {
  f.dispatch(run);
  if (mode === "automatic") {
    const claimed = f.commit(
      value(
        claimDispatchStop(
          f.state(),
          f.system,
          { run_id: run.id, reason: "dispatch_timeout", lease_ms: 60000 },
          f.io,
        ),
      ),
    );
    const stop = claimed?.dispatch_stop;
    if (!stop) throw new Error("Missing stop");
    f.commit(
      value(
        startDispatchStop(
          f.state(),
          f.system,
          { run_id: run.id, attempt_id: stop.attempt_id },
          f.io,
        ),
      ),
    );
    beforeFinish();
    return f.commit(
      value(
        recoverDispatch(
          f.state(),
          f.system,
          {
            run_id: run.id,
            stop_id: stop.attempt_id,
            stopped_runtime: stop.runtime_ref,
            timeout_ms: 1000,
            failed_attempts: 3,
            max_failures: 3,
          },
          f.io,
        ),
      ),
    );
  }
  f.commit(
    value(acknowledgeRun(f.state(), actor(4, "pm"), { run_id: run.id }, f.io)),
  );
  const action = f.commit(
    value(
      beginHostOpsAction(
        f.state(),
        f.caller,
        {
          tool: "host_ops_restart_standing_pm",
          target_id: f.params.assignment_id,
          reason: "restart source task",
          snapshot: f.params,
        },
        f.io,
      ),
    ),
  );
  beforeFinish();
  return f.commit(
    value(finishHostOpsAction(f.state(), f.system, action.action_id, f.io)),
  ).run;
}

test.each(["automatic", "host_ops"] as const)(
  "%s successor follows later source hold/release while other standing work proceeds",
  (mode) => {
    const f = setup();
    const original = sourceTask(f);
    const next = recoverTask(f, original, mode);
    if (!next) throw new Error("Missing successor");
    expect(
      f.state().events.find((e) => e.id === next.trigger_event_id)?.card_id,
    ).toBe(id("card", 2));
    const owner = f
      .state()
      .assignments.find((a) => a.id === next.assignment_id);
    if (!owner) throw new Error("Missing owner");
    holdSource(f, true);
    expect(assignmentCardHeld(owner, f.state(), next.trigger_event_id)).toBe(
      true,
    );
    expect(
      dispatchRun(
        f.state(),
        f.system,
        { run_id: next.id, runtime_ref: f.ref },
        f.io,
      ).ok,
    ).toBe(false);
    expect(
      queueRun(
        f.state(),
        f.system,
        { ...f.params, trigger_event_id: next.trigger_event_id },
        f.io,
      ).ok,
    ).toBe(false);
    // Existing historical project-stream recovery events retain their source as well.
    f.legacyEvents();
    expect(assignmentCardHeld(owner, f.state(), next.trigger_event_id)).toBe(
      true,
    );
    expect(
      dispatchRun(
        f.state(),
        f.system,
        { run_id: next.id, runtime_ref: f.ref },
        f.io,
      ).ok,
    ).toBe(false);
    const patrol = f.dispatch(f.queue());
    f.commit(
      value(
        acknowledgeRun(f.state(), actor(4, "pm"), { run_id: patrol.id }, f.io),
      ),
    );
    f.commit(
      value(
        finishRun(
          f.state(),
          actor(4, "pm"),
          {
            run_id: patrol.id,
            outcome: "completed",
            summary: "Patrol complete",
          },
          f.io,
        ),
      ),
    );
    for (const held of [false, true, false]) {
      holdSource(f, held);
      expect(assignmentCardHeld(owner, f.state(), next.trigger_event_id)).toBe(
        held,
      );
      expect(f.state().runs.find((r) => r.id === next.id)).toEqual(next);
    }
    f.dispatch(next);
    expect(f.state().runs.find((r) => r.id === f.held.id)).toEqual(f.held);
  },
);

test.each(["automatic", "host_ops"] as const)(
  "%s completes confirmed exit without queuing new work when the source is held during stop",
  (mode) => {
    const f = setup();
    const original = sourceTask(f);
    const next = recoverTask(f, original, mode, () => holdSource(f, true));
    expect(next).toBeUndefined();
    expect(f.state().runs.find((r) => r.id === original.id)?.status).toBe(
      "cancelled",
    );
    expect(
      f.state().runs.find((r) => r.id === original.id)?.dispatch_stop,
    ).toBeUndefined();
    expect(
      f.state().assignments.find((a) => a.id === original.assignment_id)
        ?.runtime_ref,
    ).toBeNull();
    expect(f.state().runs.find((r) => r.id === f.held.id)).toEqual(f.held);
    // An explicit resume can queue from the same source card; cancelled Runs stay cancelled.
    holdSource(f, false);
    const resumed = value(
      updateCard(
        f.state(),
        human,
        { card_id: id("card", 2), title: "Resume source" },
        f.io,
      ),
    );
    f.commit(resumed);
    const event = resumed.events[0];
    if (!event) throw new Error("Missing resume trigger");
    f.dispatch(f.queue(event.id));
  },
);

test.each(["automatic", "host_ops"] as const)(
  "mixed legacy recovery chain beginning with %s retains only its own card",
  (first) => {
    const f = setup();
    const original = sourceTask(f);
    const one = recoverTask(f, original, first);
    if (!one) throw new Error("Missing first successor");
    f.legacyEvents();
    const two = recoverTask(
      f,
      one,
      first === "automatic" ? "host_ops" : "automatic",
    );
    if (!two) throw new Error("Missing second successor");
    f.legacyEvents();
    holdSource(f, true);
    const owner = f.state().assignments.find((a) => a.id === two.assignment_id);
    if (!owner) throw new Error("Missing owner");
    expect(assignmentCardId(owner, f.state(), two.trigger_event_id)).toBe(
      id("card", 2),
    );
    expect(
      dispatchRun(
        f.state(),
        f.system,
        { run_id: two.id, runtime_ref: f.ref },
        f.io,
      ).ok,
    ).toBe(false);
    holdSource(f, false);
    expect(assignmentCardHeld(owner, f.state(), two.trigger_event_id)).toBe(
      false,
    );
    f.dispatch(two);
    expect(f.state().runs.find((r) => r.id === f.held.id)).toEqual(f.held);
  },
);

test.each([
  "actor",
  "assignment",
  "successor",
  "previous",
  "trigger",
  "project",
  "cycle",
])("legacy recovery source rejects a mismatched %s binding", (mismatch) => {
  const f = setup();
  const original = sourceTask(f);
  const next = recoverTask(f, original, "automatic");
  if (!next) throw new Error("Missing successor");
  f.legacyEvents();
  const state = f.state();
  const owner = state.assignments.find((a) => a.id === next.assignment_id);
  if (!owner) throw new Error("Missing owner");
  const events = state.events.map((e) => {
    if (e.id !== next.trigger_event_id) return e;
    const payload = e.payload as Record<string, string>;
    return {
      ...e,
      ...(mismatch === "actor"
        ? { actor: human }
        : mismatch === "project"
          ? { actor: { kind: "system" as const, project_id: "other" } }
          : {}),
      payload: {
        ...payload,
        ...(mismatch === "assignment"
          ? { assignment_id: id("assignment", 1) }
          : {}),
        ...(mismatch === "successor" ? { replacement_run_id: f.held.id } : {}),
        ...(mismatch === "previous" ? { run_id: f.held.id } : {}),
        ...(mismatch === "trigger"
          ? { original_trigger_event_id: f.held.trigger_event_id }
          : {}),
        ...(mismatch === "cycle"
          ? {
              run_id: next.id,
              original_trigger_event_id: next.trigger_event_id,
            }
          : {}),
      },
    };
  });
  expect(
    assignmentCardId(owner, { ...state, events }, next.trigger_event_id),
  ).toBeUndefined();
});
