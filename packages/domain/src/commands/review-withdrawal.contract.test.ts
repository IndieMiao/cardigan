import { expect, test } from "vitest";
import {
  type Actor,
  type CommandState,
  deriveReviewMatrix,
  isReviewStale,
  listNeedsYou,
  projectSnapshot,
  recordMergeCheck,
  recordMergeResult,
  withdrawReview,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { apply, human, id, now, value } from "./test-fixtures.js";

const system: Actor = { kind: "system", project_id: human.project_id };
const rationale = "发现遗漏，收回通过结论后重新核查";
const snapshot = (state: CommandState): CommandState =>
  JSON.parse(JSON.stringify(state));
async function fixture() {
  const f = mergeFixture("auto");
  const delivery = await f.deliver();
  const review = f.review(delivery);
  const params = { work_item_id: review.work_item_id, rationale };
  const withdraw = (state = f.state, caller = f.actor(f.reviewer)) =>
    withdrawReview(state, caller, params, f.io);
  return { f, delivery, review, params, withdraw };
}

test("owner withdrawal preserves the review and makes the matrix await verification", async () => {
  const { f, delivery, review, params, withdraw } = await fixture();
  const before = snapshot(f.state);
  const effect = value(withdraw());
  const after = apply(f.state, effect);
  expect(f.state).toEqual(before);
  expect(after.reviews).toEqual([
    { ...review, withdrawn: { at: now, rationale } },
  ]);
  expect(
    after.work_items.find((w) => w.id === params.work_item_id)?.status,
  ).toBe("ready");
  expect(isReviewStale(effect.data, delivery)).toBe(true);
  expect(
    deriveReviewMatrix(after.deliveries, after.work_items, after.reviews),
  ).toEqual([
    {
      delivery_id: delivery.id,
      work_item_id: review.work_item_id,
      target_sha: review.target_sha,
      verdict: null,
    },
  ]);
  expect(value(projectSnapshot(after, human)).data.cards).toMatchObject([
    {
      waiting_on: [{ kind: "review", ref: review.work_item_id }],
      next_owners: [],
      why: "等待新交付",
    },
  ]);
  expect(effect.events).toMatchObject([
    {
      type: "review_withdrawn",
      actor: f.actor(f.reviewer),
      payload: { review_id: review.id, ...params },
    },
  ]);
  expect(effect.timeline).toMatchObject([
    {
      type: "system",
      body: expect.stringContaining(rationale),
      author: `assignment:${f.reviewer.id}`,
    },
  ]);
  // Card 1 does not perform the produce/completion cascades or enqueue fix Runs.
  expect(after.deliveries).toEqual(before.deliveries);
  expect(after.runs).toEqual(before.runs);
  expect(after.decisions).toEqual(before.decisions);
  expect(after.work_items.filter((w) => w.id !== review.work_item_id)).toEqual(
    before.work_items.filter((w) => w.id !== review.work_item_id),
  );
  expect(withdraw(after)).toMatchObject({
    ok: false,
    error: { code: "illegal_transition" },
  });
});

test("withdrawn ordinary reviews disappear from merge summaries while their product awaits review", async () => {
  const f = mergeFixture("confirm");
  const { product, completion } = await f.accept();
  const review = f.state.reviews.find((r) => r.delivery_id === product.id);
  if (!review) throw new Error("Expected product review");
  const summaries = () =>
    value(listNeedsYou(f.state, human)).data.decisions.find(
      (q) => q.trigger === "merge_confirmation",
    )?.merge_confirmation;
  expect(summaries()?.reviews).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: review.id, verdict: "pass" }),
    ]),
  );
  const before = snapshot(f.state);
  f.commit(
    withdrawReview(
      f.state,
      f.actor(f.reviewer),
      {
        work_item_id: review.work_item_id,
        rationale,
      },
      f.io,
    ),
  );
  expect(summaries()?.reviews).toMatchObject([
    {
      delivery_id: completion.id,
      work_item_id: f.pm.work_item_id,
      verdict: "pass",
    },
  ]);
  expect(value(projectSnapshot(f.state, human)).data.cards[0]).toMatchObject({
    status: "awaiting_merge",
    waiting_on: expect.arrayContaining([
      {
        kind: "review",
        ref: review.work_item_id,
        label: "等待新交付",
      },
    ]),
    next_owners: expect.not.arrayContaining([
      { kind: "assignment", ref: f.reviewer.id },
    ]),
  });
  // The summary omits withdrawn conclusions; the audit record and completion remain intact.
  expect(f.state.reviews.find((r) => r.id === review.id)).toEqual({
    ...review,
    withdrawn: { at: now, rationale },
  });
  expect(f.state.deliveries).toEqual(before.deliveries);
  expect(f.state.decisions).toEqual(before.decisions);
});

test("no human, system, producer, PM or other verifier may withdraw on the owner's behalf", async () => {
  const { f, withdraw } = await fixture();
  const other = { ...f.reviewer, id: id("assignment", 999) };
  const state = { ...f.state, assignments: [...f.state.assignments, other] };
  const before = snapshot(state);
  for (const caller of [
    human,
    system,
    f.actor(f.coder),
    f.actor(f.pm),
    f.actor(other),
  ])
    expect(withdraw(state, caller)).toMatchObject({
      ok: false,
      error: { code: "unauthorized" },
    });
  expect(state).toEqual(before);
});

test("PM holding an ordinary verifier follows the same ownership rule", async () => {
  const { f, review, withdraw } = await fixture();
  const state = {
    ...f.state,
    assignments: f.state.assignments.map((a) =>
      a.id === f.reviewer.id ? { ...a, role_id: "pm" } : a,
    ),
    work_items: f.state.work_items.map((w) =>
      w.id === review.work_item_id ? { ...w, role_id: "pm" } : w,
    ),
  };
  expect(withdraw(state, f.actor({ ...f.reviewer, role_id: "pm" })).ok).toBe(
    true,
  );
});

