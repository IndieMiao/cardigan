import { expect, test } from "vitest";
import {
  type Actor,
  clearReleasedRuntimeRefs,
  occupiedRunSlots,
  queueRun,
  releaseAssignment,
  requestRuntimeExitInspection,
  retainUnconfirmedLaunch,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { apply, human, run, value } from "./test-fixtures.js";

test("unconfirmed failed launches retain exact cleanup ownership and capacity after business failure", () => {
  const f = mergeFixture();
  const pending = {
    ...run(),
    assignment_id: f.coder.id,
    status: "failed" as const,
  };
  const state = { ...f.state, runs: [pending] };
  const ref = {
    machine_id: "local",
    runtime_machine: "local",
    terminal_ref: "t-before-dispatch",
    agent_name: "fixture",
  };
  const p = { run_id: pending.id, runtime_ref: ref };
  const system = { kind: "system" as const, project_id: state.project_id };
  expect(retainUnconfirmedLaunch(state, human, p, f.io).ok).toBe(false);
  const retained = apply(
    state,
    value(retainUnconfirmedLaunch(state, system, p, f.io)),
  );
  expect(retained.runs[0]?.unconfirmed_runtime_ref).toEqual(ref);
  expect(occupiedRunSlots(retained.assignments, retained.runs, "local")).toBe(
    1,
  );
  expect(
    releaseAssignment(retained, human, { assignment_id: f.coder.id }, f.io).ok,
  ).toBe(false);
  expect(
    queueRun(
      retained,
      human,
      { assignment_id: f.coder.id, model: "fixture", agent_cli_version: "1" },
      f.io,
    ).ok,
  ).toBe(false);
  expect(
    value(
      retainUnconfirmedLaunch(
        retained,
        system,
        { ...p, runtime_ref: { ...ref, terminal_ref: "other" } },
        f.io,
      ),
    ).changes,
  ).toEqual([]);
  expect(retained.human_actions).toHaveLength(1);
});

test("an ambiguous provision keeps its original launch intent and slot without a fabricated ref", () => {
  const f = mergeFixture();
  const pending = {
    ...run(),
    assignment_id: f.coder.id,
    status: "failed" as const,
  };
  const state = { ...f.state, runs: [pending] };
  const provision_intent = {
    launch_id: pending.id,
    machine_id: "local",
    runtime_machine: "local",
    agent_name: "fixture",
    worktree_path: "/fixture/worktree",
  };
  const retained = apply(
    state,
    value(
      retainUnconfirmedLaunch(
        state,
        { kind: "system", project_id: state.project_id },
        { run_id: pending.id, provision_intent },
        f.io,
      ),
    ),
  );
  expect(retained.runs[0]?.unconfirmed_provision).toEqual(provision_intent);
  expect(retained.runs[0]?.unconfirmed_runtime_ref).toBeUndefined();
  expect(occupiedRunSlots(retained.assignments, retained.runs, "local")).toBe(
    1,
  );
  expect(
    releaseAssignment(retained, human, { assignment_id: f.coder.id }, f.io).ok,
  ).toBe(false);
  expect(
    queueRun(
      retained,
      human,
      { assignment_id: f.coder.id, model: "fixture", agent_cli_version: "1" },
      f.io,
    ).ok,
  ).toBe(false);
});

test("exit inspection is a fixed system notice bound to the original Assignment and target", () => {
  const f = mergeFixture();
  const ref = {
    machine_id: "local",
    runtime_machine: "local",
    terminal_ref: "t1",
    agent_name: "fixture",
  };
  const state = {
    ...f.state,
    assignments: f.state.assignments.map((a) =>
      a.id === f.coder.id ? { ...a, runtime_ref: ref } : a,
    ),
  };
  const system = { kind: "system" as const, project_id: state.project_id };
  const p = { assignment_id: f.coder.id, runtime_ref: ref };
  expect(requestRuntimeExitInspection(state, human, p, f.io).ok).toBe(false);
  expect(
    requestRuntimeExitInspection(state, f.actor(f.coder), p, f.io).ok,
  ).toBe(false);
  expect(
    value(
      requestRuntimeExitInspection(
        state,
        system,
        { ...p, runtime_ref: { ...ref, terminal_ref: "stale" } },
        f.io,
      ),
    ).changes,
  ).toEqual([]);
  const effect = value(requestRuntimeExitInspection(state, system, p, f.io));
  const notice = effect.changes.find((c) => c.collection === "human_actions");
  if (notice?.collection !== "human_actions")
    throw new Error("missing safety notice");
  expect(notice.entity).toMatchObject({
    status: "open",
    triage: "human",
    blocked_work_items: [],
  });
  const repeated = {
    ...state,
    human_actions: [{ ...notice.entity, status: "done" as const }],
  };
  expect(
    value(requestRuntimeExitInspection(repeated, system, p, f.io)).changes,
  ).toEqual([]);
  // Completing the notice does not alter the original runtime reference or grant exit proof.
  expect(effect.changes.some((c) => c.collection === "assignments")).toBe(
    false,
  );
});

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
