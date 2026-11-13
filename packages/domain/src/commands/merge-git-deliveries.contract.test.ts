import { expect, test } from "vitest";
import { mergePlan, recordDecision, recordMergeResult } from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { human, value } from "./test-fixtures.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

test.each(["code", "doc", "design", "test_report", "other"] as const)(
  "S19 invariants 13, 14: accepted %s Git commits require human confirmation and enter the merge plan",
  async (kind) => {
    const f = mergeFixture();
    const product = await f.deliver(kind);
    f.review(product);
    const completion = await f.deliver(
      "card_completion",
      product.subject.value,
    );
    f.review(completion);
    expect(f.state.cards[0]).toMatchObject({
      status: "awaiting_merge",
      merge_policy: "confirm",
    });
    expect(f.state.cards[0]?.resolution).toBeUndefined();
    const q = f.state.decisions.find((d) => d.trigger === "merge_confirmation");
    expect(q).toMatchObject({
      status: "open",
      decider: "human",
      plain_summary: TEST_PLAIN_SUMMARY,
      blocking: true,
      target: { delivery_id: completion.id },
    });
    expect(mergePlan(f.state, f.card.id)).toMatchObject({
      ok: false,
      error: {
        code: "illegal_transition",
        message: expect.stringContaining("confirmation"),
      },
    });
    if (!q) throw new Error("Missing merge confirmation");
    f.commit(
      recordDecision(
        f.state,
        human,
        {
          decision_id: q.id,
          option: "merge",
          rationale: "Approved Git delivery",
          raw_quote: "Merge this commit",
        },
        f.io,
      ),
    );
    expect(value(mergePlan(f.state, f.card.id)).deliveries).toEqual([
      {
        delivery_id: product.id,
        work_item_id: product.work_item_id,
        sha: product.subject.value,
      },
    ]);
    // Confirmation permits the host merge; it does not prematurely mark the card done.
    expect(f.state.cards[0]?.status).toBe("awaiting_merge");
    f.commit(
      recordMergeResult(
        f.state,
        { kind: "system", project_id: f.state.project_id },
        {
          card_id: f.card.id,
          completion_id: completion.id,
          result: {
            kind: "merged",
            merge_sha: "b".repeat(40),
            previous_sha: "c".repeat(40),
          },
        },
        f.io,
      ),
    );
    expect(f.state.cards[0]).toMatchObject({
      status: "done",
      resolution: "done",
    });
  },
);
