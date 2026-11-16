import { beforeEach, expect, test } from "vitest";
import {
  abortDispatch,
  acknowledgeRun,
  c3ExitCandidate,
  claimDispatchStop,
  dispatchRecoveryUsed,
  type Run,
  type RuntimeRef,
  recoverDispatch,
  recoverPreparation,
  recoveryChainUsed,
  startDispatchStop,
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

const bound: RuntimeRef = {
  ...ref,
  target: {
    project_id: "fixture-project",
    machine_id: "local",
    session: "fixture",
    generation: "fixture",
    fingerprint: "a".repeat(64),
  },
  launch_generation: { run_id: "R-1" as never, generation: "fixture" },
};
beforeEach(() => {
  setup();
  f.state = {
    ...f.state,
    cards: f.state.cards.map((c) => ({ ...c, flow_version: 6 })),
  };
});
const current = (r: Run) => f.state.runs.find((n) => n.id === r.id) as Run;
function recover(
  run: Run,
  reason:
    | "runtime_exited"
    | "server_restart"
    | "dispatch_timeout" = "runtime_exited",
) {
  const claimed = commit(
    claimDispatchStop(
      f.state,
      system,
      { run_id: run.id, reason, lease_ms: 60000 },
      f.io,
    ),
  );
  if (!claimed?.dispatch_stop) throw new Error("Missing stop");
  const stop = claimed.dispatch_stop;
  expect(
    commit(
      startDispatchStop(
        f.state,
        system,
        { run_id: run.id, attempt_id: stop.attempt_id },
        f.io,
      ),
    ),
  ).toBe(true);
  return commit(
    recoverDispatch(
      f.state,
      system,
      {
        run_id: run.id,
        timeout_ms: 100,
        max_failures: 1,
        failed_attempts: 0,
        stop_id: stop.attempt_id,
        stopped_runtime: stop.runtime_ref,
      },
      f.io,
    ),
  );
}
function prepared(run: Run, category = "git_network") {
  commit(
    abortDispatch(
      f.state,
      system,
      { run_id: run.id, reason: "directory preparation failed" },
      f.io,
    ),
  );
  return commit(
    recoverPreparation(
      f.state,
      system,
      {
        run_id: run.id,
        category,
        execution_exited: true,
        cleanup_complete: true,
        expected_runtime_ref: null,
        backoff_ms: 5000,
      },
      f.io,
    ),
  );
}

test("a confirmed started exit cancels the old Run and queues one inherited successor, never success", () => {
  const run = commit(dispatch(commit(queue()), bound));
  commit(acknowledgeRun(f.state, actor(), { run_id: run.id }, f.io));
  expect(c3ExitCandidate(f.state, current(run))).toBe(true);
  const next = recover(current(run));
  expect(next).toMatchObject({
    status: "queued",
    kind: run.kind,
    recovery_policy: run.recovery_policy,
  });
  expect(current(run)).toMatchObject({
    status: "cancelled",
    outcome: "failed",
  });
  expect(current(run).dispatch_stop).toBeUndefined();
  expect(dispatchRecoveryUsed(f.state.events, run.assignment_id)).toBe(true);
  expect(recoveryChainUsed(f.state, run)).toBe(true);
  expect(f.state.events.filter((e) => e.type === "run_started")).toHaveLength(
    1,
  );
  expect(
    commit(
      claimDispatchStop(
        f.state,
        system,
        { run_id: run.id, reason: "runtime_exited", lease_ms: 60000 },
        f.io,
      ),
    ),
  ).toBeUndefined();
});

test.each(["preparation", "restart", "dispatch", "exit"])(
  "%s consumes the root across other recovery entry points",
  (first) => {
    let run = commit(queue());
    const root = run.recovery_policy;
    const next =
      first === "preparation"
        ? prepared(run)
        : recover(
            commit(dispatch(run, bound)),
            first === "restart"
              ? "server_restart"
              : first === "dispatch"
                ? "dispatch_timeout"
                : "runtime_exited",
          );
    if (!next) throw new Error("Missing successor");
    expect(next.recovery_policy).toEqual(root);
    expect(dispatchRecoveryUsed(f.state.events, run.assignment_id)).toBe(
      first === "dispatch" || first === "exit",
    );
    f.io = { ...f.io, clock: { now: () => "2026-01-01T00:01:00.000Z" } };
    run = commit(dispatch(next, bound));
    // Even server_restart cannot create a second automatic successor.
    expect(recover(run, "server_restart")).toBeUndefined();
    expect(f.state.runs).toHaveLength(2);
    expect(
      f.state.events.filter((e) => e.type === "run_dispatch_stalled"),
    ).toHaveLength(1);
  },
);

test("a later independent business root does not refill the Assignment lifetime budget", () => {
  const first = commit(dispatch(commit(queue()), bound));
  const next = recover(first);
  if (!next) throw new Error("Missing successor");
  commit(
    abortDispatch(
      f.state,
      system,
      { run_id: next.id, reason: "fixture finished" },
      f.io,
    ),
  );
  const later = commit(dispatch(commit(queue()), bound));
  expect(later.recovery_policy?.root_run_id).not.toBe(
    first.recovery_policy?.root_run_id,
  );
  expect(recover(later)).toBeUndefined();
  expect(f.state.runs).toHaveLength(3);
});

test.each([1, 5])(
  "flow %i keeps the old policy through an in-flight upgrade",
  (version) => {
    f.state = {
      ...f.state,
      cards: f.state.cards.map((c) => ({ ...c, flow_version: version })),
    };
    const old = commit(dispatch(commit(queue()), bound));
    f.state = {
      ...f.state,
      cards: f.state.cards.map((c) => ({ ...c, flow_version: 6 })),
    };
    expect(old.recovery_policy).toBeUndefined();
    expect(c3ExitCandidate(f.state, old)).toBe(false);
    expect(
      commit(
        claimDispatchStop(
          f.state,
          system,
          { run_id: old.id, reason: "runtime_exited", lease_ms: 60000 },
          f.io,
        ),
      ),
    ).toBeUndefined();
  },
);

test.each([
  "blocked",
  "waiting_decision",
  "delivered",
  "accepted",
  "cancelled",
  "passed",
])("%s business cannot get another start", (status) => {
  const run = commit(dispatch(commit(queue()), bound));
  f.state = {
    ...f.state,
    work_items: f.state.work_items.map((w) =>
      w.id === f.coder.work_item_id ? { ...w, status: status as never } : w,
    ),
  };
  expect(c3ExitCandidate(f.state, run)).toBe(false);
});

test.each([
  "missing_generation",
  "changed_session",
  "downgrade",
  "external",
  "suspended",
  "pending_finish",
])("%s cannot authorize C3 recovery", (change) => {
  const run = commit(
    dispatch(commit(queue()), change === "missing_generation" ? ref : bound),
  );
  if (change === "downgrade")
    f.state = {
      ...f.state,
      cards: f.state.cards.map((c) => ({ ...c, flow_version: 5 })),
    };
  if (change === "pending_finish")
    f.state = {
      ...f.state,
      runs: f.state.runs.map((r) => ({
        ...r,
        pending_finish: {
          outcome: "completed",
          summary: "done",
          runtime_ref: bound,
          token_id: "fixture",
        },
      })),
    };
  if (["external", "suspended", "changed_session"].includes(change))
    f.state = {
      ...f.state,
      assignments: f.state.assignments.map((a) =>
        a.id !== run.assignment_id
          ? a
          : {
              ...a,
              ...(change === "external"
                ? { external: true }
                : change === "suspended"
                  ? { status: "suspended" as const }
                  : { runtime_ref: { ...bound, terminal_ref: "new" } }),
            },
      ),
    };
  expect(c3ExitCandidate(f.state, current(run))).toBe(false);
});

test("runtime_unavailable requires proved preparation exit, cleanup and no old session", () => {
  expect(prepared(commit(queue()), "runtime_unavailable")?.status).toBe(
    "queued",
  );
  expect(
    prepared(current(f.state.runs[1] as Run), "runtime_unavailable"),
  ).toBeUndefined();
  expect(f.state.runs).toHaveLength(2);
});

test.each(["runtime_exited", "server_restart", "dispatch_timeout"] as const)(
  "preparation cannot bypass the root already consumed by %s",
  (reason) => {
    const next = recover(commit(dispatch(commit(queue()), bound)), reason);
    if (!next) throw new Error("Missing successor");
    expect(prepared(next)).toBeUndefined();
    expect(f.state.runs).toHaveLength(2);
    expect(
      f.state.events.some((e) => e.type === "run_preparation_stalled"),
    ).toBe(true);
  },
);

test.each(["execution", "cleanup", "session"])(
  "runtime_unavailable rejects missing %s proof",
  (missing) => {
    const run = commit(queue());
    commit(
      abortDispatch(
        f.state,
        system,
        { run_id: run.id, reason: "directory preparation failed" },
        f.io,
      ),
    );
    if (missing === "session")
      f.state = {
        ...f.state,
        assignments: f.state.assignments.map((a) =>
          a.id === run.assignment_id ? { ...a, runtime_ref: bound } : a,
        ),
      };
    expect(
      commit(
        recoverPreparation(
          f.state,
          system,
          {
            run_id: run.id,
            category: "runtime_unavailable",
            execution_exited: missing !== "execution",
            cleanup_complete: missing !== "cleanup",
            expected_runtime_ref: missing === "session" ? bound : null,
            backoff_ms: 5000,
          },
          f.io,
        ),
      ),
    ).toBeUndefined();
    expect(f.state.runs).toHaveLength(1);
  },
);

test("a claimed observation interrupted by target withdrawal cannot leave an unstarted fence forever", () => {
  const run = commit(dispatch(commit(queue()), bound));
  expect(
    commit(
      claimDispatchStop(
        f.state,
        system,
        { run_id: run.id, reason: "runtime_exited", lease_ms: 60000 },
        f.io,
      ),
    )?.dispatch_stop?.stopping,
  ).toBe(false);
  f.state = {
    ...f.state,
    work_items: f.state.work_items.map((w) =>
      w.id === f.coder.work_item_id && w.kind === "produce"
        ? { ...w, status: "delivered" as const }
        : w,
    ),
  };
  expect(
    commit(
      claimDispatchStop(
        f.state,
        system,
        { run_id: run.id, reason: "runtime_exited", lease_ms: 60000 },
        f.io,
      ),
    ),
  ).toBeUndefined();
  expect(current(run).dispatch_stop).toBeUndefined();
  expect(current(run).status).toBe("dispatched");
});

test("a current parallel verifier retains its rejected target, but a replacement delivery invalidates recovery", async () => {
  const { rejectedParallel } = await import(
    "./parallel-review/test-fixtures.js"
  );
  const { apply, id, value } = await import("./test-fixtures.js");
  const { queueRun, dispatchRun } = await import("../index.js");
  const fixture = await rejectedParallel(1);
  let state = {
    ...fixture.state,
    cards: fixture.state.cards.map((c) => ({ ...c, flow_version: 6 })),
    runs: fixture.state.runs.map((r) => ({
      ...r,
      status: "completed" as const,
    })),
  };
  const queued = value(
    queueRun(
      state,
      system,
      {
        assignment_id: id("assignment", 3),
        model: "fixture",
        agent_cli_version: "fixture",
      },
      fixture.io,
    ),
  );
  state = apply(state, queued) as typeof state;
  expect(queued.data.recovery_policy?.delivery_id).toBe(fixture.target.id);
  const dispatched = value(
    dispatchRun(
      state,
      system,
      { run_id: queued.data.id, runtime_ref: bound, base_sha: "a".repeat(40) },
      fixture.io,
    ),
  );
  state = apply(state, dispatched) as typeof state;
  expect(c3ExitCandidate(state, dispatched.data)).toBe(true);
  state = {
    ...state,
    deliveries: [
      ...state.deliveries,
      {
        ...fixture.target,
        id: id("delivery", 9999),
        status: "submitted",
        supersedes: fixture.target.id,
      },
    ],
  };
  expect(c3ExitCandidate(state, dispatched.data)).toBe(false);
});

test("queued successors recheck the original target at dispatch and retire without touching a newer session", async () => {
  const { retireRecoveryQueuedRun } = await import("../index.js");
  const first = commit(dispatch(commit(queue()), bound));
  const next = recover(first);
  if (!next) throw new Error("Missing successor");
  f.state = {
    ...f.state,
    work_items: f.state.work_items.map((w) =>
      w.id === f.coder.work_item_id && w.kind === "produce"
        ? { ...w, status: "blocked" as const }
        : w,
    ),
  };
  expect(dispatch(next)).toMatchObject({
    ok: false,
    error: { code: "stale_target" },
  });
  // A late queued cleanup may coexist with a newer host session observation.
  f.state = {
    ...f.state,
    assignments: f.state.assignments.map((a) =>
      a.id === next.assignment_id
        ? {
            ...a,
            runtime_state: "running" as const,
            runtime_ref: { ...bound, terminal_ref: "newer" },
          }
        : a,
    ),
  };
  const owner = f.state.assignments.find((a) => a.id === next.assignment_id);
  commit(retireRecoveryQueuedRun(f.state, system, { run_id: next.id }, f.io));
  expect(current(next).status).toBe("cancelled");
  expect(f.state.assignments.find((a) => a.id === next.assignment_id)).toEqual(
    owner,
  );
  expect(recoveryChainUsed(f.state, next)).toBe(true);
  expect(f.state.events.at(-1)?.type).toBe("run_recovery_abandoned");
});
