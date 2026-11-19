import { expect, test } from "vitest";
import { isReviewStale } from "../derived.js";
import type { Delivery, PreMergeCheckStatus } from "../entities.js";
import type { CommandEffect, CommandState } from "./core.js";
import { prepareDelivery, submitDelivery, submitReview } from "./delivery.js";
import { updateCard } from "./pm.js";
import {
  currentPreMergeVersions,
  effectivePreMergeChecks,
  INDEPENDENT_REVIEW_CHECK_LABEL as label,
  MAX_PRE_MERGE_CHECKS,
  openPreMergeChecks,
} from "./pre-merge-checks.js";
import { withdrawReview } from "./review-withdrawal.js";
import {
  actor,
  apply,
  assignment,
  fixture,
  human,
  id,
  now,
  ports,
  role,
  run,
  value,
} from "./test-fixtures.js";

function setup(
  reviewRole = "independent_reviewer",
  secondReviewerRole?: string,
) {
  const seed = fixture();
  const verifier = seed.work_items.find((w) => w.id === id("work_item", 2));
  if (verifier?.kind !== "verify") throw new Error("Missing verifier");
  let state: CommandState = {
    ...seed,
    roles: [...seed.roles, role("independent_reviewer")],
    assignments: [
      ...seed.assignments.map((a) =>
        a.id === id("assignment", 2) ? { ...a, role_id: reviewRole } : a,
      ),
      ...(secondReviewerRole ? [assignment(5, secondReviewerRole)] : []),
    ],
    work_items: [
      ...seed.work_items.map((w) =>
        w.id === id("work_item", 2) ? { ...w, role_id: reviewRole } : w,
      ),
      ...(secondReviewerRole
        ? [
            {
              ...verifier,
              id: id("work_item", 5),
              assignment_id: id("assignment", 5),
              role_id: secondReviewerRole,
              template_key: "parallel_review",
            },
          ]
        : []),
    ],
    runs: [...seed.runs, ...(secondReviewerRole ? [run(5)] : [])],
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
        requested_verifiers: state.work_items
          .filter(
            (w) =>
              w.kind === "verify" &&
              w.target_work_item_id === id("work_item", 1),
          )
          .map((w) => w.id),
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
      caller = actor(2, reviewRole),
    ) {
      return submitReview(
        state,
        caller,
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
    withdraw(work_item_id = id("work_item", 2), caller = actor(2, reviewRole)) {
      return withdrawReview(
        state,
        caller,
        { work_item_id, rationale: "重新核查遗漏" },
        io,
      );
    },
    setCheck(checkLabel = label, status: PreMergeCheckStatus = "pending") {
      state = apply(
        state,
        value(
          updateCard(
            state,
            human,
            {
              card_id: card().id,
              pre_merge_check: { label: checkLabel, status },
            },
            io,
          ),
        ),
      );
    },
  };
}

test.each(["reviewer", "independent_reviewer"])(
  "%s: only a UX-only follow-up closes the current verification",
  async (role) => {
    const f = setup(role);
    const target = await f.deliver();
    const current = f.card();
    const followup = id("card", 2);
    const base = {
      description: "Feedback shown twice",
      severity: "major" as const,
      must_fix: true,
      pre_existing: false,
    };
    const ux = { ...base, impact: "ux_only" as const };
    const p = {
      delivery_id: target.id,
      target_sha: target.subject.value,
      kind: "code" as const,
      issues: [ux],
      followup_card_id: followup,
    };
    const submit = (
      overrides: Partial<Parameters<typeof submitReview>[2]> = {},
      state = f.state,
    ) => submitReview(state, actor(2, role), { ...p, ...overrides }, f.io);
    for (const issues of [
      [base],
      [{ ...base, impact: "wrong" as never }],
      [],
      [{ ...ux, pre_existing: true }],
      ...(["functional", "data_or_permission"] as const).map((impact) => [
        ux,
        { ...base, impact },
      ]),
    ])
      expect(submit({ issues })).toMatchObject({
        ok: false,
        error: { code: "validation_failed" },
      });
    for (const overrides of [
      { followup_card_id: current.id },
      { recheck_required: true },
    ])
      expect(submit(overrides)).toMatchObject({
        ok: false,
        error: { code: "validation_failed" },
      });
    for (const change of [
      { status: "cancelled" as const },
      { status: "done" as const },
      { project_id: "other" as never },
    ])
      expect(
        submit(
          {},
          {
            ...f.state,
            cards: f.state.cards.map((c) =>
              c.id === followup ? { ...c, ...change } : c,
            ),
          },
        ),
      ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
    expect(submit({ followup_card_id: id("card", 999) })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(value(f.review(target, [ux])).data).toMatchObject({
      verdict: "reject",
      blocking: true,
    });
    const effect = value(submit());
    expect(effect.data).toMatchObject({
      verdict: "conditional",
      blocking: false,
      followup_card_id: followup,
      issues: [ux],
      recheck_required: false,
    });
    expect(effect.events[0]?.payload).toMatchObject({
      followup_card_id: followup,
      issues: [ux],
      rework_allowed: false,
    });
    f.apply(effect);
    expect(f.state.deliveries.find((v) => v.id === target.id)?.status).toBe(
      "accepted",
    );
    expect(
      f.state.work_items.find((w) => w.id === effect.data.work_item_id)?.status,
    ).toBe("passed");
    if (role === "independent_reviewer")
      expect(f.checks()).toMatchObject([
        { label, status: "passed", stale: false },
      ]);
    expect(f.withdraw().ok).toBe(true);
  },
);

test.each([false, true])(
  "independent pass atomically upserts its reserved check (pending=%s)",
  async (pending) => {
    const f = setup();
    if (pending) f.setCheck();
    f.setCheck("截图核对");
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
                impact: "functional" as const,
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
    f.setCheck();
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
  f.setCheck();
  const target = await f.deliver();
  const effect = value(f.review(target));
  expect(effect.events.map((e) => e.type)).toEqual(["review_submitted"]);
  f.apply(effect);
  expect(f.checks()).toMatchObject([
    { label, status: "pending", updated_by: "human" },
  ]);
});

test.each(["pass", "reject"] as const)(
  "eight ordinary checks still allow an independent %s with or without a placeholder",
  async (verdict) => {
    for (const placeholder of ["absent", "before", "after"]) {
      const f = setup();
      const target = await f.deliver();
      if (placeholder === "before") f.setCheck();
      for (let n = 0; n < MAX_PRE_MERGE_CHECKS; n++)
        f.setCheck(`Check ${n}`, "passed");
      const ordinary = f
        .card()
        .pre_merge_checks?.filter((c) => c.label !== label);
      if (placeholder === "after") f.setCheck();
      const effect = value(
        f.review(
          target,
          verdict === "pass"
            ? []
            : [
                {
                  severity: "major",
                  impact: "functional" as const,
                  must_fix: true,
                  pre_existing: false,
                  description: "Fix permission boundary",
                },
              ],
        ),
      );
      expect(effect.data.verdict).toBe(verdict);
      f.apply(effect);
      expect(f.card().pre_merge_checks).toHaveLength(MAX_PRE_MERGE_CHECKS + 1);
      expect(
        f.card().pre_merge_checks?.filter((c) => c.label !== label),
      ).toEqual(ordinary);
      expect(f.checks().find((c) => c.label === label)).toMatchObject({
        status: verdict === "pass" ? "passed" : "failed",
        stale: false,
      });
      expect(f.state.reviews).toEqual([effect.data]);
      expect(
        updateCard(
          f.state,
          human,
          {
            card_id: f.card().id,
            pre_merge_check: {
              label: "Ninth ordinary check",
              status: "pending",
            },
          },
          f.io,
        ),
      ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
    }
  },
);

test("withdrawing the independent pass atomically resets its check and preserves other state", async () => {
  const f = setup();
  const target = await f.deliver();
  f.setCheck("截图核对", "passed");
  f.apply(value(f.review(target)));
  const before = f.state;
  expect(f.withdraw(id("work_item", 2), human)).toMatchObject({
    ok: false,
    error: { code: "unauthorized" },
  });
  expect(f.checks().find((c) => c.label === label)?.status).toBe("passed");
  const effect = value(f.withdraw());
  expect(effect.events.map((e) => e.type)).toEqual([
    "review_withdrawn",
    "pre_merge_check_updated",
  ]);
  f.apply(effect);
  expect(isReviewStale(effect.data, target)).toBe(true);
  expect(
    f.state.work_items.find((w) => w.id === effect.data.work_item_id)?.status,
  ).toBe("ready");
  expect(
    openPreMergeChecks(f.card(), f.state.work_items, f.state.deliveries),
  ).toMatchObject([
    {
      label,
      status: "pending",
      updated_by: `assignment:${id("assignment", 2)}`,
    },
  ]);
  expect(
    f.checks().find((c) => c.label === label)?.checked_versions,
  ).toBeUndefined();
  expect(
    f.card().pre_merge_checks?.find((c) => c.label === "截图核对"),
  ).toEqual(
    before.cards
      .find((c) => c.id === f.card().id)
      ?.pre_merge_checks?.find((c) => c.label === "截图核对"),
  );
  expect(f.state.deliveries).toEqual(before.deliveries);
  expect(f.state.decisions).toEqual(before.decisions);
  expect(f.state.runs).toEqual(before.runs);
  expect(f.withdraw()).toMatchObject({
    ok: false,
    error: { code: "illegal_transition" },
  });
});

test.each(["reviewer", "independent_reviewer"])(
  "withdrawing a different %s does not overwrite the current projection",
  async (reviewRole) => {
    const f = setup(reviewRole, "independent_reviewer");
    const target = await f.deliver();
    f.apply(value(f.review(target)));
    f.apply(
      value(f.review(target, [], false, actor(5, "independent_reviewer"))),
    );
    const before = f.card().pre_merge_checks;
    const withdrawn = value(f.withdraw());
    expect(withdrawn.events.map((e) => e.type)).toEqual(["review_withdrawn"]);
    f.apply(withdrawn);
    expect(f.card().pre_merge_checks).toEqual(before);
    expect(f.checks()).toMatchObject([{ label, status: "passed" }]);
    f.apply(
      value(f.withdraw(id("work_item", 5), actor(5, "independent_reviewer"))),
    );
    expect(f.checks()).toMatchObject([{ label, status: "pending" }]);
  },
);

test("a manual pending reset retains its attribution when the review is withdrawn", async () => {
  const f = setup();
  const target = await f.deliver();
  f.apply(value(f.review(target)));
  f.setCheck();
  const before = f.card().pre_merge_checks;
  f.apply(value(f.withdraw()));
  expect(f.card().pre_merge_checks).toEqual(before);
});
