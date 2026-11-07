import { expect, test } from "vitest";
import {
  agent,
  assignment,
  decision,
  delivery,
  entry,
  event,
  humanAction,
  review,
  run,
  snapshot,
  workItem,
} from "./fixtures.js";
import {
  escalation,
  routeBellFailure,
  routeEvent,
  routeRuntimeLost,
  routeWatchdog,
} from "./route.js";
import type { RouteResult } from "./types.js";

const rules = (result: RouteResult) => result.notifications.map((n) => n.rule);
const recipients = (result: RouteResult) =>
  result.notifications.map((n) =>
    n.recipient.kind === "assignment"
      ? `assignment:${n.recipient.assignment_id}`
      : n.recipient.kind,
  );

test("§6.4 work-item comment notifies that work item's Assignment", () => {
  const result = routeEvent({
    event: event("comment_posted", { body: "look" }, { seq: 4 }),
    snapshot: snapshot({ timeline: [entry(4, { work_item_id: "W-1" })] }),
  });
  expect(rules(result)).toEqual(["6.4/work-item comment"]);
  expect(recipients(result)).toEqual(["assignment:A-1"]);
});

test("§6.4 one event rings each recipient once, even when a mention repeats it", () => {
  const result = routeEvent({
    event: event("comment_posted", { body: "mine, @W-1" }, { seq: 4 }),
    snapshot: snapshot({
      timeline: [entry(4, { work_item_id: "W-1", mentions: ["@W-1"] })],
    }),
  });
  expect(result.notifications).toHaveLength(1);
  expect(recipients(result)).toEqual(["assignment:A-1"]);
});

test("§6.4 work-item comment by its own Assignment notifies nobody", () => {
  const result = routeEvent({
    event: event(
      "comment_posted",
      { body: "mine" },
      { seq: 4, actor: agent("A-1") },
    ),
    snapshot: snapshot({
      timeline: [entry(4, { work_item_id: "W-1", author: "assignment:A-1" })],
    }),
  });
  expect(result.notifications).toEqual([]);
});

test("§6.4 card comment without a mention rings no bell, but a human's is merged for PM Ops", () => {
  const fromHuman = routeEvent({
    event: event("comment_posted", { body: "note" }, { seq: 5 }),
    snapshot: snapshot({ timeline: [entry(5)] }),
  });
  expect(recipients(fromHuman)).toEqual(["pm_ops"]);
  expect(rules(fromHuman)).toEqual(["6.4/card comment without mention"]);

  const fromAgent = routeEvent({
    event: event(
      "comment_posted",
      { body: "note" },
      { seq: 5, actor: agent("A-2") },
    ),
    snapshot: snapshot({ timeline: [entry(5)] }),
  });
  expect(fromAgent.notifications).toEqual([]);
});

test("§6.4 an event for a released Assignment goes to PM Ops instead", () => {
  const result = routeEvent({
    event: event("comment_posted", { body: "look" }, { seq: 4 }),
    snapshot: snapshot({
      assignments: [assignment("A-1", { status: "released" })],
      timeline: [entry(4, { work_item_id: "W-1" })],
    }),
  });
  expect(recipients(result)).toEqual(["pm_ops"]);
});

test("§6.4 instruction goes to the work item's Assignment, or to PM Ops when unassigned", () => {
  const assigned = routeEvent({
    event: event("instruction_issued", { work_item_id: "W-1" }),
    snapshot: snapshot(),
  });
  expect(recipients(assigned)).toEqual(["assignment:A-1"]);
  expect(rules(assigned)).toEqual(["6.4/instruction"]);

  const unassigned = routeEvent({
    event: event("instruction_issued", { work_item_id: "W-9" }),
    snapshot: snapshot(),
  });
  expect(recipients(unassigned)).toEqual(["pm_ops"]);
});

