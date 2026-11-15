import { expect, test } from "vitest";
import {
  FLOW_VERSION_MAX,
  recordDecision,
  reviewLimitAttention,
  updateWorkItem,
  upgradeCardFlow,
  withdrawReview,
} from "../index.js";
import { command } from "./core.js";
import {
  flowReviewFixture,
  required,
} from "./flow-review-limit/test-fixtures.js";
import { applyFlowReviewLimit } from "./flow-review-limit.js";
import { independentReviewLimitFixture } from "./independent-review-limit/test-fixtures.js";
import { human, role, value } from "./test-fixtures.js";

test.each([false, true])(
  "B2 grants exactly one ordinary round after final non-pass (reject=%s)",
  async (reject) => {
    const { f, review, reconcile } = flowReviewFixture();
    const target = await f.deliver();
    review(target, reject);
    expect(f.state.decisions).toEqual([]);
    const event = f.state.events.find(
      (e) => e.type === "review_limit_raised_by_system",
    );
    expect(event).toMatchObject({
      actor: { kind: "system" },
      payload: {
        work_item_id: f.reviewer.work_item_id,
        delivery_id: target.id,
        previous_max_review_rounds: 1,
        max_review_rounds: 2,
        used_raises: 1,
        max_raises: 1,
      },
    });
    expect(
      f.state.events.findLast((e) => e.type === "review_submitted")?.payload,
    ).toMatchObject({ rework_allowed: true });
    const replay = value(reconcile());
    expect(replay.events).toEqual([]);
    const next = await f.deliver("code", "b".repeat(40));
    expect(
      f.state.events.filter((e) => e.type === "review_limit_raised_by_system"),
    ).toHaveLength(1);
    review(next, reject);
    expect(f.state.decisions).toEqual([]);
    expect(
      f.state.work_items.find((w) => w.id === f.reviewer.work_item_id),
    ).toMatchObject({ max_review_rounds: 2, status: "waiting_decision" });
    expect(
      f.state.events.findLast((e) => e.type === "review_submitted")?.payload,
    ).toMatchObject({ rework_allowed: false, review_limit_wait: true });
    expect(
      f.state.runs.filter((r) => r.assignment_id === f.reviewer.id).at(-1),
    ).toMatchObject({ status: "completed", outcome: "blocked" });
    expect(value(reconcile()).events).toEqual([]);
    expect(reviewLimitAttention(f.state, f.io.clock.now())).toEqual([
      expect.objectContaining({
        kind: "review_limit_auto_raise_exhausted",
        work_item_id: f.reviewer.work_item_id,
      }),
    ]);
  },
);

test.each([null, 0, undefined])(
  "B2 unset/zero cap blocks once without a Decision (max=%s)",
  async (max) => {
    const { f, review, reconcile } = flowReviewFixture(
      max === undefined ? null : max,
    );
    if (max === undefined)
      f.commit({
        ok: true,
        value: {
          data: null,
          changes: [
            {
              collection: "project_preferences",
              entity: {
                id: f.state.project_id,
                auto_merge_after_minutes: null,
              },
            },
          ],
          events: [],
          timeline: [],
          token_requests: [],
        },
      });
    const target = await f.deliver();
    review(target);
    expect(f.state.decisions).toEqual([]);
    expect(
      f.state.events.filter((e) => e.type === "review_limit_raised_by_system"),
    ).toEqual([]);
    const before = f.state.events.length;
    for (let i = 0; i < 3; i++) f.commit(reconcile());
    expect(f.state.events).toHaveLength(before);
    expect(
      f.state.events.filter(
        (e) => e.type === "review_limit_auto_raise_exhausted",
      ),
    ).toHaveLength(1);
  },
);

test.each([undefined, 1, 2, 3, 4])(
  "versions below 5 retain ordinary review-limit Decisions (%s)",
  async (version) => {
    const { f, review } = flowReviewFixture(2, version);
    const { flow_version: _version, ...legacy } = required(f.state.cards[0]);
    if (version === undefined)
      f.commit({
        ok: true,
        value: {
          data: null,
          changes: [{ collection: "cards", entity: legacy }],
          events: [],
          timeline: [],
          token_requests: [],
        },
      });
    review(await f.deliver());
    expect(f.state.decisions.at(-1)).toMatchObject({
      trigger: "review_limit",
      status: "open",
    });
    expect(
      f.state.events.some((e) => e.type === "review_limit_raised_by_system"),
    ).toBe(false);
  },
);

