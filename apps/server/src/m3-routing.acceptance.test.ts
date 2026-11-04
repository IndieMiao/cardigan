// Oracles are the M3 v2 plan and development plan §§6–7, not implementation branches.
import {
  type Event,
  recordDecision,
  requestDecision,
  requestHumanAction,
  updateWorkItem,
} from "@cardigan/domain";
import {
  type EscalationReason,
  escalation,
  mergeNotifications,
  type RouteResult,
  routeBellFailure,
  routeEvent,
  routeRuntimeLost,
  routeWatchdog,
} from "@cardigan/router";
import { afterEach, beforeEach, expect, test } from "vitest";
import { m3Fixture } from "../test-support/m3-acceptance.js";

let f: ReturnType<typeof m3Fixture>;
beforeEach(() => {
  f = m3Fixture();
});
afterEach(() => f.close());
const event = (events: readonly Event[], type: string) => {
  const e = events.find((e) => e.type === type);
  if (!e) throw new Error(`Missing ${type}`);
  return e;
};
const route = (e: Event) => routeEvent({ event: e, snapshot: f.state() });
const recipients = (r: RouteResult) =>
  r.notifications
    .map((n) => n.recipient.assignment_id ?? n.recipient.kind)
    .sort();
const pass = async () => {
  f.start(f.coder);
  const d = await f.delivery();
  f.start(f.reviewer);
  return f.review(d.data.id);
};
const decision = () => {
  f.start(f.coder);
  return f.apply(
    (s, a, p) =>
      requestDecision(
        s,
        a,
        {
          card_id: f.card.id,
          kind: "choose",
          category: "general",
          question: "Choose direction",
          context: "Need a decision",
          options: [{ key: "a", description: "Continue", impact: "Unblock" }],
          recommended: "a",
          affected_cards: [f.card.id],
          affected_work_items: [f.produce.id],
          blocking: true,
          decider: "human",
        },
        p,
      ),
    f.actor(f.coder),
  );
};

