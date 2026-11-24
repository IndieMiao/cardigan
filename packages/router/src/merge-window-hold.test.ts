import { expect, test } from "vitest";
import { card, event, snapshot } from "./fixtures.js";
import { routeEvent } from "./route.js";

test("C-677: closing a window because of a hold notifies PM Ops; other window changes stay silent", () => {
  const state = snapshot({ cards: [card({ status: "awaiting_merge" })] });
  const closed = event("merge_window_changed", {
    open: false,
    reason: "卡片已暂停",
    closed_by_hold: true,
  });
  const notes = routeEvent({ event: closed, snapshot: state }).notifications;
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({
    recipient: { kind: "pm_ops" },
    rule: "6.4/merge window closed by hold",
  });
  for (const payload of [
    { open: false, reason: "窗口到期" },
    { open: true, reason: "重复合并冲突" },
  ])
    expect(
      routeEvent({
        event: event("merge_window_changed", payload),
        snapshot: state,
      }).notifications,
    ).toEqual([]);
});
