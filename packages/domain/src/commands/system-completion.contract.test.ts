import { expect, test } from "vitest";
import type { CommandState, Delivery, ReviewIssue } from "../index.js";
import {
  createWorkItem,
  developmentCardTemplate,
  mergePlan,
  postComment,
  prepareDelivery,
  submitDelivery,
  submitReview,
  systemCompleteCard,
  updateCard,
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

const plain = {
  changed: "修正显示内容",
  impact: "页面会显示最新结果",
  risk: "无",
};
const system = { kind: "system" as const, project_id: human.project_id };
async function setup(version = 5) {
  let state: CommandState = {
    ...fixture(),
    cards: fixture().cards.map((c) => ({ ...c, flow_version: version })),
  };
  const io = ports();
  const commit = <T>(r: Parameters<typeof apply>[1] & { data: T }) => {
    state = apply(state, r);
    return r.data;
  };
  async function deliver(sha = subject.value) {
    const p = {
      work_item_id: id("work_item", 1),
      kind: "code" as const,
      summary: "Ready",
      subject: { ...subject, value: sha },
      requested_verifiers: [id("work_item", 2)],
      ...(version >= 5 ? { plain_summary: plain } : {}),
    };
    const proof = value(
      await prepareDelivery(state, actor(), p, {
        verify: async () => ({
          ok: true,
          value: [
            { kind: "commit", details: { sha, tree_sha: "c".repeat(40) } },
          ],
        }),
      }),
    );
    return commit(value(submitDelivery(state, actor(), p, proof, io)));
  }
  const product = await deliver();
  const review = (issues: ReviewIssue[] = []) =>
    commit(
      value(
        submitReview(
          state,
          actor(2, "reviewer"),
          {
            delivery_id:
              state.deliveries.find(
                (v) => v.kind === "code" && v.status !== "superseded",
              )?.id ?? product.id,
            target_sha:
              state.deliveries.find(
                (v) => v.kind === "code" && v.status !== "superseded",
              )?.subject.value ?? product.subject.value,
            kind: "code",
            issues,
          },
          io,
        ),
      ),
    );
  const complete = () =>
    commit(
      value(systemCompleteCard(state, system, { card_id: id("card", 1) }, io)),
    );
  return {
    get state() {
      return state;
    },
    set state(v: CommandState) {
      state = v;
    },
    io,
    commit,
    product,
    review,
    deliver,
    complete,
  };
}
function present<T>(v: T | null | undefined): T {
  if (v == null) throw new Error("Missing fixture");
  return v;
}

test("B3a: system binds current products and review sources, requests PM review once", async () => {
  const f = await setup();
  expect(f.complete()).toBeNull();
  const review = f.review();
  f.commit(
    value(
      postComment(
        f.state,
        actor(2, "reviewer"),
        {
          card_id: id("card", 1),
          body: "验收标准：显示结果已核对，证据见附件。",
          refs: [{ kind: "review", id: review.id }],
        },
        f.io,
      ),
    ),
  );
  f.commit(
    value(
      postComment(
        f.state,
        actor(),
        {
          card_id: id("card", 1),
          body: "作者冒充审核对照，不应被采纳",
          refs: [{ kind: "review", id: review.id }],
        },
        f.io,
      ),
    ),
  );
  const completion = present(f.complete());
  expect(completion).toMatchObject({
    kind: "card_completion",
    status: "submitted",
    subject,
    plain_summary: plain,
    requested_verifiers: [id("work_item", 3)],
    system_completion: {
      products: [{ delivery_id: f.product.id, subject, plain_summary: plain }],
      reviews: [
        {
          review_id: review.id,
          target_sha: subject.value,
          acceptance_evidence_missing: false,
          acceptance_evidence: [
            { body: "验收标准：显示结果已核对，证据见附件。" },
          ],
        },
      ],
    },
  });
  expect(
    f.state.timeline.find(
      (t) => t.delivery_id === completion.id && t.type === "delivery",
    )?.author,
  ).toBe("system");
  expect(f.complete()).toBeNull();
  expect(
    f.state.deliveries.filter((v) => v.kind === "card_completion"),
  ).toHaveLength(1);
  expect(mergePlan(f.state, id("card", 1)).ok).toBe(false);
});

test.each([false, true])(
  "B3a: an undelivered producer blocks completion only when required=%s",
  async (required) => {
    const f = await setup();
    f.commit(
      value(
        createWorkItem(
          f.state,
          human,
          {
            card_id: id("card", 1),
            title: "Additional report",
            kind: "produce",
            role_id: "coder",
            required,
            completion_criteria: ["Report findings"],
          },
          f.io,
        ),
      ),
    );
    f.review();
    const completion = f.complete();
    if (required) expect(completion).toBeNull();
    else
      expect(present(completion).system_completion?.products).toMatchObject([
        { delivery_id: f.product.id, subject: f.product.subject },
      ]);
  },
);

test("B3a: a real passing review retains pre-existing issues without blocking aggregation", async () => {
  const f = await setup();
  const issues: ReviewIssue[] = [
    {
      severity: "major",
      must_fix: true,
      pre_existing: true,
      description: "Existing unrelated issue",
    },
  ];
  const review = f.review(issues);
  expect(review).toMatchObject({ verdict: "pass", blocking: false });
  const completion = present(f.complete());
  expect(completion.system_completion?.reviews).toMatchObject([
    { review_id: review.id, issues },
  ]);
});

test.each([
  "source_reference",
  "submission_reference",
  "submission_validation",
])(
  "B3a: internal %s failures surface instead of silently waiting",
  async (failure) => {
    const f = await setup();
    const review = f.review();
    f.state = {
      ...f.state,
      reviews: f.state.reviews.map((r) =>
        failure === "source_reference" && r.id === review.id
          ? { ...r, run_id: id("run", 9999) }
          : r,
      ),
      deliveries: f.state.deliveries.map((v) =>
        v.id !== f.product.id
          ? v
          : {
              ...v,
              ...(failure === "submission_reference"
                ? { attachments: ["missing-attachment"] }
                : {}),
              ...(failure === "submission_validation"
                ? { plain_summary: { ...plain, risk: "D-123" } }
                : {}),
            },
      ),
    };
    expect(
      systemCompleteCard(f.state, system, { card_id: id("card", 1) }, f.io),
    ).toMatchObject({
      ok: false,
      error: {
        code:
          failure === "submission_validation"
            ? "validation_failed"
            : "not_found",
      },
    });
  },
);

test.each([1, 4])(
  "B3a: flow %i keeps author completion and never aggregates",
  async (v) => {
    const f = await setup(v);
    f.review();
    expect(f.complete()).toBeNull();
    const p = {
      work_item_id: f.product.work_item_id,
      kind: "card_completion" as const,
      summary: "Complete",
      subject,
      requested_verifiers: [id("work_item", 3)],
      plain_summary: plain,
    };
    expect(
      (
        await prepareDelivery(f.state, actor(), p, {
          verify: async () => ({ ok: true, value: [] }),
        })
      ).ok,
    ).toBe(true);
  },
);

test("B3a: authors, humans, other projects and forged system completion parameters cannot bypass the rule", async () => {
  const f = await setup();
  f.review();
  for (const caller of [human, actor(), { ...system, project_id: "other" }])
    expect(
      systemCompleteCard(f.state, caller, { card_id: id("card", 1) }, f.io).ok,
    ).toBe(false);
  const p = {
    work_item_id: f.product.work_item_id,
    kind: "card_completion" as const,
    summary: "Complete",
    subject,
    requested_verifiers: [id("work_item", 3)],
    plain_summary: plain,
  };
  expect(
    await prepareDelivery(f.state, actor(), p, {
      verify: async () => ({ ok: true, value: [] }),
    }),
  ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
});

test.each([
  "status_only",
  "different_sha",
  "withdrawn",
  "must_fix",
  "missing_product",
])("B3a: %s cannot satisfy current review prerequisites", async (mode) => {
  const f = await setup();
  const review = f.review();
  f.state = {
    ...f.state,
    reviews:
      mode === "status_only"
        ? []
        : f.state.reviews.map((r) =>
            r.id !== review.id
              ? r
              : {
                  ...r,
                  ...(mode === "different_sha"
                    ? { target_sha: "b".repeat(40) }
                    : {}),
                  ...(mode === "withdrawn"
                    ? { withdrawn: { at: "2026-01-01", rationale: "withdraw" } }
                    : {}),
                  ...(mode === "must_fix"
                    ? {
                        issues: [
                          {
                            severity: "minor" as const,
                            must_fix: true,
                            pre_existing: false,
                            description: "fix",
                          },
                        ],
                      }
                    : {}),
                },
          ),
    deliveries: mode === "missing_product" ? [] : f.state.deliveries,
  };
  expect(f.complete()).toBeNull();
});

test("B3a: missing independent review is a persistent, deduplicated exception; known gaps cannot waive it", async () => {
  const f = await setup();
  f.review();
  f.state = {
    ...f.state,
    cards: f.state.cards.map((c) => ({
      ...c,
      risk_tags: ["security"],
      high_risk: true,
    })),
  };
  expect(f.complete()).toBeNull();
  expect(f.complete()).toBeNull();
  expect(
    f.state.events.filter((e) => e.type === "system_completion_deferred"),
  ).toHaveLength(1);
});

test("B3a: human template still requests a human decision and never accepts directly", async () => {
  const f = await setup();
  f.review();
  f.state = {
    ...f.state,
    cards: f.state.cards.map((c) => ({
      ...c,
      risk_tags: ["security"],
      high_risk: true,
    })),
    card_templates: [
      {
        ...developmentCardTemplate,
        completion: { mode: "review", reviewer: "human" },
        work_items: developmentCardTemplate.work_items.filter(
          (w) => w.key !== "pm_acceptance",
        ),
      },
    ],
    work_items: f.state.work_items.filter(
      (w) => w.template_key !== "pm_acceptance",
    ),
  };
  const completion = present(f.complete());
  expect(completion.status).toBe("submitted");
  expect(completion.requested_verifiers).toEqual([]);
  expect(f.state.decisions).toMatchObject([
    {
      trigger: "completion_review",
      decider: "human",
      human_required_reason: expect.any(String),
      target: { delivery_id: completion.id },
    },
  ]);
  expect(f.state.cards.find((c) => c.id === id("card", 1))?.status).toBe(
    "review",
  );
});

test("B3a: a template without completion work directly enters merge, without fabricating PM review", async () => {
  const f = await setup();
  f.review();
  f.state = {
    ...f.state,
    card_templates: [
      {
        ...developmentCardTemplate,
        work_items: developmentCardTemplate.work_items.filter(
          (w) => w.key !== "pm_acceptance",
        ),
      },
    ],
    work_items: f.state.work_items.filter(
      (w) => w.template_key !== "pm_acceptance",
    ),
  };
  const completion = present(f.complete());
  expect(completion.status).toBe("accepted");
  expect(f.state.cards.find((c) => c.id === id("card", 1))?.status).toBe(
    "awaiting_merge",
  );
  expect(f.state.reviews).toHaveLength(1);
  expect(mergePlan(f.state, id("card", 1)).ok).toBe(false);
});

test("B3a: withdrawal atomically invalidates the generated request and pending acceptance", async () => {
  const f = await setup();
  f.review();
  const completion = present(f.complete());
  f.commit(
    value(
      withdrawReview(
        f.state,
        actor(2, "reviewer"),
        { work_item_id: id("work_item", 2), rationale: "need new review" },
        f.io,
      ),
    ),
  );
  expect(f.state.deliveries.find((v) => v.id === completion.id)?.status).toBe(
    "superseded",
  );
  expect(
    f.state.work_items.find((w) => w.id === id("work_item", 3))?.status,
  ).toBe("todo");
  expect(f.complete()).toBeNull();
});

test("B3a: multiple producers with different SHAs are bound; any new product revokes the whole request", async () => {
  const f = await setup();
  f.review();
  const { plain_summary: _missing, ...withoutPlain } = f.product;
  const extra: Delivery = {
    ...withoutPlain,
    id: id("delivery", 5000),
    work_item_id: id("work_item", 50),
    subject: { ...subject, value: "b".repeat(40) },
    requested_verifiers: [],
    status: "accepted",
  };
  const producer = present(
    f.state.work_items.find((w) => w.kind === "produce"),
  );
  if (producer.kind !== "produce") throw new Error("Expected producer");
  f.state = {
    ...f.state,
    work_items: [
      ...f.state.work_items,
      {
        ...producer,
        id: extra.work_item_id,
        kind: "produce",
        status: "accepted",
        template_key: "extra",
      },
    ],
    deliveries: [...f.state.deliveries, extra],
  };
  f.state = {
    ...f.state,
    work_items: f.state.work_items.map((w) =>
      w.id === extra.work_item_id
        ? { ...w, assignment_id: id("assignment", 50) }
        : w,
    ),
    assignments: [...f.state.assignments, assignment(50)],
    runs: [...f.state.runs, run(50)],
  };
  const completion = present(f.complete());
  expect(
    completion.system_completion?.products.map((v) => v.subject.value),
  ).toEqual([subject.value, extra.subject.value]);
  expect(completion.system_completion?.products[1]?.plain_summary).toBeNull();
  const extraParams = {
    work_item_id: extra.work_item_id,
    kind: "code" as const,
    summary: "Changed secondary product",
    subject: { ...subject, value: "d".repeat(40) },
    requested_verifiers: [],
  };
  const extraProof = value(
    await prepareDelivery(f.state, actor(50), extraParams, {
      verify: async () => ({ ok: true, value: [] }),
    }),
  );
  f.commit(
    value(submitDelivery(f.state, actor(50), extraParams, extraProof, f.io)),
  );
  expect(f.state.deliveries.find((v) => v.id === completion.id)?.status).toBe(
    "superseded",
  );
});

test("B3a: a missing declared completion reviewer never becomes an implicit approval", async () => {
  const f = await setup();
  f.review();
  f.state = {
    ...f.state,
    work_items: f.state.work_items.filter(
      (w) => w.template_key !== "pm_acceptance",
    ),
  };
  expect(f.complete()).toBeNull();
});

test("B3a: only an effective independent pass for the current product can satisfy risk prerequisites", async () => {
  const f = await setup();
  const base = present(
    f.state.work_items.find(
      (w) => w.kind === "verify" && w.target_work_item_id,
    ),
  );
  if (base.kind !== "verify") throw new Error("Expected verifier");
  const independent = {
    ...base,
    id: id("work_item", 40),
    role_id: "independent_reviewer",
    assignment_id: id("assignment", 40),
    template_key: "independent",
  };
  f.state = {
    ...f.state,
    roles: [...f.state.roles, role("independent_reviewer")],
    cards: f.state.cards.map((c) => ({
      ...c,
      risk_tags: ["permission"],
      high_risk: true,
    })),
    work_items: [...f.state.work_items, independent],
    assignments: [
      ...f.state.assignments,
      assignment(40, "independent_reviewer"),
    ],
    runs: [...f.state.runs, run(40)],
    deliveries: f.state.deliveries.map((v) => ({
      ...v,
      requested_verifiers: [...v.requested_verifiers, independent.id],
    })),
  };
  f.review();
  expect(f.complete()).toBeNull();
  f.commit(
    value(
      submitReview(
        f.state,
        actor(40, "independent_reviewer"),
        {
          delivery_id: f.product.id,
          target_sha: subject.value,
          kind: "code",
          issues: [],
        },
        f.io,
      ),
    ),
  );
  const completion = present(f.complete());
  expect(completion.system_completion?.reviews).toHaveLength(2);
  // Historical employee overlap cannot be hidden by the system's own identity.
  f.state = {
    ...f.state,
    assignments: f.state.assignments.map((a) =>
      [id("assignment", 1), independent.assignment_id].includes(a.id)
        ? { ...a, employee_id: "E-1" as never }
        : a,
    ),
  };
  expect(f.complete()).toBeNull();
  expect(f.state.deliveries.find((v) => v.id === completion.id)?.status).toBe(
    "superseded",
  );
});

test("B3a: obsolete source evidence rejects both completion review and later publication", async () => {
  const f = await setup();
  f.review();
  const completion = present(f.complete());
  const current = f.state;
  const changed: CommandState = {
    ...current,
    reviews: current.reviews.map((r) => ({
      ...r,
      withdrawn: { at: "2031-01-01", rationale: "stale source" },
    })),
  };
  expect(
    submitReview(
      changed,
      actor(3, "pm"),
      {
        delivery_id: completion.id,
        target_sha: completion.subject.value,
        kind: "product",
        issues: [],
      },
      f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "stale_target" } });
  f.commit(
    value(
      submitReview(
        current,
        actor(3, "pm"),
        {
          delivery_id: completion.id,
          target_sha: completion.subject.value,
          kind: "product",
          issues: [],
        },
        f.io,
      ),
    ),
  );
  const stale = {
    ...f.state,
    deliveries: f.state.deliveries.map((v) =>
      v.id === f.product.id
        ? { ...v, subject: { ...v.subject, value: "d".repeat(40) } }
        : v,
    ),
  };
  expect(mergePlan(stale, id("card", 1))).toMatchObject({
    ok: false,
    error: { code: "stale_target" },
  });
});

test("B3a: a rejected completion is not automatically resubmitted", async () => {
  const f = await setup();
  f.review();
  const completion = present(f.complete());
  f.commit(
    value(
      submitReview(
        f.state,
        actor(3, "pm"),
        {
          delivery_id: completion.id,
          target_sha: completion.subject.value,
          kind: "product",
          issues: [
            {
              severity: "major",
              must_fix: true,
              pre_existing: false,
              description: "Need evidence",
            },
          ],
        },
        f.io,
      ),
    ),
  );
  expect(f.complete()).toBeNull();
  expect(f.complete()).toBeNull();
  expect(
    f.state.deliveries.filter((v) => v.kind === "card_completion"),
  ).toHaveLength(1);
});

test.each(["accepted", "cancelled"] as const)(
  "B3a: accepted output of an optional %s producer remains bound to the actual merge candidate set",
  async (status) => {
    const f = await setup();
    f.review();
    const producer = present(
      f.state.work_items.find((w) => w.kind === "produce"),
    );
    if (producer.kind !== "produce") throw new Error("Expected producer");
    const extra = {
      ...f.product,
      id: id("delivery", 5000),
      work_item_id: id("work_item", 50),
      subject: { ...subject, value: "b".repeat(40) },
      requested_verifiers: [],
      status: "accepted" as const,
    };
    f.state = {
      ...f.state,
      work_items: [
        ...f.state.work_items,
        {
          ...producer,
          id: extra.work_item_id,
          required: false,
          status,
          template_key: "extra",
        },
      ],
      deliveries: [...f.state.deliveries, extra],
    };
    expect(
      present(f.complete()).system_completion?.products.map(
        (v) => v.delivery_id,
      ),
    ).toContain(extra.id);
  },
);

test("hold preserves current reviews and system completion; new versions retain normal invalidation", async () => {
  const f = await setup();
  f.review();
  const change = (hold: { reason: string; resume_condition: string } | null) =>
    f.commit(
      value(updateCard(f.state, human, { card_id: id("card", 1), hold }, f.io)),
    );
  change({ reason: "wait", resume_condition: "ready" });
  expect(f.complete()).toBeNull();
  const reviews = f.state.reviews;
  change(null);
  const completion = present(f.complete());
  change({ reason: "wait", resume_condition: "ready" });
  expect(f.state.reviews).toEqual(reviews);
  expect(f.state.deliveries.find((v) => v.id === completion.id)).toEqual(
    completion,
  );
  await f.deliver("b".repeat(40));
  expect(f.state.deliveries.find((v) => v.id === completion.id)?.status).toBe(
    "superseded",
  );
  expect(f.state.cards.find((c) => c.id === id("card", 1))?.hold).toBeDefined();
});
