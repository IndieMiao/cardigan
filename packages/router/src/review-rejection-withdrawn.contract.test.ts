import { expect, test } from "vitest";
import { agent, delivery, event, snapshot, workItem } from "./fixtures.js";
import { routeEvent } from "./route.js";

// C-769: a voided late-evidence rejection wakes the verifier for the same
// delivery and tells the author that no resubmission is needed.
const voided = event(
  "review_withdrawn",
  {
    review_id: "V-1",
    work_item_id: "W-2",
    verdict: "reject",
    delivery_id: "D-1",
    rationale: "证据晚到",
    reviewer_needs_run: true,
  },
  { actor: agent("A-2") },
);
const state = (deliveryStatus = "submitted", producer = "delivered") =>
  snapshot({
    deliveries: [
      delivery("D-1", { status: deliveryStatus, requested_verifiers: ["W-2"] }),
    ],
    work_items: [
      workItem("W-1", { assignment_id: "A-1", status: producer }),
      workItem("W-2", {
        kind: "verify",
        role_id: "reviewer",
        assignment_id: "A-2",
        target_work_item_id: "W-1",
        status: "ready",
      }),
    ],
  });

test("voided rejection wakes the verifier and informs the author", () => {
  const { notifications } = routeEvent({ event: voided, snapshot: state() });
  expect(notifications).toMatchObject([
    {
      recipient: { kind: "assignment", assignment_id: "A-2" },
      kind: "delivery",
      rule: "C-769/review rejection withdrawn",
      work_item_id: "W-2",
    },
    {
      recipient: { kind: "assignment", assignment_id: "A-1" },
      kind: "review",
      rule: "C-769/review rejection withdrawn",
      summary: expect.stringContaining("无需重交"),
    },
  ]);
  expect(notifications.some((n) => n.run_kind === "rework")).toBe(false);
});

test("a reviewer voiding from a later running Run reviews there without a new wake", () => {
  const { notifications } = routeEvent({
    event: {
      ...voided,
      payload: { ...(voided.payload as object), reviewer_needs_run: false },
    },
    snapshot: state(),
  });
  expect(notifications.map((n) => n.recipient.assignment_id)).toEqual(["A-1"]);
});

test("withdrawn passes and stale replays route nothing", () => {
  expect(
    routeEvent({
      event: { ...voided, payload: { review_id: "V-1", work_item_id: "W-2" } },
      snapshot: state(),
    }).notifications,
  ).toEqual([]);
  for (const status of ["superseded", "rejected", "accepted"])
    expect(
      routeEvent({ event: voided, snapshot: state(status) }).notifications,
    ).toEqual([]);
});
