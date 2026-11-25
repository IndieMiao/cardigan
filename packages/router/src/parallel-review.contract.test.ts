import {
  deriveCardFields,
  dispatchRun,
  dispatchRunKind,
  queueRun,
  remindDecisionFollowups,
  submitReview,
} from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  parallelBug,
  parallelDelivery,
  rejectedParallel,
} from "../../domain/src/commands/parallel-review/test-fixtures.js";
import {
  first as sharedBug,
  sharedReviewFixture,
} from "../../domain/src/commands/shared-review/test-fixtures.js";
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
      rework_allowed: true,
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

test.each(
  [4, 5].flatMap((flow_version) =>
    ["unmarked", "other-card", "other-delivery", "other-review"].map(
      (binding) => ({ flow_version, binding }),
    ),
  ),
)(
  "C1 flow $flow_version repeated rejection routing with unrelated marker $binding",
  async ({ flow_version, binding }) => {
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
      cards: state.cards.map((c) => ({ ...c, flow_version })),
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
    expect(
      routeEvent({ event: first, snapshot }).notifications.filter(
        (n) => n.rule === "7.2/delivery rejected twice",
      ),
    ).toHaveLength(0);
  },
);

test.each([2, 3])(
  "a late rejection after %i prior rounds respects the pause without routing or dispatching rework",
  async (rounds) => {
    const f = await sharedReviewFixture(3, [sharedBug], rounds);
    f.review(2, [sharedBug]);
    expect(f.decide(2, "pause").ok).toBe(true);
    f.review(3, [], f.refs());
    const event = f.state.events.findLast((e) => e.type === "review_submitted");
    const producer = f.state.assignments.find(
      (a) => a.id === id("assignment", 1),
    );
    if (!event || !producer) throw Error("Missing late review or producer");
    expect(event.payload).toMatchObject({
      parallel_late: true,
      review_limit_wait: true,
      rework_allowed: false,
    });
    const idle = {
      ...f.state,
      runs: f.state.runs.filter((r) => r.assignment_id !== producer.id),
    };
    expect(routeEvent({ event, snapshot: idle }).notifications).toEqual([]);
    const kind = dispatchRunKind(event, producer, true);
    expect(kind).toBe("rework");
    expect(
      queueRun(
        idle,
        { kind: "system", project_id: idle.project_id },
        {
          assignment_id: producer.id,
          kind,
          trigger_event_id: event.id,
          model: "fixture",
          agent_cli_version: "1",
        },
        f.io,
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: "illegal_transition",
        message: expect.stringContaining("暂停返工"),
      },
    });
  },
);

test.each([1, 2])(
  "the decision owns the next wake, including delayed bells (%i prior rejections in first lane)",
  async (prior) => {
    // C-610: the independent lane's fourth rejection predates alignment rounds.
    const f = await sharedReviewFixture(prior, [sharedBug], 3);
    const author = id("assignment", 1);
    const system = { kind: "system" as const, project_id: f.state.project_id };
    f.review(2, [sharedBug]);
    const first = f.state.events.findLast((e) => e.type === "review_submitted");
    if (!first) throw Error("Missing review");
    expect(
      routeEvent({ event: first, snapshot: f.state }).notifications,
    ).toHaveLength(prior === 1 ? 1 : 0);
    f.review(3, [], f.refs());
    expect(f.decide(3, "pause").ok).toBe(true);
    const idle = () => ({
      ...f.state,
      runs: f.state.runs.filter((r) => r.assignment_id !== author),
    });
    const queue = (state: typeof f.state, event: typeof first, n = 1) => {
      const a = state.assignments.find((a) => a.id === id("assignment", n));
      if (!a) throw Error("Missing owner");
      return queueRun(
        state,
        system,
        {
          assignment_id: a.id,
          kind: dispatchRunKind(event, a, true),
          trigger_event_id: event.id,
          model: "fixture",
          agent_cli_version: "1",
        },
        f.io,
      );
    };
    expect(
      routeEvent({ event: first, snapshot: idle() }).notifications,
    ).toEqual([]);
    if (prior === 1) {
      const producerRun = f.state.runs.find((r) => r.assignment_id === author);
      if (!producerRun) throw Error("Missing producer Run");
      const queuedBeforePause = {
        ...idle(),
        runs: [
          ...idle().runs,
          {
            ...producerRun,
            trigger_event_id: first.id,
            kind: "rework" as const,
            status: "queued" as const,
          },
        ],
      };
      expect(
        dispatchRun(
          queuedBeforePause,
          system,
          { run_id: producerRun.id },
          f.io,
        ),
      ).toMatchObject({
        ok: false,
        error: {
          code: "illegal_transition",
          message: expect.stringContaining("暂停返工"),
        },
      });
    }
    expect(queue(idle(), first)).toMatchObject({
      ok: false,
      error: { code: "illegal_transition" },
    });
    f.confirmPause();
    expect(f.decide(3, "raise_limit").ok).toBe(true);
    const resumed = f.state.events.findLast(
      (e) => e.type === "decision_resolved",
    );
    if (!resumed) throw Error("Missing resume");
    const state = idle();
    const wakes = state.events
      .filter(
        (e) => e.type === "review_submitted" || e.type === "decision_resolved",
      )
      .flatMap((event) => routeEvent({ event, snapshot: state }).notifications);
    expect(wakes).toMatchObject([
      {
        recipient: { assignment_id: author },
        event_id: resumed.id,
        run_kind: "rework",
      },
    ]);
    const queued = value(queue(state, resumed));
    expect(queued.data.kind).toBe("rework");
    expect(queue(apply(state, queued), resumed)).toMatchObject({
      ok: false,
      error: { code: "idempotency_conflict" },
    });
    expect(queue(state, resumed, 3)).toMatchObject({
      ok: false,
      error: { code: "illegal_transition" },
    });
    const newer = apply(f.state, await parallelDelivery(f.state, f.io));
    expect(
      routeEvent({ event: resumed, snapshot: newer }).notifications,
    ).toEqual([]);
    expect(queue({ ...newer, runs: state.runs }, resumed)).toMatchObject({
      ok: false,
      error: { code: "illegal_transition" },
    });
  },
);