test.each(["reviewer", "tester", "designer", "pm"])(
  "all ordinary roles use the version gate (%s)",
  async (roleId) => {
    const { f } = flowReviewFixture();
    const target = await f.deliver();
    const owner = { ...f.reviewer, role_id: roleId };
    const state = {
      ...f.state,
      roles: [...f.state.roles, role(roleId)],
      assignments: f.state.assignments.map((a) =>
        a.id === owner.id ? owner : a,
      ),
      work_items: f.state.work_items.map((w) =>
        w.id === owner.work_item_id ? { ...w, role_id: roleId } : w,
      ),
    };
    // Direct internal settlement covers unreviewed targets with exhausted historic budgets.
    const result = command(
      {
        ...state,
        work_items: state.work_items.map((w) =>
          w.id === owner.work_item_id
            ? {
                ...w,
                status: "waiting_decision" as const,
                max_review_rounds: 0,
              }
            : w,
        ),
      },
      human,
      "upgrade_card_flow",
      f.io,
      (d) =>
        applyFlowReviewLimit(
          d,
          d.get("work_items", required(owner.work_item_id)),
        ),
    );
    expect(value(result).events).toContainEqual(
      expect.objectContaining({
        type: "review_limit_raised_by_system",
        payload: expect.objectContaining({ delivery_id: target.id }),
      }),
    );
  },
);

test.each([1, 5])(
  "independent review keeps its original human boundary at version %s",
  async (version) => {
    const { f, review, decision } = independentReviewLimitFixture({
      system_review_limit_max_raises: 10,
    });
    f.commit({
      ok: true,
      value: {
        data: null,
        changes: [
          {
            collection: "cards",
            entity: { ...required(f.state.cards[0]), flow_version: version },
          },
        ],
        events: [],
        timeline: [],
        token_requests: [],
      },
    });
    review(await f.deliver(), true);
    expect(decision()).toMatchObject({
      trigger: "review_limit",
      decider: "human",
      status: "open",
    });
    expect(
      f.state.events.some((e) => e.type === "review_limit_raised_by_system"),
    ).toBe(false);
  },
);

test.each(["open", "provisional"] as const)(
  "upgrade supersedes %s ordinary questions and resumes atomically",
  async (status) => {
    const { f, review, reconcile } = flowReviewFixture(2, 1);
    review(await f.deliver());
    const q = required(f.state.decisions.at(-1));
    f.commit({
      ok: true,
      value: {
        data: null,
        changes: [
          {
            collection: "cards",
            entity: { ...required(f.state.cards[0]), flow_version: 5 },
          },
          { collection: "decisions", entity: { ...q, status } },
        ],
        events: [],
        timeline: [],
        token_requests: [],
      },
    });
    f.commit(reconcile());
    expect(f.state.decisions.at(-1)).toMatchObject({
      id: q.id,
      status: "superseded",
    });
    expect(
      f.state.work_items.find((w) => w.id === f.reviewer.work_item_id),
    ).toMatchObject({ status: "ready", max_review_rounds: 2 });
    expect(
      recordDecision(
        f.state,
        human,
        {
          decision_id: q.id,
          option: "raise_limit",
          rationale: "Continue",
          raw_quote: "Continue",
        },
        f.io,
      ).ok,
    ).toBe(false);
    expect(value(reconcile()).events).toEqual([]);
  },
);

test("sufficient review budget does not emit a resume signal through another blocker", async () => {
  const { f } = flowReviewFixture(null, 1);
  f.review(await f.deliver());
  await f.deliver("code", "b".repeat(40));
  f.commit(
    updateWorkItem(
      f.state,
      human,
      {
        work_item_id: required(f.reviewer.work_item_id),
        max_review_rounds: 2,
      },
      f.io,
    ),
  );
  const result = value(
    command(f.state, human, "upgrade_card_flow", f.io, (d) => {
      d.put("cards", { ...d.card(f.card.id), flow_version: 5 });
      const item = d.work(required(f.reviewer.work_item_id));
      d.put("work_items", {
        ...item,
        reported_blocker: {
          reason: "Wait for required evidence",
          needs: "human",
          reported_by: "human",
          reported_at: d.now,
        },
      });
      applyFlowReviewLimit(d, item);
    }),
  );
  f.commit({ ok: true, value: result });
  expect(
    f.state.work_items.find((w) => w.id === f.reviewer.work_item_id)?.status,
  ).toBe("waiting_decision");
  expect(
    result.events.some((e) => e.type === "review_limit_resumed_by_system"),
  ).toBe(false);
});