test("§6.4 delivery submitted notifies the verifying Assignments and PM Ops with a summary", () => {
  const result = routeEvent({
    event: event("delivery_submitted", {
      delivery_id: "D-1",
      work_item_id: "W-1",
    }),
    snapshot: snapshot({
      deliveries: [delivery("D-1", { requested_verifiers: ["W-2"] })],
    }),
  });
  expect(recipients(result)).toEqual(["assignment:A-2", "pm_ops"]);
  expect(result.notifications[1]?.summary).toContain("D-1");
});

test("§6.4 review passed wakes nobody and asks for the done checks", () => {
  const result = routeEvent({
    event: event("review_submitted", { verdict: "pass", delivery_id: "D-1" }),
    snapshot: snapshot({
      deliveries: [delivery("D-1")],
      reviews: [review("pass")],
    }),
  });
  expect(result.notifications).toEqual([]);
  expect(result.checks.map((check) => check.rule)).toEqual([
    "6.4/review passed",
  ]);
});

test("§6.4 all required work items passed reminds the producer, without closing the card", () => {
  const result = routeEvent({
    event: event("review_submitted", { verdict: "pass", delivery_id: "D-1" }),
    snapshot: snapshot({
      deliveries: [delivery("D-1")],
      reviews: [review("pass")],
      work_items: [
        workItem("W-1", { status: "accepted", assignment_id: "A-1" }),
        workItem("W-2", {
          kind: "verify",
          role_id: "reviewer",
          status: "passed",
          assignment_id: "A-2",
        }),
      ],
    }),
  });
  expect(rules(result)).toEqual(["6.4/all required work items passed"]);
  expect(recipients(result)).toEqual(["assignment:A-1"]);
  expect(result.notifications[0]?.kind).toBe("completion");
});

test("§6.4 a pass among several required verifiers does not wake the downstream work", () => {
  // The delivery names two required verifiers; only this one has passed, so the
  // producer is still only "delivered" and nothing downstream may start.
  const result = routeEvent({
    event: event("review_submitted", { verdict: "pass", delivery_id: "D-1" }),
    snapshot: snapshot({
      deliveries: [
        delivery("D-1", {
          work_item_id: "W-1",
          requested_verifiers: ["W-2", "W-3"],
        }),
      ],
      reviews: [review("pass")],
      work_items: [
        workItem("W-1", { status: "in_progress", assignment_id: "A-1" }),
        workItem("W-2", {
          kind: "verify",
          role_id: "reviewer",
          status: "passed",
          assignment_id: "A-2",
        }),
        workItem("W-3", {
          kind: "verify",
          role_id: "pm",
          status: "in_progress",
          assignment_id: "A-3",
        }),
        workItem("W-4", {
          depends_on: ["W-1"],
          status: "todo",
          assignment_id: "A-4",
        }),
      ],
    }),
  });
  expect(rules(result)).not.toContain("6.4/dependency completed");
  expect(recipients(result)).not.toContain("assignment:A-4");
});

