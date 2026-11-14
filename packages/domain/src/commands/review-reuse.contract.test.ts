import { beforeEach, expect, test } from "vitest";
import type { Actor, Delivery, DeliveryVerifier, WorkItem } from "../index.js";
import {
  type CommandState,
  deriveReviewMatrix,
  isReviewStale,
  prepareDelivery,
  prepareMergePlan,
  type SubmitDeliveryParams,
  submitDelivery,
  submitReview,
  updateCard,
  updateWorkItem,
  withdrawReview,
} from "../index.js";
import {
  actor,
  apply,
  assignment,
  fixture,
  human,
  id,
  ports,
  role,
  run,
  subject,
  value,
} from "./test-fixtures.js";

let io = ports();
beforeEach(() => {
  io = ports();
});
const tree = "c".repeat(40);
const verifier = (treeSha: string | null = tree): DeliveryVerifier => ({
  verify: async (s) => ({
    ok: true,
    value: treeSha
      ? [{ kind: "commit", details: { sha: s.value, tree_sha: treeSha } }]
      : [],
  }),
});
const params: SubmitDeliveryParams = {
  work_item_id: id("work_item", 1),
  kind: "code",
  summary: "Ready",
  subject,
  requested_verifiers: [id("work_item", 2)],
};
async function deliver(s: CommandState, p = params, evidence = verifier()) {
  return value(
    submitDelivery(
      s,
      actor(),
      p,
      value(await prepareDelivery(s, actor(), p, evidence)),
      io,
    ),
  );
}
function pass(
  s: CommandState,
  target: Delivery,
  caller: Actor = actor(2, "reviewer"),
) {
  return value(
    submitReview(
      s,
      caller,
      {
        delivery_id: target.id,
        target_sha: target.subject.value,
        kind: "code",
        issues: [],
      },
      io,
    ),
  );
}
async function passed(s = fixture(), evidence = verifier()) {
  const first = await deliver(s, params, evidence);
  s = apply(s, first);
  const reviewed = pass(s, first.data);
  return { s: apply(s, reviewed), first: first.data, review: reviewed.data };
}
function matrix(s: CommandState, delivery: Delivery) {
  return deriveReviewMatrix(s.deliveries, s.work_items, s.reviews).filter(
    (r) => r.delivery_id === delivery.id,
  );
}

test("same full SHA and tree retain the original pass and skip review budget at its limit", async () => {
  const base = fixture();
  const { s, first, review } = await passed({
    ...base,
    work_items: base.work_items.map((w) =>
      w.kind === "verify" ? { ...w, max_review_rounds: 1 } : w,
    ),
  });
  const next = await deliver(s, {
    ...params,
    summary: "Updated delivery number",
  });
  const current = apply(s, next);
  expect(next.data).toMatchObject({
    status: "accepted",
    supersedes: first.id,
    reused_reviews: [review.id],
  });
  expect(current.reviews).toEqual([review]);
  expect(
    current.work_items.find((w) => w.id === id("work_item", 1))?.status,
  ).toBe("accepted");
  expect(
    current.work_items.find((w) => w.id === id("work_item", 2))?.status,
  ).toBe("passed");
  expect(matrix(current, next.data)[0]).toMatchObject({
    verdict: "pass",
    review_id: review.id,
    reused_from: { review_id: review.id, delivery_id: first.id },
  });
  expect(next.events.map((e) => e.type)).toContain("review_reused");
  expect(next.events.map((e) => e.type)).not.toContain("review_submitted");
  expect(next.events.map((e) => e.type)).not.toContain("decision_requested");
  expect(next.changes.some((c) => c.collection === "runs")).toBe(false);
  expect(
    next.timeline.some(
      (e) => e.author === "system" && e.body.includes(`沿用自 ${review.id}`),
    ),
  ).toBe(true);
});

test("successive redeliveries bind to the real original review, without copying it", async () => {
  let { s, review } = await passed();
  for (let n = 0; n < 3; n++) {
    const next = await deliver(s);
    s = apply(s, next);
    expect(next.data.reused_reviews).toEqual([review.id]);
    expect(matrix(s, next.data)[0]?.review_id).toBe(review.id);
  }
  expect(s.reviews).toEqual([review]);
});

