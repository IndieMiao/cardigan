import { beforeEach, expect, test } from "vitest";
import {
  commit,
  dispatch,
  f,
  queue,
  setup,
} from "./commands/launch/test-fixtures.js";
import { abortDispatch } from "./commands/launch.js";
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
  expect(isStandingPm({ ...pm, role_id: "observer" })).toBe(false);
  expect(occupiedRunSlots([pm], runs, "local")).toBe(3);
  expect(occupiedRunSlots([pm], runs, "other")).toBe(0);
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
