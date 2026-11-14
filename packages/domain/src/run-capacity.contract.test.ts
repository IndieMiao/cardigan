import { beforeEach, expect, test } from "vitest";
import {
  claimInactiveRunStop,
  DEFAULT_INACTIVE_CANCEL_AFTER_MS,
  finishInactiveRunStop,
  INACTIVE_STOP_LEASE_MS,
  startInactiveRunStop,
} from "./commands/inactive-run.js";
import {
  actor,
  commit,
  dispatch,
  f,
  queue,
  setup,
} from "./commands/launch/test-fixtures.js";
import { abortDispatch, acknowledgeRun } from "./commands/launch.js";
import { finishRun, heartbeat } from "./commands/runtime.js";
import type { Assignment, Run } from "./entities.js";
import {
  canDispatchRun,
  compareDispatchOrder,
  isStandingPm,
  occupiedRunSlots,
  type QueuedRun,
  runQueuePositions,
} from "./run-capacity.js";

beforeEach(setup);

test("capacity changes affect the next pure decision; standing PMs bypass the limit", () => {
  expect(canDispatchRun(4, 4, false)).toBe(false);
  expect(canDispatchRun(5, 4, false)).toBe(true);
  expect(canDispatchRun(3, 4, false)).toBe(false);
  expect(canDispatchRun(0, 4, true)).toBe(true);
  for (const limit of [0, -1, 0.5, Number.NaN, Infinity])
    expect(canDispatchRun(limit, 0, false)).toBe(false);
});

test("standing PMs occupy a slot; only dispatched/acked/running count on their machine", () => {
  const { work_item_id: _workItem, ...base } = f.coder;
  const pm: Assignment = { ...base, scope: "standing", role_id: "pm" };
  const run = commit(queue());
  const runs = (
    [
      "queued",
      "dispatched",
      "acked",
      "running",
      "unknown",
      "completed",
      "failed",
      "cancelled",
    ] as const
  ).map((status): Run => ({ ...run, status }));
  expect(isStandingPm(pm)).toBe(true);
  expect(isStandingPm({ ...f.coder, role_id: "pm" })).toBe(false);
  expect(isStandingPm({ ...pm, role_id: "observer" })).toBe(false);
  expect(occupiedRunSlots([pm], runs, "local")).toBe(3);
  expect(occupiedRunSlots([pm], runs, "other")).toBe(0);
  expect(canDispatchRun(3, occupiedRunSlots([pm], runs, "local"), true)).toBe(
    true,
  );
  expect(canDispatchRun(3, occupiedRunSlots([pm], runs, "local"), false)).toBe(
    false,
  );
});

const entry = (
  project_id: string,
  seconds: number,
  run_id = "R-1",
  machine_id = "local",
): QueuedRun => ({
  project_id,
  run_id,
  machine_id,
  assignment_id: "A-1",
  trigger_event_id: `event-${seconds}`,
  created_at: `2030-01-01T00:00:0${seconds}.000Z`,
});

test("cross-project FIFO uses trigger time; repeated saturated ticks never mutate queued relative order", () => {
  const queue = [
    entry("first-project", 3),
    entry("second-project", 1),
    entry("first-project", 2, "R-2"),
    entry("other-machine", 0, "R-1", "other"),
  ];
  const original = [...queue];
  const expected = [
    ["other-machine", "R-1", 0],
    ["second-project", "R-1", 0],
    ["first-project", "R-2", 1],
    ["first-project", "R-1", 2],
  ];
  for (const limit of [4, 2, 1]) {
    expect(canDispatchRun(limit, 4, false)).toBe(false);
    expect(
      runQueuePositions(queue).map((r) => [r.project_id, r.run_id, r.ahead]),
    ).toEqual(expected);
    expect(queue).toEqual(original);
  }
  const equalTime = [entry("z", 1), entry("a", 1)];
  expect([...equalTime].reverse().sort(compareDispatchOrder)).toEqual(
    equalTime.sort(compareDispatchOrder),
  );
});

test("dispatch consumes the original queued Run and clears only its capacity wait metadata", () => {
  const run = commit(queue());
  f.state = {
    ...f.state,
    runs: [{ ...run, queue_reason: "concurrency_limit" }],
  };
  const started = commit(dispatch(run));
  expect(started.id).toBe(run.id);
  expect(started.trigger_event_id).toBe(run.trigger_event_id);
  expect(started.status).toBe("dispatched");
  expect(started).not.toHaveProperty("queue_reason");
});

