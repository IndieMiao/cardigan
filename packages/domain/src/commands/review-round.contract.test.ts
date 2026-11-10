import { expect, test } from "vitest";
import {
  type Delivery,
  prepareDelivery,
  type ReviewIssue,
  recordDecision,
  recordMergeResult,
  submitDelivery,
  submitReview,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { human, value } from "./test-fixtures.js";

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

test("invariants 13, 14: conflict repair and its completion can pass at an exhausted budget without resetting it", async () => {
  const { f, repair, event, conflict } = await conflicted();
  expect(repair.merge_conflict_event_id).toBe(event.id);
  expect(f.state.decisions).toEqual([]);
  // The conflict command replay cannot mint another exemption.
  expect(conflict().id).toBe(event.id);
  f.review(repair);
  const completion = await f.deliver("card_completion", repair.subject.value);
  expect(completion.merge_conflict_event_id).toBe(event.id);
  f.review(completion);
  expect(f.state.cards[0]?.status).toBe("awaiting_merge");
  expect(f.state.decisions).toEqual([]);
  expect(f.state.reviews).toHaveLength(4);
  expect(f.state.work_items.filter((w) => w.kind === "verify")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: f.reviewer.work_item_id,
        status: "passed",
        max_review_rounds: 1,
      }),
      expect.objectContaining({
        id: f.pm.work_item_id,
        status: "passed",
        max_review_rounds: 1,
      }),
    ]),
  );
});

test("invariant 11: a conflict exemption does not consume the next ordinary review round", async () => {
  const { f, repair } = await conflicted(2);
  f.review(repair);
  const ordinary = await f.deliver("code", "c".repeat(40));
  expect(ordinary.merge_conflict_event_id).toBeUndefined();
  f.review(ordinary);
  expect(f.state.decisions).toEqual([]);
  await f.deliver("code", "d".repeat(40));
  expect(f.state.decisions.at(-1)).toMatchObject({
    trigger: "review_limit",
    recommended: "raise_limit",
  });
  expect(f.state.decisions.at(-1)?.context).toContain("上一轮结论为通过");
});

test("invariant 11: another fix Run cannot reuse the same conflict exemption", async () => {
  const { f, repair, event } = await conflicted();
  f.review(repair);
  // Simulate another host Run bound to the same conflict: the event, not Run id, is the budget key.
  const next = await f.deliver("code", "c".repeat(40), true, [], event);
  expect(next.merge_conflict_event_id).toBeUndefined();
  expect(f.state.decisions.at(-1)).toMatchObject({
    trigger: "review_limit",
    recommended: "raise_limit",
  });
});

test("invariant 11: caller-supplied conflict provenance cannot bypass the review limit", async () => {
  const f = mergeFixture("auto", 1);
  const first = await f.deliver();
  f.review(first);
  f.start(f.coder);
  const params = {
    work_item_id: first.work_item_id,
    kind: "code" as const,
    summary: "Another version",
    subject: { kind: "git_head" as const, value: "b".repeat(40) },
    requested_verifiers: first.requested_verifiers,
    merge_conflict_event_id: f.io.ids.nextEventId(),
  };
  const proof = value(
    await prepareDelivery(f.state, f.actor(f.coder), params, {
      verify: async () => ({ ok: true, value: [] }),
    }),
  );
  const next = f.commit(
    submitDelivery(f.state, f.actor(f.coder), params, proof, f.io),
  );
  expect(next.merge_conflict_event_id).toBeUndefined();
  expect(f.state.decisions.at(-1)).toMatchObject({ trigger: "review_limit" });
});