test("[R01] §6.4 work-item comment reaches its Assignment", () => {
  expect(recipients(route(f.comment(f.human, f.produce.id)))).toEqual([
    f.coder.id,
  ]);
});
test("[R02] §6.4 authors do not receive their own work-item comments", () => {
  expect(recipients(route(f.comment(f.actor(f.coder), f.produce.id)))).toEqual(
    [],
  );
});
test("[R03] §6.4 card-level Agent comment without mention is quiet", () => {
  expect(recipients(route(f.comment(f.actor(f.coder))))).toEqual([]);
});
test("[R04] §6.4 human card comment goes only to Ops", () => {
  expect(recipients(route(f.comment()))).toEqual(["pm_ops"]);
});
// No command emits instruction yet; R05/R06 cover only the pure routing contract.
test("[R05] §6.4 instruction reaches the responsible Assignment", () => {
  expect(
    recipients(route(f.fact("instruction", { work_item_id: f.produce.id }))),
  ).toEqual([f.coder.id]);
});
test("[R06] §6.4 unassigned instruction goes to Ops", () => {
  const w = f.extra(f.produce.role_id);
  expect(
    recipients(route(f.fact("instruction", { work_item_id: w.id }))),
  ).toEqual(["pm_ops"]);
});
test("[R07] §6.4 delivery reaches its requested reviewer and Ops", async () => {
  f.start(f.coder);
  const d = await f.delivery();
  expect(recipients(route(event(d.events, "delivery_submitted")))).toEqual(
    [f.reviewer.id, "pm_ops"].sort(),
  );
});
test("[R08] §6.4 passing review does not wake anyone before all required work succeeds", async () => {
  const w = f.extra(f.produce.role_id);
  f.apply((s, a, p) =>
    updateWorkItem(s, a, { work_item_id: w.id, required: true }, p),
  );
  const r = route(event((await pass()).events, "review_submitted"));
  expect(recipients(r)).toEqual([]);
  expect(r.checks.length).toBeGreaterThan(0);
});
test("[R09] §6.4 rejection reaches the producer of the reviewed delivery", async () => {
  f.start(f.coder);
  const d = await f.delivery();
  f.start(f.reviewer);
  expect(
    recipients(
      route(event(f.review(d.data.id, true).events, "review_submitted")),
    ),
  ).toEqual([f.coder.id]);
});
test("[R10] §6.4 human decision request reaches Needs You and Office", () => {
  expect(
    recipients(route(event(decision().events, "decision_requested"))),
  ).toEqual(["needs_you", "pm_office"]);
});
test("[R11] §6.4 resolving a blocking decision notifies resumed work and Ops", () => {
  const d = decision().data;
  const r = f.apply(
    (s, a, p) =>
      recordDecision(
        s,
        a,
        {
          decision_id: d.id,
          option: "a",
          rationale: "Proceed",
          raw_quote: "Choose a",
        },
        p,
      ),
    f.actor(f.office()),
  );
  expect(recipients(route(event(r.events, "decision_resolved")))).toEqual(
    [f.coder.id, "pm_ops"].sort(),
  );
});
// A real passing review accepts the producer but does not notify its dependent Assignment.
test.fails("[R12] §6.4 completed dependency reaches downstream Assignment", async () => {
  const downstream = f.assignItem(f.extra(f.produce.role_id, [f.produce.id]));
  const reviewed = await pass();
  expect(
    recipients(route(event(reviewed.events, "review_submitted"))),
  ).toContain(downstream.id);
});
// A real passing review also fails to notify Ops when the dependent work has no Assignment.
test.fails("[R13] §6.4 completed dependency with no owner reaches Ops", async () => {
  f.extra(f.produce.role_id, [f.produce.id]);
  const reviewed = await pass();
  expect(
    recipients(route(event(reviewed.events, "review_submitted"))),
  ).toContain("pm_ops");
});
test("[R14] §6.4 all required work passing reminds the producer, without closing the card", async () => {
  const r = await pass();
  expect(recipients(route(event(r.events, "review_submitted")))).toEqual([
    f.coder.id,
  ]);
  expect(f.state().cards[0]?.status).not.toBe("done");
});
test("[R15] §6.4 completion request reaches its designated PM verifier", async () => {
  await pass();
  const d = await f.delivery("card_completion");
  expect(recipients(route(event(d.events, "delivery_submitted")))).toEqual([
    f.pm.id,
  ]);
});
test("[R16] §6.4 human action reaches Needs You and Office", () => {
  f.start(f.coder);
  const a = f.apply(
    (s, who, p) =>
      requestHumanAction(
        s,
        who,
        {
          card_id: f.card.id,
          instructions: "Enable access",
          why_human: "Account owner",
          expected_return: "Confirmation",
          blocked_work_items: [f.produce.id],
        },
        p,
      ),
    f.actor(f.coder),
  );
  expect(recipients(route(event(a.events, "human_action_requested")))).toEqual([
    "needs_you",
    "pm_office",
  ]);
});
test("[R17] §6.4 bell delivery failure routes to Ops", () => {
  const e = f.fact("bell_delivery_failed", {});
  expect(
    routeBellFailure({
      event_id: e.id,
      seq: e.seq,
      card_id: f.card.id,
      assignment_id: f.coder.id,
      reason: "timeout",
    }).recipient,
  ).toEqual({ kind: "pm_ops" });
});
test("[R18] §6.4 Run ending without delivery, blocker or decision reaches Ops", () => {
  f.start(f.coder);
  expect(
    recipients(route(event(f.finish(f.coder).events, "run_finished"))),
  ).toEqual(["pm_ops"]);
});
// §6.4 excludes Runs that produced a Delivery. Current routing still emits a no-output Ops alert.
test.fails("[R19] §6.4 a Run that delivered output is not reported as having no output", async () => {
  f.start(f.coder);
  await f.delivery();
  expect(
    recipients(route(event(f.finish(f.coder).events, "run_finished"))),
  ).toEqual([]);
});
test("[R20] §6.4 activity watchdog routes to Ops", () => {
  const e = f.fact("run_inactive", {});
  expect(
    routeWatchdog({
      event_id: e.id,
      seq: e.seq,
      card_id: f.card.id,
      assignment_id: f.coder.id,
      idle_minutes: 16,
    }).recipient,
  ).toEqual({ kind: "pm_ops" });
});
test("[R21] §6.4 lost runtime goes to the human for takeover", () => {
  const e = f.fact("runtime_lost", {});
  expect(
    routeRuntimeLost({
      event_id: e.id,
      seq: e.seq,
      card_id: f.card.id,
      assignment_id: f.coder.id,
      lost_minutes: 6,
    }).recipient,
  ).toEqual({ kind: "needs_you" });
});
test("[R22] §6.5 unique role mention reaches that Assignment", () => {
  expect(
    recipients(route(f.comment(f.human, undefined, [`@${f.produce.role_id}`]))),
  ).toEqual([f.coder.id]);
});
test("[R23] §6.5 absent role Assignment goes to Ops", () => {
  expect(
    recipients(route(f.comment(f.human, undefined, ["@designer"]))),
  ).toEqual(["pm_ops"]);
});
test("[R24] §6.5 ambiguous role asks for clarification and does not broadcast", () => {
  f.assignItem(f.extra(f.produce.role_id));
  const r = route(f.comment(f.human, undefined, [`@${f.produce.role_id}`]));
  expect(recipients(r)).toEqual([]);
  expect(r.problems.some((p) => p.code === "ambiguous_role_mention")).toBe(
    true,
  );
});
test("[R25] §6.5 explicit Assignment mention is precise", () => {
  expect(
    recipients(route(f.comment(f.human, undefined, [`@${f.reviewer.id}`]))),
  ).toEqual([f.reviewer.id]);
});
test("[R26] §6.5 explicit WorkItem mention resolves its owner", () => {
  expect(
    recipients(route(f.comment(f.human, undefined, [`@${f.verify.id}`]))),
  ).toEqual([f.reviewer.id]);
});
const escalations: [string, EscalationReason][] = [
  ["R27", "work conflict or priority contention"],
  ["R28", "delivery rejected twice"],
  ["R29", "delivery does not match the requirement"],
  ["R30", "decide whether to pause"],
  ["R31", "unhandled exception"],
];
test.each(escalations)("[%s] §7.2 %s reaches Ops", (_id, reason) => {
  const e = f.fact("attention_requested", {});
  const note = escalation(
    { event: e, snapshot: f.state() },
    reason,
    "Needs judgement",
  );
  expect(note).toMatchObject({
    recipient: { kind: "pm_ops" },
    kind: "escalation",
    event_id: e.id,
    rule: `7.2/${reason}`,
  });
});
test("[R32] §6.7 merge preserves unsorted seq range and counts, without message bodies", () => {
  const kinds = [
    "comment",
    "delivery",
    "review",
    "comment",
    "review",
    "comment",
    "comment",
    "comment",
  ] as const;
  const bell = mergeNotifications({
    card_id: f.card.id,
    assignment_id: f.coder.id,
    notifications: kinds.map((kind, i) => ({
      seq: i ? 16 + i : 25,
      kind,
      summary: "private message body",
    })),
  });
  expect(bell).toMatchObject({
    from_seq: 17,
    to_seq: 25,
    summary: "1 delivery, 2 reviews, 5 comments",
  });
  expect(bell?.text).toContain(`card=${f.card.id}`);
  expect(bell?.text).toContain(`asg=${f.coder.id}`);
  expect(bell?.text).toContain("seq=17..25");
  expect(bell?.text).not.toContain("private message body");
});
test("[R33] §6.7 an empty inbox produces no bell", () => {
  expect(
    mergeNotifications({
      card_id: f.card.id,
      assignment_id: f.coder.id,
      notifications: [],
    }),
  ).toBeUndefined();
});
test("[R34] M3.1 replaying pure routing preserves the snapshot and recipient decision", () => {
  const input = {
      event: f.comment(f.human, f.produce.id),
      snapshot: f.state(),
    },
    before = structuredClone(input);
  expect(routeEvent(input)).toEqual(routeEvent(input));
  expect(input).toEqual(before);
});
