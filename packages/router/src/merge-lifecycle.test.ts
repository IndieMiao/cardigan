import {
  autoConfirmMerge,
  type MergeResult,
  recordDecision,
  recordMergeCheck,
  recordMergeResult,
  requestDeliveryRework,
  setCardSensitive,
  setProjectPreferences,
  withdrawReview,
} from "@cardigan/domain";
import { expect, test } from "vitest";
import { mergeFixture } from "../../domain/src/commands/merge/test-fixtures.js";
import { value } from "../../domain/src/commands/test-fixtures.js";
import { routeEvent } from "./index.js";

test.each(["merged", "conflicted", "failed"] as const)(
  "M4.1 routes real %s results to the owner or PM Ops",
  async (kind) => {
    const f = mergeFixture("auto");
    const { product, completion } = await f.accept();
    const review = f.state.events.findLast(
      (e) => e.type === "review_submitted",
    );
    if (!review) throw new Error("Missing review event");
    expect(
      routeEvent({ event: review, snapshot: f.state }).notifications.some(
        (n) => n.rule === "6.4/all required work items passed",
      ),
    ).toBe(false);
    const result: MergeResult =
      kind === "merged"
        ? { kind, merge_sha: "b".repeat(40), previous_sha: "a".repeat(40) }
        : kind === "conflicted"
          ? { kind, delivery_id: product.id, files: ["file.ts"] }
          : { kind, reason: "Git failed" };
    const effect = value(
      recordMergeResult(
        f.state,
        { kind: "system", project_id: f.state.project_id },
        { card_id: f.card.id, completion_id: completion.id, result },
        f.io,
      ),
    );
    f.commit({ ok: true, value: effect });
    const event = effect.events[0];
    if (!event) throw new Error("Missing merge event");
    const routed = routeEvent({ event, snapshot: f.state });
    if (kind === "merged") {
      expect(routed.notifications).toHaveLength(0);
      return;
    }
    expect(routed.notifications).toHaveLength(1);
    expect(routed.notifications[0]).toMatchObject(
      kind === "conflicted"
        ? {
            recipient: { kind: "assignment", assignment_id: f.coder.id },
            work_item_id: f.coder.work_item_id,
            run_kind: "fix",
          }
        : {
            recipient: { kind: "pm_ops" },
            kind: kind === "failed" ? "escalation" : "completion",
          },
    );
    if (kind === "conflicted") {
      const snapshot = {
        ...f.state,
        assignments: f.state.assignments.filter((a) => a.id !== f.coder.id),
      };
      expect(
        routeEvent({ event, snapshot }).notifications[0]?.recipient.kind,
      ).toBe("pm_ops");
    }
  },
);

const missing = (): never => {
  throw new Error("Missing fixture");
};

test("M4.1 reconciliation findings route to PM Ops without a card", () => {
  const f = mergeFixture();
  const source = f.state.events[0];
  if (!source) throw new Error("Missing event");
  const { card_id: _card, ...event } = source;
  const result = routeEvent({
    event: { ...event, type: "reconcile_finding", payload: { kind: "orphan" } },
    snapshot: f.state,
  });
  expect(result.notifications).toHaveLength(1);
  expect(result.notifications[0]).toMatchObject({
    recipient: { kind: "pm_ops" },
    kind: "escalation",
    rule: "6.4/reconcile finding",
  });
});

