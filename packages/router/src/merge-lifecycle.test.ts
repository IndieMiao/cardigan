import { type MergeResult, recordMergeResult } from "@cardigan/domain";
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
