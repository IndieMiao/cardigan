import { expect, test } from "vitest";
import { testReviewFixture } from "../../domain/src/commands/test-review/test-fixtures.js";
import { routeEvent } from "./route.js";

test("a free test delivery routes the original independent verifier and rejection routes ordinary must_fix rework", async () => {
  const f = await testReviewFixture(3);
  const next = await f.deliver();
  const event = next.events.find((e) => e.type === "delivery_submitted");
  if (!event) throw new Error("Missing delivery event");
  const notifications = routeEvent({ event, snapshot: f.state }).notifications;
  expect(notifications).toContainEqual(
    expect.objectContaining({
      recipient: { kind: "assignment", assignment_id: "A-2" },
      kind: "delivery",
    }),
  );
  expect(f.state.decisions).toHaveLength(0);
  f.start();
  const rejected = f.commit(
    f.review([
      {
        description: "Weakened fixture",
        severity: "major",
        must_fix: true,
        pre_existing: false,
      },
    ]),
  );
  const result = rejected.events.find((e) => e.type === "review_submitted");
  if (!result) throw new Error("Missing review event");
  expect(
    routeEvent({ event: result, snapshot: f.state }).notifications,
  ).toContainEqual(
    expect.objectContaining({
      recipient: { kind: "assignment", assignment_id: "A-1" },
      rule: "6.4/review rejected",
    }),
  );
});
