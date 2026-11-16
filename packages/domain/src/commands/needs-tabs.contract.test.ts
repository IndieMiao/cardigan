import { expect, test } from "vitest";
import type { CommandState, Decision, HumanAction } from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { listNeedsYou, listNeedsYouCounts } from "./queries.js";
import { actor, fixture, human, id, now, value } from "./test-fixtures.js";

const decision = (n: number): Decision => ({
  id: id("decision", n),
  key: id("decision", n),
  kind: "choose",
  raised_by: "human",
  question: "Synthetic decision",
  context: "Private detail",
  options: [],
  recommended: "wait",
  affected_cards: [],
  affected_work_items: [],
  blocking: true,
  decider: "human",
  doc_refs: [],
  status: "open",
});
test("tab counts and sections partition the existing human queue without changing owners or state", async () => {
  const f = mergeFixture();
  await f.accept();
  const merge = f.state.decisions.find(
    (q) => q.trigger === "merge_confirmation",
  );
  if (!merge) throw new Error("Missing merge confirmation");
  const action: HumanAction = {
    id: id("human_action", 901),
    key: id("human_action", 901),
    requested_by: "human",
    instructions: "Synthetic action",
    why_human: "Needs device",
    expected_return: "Result",
    blocked_work_items: [],
    status: "open",
  };
  const state: CommandState = {
    ...f.state,
    decisions: [
      ...f.state.decisions,
      decision(901),
      { ...decision(902), ready_when: { kind: "manual" } },
      {
        ...merge,
        id: id("decision", 903),
        key: id("decision", 903),
        decider: "role:pm",
      },
    ],
    human_actions: [
      action,
      {
        ...action,
        id: id("human_action", 902),
        key: id("human_action", 902),
        triage: "host",
      },
    ],
  };
  const before = JSON.stringify(state);
  const clock = { now: () => now };
  const all = value(listNeedsYou(state, human, clock)).data;
  const counts = value(listNeedsYouCounts(state, human, clock)).data;
  expect(counts).toEqual({
    total_pending: 3,
    tabs: {
      decisions: { count: 1, attention: 1 },
      merges: { count: 2, attention: 1 },
      actions: { count: 2, attention: 1 },
      later: { count: 1, attention: 0 },
      notices: { count: 0, attention: 0 },
    },
  });
  const sections = [
    "decisions",
    "merges",
    "actions",
    "later",
    "notices",
  ] as const;
  const pieces = sections.map(
    (section) => value(listNeedsYou(state, human, clock, { section })).data,
  );
  expect(
    pieces
      .flatMap((p) => p.decisions)
      .map((q) => q.id)
      .sort(),
  ).toEqual(all.decisions.map((q) => q.id).sort());
  expect(pieces.flatMap((p) => p.pm_held_merges)).toEqual(all.pm_held_merges);
  expect(pieces.flatMap((p) => p.human_actions)).toEqual(all.human_actions);
  expect(pieces.flatMap((p) => p.later)).toEqual(all.later);
  expect(pieces[4]?.decisions).toEqual([]);
  expect(pieces[4]?.human_actions).toEqual([]);
  expect(JSON.stringify(state)).toBe(before);
  expect(
    listNeedsYouCounts(state, { ...human, project_id: "other" }, clock).ok,
  ).toBe(false);
  expect(listNeedsYouCounts(state, actor(), clock).ok).toBe(false);
});

test("counts do not read decision context or build the detailed decision projection", () => {
  const q = decision(901);
  Object.defineProperty(q, "context", {
    enumerable: true,
    get() {
      throw new Error("Detail should not be read");
    },
  });
  const state = { ...fixture(), decisions: [q] };
  expect(
    value(listNeedsYouCounts(state, human, { now: () => now })).data.tabs
      .decisions.count,
  ).toBe(1);
  // Selecting an unrelated tab also avoids the unrequested decision body.
  expect(
    value(
      listNeedsYou(state, human, { now: () => now }, { section: "actions" }),
    ).data.decisions,
  ).toEqual([]);
});