test("cancelling a queued startup fences every later dispatch of that Run", () => {
  const run = commit(queue());
  commit(
    abortDispatch(
      f.state,
      { kind: "system", project_id: f.state.project_id },
      {
        run_id: run.id,
        reason: "startup lease expired",
      },
      f.io,
    ),
  );
  expect(dispatch(run)).toMatchObject({
    ok: false,
    error: { code: "illegal_transition" },
  });
  expect(f.state.runs[0]).toMatchObject({
    status: "cancelled",
    outcome: "failed",
    trigger_event_id: run.trigger_event_id,
  });
});

function inactiveFixture() {
  const run = commit(queue());
  commit(dispatch(run));
  commit(acknowledgeRun(f.state, actor(), { run_id: run.id }, f.io));
  let now = Date.parse(f.io.clock.now());
  f.io = { ...f.io, clock: { now: () => new Date(now).toISOString() } };
  const system = { kind: "system" as const, project_id: f.state.project_id };
  const advance = (ms: number) => {
    now += ms;
  };
  const claim = () =>
    commit(
      claimInactiveRunStop(
        f.state,
        system,
        { run_id: run.id, after_ms: DEFAULT_INACTIVE_CANCEL_AFTER_MS },
        f.io,
      ),
    );
  const start = (attempt_id: string) =>
    commit(
      startInactiveRunStop(
        f.state,
        system,
        {
          run_id: run.id,
          attempt_id,
          after_ms: DEFAULT_INACTIVE_CANCEL_AFTER_MS,
        },
        f.io,
      ),
    );
  return { run, system, advance, claim, start };
}

test("q(86) requires the grace and rechecks new heartbeat activity before issuing a stop", () => {
  const t = inactiveFixture();
  expect(t.claim()).toBeUndefined();
  t.advance(DEFAULT_INACTIVE_CANCEL_AFTER_MS);
  const stop = t.claim()?.inactivity_stop;
  if (!stop) throw new Error("Missing stop intent");
  t.advance(1);
  const caller = actor();
  if (caller.kind !== "assignment") throw new Error("Missing fixture actor");
  commit(
    heartbeat(
      f.state,
      { ...caller, allowed_tools: [...caller.allowed_tools, "heartbeat"] },
      { run_id: t.run.id },
      f.io,
    ),
  );
  expect(t.start(stop.attempt_id)).toBeUndefined();
  expect(f.state.runs[0]).toMatchObject({ status: "running" });
  expect(f.state.runs[0]?.inactivity_stop).toBeUndefined();
});

