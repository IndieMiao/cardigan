import {
  type Actor,
  createCard,
  type Event,
  resumeWorkWaits,
  submitReview,
} from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  flowReviewFixture,
  required,
} from "../../domain/src/commands/flow-review-limit/test-fixtures.js";
import { human } from "../../domain/src/commands/test-fixtures.js";
import { routeEvent } from "./route.js";

const system: Actor = { kind: "system", project_id: human.project_id };

async function pendingReview(mustFix: boolean) {
  const { f } = flowReviewFixture(undefined, 5);
  const platform = required(
    f.commit(
      createCard(
        f.state,
        human,
        {
          title: "Platform entry",
          goal: "Fix the managed entry",
          acceptance_criteria: ["Entry works"],
          source: { kind: "quote", text: "Platform" },
          repo: "fixture",
          base_branch: "main",
        },
        f.io,
      ),
    ),
  );
  const delivery = await f.deliver();
  f.start(f.reviewer);
  const review = required(
    f.commit(
      submitReview(
        f.state,
        f.actor(f.reviewer),
        {
          delivery_id: delivery.id,
          target_sha: delivery.subject.value,
          kind: "code",
          issues: mustFix
            ? [
                {
                  severity: "major",
                  impact: "functional",
                  basis: "AC1",
                  must_fix: true,
                  pre_existing: false,
                  description: "Saved value is lost",
                },
              ]
            : [],
          evidence_pending: {
            items: [{ description: "Simulator run", basis: "AC1" }],
            blocker: { kind: "card_merged", target_id: platform.id },
          },
        },
        f.io,
      ),
    ),
  );
  const event = required(
    f.state.events.findLast((e) => e.type === "review_submitted"),
  );
  return { f, platform, review, event };
}

test("C-618: a pure evidence wait wakes nobody and is not routed as a pass", async () => {
  const { f, event } = await pendingReview(false);
  const result = routeEvent({ event, snapshot: f.state });
  expect(result.notifications).toEqual([]);
  expect(result.checks).toEqual([]);
});

test("C-618: a code must-fix next to pending evidence still asks for rework", async () => {
  const { f, event } = await pendingReview(true);
  expect(routeEvent({ event, snapshot: f.state }).notifications).toEqual([
    expect.objectContaining({
      recipient: { kind: "assignment", assignment_id: f.coder.id },
      rule: "6.4/review rejected",
    }),
  ]);
});

test("C-618: the platform resolution notice wakes the original author", async () => {
  const { f, platform } = await pendingReview(false);
  const card = required(f.state.cards.find((c) => c.id === platform.id));
  const merged: Event = {
    id: f.io.ids.nextEventId(),
    seq: f.io.ids.nextEventSequence(f.state.project_id, platform.id),
    type: "card_merged",
    payload: { merge_sha: "f".repeat(40) },
    actor: system,
    card_id: platform.id,
    created_at: f.io.clock.now(),
  };
  f.commit({
    ok: true,
    value: {
      data: null,
      changes: [{ collection: "cards", entity: { ...card, status: "done" } }],
      events: [merged],
      timeline: [],
      token_requests: [],
    },
  });
  f.commit(resumeWorkWaits(f.state, system, {}, f.io));
  const instruction = required(
    f.state.events.findLast((e) => e.type === "instruction_issued"),
  );
  expect(
    routeEvent({ event: instruction, snapshot: f.state }).notifications,
  ).toEqual([
    expect.objectContaining({
      recipient: { kind: "assignment", assignment_id: f.coder.id },
      kind: "instruction",
      work_item_id: f.coder.work_item_id,
    }),
  ]);
});