// C-66 / C-115: ordinary failures allow PM handling after confirmation;
// human-only merges allow only structured timeout rechecks, even before it.
const failureCases = [
  {
    failure: "failed",
    status: "failed",
    steps: ["failed"],
    timeoutOnly: false,
  },
  {
    failure: "timed_out",
    status: "timed_out",
    steps: ["timed_out"],
    timeoutOnly: true,
  },
  {
    failure: "step timeout",
    status: "failed",
    steps: ["passed", "timed_out", "not_run"],
    timeoutOnly: true,
  },
  {
    failure: "timeout with failed step",
    status: "timed_out",
    steps: ["failed", "timed_out"],
    timeoutOnly: false,
  },
  {
    failure: "timeout with interrupted step",
    status: "timed_out",
    steps: ["interrupted", "timed_out"],
    timeoutOnly: false,
  },
] as const;
test.each(
  (["human", "timeout", "sensitive"] as const).flatMap((mode) =>
    [false, true].flatMap((enabled) =>
      failureCases.map((failure) => ({
        mode,
        enabled,
        ...failure,
      })),
    ),
  ),
)(
  "a $mode-confirmed merge with $failure respects PM authorization when enabled=$enabled",
  async ({ mode, enabled, status, steps, timeoutOnly }) => {
    const f = mergeFixture("confirm");
    const human = { kind: "human", project_id: f.state.project_id } as const;
    const system = { kind: "system", project_id: f.state.project_id } as const;
    if (mode === "sensitive")
      f.commit(
        setCardSensitive(
          f.state,
          human,
          { card_id: f.card.id, sensitive: true },
          f.io,
        ),
      );
    f.commit(
      setProjectPreferences(
        f.state,
        human,
        { auto_merge_after_minutes: 1, pm_merge_confirmation: enabled },
        f.io,
      ),
    );
    const { completion } = await f.accept();
    const q = f.state.decisions.findLast(
      (d) => d.trigger === "merge_confirmation",
    );
    if (!q) throw new Error("Missing confirmation");
    expect(q).toMatchObject({ status: "open", decider: "human" });
    const identity = {
      card_id: f.card.id,
      completion_id: completion.id,
      attempt_id: "attempt-1",
      candidate_sha: "b".repeat(40),
      tree_sha: "c".repeat(40),
    };
    const gated = () => ({
      ...f.state,
      project_settings: { merge_gate_enabled: true },
    });
    f.commit(
      recordMergeCheck(
        gated(),
        system,
        { ...identity, status: "queued" },
        f.io,
      ),
    );
    f.commit(
      recordMergeCheck(
        gated(),
        system,
        { ...identity, status: "running" },
        f.io,
      ),
    );
    const failed = value(
      recordMergeCheck(
        gated(),
        system,
        {
          ...identity,
          status,
          // Log text must never authorize timeout handling on its own.
          summary: "test failed: timeout",
          log_ref: "attempt-1.log",
          checks: steps.map((status, index) => ({
            name: `check-${index}`,
            status,
            exit_code: status === "passed" ? 0 : null,
            duration_ms: 1,
          })),
        },
        f.io,
      ),
    );
    f.commit({ ok: true, value: failed });
    const finished = failed.events.find(
      (e) => e.type === "merge_check_finished",
    );
    if (!finished) throw new Error("Missing finished event");
    const timeoutNotice = expect.objectContaining({
      recipient: { kind: "pm_ops" },
      summary: expect.stringMatching(/仅可重新检查.*不能退回或代确认合并/),
    });
    const pending = routeEvent({
      event: finished,
      snapshot: f.state,
    }).notifications;
    if (mode === "sensitive" && enabled && timeoutOnly)
      expect(pending).toEqual([timeoutNotice]);
    else expect(pending).toEqual([]);
    const confirmed = value(
      mode === "timeout"
        ? autoConfirmMerge(
            f.state,
            system,
            { decision_id: q.id },
            {
              ...f.io,
              clock: { now: () => "2099-01-01T00:00:00.000Z" },
            },
          )
        : recordDecision(
            f.state,
            human,
            {
              decision_id: q.id,
              option: "merge",
              rationale: "合并",
              raw_quote: "合并",
            },
            f.io,
          ),
    );
    f.commit({ ok: true, value: confirmed });
    const resolved = confirmed.events.find(
      (e) => e.type === "decision_resolved",
    );
    if (!resolved) throw new Error("Missing resolution event");
    const routed = routeEvent({
      event: resolved,
      snapshot: f.state,
    }).notifications;
    if (!enabled || (mode === "sensitive" && !timeoutOnly))
      expect(routed).toEqual([]);
    else if (mode === "sensitive") expect(routed).toEqual([timeoutNotice]);
    else
      expect(routed).toEqual([
        expect.objectContaining({
          recipient: { kind: "pm_ops" },
          summary: expect.stringContaining("退回修改或重新检查"),
        }),
      ]);
    // The check-finished path reads the same current preference as confirmation.
    expect(
      routeEvent({ event: finished, snapshot: f.state }).notifications,
    ).toEqual(
      routed.map((n) => ({
        ...n,
        event_id: finished.id,
        seq: finished.seq,
        // Completion and confirmation describe different events, but both
        // must tell PM Ops that human-only cards permit rechecking only.
        summary:
          mode === "sensitive"
            ? expect.stringMatching(/仅可重新检查.*不能退回或代确认合并/)
            : n.summary,
      })),
    );
  },
);

