import { expect, test } from "vitest";
import {
  type Actor,
  type CommandState,
  mergePlan,
  recordDecision,
  requestDeliveryRework,
  withdrawReview,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { apply, human, id, role, value } from "./test-fixtures.js";

async function fixture(completion = true) {
  const f = mergeFixture();
  const product = await f.deliver();
  const review = f.review(product);
  if (completion) {
    const c = await f.deliver("card_completion");
    f.review(c);
  }
  f.commit(
    withdrawReview(
      f.state,
      f.actor(f.reviewer),
      {
        work_item_id: review.work_item_id,
        rationale: "New requirement requires implementation",
      },
      f.io,
    ),
  );
  const params = {
    work_item_id: product.work_item_id,
    delivery_id: product.id,
    target_sha: product.subject.value,
    review_id: review.id,
    rationale: "Implement the newly approved requirement",
  };
  return { f, product, review, params };
}
const answer = (decision_id: ReturnType<typeof id<"decision">>) => ({
  decision_id,
  option: "return_for_rework",
  rationale: "Return this exact version",
  raw_quote: "Please return this version",
});

test.each([undefined, 1, 2])(
  "human return is atomic and requires fresh verification (flow %s)",
  async (flow) => {
    const { f, product, review, params } = await fixture();
    const state = {
      ...f.state,
      cards: f.state.cards.map((c) => ({
        ...c,
        ...(flow === undefined ? {} : { flow_version: flow }),
      })),
    };
    const requested = value(requestDeliveryRework(state, human, params, f.io));
    const waiting = apply(state, requested);
    expect(waiting.deliveries).toEqual(state.deliveries);
    expect(waiting.runs).toEqual(state.runs);
    expect(mergePlan(waiting, f.card.id).ok).toBe(false);
    expect(requested.data).toMatchObject({
      decider: "human",
      trigger: "accepted_delivery_rework",
      rework_target: {
        delivery_id: product.id,
        target_sha: params.target_sha,
        review_id: review.id,
        work_item_id: params.work_item_id,
      },
    });
    const effect = value(
      recordDecision(waiting, human, answer(requested.data.id), f.io),
    );
    const after = apply(waiting, effect);
    expect(after.cards[0]?.status).toBe("in_progress");
    expect(
      after.work_items.find((w) => w.id === product.work_item_id)?.status,
    ).toBe("changes_requested");
    expect(after.deliveries.every((v) => v.status === "superseded")).toBe(true);
    expect(
      after.work_items.filter((w) => w.kind === "verify").map((w) => w.status),
    ).toEqual(["todo", "todo"]);
    expect(after.reviews).toEqual(state.reviews);
    expect(
      after.reviews.find((r) => r.id === review.id)?.withdrawn,
    ).toBeDefined();
    expect(after.assignments).toEqual(state.assignments);
    expect(
      after.events.filter((e) => e.type === "merge_changes_requested"),
    ).toMatchObject([
      {
        actor: human,
        payload: {
          delivery_id: product.id,
          target_sha: product.subject.value,
          review_id: review.id,
          run_kind: "fix",
        },
      },
    ]);
    expect(
      recordDecision(after, human, answer(requested.data.id), f.io),
    ).toMatchObject({ ok: false });
    expect(requestDeliveryRework(after, human, params, f.io)).toMatchObject({
      ok: false,
    });
  },
);

const missing = (): never => {
  throw new Error("Missing fixture");
};

test("Ops can request, but no PM, author, reviewer or system can approve", async () => {
  const { f, params } = await fixture(false);
  const { work_item_id: _work, ...base } = f.pm;
  const ops = {
    ...base,
    id: id("assignment", 70),
    scope: "standing" as const,
    standing_mode: "ops" as const,
  };
  const state = { ...f.state, assignments: [...f.state.assignments, ops] };
  const actor: Actor = {
    kind: "assignment",
    project_id: state.project_id,
    assignment_id: ops.id,
    ...role("pm"),
  };
  const q = value(requestDeliveryRework(state, actor, params, f.io));
  const pending = apply(state, q);
  expect(
    value(requestDeliveryRework(pending, actor, params, f.io)).data.id,
  ).toBe(q.data.id);
  for (const caller of [
    actor,
    f.actor(f.coder),
    f.actor(f.reviewer),
    f.actor(f.pm),
    { kind: "system" as const, project_id: state.project_id },
  ]) {
    expect(
      recordDecision(pending, caller, answer(q.data.id), f.io),
    ).toMatchObject({ ok: false });
  }
  for (const caller of [
    f.actor(f.coder),
    f.actor(f.reviewer),
    f.actor(f.pm),
    { ...actor, assignment_id: f.pm.id },
  ]) {
    expect(requestDeliveryRework(state, caller, params, f.io)).toMatchObject({
      ok: false,
    });
  }
  const office: CommandState = {
    ...state,
    assignments: state.assignments.map((a) =>
      a.id === ops.id ? { ...ops, standing_mode: "office" } : a,
    ),
  };
  expect(requestDeliveryRework(office, actor, params, f.io)).toMatchObject({
    ok: false,
  });
});

test.each(["sha", "review", "audit", "closed", "cancelled", "foreign"])(
  "rejects %s evidence without partial effects",
  async (change) => {
    const { f, params } = await fixture(false);
    let state = f.state;
    let p = params;
    if (change === "sha") p = { ...p, target_sha: "b".repeat(40) };
    if (change === "review")
      state = {
        ...state,
        reviews: state.reviews.map((r) => ({ ...r, withdrawn: undefined })),
      } as unknown as CommandState;
    if (change === "audit")
      state = {
        ...state,
        events: state.events.filter((e) => e.type !== "review_withdrawn"),
      };
    if (change === "closed" || change === "cancelled")
      state = {
        ...state,
        cards: state.cards.map((c) => ({
          ...c,
          status:
            change === "closed" ? ("done" as const) : ("cancelled" as const),
        })),
      };
    if (change === "foreign") p = { ...p, work_item_id: id("work_item", 999) };
    const copy = JSON.parse(JSON.stringify(state));
    expect(requestDeliveryRework(state, human, p, f.io)).toMatchObject({
      ok: false,
    });
    expect(state).toEqual(copy);
  },
);

test.each([
  "requirements",
  "new_delivery",
  "new_review",
  "merged",
  "running_check",
])("human approval rechecks concurrent %s", async (change) => {
  const { f, params } = await fixture();
  const q = value(requestDeliveryRework(f.state, human, params, f.io));
  let state = apply(f.state, q);
  if (change === "requirements")
    state = {
      ...state,
      cards: state.cards.map((c) => ({
        ...c,
        acceptance_criteria: ["Changed again"],
      })),
    };
  if (change === "new_delivery")
    state = {
      ...state,
      deliveries: state.deliveries.map((v) =>
        v.id === params.delivery_id ? { ...v, status: "superseded" } : v,
      ),
    };
  if (change === "new_review")
    state = {
      ...state,
      reviews: [
        ...state.reviews,
        {
          ...(state.reviews.find((r) => r.id === params.review_id) ??
            missing()),
          id: id("review", 999),
        },
      ],
    };
  if (change === "merged")
    state = {
      ...state,
      events: [
        ...state.events,
        {
          ...(state.events[0] ?? missing()),
          card_id: f.card.id,
          type: "card_merged",
        },
      ],
    };
  if (change === "running_check") {
    const c =
      state.deliveries.find((v) => v.kind === "card_completion") ?? missing();
    state = {
      ...state,
      events: [
        ...state.events,
        {
          ...(state.events.at(-1) ?? missing()),
          seq: 9999,
          type: "merge_check_started",
          payload: {
            completion_id: c.id,
            attempt_id: "attempt",
            candidate_sha: "c".repeat(40),
            tree_sha: "d".repeat(40),
            status: "running",
            checks: [],
            summary: "Running",
          },
        },
      ],
    };
  }
  const copy = JSON.parse(JSON.stringify(state));
  expect(recordDecision(state, human, answer(q.data.id), f.io)).toMatchObject({
    ok: false,
  });
  expect(state).toEqual(copy);
});

test("keep closes only the request; a human return without completion is supported", async () => {
  const { f, params } = await fixture(false);
  const q = f.commit(requestDeliveryRework(f.state, human, params, f.io));
  f.commit(
    recordDecision(f.state, human, { ...answer(q.id), option: "keep" }, f.io),
  );
  expect(f.state.deliveries[0]?.status).toBe("accepted");
  const next = f.commit(requestDeliveryRework(f.state, human, params, f.io));
  f.commit(recordDecision(f.state, human, answer(next.id), f.io));
  const trigger =
    f.state.events.findLast((e) => e.type === "merge_changes_requested") ??
    missing();
  const replacement = await f.deliver(
    "code",
    "b".repeat(40),
    true,
    [],
    trigger,
  );
  expect(replacement.status).toBe("submitted");
  expect(replacement.reused_reviews).toBeUndefined();
  f.review(replacement);
  expect(
    f.state.work_items.find((w) => w.id === params.work_item_id)?.status,
  ).toBe("accepted");
});

test("redelivery supersedes a pending rework question without blocking the existing author path", async () => {
  const { f, params } = await fixture(false);
  const q = f.commit(requestDeliveryRework(f.state, human, params, f.io));
  await f.deliver("code", "b".repeat(40));
  expect(f.state.decisions.find((v) => v.id === q.id)?.status).toBe(
    "superseded",
  );
  expect(recordDecision(f.state, human, answer(q.id), f.io)).toMatchObject({
    ok: false,
  });
});

test.each(["ready", "blocked", "waiting_decision"] as const)(
  "returns only the target product and preserves %s pause evidence",
  async (status) => {
    const { f, params, product } = await fixture(false);
    const producer =
      f.state.work_items.find((w) => w.id === params.work_item_id) ?? missing();
    const verifier =
      f.state.work_items.find((w) => w.id === f.reviewer.work_item_id) ??
      missing();
    if (verifier.kind !== "verify") throw new Error("Missing verifier");
    const { assignment_id: _owner, ...unassigned } = verifier;
    const extra = {
      ...unassigned,
      id: id("work_item", 900),
      status,
      reported_blocker: {
        reason: "Keep the original pause reason",
        needs: "role" as const,
        reported_by: "human" as const,
        reported_at: f.io.clock.now(),
      },
    };
    const other = { ...producer, id: id("work_item", 901) };
    const otherDelivery = {
      ...product,
      id: id("delivery", 901),
      work_item_id: other.id,
      status: "accepted" as const,
    };
    const state = {
      ...f.state,
      work_items: [...f.state.work_items, extra, other],
      deliveries: [...f.state.deliveries, otherDelivery],
    };
    const request = value(requestDeliveryRework(state, human, params, f.io));
    const pending = apply(state, request);
    const after = apply(
      pending,
      value(recordDecision(pending, human, answer(request.data.id), f.io)),
    );
    expect(after.work_items.find((w) => w.id === extra.id)).toEqual({
      ...extra,
      status: status === "ready" ? "todo" : status,
    });
    expect(after.work_items.find((w) => w.id === other.id)).toEqual(other);
    expect(after.deliveries.find((d) => d.id === otherDelivery.id)).toEqual(
      otherDelivery,
    );
  },
);

test("an edit then revert cannot revive an old request; a replacement supersedes it", async () => {
  const { f, params } = await fixture(false);
  const q = f.commit(requestDeliveryRework(f.state, human, params, f.io));
  const source = f.state.events.at(-1);
  if (!source) throw new Error("Missing event");
  const changed = {
    ...f.state,
    events: [
      ...f.state.events,
      {
        ...source,
        id: f.io.ids.nextEventId(),
        seq: source.seq + 1,
        type: "card_updated",
      },
    ],
  };
  expect(recordDecision(changed, human, answer(q.id), f.io)).toMatchObject({
    ok: false,
  });
  const next = value(requestDeliveryRework(changed, human, params, f.io));
  expect(
    apply(changed, next).decisions.find((v) => v.id === q.id)?.status,
  ).toBe("superseded");
});

test("rework preserves an explicit human handoff through new completion and fresh reviews", async () => {
  const { f, params } = await fixture();
  const prior = f.state.decisions.find(
    (q) => q.trigger === "merge_confirmation",
  );
  if (!prior) throw new Error("Missing confirmation");
  f.commit({
    ok: true,
    value: {
      data: null,
      events: [],
      timeline: [],
      token_requests: [],
      changes: [
        {
          collection: "decisions",
          entity: {
            ...prior,
            human_required_reason: "Explicit handoff retained",
          },
        },
      ],
    },
  });
  const q = f.commit(requestDeliveryRework(f.state, human, params, f.io));
  f.commit(recordDecision(f.state, human, answer(q.id), f.io));
  const event = f.state.events.findLast(
    (e) => e.type === "merge_changes_requested",
  );
  if (!event) throw new Error("Missing return");
  const product = await f.deliver("code", "b".repeat(40), true, [], event);
  f.review(product);
  const completion = await f.deliver("card_completion", product.subject.value);
  f.review(completion);
  expect(
    f.state.decisions.findLast((v) => v.trigger === "merge_confirmation"),
  ).toMatchObject({
    human_required_reason: "Explicit handoff retained",
    amends: prior.id,
  });
});
