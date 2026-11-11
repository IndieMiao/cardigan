import { expect, test } from "vitest";
import {
  agent,
  assignment,
  card,
  event,
  human,
  snapshot,
  workItem,
} from "./fixtures.js";
import { routeEvent } from "./route.js";

test.each([human(), agent("A-1")])(
  "cross-card and orphan @A mentions go to Ops once, with an explanation (%j)",
  (actor) => {
    const base = snapshot();
    const result = routeEvent({
      event: event(
        "comment_posted",
        { mentions: ["@A-9", "@A-10", "@A-2", "@A-2"] },
        { actor },
      ),
      snapshot: snapshot({
        cards: [card({ status: "done" }), card({ id: "C-2" })],
        assignments: [
          ...base.assignments,
          assignment("A-9", { work_item_id: "W-9" }),
          assignment("A-10", { work_item_id: "W-10" }),
        ],
        work_items: [
          ...base.work_items,
          workItem("W-9", { card_id: "C-2", assignment_id: "A-9" }),
        ],
      }),
    });
    expect(result.notifications.map((n) => n.recipient)).toEqual([
      { kind: "pm_ops" },
      { kind: "assignment", assignment_id: "A-2" },
    ]);
    expect(result.problems).toEqual(
      ["A-9", "A-10"].map((id) => ({
        rule: "6.5/explicit assignment or work item",
        code: "assignment_cannot_read_card",
        detail: expect.stringContaining(`@${id} 无权读取本卡`),
      })),
    );
  },
);

test("same-card, standing and project-stream explicit mentions remain readable; self mentions stay silent", () => {
  expect(
    routeEvent({
      event: event(
        "comment_posted",
        { mentions: ["@A-1", "@A-2", "@A-3"] },
        { actor: agent("A-1") },
      ),
      snapshot: snapshot(),
    }).notifications.map((n) => n.recipient),
  ).toEqual([
    { kind: "assignment", assignment_id: "A-2" },
    { kind: "assignment", assignment_id: "A-3" },
  ]);
  const result = routeEvent({
    event: event("comment_posted", { mentions: ["@A-1"] }, { card: false }),
    snapshot: snapshot(),
  });
  expect(result.problems).toEqual([]);
  expect(result.notifications[0]?.recipient).toEqual({
    kind: "assignment",
    assignment_id: "A-1",
  });
});
