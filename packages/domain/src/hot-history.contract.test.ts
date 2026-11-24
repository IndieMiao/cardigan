import { describe, expect, test } from "vitest";
import type { CommandState } from "./commands/core.js";
import {
  assignment,
  card,
  fixture,
  id,
  now,
  run,
  value,
} from "./commands/test-fixtures.js";
import type {
  Card,
  Event,
  HumanAction,
  JsonValue,
  WorkItem,
} from "./entities.js";
import {
  commandEventHistory,
  fullEventHistory,
  isTelemetryEvent,
} from "./event-index.js";
import {
  COLD_CARD_OMITTED_EVENT_TYPES,
  cardClosed,
  commandTargetCards,
  hotCardIds,
  hotCommandEvents,
  liveTriggerEventIds,
} from "./hot-history.js";
import { compareHotState } from "./hot-history-shadow.js";
import { type CardId, parseEventId } from "./ids.js";

let serial = 0;
const event = (
  type: string,
  card_id?: CardId,
  payload: Record<string, JsonValue> = {},
): Event => ({
  id: value(parseEventId(String(++serial).padStart(26, "0"))),
  seq: serial,
  ...(card_id ? { card_id } : {}),
  type,
  actor: { kind: "system", project_id: fixture().project_id },
  payload,
  created_at: now,
});
const closed = (n: number, extra: Partial<Card> = {}): Card => ({
  ...card(n),
  status: "done",
  resolution: "done",
  ...extra,
});
const telemetry = (c: CardId) =>
  [...COLD_CARD_OMITTED_EVENT_TYPES].map((type) => event(type, c));

/**
 * C1 is open. C2 is a done predecessor of C1, C3 is a done card nothing
 * references, C4 is done but has an open human action, C5 is cancelled and
 * holds the trigger of C1's queued Run, C6 is done with a released assignment.
 */
function scenario(triggerType = "comment_posted"): CommandState {
  serial = 0;
  const base = fixture();
  const [c1, c2, c3, c4, c5, c6] = [1, 2, 3, 4, 5, 6].map((n) =>
    id("card", n),
  ) as [CardId, CardId, CardId, CardId, CardId, CardId];
  const trigger = event(triggerType, c5);
  const taken = event("host_ops_action_taken", undefined, {
    execution: true,
    assignment_id: id("assignment", 1),
  });
  const events = [
    taken,
    event("card_created", c1),
    event("run_started", c1),
    event("card_merged", c2),
    ...telemetry(c2),
    event("comment_posted", c3),
    // The finish of a system-stream host action lives on a cold card stream.
    event("host_ops_action_finished", c3, { action_id: taken.id }),
    ...telemetry(c3),
    ...telemetry(c4),
    trigger,
    ...telemetry(c5),
    ...telemetry(c6),
  ];
  const item6 = {
    ...(base.work_items[0] as WorkItem),
    id: id("work_item", 6),
    card_id: c6,
    status: "accepted",
    assignment_id: id("assignment", 6),
  } as WorkItem;
  const action: HumanAction = {
    id: id("human_action", 1),
    key: id("human_action", 1),
    card_id: c4,
    requested_by: "system",
    instructions: "Check",
    why_human: "Only a person can",
    expected_return: "Done",
    blocked_work_items: [],
    status: "open",
    created_at: now,
  } as unknown as HumanAction;
  return {
    ...base,
    cards: [
      { ...card(1), depends_on_cards: [c2] },
      closed(2),
      closed(3),
      closed(4),
      closed(5, { status: "cancelled", resolution: "wontdo" }),
      closed(6),
    ],
    work_items: [...base.work_items, item6],
    assignments: [
      ...base.assignments,
      { ...assignment(6), status: "released", runtime_state: "released" },
    ],
    runs: [
      { ...run(1), status: "queued", trigger_event_id: trigger.id },
      { ...run(6, 6), status: "completed" },
    ],
    human_actions: [action],
    events,
  };
}

