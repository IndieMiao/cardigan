import type { Assignment, Event } from "@cardigan/domain";
import { describe, expect, test } from "vitest";
import {
  agent,
  assignment,
  decision,
  event,
  humanAction,
  snapshot,
} from "./fixtures.js";
import { routeEvent } from "./route.js";
import type { RoutedNotification, RouterSnapshot } from "./types.js";

/**
 * C-722: the five exception/pending events also reach the project's PM Office
 * on duty. The original recipients are exactly those of the same event routed
 * without an Office; the Office gets one notification, never two.
 */
const OFFICE = "A-10";
const OPS = "A-11";
const office = (fields: Record<string, unknown> = {}): Assignment =>
  assignment(OFFICE, {
    scope: "standing",
    role_id: "pm",
    standing_mode: "office",
    ...fields,
  });
const ops = assignment(OPS, {
  scope: "standing",
  role_id: "pm",
  standing_mode: "ops",
});

const withStaff = (
  base: RouterSnapshot,
  extra: readonly Assignment[],
): RouterSnapshot => ({
  ...base,
  assignments: [...base.assignments, ops, ...extra],
});

const key = (n: RoutedNotification) =>
  `${n.recipient.kind}:${n.recipient.assignment_id ?? ""}:${n.kind}:${n.rule}`;
const offices = (notes: readonly RoutedNotification[]) =>
  notes.filter((n) => n.recipient.kind === "pm_office");

interface Case {
  readonly name: string;
  readonly event: Event;
  readonly snapshot: RouterSnapshot;
  /** Original recipients that must be present with or without the Office. */
  readonly original: readonly string[];
  /** The rule already notified the Office before C-722. */
  readonly officeBefore?: boolean;
}

const cases: readonly Case[] = [
  {
    name: "human_action_requested (PM Ops triage)",
    event: event("human_action_requested", { human_action_id: "H-1" }),
    snapshot: snapshot({
      human_actions: [{ ...humanAction(), status: "open", triage: "pm_ops" }],
    }),
    original: ["pm_ops"],
  },
  {
    name: "human_action_requested (handed to the human)",
    event: event("human_action_requested", { human_action_id: "H-1" }),
    snapshot: snapshot({
      human_actions: [{ ...humanAction(), status: "open" }],
    }),
    original: ["needs_you"],
    officeBefore: true,
  },
  {
    name: "blocker_reported",
    event: event("blocker_reported", { work_item_id: "W-1" }),
    snapshot: snapshot(),
    original: ["pm_ops"],
  },
  {
    name: "blocker_reported (auto-resume wait)",
    event: event("blocker_reported", {
      work_item_id: "W-1",
      resume_when: { kind: "baseline_updated", target_id: "x" },
    }),
    snapshot: snapshot(),
    original: [],
  },
  {
    name: "run_inactive",
    event: event("run_inactive", { assignment_id: "A-1", run_id: "R-1" }),
    snapshot: snapshot(),
    original: [],
  },
  {
    name: "merge_conflicted",
    event: event("merge_conflicted", { work_item_id: "W-1" }),
    snapshot: snapshot(),
    original: ["assignment"],
  },
  {
    name: "decision_requested (PM)",
    event: event("decision_requested", { decision_id: "Q-1" }),
    snapshot: snapshot({
      decisions: [decision({ decider: "role:pm", status: "open" })],
    }),
    original: ["pm_ops"],
  },
];

describe("C-722 Office alert routing", () => {
  test.each(cases)(
    "$name: original recipients unchanged, Office notified once",
    (c) => {
      const before = routeEvent({
        event: c.event,
        snapshot: withStaff(c.snapshot, []),
      });
      const after = routeEvent({
        event: c.event,
        snapshot: withStaff(c.snapshot, [office()]),
      });
      for (const kind of c.original)
        expect(
          before.notifications.some((n) => n.recipient.kind === kind),
        ).toBe(true);
      // Everything routed before is still routed, unchanged and in order.
      const others = (notes: readonly RoutedNotification[]) =>
        notes.filter((n) => n.recipient.kind !== "pm_office");
      expect(others(after.notifications)).toEqual(others(before.notifications));
      expect(offices(before.notifications)).toHaveLength(
        c.officeBefore ? 1 : 0,
      );
      expect(offices(after.notifications)).toHaveLength(1);
      if (c.officeBefore)
        // The earlier rule keeps its own notification; nothing is added on top.
        expect(offices(after.notifications).map(key)).toEqual(
          offices(before.notifications).map(key),
        );
      else
        expect(offices(after.notifications)[0]?.rule).toBe(
          "C-722/office alert",
        );
      expect(after.problems).toEqual(before.problems);
      expect(after.checks).toEqual(before.checks);
    },
  );

  test.each([
    ["suspended", { status: "suspended" }],
    ["released", { status: "released" }],
    ["not standing_mode=office", { standing_mode: undefined }],
  ])("an Office that is %s is skipped without error", (_, fields) => {
    for (const c of cases) {
      const before = routeEvent({
        event: c.event,
        snapshot: withStaff(c.snapshot, []),
      });
      const after = routeEvent({
        event: c.event,
        snapshot: withStaff(c.snapshot, [office(fields)]),
      });
      expect(after).toEqual(before);
    }
  });

  test("the Office is not told about its own request or its own inactivity", () => {
    const own = routeEvent({
      event: event(
        "decision_requested",
        { decision_id: "Q-1" },
        { actor: agent(OFFICE) },
      ),
      snapshot: withStaff(
        snapshot({
          decisions: [decision({ decider: "role:pm", status: "open" })],
        }),
        [office()],
      ),
    });
    expect(offices(own.notifications)).toEqual([]);
    expect(own.notifications.map((n) => n.recipient.kind)).toEqual(["pm_ops"]);
    const idle = routeEvent({
      event: event("run_inactive", { assignment_id: OFFICE }, { card: false }),
      snapshot: withStaff(snapshot(), [office()]),
    });
    expect(idle.notifications).toEqual([]);
  });

  test("settled or system-only questions and closed actions are no pending work", () => {
    for (const q of [
      decision({ decider: "system", status: "open" }),
      decision({ decider: "role:pm", status: "resolved" }),
    ]) {
      const routed = routeEvent({
        event: event("decision_requested", { decision_id: "Q-1" }),
        snapshot: withStaff(snapshot({ decisions: [q] }), [office()]),
      });
      expect(offices(routed.notifications)).toEqual([]);
    }
    const closed = routeEvent({
      event: event("human_action_requested", { human_action_id: "H-1" }),
      snapshot: withStaff(
        snapshot({
          human_actions: [
            { ...humanAction(), status: "completed", triage: "pm_ops" },
          ],
        }),
        [office()],
      ),
    });
    expect(offices(closed.notifications)).toEqual([]);
  });

  test("routine progress never rings the Office", () => {
    for (const type of [
      "card_merged",
      "delivery_submitted",
      "review_submitted",
      "card_updated",
      "host_deployment_recorded",
    ]) {
      const routed = routeEvent({
        event: event(type, { delivery_id: "D-1" }),
        snapshot: withStaff(snapshot(), [office()]),
      });
      expect(offices(routed.notifications)).toEqual([]);
    }
  });

  test("another project's event does not reach this project's Office", () => {
    const foreign = {
      ...event("blocker_reported", { work_item_id: "W-1" }),
      actor: { kind: "system", project_id: "p-other" },
    } as unknown as Event;
    const routed = routeEvent({
      event: foreign,
      snapshot: withStaff(snapshot(), [office()]),
    });
    expect(offices(routed.notifications)).toEqual([]);
  });
});
