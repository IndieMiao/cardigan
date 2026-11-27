import { expect, test } from "vitest";
import type {
  CommandState,
  Delivery,
  ReviewIssue,
  WorkItem,
} from "../index.js";
import {
  effectivePreMergeChecks,
  prepareDelivery,
  submitDelivery,
  submitReview,
  systemCompleteCard,
  updateCard,
} from "../index.js";
import {
  actor,
  apply,
  assignment,
  convergent,
  fixture,
  human,
  id,
  ports,
  role,
  run,
  subject,
  value,
} from "./test-fixtures.js";

/**
 * C-805: an independent review covers its target producers. Outputs that bring
 * no code (a signed package) never make it stale; code from another producer
 * does, and then the review item is reopened instead of waiting at a merge
 * gate that accepts no review.
 */
const plain = {
  changed: "修正显示内容",
  impact: "页面显示最新结果",
  risk: "无",
};
const system = { kind: "system" as const, project_id: human.project_id };
const CODE = id("work_item", 1);
const REVIEW = id("work_item", 2);
const ACCEPT = id("work_item", 3);
const INDEPENDENT = id("work_item", 40);
const RELEASE = id("work_item", 50);

function present<T>(v: T | null | undefined): T {
  if (v == null) throw new Error("Missing fixture");
  return v;
}

async function setup() {
  const seed = fixture();
  const base = present(seed.work_items.find((w) => w.id === REVIEW));
  const independent = {
    ...base,
    id: INDEPENDENT,
    title: "Independent review",
    role_id: "independent_reviewer",
    assignment_id: id("assignment", 40),
    template_key: "independent",
  } as WorkItem;
  const release = {
    ...present(seed.work_items.find((w) => w.id === CODE)),
    id: RELEASE,
    title: "Signing",
    role_id: "release_ops",
    status: "in_progress",
    assignment_id: id("assignment", 50),
    template_key: "signing",
  } as WorkItem;
  let state: CommandState = {
    ...seed,
    roles: [...seed.roles, role("independent_reviewer"), role("release_ops")],
    cards: seed.cards.map((c) => ({
      ...c,
      flow_version: 5,
      risk_tags: ["permission"],
    })),
    work_items: [...seed.work_items, independent],
    assignments: [
      ...seed.assignments,
      assignment(40, "independent_reviewer"),
      assignment(50, "release_ops"),
    ],
    runs: [...seed.runs, run(40), run(50)],
  };
  const io = ports();
  let runs = 1000;
  const commit = <T>(r: Parameters<typeof apply>[1] & { data: T }) => {
    state = apply(state, r);
    return r.data;
  };
  /** A fresh running Run: each Run may submit only one review. */
  const fresh = (n: number) => {
    state = {
      ...state,
      runs: [
        ...state.runs.map((r) =>
          r.assignment_id === id("assignment", n) && r.status === "running"
            ? { ...r, status: "completed" as const }
            : r,
        ),
        { ...run(++runs, n) },
      ],
    };
  };
  const card = () => present(state.cards.find((c) => c.id === id("card", 1)));
  const current = (item: string) =>
    present(
      state.deliveries
        .filter(
          (v) =>
            v.work_item_id === item &&
            v.kind !== "card_completion" &&
            v.status !== "superseded",
        )
        .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0],
    );
  async function deliver(
    n: number,
    p: Omit<Parameters<typeof submitDelivery>[2], "plain_summary">,
  ): Promise<Delivery> {
    fresh(n);
    const params = { ...p, plain_summary: plain };
    const proof = value(
      await prepareDelivery(
        state,
        actor(n, p.work_item_id === CODE ? "coder" : "release_ops"),
        params,
        {
          verify: async (s) => ({
            ok: true,
            value:
              s.kind === "git_head"
                ? [
                    {
                      kind: "commit",
                      details: { sha: s.value, tree_sha: "c".repeat(40) },
                    },
                  ]
                : [],
          }),
        },
      ),
    );
    return commit(
      value(
        submitDelivery(
          state,
          actor(n, p.work_item_id === CODE ? "coder" : "release_ops"),
          params,
          proof,
          io,
        ),
      ),
    );
  }
  const code = (sha = subject.value) =>
    deliver(1, {
      work_item_id: CODE,
      kind: "code",
      summary: "Ready",
      subject: { ...subject, value: sha },
      requested_verifiers: [REVIEW, INDEPENDENT],
    });
  const signed = (s: Delivery["subject"]) =>
    deliver(50, {
      work_item_id: RELEASE,
      kind: s.kind === "git_head" ? "code" : "other",
      summary: "Signed package",
      subject: s,
      requested_verifiers: [],
    });
  const review = (
    n: number,
    role_id: string,
    target: Delivery,
    issues: ReviewIssue[] = [],
  ) => {
    fresh(n);
    const rule = convergent(state, target.requested_verifiers[0] ?? "");
    return commit(
      value(
        submitReview(
          state,
          actor(n, role_id),
          {
            delivery_id: target.id,
            target_sha: target.subject.value,
            kind: target.kind === "card_completion" ? "product" : "code",
            issues: issues.map((i) => ({ ...i, basis: rule.basis })),
            ...(issues.length ? { pass_conditions: rule.pass_conditions } : {}),
          },
          io,
        ),
      ),
    );
  };
  const complete = () =>
    commit(
      value(systemCompleteCard(state, system, { card_id: id("card", 1) }, io)),
    );
  const independentCheck = () =>
    effectivePreMergeChecks(card(), state.work_items, state.deliveries).find(
      (c) => c.label === "独立复核",
    );
  const item = (w: string) => present(state.work_items.find((v) => v.id === w));
  const addRelease = () => {
    state = { ...state, work_items: [...state.work_items, release] };
  };
  /** Code review, independent review, then the signing producer joins (C-175 order). */
  async function reviewed() {
    const product = await code();
    review(2, "reviewer", product);
    review(40, "independent_reviewer", product);
    expect(independentCheck()).toMatchObject({
      status: "passed",
      stale: false,
    });
    addRelease();
    return product;
  }
  /** System completion, accepted by PM: the card waits for merge. */
  function accepted() {
    const completion = present(complete());
    expect(completion.requested_verifiers).toEqual([ACCEPT]);
    review(3, "pm", completion);
    expect(card().status).toBe("awaiting_merge");
    return completion;
  }
  return {
    get state() {
      return state;
    },
    set state(v: CommandState) {
      state = v;
    },
    io,
    commit,
    card,
    current,
    code,
    signed,
    review,
    complete,
    independentCheck,
    item,
    reviewed,
    accepted,
  };
}

