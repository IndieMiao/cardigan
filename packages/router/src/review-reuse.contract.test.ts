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
} from "../../domain/src/commands/test-fixtures.js";
import { routeEvent } from "./route.js";

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
});
