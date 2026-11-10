import { expect, test } from "vitest";
import {
  assignment,
  decision,
  event,
  humanAction,
  snapshot,
} from "./fixtures.js";
import { routeEvent } from "./route.js";

test.each(["general", "feature_detail", "scope_change"])(
  "authorized %s goes only to PM Ops",
  (category) => {
    const routed = routeEvent({
      event: event("decision_requested", { decision_id: "q(1)" }),
      snapshot: snapshot({
        decisions: [decision({ decider: "role:pm", category })],
      }),
    });
    expect(routed.notifications.map((n) => n.recipient)).toEqual([
      { kind: "pm_ops" },
    ]);
  },
);
test("resolved nonblocking decisions notify their standing initiator with choice and impact", () => {
  const q = decision({
    raised_by: "assignment:A-8",
    status: "resolved",
    blocking: false,
    affected_work_items: [],
    options: [
      { key: "close", description: "关闭旧卡", impact: "创建新卡继续" },
    ],
    resolution: { option: "close", via: "delegated" },
  });
  const input = {
    event: event("decision_resolved", {
      decision_id: q.id,
      resume_work_items: [],
    }),
    snapshot: snapshot({
      decisions: [q],
      assignments: [
        assignment("A-8", {
          scope: "standing",
          role_id: "pm",
          standing_mode: "office",
        }),
      ],
    }),
  };
  const notes = routeEvent(input).notifications;
  expect(notes).toMatchObject([
    {
      recipient: { kind: "assignment", assignment_id: "A-8" },
      summary: expect.stringContaining("创建新卡继续"),
    },
  ]);
  expect(notes[0]?.summary).toContain("请发起人落实");
  expect(
    routeEvent({
      ...input,
      event: event("decision_followup_due", { decision_id: q.id }),
    }).notifications,
  ).toMatchObject([
    {
      recipient: { kind: "needs_you" },
      summary: expect.stringContaining("30 分钟"),
    },
  ]);
});
test("action triage stays out of Needs You until the PM hands it to a host operator", () => {
  const action = { ...humanAction(), triage: "pm_ops" as const };
  const input = {
    event: event("human_action_requested", { human_action_id: action.id }),
    snapshot: snapshot({ human_actions: [action] }),
  };
  expect(routeEvent(input).notifications.map((n) => n.recipient.kind)).toEqual([
    "pm_ops",
  ]);
  expect(
    routeEvent({
      ...input,
      snapshot: snapshot({ human_actions: [{ ...action, triage: "host" }] }),
    }).notifications.map((n) => n.recipient.kind),
  ).toEqual(["needs_you", "pm_office"]);
});

test.each(["active", "suspended", "released"] as const)(
  "decision follow-up recipient matches shared request routing when requester is %s",
  (status) => {
    for (const ops of [false, true]) {
      const q = decision({
        raised_by: "assignment:A-8",
        status: "resolved",
        options: [{ key: "go", description: "继续", impact: "安排后续工作" }],
        resolution: { option: "go" },
      });
      const assignments = [
        assignment("A-8", { status }),
        ...(ops
          ? [
              assignment("A-9", {
                scope: "standing",
                role_id: "pm",
                standing_mode: "ops",
              }),
            ]
          : []),
      ];
      const state = snapshot({ decisions: [q], assignments });
      const routed = routeEvent({
        event: event("decision_resolved", {
          decision_id: q.id,
          resume_work_items: [],
        }),
        snapshot: state,
      });
      expect(routed.notifications.map((n) => n.recipient)).toEqual([
        status === "active"
          ? { kind: "assignment", assignment_id: "A-8" }
          : { kind: ops ? "pm_ops" : "needs_you" },
      ]);
      const reminder = routeEvent({
        event: event("decision_followup_due", { decision_id: q.id }),
        snapshot: state,
      });
      expect(reminder.notifications.map((n) => n.recipient)).toEqual([
        { kind: ops ? "pm_ops" : "needs_you" },
      ]);
    }
  },
);
