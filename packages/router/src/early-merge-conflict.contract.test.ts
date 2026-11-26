import { EARLY_MERGE_CONFLICT } from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  agent,
  assignment,
  card,
  delivery,
  event,
  project_id,
  snapshot,
  workItem,
} from "./fixtures.js";
import { routeEvent } from "./route.js";

// C-782: a trial-merge conflict on the current delivery tells only its author.
const body =
  "W-1 的交付 D-1（aaaaaaaa）在 main 最新基线 bbbbbbbb 上试合并冲突：a.ts。";
const conflict = (actor = { kind: "system" as const, project_id }) =>
  event(
    EARLY_MERGE_CONFLICT,
    { work_item_id: "W-1", delivery_id: "D-1", files: ["a.ts"], body },
    { actor },
  );
const head = (id: string, overrides: Record<string, unknown> = {}) =>
  delivery(id, {
    subject: { kind: "git_head", value: "a".repeat(40) },
    ...overrides,
  });
const state = (
  deliveries = [head("D-1")],
  owner = assignment("A-1", { work_item_id: "W-1" }),
) =>
  snapshot({
    cards: [card({ status: "review" })],
    work_items: [
      workItem("W-1", { assignment_id: "A-1", status: "delivered" }),
    ],
    assignments: [owner],
    deliveries,
  });

test("the idle author is told to merge the baseline and resolve the conflict", () => {
  expect(
    routeEvent({ event: conflict(), snapshot: state() }).notifications,
  ).toMatchObject([
    {
      recipient: { kind: "assignment", assignment_id: "A-1" },
      kind: "instruction",
      rule: "C-782/early merge conflict",
      work_item_id: "W-1",
      summary: expect.stringMatching(
        new RegExp(`^${body}.*已知遗漏和附件原样沿用上一版`, "u"),
      ),
    },
  ]);
});

test("a redelivered head, an inactive author or a forged actor routes nothing, not even to PM", () => {
  for (const input of [
    {
      event: conflict(),
      snapshot: state([head("D-1", { status: "superseded" }), head("D-2")]),
    },
    {
      event: conflict(),
      snapshot: state(
        undefined,
        assignment("A-1", { work_item_id: "W-1", status: "released" }),
      ),
    },
    { event: conflict(agent("A-1") as never), snapshot: state() },
  ])
    expect(routeEvent(input).notifications).toEqual([]);
});
