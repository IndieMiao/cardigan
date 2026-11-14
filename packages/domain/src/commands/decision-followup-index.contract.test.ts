import { expect, test } from "vitest";
import type {
  Assignment,
  Decision,
  Event,
  JsonValue,
  TimelineEntry,
} from "../index.js";
import {
  type CommandState,
  DECISION_FOLLOWUP_DELAY_MS,
  type DecisionId,
  decisionFollowupNeedsHuman,
  decisionFollowupStatus,
  formatTimelineEntryId,
  parseEventId,
  remindDecisionFollowups,
  requesterNotificationRecipient,
} from "../index.js";
import {
  assignment,
  fixture,
  human,
  id,
  ports,
  value,
} from "./test-fixtures.js";

/*
 * C-244: the reminder pass now reads per-snapshot indexes and the host may
 * limit it to some decisions. The pre-C-244 implementation is kept here
 * verbatim as the reference; random histories must give identical answers.
 */
const field = (e: Event, key: string) =>
  typeof e.payload === "object" && e.payload !== null && key in e.payload
    ? (e.payload as Record<string, unknown>)[key]
    : undefined;
const progressTypes = new Set([
  "card_updated",
  "card_superseded",
  "card_marked_done",
  "card_merged",
  "work_item_created",
  "work_item_updated",
  "work_item_assigned",
  "instruction_issued",
  "delivery_submitted",
  "review_submitted",
  "human_action_completed",
]);
function referenceRecorded(state: CommandState, q: Decision) {
  const resolutions = state.events.filter(
    (e) => e.type === "decision_resolved" && field(e, "decision_id") === q.id,
  );
  const after = (e: Event) =>
    e.created_at > (q.resolution?.at ?? "") ||
    (e.created_at === q.resolution?.at &&
      resolutions.some((r) => r.card_id === e.card_id && e.seq > r.seq));
  const cards = new Set([
    ...q.affected_cards,
    ...(q.card_id ? [q.card_id] : []),
  ]);
  const changed = state.events.some(
    (e) =>
      after(e) &&
      progressTypes.has(e.type) &&
      !!e.card_id &&
      cards.has(e.card_id) &&
      (!q.affected_work_items.length ||
        !field(e, "work_item_id") ||
        q.affected_work_items.some((id) => id === field(e, "work_item_id"))),
  );
  const recorded = state.timeline.some(
    (entry) =>
      entry.created_at >= (q.resolution?.at ?? "") &&
      entry.type === "comment" &&
      (entry.author === q.raised_by ||
        entry.author === "human" ||
        state.assignments.some(
          (a) =>
            `assignment:${a.id}` === entry.author &&
            a.scope === "standing" &&
            a.role_id === "pm" &&
            a.standing_mode === "ops",
        )) &&
      entry.refs.some((ref) => ref.kind === "decision" && ref.id === q.id) &&
      state.events.some(
        (e) =>
          e.card_id === entry.card_id && e.seq === entry.event_seq && after(e),
      ),
  );
  return changed || recorded;
}
const referenceReminded = (state: CommandState, q: Decision) =>
  state.events.some(
    (e) =>
      e.type === "decision_followup_due" &&
      field(e, "decision_id") === q.id &&
      field(e, "resolved_at") === q.resolution?.at,
  );
function referenceDue(state: CommandState, now: string): string[] {
  return state.decisions
    .filter(
      (q) =>
        q.status === "resolved" &&
        !!q.resolution &&
        q.raised_by.startsWith("assignment:") &&
        !(
          Date.parse(now) - Date.parse(q.resolution.at) <
          DECISION_FOLLOWUP_DELAY_MS
        ) &&
        !referenceReminded(state, q) &&
        !referenceRecorded(state, q),
    )
    .map((q) => q.id);
}
function referenceNeedsHuman(state: CommandState, q: Decision) {
  if (
    q.status !== "resolved" ||
    !q.resolution ||
    !q.raised_by.startsWith("assignment:")
  )
    return false;
  if (
    q.card_id &&
    state.cards.some(
      (c) => c.id === q.card_id && ["done", "cancelled"].includes(c.status),
    )
  )
    return false;
  const recipient = requesterNotificationRecipient(
    q.raised_by,
    state.assignments,
  );
  const fallback = requesterNotificationRecipient(
    q.raised_by,
    state.assignments,
    { skip_requester: true },
  );
  return (
    (recipient?.kind === "needs_you" ||
      (referenceReminded(state, q) && fallback?.kind === "needs_you")) &&
    !referenceRecorded(state, q)
  );
}

/** mulberry32: an LCG's low bits cycle too fast for small `% n` choices. */
function rng(seed: number) {
  let s = seed >>> 0;
  return (n: number) => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
}

