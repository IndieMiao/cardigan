import { expect, test } from "vitest";
import { referenceReadState } from "./card-read.js";
import type { CommandState } from "./commands/core.js";
import { decisionHistory } from "./commands/decision-followup.js";
import { dispatchRecoveryUsed } from "./commands/dispatch-recovery.js";
import { hostOpsExitConfirmation } from "./commands/host-ops-actions.js";
import { mergeFixture } from "./commands/merge/test-fixtures.js";
import { beginMergePush } from "./commands/merge-push.js";
import { recordMergeResult } from "./commands/merge-result.js";
import { mergeShadowComparisons } from "./commands/merge-shadow.js";
import { notices } from "./commands/notices.js";
import { stoppedByHuman } from "./commands/stop-state.js";
import { suggestionProgressEvents } from "./commands/suggestion-progress.js";
import {
  assignment,
  card,
  fixture,
  id,
  now,
  ports,
  run,
  value,
} from "./commands/test-fixtures.js";
import { resumeWorkWaits } from "./commands/work-waits.js";
import type {
  Card,
  Decision,
  Event,
  HumanAction,
  JsonValue,
  TimelineEntry,
  WorkItem,
} from "./entities.js";
import { commandStreamHistory, fullEventHistory } from "./event-index.js";
import { EventLog, EventLogView } from "./event-log.js";
import { pendingHostOpsActions } from "./host-ops.js";
import {
  hotCardIds,
  LEAN_COLD_CARD_OMITTED_EVENT_TYPES,
  SLIM_COLD_CARD_EVENT_TYPES,
  SLIM_RESIDENT_EVENT_TYPES,
  slimCommandEvents,
} from "./hot-history.js";
import { compareHotState } from "./hot-history-shadow.js";
import { type CardId, type EventId, parseEventId } from "./ids.js";
import { remoteWorkerLosses } from "./remote-worker-loss.js";

/**
 * C-671 contract for the `slim` scope: cold cards keep only the whitelisted
 * facts in the command-state array, and every cross-card reader moved to the
 * indexed lookups answers as on the whole history. The evidence each reader
 * needs sits on cold cards and is NOT whitelisted, so a reader that still
 * scanned the array would answer differently (checked below). The same holds
 * with an empty whitelist, and when the Store left those events dormant.
 */
let serial = 0;
const project_id = fixture().project_id;
const system = { kind: "system", project_id } as const;
const humanActor = { kind: "human", project_id } as const;
const later = "2026-01-02T00:00:00.000Z";
const event = (
  type: string,
  card_id: CardId | undefined,
  payload: Record<string, JsonValue> = {},
  extra: Partial<Event> = {},
): Event => ({
  id: value(parseEventId(String(++serial).padStart(26, "0"))),
  seq: ++serial,
  ...(card_id ? { card_id } : {}),
  type,
  actor: system,
  payload,
  created_at: now,
  ...extra,
});
const done = (n: number): Card => ({
  ...card(n),
  status: "done",
  resolution: "done",
});
const telemetry = (c: CardId) =>
  [...LEAN_COLD_CARD_OMITTED_EVENT_TYPES].map((type) => event(type, c));
const [c1, c5, c6, _c7, c8, c9, c10, c11, c12] = [
  1, 5, 6, 7, 8, 9, 10, 11, 12,
].map((n) => id("card", n)) as CardId[] as [
  CardId,
  CardId,
  CardId,
  CardId,
  CardId,
  CardId,
  CardId,
  CardId,
  CardId,
];
const decision = (
  n: number,
  fields: Partial<Decision> & Record<string, unknown>,
): Decision =>
  ({
    id: id("decision", n),
    key: id("decision", n),
    raised_by: `assignment:${id("assignment", 1)}`,
    kind: "choose",
    category: "general",
    question: `Question ${n}`,
    context: "",
    options: [{ key: "a", description: "A", impact: "none" }],
    recommended: "a",
    affected_cards: [],
    affected_work_items: [],
    blocking: false,
    decider: "human",
    status: "resolved",
    resolution: {
      option: "a",
      rationale: "ok",
      resolved_by: "human",
      at: now,
    },
    created_at: now,
    ...fields,
  }) as unknown as Decision;

