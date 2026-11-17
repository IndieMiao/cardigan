import { expect, test } from "vitest";
import {
  type Delivery,
  recordDecision,
  recordMergeResult,
  requestDecision,
  systemCompleteCard,
  updateWorkItem,
} from "../index.js";
import {
  flowReviewFixture,
  required,
} from "./flow-review-limit/test-fixtures.js";
import { human } from "./test-fixtures.js";

const system = { kind: "system" as const, project_id: human.project_id };

function setup(maxRaises: number, acceptanceLimit = 1) {
  const { f } = flowReviewFixture(maxRaises);
  for (const [owner, limit] of [
    [f.reviewer, 3],
    [f.pm, acceptanceLimit],
  ] as const)
    f.commit(
      updateWorkItem(
        f.state,
        human,
        {
          work_item_id: required(owner.work_item_id),
          max_review_rounds: limit,
        },
        f.io,
      ),
    );
  const complete = () =>
    f.commit(systemCompleteCard(f.state, system, { card_id: f.card.id }, f.io));
  const decide = (option: "merge" | "request_changes") => {
    const confirmation = required(
      f.state.decisions.find(
        (q) => q.trigger === "merge_confirmation" && q.status === "open",
      ),
    );
    f.commit(
      recordDecision(
        f.state,
        human,
        {
          decision_id: confirmation.id,
          option,
          rationale: "Review the current implementation",
          raw_quote: "Review the current implementation",
        },
        f.io,
      ),
    );
  };
  const accept = async () => {
    const product = await f.deliver();
    f.review(product);
    const completion = required(complete());
    f.review(completion);
    return { product, completion };
  };
  return { f, complete, decide, accept };
}

test.each([2, 0])(
  "B3a/B2: completion after ordinary rework settles acceptance budget with %i automatic raises",
  async (maxRaises) => {
    const { f, complete, decide, accept } = setup(maxRaises);
    const first = await accept();
    decide("request_changes");
    const product = await f.deliver("code", "b".repeat(40));
    f.review(product);
    const completion = required(complete());
    expect(completion).toMatchObject({
      status: "submitted",
      system_completion: {
        products: [{ delivery_id: product.id, subject: product.subject }],
      },
    });
    expect(completion.merge_conflict_event_id).toBeUndefined();
    expect(
      f.state.deliveries.find((v) => v.id === first.completion.id)?.status,
    ).toBe("superseded");
    expect(
      f.state.work_items.find((w) => w.id === f.pm.work_item_id),
    ).toMatchObject({ status: "ready", max_review_rounds: 1 });
    expect(
      f.state.events.filter((e) =>
        [
          "review_limit_raised_by_system",
          "review_limit_auto_raise_exhausted",
        ].includes(e.type),
      ),
    ).toEqual([]);
    const before = f.state.events.length;
    expect(complete()).toBeNull();
    expect(complete()).toBeNull();
    expect(f.state.events).toHaveLength(before);
    f.review(completion);
    expect(f.state.cards.find((c) => c.id === f.card.id)?.status).toBe(
      "awaiting_merge",
    );
  },
);

test.each([1, 3])(
  "B3a: conflict repair preserves its free completion review at acceptance limit %i",
  async (acceptanceLimit) => {
    const { f, complete, decide, accept } = setup(0, acceptanceLimit);
    const first = await accept();
    decide("merge");
    const conflictParams = {
      card_id: f.card.id,
      completion_id: first.completion.id,
      result: {
        kind: "conflicted" as const,
        delivery_id: first.product.id,
        files: ["file.ts"],
      },
    };
    f.commit(recordMergeResult(f.state, system, conflictParams, f.io));
    const event = required(
      f.state.events.find((e) => e.type === "merge_conflicted"),
    );
    // Replaying the same host outcome must not mint another free round.
    f.commit(recordMergeResult(f.state, system, conflictParams, f.io));
    const repair = await f.deliver("code", "b".repeat(40), true, [], event);
    expect(repair.merge_conflict_event_id).toBe(event.id);
    f.review(repair);
    const completion = required(complete());
    expect(completion.merge_conflict_event_id).toBe(event.id);
    expect(complete()).toBeNull();
    expect(
      f.state.events.filter((e) => e.type.startsWith("review_limit_")),
    ).toEqual([]);
    f.review(completion);
    expect(
      f.state.work_items.find((w) => w.id === f.pm.work_item_id),
    ).toMatchObject({
      status: "passed",
      max_review_rounds: acceptanceLimit,
    });
    decide("request_changes");
    // Even another fix Run bound to the old conflict cannot spend it again.
    const ordinary = await f.deliver("code", "c".repeat(40), true, [], event);
    expect(ordinary.merge_conflict_event_id).toBeUndefined();
    f.review(ordinary);
    const next = required(complete());
    expect(next.merge_conflict_event_id).toBeUndefined();
    expect(
      f.state.work_items.find((w) => w.id === f.pm.work_item_id),
    ).toMatchObject({
      status: "ready",
      max_review_rounds: acceptanceLimit,
    });
    f.review(next);
  },
);

test("B3a: an unresolved blocking decision is a normal precondition wait", async () => {
  const { f, complete } = setup(0);
  const product: Delivery = await f.deliver();
  f.review(product);
  f.commit(
    requestDecision(
      f.state,
      human,
      {
        card_id: f.card.id,
        kind: "choose",
        category: "general",
        question: "Confirm remaining requirements",
        context: "Completion must wait for this decision",
        options: [
          {
            key: "continue",
            description: "Continue",
            impact: "Resume completion",
          },
        ],
        recommended: "continue",
        decider: "human",
        plain_summary: {
          changed: "等待确认要求",
          impact: "确认前保持等待",
          risk: "无",
        },
        affected_cards: [f.card.id],
        affected_work_items: [],
        blocking: true,
      },
      f.io,
    ),
  );
  const before = f.state;
  expect(complete()).toBeNull();
  expect(f.state.deliveries).toEqual(before.deliveries);
  expect(f.state.work_items).toEqual(before.work_items);
  expect(f.state.events).toEqual(before.events);
});