test("§6.4 downstream work waits for every one of its dependencies", () => {
  const base = {
    // Every recipient needs an Assignment, or the router hands it to PM Ops.
    assignments: [
      assignment("A-1"),
      assignment("A-2", { role_id: "reviewer" }),
      assignment("A-3", { scope: "standing", role_id: "pm" }),
      assignment("A-4"),
      assignment("A-5"),
      assignment("A-6"),
      assignment("A-7"),
    ],
    deliveries: [
      delivery("D-1", { work_item_id: "W-1", requested_verifiers: ["W-2"] }),
    ],
    reviews: [review("pass")],
    work_items: [
      workItem("W-1", { status: "accepted", assignment_id: "A-1" }),
      workItem("W-2", {
        kind: "verify",
        role_id: "reviewer",
        status: "passed",
        assignment_id: "A-2",
      }),
      workItem("W-3", { status: "accepted", assignment_id: "A-3" }),
      workItem("W-4", {
        depends_on: ["W-1"],
        status: "todo",
        assignment_id: "A-4",
      }),
      workItem("W-5", {
        depends_on: ["W-1", "W-3"],
        status: "todo",
        assignment_id: "A-5",
      }),
      workItem("W-6", {
        depends_on: ["W-1", "W-7"],
        status: "todo",
        assignment_id: "A-6",
      }),
      workItem("W-7", { status: "in_progress", assignment_id: "A-7" }),
    ],
  };
  // W-5 and W-6 still have an unfinished dependency besides W-1.
  const partial = routeEvent({
    event: event("review_submitted", { verdict: "pass", delivery_id: "D-1" }),
    snapshot: snapshot({
      ...base,
      work_items: base.work_items.filter((item) => item.id !== "W-3"),
    }),
  });
  expect(recipients(partial)).not.toContain("assignment:A-5");
  expect(recipients(partial)).not.toContain("assignment:A-6");
  expect(recipients(partial)).toContain("assignment:A-4");

  // Once the second dependency has succeeded as well, W-5 is next.
  const ready = routeEvent({
    event: event("review_submitted", { verdict: "pass", delivery_id: "D-1" }),
    snapshot: snapshot(base),
  });
  expect(recipients(ready)).toContain("assignment:A-5");
  expect(recipients(ready)).not.toContain("assignment:A-6");
});

test("§6.4 review rejected produces a rework notification for the delivery's Assignment", () => {
  const result = routeEvent({
    event: event("review_submitted", { verdict: "reject", delivery_id: "D-1" }),
    snapshot: snapshot({
      deliveries: [delivery("D-1", { work_item_id: "W-1" })],
      reviews: [review("reject")],
    }),
  });
  expect(rules(result)).toEqual(["6.4/review rejected"]);
  expect(recipients(result)).toEqual(["assignment:A-1"]);
});

test("§6.4 decision requested for the human becomes Needs You plus a PM Office brief", () => {
  const result = routeEvent({
    event: event("decision_requested", { decision_id: "q(1)" }),
    snapshot: snapshot({ decisions: [decision({ decider: "human" })] }),
  });
  expect(recipients(result)).toEqual(["needs_you", "pm_office"]);
  expect(rules(result)).toEqual([
    "6.4/decision requested",
    "6.4/decision requested",
  ]);
});

test("§6.4 decision requested from a role goes to that role's Assignment", () => {
  const result = routeEvent({
    event: event("decision_requested", { decision_id: "q(1)" }),
    snapshot: snapshot({ decisions: [decision({ decider: "role:pm" })] }),
  });
  expect(recipients(result)).toEqual(["assignment:A-3"]);
});

test("§6.4 decision resolved wakes every Assignment it had blocked, and PM Ops", () => {
  const result = routeEvent({
    event: event("decision_resolved", {
      decision_id: "q(1)",
      resume_work_items: ["W-2"],
    }),
    snapshot: snapshot(),
  });
  expect(recipients(result)).toEqual(["assignment:A-2", "pm_ops"]);
  expect(rules(result)[0]).toBe("6.4/decision resolved");
});

test("§6.4 dependency completed notifies the downstream Assignment", () => {
  const result = routeEvent({
    event: event("work_item_updated", { work_item_id: "W-1" }),
    snapshot: snapshot({
      work_items: [
        workItem("W-1", { status: "accepted" }),
        workItem("W-2", {
          kind: "verify",
          role_id: "reviewer",
          depends_on: ["W-1"],
          status: "todo",
          assignment_id: "A-2",
        }),
      ],
    }),
  });
  expect(rules(result)).toEqual(["6.4/dependency completed"]);
  expect(recipients(result)).toEqual(["assignment:A-2"]);
});