/**
 * C1 is the only open card. Every other card is closed and referenced by
 * nothing live, so each one is cold; the readers' evidence sits on them.
 */
function scenario() {
  serial = 0;
  const base = fixture();
  const standing = base.assignments.find((a) => a.scope === "standing");
  if (!standing) throw new Error("missing standing assignment");
  // Host-ops: one action finished on a cold trigger card, one still pending
  // whose exit a human confirmed on another cold card.
  const finished = event("host_ops_action_taken", undefined, {
    execution: true,
    assignment_id: standing.id,
  });
  const pending = event("host_ops_action_taken", undefined, {
    execution: true,
    assignment_id: id("assignment", 5),
  });
  const exitAction = {
    id: id("human_action", 2),
    key: id("human_action", 2),
    card_id: c10,
    requested_by: "system",
    instructions: "Confirm the exit",
    why_human: "Only a person can see the terminal",
    expected_return: "Confirmation",
    blocked_work_items: [],
    status: "done",
    created_at: now,
  } as unknown as HumanAction;
  const merged = event("card_merged", c12, {
    completion_id: "D-12",
    result: {
      kind: "merged",
      merge_sha: "b".repeat(40),
      previous_sha: "a".repeat(40),
      tree_sha: "c".repeat(40),
    },
  });
  const restricted = event("merge_check_finished", c5, {
    attempt_id: "batch-attempt",
    completion_id: "D-5",
    batch_id: "B-9",
    level: "batch",
    status: "failed",
    checks: [{ name: "secret detail" }],
  });
  const comment = event(
    "comment_posted",
    c8,
    { body: "progress" },
    { actor: humanActor, created_at: later },
  );
  const events = [
    finished,
    pending,
    event("merge_push_queued", undefined, {
      target: "origin",
      branch: "main",
      sha: "b".repeat(40),
      merge_event_id: merged.id,
    }),
    // C5: a restricted batch check (masks the timeline entry at its seq).
    restricted,
    ...telemetry(c5),
    // C6 merged without the whitelisted fact (a review-only completion).
    event(
      "review_submitted",
      c6,
      { delivery_id: "D-6", verdict: "pass" },
      { actor: humanActor },
    ),
    ...telemetry(c6),
    // C8: a delegated resolution, a superseded resolution, decision progress.
    event(
      "decision_provisionally_resolved",
      c8,
      { decision_id: id("decision", 2), via: "delegated", option: "a" },
      { created_at: later },
    ),
    event(
      "work_item_updated",
      c8,
      { work_item_id: "W-80" },
      {
        created_at: later,
      },
    ),
    comment,
    ...telemetry(c8),
    // C9: a human hold, a system-completed action, a human stop.
    event(
      "card_hold_set",
      c9,
      { notice: "paused" },
      { actor: humanActor, created_at: later },
    ),
    event("human_action_completed", c9, {
      human_action_id: id("human_action", 9),
      result: "done by system",
    }),
    event(
      "assignment_stopped",
      c9,
      { assignment_id: id("assignment", 6), hold: true },
      { actor: humanActor },
    ),
    ...telemetry(c9),
    // C10: host-ops and remote-loss facts of released or standing owners.
    event("host_ops_action_finished", c10, { action_id: finished.id }),
    event("human_action_requested", c10, {
      human_action_id: exitAction.id,
      host_ops_action_id: pending.id,
    }),
    event(
      "human_action_completed",
      c10,
      { human_action_id: exitAction.id, conclusion: "exited" },
      { actor: humanActor },
    ),
    event("run_dispatch_recovered", c10, {
      assignment_id: standing.id,
      reason: "terminal_gone",
      run_id: "R-90",
      replacement_run_id: "R-91",
    }),
    ...telemetry(c10),
    // C11: the precheck a live wait names.
    event("precheck_finished", c11, {
      attempt_id: "pre-1",
      card_id: c11,
      status: "passed",
    }),
    ...telemetry(c11),
    // C12: the merge a queued push names, and its shadow record.
    merged,
    event("system_merge_shadow_recorded", c12, {
      decision_id: id("decision", 3),
    }),
    ...telemetry(c12),
  ];
  const [produce, ...rest] = base.work_items as [WorkItem, ...WorkItem[]];
  const blocked: WorkItem = {
    ...produce,
    status: "blocked",
    reported_blocker: {
      reason: "waiting for the precheck on C11",
      needs: "role",
      reported_by: `assignment:${id("assignment", 1)}`,
      reported_at: now,
      resume_when: { kind: "precheck_finished", target_id: "pre-1" },
    },
  };
  const timeline: TimelineEntry[] = [
    {
      id: `${c5}#1`,
      short_id: `${c5}#1`,
      card_id: c5,
      event_seq: restricted.seq,
      type: "system",
      author: "system",
      refs: [],
      mentions: [],
      retracted: false,
      created_at: now,
      body: "secret batch detail",
    } as unknown as TimelineEntry,
  ];
  const full: CommandState = {
    ...base,
    cards: [
      card(1),
      ...[5, 6, 7, 8, 9, 10, 11, 12].map(done),
      { ...done(7), depends_on_cards: [c6] },
    ].filter((c, i, all) => all.findLastIndex((d) => d.id === c.id) === i),
    work_items: [blocked, ...rest],
    assignments: [
      ...base.assignments,
      { ...assignment(5), status: "released" },
      { ...assignment(6), status: "released" },
    ],
    runs: [{ ...run(1), status: "completed" }],
    decisions: [
      decision(1, { status: "superseded", card_id: c8 }),
      decision(2, {
        card_id: c8,
        affected_cards: [c8],
        decider: "role:pm",
      }),
      decision(4, {
        card_id: c8,
        suggestion: {
          option: "a",
          rationale: "r",
          by: "human",
          at: now,
          basis: "",
          evidence_baseline: { [c8]: 0 },
        },
      }),
    ],
    human_actions: [exitAction],
    timeline,
    events: [
      ...events,
      // The resolution the superseded decision's history needs, on C8.
      event("decision_resolved", c8, { decision_id: id("decision", 1) }),
    ],
  };
  return { full, comment, merged, restricted };
}

