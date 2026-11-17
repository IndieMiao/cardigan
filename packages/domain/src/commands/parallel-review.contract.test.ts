import { expect, test } from "vitest";
import { deriveReviewMatrix, submitReview, withdrawReview } from "../index.js";
import {
  parallelBug,
  parallelDelivery,
  rejectedParallel,
} from "./parallel-review/test-fixtures.js";
import { actor, apply, id, run, value } from "./test-fixtures.js";

const lateActor = () => actor(3, "pm");

test.each(["pass", "reject", "conditional"] as const)(
  "flow 5 collects a parallel %s without reopening the rejected delivery",
  async (verdict) => {
    const f = await rejectedParallel();
    const before = f.state;
    const result = value(
      submitReview(
        before,
        lateActor(),
        {
          ...f.review,
          issues: verdict === "reject" ? [parallelBug] : [],
          recheck_required: verdict === "conditional",
        },
        f.io,
      ),
    );
    const after = apply(before, result);
    expect(result.data.verdict).toBe(verdict);
    expect(result.events[0]?.payload).toMatchObject({
      parallel_late: true,
      delivery_id: f.target.id,
    });
    expect(after.deliveries).toEqual(before.deliveries);
    expect(after.cards).toEqual(before.cards);
    expect(after.decisions).toEqual(before.decisions);
    expect(after.runs).toEqual(before.runs);
    expect(
      after.work_items.find((w) => w.id === id("work_item", 1))?.status,
    ).toBe("changes_requested");
    expect(
      after.work_items.find((w) => w.id === id("work_item", 3))?.status,
    ).toBe(
      verdict === "pass"
        ? "passed"
        : verdict === "reject"
          ? "failed"
          : "in_progress",
    );
    expect(after.reviews).toHaveLength(2);
    expect(after.reviews[0]?.issues[0]?.must_fix).toBe(true);
    // Another Run cannot duplicate even a conditional or withdrawn submission.
    const retry = {
      ...after,
      runs: [
        ...after.runs.filter((r) => r.assignment_id !== id("assignment", 3)),
        run(99, 3),
      ],
    };
    expect(submitReview(retry, lateActor(), f.review, f.io)).toMatchObject({
      ok: false,
      error: { code: "illegal_transition" },
    });
    const next = await parallelDelivery(after, f.io);
    const newer = apply(after, next);
    expect(next.data.reused_reviews ?? []).toEqual([]);
    expect(
      newer.work_items.find((w) => w.id === id("work_item", 3))?.status,
    ).toBe("ready");
    expect(
      deriveReviewMatrix(
        newer.deliveries,
        newer.work_items,
        newer.reviews,
      ).find(
        (row) =>
          row.delivery_id === next.data.id &&
          row.work_item_id === id("work_item", 3),
      ),
    ).toMatchObject({ verdict: null });
    expect(submitReview(newer, lateActor(), f.review, f.io)).toMatchObject({
      ok: false,
      error: { code: "stale_target" },
    });
  },
);

test.each([undefined, 1, 4])(
  "flow %s preserves the old rejection boundary",
  async (version) => {
    const f = await rejectedParallel(version === undefined ? 1 : version);
    const state =
      version === undefined
        ? {
            ...f.state,
            cards: f.state.cards.map(({ flow_version: _v, ...c }) => c),
          }
        : f.state;
    expect(submitReview(state, lateActor(), f.review, f.io)).toMatchObject({
      ok: false,
      error: { code: "illegal_transition" },
    });
  },
);

test("a new delivery wins over a prepared late review, including the same SHA", async () => {
  const f = await rejectedParallel();
  const next = await parallelDelivery(f.state, f.io);
  expect(
    submitReview(apply(f.state, next), lateActor(), f.review, f.io),
  ).toMatchObject({ ok: false, error: { code: "stale_target" } });
});

