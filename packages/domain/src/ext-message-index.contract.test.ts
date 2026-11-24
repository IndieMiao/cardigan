import { expect, test } from "vitest";
import { type CommandState, command } from "./commands/core.js";
import { notices } from "./commands/notices.js";
import { selectNeedsYouDecisions } from "./commands/queries.js";
import { fixture, id, value } from "./commands/test-fixtures.js";
import type {
  Decision,
  Event,
  HumanAction,
  JsonValue,
  ReadyCondition,
} from "./entities.js";
import { EventLog, EventLogView } from "./event-log.js";
import { type ExtMessageItem, extMessageItems } from "./ext-message.js";
import type { CardId, ProjectId } from "./ids.js";
import { parseEventId } from "./index.js";
import { NEEDS_YOU_ITEM_READY, needsYouItemReady } from "./readiness.js";

/*
 * C-653 oracle: the projection exactly as it was before keyed lookups, with
 * its two whole-history passes (id -> time map, then a payload field scan).
 * Only the name changed; it stays frozen so equality proves no drift.
 */
function sameGate(gate: ReadyCondition | undefined, recorded: unknown) {
  if (
    !gate ||
    !recorded ||
    typeof recorded !== "object" ||
    !("kind" in recorded) ||
    recorded.kind !== gate.kind
  )
    return false;
  if (gate.kind === "manual") return true;
  return (
    "card_id" in recorded &&
    recorded.card_id === gate.card_id &&
    (gate.kind !== "card_delivery" ||
      ("after" in recorded ? recorded.after : undefined) === gate.after)
  );
}

