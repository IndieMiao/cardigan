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
