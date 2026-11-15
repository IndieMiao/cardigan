import { submitReview } from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  parallelBug,
  parallelDelivery,
  rejectedParallel,
} from "../../domain/src/commands/parallel-review/test-fixtures.js";
import {
  actor,
  apply,
  id,
  value,
} from "../../domain/src/commands/test-fixtures.js";
import { routeEvent } from "./route.js";

test.each([null, 1])(
  "parallel findings still reach the current author at a B2 round boundary (cap=%s)",
  async (cap) => {
    const f = await rejectedParallel();
    const state = {
      ...f.state,
      project_preferences: [
        {
          id: f.state.project_id,
          auto_merge_after_minutes: null,
          system_review_limit_max_raises: cap,
        },
      ],
      work_items: f.state.work_items.map((w) =>
        w.id === id("work_item", 3) && w.kind === "verify"
          ? { ...w, max_review_rounds: 1 }
          : w,
      ),
    };
    const effect = value(
      submitReview(
        state,
        actor(3, "pm"),
        { ...f.review, issues: [parallelBug] },
        f.io,
      ),
    );
    const event = effect.events.find((e) => e.type === "review_submitted");
    if (!event) throw new Error("Missing review event");
    expect(event.payload).toMatchObject({
      parallel_late: true,
      rework_allowed: cap === 1,
      ...(cap === null ? { review_limit_wait: true } : {}),
    });
    const result = routeEvent({ event, snapshot: apply(state, effect) });
    expect(result.notifications).toEqual([
      expect.objectContaining({
        recipient: { kind: "assignment", assignment_id: id("assignment", 1) },
        kind: "review",
        summary: expect.stringContaining(
          `${f.target.id} received a parallel review`,
        ),
      }),
    ]);
    expect(result.checks).toEqual([]);
  },
);

test.each(["pass", "reject", "conditional"] as const)(
  "parallel %s reaches the current producer once without completion or repeat escalation",
  async (verdict) => {
    const f = await rejectedParallel();
    const effect = value(
      submitReview(
        f.state,
        actor(3, "pm"),
        {
          ...f.review,
          issues: verdict === "reject" ? [parallelBug] : [],
          recheck_required: verdict === "conditional",
        },
        f.io,
      ),
    );
    const event = effect.events[0];
    if (!event) throw new Error("Missing event");
    const state = apply(f.state, effect);
    // A newer delivery may arrive before the router consumes the old event.
    const newer = apply(state, await parallelDelivery(state, f.io));
    for (const snapshot of [state, newer]) {
      const routed = routeEvent({ event, snapshot });
      expect(routed.notifications).toEqual([
        expect.objectContaining({
          recipient: { kind: "assignment", assignment_id: id("assignment", 1) },
          kind: "review",
          summary: expect.stringContaining(
            `${f.target.id} received a parallel review`,
          ),
        }),
      ]);
      expect(routed.checks).toEqual([]);
      expect(routeEvent({ event, snapshot })).toEqual(routed);
    }
    for (const status of ["suspended", "released"] as const) {
      expect(
        routeEvent({
          event,
          snapshot: {
            ...state,
            assignments: state.assignments.map((a) =>
              a.id === id("assignment", 1) ? { ...a, status } : a,
            ),
          },
        }).notifications,
      ).toEqual([expect.objectContaining({ recipient: { kind: "pm_ops" } })]);
    }
  },
);

test("both parallel rejections can precede routing the first rejection", async () => {
  const f = await rejectedParallel();
  const late = value(
    submitReview(
      f.state,
      actor(3, "pm"),
      { ...f.review, issues: [parallelBug] },
      f.io,
    ),
  );
  const state = apply(f.state, late);
  const first = f.rejected.events[0];
  const second = late.events[0];
  if (!first || !second) throw new Error("Missing rejection events");
  for (const snapshot of [
    state,
    apply(state, await parallelDelivery(state, f.io)),
  ]) {
    for (const event of [first, second]) {
      const result = routeEvent({ event, snapshot });
      expect(result.notifications).toEqual([
        expect.objectContaining({
          recipient: { kind: "assignment", assignment_id: id("assignment", 1) },
          kind: "review",
          summary: expect.stringContaining(f.target.id),
        }),
      ]);
      expect(result.checks).toEqual([]);
      expect(routeEvent({ event, snapshot })).toEqual(result);
    }
  }
});

test.each([
  "unmarked",
  "other-card",
  "other-delivery",
  "other-review",
] as const)(
  "repeat rejection escalation ignores an unrelated late marker: %s",
  async (binding) => {
    const f = await rejectedParallel();
    const late = value(
      submitReview(
        f.state,
        actor(3, "pm"),
        { ...f.review, issues: [parallelBug] },
        f.io,
      ),
    );
    const state = apply(f.state, late);
    const first = f.rejected.events[0];
    const second = late.events[0];
    if (!first || !second) throw new Error("Missing events");
    const snapshot = {
      ...state,
      events: state.events.map((event) =>
        event.id !== second.id
          ? event
          : {
              ...event,
              ...(binding === "other-card" ? { card_id: id("card", 2) } : {}),
              payload: {
                ...(event.payload as object),
                ...(binding === "unmarked" ? { parallel_late: false } : {}),
                ...(binding === "other-delivery"
                  ? { delivery_id: id("delivery", 999) }
                  : {}),
                ...(binding === "other-review"
                  ? { review_id: id("review", 999) }
                  : {}),
              },
            },
      ),
    };
    expect(routeEvent({ event: first, snapshot }).notifications).toContainEqual(
      expect.objectContaining({ rule: "7.2/delivery rejected twice" }),
    );
  },
);