function legacyExtMessageItems(
  state: CommandState,
  project: ProjectId,
): ExtMessageItem[] {
  const result = command(
    state,
    { kind: "human", project_id: project },
    "list_needs_you",
    undefined,
    (d) => {
      d.pm();
      d.projectAccess();
      return new Set(selectNeedsYouDecisions(d).map((q) => q.id));
    },
  );
  if (!result.ok) return [];
  const visible = result.value.data;
  const cards = new Map(state.cards.map((c) => [c.id, c]));
  const work = new Map(state.work_items.map((w) => [w.id, w.card_id]));
  const decisions = new Map(state.decisions.map((q) => [q.id, q]));
  const sensitive = (ids: readonly (CardId | undefined)[]) =>
    ids.some(
      (id) => !id || !cards.has(id) || cards.get(id)?.sensitive === true,
    );
  // Preserve first-match stream order, including legacy events with both references.
  const history = new Map<
    string,
    { source: Event; times: Set<string>; datedRelease: boolean }
  >();
  const gates = new Map<string, ReadyCondition | undefined>(
    [...state.decisions, ...state.human_actions].map((item) => [
      item.id,
      item.ready_when,
    ]),
  );
  const eventTimes = new Map<string, string>(
    state.events.map((e) => [e.id, e.created_at]),
  );
  // A handoff or reissue never erases an earlier quiet touch. The readiness
  // notification and the source change it references can straddle quiet hours.
  for (const e of state.events) {
    const p = e.payload;
    if (!p || typeof p !== "object") continue;
    const trigger =
      "source_event_id" in p && typeof p.source_event_id === "string"
        ? eventTimes.get(p.source_event_id)
        : undefined;
    for (const id of [
      "decision_id" in p && p.decision_id,
      "human_action_id" in p && p.human_action_id,
    ]) {
      if (typeof id !== "string") continue;
      const entry = history.get(id) ?? {
        source: e,
        times: new Set<string>(),
        datedRelease: false,
      };
      entry.times.add(e.created_at);
      if (trigger) {
        entry.times.add(trigger);
        if (
          e.type === NEEDS_YOU_ITEM_READY &&
          "condition" in p &&
          sameGate(gates.get(id), p.condition)
        )
          entry.datedRelease = true;
      }
      history.set(id, entry);
    }
  }
  const out: ExtMessageItem[] = [];
  for (const q of state.decisions) {
    if (q.decider !== "human") continue;
    const facts = history.get(q.id);
    if (!facts) continue;
    const { source: event, times, datedRelease } = facts;
    const ready = needsYouItemReady(state, q);
    const related = [
      ...q.affected_cards,
      ...(q.card_id ? [q.card_id] : []),
      ...q.affected_work_items.map((id) => work.get(id)),
    ];
    out.push({
      project_id: project,
      ...(q.card_id ? { card_id: q.card_id } : {}),
      event_id: event.id,
      created_at: event.created_at,
      activity_at: [...times],
      ...(ready && q.ready_when && !datedRelease
        ? { undated_ready: true as const }
        : {}),
      item_id: q.id,
      kind:
        q.trigger === "merge_confirmation" ? "merge_confirmation" : "decision",
      title: q.question,
      sensitive: sensitive(related),
      ready,
      handled:
        !visible.has(q.id) &&
        (ready || !["open", "provisional", "snoozed"].includes(q.status)),
    });
  }
  for (const h of state.human_actions) {
    if (h.triage === "pm_ops") continue;
    const facts = history.get(h.id);
    if (!facts) continue;
    const { source: event, times, datedRelease } = facts;
    if (h.ready_released) times.add(h.ready_released.at);
    if (h.handoff) times.add(h.handoff.rewritten_at);
    const ready = needsYouItemReady(state, h);
    out.push({
      project_id: project,
      ...(h.card_id ? { card_id: h.card_id } : {}),
      event_id: event.id,
      created_at: event.created_at,
      activity_at: [...times],
      ...(ready && h.ready_when && !h.ready_released && !datedRelease
        ? { undated_ready: true as const }
        : {}),
      item_id: h.id,
      kind: "human_action",
      ...(h.handoff?.title ? { title: h.handoff.title } : {}),
      sensitive: sensitive([
        ...(h.card_id ? [h.card_id] : []),
        ...h.blocked_work_items.map((id) => work.get(id)),
      ]),
      ready,
      handled: h.status !== "open",
    });
  }
  for (const n of notices(state)) {
    // A failed external delivery is a Workbench-only notice. Never recurse.
    if (n.kind === "external_message") continue;
    const decision = n.decision_id ? decisions.get(n.decision_id) : undefined;
    out.push({
      project_id: project,
      ...(n.card_id ? { card_id: n.card_id } : {}),
      event_id: n.id,
      created_at: n.at,
      item_id: n.id,
      kind: "notice",
      title: n.question,
      ...(n.decision_id ? { anchor: `decision-${n.decision_id}` } : {}),
      sensitive: sensitive([
        ...(n.card_id ? [n.card_id] : []),
        ...(decision?.affected_cards ?? []),
        ...(decision?.affected_work_items.map((id) => work.get(id)) ?? []),
      ]),
      ready: true,
      handled: n.read,
    });
  }
  return out;
}

const eventId = (n: number) =>
  value(parseEventId(n.toString().padStart(26, "0")));
const streams = ["", "C-1", "C-2"] as const;
const times = [
  "2026-01-01T00:00:00.000Z",
  "2026-01-01T00:01:00.000Z",
  "2026-01-01T23:30:00.000Z",
  "",
];

function rng(seed: number) {
  let s = seed >>> 0;
  return (n: number) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    // High bits: the low bits of an LCG repeat with a tiny period.
    return Math.floor((s / 2 ** 32) * n);
  };
}