/** The whole history as the Store builds it (project stream, then cards). */
function storeHistory(full: CommandState) {
  const log = new EventLog();
  for (const e of fullEventHistory(full.events)) log.append(e);
  const order = ["", ...full.cards.map((c) => c.id)];
  return {
    ...full,
    events: commandStreamHistory(new EventLogView(log, log.end), order),
  };
}

/** The slim history the Store builds when cold rows were left dormant. */
function dormantSlim(full: CommandState) {
  const closed = new Set(
    full.cards.filter((c) => c.status === "done").map((c) => c.id as string),
  );
  const byStream = new Map<string, Event[]>();
  for (const e of fullEventHistory(full.events)) {
    const list = byStream.get(e.card_id ?? "") ?? [];
    list.push(e);
    byStream.set(e.card_id ?? "", list);
  }
  const loads: string[] = [];
  const log = new EventLog();
  log.loader = (stream, seqs) => {
    loads.push(stream);
    return (byStream.get(stream) ?? []).filter((e) => seqs.includes(e.seq));
  };
  const order = ["", ...full.cards.map((c) => c.id)];
  for (const stream of order)
    for (const e of byStream.get(stream) ?? [])
      if (
        e.card_id &&
        closed.has(e.card_id) &&
        !SLIM_RESIDENT_EVENT_TYPES.has(e.type)
      )
        log.appendDormant(e);
      else log.append(e);
  const view = new EventLogView(log, log.end);
  const events = commandStreamHistory(view, order, {
    full: hotCardIds(full),
    omit: LEAN_COLD_CARD_OMITTED_EVENT_TYPES,
    keep: SLIM_COLD_CARD_EVENT_TYPES,
  });
  return { state: { ...full, events }, log, loads };
}

