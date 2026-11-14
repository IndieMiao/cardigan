// C-212: deferred Needs You items ring from their own `needs_you_item_ready`
// event when they become ready, never from the request or the other card.
import {
  type CardId,
  type Event,
  type HumanAction,
  NEEDS_YOU_ITEM_READY,
} from "@cardigan/domain";
import { expect, test } from "vitest";
import { card, decision, event, humanAction, snapshot } from "./fixtures.js";
import { routeEvent } from "./route.js";

const OTHER = "C-2" as CardId;
const on = (e: Event, card_id: CardId): Event => ({ ...e, card_id });
const action = (overrides: Partial<HumanAction> = {}): HumanAction => ({
  ...humanAction(),
  status: "open",
  triage: "human",
  blocked_work_items: [],
  ...overrides,
});
const cards = (status: string) => [
  card(),
  card({ id: OTHER, status: status as never }),
];
const recipients = (input: Parameters<typeof routeEvent>[0]) =>
  routeEvent(input).notifications.map((n) => [n.recipient.kind, n.rule]);
const ready = (payload: Record<string, unknown>) =>
  event(NEEDS_YOU_ITEM_READY, {
    condition: { kind: "card_merged", card_id: OTHER },
    source_card_id: OTHER,
    waiting_for: "等 C-2 合并",
    ...payload,
  });

test("a deferred action stays quiet when requested and rings from its own ready event", () => {
  const h = action({ ready_when: { kind: "card_merged", card_id: OTHER } });
  expect(
    recipients({
      event: event("human_action_requested", { human_action_id: h.id }),
      snapshot: snapshot({
        human_actions: [h],
        cards: cards("awaiting_merge"),
      }),
    }),
  ).toEqual([]);
  const merged = snapshot({ human_actions: [h], cards: cards("done") });
  // The other card's merge itself rings nobody about this action.
  expect(
    recipients({
      event: on(event("card_merged"), OTHER),
      snapshot: merged,
    }).filter(([kind]) => kind !== "pm_ops"),
  ).toEqual([]);
  const notes = routeEvent({
    event: ready({ human_action_id: h.id }),
    snapshot: merged,
  }).notifications;
  expect(notes.map((n) => [n.recipient.kind, n.rule, n.card_id])).toEqual([
    ["needs_you", "6.4/needs you item ready", "C-1"],
    ["pm_office", "6.4/needs you item ready", "C-1"],
  ]);
  expect(notes[0]?.summary).toContain(h.id);
});

test("a ready event for an item closed or back in PM triage rings nobody", () => {
  for (const h of [action({ status: "done" }), action({ triage: "pm_ops" })])
    expect(
      recipients({
        event: ready({ human_action_id: h.id }),
        snapshot: snapshot({ human_actions: [h], cards: cards("done") }),
      }),
    ).toEqual([]);
});

test("a deferred human decision rings from its ready event, not when requested", () => {
  const q = decision({
    status: "open",
    affected_cards: [],
    ready_when: { kind: "card_merged", card_id: OTHER },
  });
  expect(
    recipients({
      event: event("decision_requested", { decision_id: q.id }),
      snapshot: snapshot({ decisions: [q], cards: cards("review") }),
    }),
  ).toEqual([]);
  expect(
    recipients({
      event: ready({ decision_id: q.id }),
      snapshot: snapshot({ decisions: [q], cards: cards("cancelled") }),
    }),
  ).toEqual([
    ["needs_you", "6.4/needs you item ready"],
    ["pm_office", "6.4/needs you item ready"],
  ]);
});

test("a host action for an external operator rings PM Office only", () => {
  const h = action({ triage: "host", host_operator: "external" });
  for (const e of [
    event("human_action_requested", { human_action_id: h.id }),
    ready({ human_action_id: h.id }),
  ]) {
    const notes = routeEvent({
      event: e,
      snapshot: snapshot({ human_actions: [h], cards: cards("done") }),
    }).notifications;
    expect(notes.map((n) => n.recipient.kind)).toEqual(["pm_office"]);
    expect(notes[0]?.summary).toContain("外接操作员");
  }
});
