import { submitReview } from "@cardigan/domain";
import { expect, test } from "vitest";
import { mergeFixture } from "../../domain/src/commands/merge/test-fixtures.js";
import { value } from "../../domain/src/commands/test-fixtures.js";
import { routeEvent } from "./route.js";

const issues = [
  {
    severity: "minor" as const,
    description: "Explain the remaining validation result",
    must_fix: false,
    pre_existing: false,
  },
];

async function conditional(completion = false, lastRound = false) {
  const f = mergeFixture();
  let delivery = await f.deliver();
  if (completion) {
    f.review(delivery);
    delivery = await f.deliver("card_completion");
  }
  const reviewer = completion ? f.pm : f.reviewer;
  const review = () => {
    f.start(reviewer);
    const effect = value(
      submitReview(
        f.state,
        f.actor(reviewer),
        {
          delivery_id: delivery.id,
          target_sha: delivery.subject.value,
          kind: completion ? "product" : "code",
          recheck_required: true,
          issues,
        },
        f.io,
      ),
    );
    f.commit({ ok: true, value: effect });
    return effect;
  };
  if (lastRound) {
    review();
    review();
  }
  const effect = review();
  const event = effect.events[0];
  if (!event) throw new Error("Missing review event");
  return { f, event, effect, delivery, reviewer };
}

test.each([false, true])(
  "conditional review wakes its producer with the persisted issues (completion=%s)",
  async (completion) => {
    const { f, event, delivery } = await conditional(completion);
    expect(event.payload).toMatchObject({
      delivery_id: delivery.id,
      verdict: "conditional",
      recheck_required: true,
      rework_allowed: true,
      issues,
    });
    const result = routeEvent({ event, snapshot: f.state });
    expect(result.notifications).toEqual([
      expect.objectContaining({
        recipient: { kind: "assignment", assignment_id: f.coder.id },
        kind: "review",
        rule: "6.4/review conditional",
        event_id: event.id,
        work_item_id: f.coder.work_item_id,
        run_kind: "rework",
      }),
    ]);
    expect(f.state.deliveries.find((d) => d.id === delivery.id)?.status).toBe(
      "submitted",
    );
  },
);

test.each(["missing", "suspended", "released"] as const)(
  "conditional review goes to PM Ops when the producer is %s",
  async (status) => {
    const { f, event } = await conditional();
    const snapshot = {
      ...f.state,
      assignments:
        status === "missing"
          ? f.state.assignments.filter((a) => a.id !== f.coder.id)
          : f.state.assignments.map((a) =>
              a.id === f.coder.id ? { ...a, status } : a,
            ),
    };
    expect(routeEvent({ event, snapshot }).notifications).toEqual([
      expect.objectContaining({
        recipient: { kind: "pm_ops" },
        kind: "review",
      }),
    ]);
  },
);

test.each([false, true])(
  "conditional without recheck only summarizes to PM Ops (legacy event=%s)",
  async (legacy) => {
    const { f, event, effect } = await conditional();
    const result = routeEvent({
      event: {
        ...event,
        payload: {
          review_id: effect.data.id,
          delivery_id: effect.data.delivery_id,
          verdict: "conditional",
          ...(!legacy
            ? { recheck_required: false, rework_allowed: false }
            : {}),
        },
      },
      snapshot: {
        ...f.state,
        reviews: [{ ...effect.data, recheck_required: false }],
      },
    });
    expect(result.notifications).toEqual([
      expect.objectContaining({
        recipient: { kind: "pm_ops" },
        kind: "review",
      }),
    ]);
    expect(result.checks[0]?.rule).toBe("6.4/review passed");
  },
);

test.each([false, true])(
  "final conditional round still blocks on a Decision without waking the producer (completion=%s)",
  async (completion) => {
    const { f, event, effect, reviewer } = await conditional(completion, true);
    expect(event.payload).toMatchObject({ rework_allowed: false });
    expect(routeEvent({ event, snapshot: f.state }).notifications).toEqual([]);
    expect(
      f.state.work_items.find((w) => w.id === reviewer.work_item_id)?.status,
    ).toBe("waiting_decision");
    expect(f.state.decisions.at(-1)).toMatchObject({
      trigger: "review_limit",
      status: "open",
      blocking: true,
    });
    const decision = effect.events[1];
    if (!decision) throw new Error("Missing decision event");
    expect(decision.type).toBe("decision_requested");
    expect(
      routeEvent({ event: decision, snapshot: f.state }).notifications.map(
        (n) => n.recipient,
      ),
    ).toEqual([{ kind: "needs_you" }, { kind: "pm_office" }]);
  },
);
