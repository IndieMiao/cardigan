import { expect, test } from "vitest";
import {
  type Actor,
  type Attachment,
  type Card,
  type CommandState,
  cardDependencyView,
  type Delivery,
  type DeliveryStatus,
  deriveCardFields,
  deriveReviewMatrix,
  type Event,
  mergeStage,
  parseEventId,
  referenceProjectSnapshot,
  referenceReadState,
  type TimelineEntry,
  type WorkItem,
} from "../index.js";
import {
  actor,
  assignment,
  card,
  fixture,
  id,
  now,
  subject,
  value,
} from "./test-fixtures.js";

// C-648: project snapshots index card-independent sources once per snapshot.
// Every card must still see exactly what its own per-card scan returned.

const system: Actor = { kind: "system", project_id: "fixture-project" };
const delivery = (
  n: number,
  work_item: WorkItem["id"],
  status: DeliveryStatus,
  kind: Delivery["kind"] = "card_completion",
): Delivery => ({
  id: id("delivery", n),
  work_item_id: work_item,
  run_id: id("run", 1),
  kind,
  summary: `delivery ${n}`,
  subject,
  evidence: [],
  attachments: [],
  known_gaps: [],
  requested_verifiers: [],
  status,
});
let serial = 0;
const passedCheck = (cardId: Card["id"], completion: Delivery): Event => ({
  id: value(parseEventId(String(++serial).padStart(26, "0"))),
  card_id: cardId,
  seq: serial,
  type: "merge_check_finished",
  actor: system,
  created_at: now,
  payload: {
    attempt_id: `check-${completion.id}`,
    completion_id: completion.id,
    level: "card",
    status: "passed",
    checks: [],
  },
});
const item = (n: number, cardId: Card["id"]): WorkItem => ({
  id: id("work_item", n),
  card_id: cardId,
  title: `Build ${n}`,
  kind: "produce",
  role_id: "coder",
  status: "in_progress",
  required: true,
  depends_on: [],
  completion_criteria: ["passes"],
  template_key: "development",
});

function mergeState(): CommandState {
  const base = fixture();
  const first = { ...card(), status: "awaiting_merge" as const };
  const second = { ...card(2), status: "awaiting_merge" as const };
  const deliveries = [
    delivery(5, id("work_item", 3), "accepted"),
    delivery(12, id("work_item", 1), "submitted"),
    delivery(15, id("work_item", 1), "superseded"),
    delivery(9, id("work_item", 4), "accepted"),
  ];
  return {
    ...base,
    cards: [first, second],
    work_items: [...base.work_items, item(4, second.id)],
    deliveries,
    events: deliveries.map((v) =>
      passedCheck(
        v.work_item_id === id("work_item", 4) ? second.id : first.id,
        v,
      ),
    ),
    project_settings: {
      merge_gate_enabled: true,
      merge_queue: { max_batch_size: 4 },
    },
  };
}
const checkedCompletion = (state: CommandState, n: number) =>
  mergeStage(state, state.cards[n - 1] as Card)?.card_check?.completion_id;

test("merge stage picks each card's newest open completion and follows new collections", () => {
  const state = mergeState();
  expect(checkedCompletion(state, 1)).toBe(id("delivery", 12));
  expect(checkedCompletion(state, 2)).toBe(id("delivery", 9));

  // A newer open completion without a passed check replaces the old evidence.
  const newer = {
    ...state,
    deliveries: [
      ...state.deliveries,
      delivery(20, id("work_item", 2), "submitted"),
    ],
  };
  expect(mergeStage(newer, newer.cards[0] as Card)).toEqual({
    stage: "awaiting_confirmation",
  });
  // The original immutable snapshot keeps its own answer.
  expect(checkedCompletion(state, 1)).toBe(id("delivery", 12));

  // Same deliveries, moved work item: ownership follows the new array.
  const moved = {
    ...state,
    work_items: state.work_items.map((w) =>
      w.id === id("work_item", 1) ? { ...w, card_id: id("card", 2) } : w,
    ),
    events: [
      ...state.events,
      passedCheck(id("card", 2), state.deliveries[1] as Delivery),
    ],
  };
  expect(checkedCompletion(moved, 1)).toBe(id("delivery", 5));
  expect(checkedCompletion(moved, 2)).toBe(id("delivery", 12));
});

function dependencyState(): CommandState {
  const base = fixture();
  const cards: Card[] = [1, 2, 3, 4, 5, 6].map((n) => ({
    ...card(n),
    priority: (n % 2) as Card["priority"],
    ...(n > 1 ? { depends_on_cards: [id("card", n - 1)] } : {}),
    ...(n === 6 ? { depends_on_cards: [id("card", 1), id("card", 4)] } : {}),
  }));
  return {
    ...base,
    cards,
    work_items: [
      ...base.work_items,
      item(4, id("card", 2)),
      item(5, id("card", 5)),
    ],
    deliveries: [
      delivery(7, id("work_item", 1), "submitted", "code"),
      delivery(8, id("work_item", 4), "accepted", "code"),
      delivery(10, id("work_item", 5), "rejected", "code"),
      delivery(11, id("work_item", 4), "submitted", "code"),
    ],
  };
}