test("late reviewers retain target, assignment, historical employee and round checks", async () => {
  const f = await rejectedParallel();
  expect(submitReview(f.state, actor(), f.review, f.io)).toMatchObject({
    ok: false,
    error: { code: "unauthorized" },
  });
  expect(
    submitReview(
      f.state,
      lateActor(),
      { ...f.review, target_sha: "b".repeat(40) },
      f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "stale_target" } });
  for (const status of ["suspended", "released"] as const) {
    const state = {
      ...f.state,
      assignments: f.state.assignments.map((a) =>
        a.id === id("assignment", 3) ? { ...a, status } : a,
      ),
    };
    expect(submitReview(state, lateActor(), f.review, f.io).ok).toBe(false);
  }
  for (const historical of [false, true]) {
    const assignments = f.state.assignments.map((a) => ({
      ...a,
      employee_id: id("employee", a.id === id("assignment", 3) ? 1 : 2),
    }));
    const producer = assignments.find((a) => a.id === id("assignment", 1));
    if (!producer) throw new Error("Missing producer");
    const state = {
      ...f.state,
      assignments: historical
        ? [
            ...assignments,
            {
              ...producer,
              id: id("assignment", 99),
              status: "released" as const,
              employee_id: id("employee", 1),
            },
          ]
        : assignments.map((a) =>
            a.id === producer.id ? { ...a, employee_id: id("employee", 1) } : a,
          ),
    };
    expect(submitReview(state, lateActor(), f.review, f.io)).toMatchObject({
      ok: false,
      error: { code: "invariant_violation" },
    });
  }
  const unrequested = {
    ...f.state,
    deliveries: f.state.deliveries.map((d) => ({
      ...d,
      requested_verifiers: [id("work_item", 2)],
    })),
  };
  expect(submitReview(unrequested, lateActor(), f.review, f.io)).toMatchObject({
    ok: false,
    error: { code: "unauthorized" },
  });
  const exhausted = {
    ...f.state,
    reviews: [
      ...f.state.reviews,
      ...[1, 2, 3].map((n) => ({
        ...f.rejected.data,
        id: id("review", n),
        work_item_id: id("work_item", 3),
        delivery_id: id("delivery", n),
      })),
    ],
  };
  expect(submitReview(exhausted, lateActor(), f.review, f.io)).toMatchObject({
    ok: false,
    error: { code: "illegal_transition" },
  });
});

test("late pass can be withdrawn, stays consumed and does not revive acceptance", async () => {
  const f = await rejectedParallel();
  const pass = value(submitReview(f.state, lateActor(), f.review, f.io));
  let state = apply(f.state, pass);
  state = apply(
    state,
    value(
      withdrawReview(
        state,
        lateActor(),
        { work_item_id: id("work_item", 3), rationale: "Recheck" },
        f.io,
      ),
    ),
  );
  expect(state.deliveries[0]?.status).toBe("rejected");
  expect(submitReview(state, lateActor(), f.review, f.io)).toMatchObject({
    ok: false,
    error: { code: "illegal_transition" },
  });
});

test("a newer target stays stale after the replacement reaches the merge gate", async () => {
  const f = await rejectedParallel();
  const next = await parallelDelivery(f.state, f.io);
  const state = apply(f.state, next);
  const awaiting = {
    ...state,
    cards: state.cards.map((c) => ({
      ...c,
      status: "awaiting_merge" as const,
    })),
  };
  expect(submitReview(awaiting, lateActor(), f.review, f.io)).toMatchObject({
    ok: false,
    error: { code: "stale_target" },
  });
});

test("accepted deliveries and rejected completion requests do not allow parallel supplements", async () => {
  const f = await rejectedParallel();
  for (const status of ["accepted", "rejected"] as const) {
    const state = {
      ...f.state,
      deliveries: f.state.deliveries.map((d) => ({
        ...d,
        status,
        ...(status === "rejected"
          ? {
              kind: "card_completion" as const,
              requested_verifiers: [id("work_item", 3)],
            }
          : {}),
      })),
      work_items: f.state.work_items.map((w) => {
        if (
          status !== "rejected" ||
          w.id !== id("work_item", 3) ||
          w.kind !== "verify"
        )
          return w;
        const { target_work_item_id: _target, ...rest } = w;
        return { ...rest, template_key: "pm_acceptance" };
      }),
    };
    expect(submitReview(state, lateActor(), f.review, f.io)).toMatchObject({
      ok: false,
      error: { code: "illegal_transition" },
    });
  }
});

