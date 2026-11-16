import { expect, test } from "vitest";
import {
  finishRun,
  incrementalTestReview,
  prepareDelivery,
  refreshTestReviewLimits,
  submitDelivery,
  testReviewForAssignment,
  testReviewPassValid,
  withdrawReview,
} from "../index.js";
import { CommandDraft } from "./core.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { reviewRound } from "./review-round.js";
import { actor, human, id, value } from "./test-fixtures.js";
import { testReviewFixture } from "./test-review/test-fixtures.js";

const quota = (f: Awaited<ReturnType<typeof testReviewFixture>>) => {
  const d = new CommandDraft(f.state, human, "queue_run");
  return reviewRound(d, d.work(id("work_item", 2)));
};
test("only independent test review is free at the existing limit and binds a fresh Run and Review", async () => {
  const f = await testReviewFixture();
  const next = (await f.deliver()).data;
  expect(next.test_review).toMatchObject({
    delivery_id: next.id,
    previous_delivery_id: f.first.id,
    previous_review_id: f.passed.id,
  });
  expect(quota(f)).toBe(1);
  expect(f.state.decisions).toHaveLength(0);
  const run = f.start();
  expect(run.test_review).toEqual(next.test_review);
  const review = f.commit(f.review()).data;
  expect(review).toMatchObject({
    delivery_id: next.id,
    target_sha: next.subject.value,
    verdict: "pass",
    test_review: next.test_review,
  });
  expect(review.id).not.toBe(f.passed.id);
  expect(
    f.state.cards
      .find((c) => c.id === id("card", 1))
      ?.pre_merge_checks?.find((c) => c.label === "独立复核")?.note,
  ).toContain("增量复核（只改测试）");
  expect(testReviewPassValid(f.state, review)).toBe(true);
  f.revoke();
  expect(testReviewPassValid(f.state, review)).toBe(false);
});
test("an incremental rejection can report a new weakened assertion and does not grant another free attempt", async () => {
  const f = await testReviewFixture(2);
  await f.deliver();
  f.start();
  const review = f.commit(
    f.review([
      {
        description: "Assertion removed",
        severity: "major",
        must_fix: true,
        pre_existing: false,
      },
    ]),
  ).data;
  expect(review.verdict).toBe("reject");
  expect(review.test_review).toBeDefined();
  expect(quota(f)).toBe(2);
  const next = (await f.deliver("9".repeat(40))).data;
  expect(next.test_review).toBeUndefined();
  expect(quota(f)).toBe(2);
});
test("revoking a proof after dispatch refuses scoped submission even with full budget remaining", async () => {
  const f = await testReviewFixture(3);
  await f.deliver();
  f.start();
  f.revoke();
  expect(testReviewForAssignment(f.state, id("assignment", 2))).toBeUndefined();
  expect(f.review()).toMatchObject({
    ok: false,
    error: { code: "stale_target" },
  });
  expect(quota(f)).toBe(1);
});
test("a withdrawn incremental pass retains its historical quota but cannot be used a second time", async () => {
  const f = await testReviewFixture(3);
  await f.deliver();
  f.start();
  f.commit(f.review());
  f.commit(
    withdrawReview(
      f.state,
      actor(2, "independent_reviewer"),
      { work_item_id: id("work_item", 2), rationale: "Recheck" },
      f.io,
    ),
  );
  expect(quota(f)).toBe(1);
  const d = new CommandDraft(f.state, human, "queue_run");
  expect(
    incrementalTestReview(
      d,
      d.work(id("work_item", 2)),
      f.state.deliveries.find((v) => v.status !== "superseded"),
    ),
  ).toBeUndefined();
});
test.each([
  "no-source",
  "missing-identity",
  "history-conflict",
  "risk-change",
  "withdrawn-pass",
  "wrong-sha",
])("%s falls back to full review", async (which) => {
  const f = await testReviewFixture(2);
  if (which === "no-source") f.disableProof();
  if (which === "missing-identity")
    f.state = {
      ...f.state,
      assignments: f.state.assignments.map((a) =>
        a.id === id("assignment", 1)
          ? ({ ...a, employee_id: undefined } as never)
          : a,
      ),
    };
  if (which === "history-conflict")
    f.state = {
      ...f.state,
      assignments: [
        ...f.state.assignments,
        {
          ...f.state.assignments[0],
          id: id("assignment", 88),
          status: "released",
          employee_id: id("employee", 2),
        } as never,
      ],
    };
  if (which === "risk-change")
    f.state = {
      ...f.state,
      cards: f.state.cards.map((c) => ({ ...c, high_risk: true })),
    };
  if (which === "withdrawn-pass")
    f.state = {
      ...f.state,
      reviews: f.state.reviews.map((r) => ({
        ...r,
        withdrawn: { at: "2026-01-01", rationale: "Recheck" },
      })),
    };
  if (which === "wrong-sha")
    f.state = {
      ...f.state,
      test_review_trust: {
        ...f.trust,
        prepare: async (c) => {
          const p = await f.trust.prepare(c);
          return p ? { ...p, new_sha: "f".repeat(40) } : undefined;
        },
      },
    };
  const next = (await f.deliver()).data;
  if (which === "history-conflict") expect(next.test_review).toBeDefined();
  else expect(next.test_review).toBeUndefined();
  expect(quota(f)).toBe(1);
});
test("a concurrent risk mutation discards prepared evidence inside the fresh delivery transaction", async () => {
  const f = await testReviewFixture(2);
  const p = f.params("b".repeat(40));
  const prepared = value(
    await prepareDelivery(f.state, actor(), p, f.verifier),
  );
  f.state = {
    ...f.state,
    cards: f.state.cards.map((c) => ({ ...c, high_risk: true })),
  };
  expect(
    f.commit(submitDelivery(f.state, actor(), p, prepared, f.io)).data
      .test_review,
  ).toBeUndefined();
});