test("C-116: the automatically rerun timeout does not wake PM; the second failure does", async () => {
  const f = mergeFixture("confirm");
  const human = { kind: "human", project_id: f.state.project_id } as const;
  const system = { kind: "system", project_id: f.state.project_id } as const;
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { auto_merge_after_minutes: 1, pm_merge_confirmation: true },
      f.io,
    ),
  );
  const { completion } = await f.accept();
  const q = f.state.decisions.findLast(
    (d) => d.trigger === "merge_confirmation",
  );
  if (!q) throw new Error("Missing confirmation");
  f.commit(
    recordDecision(
      f.state,
      human,
      {
        decision_id: q.id,
        option: "merge",
        rationale: "合并",
        raw_quote: "合并",
      },
      f.io,
    ),
  );
  const gated = () => ({
    ...f.state,
    project_settings: { merge_gate_enabled: true },
  });
  const attempt = (attempt_id: string) => {
    const identity = {
      card_id: f.card.id,
      completion_id: completion.id,
      attempt_id,
      candidate_sha: "b".repeat(40),
      tree_sha: "c".repeat(40),
    };
    for (const status of ["queued", "running"] as const)
      f.commit(
        recordMergeCheck(gated(), system, { ...identity, status }, f.io),
      );
    const effect = value(
      recordMergeCheck(
        gated(),
        system,
        {
          ...identity,
          status: "failed",
          summary: "Test timed out",
          log_ref: `${attempt_id}.log`,
          checks: [{ name: "test", status: "failed", exit_code: 1 }],
          timeout_only: true,
        },
        f.io,
      ),
    );
    f.commit({ ok: true, value: effect });
    const finished = effect.events.find(
      (e) => e.type === "merge_check_finished",
    );
    if (!finished) throw new Error("Missing finished event");
    return routeEvent({ event: finished, snapshot: f.state }).notifications;
  };
  expect(attempt("attempt-1")).toEqual([]);
  expect(attempt("attempt-2")).toEqual([
    expect.objectContaining({
      recipient: { kind: "pm_ops" },
      summary: expect.stringContaining("退回修改或重新检查"),
    }),
  ]);
});

test("A1a: version 2 failure routes only a fix to the producer, with PM as missing-owner fallback", async () => {
  const f = mergeFixture();
  const { completion } = await f.accept();
  const state = () => ({
    ...f.state,
    cards: f.state.cards.map((c) => ({ ...c, flow_version: 2 })),
    project_settings: { merge_gate_enabled: true },
  });
  const identity = {
    card_id: f.card.id,
    completion_id: completion.id,
    attempt_id: "flow-v2",
    candidate_sha: "b".repeat(40),
    tree_sha: "c".repeat(40),
  };
  const system = { kind: "system" as const, project_id: f.state.project_id };
  f.commit(
    recordMergeCheck(state(), system, { ...identity, status: "queued" }, f.io),
  );
  f.commit(
    recordMergeCheck(state(), system, { ...identity, status: "running" }, f.io),
  );
  const effect = value(
    recordMergeCheck(
      state(),
      system,
      {
        ...identity,
        status: "failed",
        checks: [{ name: "test", status: "failed", exit_code: 1 }],
        summary: "failed",
        failure_excerpt: "FAIL contract",
        log_ref: "flow-v2.log",
      },
      f.io,
    ),
  );
  // Even a snapshot from before the return must not send the old PM task.
  const finished = effect.events.find((e) => e.type === "merge_check_finished");
  const returned = effect.events.find(
    (e) => e.type === "merge_changes_requested",
  );
  if (!finished || !returned) throw new Error("Missing events");
  expect(
    routeEvent({ event: finished, snapshot: state() }).notifications,
  ).toEqual([]);
  f.commit({ ok: true, value: effect });
  expect(
    routeEvent({ event: returned, snapshot: state() }).notifications,
  ).toMatchObject([
    {
      recipient: { kind: "assignment", assignment_id: f.coder.id },
      run_kind: "fix",
      summary: expect.stringContaining("FAIL contract"),
    },
  ]);
  expect(
    routeEvent({
      event: returned,
      snapshot: {
        ...state(),
        assignments: state().assignments.filter((a) => a.id !== f.coder.id),
      },
    }).notifications,
  ).toMatchObject([{ recipient: { kind: "pm_ops" }, kind: "escalation" }]);
});

