import {
  autoConfirmMerge,
  type MergeResult,
  recordDecision,
  recordMergeCheck,
  recordMergeResult,
  setCardSensitive,
  setProjectPreferences,
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

// P2a-1 §2.6 / C-66: a check that failed before the merge was confirmed.
test.each(
  (["human", "timeout", "sensitive"] as const).flatMap((mode) =>
    [false, true].flatMap((enabled) =>
      (["failed", "timed_out"] as const).map((status) => ({
        mode,
        enabled,
        status,
      })),
    ),
  ),
)(
  "a $mode-confirmed $status merge wakes PM Ops only when enabled=$enabled and not human-only",
  async ({ mode, enabled, status }) => {
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
          summary: "test failed",
          log_ref: "attempt-1.log",
          checks: [{ name: "test", status, exit_code: 1, duration_ms: 1 }],
        },
        f.io,
      ),
    );
    f.commit({ ok: true, value: failed });
    const finished = failed.events.find(
      (e) => e.type === "merge_check_finished",
    );
    if (!finished) throw new Error("Missing finished event");
    // Still open with the human: nothing for PM Ops yet.
    expect(
      routeEvent({ event: finished, snapshot: f.state }).notifications,
    ).toEqual([]);
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
    if (mode === "sensitive" || !enabled) expect(routed).toEqual([]);
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
      routed.map((n) => ({ ...n, event_id: finished.id, seq: finished.seq })),
    );
  },
);
