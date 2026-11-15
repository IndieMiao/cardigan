import { expect, test } from "vitest";
import type { CommandState } from "./commands/core.js";
import { abortDispatch } from "./commands/launch.js";
import { recoverPreparation } from "./commands/preparation-recovery.js";
import {
  actor,
  apply,
  assignment,
  fixture,
  id,
  now,
  ports,
  run,
  subject,
  value,
} from "./commands/test-fixtures.js";
import { dispatchRunKind, dispatchTier } from "./dispatch-tier.js";
import type { Delivery, Event, JsonValue, Run } from "./entities.js";
import { parseEventId } from "./ids.js";
import { compareDispatchOrder, runQueuePositions } from "./run-capacity.js";

const owner = assignment(1);
const event = (type = "comment_posted", seq = 1): Event => ({
  id: value(parseEventId(`${"0".repeat(24)}${String(seq).padStart(2, "0")}`)),
  seq,
  type,
  actor: { kind: "system", project_id: "fixture-project" },
  card_id: id("card", 1),
  created_at: now,
  payload: {},
});
const product: Delivery = {
  id: id("delivery", 1),
  work_item_id: owner.work_item_id,
  run_id: id("run", 1),
  kind: "code",
  summary: "formal product",
  subject,
  evidence: [],
  attachments: [],
  known_gaps: [],
  requested_verifiers: [],
  status: "submitted",
};
const completion: Delivery = {
  ...product,
  id: id("delivery", 2),
  kind: "card_completion",
  status: "superseded",
};
const queued = (kind: Run["kind"] = "followup"): Run => ({
  ...run(4, 1),
  kind,
  status: "queued",
  trigger_event_id: event().id,
});
const state = (): CommandState => ({
  ...fixture(),
  runs: [run(1)],
  events: [event()],
  deliveries: [product, completion],
});
const rank = (s: CommandState, r = queued(), a = owner) =>
  dispatchTier(
    s,
    a,
    r,
    s.events.find((e) => e.id === r.trigger_event_id),
  ).dispatch_tier;
const repairState = (type = "merge_conflicted"): CommandState => {
  const cause = {
    ...event(type, 2),
    payload: { work_item_id: owner.work_item_id, completion_id: completion.id },
  };
  return { ...state(), events: [cause] };
};
const fix = (): Run => ({
  ...queued("fix"),
  trigger_event_id: event("", 2).id,
});

test("all verify work items use tier 2 regardless of Run kind, including PM acceptance", () => {
  for (const kind of [
    "initial",
    "fix",
    "rework",
    "followup",
    "decision_resumed",
  ] as const) {
    for (const n of [2, 3]) {
      const a = assignment(n, n === 3 ? "pm" : "reviewer");
      expect(rank(state(), { ...queued(kind), assignment_id: a.id }, a)).toBe(
        2,
      );
    }
  }
});

test("tier 3 requires formal product history on the same item; released history counts", () => {
  for (const kind of ["rework", "followup", "decision_resumed"] as const) {
    expect(rank(state(), queued(kind))).toBe(3);
    expect(
      rank(
        { ...state(), deliveries: [{ ...product, status: "superseded" }] },
        queued(kind),
      ),
    ).toBe(3);
    const historical = {
      ...assignment(9),
      work_item_id: owner.work_item_id,
      status: "released" as const,
    };
    expect(
      rank(
        {
          ...state(),
          assignments: [...state().assignments, historical],
          runs: [{ ...run(1), assignment_id: historical.id }],
        },
        queued(kind),
      ),
    ).toBe(3);
  }
  expect(rank(state(), queued("initial"))).toBe(4);
  for (const s of [
    { ...state(), deliveries: [] },
    { ...state(), deliveries: [completion] },
    {
      ...state(),
      deliveries: [{ ...product, work_item_id: id("work_item", 2) }],
    },
    { ...state(), runs: [] },
    { ...state(), runs: [{ ...run(1), assignment_id: id("assignment", 99) }] },
    { ...state(), runs: [run(1, 2)] },
    { ...state(), work_items: [] },
  ])
    expect(rank(s)).toBe(4);
});