test("§6.4 dependency completed with no downstream Assignment goes to PM Ops", () => {
  const result = routeEvent({
    event: event("work_item_updated", { work_item_id: "W-1" }),
    snapshot: snapshot({
      work_items: [
        workItem("W-1", { status: "accepted" }),
        workItem("W-3", {
          kind: "verify",
          role_id: "reviewer",
          depends_on: ["W-1"],
          status: "todo",
        }),
      ],
    }),
  });
  expect(recipients(result)).toEqual(["pm_ops"]);
});

test("§6.4 completion request notifies the card template's reviewer", () => {
  const result = routeEvent({
    event: event("delivery_submitted", {
      delivery_id: "D-1",
      work_item_id: "W-1",
    }),
    snapshot: snapshot({
      deliveries: [
        delivery("D-1", {
          kind: "card_completion",
          requested_verifiers: ["W-2"],
        }),
      ],
      work_items: [
        workItem("W-1", { status: "delivered" }),
        workItem("W-2", {
          kind: "verify",
          role_id: "pm",
          status: "ready",
          assignment_id: "A-3",
        }),
      ],
    }),
  });
  expect(rules(result)).toEqual(["6.4/completion request"]);
  expect(recipients(result)).toEqual(["assignment:A-3"]);
});

test("§6.4 human action requested becomes Needs You plus a PM Office brief", () => {
  const result = routeEvent({
    event: event("human_action_requested", { human_action_id: "h(1)" }),
    snapshot: snapshot({
      human_actions: [humanAction("h(1)")],
      work_items: [workItem("W-1", { status: "waiting_human" })],
    }),
  });
  expect(recipients(result)).toEqual(["needs_you", "pm_office"]);
  expect(rules(result)).toEqual([
    "6.4/human action requested",
    "6.4/human action requested",
  ]);
});

test("§6.4 bell delivery failed goes to PM Ops and is never retried silently", () => {
  const notification = routeBellFailure({
    event_id: "E-9" as never,
    seq: 9,
    card_id: "C-1" as never,
    assignment_id: "A-1" as never,
    reason: "runtime_unavailable",
  });
  expect(notification.recipient.kind).toBe("pm_ops");
  expect(notification.rule).toBe("6.4/bell delivery failed");
});

test("§6.4 run finished without output is an exception for PM Ops", () => {
  const result = routeEvent({
    event: event("run_finished", { run_id: "R-1", outcome: "completed" }),
    snapshot: snapshot(),
  });
  expect(rules(result)).toEqual(["6.4/run finished without output"]);
  expect(result.notifications[0]?.kind).toBe("run_attention");
});

test("§7.1/S4 a finished work-item Run is PM Ops' business, never its own bell", () => {
  const result = routeEvent({
    event: event(
      "run_finished",
      { run_id: "R-1", outcome: "completed" },
      { seq: 9 },
    ),
    snapshot: snapshot({ runs: [run("R-1", { assignment_id: "A-1" })] }),
  });
  expect(recipients(result)).toEqual(["pm_ops"]);
});

test("§7.1/S4 a standing PM's own finished Run never rings it again", () => {
  // PM Ops ends a working turn (completed, with a conclusion) and nothing was
  // delivered: that is its normal work, not the §7.2 exception.
  const result = routeEvent({
    event: event(
      "run_finished",
      { run_id: "R-9", outcome: "completed" },
      { seq: 9, card: false },
    ),
    snapshot: snapshot({
      assignments: [
        assignment("A-9", {
          scope: "standing",
          role_id: "pm",
          standing_mode: "ops",
        }),
      ],
      runs: [run("R-9", { assignment_id: "A-9" })],
    }),
  });
  expect(result.notifications).toEqual([]);
});

test("§7.1/S4 a standing PM Run that failed goes to the human, not to itself", () => {
  const result = routeEvent({
    event: event(
      "run_finished",
      { run_id: "R-9", outcome: "failed" },
      { seq: 9, card: false },
    ),
    snapshot: snapshot({
      assignments: [
        assignment("A-9", {
          scope: "standing",
          role_id: "pm",
          standing_mode: "ops",
        }),
      ],
      runs: [run("R-9", { assignment_id: "A-9", outcome: "failed" })],
    }),
  });
  expect(recipients(result)).toEqual(["needs_you"]);
  expect(result.notifications[0]?.kind).toBe("escalation");
});

