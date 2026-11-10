import { expect, test } from "vitest";
import {
  assignment,
  event,
  humanAction,
  snapshot,
  workItem,
} from "./fixtures.js";
import { routeEvent } from "./route.js";

const action = {
  ...humanAction(),
  key: "h(1)",
  status: "done" as const,
  requested_by: "assignment:A-1" as const,
  result: {
    text: "脱敏副本已准备好",
    attachments: [],
    at: "2030-01-01T00:00:00Z",
  },
};
const completed = event("human_action_completed", {
  human_action_id: action.id,
  resume_work_items: ["W-1"],
});

test("completion notifies its requester, resumed owners and waiting verifiers once with the result and card", () => {
  const result = routeEvent({
    event: completed,
    snapshot: snapshot({
      human_actions: [action],
      work_items: [
        workItem("W-1", { assignment_id: "A-1" }),
        workItem("W-2", {
          kind: "verify",
          status: "in_progress",
          assignment_id: "A-2",
        }),
        workItem("W-3", {
          kind: "verify",
          role_id: "pm",
          status: "todo",
          assignment_id: "A-3",
        }),
        workItem("W-4", {
          kind: "verify",
          card_id: "C-2",
          status: "blocked",
          assignment_id: "A-4",
        }),
      ],
      assignments: [
        assignment("A-1"),
        assignment("A-2"),
        assignment("A-3"),
        assignment("A-4"),
      ],
    }),
  });
  expect(result.notifications.map((n) => n.recipient)).toEqual([
    { kind: "assignment", assignment_id: "A-1" },
    { kind: "assignment", assignment_id: "A-2" },
    { kind: "assignment", assignment_id: "A-3" },
  ]);
  for (const n of result.notifications) {
    expect(n.kind).toBe("human_action");
    expect(n.summary).toBe("C-1 h(1): 已完成；脱敏副本已准备好");
  }
});

test.each([
  ["produce", "blocked", true],
  ["produce", "waiting_decision", true],
  ["produce", "delivered", true],
  ["produce", "in_progress", false],
  ["produce", "accepted", false],
  ["produce", "cancelled", false],
  ["verify", "todo", true],
  ["verify", "ready", true],
  ["verify", "in_progress", true],
  ["verify", "blocked", true],
  ["verify", "waiting_decision", true],
  ["verify", "passed", false],
  ["verify", "failed", false],
  ["verify", "cancelled", false],
])("only current waiting work is informed: %s/%s", (kind, status, notified) => {
  const result = routeEvent({
    event: completed,
    snapshot: snapshot({
      human_actions: [action],
      work_items: [workItem("W-2", { kind, status, assignment_id: "A-2" })],
    }),
  });
  expect(
    result.notifications.some((n) => n.recipient.assignment_id === "A-2"),
  ).toBe(notified);
});

test.each(["suspended", "released"])(
  "inactive requester (%s) falls back to Ops or Needs You; inactive waiters stay silent",
  (status) => {
    for (const opsActive of [false, true]) {
      const result = routeEvent({
        event: event("human_action_completed", { human_action_id: action.id }),
        snapshot: snapshot({
          human_actions: [action],
          assignments: [
            assignment("A-1", { status }),
            assignment("A-2", { status }),
            assignment("A-3", {
              scope: "standing",
              role_id: "pm",
              standing_mode: "ops",
              status: opsActive ? "active" : "suspended",
            }),
            assignment("A-4", {
              scope: "standing",
              role_id: "pm",
              standing_mode: "office",
            }),
          ],
        }),
      });
      expect(result.notifications.map((n) => n.recipient.kind)).toEqual([
        opsActive ? "pm_ops" : "needs_you",
      ]);
      expect(result.notifications[0]?.summary).toContain(action.result.text);
    }
  },
);
