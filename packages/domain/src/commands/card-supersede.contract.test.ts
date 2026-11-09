import { expect, test } from "vitest";
import {
  type Actor,
  type Card,
  type CommandState,
  projectSnapshot,
  supersedeCard,
  updateCard,
} from "../index.js";
import {
  actor,
  apply,
  card,
  fixture,
  human,
  id,
  ports,
  value,
} from "./test-fixtures.js";

const params = { card_id: id("card", 1), superseded_by: id("card", 2) };
const snapshot = (state: CommandState): CommandState =>
  JSON.parse(JSON.stringify(state));
function closed(status: Card["status"] = "done"): CommandState {
  return {
    ...fixture(),
    cards: [
      { ...card(), status, resolution: "done", related_cards: [id("card", 3)] },
      card(2),
      card(3),
    ],
  };
}

test.each(["done", "cancelled"] as const)(
  "P2a-5: superseding %s preserves status and all work, records the target and audit event",
  (status) => {
    const state = closed(status);
    const before = snapshot(state);
    const effect = value(supersedeCard(state, human, params, ports()));
    expect(effect.data).toEqual({
      ...state.cards[0],
      resolution: "superseded",
      superseded_by: params.superseded_by,
      related_cards: [id("card", 3), params.superseded_by],
    });
    expect(effect.changes).toEqual([
      { collection: "cards", entity: effect.data },
    ]);
    expect(effect.events).toMatchObject([
      {
        type: "card_superseded",
        card_id: params.card_id,
        actor: human,
        payload: params,
      },
    ]);
    expect(effect.timeline).toMatchObject([
      {
        author: "human",
        body: "已被 C-2 取代",
        refs: [{ kind: "card", id: params.superseded_by }],
      },
    ]);
    expect(effect.timeline[0]?.event_seq).toBe(effect.events[0]?.seq);
    expect(state).toEqual(before);
    const next = apply(state, effect);
    expect(next.work_items).toEqual(before.work_items);
    expect(
      value(projectSnapshot(next, human)).data.cards.find(
        (c) => c.id === params.card_id,
      ),
    ).toMatchObject({
      status,
      resolution: "superseded",
      superseded_by: params.superseded_by,
    });
  },
);

test("P2a-5: existing relations are deduplicated and retrying the same replacement is a no-op", () => {
  const state = closed();
  const io = ports();
  const first = value(
    supersedeCard(
      state,
      human,
      { ...params, superseded_by: id("card", 3) },
      io,
    ),
  );
  expect(first.data.related_cards).toEqual([id("card", 3)]);
  const second = value(
    supersedeCard(
      apply(state, first),
      human,
      { ...params, superseded_by: id("card", 3) },
      io,
    ),
  );
  expect(second.changes).toEqual([]);
  expect(second.events).toEqual([]);
  const revised = value(supersedeCard(apply(state, first), human, params, io));
  expect(revised.data.superseded_by).toBe(params.superseded_by);
  expect(revised.data.related_cards).toEqual([
    id("card", 3),
    params.superseded_by,
  ]);
});

test.each([
  "backlog",
  "todo",
  "in_progress",
  "review",
  "awaiting_merge",
] as const)(
  "invariant 11: superseding unfinished %s is rejected without effects",
  (status) => {
    const state = closed(status),
      before = snapshot(state);
    expect(supersedeCard(state, human, params, ports())).toMatchObject({
      ok: false,
      error: { code: "illegal_transition" },
    });
    expect(state).toEqual(before);
  },
);

test.each([
  { target: id("card", 1), code: "validation_failed" },
  { target: id("card", 99), code: "not_found" },
  { target: id("card", 2), code: "unauthorized", project: "another-project" },
])(
  "invariant 11: rejects invalid replacement $target ($code)",
  ({ target, code, project }) => {
    const state = closed();
    const input = project
      ? {
          ...state,
          cards: state.cards.map((c) =>
            c.id === target ? { ...c, project_id: project } : c,
          ),
        }
      : state;
    const before = snapshot(input);
    expect(
      supersedeCard(
        input,
        human,
        { ...params, superseded_by: target },
        ports(),
      ),
    ).toMatchObject({ ok: false, error: { code } });
    expect(input).toEqual(before);
  },
);

test.each<Actor>([
  actor(),
  actor(3, "pm"),
  actor(4, "pm"),
  { kind: "system", project_id: human.project_id },
])("invariant 11: only the human can mark a replacement ($kind)", (who) => {
  expect(supersedeCard(closed(), who, params, ports())).toMatchObject({
    ok: false,
    error: { code: "forbidden_tool" },
  });
});

test("invariant 11: missing source or a human from another project cannot supersede a card", () => {
  expect(
    supersedeCard(
      closed(),
      human,
      { ...params, card_id: id("card", 99) },
      ports(),
    ),
  ).toMatchObject({ ok: false, error: { code: "not_found" } });
  expect(
    supersedeCard(
      closed(),
      { kind: "human", project_id: "another-project" },
      params,
      ports(),
    ),
  ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
});

test("P2a-5: cancelling a done card rejects the entire update and preserves its work", () => {
  const state = closed(),
    before = snapshot(state);
  expect(
    updateCard(
      state,
      human,
      {
        card_id: params.card_id,
        title: "Must not change",
        status: "cancelled",
      },
      ports(),
    ),
  ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
  expect(state).toEqual(before);
});
