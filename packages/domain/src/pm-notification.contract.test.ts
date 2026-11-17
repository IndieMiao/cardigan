import { beforeEach, expect, test } from "vitest";
import { f, setup } from "./commands/launch/test-fixtures.js";
import {
  type Notification,
  orderPmNotificationGroups,
  pmNotificationState,
} from "./index.js";

beforeEach(setup);
test("N1 preserves old, project and other-recipient slots and stable order within urgency", () => {
  const queue = [
    "old",
    "new ordinary",
    "project",
    "new urgent 1",
    "office",
    "new urgent 2",
    "new ordinary 2",
  ];
  const result = orderPmNotificationGroups(queue, (n) =>
    n.startsWith("new")
      ? { recipient: "ops", urgent: n.includes("urgent") }
      : undefined,
  );
  expect(result).toEqual([
    "old",
    "new urgent 1",
    "project",
    "new urgent 2",
    "office",
    "new ordinary",
    "new ordinary 2",
  ]);
  expect(queue[1]).toBe("new ordinary");
});
test.each(["decision_requested", "human_action_requested"])(
  "%s: unknown stays urgent, resolved request retires, result remains deliverable",
  (type) => {
    const event = {
      id: "event" as never,
      seq: 1,
      type,
      actor: { kind: "system" as const, project_id: f.state.project_id },
      payload:
        type === "decision_requested"
          ? { decision_id: "Q-1" }
          : { human_action_id: "H-1" },
      created_at: f.io.clock.now(),
    };
    f.state = { ...f.state, events: [event] };
    const note: Notification = {
      id: "fixture-note",
      project_id: f.state.project_id,
      event_id: event.id,
      seq: 1,
      recipient: { kind: "pm_ops" },
      kind: "decision",
      status: "pending",
      attempts: 0,
      created_at: f.io.clock.now(),
      updated_at: f.io.clock.now(),
    };
    expect(pmNotificationState(f.state, note)).toBe("urgent");
    f.state = {
      ...f.state,
      decisions: [{ id: "Q-1", status: "resolved" } as never],
      human_actions: [{ id: "H-1", status: "done" } as never],
    };
    expect(pmNotificationState(f.state, note)).toBe("obsolete");
    f.state = {
      ...f.state,
      events: [
        {
          ...event,
          type:
            type === "decision_requested"
              ? "decision_resolved"
              : "human_action_completed",
        },
      ],
    };
    expect(pmNotificationState(f.state, note)).toBe("ordinary");
  },
);