test("completion cannot consume a pass after its isolation source was revoked", async () => {
  const f = await testReviewFixture(3);
  const next = (await f.deliver()).data;
  f.start();
  f.commit(f.review());
  f.revoke();
  const p = {
    ...f.params(next.subject.value),
    kind: "card_completion" as const,
    requested_verifiers: [id("work_item", 3)],
    plain_summary: { changed: "更新测试", impact: "验证更新", risk: "无" },
  };
  const receipt = value(await prepareDelivery(f.state, actor(), p, f.verifier));
  expect(submitDelivery(f.state, actor(), p, receipt, f.io)).toMatchObject({
    ok: false,
    error: { code: "stale_target" },
  });
});

test.each([false, true])(
  "completion checks only its own card's proof without weakening assignment access (revoked=%s)",
  async (revoked) => {
    const f = await testReviewFixture(3);
    const next = (await f.deliver()).data;
    f.start();
    const review = f.commit(f.review()).data;
    if (!review.test_review)
      throw new Error("Missing incremental review proof");
    const foreign = mergeFixture("auto", 3, { state: f.state, ports: f.io });
    const foreignDelivery = await foreign.deliver();
    const foreignReview = {
      ...foreign.review(foreignDelivery),
      test_review: review.test_review,
    };
    // Its copied proof is invalid for this other delivery and must not affect
    // completion on the actor's card, even while that delivery remains live.
    f.state = {
      ...foreign.state,
      reviews: foreign.state.reviews.map((r) =>
        r.id === foreignReview.id ? foreignReview : r,
      ),
    };
    expect(testReviewPassValid(f.state, foreignReview)).toBe(false);
    if (revoked) f.revoke();
    const p = {
      ...f.params(next.subject.value),
      kind: "card_completion" as const,
      requested_verifiers: [id("work_item", 3)],
      plain_summary: { changed: "更新测试", impact: "验证更新", risk: "无" },
    };
    const receipt = value(
      await prepareDelivery(f.state, actor(), p, f.verifier),
    );
    const result = submitDelivery(f.state, actor(), p, receipt, f.io);
    if (revoked)
      expect(result).toMatchObject({
        ok: false,
        error: { code: "stale_target" },
      });
    else expect(value(result).data.kind).toBe("card_completion");
    expect(
      submitDelivery(
        f.state,
        actor(),
        { ...p, work_item_id: foreignDelivery.work_item_id },
        receipt,
        f.io,
      ),
    ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  },
);

test("successive eligible test versions get fresh conclusions without resetting or consuming full quota", async () => {
  const f = await testReviewFixture();
  await f.deliver();
  const run = f.start();
  f.commit(f.review());
  f.commit(
    finishRun(
      f.state,
      actor(2, "independent_reviewer"),
      { run_id: run.id, outcome: "completed", summary: "Finished" },
      f.io,
    ),
  );
  const next = (await f.deliver("9".repeat(40))).data;
  expect(next.test_review?.previous_delivery_id).not.toBe(f.first.id);
  expect(quota(f)).toBe(1);
  f.start();
  f.commit(f.review());
  expect(f.state.reviews.filter((r) => r.test_review)).toHaveLength(2);
});

test("an incremental Review cannot also spend a conflict exemption", async () => {
  const f = await testReviewFixture(3);
  const next = (await f.deliver()).data;
  f.state = {
    ...f.state,
    deliveries: f.state.deliveries.map((v) =>
      v.id === next.id
        ? { ...v, merge_conflict_event_id: f.state.events[0]?.id as never }
        : v,
    ),
  };
  f.start();
  f.commit(f.review());
  expect(quota(f)).toBe(1);
});

test("a full review after a conflict's incremental attempt cannot spend that same conflict again", async () => {
  const f = await testReviewFixture(3);
  const next = (await f.deliver()).data;
  f.state = {
    ...f.state,
    deliveries: f.state.deliveries.map((v) =>
      v.id === next.id
        ? { ...v, merge_conflict_event_id: f.state.events[0]?.id as never }
        : v,
    ),
  };
  f.start();
  const reviewed = f.commit(f.review()).data;
  // Historical second attempt (e.g. after withdrawal) is a paid full review.
  f.state = {
    ...f.state,
    reviews: [
      ...f.state.reviews,
      { ...reviewed, id: id("review", 9999), test_review: undefined } as never,
    ],
  };
  expect(quota(f)).toBe(1);
});

test("a second product cannot introduce unchecked inputs into the publication tree", async () => {
  const f = await testReviewFixture(3);
  await f.deliver();
  f.start();
  const review = f.commit(f.review()).data;
  expect(testReviewPassValid(f.state, review)).toBe(true);
  const product = f.state.work_items.find((w) => w.kind === "produce");
  if (!product) throw new Error("Missing product");
  f.state = {
    ...f.state,
    work_items: [
      ...f.state.work_items,
      {
        ...product,
        id: id("work_item", 999),
        required: false,
      },
    ],
  };
  expect(testReviewPassValid(f.state, review)).toBe(false);
});

test.each(["revoked", "no-authority"])(
  "lost incremental quota settles the ordinary limit state machine (%s)",
  async (reason) => {
    const f = await testReviewFixture(1);
    await f.deliver();
    if (reason === "revoked") f.revoke();
    else {
      const { test_review_trust: _old, ...state } = f.state;
      f.state = state;
    }
    const system = { kind: "system" as const, project_id: f.state.project_id };
    expect(
      f.commit(refreshTestReviewLimits(f.state, system, f.io)).data,
    ).toEqual([]);
    expect(
      f.state.work_items.find((w) => w.id === id("work_item", 2))?.status,
    ).toBe("ready");
    const first = f.state.decisions[0];
    expect(first).toBeUndefined();
    const repeated = f.commit(refreshTestReviewLimits(f.state, system, f.io));
    expect(repeated.events).toHaveLength(0);
    expect(repeated.changes).toHaveLength(0);
    expect(f.state.decisions).toEqual([]);
    expect(refreshTestReviewLimits(f.state, actor(), f.io)).toMatchObject({
      ok: false,
      error: { code: "unauthorized" },
    });
  },
);
