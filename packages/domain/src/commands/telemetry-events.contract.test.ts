import { expect, test } from "vitest";
import { cardEventsOfType, setTelemetryQueryGuard } from "../event-index.js";
import {
  appendEvents,
  commandEventHistory,
  commandStreamHistory,
  type Event,
  EventLog,
  EventLogView,
  eventById,
  eventsForDecision,
  eventsOfType,
  flatMapEvents,
  fullEventHistory,
  isTelemetryEvent,
  type JsonValue,
  parseEventId,
  stoppedByHuman,
  TELEMETRY_EVENT_TYPES,
  telemetryEvents,
} from "../index.js";
import { human, id, now, value } from "./test-fixtures.js";

const eventId = (n: number) =>
  value(parseEventId(n.toString().padStart(26, "0")));

let next = 0;
function event(
  type: string,
  payload: JsonValue = {},
  card_id?: Event["card_id"],
): Event {
  next++;
  return {
    id: eventId(next),
    seq: next,
    ...(card_id ? { card_id } : {}),
    type,
    actor: human,
    payload,
    created_at: now,
  };
}

const card = id("card", 1);
const owner = id("assignment", 1);
const parts = (): Event[][] => [
  [
    event("pm_coordination_started"),
    event("session_maintenance_changed", { assignment_id: owner }),
    event("run_queued", { run_id: "R-9", assignment_id: owner }),
  ],
  [
    event("work_item_assigned", { work_item_id: "W-1" }, card),
    event("run_queued", { run_id: "R-1", assignment_id: owner }, card),
    event("assignment_stopped", { assignment_id: owner }, card),
    event("run_dispatched", { run_id: "R-1", assignment_id: owner }, card),
    event("run_started", { run_id: "R-1", assignment_id: owner }, card),
    event("github_check_dispatch", { attempt: "C-1" }, card),
    event("assignment_branch_backed_up", { assignment_id: owner }, card),
    event("delivery_submitted", { delivery_id: "D-1" }, card),
    event(
      "run_finished",
      { run_id: "R-1", decision_id: "Q-1", outcome: "blocked" },
      card,
    ),
    event("decision_requested", { decision_id: "Q-1" }, card),
  ],
];

test("C-643: telemetry types are the four host telemetry families", () => {
  expect([...TELEMETRY_EVENT_TYPES].sort()).toEqual([
    "assignment_branch_backed_up",
    "github_check_dispatch",
    "github_probe_dispatch",
    "run_dispatched",
    "run_finished",
    "run_queued",
    "run_started",
    "session_maintenance_changed",
  ]);
  expect(isTelemetryEvent({ type: "run_inactive" })).toBe(false);
  expect(isTelemetryEvent({ type: "session_maintenance_attention" })).toBe(
    false,
  );
});

test("C-643: the command-state stream leaves telemetry out, lookups still see it in order", () => {
  const history = parts();
  const full = history.flat();
  const events = commandEventHistory(history);
  expect(events.map((e) => e.type)).toEqual([
    "pm_coordination_started",
    "work_item_assigned",
    "assignment_stopped",
    "delivery_submitted",
    "decision_requested",
  ]);
  expect(events.some(isTelemetryEvent)).toBe(false);
  expect(telemetryEvents(events)).toEqual(full.filter(isTelemetryEvent));
  expect(fullEventHistory(events)).toEqual(full);
  expect(fullEventHistory(events)).toBe(fullEventHistory(events));
  // Plain arrays are complete histories.
  expect(fullEventHistory(full)).toBe(full);
  expect(telemetryEvents(full)).toEqual([]);
  for (const type of [...TELEMETRY_EVENT_TYPES, "delivery_submitted", "x"])
    expect(eventsOfType(events, type)).toEqual(
      full.filter((e) => e.type === type),
    );
  for (const e of [...full, event("absent")])
    expect(eventById(events, e.id)).toBe(full.find((f) => f.id === e.id));
  expect(eventsForDecision(events, "Q-1")).toEqual(
    full.filter(
      (e) => (e.payload as { decision_id?: string }).decision_id === "Q-1",
    ),
  );
  // A dispatch after the stop (telemetry) still ends the human stop.
  expect(stoppedByHuman(events, owner)).toBe(false);
  expect(stoppedByHuman(full, owner)).toBe(false);
  // Unchanged parts are split once; a new history shares their events.
  const again = commandEventHistory(history);
  expect(again).not.toBe(events);
  expect(again[1]).toBe(events[1]);
});

