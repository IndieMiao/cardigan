import { expect, test } from "vitest";
import type { CommandState, Decision, Event, HumanAction } from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { listNeedsYou, listNeedsYouCounts } from "./queries.js";
import {
  actor,
  fixture,
  human,
  id,
  now,
  ports,
  value,
} from "./test-fixtures.js";

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
  const grouped = [901, 902].map((n) => {
    const q = {
      ...decision(n),
      card_id: id("card", 1),
      handoff_group: "C-1/general",
    };
    Object.defineProperty(q, "context", {
      enumerable: true,
      get() {
        throw new Error("Detail should not be read");
      },
    });
    return q;
  });
  const state = { ...fixture(), decisions: grouped };
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

test("group counts and the selected decision section share sources and keep independent answers", () => {
  const grouped = [901, 902].map((n) => ({
    ...decision(n),
    card_id: id("card", 1),
    handoff_group: "C-1/general",
  }));
  const state = { ...fixture(), decisions: grouped };
  const clock = { now: () => now };
  const all = value(listNeedsYou(state, human, clock)).data;
  const section = value(
    listNeedsYou(state, human, clock, { section: "decisions" }),
  ).data;
  expect(section.decisions).toEqual(all.decisions);
  expect(section.decisions[0]?.grouped_decisions?.map((q) => q.id)).toEqual(
    grouped.map((q) => q.id),
  );
  expect(
    value(listNeedsYouCounts(state, human, clock)).data.tabs.decisions.count,
  ).toBe(section.decisions.length);
  const answered = {
    ...state,
    decisions: state.decisions.map((q, i) =>
      i === 0 ? { ...q, status: "resolved" as const } : q,
    ),
  };
  const remaining = value(
    listNeedsYou(answered, human, clock, { section: "decisions" }),
  ).data;
  expect(remaining.decisions.map((q) => q.id)).toEqual([id("decision", 902)]);
  expect(
    value(listNeedsYouCounts(answered, human, clock)).data.tabs.decisions.count,
  ).toBe(1);
  expect(state.decisions.every((q) => q.status === "open")).toBe(true);
});

test("C-499: provider failure, pause and recovery leave human counts unchanged", () => {
  const state = { ...fixture(), decisions: [decision(901)] };
  const baseline = value(listNeedsYouCounts(state, human)).data;
  const events: Event[] = [];
  const io = ports();
  for (const [type, payload, incidents] of [
    [
      "provider_start_failed",
      { failures: 1, cooldown_ms: 1000 },
      [{ profile: "relay", paused: false }],
    ],
    [
      "provider_start_failed",
      { failures: 2, cooldown_ms: 1000, retry_at: now },
      [{ profile: "relay", paused: true }],
    ],
    ["provider_start_restored", {}, []],
  ] as const) {
    events.push({
      type,
      seq: events.length + 1,
      id: io.ids.nextEventId(),
      actor: { kind: "system", project_id: state.project_id },
      created_at: now,
      payload: { profile: "relay", ...payload },
    });
    const snapshot = { ...state, events: [...events] };
    expect(
      value(listNeedsYou(snapshot, human, undefined, { section: "actions" }))
        .data.provider_incidents,
    ).toEqual(incidents);
    expect(value(listNeedsYouCounts(snapshot, human)).data).toEqual(baseline);
  }
});