test("managed pause routes the owner, two reviewers, settlement and both reminder audiences; stale instructions never wake replacements", async () => {
  const f = await sharedReviewFixture();
  f.review(2, [sharedBug]);
  f.review(3, [], f.refs());
  expect(f.decide(3, "pause").ok).toBe(true);
  const event = (type: string) => {
    const e = f.state.events.findLast((e) => e.type === type);
    if (!e) throw Error(type);
    return e;
  };
  const recipients = (e: ReturnType<typeof event>, snapshot = f.state) =>
    routeEvent({ event: e, snapshot }).notifications.map((n) => n.recipient);
  const instruction = event("instruction_issued");
  expect(recipients(instruction)).toEqual([
    { kind: "assignment", assignment_id: id("assignment", 1) },
  ]);
  const current = f.state;
  const tick = (s: typeof current, at: string) => {
    const effect = value(
      remindDecisionFollowups(
        s,
        { kind: "system", project_id: s.project_id },
        { ...f.io, clock: { now: () => at } },
      ),
    );
    const next = apply(s, effect);
    const notice = effect.events[0];
    if (!notice) throw Error("Missing reminder");
    return { next, to: recipients(notice, next) };
  };
  const ops = tick(current, "2026-01-01T00:30:00Z");
  expect(ops.to).toEqual([{ kind: "pm_ops" }]);
  expect(tick(ops.next, "2026-01-01T01:00:00Z").to).toEqual([
    { kind: "pm_office" },
  ]);
  const p = f.comment(1, "propose");
  expect(recipients(instruction)).toEqual([]);
  const confirm = f.state.events
    .filter((e) => e.type === "instruction_issued")
    .slice(-2);
  expect(confirm.flatMap((e) => recipients(e))).toEqual(
    [2, 3].map((n) => ({
      kind: "assignment",
      assignment_id: id("assignment", n),
    })),
  );
  const toPeer = confirm[1];
  if (!toPeer) throw Error("Missing peer instruction");
  expect(
    recipients(toPeer, {
      ...f.state,
      work_items: f.state.work_items.map((w) =>
        w.id === id("work_item", 3)
          ? { ...w, assignment_id: id("assignment", 90) }
          : w,
      ),
    }),
  ).toEqual([]);
  f.comment(2, "confirm", p.id);
  f.comment(3, "confirm", p.id);
  const notice = event("review_pause_notice");
  expect(recipients(notice)).toEqual([{ kind: "pm_ops" }]);
  expect(f.decide(2, "raise_limit").ok).toBe(true);
  expect(recipients(notice)).toEqual([]);
});

test.each(["before", "after"])(
  "closure follows human escalation %s the last vote",
  async (when) => {
    const f = await sharedReviewFixture();
    f.review(2, [sharedBug]);
    f.review(3, [], f.refs());
    expect(f.decide(3, "pause").ok).toBe(true);
    if (when === "before") expect(f.decide(3, "escalate").ok).toBe(true);
    f.confirmPause();
    if (when === "after") expect(f.decide(3, "escalate").ok).toBe(true);
    const notice = f.state.events.findLast(
      (e) => e.type === "review_pause_notice",
    );
    const q = f.state.decisions[0];
    const card = f.state.cards.find((c) => c.id === q?.card_id);
    if (!notice || !card || !q) throw Error("missing closure notice");
    expect(notice.payload).toMatchObject({
      audience: when === "before" ? "human" : "pm_ops",
    });
    expect(
      routeEvent({ event: notice, snapshot: f.state }).notifications.map(
        (n) => n.recipient,
      ),
    ).toEqual([{ kind: "needs_you" }]);
    expect(deriveCardFields({ ...f.state, card })).toMatchObject({
      why: `待你结案恢复 ${q.id}`,
      waiting_on: [{ review_phase: "待你结案恢复" }],
      next_owners: [{ kind: "human", ref: "human" }],
    });
    expect(f.decide(3, "raise_limit").ok).toBe(false);
  },
);