test.each(["open", "provisional"] as const)(
  "upgrade emits a replayable resume signal with sufficient existing budget (%s)",
  async (status) => {
    const { f, reconcile } = flowReviewFixture(null, 1);
    f.review(await f.deliver());
    const target = await f.deliver("code", "b".repeat(40));
    const question = required(f.state.decisions.at(-1));
    if (status === "provisional")
      f.commit(
        recordDecision(
          f.state,
          human,
          {
            decision_id: question.id,
            option: "pause",
            rationale: "Wait",
            raw_quote: "Wait",
          },
          f.io,
        ),
      );
    f.commit(
      updateWorkItem(
        f.state,
        human,
        {
          work_item_id: required(f.reviewer.work_item_id),
          max_review_rounds: 2,
        },
        f.io,
      ),
    );
    expect(
      f.state.work_items.find((w) => w.id === f.reviewer.work_item_id),
    ).toMatchObject({ status: "waiting_decision", max_review_rounds: 2 });
    const effect = value(
      command(f.state, human, "upgrade_card_flow", f.io, (d) => {
        d.put("cards", { ...d.card(f.card.id), flow_version: 5 });
        applyFlowReviewLimit(d, d.work(required(f.reviewer.work_item_id)));
      }),
    );
    expect(effect.events).toContainEqual(
      expect.objectContaining({
        type: "review_limit_resumed_by_system",
        actor: { kind: "system", project_id: f.state.project_id },
        payload: expect.objectContaining({
          work_item_id: f.reviewer.work_item_id,
          delivery_id: target.id,
          max_review_rounds: 2,
          source: "upgrade_card_flow",
          resume_work_items: [f.reviewer.work_item_id],
        }),
      }),
    );
    f.commit({ ok: true, value: effect });
    expect(f.state.decisions.find((q) => q.id === question.id)?.status).toBe(
      "superseded",
    );
    expect(
      f.state.work_items.find((w) => w.id === f.reviewer.work_item_id),
    ).toMatchObject({ status: "ready", max_review_rounds: 2 });
    expect(
      f.state.events.some((e) => e.type === "review_limit_raised_by_system"),
    ).toBe(false);
    expect(value(reconcile()).events).toEqual([]);
  },
);

test("C-239 lifetime consumption survives upgrade and cannot be double spent", async () => {
  const { f, review } = flowReviewFixture();
  f.commit(
    command(
      f.state,
      { kind: "system", project_id: f.state.project_id },
      "system_review_limit",
      f.io,
      (d) => {
        d.emit("system_review_limit_raised", f.card.id, {
          work_item_id: required(f.reviewer.work_item_id),
        });
      },
    ),
  );
  review(await f.deliver());
  expect(f.state.decisions).toEqual([]);
  expect(
    f.state.events.filter((e) => e.type === "review_limit_raised_by_system"),
  ).toEqual([]);
  expect(f.state.events.at(-1)?.payload).toMatchObject({
    review_limit_wait: true,
  });
});

test("version 5 remains unavailable through the public command", () => {
  const { f } = flowReviewFixture();
  expect(FLOW_VERSION_MAX).toBe(1);
  expect(
    upgradeCardFlow(f.state, human, { card_id: f.card.id, to: 5 }, f.io),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
});

test("a new target after exhaustion remains blocked, then resumes only with available budget", async () => {
  const { f, review } = flowReviewFixture(null);
  review(await f.deliver());
  await f.deliver("code", "b".repeat(40));
  expect(
    f.state.work_items.find((w) => w.id === f.reviewer.work_item_id),
  ).toMatchObject({ status: "waiting_decision", max_review_rounds: 1 });
  expect(
    f.state.events.filter(
      (e) => e.type === "review_limit_auto_raise_exhausted",
    ),
  ).toHaveLength(2);
  // Synthetic human-owned preference update: the next settlement reads it fresh.
  f.commit({
    ok: true,
    value: {
      data: null,
      changes: [
        {
          collection: "project_preferences",
          entity: {
            id: f.state.project_id,
            auto_merge_after_minutes: null,
            system_review_limit_max_raises: 1,
          },
        },
      ],
      events: [],
      timeline: [],
      token_requests: [],
    },
  });
  await f.deliver("code", "c".repeat(40));
  expect(
    f.state.work_items.find((w) => w.id === f.reviewer.work_item_id),
  ).toMatchObject({ status: "ready", max_review_rounds: 2 });
  expect(reviewLimitAttention(f.state, f.io.clock.now())).toEqual([]);
  expect(
    f.state.events.filter((e) => e.type === "review_limit_raised_by_system"),
  ).toHaveLength(1);
});

test("an unreviewed new target at the old limit gets a round and can start normally", async () => {
  const { f } = flowReviewFixture(2);
  f.review(await f.deliver());
  expect(
    f.state.events.some((e) => e.type === "review_limit_raised_by_system"),
  ).toBe(false);
  const next = await f.deliver("code", "b".repeat(40));
  expect(
    f.state.work_items.find((w) => w.id === f.reviewer.work_item_id),
  ).toMatchObject({ status: "ready", max_review_rounds: 2 });
  f.review(next);
  expect(f.state.decisions).toEqual([]);
});

test("withdrawal invalidates reuse and a fresh target still spends an ordinary round", async () => {
  const { f } = flowReviewFixture();
  f.review(await f.deliver());
  f.commit(
    withdrawReview(
      f.state,
      f.actor(f.reviewer),
      {
        work_item_id: required(f.reviewer.work_item_id),
        rationale: "Recheck the boundary",
      },
      f.io,
    ),
  );
  const next = await f.deliver("code", "b".repeat(40));
  expect(next.reused_reviews).toBeUndefined();
  expect(
    f.state.events.filter((e) => e.type === "review_limit_raised_by_system"),
  ).toHaveLength(1);
  expect(
    f.state.work_items.find((w) => w.id === f.reviewer.work_item_id),
  ).toMatchObject({ max_review_rounds: 2, status: "ready" });
});