test.each([
  "sha",
  "tree",
  "kind",
  "missing_tree",
  "legacy",
  "withdrawn",
  "expired",
  "conditional",
  "reject",
  "materials",
] as const)("%s cannot reuse a pass", async (change) => {
  let { s, review } = await passed();
  let p = params;
  let evidence = verifier();
  if (change === "sha")
    p = { ...p, subject: { ...subject, value: "b".repeat(40) } };
  if (change === "tree") evidence = verifier("d".repeat(40));
  if (change === "kind") p = { ...p, kind: "doc" };
  if (change === "missing_tree") evidence = verifier(null);
  if (change === "legacy")
    s = { ...s, reviews: s.reviews.map(({ reuse_basis: _proof, ...r }) => r) };
  if (change === "withdrawn")
    s = apply(
      s,
      value(
        withdrawReview(
          s,
          actor(2, "reviewer"),
          {
            work_item_id: review.work_item_id,
            rationale: "Missed an invariant",
          },
          io,
        ),
      ),
    );
  if (change === "expired")
    s = {
      ...s,
      deliveries: s.deliveries.map((v) => ({ ...v, status: "superseded" })),
    };
  if (change === "conditional" || change === "reject")
    s = {
      ...s,
      reviews: [{ ...review, verdict: change }],
      work_items: s.work_items.map((w) =>
        w.id === review.work_item_id
          ? ({
              ...w,
              status: change === "reject" ? "failed" : "in_progress",
            } as WorkItem)
          : w,
      ),
    };
  if (change === "materials")
    p = {
      ...p,
      test_results: [{ command: "new test", result: "new evidence" }],
    };
  const next = await deliver(s, p, evidence);
  expect(next.data.reused_reviews).toBeUndefined();
  expect(matrix(apply(s, next), next.data)[0]?.verdict).toBeNull();
});

test("missing old host evidence cannot be retroactively trusted", async () => {
  const { s } = await passed(fixture(), {
    verify: async () => ({ ok: true, value: [] }),
  });
  expect((await deliver(s)).data.reused_reviews).toBeUndefined();
});

test.each(["risk", "requirements", "required_verifier"] as const)(
  "%s changes invalidate reuse permanently, even if restored",
  async (change) => {
    let { s, review } = await passed();
    const next = await deliver(s);
    s = apply(s, next);
    if (change === "risk") {
      s = apply(
        s,
        value(
          updateCard(
            s,
            human,
            { card_id: id("card", 1), risk_tags: ["permission"] },
            io,
          ),
        ),
      );
      s = apply(
        s,
        value(
          updateCard(s, human, { card_id: id("card", 1), risk_tags: [] }, io),
        ),
      );
    } else if (change === "requirements") {
      s = apply(
        s,
        value(
          updateCard(
            s,
            human,
            {
              card_id: id("card", 1),
              acceptance_criteria: ["changed requirement"],
            },
            io,
          ),
        ),
      );
      s = apply(
        s,
        value(
          updateCard(
            s,
            human,
            { card_id: id("card", 1), acceptance_criteria: ["passes"] },
            io,
          ),
        ),
      );
    } else {
      s = apply(
        s,
        value(
          updateWorkItem(
            s,
            human,
            {
              work_item_id: id("work_item", 3),
              completion_criteria: ["more acceptance checks"],
            },
            io,
          ),
        ),
      );
    }
    expect(
      s.reviews.find((r) => r.id === review.id)?.reuse_invalidated_at,
    ).toBeDefined();
    expect(matrix(s, next.data)[0]?.verdict).toBeNull();
    expect((await deliver(s)).data.reused_reviews).toBeUndefined();
  },
);

test("historical assignments participate in identity proof, even when released", async () => {
  const { s } = await passed();
  const altered = {
    ...s,
    assignments: [
      ...s.assignments,
      {
        ...assignment(9, "coder"),
        work_item_id: params.work_item_id,
        status: "released" as const,
      },
    ],
  };
  expect((await deliver(altered)).data.reused_reviews).toBeUndefined();
});

test("an owning reviewer withdraws the original pass after multiple reuses, invalidating every binding", async () => {
  let { s, review } = await passed();
  const second = await deliver(s);
  s = apply(s, second);
  const third = await deliver(s);
  s = apply(s, third);
  const withdrawn = value(
    withdrawReview(
      s,
      actor(2, "reviewer"),
      { work_item_id: review.work_item_id, rationale: "Recheck the boundary" },
      io,
    ),
  );
  s = apply(s, withdrawn);
  expect(withdrawn.data.id).toBe(review.id);
  expect(withdrawn.data.delivery_id).toBe(review.delivery_id);
  expect(isReviewStale(withdrawn.data, third.data)).toBe(true);
  expect(matrix(s, third.data)[0]?.verdict).toBeNull();
  expect((await deliver(s)).data.reused_reviews).toBeUndefined();
});

test("reuse versus withdrawal is decided by the fresh commit snapshot, not preflight", async () => {
  let { s, review } = await passed();
  const prepared = value(await prepareDelivery(s, actor(), params, verifier()));
  s = apply(
    s,
    value(
      withdrawReview(
        s,
        actor(2, "reviewer"),
        {
          work_item_id: review.work_item_id,
          rationale: "Withdraw before commit",
        },
        io,
      ),
    ),
  );
  const next = value(submitDelivery(s, actor(), params, prepared, io));
  expect(next.data.reused_reviews).toBeUndefined();
});