test("§6.4 agent idle without finish_run is a watchdog escalation for PM Ops", () => {
  const notification = routeWatchdog({
    event_id: "E-10" as never,
    seq: 10,
    assignment_id: "A-1" as never,
    idle_minutes: 15,
  });
  expect(notification.rule).toBe("6.4/agent idle without finish_run");
  expect(notification.summary).toContain("15");
});

test("§6.4 runtime lost beyond the grace period is the human's decision", () => {
  const notification = routeRuntimeLost({
    event_id: "E-11" as never,
    seq: 11,
    assignment_id: "A-1" as never,
    lost_minutes: 30,
  });
  expect(notification.recipient.kind).toBe("needs_you");
  expect(notification.rule).toBe("6.4/runtime lost");
});

test("§6.5 one Assignment for the mentioned role is notified", () => {
  const result = routeEvent({
    event: event("comment_posted", { body: "@reviewer look" }, { seq: 6 }),
    snapshot: snapshot({ timeline: [entry(6, { mentions: ["@reviewer"] })] }),
  });
  expect(rules(result)).toEqual(["6.5/single assignment for the role"]);
  expect(recipients(result)).toEqual(["assignment:A-2"]);
});

test("§6.5 no Assignment for the mentioned role goes to PM Ops", () => {
  const result = routeEvent({
    event: event("comment_posted", { body: "@designer look" }, { seq: 6 }),
    snapshot: snapshot({ timeline: [entry(6, { mentions: ["@designer"] })] }),
  });
  expect(rules(result)).toEqual(["6.5/no assignment for the role"]);
  expect(recipients(result)).toEqual(["pm_ops"]);
});

test("§6.5 several Assignments for the mentioned role ask for a work item instead of broadcasting", () => {
  const result = routeEvent({
    event: event("comment_posted", { body: "@coder look" }, { seq: 6 }),
    snapshot: snapshot({
      assignments: [
        assignment("A-1"),
        assignment("A-4", { work_item_id: "W-2" }),
      ],
      timeline: [entry(6, { mentions: ["@coder"] })],
    }),
  });
  expect(result.notifications).toEqual([]);
  expect(result.problems.map((problem) => problem.code)).toEqual([
    "ambiguous_role_mention",
  ]);
});

test("§6.5 an explicit @A-17 or @W-4 is notified directly", () => {
  const byAssignment = routeEvent({
    event: event("comment_posted", { body: "@A-3?" }, { seq: 7 }),
    snapshot: snapshot({ timeline: [entry(7, { mentions: ["@A-2"] })] }),
  });
  expect(recipients(byAssignment)).toEqual(["assignment:A-2"]);
  expect(rules(byAssignment)).toEqual(["6.5/explicit assignment or work item"]);

  const byWorkItem = routeEvent({
    event: event("comment_posted", { body: "@W-2?" }, { seq: 7 }),
    snapshot: snapshot({ timeline: [entry(7, { mentions: ["@W-2"] })] }),
  });
  expect(recipients(byWorkItem)).toEqual(["assignment:A-2"]);

  // Unknown ids are a problem for the speaker, not a broadcast.
  const unknown = routeEvent({
    event: event("comment_posted", { body: "@W-9?" }, { seq: 7 }),
    snapshot: snapshot({ timeline: [entry(7, { mentions: ["@W-9"] })] }),
  });
  expect(unknown.notifications).toEqual([]);
  expect(unknown.problems[0]?.code).toBe("unknown_mention");

  // A work item that exists but has nobody assigned goes to PM Ops.
  const unassigned = routeEvent({
    event: event("comment_posted", { body: "@W-3?" }, { seq: 7 }),
    snapshot: snapshot({
      work_items: [
        ...snapshot().work_items,
        workItem("W-3", { status: "todo" }),
      ],
      timeline: [entry(7, { mentions: ["@W-3"] })],
    }),
  });
  expect(recipients(unassigned)).toEqual(["pm_ops"]);
  expect(unassigned.problems[0]?.code).toBe("mentioned_work_item_unassigned");
});