test.each([
  ["artifact", { kind: "artifact_sha256" as const, value: "f".repeat(64) }],
  ["same commit", subject],
])(
  "C-805: a %s output from another producer keeps the independent review current through completion and merge gate",
  async (_name, signedSubject) => {
    const f = await setup();
    const product = await f.reviewed();
    await f.signed(signedSubject);
    expect(f.independentCheck()).toMatchObject({
      status: "passed",
      stale: false,
    });
    const completion = f.accepted();
    expect(
      completion.system_completion?.products.map((v) => v.delivery_id),
    ).toEqual([product.id, f.current(RELEASE).id]);
    // The gate and the binding agree: nothing is reopened, nothing revoked.
    expect(f.complete()).toBeNull();
    expect(f.card().status).toBe("awaiting_merge");
    expect(f.item(INDEPENDENT).status).toBe("passed");
    expect(f.state.deliveries.find((v) => v.id === completion.id)?.status).toBe(
      "accepted",
    );
    expect(f.independentCheck()).toMatchObject({
      status: "passed",
      stale: false,
    });
  },
);

test("C-805: code from another producer makes the review stale, withholds completion and reopens the reviewer", async () => {
  const f = await setup();
  const product = await f.reviewed();
  await f.signed({ kind: "git_head", value: "d".repeat(40) });
  expect(f.independentCheck()).toMatchObject({
    status: "pending",
    stale: true,
  });
  expect(f.complete()).toBeNull();
  // The reviewer has a reviewable target again and is told so.
  expect(f.item(INDEPENDENT).status).toBe("ready");
  expect(f.item(CODE).status).toBe("delivered");
  expect(f.current(CODE)).toMatchObject({
    id: product.id,
    status: "submitted",
  });
  expect(
    f.state.events.findLast((e) => e.type === "delivery_verifier_added")
      ?.payload,
  ).toMatchObject({
    delivery_id: product.id,
    work_item_id: INDEPENDENT,
    reason: "independent_review_recheck",
  });
  expect(f.state.deliveries.some((v) => v.kind === "card_completion")).toBe(
    false,
  );
  // Idempotent while the review is outstanding.
  expect(f.complete()).toBeNull();
  expect(
    f.state.events.filter((e) => e.type === "delivery_verifier_added"),
  ).toHaveLength(1);
  f.review(40, "independent_reviewer", product);
  expect(f.item(CODE).status).toBe("accepted");
  expect(f.independentCheck()).toMatchObject({
    status: "passed",
    stale: false,
  });
  const completion = f.accepted();
  expect(
    completion.system_completion?.reviews.map((r) => r.work_item_id),
  ).toEqual(expect.arrayContaining([REVIEW, INDEPENDENT]));
  expect(f.complete()).toBeNull();
  expect(f.card().status).toBe("awaiting_merge");
});