const base = Date.parse("2026-01-01T00:00:00.000Z");
const at = (minutes: number) => new Date(base + minutes * 60_000).toISOString();
const TYPES = [
  "decision_resolved",
  "decision_followup_due",
  "card_updated",
  "work_item_updated",
  "delivery_submitted",
  "review_submitted",
  "comment_posted",
  "run_started",
];

const QUIET = TYPES.filter(
  (t) => t.startsWith("decision_") || t === "comment_posted",
);

function randomState(seed: number): { state: CommandState; now: string } {
  const pick = rng(seed);
  const f = fixture();
  const cards = [id("card", 1), id("card", 2), id("card", 3)];
  const items = [id("work_item", 1), id("work_item", 2), id("work_item", 3)];
  const { work_item_id: _w, ...pmBase } = assignment(7, "pm");
  const ops: Assignment = {
    ...pmBase,
    scope: "standing",
    standing_mode: pick(3) === 0 ? "office" : "ops",
    status: pick(4) === 0 ? "released" : "active",
  };
  const assignments: Assignment[] = [
    ...f.assignments.map((a) =>
      pick(4) === 0 ? { ...a, status: "released" as const } : a,
    ),
    ...(pick(5) === 0 ? [] : [ops]),
  ];
  const authors = [
    "human",
    `assignment:${id("assignment", 1)}`,
    `assignment:${id("assignment", 2)}`,
    `assignment:${ops.id}`,
    "system",
  ] as const;
  const times = [-20, -5, 0, 0, 0, 5, 40, 90];
  const decisions: Decision[] = [];
  for (let n = 1, count = 1 + pick(5); n <= count; n++) {
    const resolvedAt = at(times[pick(times.length)] ?? 0);
    const status = (
      ["resolved", "resolved", "resolved", "open", "revoked"] as const
    )[pick(5)];
    decisions.push({
      id: id("decision", n),
      key: id("decision", n),
      kind: "choose",
      ...(pick(4) === 0 ? {} : { card_id: cards[pick(3)] }),
      raised_by: authors[pick(authors.length)] ?? "human",
      question: "q",
      context: "c",
      options: [{ key: "go", description: "go", impact: "impact" }],
      recommended: "go",
      affected_cards: pick(2) ? [] : [cards[pick(3)] ?? cards[0]],
      affected_work_items: pick(2) ? [] : [items[pick(3)] ?? items[0]],
      blocking: false,
      decider: "human",
      doc_refs: [],
      status: status ?? "resolved",
      ...(status === "open" || pick(8) === 0
        ? {}
        : {
            resolution: {
              option: "go",
              rationale: "r",
              resolved_by: "human",
              via: "needs_you",
              raw_quote: "go",
              via_chain: [],
              at: resolvedAt,
            },
          }),
    } as Decision);
  }
  const events: Event[] = [];
  const timeline: TimelineEntry[] = [];
  const seqs = new Map<string, number>();
  // Quiet histories carry no progress events, so comment evidence decides.
  const types = pick(3) === 0 ? QUIET : TYPES;
  for (let n = 1, count = pick(40); n <= count; n++) {
    const card = pick(5) === 0 ? undefined : cards[pick(3)];
    const key = card ?? "";
    // Repeated (card, seq) pairs exercise the "some event" lookups.
    const seq =
      pick(8) === 0 ? 1 + pick(seqs.get(key) ?? 1) : (seqs.get(key) ?? 0) + 1;
    seqs.set(key, Math.max(seq, seqs.get(key) ?? 0));
    const type = types[pick(types.length)] ?? "comment_posted";
    const decision = decisions[pick(decisions.length + 1)];
    const payload: Record<string, JsonValue> = {};
    if (decision && pick(5)) payload.decision_id = decision.id;
    if (type === "decision_followup_due")
      payload.resolved_at =
        pick(3) === 0 ? at(-999) : (decision?.resolution?.at ?? at(0));
    if (pick(2)) payload.work_item_id = items[pick(3)] ?? "W-1";
    const event: Event = {
      id: value(parseEventId(String(n).padStart(26, "0"))),
      ...(card ? { card_id: card } : {}),
      seq,
      type,
      actor: human,
      payload,
      created_at: at(times[pick(times.length)] ?? 0),
    };
    events.push(event);
    if (card && pick(2)) {
      const ref = decisions[pick(decisions.length + 1)];
      timeline.push({
        id: value(formatTimelineEntryId(card, n)),
        short_id: value(formatTimelineEntryId(card, n)),
        card_id: card,
        event_seq: pick(6) === 0 ? 1 + pick(seq + 1) : seq,
        type: pick(4) === 0 ? "system" : "comment",
        author: authors[pick(authors.length)] ?? "human",
        body: "b",
        refs: ref
          ? [
              ...(pick(3) === 0 ? [{ kind: "card" as const, id: card }] : []),
              { kind: "decision" as const, id: ref.id },
              ...(pick(4) === 0
                ? [{ kind: "decision" as const, id: ref.id }]
                : []),
            ]
          : [],
        mentions: [],
        retracted: false,
        created_at: at(times[pick(times.length)] ?? 0),
      } as unknown as TimelineEntry);
    }
  }
  return {
    state: {
      ...f,
      cards: f.cards.map((c) =>
        pick(4) === 0 ? { ...c, status: "done" as const } : c,
      ),
      assignments,
      decisions,
      events,
      timeline,
    },
    now: at([10, 29, 30, 31, 45, 200][pick(6)] ?? 31),
  };
}

