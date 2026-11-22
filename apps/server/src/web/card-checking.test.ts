import type { CommandState, Delivery, Event, WorkItem } from "@cardigan/domain";
import { describe, expect, test } from "vitest";
import {
  fixture,
  id,
} from "../../../../packages/domain/src/commands/test-fixtures.js";
import { cardCheckingIndex } from "./card-checking.js";
import { cardSummary } from "./cards-page.js";
import { cardListViews } from "./read.js";

// C-567: what the board shows while a precheck or merge check is in flight.

const card1 = id("card", 1);
let seq = 0;
function systemEvent(type: string, payload: Record<string, unknown>): Event {
  seq += 1;
  return {
    id: `event-${seq}`,
    project_id: fixture().project_id,
    card_id: card1,
    seq,
    type,
    actor: { kind: "system", project_id: fixture().project_id },
    created_at: "2026-01-01T00:00:00.000Z",
    payload,
  } as unknown as Event;
}
const precheck = (status: string) =>
  systemEvent(
    status === "queued"
      ? "precheck_queued"
      : status === "running"
        ? "precheck_started"
        : "precheck_finished",
    {
      attempt_id: "attempt-1",
      assignment_id: id("assignment", 1),
      work_item_id: id("work_item", 1),
      card_id: card1,
      head_sha: "a".repeat(40),
      status,
      branch: "feature",
      machine_id: "local",
    },
  );
const waitingForPrecheck: Partial<WorkItem> = {
  status: "blocked",
  reported_blocker: {
    reason: "等预检",
    needs: "role",
    reported_by: `assignment:${id("assignment", 1)}`,
    reported_at: "2026-01-01T00:00:00.000Z",
    resume_when: { kind: "precheck_finished", target_id: "attempt-1" },
  },
} as Partial<WorkItem>;

function state(
  events: readonly Event[],
  item: Partial<WorkItem> = waitingForPrecheck,
): CommandState {
  const base = fixture();
  return {
    ...base,
    work_items: base.work_items.map((w) =>
      w.id === id("work_item", 1) ? ({ ...w, ...item } as WorkItem) : w,
    ),
    events: [...events],
  };
}
const listed = (s: CommandState) => {
  const view = cardListViews(s).find((c) => c.id === card1);
  if (!view) throw new Error("missing card");
  return view;
};

describe("precheck in flight", () => {
  test.each(["queued", "running"])(
    "a %s precheck marks the card and the item that waits for it",
    (status) => {
      const view = listed(state([precheck(status)]));
      expect(view.checking).toStrictEqual({
        precheck: {
          attempt_ids: ["attempt-1"],
          waiting_items: [id("work_item", 1)],
        },
      });
      // The domain wait list is unchanged; the list row carries the marker.
      expect(view.waiting_on).toContainEqual(
        expect.objectContaining({ kind: "blocked", ref: id("work_item", 1) }),
      );
      expect(cardSummary(view).checking).toStrictEqual(view.checking);
    },
  );

  test.each(["passed", "failed", "timed_out"])(
    "a %s precheck clears the marker and leaves the blocker as is",
    (status) => {
      const view = listed(state([precheck("queued"), precheck(status)]));
      expect(view.checking).toBeUndefined();
      expect("checking" in cardSummary(view)).toBe(false);
      expect(view.waiting_on).toContainEqual(
        expect.objectContaining({ kind: "blocked", ref: id("work_item", 1) }),
      );
    },
  );

  test("a real blocker during a running precheck is not counted as a precheck wait", () => {
    const view = listed(
      state([precheck("running")], {
        status: "blocked",
        reported_blocker: {
          ...(waitingForPrecheck.reported_blocker as NonNullable<
            WorkItem["reported_blocker"]
          >),
          resume_when: undefined,
        },
      } as Partial<WorkItem>),
    );
    expect(view.checking).toStrictEqual({
      precheck: { attempt_ids: ["attempt-1"], waiting_items: [] },
    });
  });

  test("a wait for another attempt that already finished is a real blocker", () => {
    const view = listed(
      state([precheck("running")], {
        ...waitingForPrecheck,
        reported_blocker: {
          ...(waitingForPrecheck.reported_blocker as NonNullable<
            WorkItem["reported_blocker"]
          >),
          resume_when: { kind: "precheck_finished", target_id: "attempt-0" },
        },
      } as Partial<WorkItem>),
    );
    expect(view.checking?.precheck?.waiting_items).toStrictEqual([]);
  });
});

describe("merge check in flight", () => {
  const completion = {
    id: "D-9",
    work_item_id: id("work_item", 3),
    kind: "card_completion",
    status: "submitted",
  } as unknown as Delivery;
  const mergeCheck = (status: string, attempt = "merge-1") =>
    systemEvent(
      status === "queued"
        ? "merge_check_queued"
        : status === "running"
          ? "merge_check_started"
          : "merge_check_finished",
      { attempt_id: attempt, completion_id: "D-9", status, checks: [] },
    );
  const checkingOf = (
    events: readonly Event[],
    status: "awaiting_merge" | "review" = "awaiting_merge",
  ) => {
    const s = { ...state(events, {}), deliveries: [completion] };
    return cardCheckingIndex(s)({ id: card1, status, prechecks: [] });
  };

  test.each(["queued", "running"] as const)(
    "a %s merge check on an awaiting-merge card is shown",
    (status) => {
      expect(checkingOf([mergeCheck(status)])).toStrictEqual({
        merge_check: { attempt_id: "merge-1", status },
      });
    },
  );

  test.each(["passed", "failed"])("a %s merge check is not shown", (status) => {
    expect(
      checkingOf([mergeCheck("running"), mergeCheck(status)]),
    ).toBeUndefined();
  });

  test("a card that is not awaiting merge never shows a merge check", () => {
    expect(checkingOf([mergeCheck("running")], "review")).toBeUndefined();
  });
});
