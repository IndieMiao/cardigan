import { expect, test } from "vitest";
import type { CommandState } from "./commands/core.js";
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
import type { Card, Decision, Event, JsonValue, WorkItem } from "./entities.js";
import { eventById } from "./event-index.js";
import {
  commandRunIds,
  githubRunCards,
  hotCommandEvents,
  LEAN_COLD_CARD_OMITTED_EVENT_TYPES,
  leanCommandEvents,
  PROJECT_STREAM_RETENTION,
  projectStreamDropped,
  waitedGithubRuns,
} from "./hot-history.js";
import { compareHotState } from "./hot-history-shadow.js";
import { type CardId, type EventId, parseEventId } from "./ids.js";

/**
 * C-649 contract for the `lean` scope: cold cards also lose GitHub dispatch
 * records unless a live wait names their run, and the project stream keeps
 * each retained type only as far as its readers look. Every rule and
 * projection of the shadow comparison answers as on the whole history.
 */
let serial = 0;
const project_id = fixture().project_id;
const event = (
  type: string,
  card_id?: CardId,
  payload: Record<string, JsonValue> = {},
  actor: Event["actor"] = { kind: "system", project_id },
): Event => ({
  id: value(parseEventId(String(++serial).padStart(26, "0"))),
  seq: ++serial,
  ...(card_id ? { card_id } : {}),
  type,
  actor,
  payload,
  created_at: now,
});
const done = (n: number): Card => ({
  ...card(n),
  status: "done",
  resolution: "done",
});
const [c1, c2, c3] = [1, 2, 3].map((n) => id("card", n)) as [
  CardId,
  CardId,
  CardId,
];
const telemetry = (c: CardId) =>
  [...LEAN_COLD_CARD_OMITTED_EVENT_TYPES].map((type) => event(type, c));
const backup = (assignment_id: string, branch: string, sha: string) =>
  event("assignment_branch_backed_up", undefined, {
    assignment_id,
    machine_id: "local",
    branch,
    sha,
  });

/**
 * C1 is open; its producer waits for GitHub run 4242, whose dispatch record
 * lives on done C2. Done C3 holds another run's record, a resolved
 * decision's follow-up evidence and telemetry. The project stream carries
 * repeated branch backups and audit rows, one of them a live Run trigger.
 */
function scenario() {
  serial = 0;
  const base = fixture();
  const trigger = event("cross_card_read", undefined, { tool: "get_card" });
  const audit = event("cross_card_read", undefined, { tool: "get_card" });
  const backups = [
    backup("A-1", "b", "1"),
    backup("A-1", "b", "2"),
    backup("A-1", "other", "3"),
    backup("A-2", "b", "4"),
    // Same fields from another actor kind: a different key, never a match.
    {
      ...backup("A-1", "b", "5"),
      actor: { kind: "human", project_id } as Event["actor"],
    },
  ];
  const resolved = event("decision_resolved", c3, {
    decision_id: id("decision", 1),
  });
  const events = [
    trigger,
    ...backups,
    audit,
    event("github_check_dispatch", c2, {
      attempt: "a-1",
      externalRun: { run_id: 4242 },
      finished: true,
    }),
    event("card_merged", c2, { completion_id: "D-2" }),
    ...telemetry(c2),
    event("github_check_dispatch", c3, {
      attempt: "a-2",
      externalRun: { run_id: 999 },
    }),
    resolved,
    event("delivery_submitted", c3, { delivery_id: "D-3" }),
    ...telemetry(c3),
  ];
  const [produce, ...rest] = base.work_items as [WorkItem, ...WorkItem[]];
  const blocked: WorkItem = {
    ...produce,
    status: "blocked",
    reported_blocker: {
      reason: "waiting for the GitHub run",
      needs: "role",
      reported_by: `assignment:${id("assignment", 1)}`,
      reported_at: now,
      resume_when: { kind: "github_run_completed", target_id: "4242" },
    },
  };
  const decision = {
    id: id("decision", 1),
    key: id("decision", 1),
    card_id: c3,
    raised_by: `assignment:${id("assignment", 1)}`,
    kind: "choose",
    category: "general",
    question: "Which?",
    context: "",
    options: [{ key: "a", description: "A", impact: "none" }],
    recommended: "a",
    affected_cards: [],
    affected_work_items: [],
    blocking: false,
    decider: "role:pm",
    status: "resolved",
    resolution: {
      option: "a",
      rationale: "ok",
      resolved_by: "human",
      at: "2025-12-31T00:00:00.000Z",
    },
    created_at: "2025-12-31T00:00:00.000Z",
  } as unknown as Decision;
  const full: CommandState = {
    ...base,
    cards: [card(1), done(2), done(3)],
    work_items: [blocked, ...rest],
    assignments: [{ ...assignment(1), runtime_state: "idle" }],
    runs: [
      { ...run(1), status: "completed" },
      { ...run(2, 1), trigger_event_id: trigger.id as EventId },
    ],
    decisions: [decision],
    events,
  };
  return { full, trigger, audit, backups };
}