test("C-643: draft histories keep the journal and see newly emitted telemetry", () => {
  const history = parts();
  const events = commandEventHistory(history);
  const stop = event("assignment_stopped", { assignment_id: owner }, card);
  const queued = event("run_queued", { run_id: "R-2" }, card);
  const extended = appendEvents(events, [stop, queued]);
  expect(extended.at(-1)).toBe(queued);
  expect(eventsOfType(extended, "run_queued")).toEqual([
    ...history.flat().filter((e) => e.type === "run_queued"),
    queued,
  ]);
  expect(eventById(extended, history[1]?.[3]?.id)).toBe(history[1]?.[3]);
  expect(fullEventHistory(extended)).toEqual([...history.flat(), stop, queued]);
  expect(stoppedByHuman(extended, owner)).toBe(true);
  // The source snapshot is unchanged.
  expect(eventsOfType(events, "run_queued")).toHaveLength(2);
  expect(stoppedByHuman(events, owner)).toBe(false);
  // Plain arrays stay plain.
  expect(appendEvents([stop], [queued])).toEqual([stop, queued]);
  expect(telemetryEvents(appendEvents([stop], [queued]))).toEqual([]);
});

test("C-643: scoped read states keep the journal through flatMapEvents", () => {
  const history = parts();
  const events = commandEventHistory(history);
  const onCard = (e: Event) => (e.card_id === card ? [e] : []);
  const scoped = flatMapEvents(events, onCard);
  expect(scoped).toEqual(events.flatMap(onCard));
  expect(fullEventHistory(scoped)).toEqual(history.flat().flatMap(onCard));
  expect(eventsOfType(scoped, "run_started")).toEqual(
    history.flat().filter((e) => e.type === "run_started"),
  );
  expect(eventsOfType(scoped, "session_maintenance_changed")).toEqual([]);
  expect(flatMapEvents(history.flat(), onCard)).toEqual(
    history.flat().flatMap(onCard),
  );
});

test("C-655: telemetry lookups on arrays derived from command-state events throw in tests", () => {
  const history = parts();
  const full = history.flat();
  const events = commandEventHistory(history);
  const started = full.find((e) => e.type === "run_started");
  const submitted = full.find((e) => e.type === "delivery_submitted");
  // Deliberately wrong: filter and spread drop the journal.
  const mine = events.filter((e) => e.card_id === card);
  for (const derived of [mine, [...events]]) {
    expect(() => eventsOfType(derived, "run_started")).toThrow(/C-655/);
    expect(() => cardEventsOfType(derived, card, "run_started")).toThrow(
      /C-655/,
    );
    expect(() => eventById(derived, started?.id)).toThrow(/C-655/);
    expect(() => fullEventHistory(derived)).toThrow(/C-655/);
    expect(() => telemetryEvents(derived)).toThrow(/C-655/);
    // Business lookups stay as before.
    expect(eventsOfType(derived, "delivery_submitted")).toEqual([submitted]);
    expect(eventById(derived, submitted?.id)).toBe(submitted);
    expect(eventById(derived, eventId(999))).toBeUndefined();
  }
  // The supported derivations keep the journal.
  const scoped = flatMapEvents(events, (e) => (e.card_id === card ? [e] : []));
  expect(eventsOfType(scoped, "run_started")).toEqual([started]);
  expect(eventsOfType(appendEvents(events, []), "run_started")).toEqual([
    started,
  ]);
  // Telemetry that the source does not hold for these cards is legitimately absent.
  const project = events.filter((e) => !e.card_id);
  expect(eventsOfType(project, "run_started")).toEqual([]);
  expect(() => eventsOfType(project, "run_queued")).toThrow(/C-655/);
  // Complete arrays and fresh fixtures stay unchecked.
  expect(eventsOfType(full, "run_started")).toEqual([started]);
  expect(eventsOfType([event("delivery_submitted")], "run_started")).toEqual(
    [],
  );
  setTelemetryQueryGuard(false);
  try {
    expect(eventsOfType(mine, "run_started")).toEqual([]);
    expect(eventById(mine, started?.id)).toBeUndefined();
  } finally {
    setTelemetryQueryGuard(true);
  }
});

test("C-655: derived Store command histories are guarded too", () => {
  const log = new EventLog();
  for (const e of parts().flat()) log.append(e);
  const view = new EventLogView(log, log.end);
  const events = commandStreamHistory(view, ["", card]);
  const started = view
    .history(["", card])
    .find((e) => e.type === "run_started");
  expect(eventsOfType(events, "run_started")).toEqual([started]);
  const mine = events.filter((e) => e.card_id === card);
  expect(() => eventsOfType(mine, "run_started")).toThrow(/C-655/);
  expect(() => eventById(mine, started?.id)).toThrow(/C-655/);
  // Raw stream reads keep telemetry inline.
  expect(eventsOfType(view.get(card) ?? [], "run_started")).toEqual([started]);
});
