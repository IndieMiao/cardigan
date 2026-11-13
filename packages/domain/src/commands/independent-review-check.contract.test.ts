import { expect, test } from "vitest";
import { isReviewStale } from "../derived.js";
import type { Delivery } from "../entities.js";
import type { CommandEffect, CommandState } from "./core.js";
import { prepareDelivery, submitDelivery, submitReview } from "./delivery.js";
import { updateCard } from "./pm.js";
import {
  currentPreMergeVersions,
  effectivePreMergeChecks,
  INDEPENDENT_REVIEW_CHECK_LABEL as label,
  MAX_PRE_MERGE_CHECKS,
} from "./pre-merge-checks.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  now,
  ports,
  role,
  value,
} from "./test-fixtures.js";

function setup(reviewRole = "independent_reviewer") {
  const seed = fixture();
  let state: CommandState = {
    ...seed,
    roles: [...seed.roles, role("independent_reviewer")],
    assignments: seed.assignments.map((a) =>
      a.id === id("assignment", 2) ? { ...a, role_id: reviewRole } : a,
    ),
    work_items: seed.work_items.map((w) =>
      w.id === id("work_item", 2) ? { ...w, role_id: reviewRole } : w,
    ),
  };
  const io = ports();
  const card = () => {
    const c = state.cards.find((c) => c.id === id("card", 1));
    if (!c) throw new Error("Missing card");
    return c;
  };
  return {
    get state() {
      return state;
    },
    io,
    card,
    checks: () =>
      effectivePreMergeChecks(card(), state.work_items, state.deliveries),
    async deliver(sha = "a".repeat(40)) {
      const p = {
        work_item_id: id("work_item", 1),
        kind: "code" as const,
        summary: "Ready for review",
        subject: { kind: "git_head" as const, value: sha },
        requested_verifiers: [id("work_item", 2)],
      };
      const proof = value(
        await prepareDelivery(state, actor(), p, {
          verify: async () => ({ ok: true, value: [] }),
        }),
      );
      const effect = value(submitDelivery(state, actor(), p, proof, io));
      state = apply(state, effect);
      return effect.data;
    },
    review(
      target: Delivery,
      issues: Parameters<typeof submitReview>[2]["issues"] = [],
      recheck_required = false,
    ) {
      return submitReview(
        state,
        actor(2, reviewRole),
        {
          delivery_id: target.id,
          target_sha: target.subject.value,
          kind: "code",
          issues,
          recheck_required,
        },
        io,
      );
    },
    apply(effect: CommandEffect<unknown>) {
      state = apply(state, effect);
    },
    pending(checkLabel = label) {
      state = apply(
        state,
        value(
          updateCard(
            state,
            human,
            {
              card_id: card().id,
              pre_merge_check: { label: checkLabel, status: "pending" },
            },
            io,
          ),
        ),
      );
    },
  };
}

test.each([false, true])(
  "independent pass atomically upserts its reserved check (pending=%s)",
  async (pending) => {
    const f = setup();
    if (pending) f.pending();
    f.pending("截图核对");
    const other = f
      .card()
      .pre_merge_checks?.find((c) => c.label === "截图核对");
    const target = await f.deliver();
    const effect = value(f.review(target));
    expect(effect.events.map((e) => e.type)).toEqual([
      "review_submitted",
      "pre_merge_check_updated",
    ]);
    f.apply(effect);
    expect(f.card().pre_merge_checks).toHaveLength(2);
    expect(
      f.card().pre_merge_checks?.find((c) => c.label === "截图核对"),
    ).toEqual(other);
    const versions = currentPreMergeVersions(
      f.card(),
      f.state.work_items,
      f.state.deliveries,
    );
    expect(versions).toEqual([
      {
        work_item_id: target.work_item_id,
        delivery_id: target.id,
        subject: target.subject.value,
      },
    ]);
    expect(f.checks().find((c) => c.label === label)).toEqual({
      label,
      status: "passed",
      stale: false,
      note: `审核 ${effect.data.id}`,
      checked_versions: versions,
      updated_by: `assignment:${id("assignment", 2)}`,
      updated_at: now,
    });
    expect(effect.events[1]?.payload).toMatchObject({
      label,
      status: "passed",
      checked_versions: versions,
    });
    expect(effect.timeline[1]?.author).toBe(
      `assignment:${id("assignment", 2)}`,
    );
  },
);

test.each([
  { verdict: "reject", mustFix: true, preExisting: false, recheck: false },
  { verdict: "conditional", mustFix: false, preExisting: false, recheck: true },
  { verdict: "conditional", mustFix: true, preExisting: true, recheck: true },
  { verdict: "pass", mustFix: true, preExisting: true, recheck: false },
])(
  "$verdict with must_fix=$mustFix cannot project a pass",
  async ({ verdict, mustFix, preExisting, recheck }) => {
    const f = setup();
    const target = await f.deliver();
    const effect = value(
      f.review(
        target,
        mustFix
          ? [
              {
                severity: "major",
                must_fix: true,
                pre_existing: preExisting,
                description: "Permission boundary needs repair",
              },
            ]
          : [],
        recheck,
      ),
    );
    expect(effect.data.verdict).toBe(verdict);
    f.apply(effect);
    expect(f.checks()).toMatchObject([
      { label, status: "failed", stale: false },
    ]);
    f.pending();
    expect(f.checks()).toMatchObject([
      { label, status: "pending", stale: false },
    ]);
    expect(f.checks()[0]?.checked_versions).toBeUndefined();
  },
);

test.each(["a", "b"])(
  "invariant 14: redelivery of SHA %s invalidates both Review and projection",
  async (sha) => {
    const f = setup();
    const target = await f.deliver();
    const effect = value(f.review(target));
    f.apply(effect);
    const next = await f.deliver(sha.repeat(40));
    expect(isReviewStale(effect.data, next)).toBe(true);
    expect(f.checks()).toMatchObject([
      { label, status: "pending", stale: true },
    ]);
    expect(
      f.state.work_items.find((w) => w.id === id("work_item", 2))?.status,
    ).toBe("ready");
    expect(f.review(target)).toMatchObject({
      ok: false,
      error: { code: "stale_target" },
    });
  },
);

test("ordinary reviewers cannot create or overwrite the independent projection", async () => {
  const f = setup("reviewer");
  f.pending();
  const target = await f.deliver();
  const effect = value(f.review(target));
  expect(effect.events.map((e) => e.type)).toEqual(["review_submitted"]);
  f.apply(effect);
  expect(f.checks()).toMatchObject([
    { label, status: "pending", updated_by: "human" },
  ]);
});

test("projection failure does not expose a partial Review or workflow transition", async () => {
  const f = setup();
  for (let n = 0; n < MAX_PRE_MERGE_CHECKS; n++) f.pending(`Check ${n}`);
  const target = await f.deliver();
  const before = JSON.stringify(f.state);
  expect(f.review(target)).toMatchObject({
    ok: false,
    error: { code: "validation_failed" },
  });
  expect(JSON.stringify(f.state)).toBe(before);
  expect(f.state.reviews).toEqual([]);
});