test("concurrent prepared redeliveries serialize against the actual current predecessor", async () => {
  let { s, review } = await passed();
  const tickets = await Promise.all([
    prepareDelivery(s, actor(), params, verifier()),
    prepareDelivery(s, actor(), params, verifier()),
  ]);
  const first = value(
    submitDelivery(s, actor(), params, value(tickets[0]), io),
  );
  s = apply(s, first);
  const second = value(
    submitDelivery(s, actor(), params, value(tickets[1]), io),
  );
  s = apply(s, second);
  expect(second.data.supersedes).toBe(first.data.id);
  expect(second.data.reused_reviews).toEqual([review.id]);
  expect(s.deliveries.filter((d) => d.status !== "superseded")).toHaveLength(1);
});

test("independent review projection keeps the original author and time and follows withdrawal", async () => {
  const base = fixture();
  const s0: CommandState = {
    ...base,
    roles: [...base.roles, role("independent_reviewer")],
    assignments: base.assignments.map((a) =>
      a.id === id("assignment", 2)
        ? { ...a, role_id: "independent_reviewer" }
        : a,
    ),
    work_items: base.work_items.map((w) =>
      w.id === id("work_item", 2)
        ? { ...w, role_id: "independent_reviewer" }
        : w,
    ),
  };
  const first = await deliver(s0);
  let s = apply(s0, first);
  const review = pass(s, first.data, actor(2, "independent_reviewer"));
  s = apply(s, review);
  const oldCheck = s.cards.find((c) => c.id === id("card", 1))
    ?.pre_merge_checks?.[0];
  const next = await deliver(s);
  s = apply(s, next);
  expect(
    s.cards.find((c) => c.id === id("card", 1))?.pre_merge_checks?.[0],
  ).toMatchObject({
    status: "passed",
    reused_from: review.data.id,
    updated_by: oldCheck?.updated_by,
    updated_at: oldCheck?.updated_at,
    checked_versions: [{ delivery_id: next.data.id }],
  });
  s = apply(
    s,
    value(
      withdrawReview(
        s,
        actor(2, "independent_reviewer"),
        { work_item_id: id("work_item", 2), rationale: "Recheck" },
        io,
      ),
    ),
  );
  expect(
    s.cards.find((c) => c.id === id("card", 1))?.pre_merge_checks?.[0]?.status,
  ).toBe("pending");
});

const plain = { changed: "补齐实现", impact: "原有流程保持可用", risk: "无" };
async function partialCompletion() {
  const base = fixture();
  const pm = base.work_items[2];
  if (!pm) throw new Error("Missing PM fixture");
  let s: CommandState = {
    ...base,
    work_items: [
      ...base.work_items,
      { ...pm, id: id("work_item", 5), assignment_id: id("assignment", 5) },
    ],
    assignments: [...base.assignments, assignment(5, "pm")],
    runs: [...base.runs, run(5)],
  };
  ({ s } = await passed(s));
  const p: SubmitDeliveryParams = {
    ...params,
    kind: "card_completion",
    plain_summary: plain,
    requested_verifiers: [id("work_item", 3), id("work_item", 5)],
  };
  const first = await deliver(s, p);
  s = apply(s, first);
  const review = pass(s, first.data, actor(3, "pm"));
  return { s: apply(s, review), p, review: review.data };
}

test("PM acceptance reuses only the same completion contents, leaving the remaining reviewer ready", async () => {
  const { s, p, review } = await partialCompletion();
  const next = await deliver(s, p);
  expect(next.data.reused_reviews).toEqual([review.id]);
  expect(next.data.status).toBe("submitted");
  const current = apply(s, next);
  expect(
    current.work_items.find((w) => w.id === id("work_item", 3))?.status,
  ).toBe("passed");
  expect(
    current.work_items.find((w) => w.id === id("work_item", 5))?.status,
  ).toBe("ready");
});

test.each(["summary", "plain_summary", "test_results"] as const)(
  "completion %s changes require new PM acceptance at the same SHA",
  async (field) => {
    const { s, p } = await partialCompletion();
    const changed =
      field === "summary"
        ? { summary: "Changed acceptance claim" }
        : field === "plain_summary"
          ? { plain_summary: { ...plain, impact: "增加了功能" } }
          : { test_results: [{ command: "check", result: "new" }] };
    expect(
      (await deliver(s, { ...p, ...changed })).data.reused_reviews,
    ).toBeUndefined();
  },
);

