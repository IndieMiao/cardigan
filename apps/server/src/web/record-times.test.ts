import {
  prepareDelivery,
  submitDelivery,
  submitReview,
} from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  actor,
  apply,
  fixture,
  id,
  ports,
  subject,
  value,
} from "../../../../packages/domain/src/commands/test-fixtures.js";
import { cardDetail } from "./read.js";

test("card detail reports when each delivery and review was submitted (C-136)", async () => {
  let state = fixture();
  const p = ports();
  const params = {
    work_item_id: id("work_item", 1),
    kind: "code" as const,
    summary: "Ready",
    subject,
    requested_verifiers: [id("work_item", 2)],
  };
  const receipt = value(
    await prepareDelivery(state, actor(), params, {
      verify: async () => ({ ok: true, value: [] }),
    }),
  );
  const delivered = value(submitDelivery(state, actor(), params, receipt, p));
  state = apply(state, delivered);
  const reviewed = value(
    submitReview(
      state,
      actor(2, "reviewer"),
      {
        delivery_id: delivered.data.id,
        target_sha: subject.value,
        kind: "code",
        issues: [],
      },
      p,
    ),
  );
  state = apply(state, reviewed);
  const at = (type: string) =>
    state.events.find((event) => event.type === type)?.created_at;
  expect(at("delivery_submitted")).toBeTruthy();
  const detail = cardDetail(state, id("card", 1));
  expect(detail?.deliveries[0]?.submitted_at).toBe(at("delivery_submitted"));
  expect(detail?.reviews[0]?.submitted_at).toBe(at("review_submitted"));

  // Records without their creating event (imported or legacy) simply omit it.
  const legacy = cardDetail(
    { ...state, events: state.events.filter((e) => e.card_id !== "C-1") },
    id("card", 1),
  );
  expect(legacy?.deliveries[0]).not.toHaveProperty("submitted_at");
});
