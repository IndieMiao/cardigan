/** C-620: the PM's deferred-resume row treats a released managed stop like any other idle owner. */
import { expect, test } from "vitest";
import type { Actor, Event, JsonValue } from "../entities.js";
import { resumeAttention } from "./resume-attention.js";
import { fixture, human, id } from "./test-fixtures.js";

const system: Actor = { kind: "system", project_id: human.project_id };
const A1 = id("assignment", 1);
const W1 = id("work_item", 1);

function state(stops: readonly Event[]) {
  const s = fixture();
  let seq = 0;
  const event = (type: string, actor: Actor, payload: JsonValue): Event => ({
    id: String(++seq).padStart(26, "0") as never,
    seq,
    card_id: id("card", 1),
    type,
    actor,
    payload,
    created_at: "2026-01-01T00:00:00.000Z",
  });
  const events = [
    event("work_item_resume_deferred", system, {
      work_item_id: W1,
      assignment_id: A1,
      reason: "指派已被人工停止",
      body: "W-1 waits",
    }),
    ...stops.map((e) => event(e.type, e.actor, e.payload)),
    event("run_queued", system, { assignment_id: A1, run_id: "R-9" }),
  ];
  return { ...s, events: [...s.events, ...events] };
}
const stopEvent = (
  type: string,
  payload: Record<string, JsonValue> = {},
): Event =>
  ({ type, actor: human, payload: { assignment_id: A1, ...payload } }) as never;

test("C-620 a queue after a released managed stop settles the deferred resume; a pause keeps it open", () => {
  expect(
    resumeAttention(
      state([
        stopEvent("assignment_stopped", { hold: false }),
        stopEvent("assignment_stop_released"),
      ]),
    ).has(W1),
  ).toBe(false);
  for (const stops of [
    // Release not yet confirmed.
    [stopEvent("assignment_stopped", { hold: false })],
    // Explicit pause, and a legacy stop without `hold`.
    [
      stopEvent("assignment_stopped", { hold: true }),
      stopEvent("assignment_stop_released"),
    ],
    [stopEvent("assignment_stopped"), stopEvent("assignment_stop_released")],
  ])
    expect(resumeAttention(state(stops)).has(W1)).toBe(true);
});