test("C-805: a gate pending at awaiting_merge revokes the completion and returns the review to its reviewer", async () => {
  const f = await setup();
  const product = await f.reviewed();
  await f.signed({ kind: "artifact_sha256", value: "f".repeat(64) });
  const completion = f.accepted();
  // A pre-fix state: the stored versions no longer match the reviewed target.
  f.state = {
    ...f.state,
    cards: f.state.cards.map((c) =>
      c.id === id("card", 1)
        ? {
            ...c,
            pre_merge_checks: (c.pre_merge_checks ?? []).map((check) =>
              check.label === "独立复核"
                ? {
                    ...check,
                    checked_versions: (check.checked_versions ?? []).map(
                      (v) => ({ ...v, delivery_id: id("delivery", 1) }),
                    ),
                  }
                : check,
            ),
          }
        : c,
    ),
  };
  expect(f.independentCheck()).toMatchObject({
    status: "pending",
    stale: true,
  });
  expect(f.card().status).toBe("awaiting_merge");
  expect(f.complete()).toBeNull();
  expect(f.card().status).not.toBe("awaiting_merge");
  expect(f.state.deliveries.find((v) => v.id === completion.id)?.status).toBe(
    "superseded",
  );
  expect(
    f.state.events.findLast((e) => e.type === "completion_invalidated")
      ?.payload,
  ).toMatchObject({ reason: "independent_review_recheck" });
  expect(f.item(INDEPENDENT).status).toBe("ready");
  // The reviewer can now submit; the merge path resumes on its own.
  f.review(40, "independent_reviewer", product);
  expect(f.independentCheck()).toMatchObject({
    status: "passed",
    stale: false,
  });
  f.accepted();
});

test("C-805: a pending reset by PM Ops at awaiting_merge also has an exit", async () => {
  const f = await setup();
  const product = await f.reviewed();
  await f.signed({ kind: "artifact_sha256", value: "f".repeat(64) });
  f.accepted();
  f.commit(
    value(
      updateCard(
        f.state,
        human,
        {
          card_id: id("card", 1),
          pre_merge_check: { label: "独立复核", status: "pending" },
        },
        f.io,
      ),
    ),
  );
  expect(f.independentCheck()).toMatchObject({
    status: "pending",
    stale: false,
  });
  expect(f.complete()).toBeNull();
  expect(f.item(INDEPENDENT).status).toBe("ready");
  f.review(40, "independent_reviewer", product);
  f.accepted();
  expect(f.independentCheck()).toMatchObject({ status: "passed" });
});

test("C-805 regression (C-175 order): after a returned completion the regenerated request keeps a valid independent review", async () => {
  const f = await setup();
  await f.reviewed();
  await f.signed({ kind: "artifact_sha256", value: "f".repeat(64) });
  const first = present(f.complete());
  // C-175 stalled here: the gate called the review stale, the request omitted it.
  expect(f.independentCheck()).toMatchObject({
    status: "passed",
    stale: false,
  });
  // PM returns the completion request.
  f.review(3, "pm", first, [
    {
      severity: "major",
      impact: "functional",
      must_fix: true,
      pre_existing: false,
      description: "需要补充说明",
    },
  ]);
  expect(f.card().status).toBe("in_progress");
  // The author redelivers the same commit; every required verifier is listed.
  const again = await f.code();
  for (const [n, role_id, w] of [
    [2, "reviewer", REVIEW],
    [40, "independent_reviewer", INDEPENDENT],
  ] as const)
    if (f.item(w).status !== "passed") f.review(n, role_id, again);
  expect(f.independentCheck()).toMatchObject({
    status: "passed",
    stale: false,
  });
  const second = f.accepted();
  expect(second.id).not.toBe(first.id);
  expect(f.complete()).toBeNull();
  expect(f.card().status).toBe("awaiting_merge");
  expect(f.independentCheck()).toMatchObject({
    status: "passed",
    stale: false,
  });
});
