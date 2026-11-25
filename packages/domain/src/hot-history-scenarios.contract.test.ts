import { describe, expect, test } from "vitest";
import {
  assignmentDependenciesAllowStart,
  cardDependencyComplete,
} from "./card-dependencies.js";
import { referenceReadState } from "./card-read.js";
import { CommandDraft, type CommandState } from "./commands/core.js";
import { humanOnlyAction } from "./commands/human-action-completion.js";
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
  Event,
  HumanAction,
  JsonValue,
  TimelineEntry,
  WorkItem,
} from "./entities.js";
import { fullEventHistory } from "./event-index.js";
import { pendingHostOpsActions } from "./host-ops.js";
import {
  COLD_CARD_OMITTED_EVENT_TYPES,
  hotCardIds,
  hotCommandEvents,
  LEAN_COLD_CARD_OMITTED_EVENT_TYPES,
  leanCommandEvents,
  SLIM_COLD_CARD_EVENT_TYPES,
  slimCommandEvents,
} from "./hot-history.js";
import { type CardId, parseEventId } from "./ids.js";

/**
 * C-639 contract: the cross-card readers found in the audit give the same
 * answer on the hot history as on the whole history. Every closed card here
 * also carries the cold-omitted telemetry, so a wrongly cold card would show.
 * C-649: the same scenarios hold for the `lean` scope (cold cards also lose
 * GitHub dispatch records; the project stream follows retention rules).
 * C-671: and for the `slim` scope, whose cold cards keep only the whitelisted
 * facts in the array while indexed lookups still see the rest.
 */
let serial = 0;
const project_id = fixture().project_id;
const event = (
  type: string,
  card_id?: CardId,
  payload: Record<string, JsonValue> = {},
): Event => ({
  id: value(parseEventId(String(++serial).padStart(26, "0"))),
  seq: ++serial,
  ...(card_id ? { card_id } : {}),
  type,
  actor: { kind: "system", project_id },
  payload,
  created_at: now,
});
const done = (n: number): Card => ({
  ...card(n),
  status: "done",
  resolution: "done",
});
const telemetry = (c: CardId) =>
  [...LEAN_COLD_CARD_OMITTED_EVENT_TYPES].map((type) => event(type, c));
const scopes = [
  [
    "hot",
    COLD_CARD_OMITTED_EVENT_TYPES,
    (s: CommandState) => hotCommandEvents(s),
  ],
  [
    "lean",
    LEAN_COLD_CARD_OMITTED_EVENT_TYPES,
    (s: CommandState) => leanCommandEvents(s),
  ],
  [
    "slim",
    LEAN_COLD_CARD_OMITTED_EVENT_TYPES,
    (s: CommandState) => slimCommandEvents(s),
  ],
] as const;
const [c1, c2, c3, c4] = [1, 2, 3, 4].map((n) => id("card", n)) as [
  CardId,
  CardId,
  CardId,
  CardId,
];

/**
 * C1 is open: it depends on done C2 and its producer waits for done C3 to
 * merge. C3 also holds a restricted batch check and the finish of a
 * system-stream host action. C4 is done with an open human-only action.
 */
