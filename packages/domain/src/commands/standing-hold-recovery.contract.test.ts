import { expect, test } from "vitest";
import type { Actor, Run } from "../entities.js";
import { HOST_OPS_ROLE_TOOLS } from "../host-ops.js";
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
  const queue = () => commit(value(queueRun(state, system, params, io)));
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
