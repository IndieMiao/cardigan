import { expect, test } from "vitest";
import { type Decision, type Event, needsYouReadPhase } from "../index.js";
import { fixture, id, now, ports } from "./test-fixtures.js";

test("read phase follows existing runtime visibility boundaries, not elapsed display time", () => {
  const state = fixture();
  const a = state.assignments[0];
  if (!a) throw new Error("missing assignment");
  const io = ports();
  const event: Event = {
    id: io.ids.nextEventId(),
    seq: 1,
    type: "runtime_disconnected",
    created_at: now,
    actor: { kind: "system", project_id: state.project_id },
    payload: {
      assignment_id: a.id,
      runtime_key: JSON.stringify(a.runtime_ref),
      cause: "failures",
    },
  };
  const snapshot = {
    ...state,
    assignments: state.assignments.map((x) =>
      x.id === a.id ? { ...x, runtime_state: "unknown" as const } : x,
    ),
    events: [event],
  };
  const at = (ms: number) => new Date(Date.parse(now) + ms).toISOString();
  expect(needsYouReadPhase(snapshot, at(0))).toBe(
    needsYouReadPhase(snapshot, at(59_999)),
  );
  expect(needsYouReadPhase(snapshot, at(60_000))).not.toBe(
    needsYouReadPhase(snapshot, at(59_999)),
  );
  expect(needsYouReadPhase(snapshot, at(60_000))).toBe(
    needsYouReadPhase(snapshot, at(90_000)),
  );
});

test("read phase advances when the existing review-limit follow-up becomes visible", () => {
  const state = fixture();
  const item = state.work_items.find((w) => w.kind === "verify");
  if (!item) throw new Error("missing verifier");
  const q: Decision = {
    id: id("decision", 1),
    key: id("decision", 1),
    kind: "choose",
    trigger: "review_limit",
    raised_by: "human",
    card_id: item.card_id,
    question: "Review?",
    context: "fixture",
    options: [{ key: "raise_limit", description: "raise", impact: "review" }],
    recommended: "raise_limit",
    affected_cards: [item.card_id],
    affected_work_items: [item.id],
    blocking: true,
    decider: "human",
    doc_refs: [],
    status: "resolved",
    resolution: {
      option: "raise_limit",
      rationale: "fixture",
      resolved_by: "human",
      via: "needs_you",
      raw_quote: "fixture",
      via_chain: [],
      at: now,
    },
  };
  const snapshot = {
    ...state,
    decisions: [q],
    work_items: state.work_items.map((w) =>
      w.id === item.id ? { ...w, status: "waiting_decision" as const } : w,
    ),
  };
  const at = (ms: number) => new Date(Date.parse(now) + ms).toISOString();
  expect(needsYouReadPhase(snapshot, at(0))).toBe(
    needsYouReadPhase(snapshot, at(600_000)),
  );
  expect(needsYouReadPhase(snapshot, at(600_001))).not.toBe(
    needsYouReadPhase(snapshot, at(600_000)),
  );
  expect(needsYouReadPhase(snapshot, at(600_001))).toBe(
    needsYouReadPhase(snapshot, at(700_000)),
  );
});
