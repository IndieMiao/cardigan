import {
  assign,
  createWorkItem,
  finishRun,
  queueRun,
  submitReview,
} from "@cardigan/domain";
import { expect, test } from "vitest";
import { mergeFixture } from "../../domain/src/commands/merge/test-fixtures.js";
import { human, value } from "../../domain/src/commands/test-fixtures.js";
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

test.each([false, true])(
  "real pass with issues retains completion reminders and summarizes to PM Ops without rework (completion=%s)",
  async (completion) => {
    const { f, delivery, reviewer } = await conditional(completion);
    f.start(reviewer);
    const effect = value(
      submitReview(
        f.state,
        f.actor(reviewer),
        {
          delivery_id: delivery.id,
          target_sha: delivery.subject.value,
          kind: completion ? "product" : "code",
          recheck_required: false,
          issues,
        },
        f.io,
      ),
    );
    f.commit({ ok: true, value: effect });
    const event = effect.events[0];
    if (!event) throw new Error("Missing review event");
    expect(effect.data.verdict).toBe("pass");
    expect(f.state.deliveries.find((d) => d.id === delivery.id)?.status).toBe(
      "accepted",
    );
    // Older events have no issues payload; look up this review, not its history.
    for (const payload of [
      event.payload,
      { review_id: effect.data.id, delivery_id: delivery.id, verdict: "pass" },
      {
        review_id: effect.data.id,
        delivery_id: delivery.id,
        verdict: "conditional",
        recheck_required: false,
      },
    ]) {
      const result = routeEvent({
        event: { ...event, payload },
        snapshot: f.state,
      });
      expect(result.notifications).toEqual([
        ...(completion
          ? []
          : [
              expect.objectContaining({
                recipient: { kind: "assignment", assignment_id: f.coder.id },
                kind: "completion",
                rule: "6.4/all required work items passed",
              }),
            ]),
        expect.objectContaining({
          recipient: { kind: "pm_ops" },
          kind: "review",
          rule: "6.4/review conditional",
          summary: `${delivery.id} passed with 1 review issue(s); no recheck is needed`,
        }),
      ]);
      expect(result.notifications.every((n) => n.run_kind !== "rework")).toBe(
        true,
      );
      expect(result.checks[0]?.rule).toBe("6.4/review passed");
    }
  },
);

test.each([false, true])(
  "pass without issues retains completion routing and never summarizes past issues (completion=%s)",
  async (completion) => {
    const { f, delivery } = await conditional(completion);
    const review = f.review(delivery);
    const event = f.state.events.findLast((e) => e.type === "review_submitted");
    if (!event) throw new Error("Missing review event");
    expect(review).toMatchObject({ verdict: "pass", issues: [] });
    for (const payload of [
      event.payload,
      { review_id: review.id, delivery_id: delivery.id, verdict: "pass" },
    ]) {
      const result = routeEvent({
        event: { ...event, payload },
        snapshot: f.state,
      });
      expect(result.notifications).toEqual(
        completion
          ? []
          : [
              expect.objectContaining({
                recipient: { kind: "assignment", assignment_id: f.coder.id },
                kind: "completion",
                rule: "6.4/all required work items passed",
              }),
            ],
      );
    }
  },
);

