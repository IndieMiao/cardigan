import type { HumanAction } from "@cardigan/domain";
import { expect, test } from "vitest";
import { event, humanAction, project_id, snapshot } from "./fixtures.js";
import { routeEvent } from "./route.js";

const blocking = (
  id: string,
  overrides: Partial<HumanAction> = {},
): HumanAction =>
  ({
    ...humanAction(id),
    status: "open",
    blocked_work_items: [],
    blocks_merge: true,
    triage: "pm_ops",
    ...overrides,
  }) as HumanAction;

const versions = (subject: string) => [
  { work_item_id: "W-1", delivery_id: "D-1", subject },
];
const updated = (
  payload: Record<string, unknown>,
  seq = 1,
): ReturnType<typeof event> =>
  event(
    "pre_merge_check_updated",
    {
      card_id: "C-1",
      label: "张良截图核对",
      checked_versions: versions("abc"),
      ...payload,
    },
    { seq },
  );
const passed = updated({ status: "passed", previous_status: "pending" });
const reminders = (
  e: ReturnType<typeof event>,
  overrides: Parameters<typeof snapshot>[0] = {},
) =>
  routeEvent({ event: e, snapshot: snapshot(overrides) }).notifications.filter(
    (n) => n.rule === "7.4/pre-merge check passed",
  );

test("C-179: a passed check reminds the triage owner of an open merge-blocking action once, with a direct link", () => {
  const notes = reminders(passed, {
    human_actions: [
      blocking("H-25", {
        handoff: { title: "确认截图" } as HumanAction["handoff"],
      }),
    ],
  });
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({
    recipient: { kind: "pm_ops" },
    kind: "human_action",
    card_id: "C-1",
  });
  expect(notes[0]?.summary).toBe(
    `合并前核对项「张良截图核对」已通过，H-25「确认截图」仍在挡合并，请确认是否可以完成：#/p/${project_id}/cards/C-1?at=human-action-H-25`,
  );
});

test("C-179: an action already handed to the human is reminded in Needs You", () => {
  const notes = reminders(passed, {
    human_actions: [
      blocking("H-1", { triage: "human" }),
      blocking("H-2", { triage: "host" }),
      blocking("H-3"),
    ],
  });
  expect(notes.map((n) => n.recipient.kind)).toEqual(["needs_you", "pm_ops"]);
  const human = notes[0]?.summary.split("\n") ?? [];
  expect(human).toHaveLength(2);
  expect(human[0]).toContain("H-1「Connect the device」");
  expect(human[1]).toContain("H-2");
  expect(notes[1]?.summary).toContain("H-3");
});

test("C-179: an action blocking one of the card's work items also counts", () => {
  const notes = reminders(passed, {
    human_actions: [
      blocking("H-1", { blocks_merge: undefined, blocked_work_items: ["W-1"] }),
    ],
  });
  expect(notes).toHaveLength(1);
});

test.each([
  ["no human action", []],
  ["a read-only escalation", [blocking("H-1", { blocks_merge: undefined })]],
  ["a completed action", [blocking("H-1", { status: "done" })]],
  [
    "an action on another card",
    [blocking("H-1", { card_id: "C-2" } as Partial<HumanAction>)],
  ],
] as const)("C-179: nothing is sent when there is %s", (_, actions) => {
  expect(
    reminders(passed, { human_actions: [...actions] as HumanAction[] }),
  ).toEqual([]);
});

test.each(["pending", "failed"])(
  "C-179: a check set to %s reminds nobody",
  (status) => {
    expect(
      reminders(updated({ status, previous_status: "passed" }), {
        human_actions: [blocking("H-1")],
      }),
    ).toEqual([]);
  },
);

test("C-179: a note-only edit of a passed check is not a new pass; a pass on a new version is", () => {
  const first = updated({ status: "passed", previous_status: "pending" }, 1);
  const human_actions = [blocking("H-1")];
  const noteOnly = updated(
    { status: "passed", previous_status: "passed", note: "补充" },
    2,
  );
  expect(reminders(noteOnly, { human_actions, events: [first] })).toEqual([]);
  const rework = updated(
    {
      status: "passed",
      previous_status: "passed",
      checked_versions: versions("def"),
    },
    2,
  );
  expect(reminders(rework, { human_actions, events: [first] })).toHaveLength(1);
});

test("C-179: the reminder never completes the action", () => {
  const action = blocking("H-1");
  const result = routeEvent({
    event: passed,
    snapshot: snapshot({ human_actions: [action] }),
  });
  expect(result.checks).toEqual([]);
  expect(action.status).toBe("open");
});
