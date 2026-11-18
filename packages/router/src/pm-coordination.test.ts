import { expect, test } from "vitest";
import {
  assignment,
  card,
  decision,
  event,
  project_id,
  snapshot,
  workItem,
} from "./fixtures.js";
import { routeEvent } from "./route.js";

const system = { kind: "system" as const, project_id };

test("first producer assignment replaces planning chatter; deferred assignment retains its exception", () => {
  for (const type of ["work_item_assigned", "system_assignment_deferred"]) {
    const fact = event(
      type,
      { first_producer: true, work_item_id: "W-1", reason: "没有合格员工" },
      { actor: system, seq: 2 },
    );
    const state = snapshot({
      cards: [card({ status: "todo" })],
      work_items: [workItem("W-1", { status: "todo" })],
      events: [fact],
    });
    expect(
      routeEvent({ event: event("card_created"), snapshot: state })
        .notifications,
    ).toHaveLength(0);
    if (type === "system_assignment_deferred")
      expect(
        routeEvent({ event: fact, snapshot: state }).notifications,
      ).toHaveLength(1);
  }
});

test("author requests only notify PM; one grouped handoff notifies humans once", () => {
  const first = decision({
    id: "Q-1",
    pm_triage: true,
    status: "open",
    decider: "role:pm",
    category: "credential",
  });
  const second = decision({ ...first, id: "Q-2" });
  const source = event("decision_requested", {
    decision_id: first.id,
    routed_to: "role:pm",
  });
  expect(
    routeEvent({
      event: source,
      snapshot: snapshot({ decisions: [first, second] }),
    }).notifications.map((n) => n.recipient.kind),
  ).toEqual(["pm_ops"]);
  const handed = [first, second].map((q) => ({
    ...q,
    decider: "human" as const,
    handoff_group: "C-1/credential",
  }));
  const state = snapshot({ decisions: handed });
  expect(
    routeEvent({ event: source, snapshot: state }).notifications,
  ).toHaveLength(0);
  const results = handed.flatMap(
    (q) =>
      routeEvent({
        event: event("decision_requested", {
          decision_id: q.id,
          previous_decider: "role:pm",
          handoff_group: q.handoff_group,
        }),
        snapshot: state,
      }).notifications,
  );
  expect(results.map((n) => n.recipient.kind)).toEqual([
    "needs_you",
    "pm_office",
  ]);
});

test("Office overdue only reminds the human while its explicit request remains unanswered", () => {
  const overdue = event(
    "office_wait_overdue",
    { source_entry_id: "C-1#1", notice: "超过 30 分钟" },
    { actor: system },
  );
  expect(
    routeEvent({ event: overdue, snapshot: snapshot() }).notifications.map(
      (n) => n.recipient.kind,
    ),
  ).toEqual(["needs_you"]);
  expect(
    routeEvent({
      event: overdue,
      snapshot: snapshot({
        events: [
          event(
            "office_wait_closed",
            { source_entry_id: "C-1#1" },
            { actor: system },
          ),
        ],
      }),
    }).notifications,
  ).toHaveLength(0);
});

test("recovery routes only the system fact to the same active standing identity", () => {
  const a = assignment("A-4", {
    role_id: "pm",
    scope: "standing",
    standing_mode: "ops",
  });
  const fact = event(
    "standing_pm_recovered",
    { assignment_id: a.id },
    { actor: system, card_id: undefined },
  );
  expect(
    routeEvent({
      event: fact,
      snapshot: snapshot({ assignments: [a] }),
    }).notifications.map((n) => n.recipient),
  ).toEqual([{ kind: "assignment", assignment_id: a.id }]);
  expect(
    routeEvent({
      event: fact,
      snapshot: snapshot({ assignments: [{ ...a, status: "released" }] }),
    }).notifications,
  ).toHaveLength(0);
});

test("implementation progress ignores stale resolution, closed targets and inactive owners without PM fallback", () => {
  const q = decision({
    id: "Q-1",
    card_id: "C-1",
    status: "resolved",
    raised_by: "assignment:A-1",
    affected_work_items: ["W-1", "W-2"],
    resolution: { at: "2030-01-01T00:00:00Z" },
  });
  const fact = event(
    "decision_implementation_recorded",
    {
      decision_id: q.id,
      resolved_at: q.resolution?.at,
    },
    { actor: system },
  );
  const state = snapshot({ decisions: [q] });
  expect(
    routeEvent({ event: fact, snapshot: state }).notifications.map(
      (n) => n.recipient,
    ),
  ).toEqual([
    { kind: "assignment", assignment_id: "A-1" },
    { kind: "assignment", assignment_id: "A-2" },
  ]);
  for (const changed of [
    { ...state, decisions: [{ ...q, status: "revoked" as const }] },
    {
      ...state,
      decisions: [
        decision({ ...q, resolution: { at: "2030-01-02T00:00:00Z" } }),
      ],
    },
    { ...state, cards: [card({ status: "cancelled" })] },
    {
      ...state,
      assignments: state.assignments.map((a) => ({
        ...a,
        status: "released" as const,
      })),
    },
    { ...state, work_items: [] },
  ])
    expect(
      routeEvent({ event: fact, snapshot: changed }).notifications,
    ).toHaveLength(0);
  expect(
    routeEvent({
      event: { ...fact, actor: { kind: "human", project_id } },
      snapshot: state,
    }).notifications,
  ).toHaveLength(0);
});

test("interactive zero-match handoff reaches Ops even for manual work, but not once assigned", () => {
  const fact = event(
    "system_assignment_deferred",
    { interactive: true, work_item_id: "W-1", body: "缺少已验证的 godot" },
    { actor: { kind: "human", project_id } },
  );
  const owner = assignment("A-1", {
    scope: "standing",
    role_id: "pm",
    standing_mode: "ops",
  });
  const item = workItem("W-1", { manual_assign: true });
  const result = (item: ReturnType<typeof workItem>) =>
    routeEvent({
      event: fact,
      snapshot: snapshot({
        cards: [card()],
        work_items: [item],
        assignments: [owner],
      }),
    }).notifications;
  expect(result(item).map((n) => n.recipient.kind)).toEqual(["pm_ops"]);
  expect(result({ ...item, assignment_id: owner.id })).toEqual([]);
});
