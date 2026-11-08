import { expect, test } from "vitest";
import type { SnapshotData } from "../../../web/src/api.js";
import { m5Cross, TEST_PASSWORD } from "../../test-support/m5-cross.js";

test("U4b recent deliveries identify the work item and submission event time without advancing cursors", async () => {
  const f = await m5Cross();
  try {
    await f.password(TEST_PASSWORD);
    await f.login();
    const delivery = await f.deliver(
      f.primary,
      await f.change(f.primary.owner, "snapshot.txt", "delivered"),
    );
    await f.agentComment("A later update must not become the delivery time");
    const before = f.state().cursors;
    const response = await f.call(f.projectPath("/snapshot"));
    expect(response.status).toBe(200);
    const view = response.json as SnapshotData;
    const event = f
      .state()
      .events.find(
        (e) =>
          e.type === "delivery_submitted" &&
          e.payload &&
          typeof e.payload === "object" &&
          "delivery_id" in e.payload &&
          e.payload.delivery_id === delivery.id,
      );
    expect(event).toBeDefined();
    expect(
      view.recent_deliveries.find((d) => d.id === delivery.id),
    ).toMatchObject({
      card_id: f.card.id,
      work_item_id: delivery.work_item_id,
      work_item_title: f
        .state()
        .work_items.find((w) => w.id === delivery.work_item_id)?.title,
      submitted_at: event?.created_at,
    });
    expect(f.state().cursors).toEqual(before);
  } finally {
    await f.close();
  }
}, 30_000);
