import { expect, test } from "vitest";
import {
  listNeedsYou,
  mergeExecutorOutage,
  recordMergeExecutor,
} from "../index.js";
import { actor, apply, fixture, human, ports, value } from "./test-fixtures.js";

function setup() {
  let state = fixture();
  let time = Date.parse("2030-01-01T00:00:00.000Z");
  const io = { ...ports(), clock: { now: () => new Date(time).toISOString() } };
  const system = { kind: "system" as const, project_id: state.project_id };
  const record = (p: Parameters<typeof recordMergeExecutor>[2]) => {
    const effect = value(recordMergeExecutor(state, system, p, io));
    state = apply(state, effect);
    return effect;
  };
  return {
    state: () => state,
    io,
    record,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

test("executor outage persists capped backoff, one nonblocking notice, and recovery", () => {
  const f = setup();
  const initialItems = f.state().work_items;
  const executor = "ci";
  for (const [i, minutes] of [1, 2, 4, 8, 16, 30, 30].entries()) {
    const failure = {
      executor,
      status: "unreachable" as const,
      attempt_id: `attempt-${i}`,
    };
    const outage = f.record(failure).data;
    expect(outage).toBeDefined();
    expect(mergeExecutorOutage(f.state(), "other-ci")).toBeUndefined();
    expect(
      Date.parse(outage?.next_retry_at ?? "") - Date.parse(f.io.clock.now()),
    ).toBe(minutes * 60_000);
    expect(f.record(failure).events).toEqual([]);
    f.advance(minutes * 60_000);
  }
  const actions = f.state().human_actions;
  expect(actions).toHaveLength(1);
  expect(actions[0]).toMatchObject({
    status: "open",
    blocked_work_items: [],
    requested_by: "system",
  });
  expect(actions[0]?.card_id).toBeUndefined();
  expect(actions[0]?.instructions).toContain("无需手动重排");
  expect(value(listNeedsYou(f.state(), human)).data.human_actions).toHaveLength(
    1,
  );
  expect(f.state().work_items).toEqual(initialItems);
  expect(f.record({ executor, status: "poll" }).events).toEqual([]);
  const recovery = f.record({ executor, status: "reachable" });
  expect(recovery.events.map((e) => e.type)).toEqual([
    "human_action_cancelled",
    "merge_executor_recovered",
  ]);
  expect(recovery.events.every((e) => !e.card_id)).toBe(true);
  expect(mergeExecutorOutage(f.state(), executor)).toBeUndefined();
  expect(value(listNeedsYou(f.state(), human)).data.human_actions).toEqual([]);
  expect(f.record({ executor, status: "reachable" }).events).toEqual([]);
  expect(
    f.record({ executor, status: "unreachable", attempt_id: "attempt-0" })
      .events,
  ).toEqual([]);
  expect(
    f.record({ executor, status: "unreachable", attempt_id: "new-outage" }).data
      ?.failure_count,
  ).toBe(1);
});

test("notice crosses 30 minutes between retries and cannot be duplicated by timer polls", () => {
  const f = setup();
  const executor = "ci";
  f.record({ executor, status: "unreachable", attempt_id: "first" });
  f.advance(30 * 60_000);
  expect(f.record({ executor, status: "poll" }).events).toEqual([]);
  f.advance(1);
  expect(
    f.record({ executor, status: "poll" }).events.map((e) => e.type),
  ).toEqual(["human_action_requested", "merge_executor_attention_required"]);
  expect(f.record({ executor, status: "poll" }).events).toEqual([]);
});

test("connectivity records reject non-system and cross-project actors without effects", () => {
  const f = setup();
  for (const caller of [
    human,
    actor(),
    { kind: "system" as const, project_id: "another" },
  ])
    expect(
      recordMergeExecutor(
        f.state(),
        caller,
        { executor: "ci", status: "unreachable", attempt_id: "first" },
        f.io,
      ),
    ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  expect(f.state().events).toEqual([]);
});