test("producer-supplied reuse bindings are ignored and cannot substitute product review for PM acceptance", async () => {
  const { s, review } = await passed();
  const forged = {
    ...params,
    kind: "card_completion" as const,
    plain_summary: plain,
    requested_verifiers: [id("work_item", 3)],
    reused_reviews: [review.id],
  };
  const next = await deliver(s, forged);
  expect(next.data.reused_reviews).toBeUndefined();
  expect(next.data.status).toBe("submitted");
});

test.each([
  "reviewer",
  "designer",
  "design_director",
  "tester",
  "independent_reviewer",
])("reuse applies to the %s verification role", async (roleId) => {
  const base = fixture();
  let s: CommandState = {
    ...base,
    roles: [...base.roles, role(roleId)],
    assignments: base.assignments.map((a) =>
      a.id === id("assignment", 2) ? { ...a, role_id: roleId } : a,
    ),
    work_items: base.work_items.map((w) =>
      w.id === id("work_item", 2) ? { ...w, role_id: roleId } : w,
    ),
  };
  const first = await deliver(s);
  s = apply(s, first);
  const reviewed = pass(s, first.data, actor(2, roleId));
  s = apply(s, reviewed);
  expect((await deliver(s)).data.reused_reviews).toEqual([reviewed.data.id]);
});

test("a command never inspects or invalidates another card's review proof", async () => {
  const { s, first, review } = await passed();
  const producer = s.work_items.find((w) => w.id === params.work_item_id);
  const reviewer = s.work_items.find((w) => w.id === review.work_item_id);
  if (!producer || !reviewer) throw new Error("Missing items");
  const otherReview = {
    ...review,
    id: id("review", 900),
    delivery_id: id("delivery", 900),
    work_item_id: id("work_item", 9),
  };
  const mixed: CommandState = {
    ...s,
    work_items: [
      ...s.work_items,
      { ...producer, id: id("work_item", 8), card_id: id("card", 2) },
      { ...reviewer, id: id("work_item", 9), card_id: id("card", 2) },
    ],
    deliveries: [
      ...s.deliveries,
      { ...first, id: id("delivery", 900), work_item_id: id("work_item", 8) },
    ],
    reviews: [...s.reviews, otherReview],
  };
  const next = await deliver(mixed);
  expect(next.data.reused_reviews).toEqual([review.id]);
  expect(
    apply(mixed, next).reviews.find((r) => r.id === otherReview.id),
  ).toEqual(otherReview);
});

test("a real merge return invalidates prior review eligibility even if the producer resubmits the same SHA", async () => {
  const { s } = await passed();
  const event = s.events[0];
  if (!event) throw new Error("Missing event");
  const returned: CommandState = {
    ...s,
    events: [
      ...s.events,
      { ...event, id: io.ids.nextEventId(), type: "merge_changes_requested" },
    ],
  };
  expect((await deliver(returned)).data.reused_reviews).toBeUndefined();
});

test("publication rechecks a reused pass after completion acceptance", async () => {
  let { s, review } = await passed();
  s = apply(s, await deliver(s));
  const completion = await deliver(s, {
    ...params,
    kind: "card_completion",
    plain_summary: plain,
    requested_verifiers: [id("work_item", 3)],
  });
  s = apply(s, completion);
  s = apply(s, pass(s, completion.data, actor(3, "pm")));
  expect(prepareMergePlan(s, id("card", 1)).ok).toBe(true);
  s = apply(
    s,
    value(
      withdrawReview(
        s,
        actor(2, "reviewer"),
        {
          work_item_id: review.work_item_id,
          rationale: "Recheck before publication",
        },
        io,
      ),
    ),
  );
  expect(prepareMergePlan(s, id("card", 1))).toMatchObject({
    ok: false,
    error: { code: "stale_target" },
  });
});

test("adding an optional requested verifier keeps its target reviewable while reusing the existing pass", async () => {
  const base = fixture();
  const reviewer = base.work_items.find((w) => w.id === id("work_item", 2));
  if (!reviewer) throw new Error("Missing reviewer");
  let { s, review } = await passed({
    ...base,
    work_items: [
      ...base.work_items,
      {
        ...reviewer,
        id: id("work_item", 5),
        assignment_id: id("assignment", 5),
        required: false,
      },
    ],
    assignments: [...base.assignments, assignment(5, "reviewer")],
    runs: [...base.runs, run(5)],
  });
  const next = await deliver(s, {
    ...params,
    requested_verifiers: [...params.requested_verifiers, id("work_item", 5)],
  });
  expect(next.data.reused_reviews).toEqual([review.id]);
  expect(next.data.status).toBe("submitted");
  s = apply(s, next);
  s = apply(s, pass(s, next.data, actor(5, "reviewer")));
  expect(s.deliveries.find((v) => v.id === next.data.id)?.status).toBe(
    "accepted",
  );
});
