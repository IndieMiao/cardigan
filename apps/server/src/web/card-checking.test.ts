import type { CommandState, Delivery, Event, WorkItem } from "@cardigan/domain";
import { describe, expect, test } from "vitest";
import {
  fixture,
  id,
} from "../../../../packages/domain/src/commands/test-fixtures.js";
import { cardCheckingIndex, missingPrecheckTargets } from "./card-checking.js";
import { cardSummary } from "./cards-page.js";
import { cardListViews } from "./read.js";

// C-567: what the board shows while a precheck or merge check is in flight.

const card1 = id("card", 1);
let seq = 0;
function systemEvent(
  type: string,
  payload: Record<string, unknown>,
  card = card1,
): Event {
  seq += 1;
  return {
    id: `event-${seq}`,
    project_id: fixture().project_id,
    card_id: card,
    seq,
    type,
    actor: { kind: "system", project_id: fixture().project_id },
    created_at: "2026-01-01T00:00:00.000Z",
    payload,
  } as unknown as Event;
}
const precheck = (status: string, card = card1, attempt = "attempt-1") =>
  systemEvent(
    status === "queued"
      ? "precheck_queued"
      : status === "running"
        ? "precheck_started"
        : "precheck_finished",
    {
      attempt_id: attempt,
      assignment_id: id("assignment", 1),
      work_item_id: id("work_item", 1),
      card_id: card,
      head_sha: "a".repeat(40),
      status,
      branch: "feature",
      machine_id: "local",
    },
    card,
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

describe("waits for another card's precheck (C-567 review)", () => {
  const card2 = id("card", 2);
  const waitFor = (target: string): Partial<WorkItem> =>
    ({
      ...waitingForPrecheck,
      reported_blocker: {
        ...(waitingForPrecheck.reported_blocker as NonNullable<
          WorkItem["reported_blocker"]
        >),
        resume_when: { kind: "precheck_finished", target_id: target },
      },
    }) as Partial<WorkItem>;

  test.each(["queued", "running"])(
    "a %s precheck on another card marks the waiting card",
    (status) => {
      const view = listed(
        state([precheck(status, card2, "other-1")], waitFor("other-1")),
      );
      expect(view.checking).toStrictEqual({
        precheck: {
          attempt_ids: ["other-1"],
          waiting_items: [id("work_item", 1)],
          // The detail page follows this card's events to see the wait settle.
          cards: [card2],
        },
      });
    },
  );

  test("the other card's events may come from outside the page's state", () => {
    const outside = [precheck("running", card2, "other-1")];
    const scoped = state([], waitFor("other-1"));
    expect(missingPrecheckTargets(scoped)).toStrictEqual(["other-1"]);
    expect(listed(scoped).checking).toBeUndefined();
    const view = cardListViews(
      scoped,
      undefined,
      [],
      undefined,
      undefined,
      outside,
    ).find((c) => c.id === card1);
    expect(view?.checking?.precheck?.waiting_items).toStrictEqual([
      id("work_item", 1),
    ]);
    expect(view?.checking?.precheck?.cards).toStrictEqual([card2]);
    // Once that attempt settles the item reads as a blocker again.
    const settled = cardListViews(scoped, undefined, [], undefined, undefined, [
      ...outside,
      precheck("failed", card2, "other-1"),
    ]).find((c) => c.id === card1);
    expect(settled?.checking).toBeUndefined();
    expect(missingPrecheckTargets(state(outside, waitFor("other-1")))).toEqual(
      [],
    );
  });

  test("a wait handed to PM for a manual resume stays a blocker", () => {
    const manual = {
      ...waitingForPrecheck,
      reported_blocker: {
        ...(waitingForPrecheck.reported_blocker as NonNullable<
          WorkItem["reported_blocker"]
        >),
        auto_resume_disabled: true,
      },
    } as Partial<WorkItem>;
    const view = listed(state([precheck("running")], manual));
    // The card still shows its running precheck, but W-1 is not hidden.
    expect(view.checking).toStrictEqual({
      precheck: { attempt_ids: ["attempt-1"], waiting_items: [] },
    });
    expect(missingPrecheckTargets(state([], manual))).toStrictEqual([]);
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