test("lean keeps waited dispatch cards whole and drops other cold dispatch records", () => {
  const { full } = scenario();
  expect(waitedGithubRuns(full.work_items)).toEqual(["4242"]);
  const dispatches = full.events.filter(
    (e) => e.type === "github_check_dispatch",
  );
  expect([...githubRunCards(dispatches, ["4242", "x", "0"])]).toEqual([c2]);
  const lean = leanCommandEvents(full);
  const dropped = full.events.filter((e) => !lean.includes(e));
  // C3 loses its dispatch record and telemetry; C2 stays whole.
  expect(dropped.filter((e) => e.card_id === c3)).toHaveLength(
    LEAN_COLD_CARD_OMITTED_EVENT_TYPES.size + 1,
  );
  expect(dropped.filter((e) => e.card_id === c2)).toEqual([]);
  // C-796: the hot scope drops cold dispatch records the same way.
  const dispatch = (events: readonly Event[]) =>
    events.filter((e) => e.type === "github_check_dispatch");
  const hot = hotCommandEvents(full);
  expect(dispatch(hot)).toEqual(dispatch(lean));
  expect(dispatch(hot).map((e) => e.card_id)).not.toContain(c3);
  expect(dispatch(hot).map((e) => e.card_id)).toContain(c2);
});

test("a wait for a GitHub run recorded on a closed card still resumes", () => {
  const { full } = scenario();
  const lean = { ...full, events: leanCommandEvents(full) };
  const system = { kind: "system", project_id } as const;
  const a = value(resumeWorkWaits(full, system, {}, ports()));
  const b = value(resumeWorkWaits(lean, system, {}, ports()));
  expect(b).toEqual(a);
  expect(a.events.length).toBeGreaterThan(0);
});

test("project-stream retention keeps the newest backup per key and live trigger audit rows", () => {
  const { full, trigger, audit, backups } = scenario();
  const lean = leanCommandEvents(full);
  const kept = new Set(lean.map((e) => e.id));
  expect(kept.has(trigger.id)).toBe(true);
  expect(kept.has(audit.id)).toBe(false);
  expect(backups.map((e) => kept.has(e.id))).toEqual([
    false,
    true,
    true,
    true,
    true,
  ]);
  // A protected id (live notification subject) is never dropped.
  expect(
    leanCommandEvents(full, [], new Set([audit.id])).some(
      (e) => e.id === audit.id,
    ),
  ).toBe(true);
  // Same answers as the host's backup reader for every key it can ask.
  const lastBackup = (events: readonly Event[], a: string, branch: string) =>
    events.findLast(
      (e) =>
        e.type === "assignment_branch_backed_up" &&
        e.actor.kind === "system" &&
        e.actor.project_id === project_id &&
        e.card_id === undefined &&
        (e.payload as Record<string, unknown>).assignment_id === a &&
        (e.payload as Record<string, unknown>).machine_id === "local" &&
        (e.payload as Record<string, unknown>).branch === branch,
    )?.id;
  for (const a of ["A-1", "A-2", "A-3"])
    for (const branch of ["b", "other"])
      expect(lastBackup(lean, a, branch)).toBe(
        lastBackup(full.events, a, branch),
      );
  expect(eventById(lean, trigger.id)).toBe(trigger);
});

test("retention rules only name project-stream types and protect what they must", () => {
  for (const [type, rule] of PROJECT_STREAM_RETENTION) {
    expect(LEAN_COLD_CARD_OMITTED_EVENT_TYPES.has(type)).toBe(false);
    expect(["none", "latest"]).toContain(rule.kind);
  }
  const a = backup("A-1", "b", "1");
  const b = backup("A-1", "b", "2");
  const onCard = { ...backup("A-1", "b", "3"), card_id: c1 };
  expect([...projectStreamDropped([a, b, onCard], new Set())]).toEqual([a.id]);
  expect([...projectStreamDropped([a, b], new Set([a.id]))]).toEqual([]);
  // A missing field and an explicit null never share a key (the reader uses ===).
  const missing = event("assignment_branch_backed_up", undefined, {
    assignment_id: "A-1",
    machine_id: "local",
  });
  const nulled = event("assignment_branch_backed_up", undefined, {
    assignment_id: "A-1",
    machine_id: "local",
    branch: null,
  });
  expect([...projectStreamDropped([missing, nulled], new Set())]).toEqual([]);
  expect(
    commandRunIds([{ resume_when: { target_id: "77" } }, 5, "x", 0]),
  ).toEqual(["77", "5"]);
});

test("every shadow rule and projection answers as on the whole history", () => {
  const { full } = scenario();
  const lean = { ...full, events: leanCommandEvents(full) };
  expect(lean.events.length).toBeLessThan(full.events.length);
  const checks = compareHotState(full, lean, { now });
  expect(checks.filter((c) => !c.equal)).toEqual([]);
  expect(checks.map((c) => c.name)).toEqual(
    expect.arrayContaining([
      "delegation",
      "deployment_audits",
      "standing_runs",
      "merge_push",
      "project_preferences",
      "remind_decision_followups",
      "critical_path",
    ]),
  );
});
