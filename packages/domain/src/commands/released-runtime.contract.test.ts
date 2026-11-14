import { expect, test } from "vitest";
import {
  type Actor,
  clearReleasedRuntimeRefs,
  releaseAssignment,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { human, value } from "./test-fixtures.js";

test("invariant 11: only the system can retire the exact released runtime reference", () => {
  const f = mergeFixture();
  const ref = {
    machine_id: "local",
    runtime_machine: "local",
    terminal_ref: "t1",
    agent_name: "fixture",
    target: {
      project_id: f.state.project_id,
      machine_id: "local",
      session: "fixture",
      generation: "one",
      fingerprint: "fixture-fingerprint",
    },
  };
  const state = {
    ...f.state,
    assignments: f.state.assignments.map((a) =>
      a.id === f.coder.id ? { ...a, runtime_ref: ref } : a,
    ),
  };
  const released = value(
    releaseAssignment(state, human, { assignment_id: f.coder.id }, f.io),
  );
  const closed = {
    ...state,
    assignments: state.assignments.map((a) =>
      a.id === f.coder.id ? released.data : a,
    ),
  };
  const p = { missing: [{ assignment_id: f.coder.id, runtime_ref: ref }] };
  const system: Actor = { kind: "system", project_id: state.project_id };
  for (const actor of [
    human,
    f.actor(f.coder),
    { ...system, project_id: "other" },
  ])
    expect(clearReleasedRuntimeRefs(closed, actor, p, f.io)).toMatchObject({
      ok: false,
      error: { code: "unauthorized" },
    });
  const effect = value(clearReleasedRuntimeRefs(closed, system, p, f.io));
  expect(effect.changes).toEqual([
    {
      collection: "assignments",
      entity: { ...released.data, runtime_ref: null },
    },
  ]);
  expect(effect.events).toMatchObject([
    { type: "assignment_terminal_cleaned", payload: p.missing[0] },
  ]);
  // Original release evidence is retained independently of the live resource pointer.
  expect(released.events[0]?.payload).toMatchObject({ runtime_ref: ref });
  for (const status of ["active", "suspended", "released"] as const) {
    const newer = {
      ...closed,
      assignments: closed.assignments.map((a) =>
        a.id === f.coder.id
          ? { ...a, status, runtime_ref: { ...ref, terminal_ref: "t2" } }
          : a,
      ),
    };
    expect(
      value(clearReleasedRuntimeRefs(newer, system, p, f.io)).changes,
    ).toEqual([]);
  }
  for (const status of ["active", "suspended"] as const) {
    const resumed = {
      ...closed,
      assignments: closed.assignments.map((a) =>
        a.id === f.coder.id ? { ...a, status } : a,
      ),
    };
    expect(
      value(clearReleasedRuntimeRefs(resumed, system, p, f.io)).changes,
    ).toEqual([]);
  }
  const committed = {
    ...closed,
    assignments: closed.assignments.map((a) =>
      a.id === f.coder.id ? { ...a, runtime_ref: null } : a,
    ),
  };
  const rebound = {
    ...closed,
    assignments: closed.assignments.map((a) =>
      a.id === f.coder.id
        ? {
            ...a,
            runtime_ref: {
              ...ref,
              target: { ...ref.target, generation: "two" },
            },
          }
        : a,
    ),
  };
  expect(
    value(clearReleasedRuntimeRefs(rebound, system, p, f.io)).changes,
  ).toEqual([]);
  expect(
    value(clearReleasedRuntimeRefs(committed, system, p, f.io)),
  ).toMatchObject({ changes: [], events: [] });
  // An uncommitted effect cannot change the original snapshot (rollback retry).
  expect(
    value(clearReleasedRuntimeRefs(closed, system, p, f.io)).changes,
  ).toEqual(effect.changes);
});
