import { expect, test } from "vitest";
import { command } from "../../domain/src/commands/core.js";
import {
  flowReviewFixture,
  required,
} from "../../domain/src/commands/flow-review-limit/test-fixtures.js";
import { reconcileFlowReviewLimits } from "../../domain/src/commands/flow-review-limit.js";
import { human } from "../../domain/src/commands/test-fixtures.js";
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

test.each([false, true])(
  "upgrade resumes the current author or verifier without routing the superseded question (reviewed=%s)",
  async (reviewed) => {
    const { f, review } = flowReviewFixture(1, 1);
    const first = await f.deliver();
    if (reviewed) review(first);
    else {
      f.review(first);
      await f.deliver("code", "b".repeat(40));
    }
    const requested = required(
      f.state.events.findLast((e) => e.type === "decision_requested"),
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
        (e) => e.type === "review_limit_raised_by_system",
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
  "B2 exhausted limit notifies Ops once per source event without author/verifier loops (reject=%s)",
  async (reject) => {
    const { f, review } = flowReviewFixture(null);
    review(await f.deliver(), reject);
    const event = required(
      f.state.events.findLast((e) => e.type === "review_submitted"),
    );
    expect(routeEvent({ event, snapshot: f.state }).notifications).toEqual([]);
    const wait = required(
      f.state.events.findLast(
        (e) => e.type === "review_limit_auto_raise_exhausted",
      ),
    );
    expect(
      routeEvent({ event: wait, snapshot: f.state }).notifications,
    ).toEqual([
      expect.objectContaining({
        recipient: { kind: "pm_ops" },
        kind: "escalation",
        event_id: wait.id,
      }),
    ]);
    expect(f.state.decisions).toEqual([]);
  },
);