test("§7.2 work conflict or priority contention is escalated to PM Ops", () => {
  const notification = escalation(
    { event: event("card_created", {}), snapshot: snapshot() },
    "work conflict or priority contention",
    "C-2 and C-3 both claim the only coder",
  );
  expect(notification.rule).toBe("7.2/work conflict or priority contention");
  expect(notification.recipient.kind).toBe("pm_ops");
  expect(notification.kind).toBe("escalation");
});

test("§7.2 a delivery that does not match the requirement is escalated", () => {
  const notification = escalation(
    {
      event: event("review_submitted", { verdict: "reject" }),
      snapshot: snapshot(),
    },
    "delivery does not match the requirement",
    "D-1 implements a different feature",
  );
  expect(notification.rule).toBe("7.2/delivery does not match the requirement");
});

test("§7.2 deciding whether to pause further work is escalated", () => {
  const notification = escalation(
    { event: event("blocker_reported", {}), snapshot: snapshot() },
    "decide whether to pause",
    "the vendor API is unavailable",
  );
  expect(notification.rule).toBe("7.2/decide whether to pause");
});

test("§7.2 an exception no rule covers is escalated", () => {
  const notification = escalation(
    {
      event: event("run_finished", { outcome: "failed" }),
      snapshot: snapshot(),
    },
    "unhandled exception",
    "run finished without a delivery and no rule applies",
  );
  expect(notification.rule).toBe("7.2/unhandled exception");
});

test("§7.2 delivery rejected twice escalates to PM Ops for re-planning", () => {
  const result = routeEvent({
    event: event(
      "review_submitted",
      { verdict: "reject", delivery_id: "D-1" },
      { seq: 8 },
    ),
    snapshot: snapshot({
      deliveries: [delivery("D-1")],
      reviews: [review("reject"), review("reject")],
    }),
  });
  expect(rules(result)).toContain("7.2/delivery rejected twice");
  expect(recipients(result)).toContain("pm_ops");
});

test("M3.4 completion routing uses requested verifiers rather than the first PM item", () => {
  const result = routeEvent({
    event: event("delivery_submitted", { delivery_id: "D-1" }),
    snapshot: snapshot({
      deliveries: [
        delivery("D-1", {
          kind: "card_completion",
          requested_verifiers: ["W-4"],
        }),
      ],
      work_items: [
        workItem("W-3", {
          kind: "verify",
          role_id: "pm",
          assignment_id: "A-3",
        }),
        workItem("W-4", {
          kind: "verify",
          role_id: "pm",
          assignment_id: "A-4",
        }),
      ],
      assignments: [
        assignment("A-3", { role_id: "pm", work_item_id: "W-3" }),
        assignment("A-4", { role_id: "pm", work_item_id: "W-4" }),
      ],
    }),
  });
  expect(recipients(result)).toEqual(["assignment:A-4"]);
});
test("M3.4 real success states remind the primary producer without waiting for its completion approval", () => {
  const state = snapshot({
    work_items: [
      workItem("W-8", {
        status: "accepted",
        assignment_id: "A-2",
        required: false,
      }),
      workItem("W-1", {
        status: "accepted",
        assignment_id: "A-1",
        template_key: "development",
      }),
      workItem("W-2", { kind: "verify", status: "passed" }),
      workItem("W-3", {
        kind: "verify",
        role_id: "pm",
        status: "todo",
        template_key: "pm_acceptance",
      }),
    ],
  });
  const input = {
    event: event("review_submitted", { verdict: "pass", delivery_id: "D-1" }),
    snapshot: state,
  };
  expect(recipients(routeEvent(input))).toEqual(["assignment:A-1"]);
  expect(
    recipients(
      routeEvent({
        ...input,
        snapshot: {
          ...state,
          cards: state.cards.map((c) => ({ ...c, status: "done" })),
        },
      }),
    ),
  ).toEqual([]);
});