test("first followup and self-reported fix labels/text never promote new output", () => {
  expect(rank({ ...state(), deliveries: [] })).toBe(4);
  expect(
    rank(state(), {
      ...queued("fix"),
      summary: "merge conflict; check failed",
    }),
  ).toBe(4);
  expect(rank(repairState(), { ...fix(), kind: "followup" })).toBe(3);
  const s = repairState();
  const originalCause = s.events[0] ?? event();
  for (const cause of [
    { ...originalCause, actor: actor(1) },
    {
      ...originalCause,
      actor: { kind: "system" as const, project_id: "other" },
    },
    { ...originalCause, card_id: id("card", 9) },
    {
      ...originalCause,
      payload: {
        work_item_id: id("work_item", 9),
        completion_id: completion.id,
      },
    },
    {
      ...originalCause,
      payload: { work_item_id: owner.work_item_id, completion_id: "D-99" },
    },
  ])
    expect(rank({ ...s, events: [cause] }, fix())).toBe(4);
});

test("only a bound control-plane conflict or a failed-check return gets tier 1", () => {
  expect(rank(repairState(), fix())).toBe(1);
  const returned = repairState("merge_changes_requested");
  expect(rank(returned, fix())).toBe(4);
  for (const status of ["failed", "timed_out", "passed", "running"] as const) {
    const check = {
      ...event("merge_check_finished"),
      payload: { completion_id: completion.id, status },
    };
    const s = { ...returned, events: [check, ...returned.events] };
    expect(rank(s, fix())).toBe(
      ["failed", "timed_out"].includes(status) ? 1 : 4,
    );
    expect(
      rank(
        { ...s, events: [{ ...check, actor: actor(1) }, ...returned.events] },
        fix(),
      ),
    ).toBe(4);
    expect(
      rank(
        {
          ...s,
          events: [
            { ...check, payload: { ...check.payload, completion_id: "D-99" } },
            ...returned.events,
          ],
        },
        fix(),
      ),
    ).toBe(4);
  }
});

test.each(["run_dispatch_recovered", "run_preparation_recovered"])(
  "%s and host restart preserve rank across replay; broken or cyclic provenance falls back",
  (recoveryType) => {
    const original = fix();
    const recovered = {
      ...fix(),
      id: id("run", 5),
      trigger_event_id: event("", 3).id,
    };
    const restart = {
      ...fix(),
      id: id("run", 6),
      trigger_event_id: event("", 4).id,
    };
    const recovery = {
      ...event(recoveryType, 3),
      payload: {
        assignment_id: owner.id,
        run_id: original.id,
        replacement_run_id: recovered.id,
        original_trigger_event_id: original.trigger_event_id,
      },
    };
    const host = {
      ...event("host_ops_action_finished", 4),
      payload: {
        assignment_id: owner.id,
        previous_run_id: recovered.id,
        run_id: restart.id,
        original_trigger_event_id: recovered.trigger_event_id,
      },
    };
    const s = {
      ...repairState(),
      runs: [original, recovered, restart],
      events: [...repairState().events, recovery, host],
    };
    expect(rank(s, restart)).toBe(1);
    expect(rank(JSON.parse(JSON.stringify(s)) as CommandState, restart)).toBe(
      1,
    );
    for (const change of [
      { ...host, actor: actor(1) },
      { ...host, payload: { ...host.payload, assignment_id: "A-99" } },
      { ...host, payload: { ...host.payload, previous_run_id: "R-99" } },
      {
        ...host,
        payload: { ...host.payload, original_trigger_event_id: "bad" },
      },
      {
        ...host,
        payload: {
          ...host.payload,
          previous_run_id: restart.id,
          original_trigger_event_id: restart.trigger_event_id,
        },
      },
    ])
      expect(
        rank({ ...s, events: [...s.events.slice(0, -1), change] }, restart),
      ).toBe(4);
  },
);

