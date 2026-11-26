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

test("C-803: a hold released past the limit notifies PM Ops; recording a hold stays silent", () => {
  const state = snapshot({ cards: [card({ status: "awaiting_merge" })] });
  const payload = {
    window_card_id: "C-9",
    window_opened_at: "2026-01-01T00:00:00.000Z",
    versions: ["D-1"],
    held_since: "2026-01-01T00:00:00.000Z",
    waited_ms: 7_200_000,
    limit_ms: 7_200_000,
  };
  const system = { kind: "system", project_id: "p" } as const;
  const released = event("merge_queue_hold_released", payload, {
    actor: system as never,
  });
  const notes = routeEvent({ event: released, snapshot: state }).notifications;
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({
    recipient: { kind: "pm_ops" },
    rule: "6.4/merge window hold released",
  });
  expect(JSON.stringify(notes[0])).toContain("set_merge_window 关闭 C-9");
  for (const silent of [
    event(
      "merge_queue_held",
      { window_card_id: "C-9" },
      { actor: system as never },
    ),
    // Only the system records a release.
    event("merge_queue_hold_released", payload),
  ])
    expect(
      routeEvent({ event: silent, snapshot: state }).notifications,
    ).toEqual([]);
});