test("a late pass leaves its rejection budget intact before the next delivery", async () => {
  const f = await rejectedParallel();
  const limited = {
    ...f.state,
    work_items: f.state.work_items.map((w) =>
      w.id === id("work_item", 3) && w.kind === "verify"
        ? { ...w, max_review_rounds: 1 }
        : w,
    ),
  };
  const pass = value(submitReview(limited, lateActor(), f.review, f.io));
  const state = apply(limited, pass);
  const next = await parallelDelivery(state, f.io);
  expect(
    apply(state, next).work_items.find((w) => w.id === id("work_item", 3))
      ?.status,
  ).toBe("ready");
  expect(
    next.events.some((e) => e.type === "review_limit_auto_raise_exhausted"),
  ).toBe(false);
  expect(apply(state, next).decisions).toEqual([]);
});

test.each([
  { cap: null, verdict: "reject" },
  { cap: 1, verdict: "reject" },
  { cap: null, verdict: "conditional" },
  { cap: 1, verdict: "conditional" },
] as const)(
  "parallel $verdict at the ordinary review limit retains B1 and B2 event fields (cap=$cap)",
  async ({ cap, verdict }) => {
    const f = await rejectedParallel();
    const state = {
      ...f.state,
      project_preferences: [
        {
          id: f.state.project_id,
          auto_merge_after_minutes: null,
          system_review_limit_max_raises: cap,
        },
      ],
      work_items: f.state.work_items.map((w) =>
        w.id === id("work_item", 3) && w.kind === "verify"
          ? { ...w, max_review_rounds: 1 }
          : w,
      ),
    };
    const effect = value(
      submitReview(
        state,
        lateActor(),
        {
          ...f.review,
          issues: verdict === "reject" ? [parallelBug] : [],
          recheck_required: verdict === "conditional",
        },
        f.io,
      ),
    );
    const event = effect.events.find((e) => e.type === "review_submitted");
    if (verdict === "conditional") {
      expect(event?.payload).toMatchObject({
        parallel_late: true,
        rework_allowed: true,
      });
      expect(
        effect.events.some(
          (e) =>
            e.type === "review_limit_raised_by_system" ||
            e.type === "review_limit_auto_raise_exhausted",
        ),
      ).toBe(false);
      return;
    }
    expect(event?.payload).toMatchObject({
      parallel_late: true,
      rework_allowed: true,
    });
    const after = apply(state, effect);
    expect(after.deliveries).toEqual(state.deliveries);
    expect(
      after.work_items.find((w) => w.id === id("work_item", 1))?.status,
    ).toBe("changes_requested");
    expect(
      after.work_items.find((w) => w.id === id("work_item", 3)),
    ).toMatchObject({
      max_review_rounds: 2,
      status: "failed",
    });
    expect(after.decisions).toEqual([]);
    expect(
      effect.events.filter((e) => e.type === "review_limit_raised_by_system"),
    ).toHaveLength(1);
    expect(submitReview(after, lateActor(), f.review, f.io).ok).toBe(false);
  },
);

test("a verifier on another card cannot supplement this delivery", async () => {
  const f = await rejectedParallel();
  const state = {
    ...f.state,
    work_items: f.state.work_items.map((w) =>
      w.id === id("work_item", 3) ? { ...w, card_id: id("card", 2) } : w,
    ),
  };
  expect(submitReview(state, lateActor(), f.review, f.io)).toMatchObject({
    ok: false,
    error: { code: "unauthorized" },
  });
});