/**
 * §4.4: a produce work item nothing verifies is accepted the moment its
 * delivery arrives. The router must treat that like a passing review, or the
 * downstream work (and PM Ops, when nothing owns it) never hears about it.
 */
test("§4.4 delivery_accepted wakes a downstream Assignment whose dependencies are complete", () => {
  const result = routeEvent({
    event: event("delivery_accepted", {
      delivery_id: "D-1",
      work_item_id: "W-1",
      unreviewed: true,
    }),
    snapshot: snapshot({
      assignments: [
        assignment("A-1"),
        assignment("A-2", { role_id: "reviewer" }),
        assignment("A-4"),
      ],
      deliveries: [
        delivery("D-1", { work_item_id: "W-1", requested_verifiers: [] }),
      ],
      work_items: [
        workItem("W-1", { status: "accepted", assignment_id: "A-1" }),
        workItem("W-4", {
          depends_on: ["W-1"],
          status: "todo",
          assignment_id: "A-4",
        }),
      ],
    }),
  });
  expect(rules(result)).toContain("6.4/dependency completed");
  expect(recipients(result)).toContain("assignment:A-4");
});

test("§4.4 delivery_accepted hands an unowned downstream item to PM Ops", () => {
  const result = routeEvent({
    event: event("delivery_accepted", {
      delivery_id: "D-1",
      work_item_id: "W-1",
      unreviewed: true,
    }),
    snapshot: snapshot({
      deliveries: [
        delivery("D-1", { work_item_id: "W-1", requested_verifiers: [] }),
      ],
      work_items: [
        workItem("W-1", { status: "accepted", assignment_id: "A-1" }),
        workItem("W-4", { depends_on: ["W-1"], status: "todo" }),
      ],
    }),
  });
  expect(rules(result)).toContain("6.4/dependency completed");
  expect(recipients(result)).toContain("pm_ops");
});

test("§4.4 delivery_accepted waits for the other dependencies and keeps the work item lazy", () => {
  const result = routeEvent({
    event: event("delivery_accepted", {
      delivery_id: "D-1",
      work_item_id: "W-1",
      unreviewed: true,
    }),
    snapshot: snapshot({
      assignments: [assignment("A-1"), assignment("A-4"), assignment("A-7")],
      deliveries: [
        delivery("D-1", { work_item_id: "W-1", requested_verifiers: [] }),
      ],
      work_items: [
        workItem("W-1", { status: "accepted", assignment_id: "A-1" }),
        // W-4 depends on W-1 and an unfinished W-7.
        workItem("W-4", {
          depends_on: ["W-1", "W-7"],
          status: "todo",
          assignment_id: "A-4",
        }),
        workItem("W-7", { status: "in_progress", assignment_id: "A-7" }),
      ],
    }),
  });
  expect(recipients(result)).not.toContain("assignment:A-4");
});

test("§4.4 delivery_accepted reminds the producer when it was the last required item", () => {
  const result = routeEvent({
    event: event("delivery_accepted", {
      delivery_id: "D-1",
      work_item_id: "W-1",
      unreviewed: true,
    }),
    snapshot: snapshot({
      deliveries: [
        delivery("D-1", { work_item_id: "W-1", requested_verifiers: [] }),
      ],
      work_items: [
        workItem("W-1", { status: "accepted", assignment_id: "A-1" }),
      ],
    }),
  });
  expect(rules(result)).toContain("6.4/all required work items passed");
  expect(recipients(result)).toContain("assignment:A-1");
});
