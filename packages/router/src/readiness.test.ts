// C-212: deferred Needs You items ring when they become ready, never before.
import type { CardId, Event, HumanAction } from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  card,
  decision,
  delivery,
  event,
  humanAction,
  snapshot,
  workItem,
} from "./fixtures.js";
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
const otherWork = workItem("W-9", { card_id: OTHER });
const recipients = (input: Parameters<typeof routeEvent>[0]) =>
  routeEvent(input).notifications.map((n) => [n.recipient.kind, n.rule]);

test("a deferred action stays quiet when requested and rings when its card merges", () => {
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
  expect(
    recipients({ event: on(event("card_merged"), OTHER), snapshot: merged }),
  ).toEqual(
    expect.arrayContaining([
      ["needs_you", "6.4/needs you item ready"],
      ["pm_office", "6.4/needs you item ready"],
    ]),
  );
  // Once shown, a later request event rings as usual.
  expect(
    recipients({
      event: event("human_action_requested", { human_action_id: h.id }),
      snapshot: merged,
    }),
  ).toEqual([
    ["needs_you", "6.4/human action requested"],
    ["pm_office", "6.4/human action requested"],
  ]);
});

test("a card_delivery condition rings on the first new delivery only", () => {
  const h = action({
    ready_when: {
      kind: "card_delivery",
      card_id: OTHER,
      after: "D-1" as never,
    },
  });
  const deliveries = [
    delivery("D-1", { work_item_id: "W-9" as never }),
    delivery("D-2", { work_item_id: "W-9" as never }),
    delivery("D-3", { work_item_id: "W-9" as never }),
  ];
  const state = snapshot({
    human_actions: [h],
    cards: cards("in_progress"),
    work_items: [...snapshot().work_items, otherWork],
    deliveries,
  });
  const routed = (id: string) =>
    recipients({
      event: on(event("delivery_submitted", { delivery_id: id }), OTHER),
      snapshot: state,
    }).filter(([, rule]) => rule === "6.4/needs you item ready");
  expect(routed("D-2")).toEqual([
    ["needs_you", "6.4/needs you item ready"],
    ["pm_office", "6.4/needs you item ready"],
  ]);
  expect(routed("D-3")).toEqual([]);
});

test("a merge-holding deferred action surfaces when its own card asks to complete", () => {
  const h = action({
    blocks_merge: true,
    ready_when: { kind: "manual" },
  });
  const state = snapshot({
    human_actions: [h],
    deliveries: [delivery("D-5", { kind: "card_completion" })],
  });
  expect(
    recipients({
      event: event("delivery_submitted", { delivery_id: "D-5" }),
      snapshot: state,
    }).filter(([, rule]) => rule === "6.4/needs you item ready"),
  ).toEqual([
    ["needs_you", "6.4/needs you item ready"],
    ["pm_office", "6.4/needs you item ready"],
  ]);
  // A deferred action that holds nothing keeps waiting for its release.
  const loose = action({ ready_when: { kind: "manual" } });
  expect(
    recipients({
      event: event("delivery_submitted", { delivery_id: "D-5" }),
      snapshot: { ...state, human_actions: [loose] },
    }).filter(([, rule]) => rule === "6.4/needs you item ready"),
  ).toEqual([]);
});

test("a deferred human decision rings when ready, not when requested", () => {
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
      event: on(event("card_updated", { status: "cancelled" }), OTHER),
      snapshot: snapshot({ decisions: [q], cards: cards("cancelled") }),
    }),
  ).toEqual([
    ["needs_you", "6.4/needs you item ready"],
    ["pm_office", "6.4/needs you item ready"],
  ]);
});

test("a host action for an external operator rings PM Office only", () => {
  const h = action({ triage: "host", host_operator: "external" });
  const notes = routeEvent({
    event: event("human_action_requested", { human_action_id: h.id }),
    snapshot: snapshot({ human_actions: [h] }),
  }).notifications;
  expect(notes.map((n) => n.recipient.kind)).toEqual(["pm_office"]);
  expect(notes[0]?.summary).toContain("外接操作员");
});
