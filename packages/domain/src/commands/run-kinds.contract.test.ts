import { expect, test } from "vitest";
import {
  acknowledgeRun,
  dispatchRun,
  type EventId,
  queueRun,
} from "../index.js";
import {
  actor,
  commit,
  dispatch,
  f,
  queue,
  ref,
  setup,
  system,
} from "./launch/test-fixtures.js";
import { apply } from "./test-fixtures.js";

/** M3.2: Run kinds, the trigger event, and dispatch on an existing terminal. */

const trigger = "E-900" as EventId;
const params = (overrides: Record<string, unknown> = {}) => ({
  assignment_id: f.coder.id,
  model: "fixture-model",
  agent_cli_version: "1.2.3",
  trigger_event_id: trigger,
  ...overrides,
});

test("queue_run records rework, decision_resumed, followup and fix with their trigger event", () => {
  for (const kind of [
    "rework",
    "decision_resumed",
    "followup",
    "fix",
  ] as const) {
    setup();
    const result = queueRun(f.state, system, params({ kind }) as never, f.io);
    expect(result.ok, kind).toBe(true);
    if (!result.ok) continue;
    const run = result.value.data;
    expect(run.kind).toBe(kind);
    expect(run.trigger_event_id).toBe(trigger);
    // The snapshot is the Assignment's role, not the caller's identity.
    expect(run.role_version).toBe(f.coder.role_version);
    expect(run.model).toBe("fixture-model");
  }
});

test("queue_run defaults to kind initial and its own run_queued event", () => {
  setup();
  const run = commit(queue());
  expect(run.kind).toBe("initial");
  expect(
    f.state.events.some(
      (event) =>
        event.type === "run_queued" && event.id === run.trigger_event_id,
    ),
  ).toBe(true);
});

test("a repeated bell for the same trigger event is rejected, not queued twice", () => {
  setup();
  const first = queueRun(
    f.state,
    system,
    params({ kind: "rework" }) as never,
    f.io,
  );
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  f.state = apply(f.state, first.value);
  expect(f.state.runs).toHaveLength(1);

  const replay = queueRun(
    f.state,
    system,
    params({ kind: "rework" }) as never,
    f.io,
  );
  expect(replay.ok).toBe(false);
  if (replay.ok) return;
  expect(replay.error.code).toBe("idempotency_conflict");
  expect(f.state.runs).toHaveLength(1);
});

test("queue_run still refuses a second unfinished Run on the same Assignment", () => {
  setup();
  commit(dispatch(commit(queue())));
  const second = queueRun(
    f.state,
    system,
    params({ kind: "followup", trigger_event_id: "E-901" as EventId }) as never,
    f.io,
  );
  expect(second.ok).toBe(false);
  if (second.ok) return;
  expect(second.error.code).toBe("invariant_violation");
});

/** Finish the current Run and leave the Assignment idle but provisioned. */
function finishFirstRun() {
  setup();
  const first = commit(queue());
  commit(dispatch(first));
  f.state = {
    ...f.state,
    runs: f.state.runs.map((run) =>
      run.id === first.id
        ? {
            ...run,
            status: "completed" as const,
            outcome: "completed" as const,
          }
        : run,
    ),
    assignments: f.state.assignments.map((assignment) =>
      assignment.id === f.coder.id
        ? { ...assignment, runtime_state: "idle" as const }
        : assignment,
    ),
  };
}

test("dispatch_run reuses the Assignment's terminal without provisioning a second one", () => {
  finishFirstRun();
  const second = commit(
    queueRun(f.state, system, params({ kind: "rework" }) as never, f.io),
  );

  // No runtime_ref: the dispatcher must fall back to the Assignment's terminal.
  const dispatched = commit(
    dispatchRun(f.state, system, { run_id: second.id }, f.io),
  );
  expect(dispatched.status).toBe("dispatched");
  expect(dispatched.kind).toBe("rework");

  const after = f.state;
  const assignment = after.assignments.find(
    (candidate) => candidate.id === f.coder.id,
  );
  expect(assignment?.runtime_ref?.terminal_ref).toBe(ref.terminal_ref);
  expect(assignment?.runtime_state).toBe("running");
  // Reuse never emits a provision event; only the dispatch is recorded.
  expect(
    after.events.filter((event) => event.type === "run_dispatched"),
  ).toHaveLength(2);
});

test("dispatch_run refuses to reuse when the Assignment has no terminal", () => {
  setup();
  const run = commit(queue());
  const result = dispatchRun(f.state, system, { run_id: run.id }, f.io);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.message).toContain("no runtime to reuse");
});

test("a bell-triggered Run is acknowledged only by its own Assignment", () => {
  setup();
  const run = commit(queue());
  commit(dispatch(run));
  const reviewer = actor(f.reviewer);
  const result = acknowledgeRun(f.state, reviewer, { run_id: run.id }, f.io);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe("unauthorized");
});
