import { expect, test } from "vitest";
import {
  type Delivery,
  type ReviewIssue,
  recordMergeResult,
  submitReview,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { human } from "./test-fixtures.js";

const system = { kind: "system" as const, project_id: human.project_id };
const bug: ReviewIssue = {
  severity: "critical",
  description: "Conflict resolution loses a required check",
  proof: "The merged function no longer checks the input",
  must_fix: true,
  pre_existing: false,
};

async function conflicted(limit = 1) {
  const f = mergeFixture("auto", limit);
  const { product, completion } = await f.accept();
  const conflict = () => {
    f.commit(
      recordMergeResult(
        f.state,
        system,
        {
          card_id: f.card.id,
          completion_id: completion.id,
          result: {
            kind: "conflicted",
            delivery_id: product.id,
            files: ["file.ts"],
          },
        },
        f.io,
      ),
    );
    const event = f.state.events.find((e) => e.type === "merge_conflicted");
    if (!event) throw new Error("Missing conflict event");
    return event;
  };
  const event = conflict();
  const repair = await f.deliver("code", "b".repeat(40), true, [], event);
  return { f, repair, event, conflict };
}

function review(
  f: ReturnType<typeof mergeFixture>,
  target: Delivery,
  issues: ReviewIssue[],
  recheck = false,
) {
  f.start(f.reviewer);
  return f.commit(
    submitReview(
      f.state,
      f.actor(f.reviewer),
      {
        delivery_id: target.id,
        target_sha: target.subject.value,
        kind: "code",
        issues,
        recheck_required: recheck,
      },
      f.io,
    ),
  );
}

test("Flow Lite: repeated passing conflict repairs and completion never exhaust review budget", async () => {
  const { f, repair, event, conflict } = await conflicted();
  expect(repair.merge_conflict_event_id).toBe(event.id);
  expect(conflict().id).toBe(event.id);
  f.review(repair);
  const completion = await f.deliver("card_completion", repair.subject.value);
  f.review(completion);
  expect(f.state.cards[0]?.status).toBe("awaiting_merge");
  expect(f.state.decisions).toEqual([]);
  expect(
    f.state.work_items
      .filter((w) => w.kind === "verify")
      .every((w) => w.max_review_rounds === 1),
  ).toBe(true);
});

test("Flow Lite: a real rejection counts even if its Run came from conflict repair", async () => {
  const { f, repair } = await conflicted();
  review(f, repair, [bug]);
  expect(f.state.decisions).toEqual([]);
  expect(
    f.state.events.some((e) => e.type === "review_limit_raised_by_system"),
  ).toBe(true);
  expect(
    f.state.work_items.find((w) => w.id === f.reviewer.work_item_id)?.status,
  ).toBe("failed");
});

test("Flow Lite: repeated conditional rechecks spend no rejection budget", async () => {
  const { f, repair } = await conflicted();
  for (let n = 0; n < 3; n++) review(f, repair, [], true);
  expect(f.state.decisions).toEqual([]);
  f.review(repair);
  expect(
    f.state.work_items.find((w) => w.id === f.reviewer.work_item_id)?.status,
  ).toBe("passed");
});

test("B5: a development-plan-only conflict tells the author to keep both sides, preserving product passes", async () => {
  const f = mergeFixture("auto", 1);
  const { product, completion } = await f.accept();
  f.commit(
    recordMergeResult(
      f.state,
      system,
      {
        card_id: f.card.id,
        completion_id: completion.id,
        result: {
          kind: "conflicted",
          delivery_id: product.id,
          files: ["docs/development-plan.md"],
        },
      },
      f.io,
    ),
  );
  expect(f.state.events.at(-1)?.payload).toMatchObject({
    conflict_kind: "development_plan",
    run_kind: "fix",
  });
  expect(f.state.timeline.at(-1)?.body).toContain("保留双方正文");
  expect(
    f.state.work_items.find((w) => w.id === f.reviewer.work_item_id)?.status,
  ).toBe("passed");
  expect(
    f.state.work_items.find((w) => w.id === f.pm.work_item_id)?.status,
  ).toBe("todo");
  expect(f.state.reviews).toHaveLength(2);
});