/** Decisions, human actions and events in commit order (seq ascends per stream). */
function randomState(seed: number, noise = 0) {
  const pick = rng(seed);
  const one = <T>(xs: readonly T[]) => xs[pick(xs.length)] as T;
  const base = fixture();
  const gates: (ReadyCondition | undefined)[] = [
    undefined,
    { kind: "manual" },
    { kind: "card_merged", card_id: id("card", 2) },
    { kind: "card_delivery", card_id: id("card", 1), after: id("delivery", 1) },
  ];
  const decisions: Decision[] = Array.from({ length: 6 }, (_, i) => {
    const ready_when = one(gates);
    return {
      id: id("decision", i + 1),
      key: id("decision", i + 1),
      kind: "choose",
      ...(pick(4) ? { card_id: id("card", 1 + pick(2)) } : {}),
      question: `Q${i}`,
      context: "",
      category: "general",
      raised_by: "human",
      options: [],
      recommended: "",
      affected_cards: pick(3) ? [] : [id("card", 2)],
      affected_work_items: pick(3) ? [] : [id("work_item", 1)],
      blocking: false,
      decider: one(["human", "human", "system", "role:pm"] as const),
      doc_refs: [],
      status: one(["open", "snoozed", "resolved"] as const),
      ...(pick(3) ? {} : { trigger: "merge_confirmation" as const }),
      ...(ready_when ? { ready_when } : {}),
    };
  });
  const human_actions: HumanAction[] = Array.from({ length: 5 }, (_, i) => {
    const ready_when = one(gates);
    return {
      id: id("human_action", i + 1),
      key: id("human_action", i + 1),
      ...(pick(4) ? { card_id: id("card", 1 + pick(2)) } : {}),
      category: "general",
      requested_by: "human",
      instructions: "",
      why_human: "",
      expected_return: "",
      blocked_work_items: pick(2) ? [] : [id("work_item", 2)],
      status: pick(3) ? "open" : "done",
      ...(pick(4) ? {} : { triage: "pm_ops" as const }),
      ...(ready_when ? { ready_when } : {}),
      ...(pick(3)
        ? {}
        : {
            ready_released: {
              by: "human" as const,
              reason: "fixture",
              at: one(times.slice(0, 3)),
            },
          }),
      ...(pick(3)
        ? {}
        : {
            handoff: {
              title: `H${i}`,
              summary: "",
              instructions: "",
              why_human: "",
              expected_outcome: "",
              expected_return: "",
              rewritten_by: "human" as const,
              rewritten_at: one(times.slice(0, 3)),
            },
          }),
    };
  });
  const seqs = new Map<string, number>();
  const events: Event[] = [];
  const total = pick(40) + noise;
  for (let n = 1; n <= total; n++) {
    const q = `Q-${1 + pick(7)}`;
    const h = `H-${1 + pick(6)}`;
    const source = pick(4) ? eventId(1 + pick(n + 2)) : "missing";
    const condition = one(gates) ?? { kind: "other" };
    const payloads: [string, JsonValue][] =
      n > total - noise
        ? [["comment_posted", { body: "noise" }]]
        : [
            ["decision_requested", { decision_id: q }],
            ["human_action_requested", { human_action_id: h }],
            ["decision_requested", { decision_id: q, human_action_id: h }],
            [
              NEEDS_YOU_ITEM_READY,
              { human_action_id: h, condition, source_event_id: source },
            ],
            [
              NEEDS_YOU_ITEM_READY,
              { decision_id: q, condition, source_event_id: source },
            ],
            ["decision_rerouted", { decision_id: q, source_event_id: source }],
            ["card_merged", { card_id: "C-2" }],
            ["legacy", { decision_id: 3, human_action_id: null }],
            ["legacy", null],
          ];
    const [type, payload] = one(payloads);
    const stream = one(streams);
    const seq = (seqs.get(stream) ?? 0) + 1;
    seqs.set(stream, seq);
    events.push({
      id: eventId(n),
      seq,
      ...(stream ? { card_id: stream as CardId } : {}),
      type,
      payload,
      actor: { kind: "system", project_id: base.project_id },
      created_at: one(times),
    });
  }
  const cards = base.cards.map((c) =>
    c.id === "C-2"
      ? { ...c, status: "done" as const, sensitive: pick(2) === 0 }
      : c,
  );
  return { base: { ...base, cards, decisions, human_actions }, events };
}

