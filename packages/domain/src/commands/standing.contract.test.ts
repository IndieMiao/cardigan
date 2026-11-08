import { expect, test } from "vitest";
import {
  type Actor,
  type Assignment,
  acknowledgeRun,
  type CommandState,
  dispatchRun,
  pauseStandingAssignment,
  queueRun,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { apply, human, id, now, role, value } from "./test-fixtures.js";

function fixture() {
  const f = mergeFixture(); // Real createCard + work-item assign; standing bootstrap mirrors pm create.
  const pm: Assignment = {
    id: id("assignment", 900),
    scope: "standing",
    standing_mode: "ops",
    role_id: "pm",
    role_version: 1,
    status: "active",
    runtime_state: "not_provisioned",
    runtime_ref: null,
    machine_id: "local",
    mcp_token_id: "pending",
    created_at: now,
  };
  let state: CommandState = {
    ...f.state,
    assignments: [...f.state.assignments, pm],
  };
  const actor: Actor = {
    kind: "assignment",
    project_id: state.project_id,
    assignment_id: pm.id,
    ...role("pm"),
  };
  const params = {
    assignment_id: pm.id,
    model: "fixture",
    agent_cli_version: "fixture",
  };
  const run = value(queueRun(state, human, params, f.io));
  state = apply(state, run);
  const dispatched = value(
    dispatchRun(
      state,
      human,
      {
        run_id: run.data.id,
        runtime_ref: {
          machine_id: "local",
          runtime_machine: "local",
          terminal_ref: "t-pm",
          agent_name: "pm",
        },
      },
      f.io,
    ),
  );
  state = apply(state, dispatched);
  state = apply(
    state,
    value(acknowledgeRun(state, actor, { run_id: run.data.id }, f.io)),
  );
  return { f, pm, actor, params, state, run: run.data };
}

test("S24 invariants 5, 11, 12: pause cancels the Run; only human resume can atomically queue another", () => {
  const x = fixture(),
    paused = value(
      pauseStandingAssignment(
        x.state,
        human,
        { assignment_id: x.pm.id },
        x.f.io,
      ),
    );
  const state = apply(x.state, paused);
  expect(paused.data).toMatchObject({
    assignment: { status: "suspended", runtime_ref: { terminal_ref: "t-pm" } },
    aborted: true,
  });
  expect(state.runs.find((r) => r.id === x.run.id)).toMatchObject({
    status: "cancelled",
    finished_at: now,
  });
  expect(
    value(
      pauseStandingAssignment(state, human, { assignment_id: x.pm.id }, x.f.io),
    ).changes,
  ).toEqual([]);
  expect(queueRun(state, human, x.params, x.f.io)).toMatchObject({
    ok: false,
    error: { code: "illegal_transition" },
  });
  for (const actor of [
    x.actor,
    { kind: "system", project_id: state.project_id } as const,
  ]) {
    expect(
      queueRun(state, actor, { ...x.params, resume: true }, x.f.io),
    ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(
      pauseStandingAssignment(
        x.state,
        actor,
        { assignment_id: x.pm.id },
        x.f.io,
      ),
    ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  }
  expect(
    queueRun(state, human, { ...x.params, resume: true, model: "" }, x.f.io),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  const resumed = value(
    queueRun(state, human, { ...x.params, resume: true }, x.f.io),
  );
  const next = apply(state, resumed);
  expect(next.assignments.find((a) => a.id === x.pm.id)).toMatchObject({
    status: "active",
    runtime_ref: null,
  });
  expect(resumed.data).toMatchObject({
    status: "queued",
    role_version: 1,
    model: "fixture",
    agent_cli_version: "fixture",
  });
  expect(
    next.runs.filter(
      (r) => !["cancelled", "completed", "failed"].includes(r.status),
    ),
  ).toHaveLength(1);
});

test("S24 invariant 11: standing pause/resume cannot change a work-item Assignment", () => {
  const x = fixture();
  expect(
    pauseStandingAssignment(
      x.state,
      human,
      { assignment_id: x.f.coder.id },
      x.f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  expect(
    queueRun(
      x.state,
      human,
      { ...x.params, assignment_id: x.f.coder.id, resume: true },
      x.f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  expect(x.state.assignments.find((a) => a.id === x.f.coder.id)?.status).toBe(
    "active",
  );
});
