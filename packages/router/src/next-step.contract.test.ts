import { expect, test } from "vitest";
import {
  assignment,
  card,
  event,
  project_id,
  run,
  snapshot,
  workItem,
} from "./fixtures.js";
import { routeEvent } from "./route.js";
import type { RouteResult } from "./types.js";

/** C-789: next-step registration and managed rotation routing. */
const system = { actor: { kind: "system" as const, project_id } };
const recipients = (result: RouteResult) =>
  result.notifications.map((n) =>
    n.recipient.kind === "assignment"
      ? `assignment:${n.recipient.assignment_id}`
      : n.recipient.kind,
  );
const owned = (status: string) =>
  snapshot({
    cards: [card({ status: "in_progress" })],
    work_items: [workItem("W-1", { assignment_id: "A-1", status })],
    assignments: [assignment("A-1", { work_item_id: "W-1" })],
  });

test("a system-registered blocker for a blocked finish reaches the PM Ops queue", () => {
  const result = routeEvent({
    event: event(
      "blocker_reported",
      { work_item_id: "W-1", needs: "role", auto_registered: true },
      system,
    ),
    snapshot: owned("blocked"),
  });
  expect(recipients(result)).toContain("pm_ops");
});

test.each([
  [{}, ["pm_ops"]],
  [{ auto_registered: true }, ["pm_ops"]],
  [{ condition: { kind: "baseline_updated", target_id: "a".repeat(40) } }, []],
  [
    {
      condition: { kind: "resource_available", target_id: "godot" },
      auto_resume_disabled: true,
    },
    ["pm_ops"],
  ],
])(
  "a standby registration goes to PM only without a verifiable condition: %j",
  (payload, expected) => {
    const result = routeEvent({
      event: event(
        "work_item_standby_registered",
        { work_item_id: "W-1", ...payload },
        system,
      ),
      snapshot: owned("accepted"),
    });
    expect(recipients(result).filter((r) => r === "pm_ops")).toEqual(expected);
  },
);

test.each(["delivered", "accepted", "changes_requested"])(
  "a system standby wake rings the %s owner without needing a state change",
  (status) => {
    const wake = (extra: Record<string, unknown>, actor = system) =>
      routeEvent({
        event: event(
          "work_item_resume_requested",
          {
            work_item_id: "W-1",
            assignment_id: "A-1",
            role_version: 1,
            ...extra,
          },
          actor,
        ),
        snapshot: owned(status),
      });
    const expected = status === "changes_requested" ? [] : ["assignment:A-1"];
    expect(recipients(wake({ standby: true }))).toEqual(expected);
    // Only the system's standby wake skips the state check.
    expect(recipients(wake({}))).toEqual([]);
  },
);

test("a completed Run that registered a standby wait produced its next step", () => {
  const result = routeEvent({
    event: event("run_finished", { run_id: "R-1", outcome: "completed" }),
    snapshot: {
      ...owned("accepted"),
      runs: [run("R-1", { assignment_id: "A-1" })],
      events: [
        event(
          "work_item_standby_registered",
          {
            work_item_id: "W-1",
            run_id: "R-1",
            condition: { kind: "baseline_updated", target_id: "a".repeat(40) },
          },
          { seq: 2 },
        ),
      ],
    },
  });
  expect(recipients(result)).toEqual([]);
});

test("a spent rotation allowance goes to PM; other skips are only recorded", () => {
  const skip = (reason: string) =>
    recipients(
      routeEvent({
        event: event(
          "session_rotation_skipped",
          { assignment_id: "A-1", signal: "inactive", reason },
          system,
        ),
        snapshot: owned("in_progress"),
      }),
    );
  expect(skip("allowance_used")).toContain("pm_ops");
  expect(skip("nothing_unread")).toEqual([]);
  expect(skip("no_exit_proof")).toEqual([]);
});

test("a rotation wake rings the in-progress owner", () => {
  const result = routeEvent({
    event: event(
      "work_item_resume_requested",
      {
        work_item_id: "W-1",
        assignment_id: "A-1",
        role_version: 1,
        rotation: true,
      },
      system,
    ),
    snapshot: owned("in_progress"),
  });
  expect(recipients(result)).toEqual(["assignment:A-1"]);
});
