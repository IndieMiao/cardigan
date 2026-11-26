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

/** C-777: a precheck slot wait reaches the PM inbox and settles when the precheck starts. */
function slotWait(after: readonly Event[]) {
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
    event("precheck_slot_waiting", system, {
      work_item_id: W1,
      assignment_id: A1,
      attempt_id: "check-1",
      reason: "cardigan/C-557 的合并检查等待执行名额",
      body: "W-1 的作者预检查 check-1 已排队 10 分钟未取得执行名额：cardigan/C-557 的合并检查等待执行名额。请 PM 核查。",
    }),
    ...after.map((e) => event(e.type, e.actor, e.payload)),
  ];
  return { ...s, events: [...s.events, ...events] };
}

test("C-777: a precheck slot wait stays in the PM inbox until its precheck starts or settles", () => {
  const open = resumeAttention(slotWait([])).get(W1);
  expect(open).toMatchObject({
    work_item_id: W1,
    assignment_id: A1,
    reason: "precheck_slot_waiting",
  });
  expect(open?.body).toContain("C-557");
  for (const type of ["precheck_started", "precheck_finished"])
    expect(
      resumeAttention(
        slotWait([
          {
            type,
            actor: system,
            payload: { work_item_id: W1, attempt_id: "check-1" },
          } as never,
        ]),
      ).has(W1),
    ).toBe(false);
  // Only the system raises it.
  const forged = slotWait([]);
  expect(
    resumeAttention({
      ...forged,
      events: forged.events.map((e) =>
        e.type === "precheck_slot_waiting" ? { ...e, actor: human } : e,
      ),
    }).has(W1),
  ).toBe(false);
});
