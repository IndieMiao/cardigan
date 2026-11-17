import { expect, test } from "vitest";
import { card, delivery, event, project_id, snapshot } from "./fixtures.js";
import { routeEvent } from "./route.js";

test("C-405: a current stalled merge goes only to PM; stale and user-authored observations do not ring", () => {
  const reminder = event(
    "merge_blocked_reminded",
    {
      completion_id: "D-1",
      body: "请 PM 核查三次远程验证，并由 PM Office 更新当前版本结论",
    },
    { actor: { kind: "system", project_id } },
  );
  const state = snapshot({
    cards: [card({ status: "awaiting_merge" })],
    deliveries: [
      delivery("D-1", { status: "accepted", kind: "card_completion" }),
    ],
  });
  const notes = routeEvent({ event: reminder, snapshot: state }).notifications;
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({
    recipient: { kind: "pm_ops" },
    rule: "6.4/automatic merge blocked",
  });
  expect(notes[0]?.summary).toContain("PM Office");
  for (const changed of [
    {
      ...state,
      events: [
        event(
          "merge_unblocked",
          {},
          { seq: 2, actor: { kind: "system", project_id } },
        ),
      ],
    },
    { ...state, cards: [card({ status: "done" })] },
    { ...state, deliveries: [delivery("D-1", { status: "superseded" })] },
  ])
    expect(
      routeEvent({ event: reminder, snapshot: changed }).notifications,
    ).toEqual([]);
  expect(
    routeEvent({
      event: { ...reminder, actor: { kind: "human", project_id } },
      snapshot: state,
    }).notifications,
  ).toEqual([]);
});
