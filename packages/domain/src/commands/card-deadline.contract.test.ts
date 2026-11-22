import { expect, test } from "vitest";
import { updateCard } from "./pm.js";
import {
  actor,
  apply,
  card,
  fixture,
  human,
  ports,
  value,
} from "./test-fixtures.js";

const card_id = card().id;

test("deadline patches preserve lifecycle and only announce actual date changes", () => {
  const io = ports();
  const state = fixture();
  const date = "2026-11-28";
  const set = value(
    updateCard(state, actor(4, "pm"), { card_id, deadline: date }, io),
  );
  expect(set.data).toEqual({ ...card(), deadline: date });
  const retained = value(
    updateCard(apply(state, set), human, { card_id, goal: "Updated goal" }, io),
  );
  expect(retained.data.deadline).toBe(date);
  const beforeClear = apply(apply(state, set), retained);
  const clear = value(
    updateCard(beforeClear, human, { card_id, deadline: null }, io),
  );
  expect(clear.data).toEqual({ ...card(), goal: "Updated goal" });
  expect(clear.data).not.toHaveProperty("deadline");
  expect(clear.events).toContainEqual(
    expect.objectContaining({
      type: "card_updated",
      payload: expect.objectContaining({
        deadline: null,
        previous_deadline: date,
      }),
    }),
  );
  expect(clear.timeline.map((entry) => entry.body)).toEqual([
    expect.stringContaining("截止日期已清除"),
  ]);
  const after = apply(beforeClear, clear);
  expect(after.work_items).toEqual(state.work_items);
  const again = value(
    updateCard(after, human, { card_id, deadline: null }, io),
  );
  expect(
    again.timeline.some((entry) => entry.body.includes("截止日期已清除")),
  ).toBe(false);
});

test("clearing a deadline cannot bypass PM permissions or be mixed with a pre-merge check", () => {
  const io = ports();
  const state = fixture();
  const patch = { card_id, deadline: null };
  expect(updateCard(state, actor(), patch, io)).toMatchObject({
    ok: false,
    error: { code: "forbidden_tool" },
  });
  expect(
    updateCard(
      state,
      human,
      { ...patch, pre_merge_check: { label: "核对", status: "pending" } },
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
});
