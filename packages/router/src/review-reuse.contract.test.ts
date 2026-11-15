import {
  prepareDelivery,
  submitDelivery,
  submitReview,
  updateCard,
} from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  ports,
  subject,
  value,
} from "../../domain/src/commands/test-fixtures.js";
import { automaticReuseInvalidation } from "../test-support/review-reuse.js";
import { routeEvent } from "./route.js";

test("producer-triggered automatic PM assignment routes its derived recovery back to the producer", async () => {
  const { state, event, completion, producer } =
    await automaticReuseInvalidation();
  expect(event.actor).toMatchObject({
    kind: "assignment",
    assignment_id: producer.id,
  });
  expect(completion.data.status).toBe("superseded");
  const notifications = completion.events.flatMap(
    (event) => routeEvent({ event, snapshot: state }).notifications,
  );
  expect(
    notifications.filter((n) => n.recipient.assignment_id === producer.id),
  ).toMatchObject([
    {
      event_id: event.id,
      work_item_id: id("work_item", 1),
      run_kind: "rework",
    },
  ]);
});

test("reused verification creates no notification or review Run, including replay", async () => {
  const io = ports();
  let state = fixture();
  const params = {
    work_item_id: id("work_item", 1),
    kind: "code" as const,
    summary: "Ready",
    subject,
    requested_verifiers: [id("work_item", 2)],
  };
  const deliver = async () => {
    const proof = value(
      await prepareDelivery(state, actor(), params, {
        verify: async () => ({
          ok: true,
          value: [
            {
              kind: "commit",
              details: { sha: subject.value, tree_sha: "c".repeat(40) },
            },
          ],
        }),
      }),
    );
    const effect = value(submitDelivery(state, actor(), params, proof, io));
    state = apply(state, effect);
    return effect;
  };
  const first = await deliver();
  state = apply(
    state,
    value(
      submitReview(
        state,
        actor(2, "reviewer"),
        {
          delivery_id: first.data.id,
          target_sha: subject.value,
          kind: "code",
          issues: [],
        },
        io,
      ),
    ),
  );
  const next = await deliver();
  const event = next.events.find((e) => e.type === "delivery_submitted");
  if (!event) throw new Error("Missing delivery event");
  const oldEvent = first.events.find((e) => e.type === "delivery_submitted");
  if (!oldEvent) throw new Error("Missing original event");
  expect(
    routeEvent({ event: oldEvent, snapshot: state }).notifications,
  ).toEqual([]);
  for (let n = 0; n < 2; n++) {
    const routed = routeEvent({ event, snapshot: state });
    expect(routed.notifications).toEqual([]);
    expect(routed.checks).toEqual([]);
  }
  const invalidation = value(
    updateCard(
      state,
      human,
      {
        card_id: id("card", 1),
        acceptance_criteria: ["Changed requirement"],
      },
      io,
    ),
  );
  state = apply(state, invalidation);
  const invalidated = invalidation.events.find(
    (e) => e.type === "review_reuse_invalidated",
  );
  if (!invalidated) throw new Error("Missing invalidation event");
  expect(
    routeEvent({ event: invalidated, snapshot: state }).notifications,
  ).toMatchObject([
    {
      recipient: { kind: "assignment", assignment_id: id("assignment", 1) },
      work_item_id: id("work_item", 1),
      run_kind: "rework",
    },
  ]);
  expect(
    routeEvent({
      event: invalidated,
      snapshot: {
        ...state,
        assignments: state.assignments.filter(
          (a) => a.id !== id("assignment", 1),
        ),
      },
    }).notifications[0]?.recipient.kind,
  ).toBe("pm_ops");
  expect(routeEvent({ event, snapshot: state }).notifications).toEqual([]);
  await deliver();
  expect(
    routeEvent({ event: invalidated, snapshot: state }).notifications,
  ).toEqual([]);
});
