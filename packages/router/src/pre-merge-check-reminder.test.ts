import type { HumanAction } from "@cardigan/domain";
import { PRE_MERGE_CHECK_REMINDED } from "@cardigan/domain";
import { expect, test } from "vitest";
import { event, humanAction, snapshot } from "./fixtures.js";
import { routeEvent } from "./route.js";

const open = (id: string, overrides: Partial<HumanAction> = {}) =>
  ({ ...humanAction(id), status: "open", ...overrides }) as HumanAction;
const reminder = (id: string, recipient: "pm_ops" | "needs_you") => ({
  human_action_id: id,
  title: "确认截图",
  recipient,
  link: `#/p/p-routing/cards/C-1?at=human-action-${id}`,
  text: `合并前核对项「张良截图核对」已通过，${id}「确认截图」仍在挡合并，请确认是否可以完成`,
});
const reminded = (reminders: readonly unknown[]) =>
  event(PRE_MERGE_CHECK_REMINDED, {
    card_id: "C-1",
    label: "张良截图核对",
    reminders,
  });
const route = (
  e: ReturnType<typeof event>,
  human_actions: readonly HumanAction[],
) =>
  routeEvent({
    event: e,
    snapshot: snapshot({ human_actions: [...human_actions] }),
  }).notifications.filter((n) => n.rule === "7.4/pre-merge check passed");

test("C-179: the persisted reminder rings each triage owner once with its text and link", () => {
  const notes = route(
    reminded([
      reminder("H-1", "pm_ops"),
      reminder("H-2", "needs_you"),
      reminder("H-3", "needs_you"),
    ]),
    [open("H-1"), open("H-2"), open("H-3")],
  );
  expect(notes.map((n) => [n.recipient.kind, n.kind])).toEqual([
    ["pm_ops", "human_action"],
    ["needs_you", "needs_you"],
  ]);
  expect(notes[0]?.summary).toBe(
    "合并前核对项「张良截图核对」已通过，H-1「确认截图」仍在挡合并，请确认是否可以完成：#/p/p-routing/cards/C-1?at=human-action-H-1",
  );
  expect(notes[1]?.summary.split("\n")).toHaveLength(2);
  for (const n of notes) expect(n.card_id).toBe("C-1");
});

test("C-179: an action closed before routing is not rung", () => {
  expect(
    route(reminded([reminder("H-1", "pm_ops")]), [
      open("H-1", { status: "done" }),
    ]),
  ).toEqual([]);
});

test("C-179: the check update itself rings nobody about human actions", () => {
  expect(
    route(
      event("pre_merge_check_updated", {
        card_id: "C-1",
        label: "张良截图核对",
        status: "passed",
        previous_status: "pending",
      }),
      [
        open("H-1", {
          blocks_merge: true,
          prerequisite: "external_account" as const,
          triage: "pm_ops",
        }),
      ],
    ),
  ).toEqual([]);
});

test("C-179: routing never completes the action", () => {
  const action = open("H-1");
  const result = routeEvent({
    event: reminded([reminder("H-1", "pm_ops")]),
    snapshot: snapshot({ human_actions: [action] }),
  });
  expect(result.checks).toEqual([]);
  expect(action.status).toBe("open");
});