const variants = [
  ["whitelist", (s: CommandState) => slimCommandEvents(s)],
  [
    "empty whitelist",
    (s: CommandState) => slimCommandEvents(s, [], new Set(), new Set()),
  ],
] as const;

test.each(variants)(
  "%s: cold cards keep only whitelisted facts in the array",
  (_name, define) => {
    const { full } = scenario();
    expect([...hotCardIds(full)]).toEqual([c1]);
    const array = fullEventHistory(define(full));
    for (const e of array)
      if (e.card_id && e.card_id !== c1)
        expect(SLIM_COLD_CARD_EVENT_TYPES.has(e.type)).toBe(true);
    // The readers' evidence is absent from the array: a scan would miss it.
    for (const type of [
      "merge_check_finished",
      "review_submitted",
      "decision_provisionally_resolved",
      "card_hold_set",
      "assignment_stopped",
      "precheck_finished",
      "run_dispatch_recovered",
      "system_merge_shadow_recorded",
      "comment_posted",
    ])
      expect(array.some((e) => e.type === type)).toBe(false);
  },
);

test.each(variants)(
  "%s: every shadow rule and projection answers as on the whole history",
  (_name, define) => {
    const { full } = scenario();
    const whole = storeHistory(full);
    const slim = { ...full, events: define(full) };
    const checks = compareHotState(whole, slim, { now: later });
    expect(checks.filter((c) => !c.equal)).toEqual([]);
    expect(checks.length).toBeGreaterThanOrEqual(32);
  },
);

test.each(variants)(
  "%s: the migrated readers see the cold evidence",
  (_name, define) => {
    const { full, comment } = scenario();
    const whole = storeHistory(full);
    const slim = { ...full, events: define(full) };
    for (const s of [whole, slim]) {
      // Decision history keeps the superseded decision that was really resolved.
      expect(decisionHistory(s).map((q) => q.id)).toContain(id("decision", 1));
      // Notices: the delegated resolution, the human hold, the system completion.
      expect(notices(s).map((n) => n.question)).toEqual(
        expect.arrayContaining(["卡片暂停"]),
      );
      expect(notices(s).length).toBe(notices(whole).length);
      // Host ops: the finish on C10 settles its action; the other stays pending.
      expect(
        pendingHostOpsActions(s.events).map((a) => a.assignment_id),
      ).toEqual([id("assignment", 5)]);
      const pending = pendingHostOpsActions(s.events)[0];
      if (!pending) throw new Error("missing pending action");
      expect(hostOpsExitConfirmation(s, pending.action_id).status).toBe(
        hostOpsExitConfirmation(whole, pending.action_id).status,
      );
      expect(stoppedByHuman(s.events, id("assignment", 6))).toBe(true);
      const standing = s.assignments.find((a) => a.scope === "standing");
      expect(dispatchRecoveryUsed(s.events, standing?.id ?? "")).toBe(true);
      expect(mergeShadowComparisons(s, c12)).toHaveLength(1);
      expect(remoteWorkerLosses(s.events)).toEqual(
        remoteWorkerLosses(whole.events),
      );
      const q4 = s.decisions.find((q) => q.id === id("decision", 4));
      if (!q4) throw new Error("missing decision");
      expect(suggestionProgressEvents(s, q4).map((e) => e.id)).toEqual([
        comment.id,
      ]);
      // The restricted batch check on C5 still masks its timeline entry.
      const reader = s.assignments[0];
      if (!reader) throw new Error("missing reader");
      expect(
        referenceReadState(s, reader).timeline.map((t) => t.body),
      ).not.toContain("secret batch detail");
      // The precheck wait on C11 resumes.
      const resumed = value(resumeWorkWaits(s, system, {}, ports()));
      expect(resumed.events.length).toBeGreaterThan(0);
    }
  },
);