test.each([
  ["work item", actor()],
  ["standing PM", actor(4, "pm")],
])(
  "the %s reference snapshot keeps every card's own sources and dependency view",
  (_label, reader) => {
    const state = dependencyState();
    const snapshot = value(referenceProjectSnapshot(state, reader)).data;
    expect(snapshot.cards.map((c) => c.id)).toEqual(
      ["C-1", "C-3", "C-5", "C-2", "C-4", "C-6"].map((c) =>
        id("card", Number(c.slice(2))),
      ),
    );
    for (const source of state.cards) {
      const view = snapshot.cards.find((c) => c.id === source.id);
      const items = state.work_items.filter((w) => w.card_id === source.id);
      const deliveries = state.deliveries.filter((v) =>
        items.some((w) => w.id === v.work_item_id),
      );
      expect(view).toMatchObject({
        review_matrix: deriveReviewMatrix(deliveries, items, state.reviews),
        dependency: cardDependencyView(state, source),
      });
    }
    expect(value(referenceProjectSnapshot(state, reader)).data).toEqual(
      snapshot,
    );
    // New collections are new snapshots: nothing survives from the old index.
    const changed = {
      ...state,
      cards: state.cards.map((c) =>
        c.id === id("card", 6) ? { ...c, depends_on_cards: [] } : c,
      ),
    };
    const after = value(referenceProjectSnapshot(changed, reader)).data;
    expect(after.cards.find((c) => c.id === id("card", 1))).toMatchObject({
      dependency: cardDependencyView(changed, changed.cards[0] as Card),
    });
    expect(after.cards.find((c) => c.id === id("card", 6))).not.toHaveProperty(
      "dependency",
    );
  },
);

test("attachment visibility keeps first-delivery and same-card bindings", () => {
  const base = dependencyState();
  const entry: TimelineEntry = {
    id: "C-2#1" as never,
    short_id: "C-2#1" as never,
    card_id: id("card", 2),
    event_seq: 1,
    type: "comment",
    body: "reference",
    refs: [],
    mentions: [],
    author: "human",
    retracted: false,
    created_at: now,
  };
  const attachment = (
    n: number,
    cardId: Card["id"],
    attach_to: Attachment["attach_to"],
  ): Attachment => ({
    id: `ATT-${n}` as never,
    card_id: cardId,
    kind: "evidence",
    sha256: "a".repeat(64),
    size: 1,
    mime: "text/plain",
    storage_path: "synthetic",
    uploaded_by: "human",
    attach_to,
  });
  const state: CommandState = {
    ...base,
    timeline: [entry],
    // A legacy duplicate delivery id: the first record decides ownership.
    deliveries: [
      ...base.deliveries,
      delivery(7, id("work_item", 4), "accepted"),
    ],
    attachments: [
      attachment(1, id("card", 2), { kind: "timeline_entry", id: entry.id }),
      attachment(2, id("card", 1), { kind: "timeline_entry", id: entry.id }),
      attachment(3, id("card", 2), { kind: "delivery", id: id("delivery", 8) }),
      attachment(4, id("card", 1), { kind: "delivery", id: id("delivery", 8) }),
      attachment(5, id("card", 1), { kind: "delivery", id: id("delivery", 7) }),
      attachment(6, id("card", 2), { kind: "delivery", id: id("delivery", 7) }),
      attachment(7, id("card", 1), {
        kind: "delivery",
        id: id("delivery", 99),
      }),
    ],
  };
  expect(
    referenceReadState(state, assignment()).attachments.map((a) => a.id),
  ).toEqual(["ATT-1", "ATT-3", "ATT-5"]);
});

test("next owners follow each assignments snapshot", () => {
  const state = fixture();
  const input = {
    card: card(),
    work_items: state.work_items.filter((w) => w.id === id("work_item", 1)),
    deliveries: [],
    reviews: [],
    decisions: [],
    human_actions: [],
  };
  expect(
    deriveCardFields({ ...input, assignments: state.assignments }).next_owners,
  ).toEqual([{ kind: "assignment", ref: id("assignment", 1) }]);
  const released = state.assignments.map((a) =>
    a.id === id("assignment", 1) ? { ...a, status: "released" as const } : a,
  );
  expect(
    deriveCardFields({ ...input, assignments: released }).next_owners,
  ).toEqual([{ kind: "role", ref: "coder" }]);
});
