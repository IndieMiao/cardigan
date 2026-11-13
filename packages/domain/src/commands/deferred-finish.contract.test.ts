import { beforeEach, expect, test } from "vitest";
import {
  acknowledgeRun,
  type CommandPorts,
  finishRun,
  type Run,
  settlePendingRunFinish,
  transition,
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
import { human, value } from "./test-fixtures.js";

let run: Run;
beforeEach(() => {
  setup();
  run = commit(dispatch(commit(queue())));
  run = commit(acknowledgeRun(f.state, actor(), { run_id: run.id }, f.io));
  f.io = {
    ...f.io,
    run_token: {
      id: "authenticated-token-id",
      project_id: f.state.project_id,
      assignment_id: run.assignment_id,
      role_version: run.role_version,
      allowed_tools: ["finish_run"],
      revoked_at: null,
    },
  };
  f.state = {
    ...f.state,
    runs: f.state.runs.map((r) =>
      r.id === run.id
        ? {
            ...r,
            status: value(transition("run", r.status, "connection_lost")),
          }
        : r,
    ),
    assignments: f.state.assignments.map((a) =>
      a.id === run.assignment_id
        ? {
            ...a,
            runtime_state: value(
              transition("runtime", a.runtime_state, "connection_lost"),
            ),
          }
        : a,
    ),
  };
});
const params = () => ({
  run_id: run.id,
  outcome: "completed" as const,
  summary: "Delivered",
});
const request = () => finishRun(f.state, actor(), params(), f.io);
const settle = (by = system, runtime_ref = ref) =>
  settlePendingRunFinish(f.state, by, { run_id: run.id, runtime_ref }, f.io);
const reconnect = () => {
  f.state = {
    ...f.state,
    runs: f.state.runs.map((r) =>
      r.id === run.id
        ? { ...r, status: value(transition("run", r.status, "reconnected")) }
        : r,
    ),
    assignments: f.state.assignments.map((a) =>
      a.id === run.assignment_id
        ? {
            ...a,
            runtime_state: value(
              transition("runtime", a.runtime_state, "reconnected"),
            ),
          }
        : a,
    ),
  };
};

test("C-219 / invariants 8, 11: deferred finish is durable intent, not business completion or a new Run", () => {
  const work = f.state.work_items;
  const result = commit(request());
  expect(result).toMatchObject({
    status: "unknown",
    pending_finish: {
      outcome: "completed",
      summary: "Delivered",
      runtime_ref: ref,
    },
  });
  expect(result.finished_at).toBeUndefined();
  expect(value(request())).toMatchObject({ changes: [], events: [] });
  expect(value(settle())).toMatchObject({ changes: [], events: [] });
  reconnect();
  expect(commit(settle())).toMatchObject({
    status: "completed",
    outcome: "completed",
    summary: "Delivered",
  });
  expect(f.state.runs).toHaveLength(1);
  expect(f.state.runs[0]?.pending_finish).toBeUndefined();
  expect(f.state.work_items).toEqual(work);
  expect(value(settle())).toMatchObject({ changes: [], events: [] });
  expect(f.state.events.filter((e) => e.type === "run_finished")).toHaveLength(
    1,
  );
});

test("C-219 / invariant 11: ownership and host-only confirmation cannot be bypassed", () => {
  expect(finishRun(f.state, actor(f.reviewer), params(), f.io)).toMatchObject({
    ok: false,
    error: { code: "unauthorized" },
  });
  commit(request());
  reconnect();
  for (const by of [
    actor(),
    human,
    { ...system, project_id: "another-project" },
  ])
    expect(settle(by)).toMatchObject({
      ok: false,
      error: { code: "unauthorized" },
    });
});

test("C-219 conflicting retries cannot overwrite an accepted finish intent", () => {
  commit(request());
  const before = f.state;
  for (const change of [
    { summary: "Another result" },
    { outcome: "failed" as const },
  ])
    expect(
      finishRun(f.state, actor(), { ...params(), ...change }, f.io),
    ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
  expect(f.state).toEqual(before);
});

test.each([
  "cancelled",
  "released",
  "replaced",
  "token",
  "role",
  "dispatch_stop",
  "inactivity_stop",
  "host_ops",
])("C-219 deferred finish cannot settle after %s changes", (change) => {
  commit(request());
  reconnect();
  f.state = {
    ...f.state,
    assignments: f.state.assignments.map((a) =>
      a.id !== run.assignment_id
        ? a
        : {
            ...a,
            ...(change === "released" ? { status: "released" as const } : {}),
            ...(change === "replaced"
              ? { runtime_ref: { ...ref, terminal_ref: "replacement" } }
              : {}),
            ...(change === "role" ? { role_version: a.role_version + 1 } : {}),
          },
    ),
    runs: f.state.runs.map((r) =>
      r.id !== run.id
        ? r
        : {
            ...r,
            ...(change === "cancelled" ? { status: "cancelled" as const } : {}),
            ...(change === "dispatch_stop"
              ? {
                  dispatch_stop: {
                    attempt_id: r.trigger_event_id,
                    runtime_ref: ref,
                    lease_until: f.io.clock.now(),
                    stopping: true,
                    reason: "dispatch_timeout" as const,
                  },
                }
              : {}),
            ...(change === "inactivity_stop"
              ? {
                  inactivity_stop: {
                    attempt_id: "stop",
                    runtime_ref: ref,
                    lease_until: f.io.clock.now(),
                    stopping: true,
                  },
                }
              : {}),
          },
    ),
    events:
      change === "host_ops"
        ? [
            ...f.state.events,
            {
              id: f.io.ids.nextEventId(),
              seq: 999,
              type: "host_ops_action_taken",
              actor: system,
              created_at: f.io.clock.now(),
              payload: {
                execution: true,
                assignment_id: run.assignment_id,
                action_id: "stop",
                tool: "host_ops_cancel_run",
                target_id: run.id,
              },
            },
          ]
        : f.state.events,
  };
  if (change === "token")
    f.io = {
      ...f.io,
      run_token: { ...tokenEvidence(), id: "replacement-token-id" },
    };
  expect(value(settle())).toMatchObject({ changes: [], events: [] });
});

test("C-219 a stale observation cannot confirm a different RuntimeRef", () => {
  commit(request());
  reconnect();
  expect(
    value(settle(system, { ...ref, terminal_ref: "other" })),
  ).toMatchObject({ changes: [], events: [] });
});

const tokenEvidence = (): NonNullable<CommandPorts["run_token"]> => {
  if (!f.io.run_token) throw new Error("Missing token evidence");
  return f.io.run_token;
};

test.each(["missing", "revoked", "assignment", "project", "version", "scope"])(
  "C-219 invalid Token evidence (%s) cannot accept or settle a deferred finish",
  (mode) => {
    const validPorts = f.io;
    const invalidPorts = {
      ...f.io,
      run_token: {
        ...tokenEvidence(),
        ...(mode === "revoked" ? { revoked_at: f.io.clock.now() } : {}),
        ...(mode === "assignment" ? { assignment_id: f.reviewer.id } : {}),
        ...(mode === "project" ? { project_id: "another-project" } : {}),
        ...(mode === "version" ? { role_version: run.role_version + 1 } : {}),
        ...(mode === "scope" ? { allowed_tools: [] } : {}),
      },
    } as CommandPorts;
    const missingPorts: CommandPorts = { clock: f.io.clock, ids: f.io.ids };
    f.io = mode === "missing" ? missingPorts : invalidPorts;
    expect(request()).toMatchObject({
      ok: false,
      error: { code: "unauthorized" },
    });
    f.io = validPorts;
    commit(request());
    reconnect();
    f.io = mode === "missing" ? missingPorts : invalidPorts;
    expect(value(settle())).toMatchObject({ changes: [], events: [] });
  },
);