test("Q-659 human return routes a durable fix instruction to the original author, or escalates", async () => {
  const f = mergeFixture();
  const { product } = await f.accept();
  const review =
    f.state.reviews.find((r) => r.delivery_id === product.id) ?? missing();
  const human = { kind: "human" as const, project_id: f.state.project_id };
  f.commit(
    withdrawReview(
      f.state,
      f.actor(f.reviewer),
      { work_item_id: review.work_item_id, rationale: "New requirement" },
      f.io,
    ),
  );
  const q = f.commit(
    requestDeliveryRework(
      f.state,
      human,
      {
        work_item_id: product.work_item_id,
        delivery_id: product.id,
        target_sha: product.subject.value,
        review_id: review.id,
        rationale: "Implement requirement",
      },
      f.io,
    ),
  );
  f.commit(
    recordDecision(
      f.state,
      human,
      {
        decision_id: q.id,
        option: "return_for_rework",
        rationale: "Confirmed",
        raw_quote: "Confirmed",
      },
      f.io,
    ),
  );
  const event =
    f.state.events.findLast((e) => e.type === "merge_changes_requested") ??
    missing();
  const route = routeEvent({ event, snapshot: f.state });
  expect(route.notifications).toMatchObject([
    {
      kind: "instruction",
      work_item_id: product.work_item_id,
      run_kind: "fix",
      recipient: { kind: "assignment", assignment_id: f.coder.id },
    },
  ]);
  expect(routeEvent({ event, snapshot: f.state })).toEqual(route);
  const snapshot = {
    ...f.state,
    assignments: f.state.assignments.filter((a) => a.id !== f.coder.id),
  };
  expect(routeEvent({ event, snapshot }).notifications).toMatchObject([
    { kind: "escalation", recipient: { kind: "pm_ops" } },
  ]);
});

test("A1b: the first infrastructure failure stays silent and the second routes the system fix", async () => {
  const f = mergeFixture();
  const { completion } = await f.accept();
  const state = () => ({
    ...f.state,
    cards: f.state.cards.map((c) => ({ ...c, flow_version: 2 })),
    project_settings: { merge_gate_enabled: true },
  });
  const system = { kind: "system" as const, project_id: f.state.project_id };
  for (const attempt_id of ["infra-first", "infra-second"]) {
    const identity = {
      card_id: f.card.id,
      completion_id: completion.id,
      attempt_id,
      candidate_sha: "b".repeat(40),
      tree_sha: "c".repeat(40),
    };
    for (const status of ["queued", "running"] as const)
      f.commit(
        recordMergeCheck(state(), system, { ...identity, status }, f.io),
      );
    const effect = value(
      recordMergeCheck(
        state(),
        system,
        {
          ...identity,
          status: "failed",
          checks: [{ name: "test", status: "failed", exit_code: 1 }],
          summary: "worker stopped",
          log_ref: `${attempt_id}.log`,
          infra_flaky: true,
        },
        f.io,
      ),
    );
    f.commit({ ok: true, value: effect });
    const finished = effect.events.find(
      (e) => e.type === "merge_check_finished",
    );
    if (!finished) throw new Error("Missing finished event");
    expect(
      routeEvent({ event: finished, snapshot: f.state }).notifications,
    ).toEqual([]);
    const returned = effect.events.find(
      (e) => e.type === "merge_changes_requested",
    );
    if (attempt_id === "infra-first") expect(returned).toBeUndefined();
    else {
      if (!returned) throw new Error("Missing system return");
      expect(
        routeEvent({ event: returned, snapshot: f.state }).notifications,
      ).toContainEqual(
        expect.objectContaining({
          recipient: { kind: "assignment", assignment_id: f.coder.id },
          run_kind: "fix",
        }),
      );
    }
  }
});
