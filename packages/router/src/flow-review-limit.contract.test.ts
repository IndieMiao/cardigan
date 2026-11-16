import { updateWorkItem } from "@cardigan/domain";
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

test("B6: the fourth consecutive rejection routes one PM decision and suppresses author loops", async () => {
  const { f, review } = flowReviewFixture(null);
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
  for (let n = 0; n < 4; n++)
    review(await f.deliver("code", String(n + 1).repeat(40)));
  const event = required(
    f.state.events.findLast((e) => e.type === "review_submitted"),
  );
  expect(routeEvent({ event, snapshot: f.state }).notifications).toEqual([]);
  const wait = required(
    f.state.events.findLast((e) => e.type === "decision_requested"),
  );
  expect(routeEvent({ event: wait, snapshot: f.state }).notifications).toEqual([
    expect.objectContaining({ recipient: { kind: "pm_ops" } }),
  ]);
});
