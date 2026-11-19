import { expect, test } from "vitest";
import type { Card } from "../entities.js";
import { refreshCardDependencies } from "./card-dependencies.js";
import { DEFAULT_FRAMEWORK_WAIT_REMINDER_MS } from "./framework-dependencies.js";
import { createCard, updateCard } from "./pm.js";
import {
  actor,
  apply,
  card,
  fixture,
  human,
  now,
  ports,
  value,
} from "./test-fixtures.js";

const prerequisite = card(2),
  dependent = card(1);
const linked = "framework_dependency_linked",
  overdue = "framework_dependency_overdue";
function scenario() {
  let s = { ...fixture(), cards: [dependent, prerequisite] as readonly Card[] };
  let elapsed = 0;
  const io = {
    ...ports(),
    clock: { now: () => new Date(Date.parse(now) + elapsed).toISOString() },
  };
  const update = (p: Parameters<typeof updateCard>[2]) => {
    const effect = value(updateCard(s, human, p, io));
    s = apply(s, effect);
    return effect.events.filter((e) => e.type === linked);
  };
  const sweep = () => {
    const effect = value(
      refreshCardDependencies(
        s,
        { kind: "system", project_id: human.project_id },
        io,
      ),
    );
    s = apply(s, effect);
    return effect.events.filter((e) => e.type === overdue);
  };
  return {
    update,
    sweep,
    state: () => s,
    io,
    advance: (ms: number) => {
      elapsed += ms;
    },
  };
}
const mark = { card_id: prerequisite.id, is_ui_framework: true };
const connect = { card_id: dependent.id, depends_on_cards: [prerequisite.id] };

test("marking a prerequisite with an existing successor starts a wait, not backdated to card creation", () => {
  const f = scenario();
  expect(f.update(connect)).toEqual([]);
  f.advance(DEFAULT_FRAMEWORK_WAIT_REMINDER_MS * 2);
  expect(f.sweep()).toEqual([]);
  const first = f.update(mark);
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({
    card_id: dependent.id,
    payload: { framework_card_id: prerequisite.id },
  });
  expect(f.update(mark)).toEqual([]);
  expect(f.update(connect)).toEqual([]);
  f.advance(DEFAULT_FRAMEWORK_WAIT_REMINDER_MS);
  expect(f.sweep()).toEqual([]);
  f.advance(1);
  expect(f.sweep()).toMatchObject([
    { card_id: dependent.id, payload: { link_event_id: first[0]?.id } },
  ]);
  expect(f.sweep()).toEqual([]);
  expect(f.state().cards.find((c) => c.id === dependent.id)).toMatchObject({
    status: dependent.status,
    depends_on_cards: [prerequisite.id],
  });
  expect(
    f.state().cards.find((c) => c.id === dependent.id)?.early_start,
  ).toBeUndefined();
});

test.each(["edge", "marker"])(
  "removing and restoring a %s starts a fresh wait even without an intervening tick",
  (mode) => {
    const f = scenario();
    f.update(mark);
    const original = f.update(connect);
    f.advance(DEFAULT_FRAMEWORK_WAIT_REMINDER_MS + 1);
    expect(f.sweep()).toHaveLength(1);
    f.update(
      mode === "edge"
        ? { ...connect, depends_on_cards: [] }
        : { ...mark, is_ui_framework: false },
    );
    const restored = f.update(mode === "edge" ? connect : mark);
    expect(restored).toHaveLength(1);
    expect(restored[0]?.id).not.toBe(original[0]?.id);
    expect(f.sweep()).toEqual([]);
    f.advance(DEFAULT_FRAMEWORK_WAIT_REMINDER_MS + 1);
    expect(f.sweep()).toMatchObject([
      { payload: { link_event_id: restored[0]?.id } },
    ]);
  },
);

test.each([
  { ...connect, depends_on_cards: [] },
  { ...mark, is_ui_framework: false },
  {
    card_id: dependent.id,
    early_start: true,
    dependency_reason: "Parallel work",
  },
  ...[dependent, prerequisite].flatMap((c) => [
    { card_id: c.id, status: "cancelled" as const },
    { card_id: c.id, hold: { reason: "Pause", resume_condition: "PM review" } },
  ]),
])(
  "no overdue notice for inactive or deliberately bypassed wait %o",
  (change) => {
    const f = scenario();
    f.update(mark);
    f.update(connect);
    f.update(change);
    f.advance(DEFAULT_FRAMEWORK_WAIT_REMINDER_MS + 1);
    expect(f.sweep()).toEqual([]);
  },
);

test("creating a dependent on a marked framework records the link; work-item PM cannot set the scheduling marker", () => {
  const f = scenario();
  f.update(mark);
  const created = value(
    createCard(
      f.state(),
      human,
      {
        title: "Successor",
        goal: "Use layout",
        template: "general",
        source: { kind: "quote", text: "Build after layout" },
        depends_on_cards: [prerequisite.id],
      },
      f.io,
    ),
  );
  expect(created.events.filter((e) => e.type === linked)).toMatchObject([
    {
      card_id: created.data.id,
      payload: { framework_card_id: prerequisite.id },
    },
  ]);
  expect(
    updateCard(
      f.state(),
      actor(3, "pm"),
      { card_id: dependent.id, is_ui_framework: true },
      f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
});
