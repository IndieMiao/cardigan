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
        workItem("W-1", { status: "verifiers_passed", assignment_id: "A-1" }),
        workItem("W-2", {
          kind: "verify",
          role_id: "reviewer",
          status: "done",
          assignment_id: "A-2",
        }),
      ],
    }),
  });
  expect(rules(result)).toEqual(["6.4/all required work items passed"]);
  expect(recipients(result)).toEqual(["assignment:A-1"]);
  expect(result.notifications[0]?.kind).toBe("completion");
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
        workItem("W-1", { status: "done" }),
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
        workItem("W-1", { status: "done" }),
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
        workItem("W-1", { status: "delivery_submitted" }),
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
