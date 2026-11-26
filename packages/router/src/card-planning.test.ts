import { expect, test } from "vitest";
import {
  agent,
  assignment,
  card,
  entry,
  event,
  human,
  project_id,
  snapshot,
} from "./fixtures.js";
import { summarizeNotifications } from "./merge.js";
import { routeEvent } from "./route.js";

test.each([human(), agent("A-office"), agent("A-coder")])(
  "new cards reach Ops regardless of their creator ($kind)",
  (actor) => {
    const result = routeEvent({
      event: event("card_created", {}, { actor }),
      snapshot: snapshot({ cards: [card({ status: "todo" })] }),
    });
    expect(result.notifications).toMatchObject([
      {
        recipient: { kind: "pm_ops" },
        kind: "card",
        card_id: "C-1",
        seq: 1,
        rule: "6.4/card needs planning",
      },
    ]);
    expect(summarizeNotifications(result.notifications)).toBe("1 card");
  },
);

test.each(["todo", "backlog"])(
  "planning cards in %s remain visible to Ops",
  (status) => {
    expect(
      routeEvent({
        event: event("card_created"),
        snapshot: snapshot({ cards: [card({ status })], assignments: [] }),
      }).notifications,
    ).toHaveLength(1);
  },
);

test.each(["done", "cancelled"])(
  "closed cards (%s) do not create stale planning bells",
  (status) => {
    expect(
      routeEvent({
        event: event("card_created"),
        snapshot: snapshot({ cards: [card({ status })] }),
      }).notifications,
    ).toEqual([]);
  },
);

test.each(["active", "released"])(
  "only the active Ops creator suppresses its own bell (%s)",
  (status) => {
    const result = routeEvent({
      event: event("card_created", {}, { actor: agent("A-ops") }),
      snapshot: snapshot({
        assignments: [
          assignment("A-ops", {
            scope: "standing",
            role_id: "pm",
            standing_mode: "ops",
            status,
          }),
        ],
      }),
    });
    expect(result.notifications).toHaveLength(status === "active" ? 0 : 1);
  },
);

test("promoting an existing card to todo wakes Ops; editing its title does not", () => {
  for (const status of ["backlog", "todo"]) {
    const result = routeEvent({
      event: event("card_updated", { status: "todo" }, { seq: 3 }),
      snapshot: snapshot({
        events: [
          event("card_updated", { status }, { seq: 2 }),
          event("card_created"),
        ],
      }),
    });
    expect(result.notifications).toHaveLength(status === "backlog" ? 1 : 0);
  }
});

test("story planning and settlement ring Office; the summary requests human confirmation", () => {
  for (const [type, recipient] of [
    ["card_created", "pm_office"],
    ["story_children_settled", "pm_office"],
    ["story_summary_submitted", "needs_you"],
  ] as const) {
    const state = snapshot({
      cards: [
        card({
          story:
            type === "story_summary_submitted"
              ? { summary_entry_id: "C-1#3" }
              : {},
          status: "todo",
        }),
      ],
    });
    expect(
      routeEvent({
        event: event(
          type,
          { entry_id: "C-1#3" },
          {
            actor:
              type === "story_summary_submitted"
                ? agent("A-office")
                : { kind: "system", project_id: state.project_id },
          },
        ),
        snapshot: state,
      }).notifications.map((n) => n.recipient.kind),
    ).toEqual([recipient]);
  }
});

test("C-762: an external Office escalation reaches Needs You and the timed handoff reaches PM Ops; both stop once summarized or closed", () => {
  const system = { kind: "system", project_id } as ReturnType<
    typeof event
  >["actor"];
  const route = (
    type: "story_summary_escalated" | "story_summary_handed_off",
    story: { summary_entry_id?: string } = {},
    status = "in_progress",
    actor: ReturnType<typeof event>["actor"] = system,
  ) =>
    routeEvent({
      event: event(type, { notice: "N" }, { actor }),
      snapshot: snapshot({ cards: [card({ story, status })] }),
    }).notifications.map((n) => [n.recipient.kind, n.kind, n.rule, n.summary]);
  expect(route("story_summary_escalated")).toEqual([
    ["needs_you", "needs_you", "story/summary escalated", "N"],
  ]);
  expect(route("story_summary_handed_off")).toEqual([
    ["pm_ops", "card", "story/summary handoff", "N"],
  ]);
  for (const type of [
    "story_summary_escalated",
    "story_summary_handed_off",
  ] as const) {
    expect(route(type, { summary_entry_id: "C-1#3" })).toEqual([]);
    expect(route(type, {}, "done")).toEqual([]);
    expect(route(type, {}, "in_progress", agent("A-office"))).toEqual([]);
  }
  // The settlement itself still rings only the Office, external or not.
  for (const external of [true, false])
    expect(
      routeEvent({
        event: event("story_children_settled", {}, { actor: system }),
        snapshot: snapshot({
          cards: [card({ story: {}, status: "in_progress" })],
          assignments: [
            assignment("A-office", {
              scope: "standing",
              role_id: "pm",
              standing_mode: "office",
              external,
            }),
          ],
        }),
      }).notifications.map((n) => n.recipient.kind),
    ).toEqual(["pm_office"]);
});

test("unmentioned human story comments belong to Office with a distinct FYI to Ops; explicit targets and children keep their routes", () => {
  const routes = (
    c: ReturnType<typeof card>,
    mentions: string[] = [],
    author = human(),
  ) =>
    routeEvent({
      event: event("comment_posted", {}, { actor: author }),
      snapshot: snapshot({ cards: [c], timeline: [entry(1, { mentions })] }),
    }).notifications.map((n) => [n.recipient, n.kind]);
  expect(routes(card({ story: {} }))).toEqual([
    [{ kind: "pm_office" }, "comment"],
    [{ kind: "pm_ops" }, "story_fyi"],
  ]);
  expect(routes(card({ story: {} }), [], agent("A-1"))).toEqual([]);
  expect(routes(card({ story: {} }), ["@A-1"])).toEqual([
    [{ kind: "assignment", assignment_id: "A-1" }, "comment"],
  ]);
  expect(routes(card({ parent_card_id: "C-5" }))).toEqual([
    [{ kind: "pm_ops" }, "comment"],
  ]);
});
