import { postComment, updateWorkItem } from "@cardigan/domain";
import { expect, test } from "vitest";
import { command } from "../../domain/src/commands/core.js";
import {
  flowReviewFixture,
  required,
} from "../../domain/src/commands/flow-review-limit/test-fixtures.js";
import { reconcileFlowReviewLimits } from "../../domain/src/commands/flow-review-limit.js";
import { seedLegacyReviewLimit } from "../../domain/src/commands/legacy-review-limit/test-fixtures.js";
import { assignment, human } from "../../domain/src/commands/test-fixtures.js";
import { routeEvent } from "./route.js";

test.each([false, true])(
  "B2 keeps author rework when a round is granted (reject=%s)",
  async (reject) => {
    const { f, review } = flowReviewFixture();
    review(await f.deliver(), reject);
    const event = required(
      f.state.events.findLast((e) => e.type === "review_submitted"),
    );
    expect(
      routeEvent({ event, snapshot: f.state }).notifications,
    ).toContainEqual(
      expect.objectContaining({
        recipient: { kind: "assignment", assignment_id: f.coder.id },
        kind: "review",
        ...(!reject ? { run_kind: "rework" } : {}),
      }),
    );
  },
);

test.each([
  { reviewed: false, existingBudget: false },
  { reviewed: true, existingBudget: false },
  { reviewed: false, existingBudget: true },
  { reviewed: true, existingBudget: true },
])(
  "upgrade resumes the current owner without routing the superseded question ($reviewed, $existingBudget)",
  async ({ reviewed, existingBudget }) => {
    const { f, review } = flowReviewFixture(1, 1);
    const first = await f.deliver();
    if (reviewed) review(first);
    else {
      review(first);
      await f.deliver("code", "b".repeat(40));
    }
    seedLegacyReviewLimit(f);
    const requested = required(
      f.state.events.findLast((e) => e.type === "decision_requested"),
    );
    if (existingBudget)
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
    f.commit(
      command(f.state, human, "upgrade_card_flow", f.io, (d) => {
        d.put("cards", { ...d.card(f.card.id), flow_version: 5 });
        reconcileFlowReviewLimits(d, f.card.id);
      }),
    );
    expect(
      routeEvent({ event: requested, snapshot: f.state }).notifications,
    ).toEqual([]);
    const raised = required(
      f.state.events.findLast(
        (e) =>
          e.type ===
          (existingBudget
            ? "review_limit_resumed_by_system"
            : "review_limit_raised_by_system"),
      ),
    );
    expect(
      routeEvent({ event: raised, snapshot: f.state }).notifications,
    ).toEqual([
      expect.objectContaining({
        recipient: {
          kind: "assignment",
          assignment_id: reviewed ? f.coder.id : f.reviewer.id,
        },
        run_kind: reviewed ? "rework" : "decision_resumed",
      }),
    ]);
  },
);

test.each([false, true])(
  "a delayed upgrade signal never requests rework after the current target passes (existingBudget=%s)",
  async (existingBudget) => {
    const { f, review } = flowReviewFixture(1, 1);
    review(await f.deliver());
    const target = await f.deliver("code", "b".repeat(40));
    seedLegacyReviewLimit(f);
    if (existingBudget)
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
    f.commit(
      command(f.state, human, "upgrade_card_flow", f.io, (d) => {
        d.put("cards", { ...d.card(f.card.id), flow_version: 5 });
        reconcileFlowReviewLimits(d, f.card.id);
      }),
    );
    const signal = required(
      f.state.events.findLast(
        (e) =>
          e.type ===
          (existingBudget
            ? "review_limit_resumed_by_system"
            : "review_limit_raised_by_system"),
      ),
    );
    f.review(target);
    expect(
      f.state.work_items.find((w) => w.id === f.reviewer.work_item_id)?.status,
    ).toBe("passed");
    expect(
      routeEvent({ event: signal, snapshot: f.state }).notifications,
    ).toEqual([]);
  },
);