const system = { kind: "system" as const, project_id: human.project_id };
const portsAt = (now: string) => ({ ...ports(), clock: { now: () => now } });
const reminded = (state: CommandState, now: string, ids?: Set<string>) =>
  value(
    remindDecisionFollowups(
      state,
      system,
      portsAt(now),
      ids ? { decision_ids: ids as never } : {},
    ),
  ).data;

test("C-244: indexed reminders, status and needs-you match the linear reference", () => {
  const seen = new Map<string, number>();
  for (let seed = 1; seed <= 4000; seed++) {
    const { state, now } = randomState(seed);
    const due = referenceDue(state, now);
    expect(reminded(state, now), `seed ${seed}`).toEqual(due);
    const subset = new Set(
      state.decisions.filter((_, i) => (seed + i) % 2 === 0).map((q) => q.id),
    );
    expect(reminded(state, now, subset)).toEqual(
      due.filter((q) => subset.has(q as DecisionId)),
    );
    for (const q of state.decisions) {
      const status = decisionFollowupStatus(state, q, now);
      seen.set(status.kind, (seen.get(status.kind) ?? 0) + 1);
      expect(status.kind === "due", `seed ${seed} ${q.id}`).toBe(
        due.includes(q.id),
      );
      const eligible =
        q.status === "resolved" &&
        !!q.resolution &&
        q.raised_by.startsWith("assignment:");
      expect(status.kind === "ineligible").toBe(!eligible);
      if (status.kind === "waiting") {
        expect(Date.parse(now)).toBeLessThan(status.due_at);
        expect(status.due_at).toBe(
          Date.parse(q.resolution?.at ?? "") + DECISION_FOLLOWUP_DELAY_MS,
        );
      }
      if (status.kind === "reminded")
        expect(referenceReminded(state, q)).toBe(true);
      if (status.kind === "recorded") {
        expect(referenceReminded(state, q)).toBe(false);
        expect(referenceRecorded(state, q)).toBe(true);
        // Durable evidence survives any Assignment change; PM Ops evidence
        // disappears without the Assignment it depends on.
        const without = { ...state, assignments: [] };
        expect(referenceRecorded(without, q)).toBe(status.durable);
        if (status.durable) seen.set("durable", (seen.get("durable") ?? 0) + 1);
      }
      expect(decisionFollowupNeedsHuman(state, q), `seed ${seed}`).toBe(
        referenceNeedsHuman(state, q),
      );
    }
  }
  // Every branch is exercised by the random histories.
  for (const kind of [
    "ineligible",
    "waiting",
    "reminded",
    "recorded",
    "due",
    "durable",
  ])
    expect(seen.get(kind) ?? 0, kind).toBeGreaterThan(30);
  expect(
    (seen.get("recorded") ?? 0) - (seen.get("durable") ?? 0),
  ).toBeGreaterThan(5);
});

test("C-244: a new snapshot rebuilds the index; the old snapshot keeps its answer", () => {
  const { state } = randomState(7);
  const q: Decision = {
    ...(state.decisions[0] as Decision),
    status: "resolved",
    raised_by: `assignment:${id("assignment", 1)}`,
    card_id: id("card", 1),
    affected_cards: [],
    affected_work_items: [],
    resolution: {
      option: "go",
      rationale: "r",
      resolved_by: "human",
      via: "needs_you",
      raw_quote: "go",
      via_chain: [],
      at: at(0),
    },
  };
  const before: CommandState = {
    ...state,
    decisions: [q],
    events: [],
    timeline: [],
  };
  const now = at(31);
  expect(decisionFollowupStatus(before, q, now).kind).toBe("due");
  const progressed: CommandState = {
    ...before,
    events: [
      {
        id: value(parseEventId("7".repeat(26))),
        card_id: id("card", 1),
        seq: 1,
        type: "work_item_updated",
        actor: human,
        payload: {},
        created_at: at(1),
      },
    ],
  };
  expect(decisionFollowupStatus(progressed, q, now)).toEqual({
    kind: "recorded",
    durable: true,
  });
  expect(decisionFollowupStatus(before, q, now).kind).toBe("due");
  const effect = value(remindDecisionFollowups(before, system, portsAt(now)));
  const after = { ...before, events: [...before.events, ...effect.events] };
  expect(decisionFollowupStatus(after, q, now).kind).toBe("reminded");
  expect(decisionFollowupStatus(before, q, now).kind).toBe("due");
});
