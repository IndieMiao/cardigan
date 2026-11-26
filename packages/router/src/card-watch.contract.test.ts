import { CARD_WATCH_ENDED, CARD_WATCH_TRIGGERED } from "@cardigan/domain";
import { describe, expect, test } from "vitest";
import {
  agent,
  assignment,
  event,
  project_id,
  snapshot,
  workItem,
} from "./fixtures.js";
import { routeEvent } from "./route.js";

const system = { kind: "system" as const, project_id };
const settled = (
  type: string,
  recipient: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  actor: typeof system | ReturnType<typeof agent> = system,
) =>
  event(
    type,
    {
      watch_id: "E-0",
      target_card_id: "C-2",
      until: "done",
      recipient,
      registered_at: "2026-01-01T00:00:00.000Z",
      notice: `C-2 ${type === CARD_WATCH_TRIGGERED ? "已完成" : "已取消"}`,
      ...extra,
    },
    { actor, seq: 7 },
  );

describe("C-763 card watch bells", () => {
  test.each([CARD_WATCH_TRIGGERED, CARD_WATCH_ENDED])(
    "%s rings the registered standing PM with the system's notice",
    (type) => {
      const result = routeEvent({
        event: settled(type, { kind: "assignment", assignment_id: "A-3" }),
        snapshot: snapshot(),
      });
      expect(result.notifications).toEqual([
        expect.objectContaining({
          recipient: { kind: "assignment", assignment_id: "A-3" },
          kind: "dependency",
          rule: "C-763/card watch",
          event_id: "E-7",
          card_id: "C-1",
          summary: `C-2 ${type === CARD_WATCH_TRIGGERED ? "已完成" : "已取消"}`,
        }),
      ]);
    },
  );

  test("a work-item PM is rung on its work item; the trigger and end bells differ", () => {
    const state = snapshot({
      work_items: [workItem("W-3", { kind: "verify", role_id: "pm" })],
      assignments: [assignment("A-5", { role_id: "pm", work_item_id: "W-3" })],
    });
    const to = { kind: "assignment", assignment_id: "A-5" };
    const [reached] = routeEvent({
      event: settled(CARD_WATCH_TRIGGERED, to),
      snapshot: state,
    }).notifications;
    const [ended] = routeEvent({
      event: settled(CARD_WATCH_ENDED, to, { reason: "cancelled" }),
      snapshot: state,
    }).notifications;
    expect(reached).toMatchObject({ work_item_id: "W-3" });
    expect(ended).toMatchObject({ work_item_id: "W-3" });
    expect(reached?.summary).not.toEqual(ended?.summary);
  });

  test("PM Ops inbox, and a released registrant falls back to PM Ops", () => {
    expect(
      routeEvent({
        event: settled(CARD_WATCH_TRIGGERED, { kind: "pm_ops" }),
        snapshot: snapshot(),
      }).notifications.map((n) => n.recipient),
    ).toEqual([{ kind: "pm_ops" }]);
    for (const assignments of [
      [
        assignment("A-3", {
          scope: "standing",
          role_id: "pm",
          status: "released",
        }),
      ],
      [],
    ])
      expect(
        routeEvent({
          event: settled(CARD_WATCH_ENDED, {
            kind: "assignment",
            assignment_id: "A-3",
          }),
          snapshot: snapshot({ assignments }),
        }).notifications.map((n) => n.recipient),
      ).toEqual([{ kind: "pm_ops" }]);
  });

  test("routing the same settlement again yields the same single bell", () => {
    const fact = settled(CARD_WATCH_TRIGGERED, {
      kind: "assignment",
      assignment_id: "A-3",
    });
    const first = routeEvent({
      event: fact,
      snapshot: snapshot({ events: [fact] }),
    });
    const second = routeEvent({
      event: fact,
      snapshot: snapshot({ events: [fact] }),
    });
    expect(first.notifications).toHaveLength(1);
    expect(second).toEqual(first);
  });

  test("a settlement not written by the system rings nobody", () => {
    expect(
      routeEvent({
        event: settled(
          CARD_WATCH_TRIGGERED,
          { kind: "pm_ops" },
          {},
          agent("A-1"),
        ),
        snapshot: snapshot(),
      }).notifications,
    ).toEqual([]);
  });
});