test.each(["reject", "conditional"] as const)(
  "invariant 11: a free conflict review with final-round %s still stops and recommends more review",
  async (verdict) => {
    const { f, repair } = await conflicted();
    const result = review(
      f,
      repair,
      verdict === "reject" ? [bug] : [],
      verdict === "conditional",
    );
    expect(result.verdict).toBe(verdict);
    const decision = f.state.decisions.at(-1);
    expect(decision).toMatchObject({
      trigger: "review_limit",
      recommended: "raise_limit",
      status: "open",
      question: `审核轮数已用完：${f.reviewer.work_item_id}`,
    });
    expect(decision?.context).toContain("最近一次交付是合并冲突修复");
    expect(decision?.context).toContain(
      verdict === "reject" ? "驳回" : "有条件通过",
    );
    expect(
      f.state.work_items.find((w) => w.id === f.reviewer.work_item_id)?.status,
    ).toBe("waiting_decision");
    expect(f.state.runs.find((r) => r.id === result.run_id)).toMatchObject({
      outcome: "blocked",
    });
    const submitted = f.state.events.find(
      (e) =>
        e.type === "review_submitted" &&
        (e.payload as { review_id?: string }).review_id === result.id,
    );
    expect(submitted?.payload).toMatchObject({ rework_allowed: false });
    expect(f.state.events.at(-1)?.type).toBe("decision_requested");
  },
);

test("invariant 11: a second review of the conflict delivery consumes budget", async () => {
  const { f, repair } = await conflicted(2);
  review(f, repair, [], true);
  expect(f.state.decisions).toEqual([]);
  review(f, repair, [], true);
  expect(f.state.decisions.at(-1)).toMatchObject({ trigger: "review_limit" });
});

test.each([true, false])(
  "ordinary final-round review recommends pause only for unresolved must-fix findings (%s)",
  async (mustFix) => {
    const f = mergeFixture("auto", 1);
    const target = await f.deliver();
    review(f, target, [{ ...bug, must_fix: mustFix }], !mustFix);
    const q = f.state.decisions.at(-1);
    expect(q).toMatchObject({ recommended: mustFix ? "pause" : "raise_limit" });
    expect(q?.context).toContain(
      mustFix ? "仍有必须修复的问题" : "没有必须修复的问题",
    );
    expect(q?.context).toContain(mustFix ? "建议暂停" : "建议增加一轮");
    for (const text of [
      q?.question,
      q?.context,
      ...(q?.options.flatMap((o) => [o.description, o.impact]) ?? []),
    ]) {
      expect(text).toMatch(/[\u4e00-\u9fff]/u);
      expect(text?.replace(/W-\d+/gu, "")).not.toMatch(/[a-z]/iu);
    }
  },
);

test("ordinary rework still counts and a pre-existing must-fix issue does not recommend pausing", async () => {
  const f = mergeFixture("auto", 2);
  const first = await f.deliver();
  review(f, first, [bug]);
  expect(f.state.decisions).toEqual([]);
  const second = await f.deliver("code", "b".repeat(40));
  expect(second.merge_conflict_event_id).toBeUndefined();
  review(f, second, [{ ...bug, pre_existing: true }], true);
  expect(f.state.decisions.at(-1)).toMatchObject({
    trigger: "review_limit",
    recommended: "raise_limit",
  });
});

test("a generic merge return does not grant an exemption based on its prose or fix Run kind", async () => {
  const f = mergeFixture("confirm", 1);
  await f.accept();
  const q = f.state.decisions.at(-1);
  if (!q) throw new Error("Missing merge confirmation");
  f.commit(
    recordDecision(
      f.state,
      human,
      {
        decision_id: q.id,
        option: "request_changes",
        rationale: "仅合入基线、解决冲突",
        raw_quote: "仅合入基线、解决冲突",
      },
      f.io,
    ),
  );
  const event = f.state.events.find(
    (e) => e.type === "merge_changes_requested",
  );
  if (!event) throw new Error("Missing merge return");
  const next = await f.deliver("code", "b".repeat(40), true, [], event);
  expect(next.merge_conflict_event_id).toBeUndefined();
  expect(f.state.decisions.at(-1)).toMatchObject({ trigger: "review_limit" });
});