test("requires both role and token permission, an active assignment and a rationale", async () => {
  const { f, params, withdraw } = await fixture();
  const caller = f.actor(f.reviewer);
  if (caller.kind !== "assignment") throw new Error("Expected assignment");
  expect(withdraw(f.state, { ...caller, allowed_tools: [] })).toMatchObject({
    ok: false,
    error: { code: "forbidden_tool" },
  });
  expect(
    withdraw({
      ...f.state,
      roles: f.state.roles.map((r) => ({
        ...r,
        allowed_tools: r.allowed_tools.filter((t) => t !== "withdraw_review"),
      })),
    }),
  ).toMatchObject({ ok: false, error: { code: "forbidden_tool" } });
  expect(
    withdraw({
      ...f.state,
      assignments: f.state.assignments.map((a) =>
        a.id === caller.assignment_id
          ? { ...a, status: "released" as const }
          : a,
      ),
    }),
  ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  for (const reason of ["", "  \n "])
    expect(
      withdrawReview(f.state, caller, { ...params, rationale: reason }, f.io),
    ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
});

test("obsolete, withdrawn and non-pass reviews cannot be withdrawn, with no partial effects", async () => {
  const { f, review, delivery, withdraw } = await fixture();
  const states: CommandState[] = [
    { ...f.state, reviews: [] },
    { ...f.state, reviews: [{ ...review, verdict: "conditional" }] },
    { ...f.state, reviews: [{ ...review, withdrawn: { at: now, rationale } }] },
    { ...f.state, reviews: [{ ...review, target_sha: "b".repeat(40) }] },
    { ...f.state, deliveries: [{ ...delivery, status: "superseded" }] },
    {
      ...f.state,
      deliveries: [
        delivery,
        { ...delivery, id: id("delivery", 999), supersedes: delivery.id },
      ],
    },
    // Current status cannot justify falling back to an earlier pass.
    {
      ...f.state,
      reviews: [
        review,
        { ...review, id: id("review", 999), verdict: "conditional" },
      ],
    },
  ];
  for (const state of states) {
    const before = snapshot(state);
    expect(withdraw(state)).toMatchObject({
      ok: false,
      error: { code: "stale_target" },
    });
    expect(state).toEqual(before);
  }
  await f.deliver("code", "b".repeat(40));
  expect(withdraw()).toMatchObject({
    ok: false,
    error: { code: "illegal_transition" },
  });
});

test.each(["done", "cancelled"] as const)(
  "closed card %s cannot withdraw",
  async (status) => {
    const { f, withdraw } = await fixture();
    const state = {
      ...f.state,
      cards: f.state.cards.map((c) => ({ ...c, status })),
    };
    const before = snapshot(state);
    expect(withdraw(state)).toMatchObject({
      ok: false,
      error: { code: "illegal_transition" },
    });
    expect(state).toEqual(before);
  },
);

test("merge timing uses the current completion's fresh check state, not historical running events", async () => {
  const { f, withdraw } = await fixture();
  const completion = await f.deliver("card_completion");
  const acceptance = f.review(completion);
  let state = { ...f.state, project_settings: { merge_gate_enabled: true } };
  const identity = {
    card_id: f.card.id,
    completion_id: completion.id,
    attempt_id: "withdraw-check",
    candidate_sha: "b".repeat(40),
    tree_sha: "c".repeat(40),
  };
  const record = (status: "queued" | "running" | "failed") => {
    const p =
      status === "failed"
        ? {
            ...identity,
            status,
            checks: [],
            summary: "failed",
            log_ref: "withdraw-check.log",
          }
        : { ...identity, status };
    state = {
      ...apply(state, value(recordMergeCheck(state, system, p, f.io))),
      project_settings: state.project_settings,
    };
  };
  record("queued");
  expect(withdraw(state).ok).toBe(true);
  record("running");
  const before = snapshot(state);
  expect(withdraw(state)).toMatchObject({
    ok: false,
    error: { message: "合并检查正在运行，暂不能撤回" },
  });
  expect(state).toEqual(before);
  const oldCompletion = {
    ...state,
    deliveries: state.deliveries.map((v) =>
      v.id === completion.id ? { ...v, status: "superseded" as const } : v,
    ),
  };
  expect(withdraw(oldCompletion).ok).toBe(true);
  record("failed");
  expect(withdraw(state).ok).toBe(true);
  // The completion branch is intentionally deferred until its atomic cascade exists.
  expect(
    withdrawReview(
      state,
      f.actor(f.pm),
      { work_item_id: acceptance.work_item_id, rationale },
      f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
});

test("recorded merge success refuses withdrawal even if a card projection is inconsistent", async () => {
  const { f, withdraw } = await fixture();
  const completion = await f.deliver("card_completion");
  f.review(completion);
  f.commit(
    recordMergeResult(
      f.state,
      system,
      {
        card_id: f.card.id,
        completion_id: completion.id,
        result: {
          kind: "merged",
          previous_sha: "b".repeat(40),
          merge_sha: "c".repeat(40),
        },
      },
      f.io,
    ),
  );
  const state = {
    ...f.state,
    cards: f.state.cards.map((c) => ({
      ...c,
      status: "awaiting_merge" as const,
    })),
  };
  const before = snapshot(state);
  expect(withdraw(state)).toMatchObject({
    ok: false,
    error: { message: "卡片已经合并，不能撤回审核" },
  });
  expect(state).toEqual(before);
});