function scenario(define: (s: CommandState) => readonly Event[]): {
  full: CommandState;
  hot: CommandState;
} {
  serial = 0;
  const base = fixture();
  const taken = event("host_ops_action_taken", undefined, {
    execution: true,
    assignment_id: id("assignment", 1),
  });
  const check = event("merge_check_finished", c3, {
    attempt_id: "batch-attempt",
    batch_id: "B-1",
    level: "batch",
    status: "failed",
    checks: [{ name: "secret detail" }],
  });
  const action: HumanAction = {
    id: id("human_action", 1),
    key: id("human_action", 1),
    card_id: c4,
    requested_by: "system",
    instructions: "Confirm the host step",
    why_human: "Only a person may close it",
    expected_return: "Confirmation",
    blocked_work_items: [],
    status: "open",
    created_at: now,
  } as unknown as HumanAction;
  const events = [
    taken,
    event("card_merged", c2, { completion_id: "D-2" }),
    ...telemetry(c2),
    event("card_merged", c3, { completion_id: "D-3" }),
    check,
    event("host_ops_action_finished", c3, { action_id: taken.id }),
    ...telemetry(c3),
    event("human_action_requested", c4, {
      human_action_id: action.id,
      host_ops_action_id: taken.id,
    }),
    ...telemetry(c4),
  ];
  const [produce, ...rest] = base.work_items as [WorkItem, ...WorkItem[]];
  const blocked: WorkItem = {
    ...produce,
    status: "blocked",
    reported_blocker: {
      reason: "waiting for C3",
      needs: "role",
      reported_by: `assignment:${id("assignment", 1)}`,
      reported_at: now,
      resume_when: { kind: "card_merged", target_id: c3 },
    },
  };
  const timeline: TimelineEntry[] = [
    {
      id: `${c3}#1`,
      short_id: `${c3}#1`,
      card_id: c3,
      event_seq: check.seq,
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
      { ...card(1), depends_on_cards: [c2], merge_policy: "confirm" },
      { ...done(2), merge_policy: "confirm" },
      done(3),
      done(4),
    ],
    work_items: [blocked, ...rest],
    assignments: [{ ...assignment(1), runtime_state: "idle" }],
    runs: [{ ...run(1), status: "completed" }],
    human_actions: [action],
    timeline,
    events,
  };
  return { full, hot: { ...full, events: define(full) } };
}

describe.each(scopes)("%s scope", (scope, omitted, define) => {
  test("only cold cards lose telemetry; referenced closed cards stay whole", () => {
    const { full, hot } = scenario(define);
    expect([...hotCardIds(full)].sort()).toEqual([c1, c2, c4].sort());
    const kept = fullEventHistory(hot.events);
    const dropped = full.events.filter((e) => !kept.includes(e));
    // C-671: a slim cold card also loses every non-whitelisted fact.
    const whitelisted = (e: Event) =>
      scope !== "slim" || SLIM_COLD_CARD_EVENT_TYPES.has(e.type);
    expect(dropped.length).toBe(
      omitted.size +
        full.events.filter(
          (e) => e.card_id === c3 && !omitted.has(e.type) && !whitelisted(e),
        ).length,
    );
    for (const e of dropped) expect(e.card_id).toBe(c3);
  });

  test("dependency completion of a done predecessor is unchanged", () => {
    const { full, hot } = scenario(define);
    const before = full.cards[1] as Card;
    expect(cardDependencyComplete(full, before)).toBe(
      cardDependencyComplete(hot, before),
    );
    const owner = full.assignments[0];
    if (!owner) throw new Error("missing owner");
    expect(assignmentDependenciesAllowStart(hot, owner)).toBe(
      assignmentDependenciesAllowStart(full, owner),
    );
  });

  test("a wait for a closed card's merge still resumes", () => {
    const { full, hot } = scenario(define);
    const a = value(
      resumeWorkWaits(full, { kind: "system", project_id }, {}, ports()),
    );
    const b = value(
      resumeWorkWaits(hot, { kind: "system", project_id }, {}, ports()),
    );
    expect(b).toEqual(a);
    expect(a.events.length).toBeGreaterThan(0);
  });

  test("restricted batch timeline on a cold card stays masked", () => {
    const { full, hot } = scenario(define);
    const reader = full.assignments[0];
    if (!reader) throw new Error("missing reader");
    const before = referenceReadState(full, reader);
    const after = referenceReadState(hot, reader);
    expect(after.timeline).toEqual(before.timeline);
    expect(after.timeline.map((t) => t.body)).not.toContain(
      "secret batch detail",
    );
  });

  test("a human-only action on a closed card stays human-only", () => {
    const { full, hot } = scenario(define);
    const action = full.human_actions[0] as HumanAction;
    const draft = (s: CommandState) =>
      new CommandDraft(
        s,
        { kind: "human", project_id },
        "list_needs_you",
        ports(),
      );
    expect(humanOnlyAction(draft(full), action)).toBe(true);
    expect(humanOnlyAction(draft(hot), action)).toBe(true);
  });

  test("a host action finished on a cold card never fences again", () => {
    const { full, hot } = scenario(define);
    expect(pendingHostOpsActions(full.events)).toEqual([]);
    expect(pendingHostOpsActions(hot.events)).toEqual([]);
  });
});