test("C-610: the third consecutive rejection wakes only the author for alignment; a dispute routes one PM decision", async () => {
  const { f, review, dispute } = flowReviewFixture(null);
  const { work_item_id: _work, ...base } = assignment(900, "pm");
  f.commit({
    ok: true,
    value: {
      data: null,
      changes: [
        {
          collection: "assignments",
          entity: { ...base, scope: "standing", standing_mode: "ops" },
        },
      ],
      events: [],
      timeline: [],
      token_requests: [],
    },
  });
  for (let n = 0; n < 3; n++)
    review(await f.deliver("code", String(n + 1).repeat(40)));
  const event = required(
    f.state.events.findLast((e) => e.type === "review_submitted"),
  );
  expect(routeEvent({ event, snapshot: f.state }).notifications).toEqual([]);
  const opened = required(
    f.state.events.findLast((e) => e.type === "instruction_issued"),
  );
  expect(
    routeEvent({ event: opened, snapshot: f.state }).notifications,
  ).toEqual([
    expect.objectContaining({
      recipient: { kind: "assignment", assignment_id: f.coder.id },
      kind: "instruction",
    }),
  ]);
  expect(f.state.events.some((e) => e.type === "decision_requested")).toBe(
    false,
  );
  dispute();
  const wait = required(
    f.state.events.findLast((e) => e.type === "decision_requested"),
  );
  expect(routeEvent({ event: wait, snapshot: f.state }).notifications).toEqual([
    expect.objectContaining({ recipient: { kind: "pm_ops" } }),
  ]);
});

test.each([false, true])(
  "C-610: an agreed alignment wakes the verifier for a waiting delivery, otherwise the author (redelivered=%s)",
  async (redelivered) => {
    const { f, review } = flowReviewFixture(null);
    for (let n = 0; n < 3; n++)
      review(await f.deliver("code", String(n + 1).repeat(40)));
    const verifier = required(f.reviewer.work_item_id);
    f.start(f.coder);
    const proposal = required(
      f.commit(
        postComment(
          f.state,
          f.actor(f.coder),
          {
            card_id: f.card.id,
            body: "不变量",
            review_alignment: {
              work_item_id: verifier,
              step: "propose",
              invariants: ["保存成功后重新读取得到新值"],
            },
          },
          f.io,
        ),
      ),
    );
    if (redelivered) await f.deliver("code", "4".repeat(40));
    f.commit(
      postComment(
        f.state,
        f.actor(f.reviewer),
        {
          card_id: f.card.id,
          body: "同意",
          reply_to: proposal.id,
          review_alignment: { work_item_id: verifier, step: "confirm" },
        },
        f.io,
      ),
    );
    const agreed = required(
      f.state.events.findLast((e) => e.type === "review_alignment_agreed"),
    );
    expect(
      routeEvent({ event: agreed, snapshot: f.state }).notifications,
    ).toEqual([
      expect.objectContaining({
        recipient: {
          kind: "assignment",
          assignment_id: redelivered ? f.reviewer.id : f.coder.id,
        },
        run_kind: redelivered ? "decision_resumed" : "rework",
      }),
    ]);
  },
);

test("C-610: a merged card hands its review follow-ups to PM Ops as a card draft", async () => {
  const { f } = flowReviewFixture(null);
  const v = await f.deliver();
  f.review(v, [
    {
      severity: "minor",
      impact: "functional",
      must_fix: true,
      pre_existing: false,
      description: "建议补一条重试指标",
    },
  ]);
  const merged = {
    id: f.io.ids.nextEventId(),
    card_id: f.card.id,
    seq: (f.state.events.at(-1)?.seq ?? 0) + 1,
    type: "card_merged",
    actor: { kind: "system" as const, project_id: f.state.project_id },
    payload: {},
    created_at: "2026-11-23T00:00:00.000Z",
  };
  expect(
    routeEvent({ event: merged, snapshot: f.state }).notifications,
  ).toEqual([
    expect.objectContaining({
      recipient: { kind: "pm_ops" },
      kind: "card",
      summary: expect.stringContaining("get_card.follow_up_draft"),
    }),
  ]);
  const clean = flowReviewFixture(null).f;
  clean.review(await clean.deliver());
  expect(
    routeEvent({
      event: { ...merged, card_id: clean.card.id },
      snapshot: clean.state,
    }).notifications,
  ).toEqual([]);
});