test("q(86) rejects unproven exit and Agent authority, and cancellation preserves the worktree and work item", () => {
  const t = inactiveFixture();
  t.advance(DEFAULT_INACTIVE_CANCEL_AFTER_MS);
  const stop = t.claim()?.inactivity_stop;
  if (!stop) throw new Error("Missing stop intent");
  t.start(stop.attempt_id);
  const itemBefore = f.state.work_items;
  const ownerBefore = f.state.assignments.find(
    (a) => a.id === t.run.assignment_id,
  );
  const input = {
    run_id: t.run.id,
    attempt_id: stop.attempt_id,
    runtime_ref: stop.runtime_ref,
    exited: true,
  };
  expect(finishInactiveRunStop(f.state, actor(), input, f.io)).toMatchObject({
    ok: false,
    error: { code: "unauthorized" },
  });
  expect(
    finishInactiveRunStop(f.state, t.system, { ...input, exited: false }, f.io),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  const ended = commit(finishInactiveRunStop(f.state, t.system, input, f.io));
  expect(ended).toMatchObject({ status: "cancelled", outcome: "failed" });
  expect(ended?.inactivity_stop).toBeUndefined();
  expect(f.state.work_items).toEqual(itemBefore);
  expect(
    f.state.assignments.find((a) => a.id === t.run.assignment_id),
  ).toMatchObject({
    worktree_path: ownerBefore?.worktree_path,
    branch: ownerBefore?.branch,
    base_sha: ownerBefore?.base_sha,
  });
});

test("q(86) holds capacity and launch exclusion during stop even if the Run finishes or becomes unknown", () => {
  const t = inactiveFixture();
  t.advance(DEFAULT_INACTIVE_CANCEL_AFTER_MS);
  const stop = t.claim()?.inactivity_stop;
  if (!stop) throw new Error("Missing stop intent");
  t.start(stop.attempt_id);
  commit(
    finishRun(
      f.state,
      actor(),
      {
        run_id: t.run.id,
        outcome: "completed",
        summary: "finished during release",
      },
      f.io,
    ),
  );
  expect(occupiedRunSlots(f.state.assignments, f.state.runs, "local")).toBe(1);
  expect(queue()).toMatchObject({
    ok: false,
    error: { code: "invariant_violation" },
  });
  const ended = commit(
    finishInactiveRunStop(
      f.state,
      t.system,
      {
        run_id: t.run.id,
        attempt_id: stop.attempt_id,
        runtime_ref: stop.runtime_ref,
        exited: true,
      },
      f.io,
    ),
  );
  expect(ended).toMatchObject({
    status: "completed",
    outcome: "completed",
    summary: "finished during release",
  });
  expect(occupiedRunSlots(f.state.assignments, f.state.runs, "local")).toBe(0);
  expect(queue().ok).toBe(true);
});

test("q(86) a recovered stop rejects the previous owner's late result", () => {
  const t = inactiveFixture();
  t.advance(DEFAULT_INACTIVE_CANCEL_AFTER_MS);
  const old = t.claim()?.inactivity_stop;
  if (!old) throw new Error("Missing stop intent");
  t.start(old.attempt_id);
  f.state = {
    ...f.state,
    runs: f.state.runs.map((r) => ({ ...r, status: "unknown" as const })),
  };
  expect(occupiedRunSlots(f.state.assignments, f.state.runs, "local")).toBe(1);
  t.advance(INACTIVE_STOP_LEASE_MS);
  const current = t.claim()?.inactivity_stop;
  expect(current?.attempt_id).not.toBe(old.attempt_id);
  expect(
    commit(
      finishInactiveRunStop(
        f.state,
        t.system,
        {
          run_id: t.run.id,
          attempt_id: old.attempt_id,
          runtime_ref: old.runtime_ref,
          exited: true,
        },
        f.io,
      ),
    ),
  ).toBeUndefined();
  expect(f.state.runs[0]?.inactivity_stop).toEqual(current);
});

test("q(86) a replaced runtime is never cancelled by an old stop result", () => {
  const t = inactiveFixture();
  t.advance(DEFAULT_INACTIVE_CANCEL_AFTER_MS);
  const stop = t.claim()?.inactivity_stop;
  if (!stop) throw new Error("Missing stop intent");
  t.start(stop.attempt_id);
  const replacement = {
    ...stop.runtime_ref,
    terminal_ref: "replacement-terminal",
  };
  f.state = {
    ...f.state,
    assignments: f.state.assignments.map((a) =>
      a.id === t.run.assignment_id ? { ...a, runtime_ref: replacement } : a,
    ),
  };
  expect(
    commit(
      finishInactiveRunStop(
        f.state,
        t.system,
        {
          run_id: t.run.id,
          attempt_id: stop.attempt_id,
          runtime_ref: stop.runtime_ref,
          exited: true,
        },
        f.io,
      ),
    ),
  ).toBeUndefined();
  expect(f.state.runs[0]?.status).toBe("running");
  expect(
    f.state.assignments.find((a) => a.id === t.run.assignment_id)?.runtime_ref,
  ).toEqual(replacement);
});

test("priority wins across projects and machines; equal tiers retain FIFO and edits reorder only queued runs", () => {
  const low = { ...entry("a", 1), priority: 1 };
  const high = { ...entry("b", 3), priority: 3 };
  const peer = { ...entry("c", 2), priority: 3 };
  expect(
    runQueuePositions([low, high, peer]).map((r) => [r.project_id, r.ahead]),
  ).toEqual([
    ["c", 0],
    ["b", 1],
    ["a", 2],
  ]);
  expect(
    runQueuePositions([{ ...low, priority: 4 }, high, peer]).map(
      (r) => r.project_id,
    ),
  ).toEqual(["a", "c", "b"]);
  expect(low.priority).toBe(1);
});