test("the Store's dormant rows answer the same, and only asked-for rows decode", () => {
  const { full } = scenario();
  const whole = storeHistory(full);
  const { state, log, loads } = dormantSlim(full);
  const before = log.dormant;
  expect(before).toBeGreaterThan(0);
  // Building the array decodes nothing.
  expect(loads).toEqual([]);
  const checks = compareHotState(whole, state, { now: later });
  expect(checks.filter((c) => !c.equal)).toEqual([]);
  // The readers decoded some cold facts, but never the cold telemetry.
  expect(log.dormant).toBeLessThan(before);
  const remaining = log.dormantTypes();
  for (const type of LEAN_COLD_CARD_OMITTED_EVENT_TYPES)
    if (!SLIM_RESIDENT_EVENT_TYPES.has(type))
      expect(remaining.get(type) ?? 0).toBeGreaterThan(0);
  expect(state.events.length).toBe(slimCommandEvents(full).length);
  expect(fullEventHistory(state.events).map((e) => e.id)).toEqual(
    fullEventHistory(slimCommandEvents(full)).map((e) => e.id),
  );
});

test("whitelisted and resident types are consistent", () => {
  for (const type of SLIM_COLD_CARD_EVENT_TYPES) {
    expect(SLIM_RESIDENT_EVENT_TYPES.has(type)).toBe(true);
    expect(LEAN_COLD_CARD_OMITTED_EVENT_TYPES.has(type)).toBe(false);
  }
  // Run ids appear only as trigger ids here; no unfinished run makes a card hot.
  const { full } = scenario();
  expect(full.runs.every((r) => r.status === "completed")).toBe(true);
  expect((full.runs[0]?.trigger_event_id ?? "") as EventId).toBeTruthy();
});

test("a queued push still finds its merge on a cold card (by event id)", async () => {
  const f = mergeFixture("auto", 3);
  f.io.clock = { now: () => "2035-01-01T00:00:00.000Z" };
  const { completion } = await f.accept();
  const destination = { target: "f".repeat(64), branch: "main" };
  const settings = {
    merge_push: [{ ...destination, base_branch: "main" }],
  };
  f.commit(
    recordMergeResult(
      { ...f.state, project_settings: settings },
      system,
      {
        card_id: f.card.id,
        completion_id: completion.id,
        result: {
          kind: "merged",
          merge_sha: "b".repeat(40),
          previous_sha: "a".repeat(40),
        },
      },
      f.io,
    ),
  );
  // Nothing live references the merged card any more: it is cold.
  const full: CommandState = {
    ...f.state,
    project_settings: settings,
    assignments: f.state.assignments.map((a) => ({
      ...a,
      status: "released" as const,
    })),
    runs: f.state.runs.map((r) => ({ ...r, status: "completed" as const })),
  };
  expect(hotCardIds(full).has(f.card.id)).toBe(false);
  const slim = {
    ...full,
    events: slimCommandEvents(full, [], new Set(), new Set()),
  };
  expect(
    fullEventHistory(slim.events).some((e) => e.type === "card_merged"),
  ).toBe(false);
  const begin = (s: CommandState) =>
    beginMergePush(s, system, { ...destination, attempt_id: "a-1" }, f.io);
  // Same push and base on both (ids come from one shared allocator).
  const payloads = (s: CommandState) => {
    const effect = value(begin(s));
    return [effect.data, effect.events.map((e) => [e.type, e.payload])];
  };
  const before = payloads(storeHistory(full));
  expect(JSON.stringify(before)).toContain("a".repeat(40));
  expect(payloads(slim)).toEqual(before);
});
