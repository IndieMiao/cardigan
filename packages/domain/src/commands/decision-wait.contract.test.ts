import { beforeEach, expect, test } from "vitest";
import { listNeedsYou, requestDecision } from "../index.js";
import { commit, f, item, setup } from "./launch/test-fixtures.js";
import { human, value } from "./test-fixtures.js";

beforeEach(setup);
const opened = "2026-01-01T00:00:00.000Z";
const later = "2026-01-01T00:01:00.000Z";
const question = {
  kind: "choose" as const,
  category: "general" as const,
  question: "Choose direction",
  context: "Project direction",
  options: [{ key: "go", description: "Continue", impact: "Proceed" }],
  recommended: "go",
  decider: "human" as const,
  blocking: false,
  affected_cards: [],
  affected_work_items: [],
};
const request = (at: string, card = false) =>
  commit(
    requestDecision(
      f.state,
      human,
      { ...question, ...(card ? { card_id: item().card_id } : {}) },
      { ...f.io, clock: { now: () => at } },
    ),
  );

test("§3.6 invariant 11: project and card decisions share the request-event clock without mutating state", () => {
  const project = request(opened),
    card = request(later, true);
  expect(f.state.timeline.some((e) => e.decision_id === project.id)).toBe(
    false,
  );
  expect(f.state.events).toContainEqual(
    expect.objectContaining({
      type: "decision_requested",
      created_at: opened,
      payload: expect.objectContaining({ decision_id: project.id }),
    }),
  );
  const before = JSON.stringify(f.state);
  const result = value(
    listNeedsYou(f.state, human, { now: () => "2026-01-01T00:02:00.000Z" }),
  );
  expect(result.data.decisions).toContainEqual(
    expect.objectContaining({
      id: project.id,
      opened_at: opened,
      waited_ms: 120000,
    }),
  );
  expect(result.data.decisions).toContainEqual(
    expect.objectContaining({
      id: card.id,
      opened_at: later,
      waited_ms: 60000,
    }),
  );
  expect(result.changes).toEqual([]);
  expect(result.events).toEqual([]);
  expect(result.timeline).toEqual([]);
  expect(JSON.stringify(f.state)).toBe(before);
});

test("§3.6: an older card snapshot can use its timeline but a project decision without evidence stays unknown", () => {
  const project = request(opened),
    card = request(later, true);
  // Legacy snapshot with request events missing; only the real card timeline remains.
  const state = { ...f.state, events: [] };
  const rows = value(
    listNeedsYou(state, human, { now: () => "2026-01-01T00:02:00.000Z" }),
  ).data.decisions;
  expect(rows.find((d) => d.id === project.id)).toMatchObject({
    opened_at: null,
    waited_ms: null,
  });
  expect(rows.find((d) => d.id === card.id)).toMatchObject({
    opened_at: later,
    waited_ms: 60000,
  });
});

test("§3.6: clock skew never produces a negative wait and an omitted query clock does not read wall time", () => {
  const decision = request(later);
  expect(
    value(listNeedsYou(f.state, human, { now: () => opened })).data
      .decisions[0],
  ).toMatchObject({ id: decision.id, opened_at: later, waited_ms: 0 });
  expect(value(listNeedsYou(f.state, human)).data.decisions[0]).toMatchObject({
    opened_at: later,
    waited_ms: null,
  });
});