describe("C-639 hot command state", () => {
  test("hot cards: every open card plus closed cards live work still references", () => {
    const state = scenario();
    const triggers = liveTriggerEventIds(state.runs);
    const triggerCards = state.events
      .filter((e) => triggers.includes(e.id))
      .map((e) => e.card_id);
    const hot = hotCardIds(state, triggerCards);
    expect([...hot].sort()).toEqual(
      [id("card", 1), id("card", 2), id("card", 4), id("card", 5)].sort(),
    );
    for (const c of state.cards)
      if (!cardClosed(c)) expect(hot.has(c.id)).toBe(true);
  });

  test("cold cards lose only execution telemetry; hot streams and the project stream stay whole", () => {
    const state = scenario();
    const events = hotCommandEvents(state);
    const dropped = state.events.filter((e) => !events.includes(e));
    expect(dropped.length).toBeGreaterThan(0);
    for (const e of dropped) {
      expect(COLD_CARD_OMITTED_EVENT_TYPES.has(e.type)).toBe(true);
      expect([id("card", 3), id("card", 6)]).toContain(e.card_id);
    }
    // Order is preserved; nothing is added.
    expect(events).toEqual(state.events.filter((e) => events.includes(e)));
    // A command or live notification naming a cold card restores it whole.
    expect(hotCommandEvents(state, [id("card", 3)]).length).toBe(
      events.length + COLD_CARD_OMITTED_EVENT_TYPES.size,
    );
  });

  test("shadow rules and projections agree on whole and hot history", () => {
    const full = scenario();
    const hot = { ...full, events: hotCommandEvents(full) };
    expect(hot.events.length).toBeLessThan(full.events.length);
    const checks = compareHotState(full, hot, { now });
    expect(checks.filter((c) => !c.equal)).toEqual([]);
    // The host-ops fence stays released: its finish on a cold card is kept.
    expect(checks.find((c) => c.name === "pending_host_ops")?.equal).toBe(true);
  });

  test("shadow comparison reports a divergence by path, never by value", () => {
    const full = scenario();
    const broken = {
      ...full,
      events: full.events.filter((e) => e.type !== "host_ops_action_finished"),
    };
    const failed = compareHotState(full, broken, { now }).filter(
      (c) => !c.equal,
    );
    expect(failed.map((c) => c.name)).toContain("pending_host_ops");
    for (const c of failed) expect(c.path).toMatch(/^\$/);
  });

  test("C-643: a telemetry-free command stream maps to the same hot history, triggers read from the journal", () => {
    // The live Run's trigger is a run_queued (telemetry) on cancelled C5.
    const plain = scenario("run_queued");
    const whole = { ...plain, events: commandEventHistory([plain.events]) };
    expect(whole.events.some((e) => e.type === "run_queued")).toBe(false);
    const expected = hotCommandEvents(plain);
    const events = hotCommandEvents(whole);
    // C5 stays hot although its trigger is only in the journal.
    expect(
      fullEventHistory(events).filter((e) => e.card_id === id("card", 5)),
    ).toEqual(plain.events.filter((e) => e.card_id === id("card", 5)));
    expect(events).toEqual(expected.filter((e) => !isTelemetryEvent(e)));
    expect(fullEventHistory(events)).toEqual(expected);
    const checks = compareHotState(whole, { ...whole, events }, { now });
    expect(checks.filter((c) => !c.equal)).toEqual([]);
  });

  test("command targets resolve cards through indirect ids", () => {
    const state = scenario();
    expect(
      [
        ...commandTargetCards({ ...state, deliveries: [], reviews: [] }, [
          { work_item_id: id("work_item", 6) },
          id("human_action", 1),
          { nested: [{ card_id: id("card", 3) }] },
          id("assignment", 6),
          "unrelated",
        ]),
      ].sort(),
    ).toEqual([id("card", 3), id("card", 4), id("card", 6)].sort());
  });
});
