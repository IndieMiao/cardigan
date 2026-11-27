/**
 * C-812 contract: bells the dispatcher escalated (`needs_attention`, never rung
 * again) while a session was busy reach a fresh session once a managed stop of
 * that session is released. A pause (`--hold`) still waits for the human.
 */
import { expect, test } from "vitest";
import type { Assignment, Event, RuntimeRef, WorkItem } from "../entities.js";
import type { CommandState } from "./core.js";
import { stopWorkItemAssignment } from "./stop.js";
import { apply, fixture, human, id, ports, run } from "./test-fixtures.js";

const A1 = id("assignment", 1);
const C1 = id("card", 1);
const ref: RuntimeRef = {
  machine_id: "local" as never,
  runtime_machine: "local",
  terminal_ref: "t1",
  agent_name: "a1",
};
const system = { kind: "system" as const, project_id: human.project_id };
let n = 9000;
const event = (
  type: string,
  payload: Record<string, unknown>,
  extra: Partial<Event> = {},
): Event => ({
  id: String(++n).padStart(26, "0") as never,
  card_id: C1,
  seq: 50,
  type,
  actor: system,
  payload: { assignment_id: A1, ...payload } as never,
  created_at: "2026-01-01T00:00:00.000Z",
  ...extra,
});
/** The dispatcher's `continuing_turn` handoff of an undelivered bell. */
const escalated = (extra: Partial<Event> = {}) =>
  event(
    "bell_wake_escalated",
    {
      reason: "continuing_turn",
      run_id: id("run", 1),
      notification_ids: ["ntf_precheck"],
    },
    extra,
  );

/** A1's session is busy in R-1; its precheck bell was escalated. */
function busy(
  events: Event[] = [escalated()],
  item: Partial<WorkItem> = {},
): CommandState {
  const s = fixture();
  return {
    ...s,
    work_items: s.work_items.map((w) =>
      w.id === id("work_item", 1) ? ({ ...w, ...item } as WorkItem) : w,
    ),
    assignments: s.assignments.map((a) =>
      a.id === A1
        ? ({ ...a, runtime_state: "running", runtime_ref: ref } as Assignment)
        : a,
    ),
    events,
  };
}
const stop = (
  s: CommandState,
  extra: { released_runtime_ref?: RuntimeRef; hold?: boolean },
) =>
  stopWorkItemAssignment(
    s,
    human,
    { assignment_id: A1, reason: "stopped by host", ...extra },
    ports(),
  );
function release(s: CommandState, hold = false) {
  const first = stop(s, { hold });
  if (!first.ok) throw new Error(first.error.message);
  const stopping = apply(s, first.value);
  const settled = stop(stopping, { released_runtime_ref: ref });
  if (!settled.ok) throw new Error(settled.error.message);
  return apply(stopping, settled.value);
}
const wakes = (s: CommandState) =>
  s.events.filter(
    (e) =>
      e.type === "work_item_resume_requested" &&
      (e.payload as { stop_redelivery?: unknown }).stop_redelivery === true,
  );

test("C-812 a managed stop's release requests one fresh session for escalated bells", () => {
  const s = busy();
  const next = release(s);
  expect(next.runs.find((r) => r.id === id("run", 1))?.status).toBe(
    "cancelled",
  );
  expect(next.assignments.find((a) => a.id === A1)?.runtime_ref).toBeNull();
  const [wake, ...rest] = wakes(next);
  expect(rest).toEqual([]);
  expect(wake).toMatchObject({
    card_id: C1,
    actor: system,
    payload: {
      work_item_id: id("work_item", 1),
      assignment_id: A1,
      role_version: 1,
      stop_redelivery: true,
      escalation_event_ids: [s.events[0]?.id],
      notification_ids: ["ntf_precheck"],
      previous_run_id: id("run", 1),
    },
  });
  // It follows the release, in the same transaction.
  expect(next.events.indexOf(wake as Event)).toBe(
    next.events.findIndex((e) => e.type === "assignment_stop_released") + 1,
  );
  expect(next.timeline.at(-1)).toMatchObject({
    type: "system",
    author: "system",
    work_item_id: id("work_item", 1),
  });
  // A retried settlement changes nothing and asks no second time.
  const again = stop(next, { released_runtime_ref: ref });
  expect(again.ok && again.value.changes).toEqual([]);
  expect(again.ok && again.value.events).toEqual([]);
});

test("C-812 a pause (--hold) leaves escalated bells for the human's start", () => {
  const next = release(busy(), true);
  expect(next.events.at(-1)?.type).toBe("assignment_stop_released");
  expect(wakes(next)).toEqual([]);
});

test("C-812 several escalations since the last dispatch make one request", () => {
  const next = release(
    busy([
      escalated({
        payload: { assignment_id: A1, notification_ids: ["ntf_old"] } as never,
      }),
      event("run_dispatched", { run_id: id("run", 1) }),
      escalated({ seq: 51 }),
      escalated({
        seq: 52,
        payload: {
          assignment_id: A1,
          reason: "first_write_guard",
          notification_ids: ["ntf_review", "ntf_precheck"],
        } as never,
      }),
    ]),
  );
  const [wake, ...rest] = wakes(next);
  expect(rest).toEqual([]);
  expect(wake?.payload).toMatchObject({
    notification_ids: ["ntf_precheck", "ntf_review"],
    escalation_event_ids: [expect.any(String), expect.any(String)],
  });
});

test.each<[string, () => CommandState]>([
  [
    "a later session was dispatched",
    () =>
      busy([escalated(), event("run_dispatched", { run_id: id("run", 1) })]),
  ],
  [
    "the owner read past the escalation",
    () => ({
      ...busy(),
      cursors: [{ assignment_id: A1, card_id: C1, acked_seq: 50 }],
    }),
  ],
  [
    "the escalation was already handed to a fresh session",
    () =>
      busy([
        escalated(),
        event("work_item_resume_requested", {
          work_item_id: id("work_item", 1),
          stop_redelivery: true,
        }),
      ]),
  ],
  [
    "it was another Assignment's",
    () =>
      busy([
        escalated({
          payload: {
            assignment_id: id("assignment", 2),
            notification_ids: ["x"],
          } as never,
        }),
      ]),
  ],
  [
    "it carried no notification",
    () =>
      busy([
        escalated({
          payload: { assignment_id: A1, notification_ids: [] } as never,
        }),
      ]),
  ],
  ["it was not the system's", () => busy([escalated({ actor: human })])],
  [
    "a kept queued Run already starts the session",
    () => {
      const s = busy();
      return {
        ...s,
        runs: [...s.runs, { ...run(9, 1), status: "queued", kind: "followup" }],
      };
    },
  ],
  ["the work item is blocked", () => busy(undefined, { status: "blocked" })],
  [
    "the card is held",
    () => {
      const s = busy();
      return {
        ...s,
        cards: s.cards.map((c) => (c.id === C1 ? { ...c, hold: true } : c)),
      } as CommandState;
    },
  ],
])("C-812 no request when %s", (_why, state) => {
  const s = state();
  expect(wakes(release(s))).toEqual(wakes(s));
});

test.each(["delivered", "accepted", "changes_requested"] as const)(
  "C-812 a %s producer is still woken for its escalated bells",
  (status) => {
    expect(wakes(release(busy(undefined, { status })))).toHaveLength(1);
  },
);