/** Store-shaped history: one log, the project stream then card streams. */
function indexed(events: readonly Event[]) {
  const log = new EventLog();
  for (const e of events) log.append(e);
  return new EventLogView(log, log.end).history([...streams]);
}

test("C-653: keyed projection equals the pre-change full scan for plain and Store histories", () => {
  const seen = { items: 0, touches: 0, dated: 0, undated: 0 };
  for (let seed = 1; seed <= 300; seed++) {
    const { base, events } = randomState(seed);
    const gated = new Set(
      [...base.decisions, ...base.human_actions]
        .filter((x) => x.ready_when && !("ready_released" in x))
        .map((x) => x.id as string),
    );
    for (const history of [events, indexed(events)]) {
      const state = { ...base, events: history };
      const expected = legacyExtMessageItems(state, state.project_id);
      expect(extMessageItems(state, state.project_id)).toEqual(expected);
      for (const i of expected) {
        if (i.kind === "notice") continue;
        seen.items++;
        if ((i.activity_at?.length ?? 0) > 2) seen.touches++;
        if (i.ready && gated.has(i.item_id))
          seen[i.undated_ready ? "undated" : "dated"]++;
      }
    }
  }
  // The generator exercises repeated touches and both release outcomes.
  for (const count of Object.values(seen)) expect(count).toBeGreaterThan(20);
});

/** Visits to every history slot while `run` reads a fresh Store-shaped state. */
function historyVisits(
  seed: number,
  run: (state: CommandState, project: ProjectId) => unknown,
) {
  const { base, events } = randomState(seed, 400);
  const history = indexed(events);
  let visits = 0;
  for (const [i, event] of [...history].entries())
    Object.defineProperty(history, i, {
      get: () => {
        visits++;
        return event;
      },
    });
  run({ ...base, events: history }, base.project_id);
  return { visits, length: history.length };
}

test("C-653: on a Store history the projection reads events only through keyed lookups", () => {
  // Everything else the projection consults scans as before (另卡).
  const dependencies = (state: CommandState, project: ProjectId) => {
    command(
      state,
      { kind: "human", project_id: project },
      "list_needs_you",
      undefined,
      (d) => {
        d.pm();
        d.projectAccess();
        return selectNeedsYouDecisions(d);
      },
    );
    for (const item of [...state.decisions, ...state.human_actions])
      needsYouItemReady(state, item);
    notices(state);
  };
  for (let seed = 1; seed <= 20; seed++) {
    const own = historyVisits(seed, extMessageItems);
    const rest = historyVisits(seed, dependencies);
    expect(own.visits).toBe(rest.visits);
    // The pre-change projection read every event twice more.
    expect(historyVisits(seed, legacyExtMessageItems).visits).toBe(
      rest.visits + 2 * own.length,
    );
  }
});

test("C-653: items keep the first naming event as source and every touch time", () => {
  const { base } = randomState(1);
  const [first] = base.decisions as [Decision];
  const decision = { ...first, decider: "human" as const };
  const at = (n: number) => `2026-01-01T00:0${n}:00.000Z`;
  const event = (n: number, payload: JsonValue, card?: string): Event => ({
    id: eventId(n),
    seq: n,
    ...(card ? { card_id: card as CardId } : {}),
    type: "decision_requested",
    payload,
    actor: { kind: "system", project_id: base.project_id },
    created_at: at(n),
  });
  // Card stream events come after the project stream in history order.
  const events = [
    event(1, { decision_id: decision.id }, "C-1"),
    event(2, { decision_id: decision.id, source_event_id: eventId(3) }),
    event(3, {}),
  ];
  for (const history of [events, indexed(events)]) {
    const [item] = extMessageItems(
      { ...base, decisions: [decision], human_actions: [], events: history },
      base.project_id,
    ) as [ExtMessageItem];
    expect(item).toMatchObject({
      item_id: decision.id,
      event_id: history === events ? eventId(1) : eventId(2),
    });
    expect([...(item.activity_at ?? [])].sort()).toEqual([at(1), at(2), at(3)]);
  }
});