test.each(["conflict", "failed", "timed_out"])(
  "actual preparation recovery retains tier 1 for %s and rejects unbound provenance",
  (reason) => {
    const original = fix();
    const base = repairState(
      reason === "conflict" ? "merge_conflicted" : "merge_changes_requested",
    );
    let s: CommandState = {
      ...base,
      runs: [original],
      events:
        reason === "conflict"
          ? base.events
          : [
              {
                ...event("merge_check_finished"),
                payload: { completion_id: completion.id, status: reason },
              },
              ...base.events,
            ],
    };
    const io = ports();
    const system = { kind: "system" as const, project_id: s.project_id };
    expect(rank(s, original)).toBe(1);
    s = apply(
      s,
      value(
        abortDispatch(
          s,
          system,
          {
            run_id: original.id,
            reason: "directory preparation failed",
          },
          io,
        ),
      ),
    );
    const effect = value(
      recoverPreparation(
        s,
        system,
        {
          run_id: original.id,
          category: "repository_lock_timeout",
          execution_exited: true,
          cleanup_complete: true,
          expected_runtime_ref: null,
          backoff_ms: 5000,
        },
        io,
      ),
    );
    s = apply(s, effect);
    const next = effect.data;
    if (!next) throw new Error("Missing preparation successor");
    const recovery = s.events.find((e) => e.id === next.trigger_event_id);
    if (!recovery) throw new Error("Missing preparation event");
    expect(recovery.type).toBe("run_preparation_recovered");
    expect(next.kind).toBe("fix");
    expect(rank(s, next)).toBe(1);
    expect(rank(JSON.parse(JSON.stringify(s)) as CommandState, next)).toBe(1);
    for (const change of [
      { actor: actor(1) },
      { actor: { kind: "system" as const, project_id: "other" } },
      ...[
        "assignment_id",
        "run_id",
        "replacement_run_id",
        "original_trigger_event_id",
      ].map((key) => ({
        payload: {
          ...(recovery.payload as Record<string, JsonValue>),
          [key]: "unbound",
        },
      })),
    ]) {
      expect(
        rank(
          {
            ...s,
            events: s.events.map((e) =>
              e.id === recovery.id ? { ...e, ...change } : e,
            ),
          },
          next,
        ),
      ).toBe(4);
    }
    for (const change of [
      { assignment_id: id("assignment", 99) },
      { kind: "initial" as const },
      { trigger_event_id: event("", 99).id },
    ]) {
      expect(
        rank(
          {
            ...s,
            runs: s.runs.map((r) =>
              r.id === original.id ? { ...r, ...change } : r,
            ),
          },
          next,
        ),
      ).toBe(4);
    }
  },
);

test("four strict tiers precede priority and FIFO, with deterministic cross-project/machine positions", () => {
  const row = (
    tier: 1 | 2 | 3 | 4,
    priority: number,
    seconds: number,
    project_id = "p",
    machine_id = "local",
  ) => ({
    ...dispatchTier(state(), owner, queued(), event()),
    dispatch_tier: tier,
    priority,
    project_id,
    machine_id,
    run_id: `R-${tier}-${seconds}`,
    assignment_id: `A-${tier}`,
    created_at: `2030-01-01T00:00:0${seconds}.000Z`,
    trigger_event_id: `event-${seconds}`,
  });
  const rows = [
    row(4, 3, 0),
    row(3, -1, 0),
    row(2, 0, 3),
    row(1, -1, 4),
    row(2, 3, 2),
    row(2, 3, 1, "other"),
    row(4, 3, 0, "other", "other"),
  ];
  const expected = [
    rows[3],
    rows[5],
    rows[4],
    rows[2],
    rows[1],
    rows[6],
    rows[0],
  ];
  expect([...rows].sort(compareDispatchOrder)).toEqual(expected);
  expect([...rows].reverse().sort(compareDispatchOrder)).toEqual(expected);
  expect(runQueuePositions(rows).map((r) => r.ahead)).toEqual([
    0, 1, 2, 3, 4, 0, 5,
  ]);
  expect(rows[0]?.dispatch_tier).toBe(4);
});

test("new notification Run kind inference matches queueing, without trusting arbitrary run_kind payload", () => {
  expect(dispatchRunKind(event("work_item_assigned"), owner)).toBe("initial");
  expect(dispatchRunKind(event("merge_conflicted"), owner)).toBe("fix");
  expect(dispatchRunKind(event("review_submitted"), owner, true)).toBe(
    "rework",
  );
  expect(dispatchRunKind(event("decision_resolved"), owner)).toBe(
    "decision_resumed",
  );
  expect(
    dispatchRunKind({ ...event(), payload: { run_kind: "fix" } }, owner),
  ).toBe("followup");
});
