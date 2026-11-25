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

test("C-681: an unreachable event carries its own failure class and latest HTTP status", () => {
  const f = setup();
  const executor = "github-actions";
  const first = f.record({
    executor,
    status: "unreachable",
    attempt_id: "attempt-1",
    failure: {
      category: "dispatch_unknown",
      stage: "run_not_found",
      http_status: 200,
      request_id: "0400:3333:CCCC",
    },
  });
  expect(first.events).toHaveLength(1);
  expect(first.events[0]).toMatchObject({
    type: "merge_executor_unreachable",
    payload: {
      executor,
      attempt_id: "attempt-1",
      failure: {
        category: "dispatch_unknown",
        stage: "run_not_found",
        http_status: 200,
        request_id: "0400:3333:CCCC",
      },
    },
  });
  expect(mergeExecutorOutage(f.state(), executor)?.failure?.stage).toBe(
    "run_not_found",
  );
  // A later attempt without classified evidence must not inherit a stale cause.
  f.advance(60_000);
  const second = f.record({
    executor,
    status: "unreachable",
    attempt_id: "attempt-2",
  });
  expect(second.events[0]?.payload).not.toHaveProperty("failure");
  expect(second.data?.failure_count).toBe(2);
  f.advance(60_000);
  const third = f.record({
    executor,
    status: "unreachable",
    attempt_id: "attempt-3",
    failure: { category: "dispatch_unknown", stage: "push_incomplete" },
  });
  expect(third.events[0]?.payload).toMatchObject({
    failure: { category: "dispatch_unknown", stage: "push_incomplete" },
  });
  expect(third.events[0]?.payload).not.toHaveProperty("failure.http_status");
});

test.each([
  { category: "Dispatch Unknown" },
  { category: "dispatch_unknown", stage: "other" },
  { category: "dispatch_unknown", http_status: 99 },
  { category: "dispatch_unknown", http_status: 200.5 },
  { category: "dispatch_unknown", request_id: "Bearer ghs_secret" },
])("C-681: malformed failure evidence is rejected (%o)", (failure) => {
  const state = fixture();
  const result = recordMergeExecutor(
    state,
    { kind: "system", project_id: state.project_id },
    {
      executor: "ci",
      status: "unreachable",
      attempt_id: "attempt-1",
      failure: failure as never,
    },
    ports(),
  );
  expect(result).toMatchObject({
    ok: false,
    error: { code: "validation_failed" },
  });
});

test.each([
  ["push_timeout", "timeout", "候选推送超时"],
  ["push_rejected", "auth", "GitHub 拒绝或报错候选推送"],
  ["push_failed", "local", "候选推送在本机失败"],
] as const)(
  "C-758: %s is recorded as a push failure, not an unreachable executor, with the same backoff",
  (stage, push_failure, label) => {
    const f = setup();
    const executor = "github-actions";
    const failure = { category: "dispatch_unknown", stage, push_failure };
    const first = f.record({
      executor,
      status: "unreachable",
      attempt_id: "attempt-1",
      failure,
    });
    expect(first.events.map((e) => e.type)).toEqual([
      "merge_executor_push_failed",
    ]);
    expect(first.events[0]?.payload).toMatchObject({
      executor,
      attempt_id: "attempt-1",
      failure,
      failure_count: 1,
      description: `${label}，合并检查排队等待并按退避重试`,
    });
    expect(JSON.stringify(first.events)).not.toContain("不可达");
    // Same executor backoff state as before C-758: 1 minute, then doubling.
    const outage = mergeExecutorOutage(f.state(), executor);
    expect(
      Date.parse(outage?.next_retry_at ?? "") - Date.parse(f.io.clock.now()),
    ).toBe(60_000);
    // Replaying the same attempt neither counts again nor emits.
    expect(
      f.record({
        executor,
        status: "unreachable",
        attempt_id: "attempt-1",
        failure,
      }).events,
    ).toEqual([]);
    f.advance(60_000);
    const second = f.record({
      executor,
      status: "unreachable",
      attempt_id: "attempt-2",
      failure,
    });
    expect(second.data?.failure_count).toBe(2);
    expect(
      Date.parse(second.data?.next_retry_at ?? "") -
        Date.parse(f.io.clock.now()),
    ).toBe(2 * 60_000);
    // A persistent push failure escalates once with push-specific guidance.
    f.advance(31 * 60_000);
    const poll = f.record({ executor, status: "poll" });
    expect(poll.events.map((e) => e.type)).toEqual([
      "human_action_requested",
      "merge_executor_attention_required",
    ]);
    const action = f.state().human_actions[0];
    expect(action?.instructions).toContain("候选推送持续失败");
    expect(action?.instructions).toContain(label);
    expect(action?.instructions).not.toContain("SSH");
    expect(action?.why_human).toBe("候选推送已连续失败超过 30 分钟");
    const recovery = f.record({ executor, status: "reachable" });
    expect(recovery.events.map((e) => e.type)).toEqual([
      "human_action_cancelled",
      "merge_executor_recovered",
    ]);
    expect(recovery.events[1]?.payload).toMatchObject({
      description: "候选推送已恢复，合并检查自动继续",
    });
    expect(mergeExecutorOutage(f.state(), executor)).toBeUndefined();
  },
);

test("C-758: only a push that could not reach GitHub is recorded as an unreachable executor", () => {
  const f = setup();
  const failure = {
    category: "dispatch_unknown",
    stage: "push_unreachable",
    push_failure: "network",
  } as const;
  const effect = f.record({
    executor: "github-actions",
    status: "unreachable",
    attempt_id: "attempt-1",
    failure,
  });
  expect(effect.events.map((e) => e.type)).toEqual([
    "merge_executor_unreachable",
  ]);
  expect(effect.events[0]?.payload).toMatchObject({
    failure,
    description: "远程检查机不可达，合并检查排队等待并按退避重试",
  });
});

test.each(["not_sent", "push_cancelled"] as const)(
  "C-758: a local cancellation (%s) is not an executor observation",
  (stage) => {
    const f = setup();
    const executor = "github-actions";
    const cancelled = f.record({
      executor,
      status: "unreachable",
      attempt_id: "attempt-1",
      failure: { category: "dispatch_unknown", stage },
    });
    expect(cancelled.events).toEqual([]);
    expect(cancelled.data).toBeUndefined();
    expect(mergeExecutorOutage(f.state(), executor)).toBeUndefined();
    // During an existing outage it neither counts nor resets the backoff.
    const outage = f.record({
      executor,
      status: "unreachable",
      attempt_id: "attempt-2",
      failure: { category: "dispatch_unknown", stage: "run_not_found" },
    }).data;
    const during = f.record({
      executor,
      status: "unreachable",
      attempt_id: "attempt-3",
      failure: { category: "dispatch_unknown", stage },
    });
    expect(during.events).toEqual([]);
    expect(outage?.failure_count).toBe(1);
    expect(during.data).toEqual(mergeExecutorOutage(f.state(), executor));
    expect(mergeExecutorOutage(f.state(), executor)?.failure_count).toBe(1);
  },
);

test.each([
  { category: "dispatch_unknown", stage: "push_failed", push_failure: "boom" },
  {
    category: "dispatch_unknown",
    stage: "push_failed",
    push_failure: "Bearer ghs_x",
  },
])("C-758: malformed push failure evidence is rejected (%o)", (failure) => {
  const state = fixture();
  expect(
    recordMergeExecutor(
      state,
      { kind: "system", project_id: state.project_id },
      {
        executor: "ci",
        status: "unreachable",
        attempt_id: "attempt-1",
        failure: failure as never,
      },
      ports(),
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
});