test.each(["active", "unassigned", "suspended", "released"] as const)(
  "pass with issues retains dependency routing for a %s downstream owner",
  async (status) => {
    const f = mergeFixture();
    const producer = f.coder.work_item_id;
    if (!producer) throw new Error("Missing producer");
    const downstream = f.commit(
      createWorkItem(
        f.state,
        human,
        {
          card_id: f.card.id,
          title: "Dependent work",
          kind: "produce",
          role_id: "coder",
          required: false,
          depends_on: [producer],
          completion_criteria: ["Build on the reviewed delivery"],
        },
        f.io,
      ),
    );
    const owner =
      status === "unassigned"
        ? undefined
        : f.commit(
            assign(
              f.state,
              human,
              { work_item_id: downstream.id, role_id: "coder" },
              f.io,
            ),
          );
    const delivery = await f.deliver();
    f.start(f.reviewer);
    const effect = value(
      submitReview(
        f.state,
        f.actor(f.reviewer),
        {
          delivery_id: delivery.id,
          target_sha: delivery.subject.value,
          kind: "code",
          recheck_required: false,
          issues: issues.map((issue) => ({ ...issue, pre_existing: true })),
        },
        f.io,
      ),
    );
    f.commit({ ok: true, value: effect });
    const event = effect.events[0];
    if (!event) throw new Error("Missing review event");
    expect(effect.data.verdict).toBe("pass");
    expect(f.state.work_items.find((w) => w.id === producer)?.status).toBe(
      "accepted",
    );
    const snapshot =
      status === "suspended" || status === "released"
        ? {
            ...f.state,
            assignments: f.state.assignments.map((a) =>
              a.id === owner?.id ? { ...a, status } : a,
            ),
          }
        : f.state;
    const result = routeEvent({ event, snapshot });
    const pm = result.notifications.filter(
      (n) => n.recipient.kind === "pm_ops",
    );
    expect(pm).toHaveLength(1);
    expect(pm[0]).toMatchObject({
      kind: "review",
      rule: "6.4/review conditional",
    });
    expect(pm[0]?.summary).toContain(
      `${delivery.id} passed with 1 review issue(s)`,
    );
    if (status === "active") {
      expect(result.notifications).toHaveLength(3);
      expect(result.notifications).toContainEqual(
        expect.objectContaining({
          recipient: { kind: "assignment", assignment_id: owner?.id },
          kind: "dependency",
          rule: "6.4/dependency completed",
          work_item_id: downstream.id,
        }),
      );
    } else {
      expect(result.notifications).toHaveLength(2);
      expect(pm[0]?.summary).toContain(`${producer} is done`);
      expect(pm[0]?.summary).toContain(
        status === "unassigned" ? "no owner" : `${downstream.id} can start`,
      );
    }
    expect(
      result.notifications.filter(
        (n) => n.recipient.assignment_id === f.coder.id,
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "completion",
        rule: "6.4/all required work items passed",
      }),
    ]);
    expect(result.notifications.every((n) => n.run_kind !== "rework")).toBe(
      true,
    );
  },
);

test("accepted producer can rework a PM conditional, redeliver and pass both original verifiers", async () => {
  const { f, delivery: completion, event } = await conditional(true);
  expect(
    f.state.work_items.find((w) => w.id === f.coder.work_item_id)?.status,
  ).toBe("accepted");
  const notification = routeEvent({ event, snapshot: f.state })
    .notifications[0];
  if (notification?.run_kind !== "rework")
    throw new Error("Missing rework notification");
  const current = f.state.runs.find(
    (r) => r.assignment_id === f.coder.id && r.status === "running",
  );
  if (!current) throw new Error("Missing producer run");
  f.commit(
    finishRun(
      f.state,
      f.actor(f.coder),
      {
        run_id: current.id,
        outcome: "completed",
        summary: "Completion submitted",
      },
      f.io,
    ),
  );
  const rework = f.commit(
    queueRun(
      f.state,
      { kind: "system", project_id: f.state.project_id },
      {
        assignment_id: f.coder.id,
        trigger_event_id: notification.event_id,
        kind: notification.run_kind,
        model: "fixture-model",
        agent_cli_version: "1",
      },
      f.io,
    ),
  );

  const revised = await f.deliver("code", "b".repeat(40));
  expect(f.state.runs.find((r) => r.id === rework.id)).toMatchObject({
    kind: "rework",
    status: "running",
  });
  expect(revised.run_id).toBe(rework.id);
  expect(
    f.state.work_items.find((w) => w.id === f.coder.work_item_id)?.status,
  ).toBe("delivered");
  expect(f.state.deliveries.find((d) => d.id === completion.id)?.status).toBe(
    "superseded",
  );
  expect(
    f.state.work_items.find((w) => w.id === f.pm.work_item_id)?.status,
  ).toBe("todo");

  expect(f.review(revised)).toMatchObject({
    verdict: "pass",
    work_item_id: f.reviewer.work_item_id,
  });
  const revisedCompletion = await f.deliver(
    "card_completion",
    revised.subject.value,
  );
  expect(f.review(revisedCompletion)).toMatchObject({
    verdict: "pass",
    work_item_id: f.pm.work_item_id,
  });
  expect(f.state.cards.find((c) => c.id === f.card.id)?.status).toBe(
    "awaiting_merge",
  );
});
