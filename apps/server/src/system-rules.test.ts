import {
  createWorkItem,
  type Employee,
  prepareDelivery,
  setProjectPreferences,
  submitDelivery,
  submitReview,
  systemCompleteCard,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { m3Fixture } from "../test-support/m3-acceptance.js";
import { routeProjectEvents } from "./dispatch-inbox.js";
import { runSystemRules } from "./system-rules.js";
import { needsYou } from "./web/read.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}

let f: ReturnType<typeof m3Fixture>;
beforeEach(() => {
  f = m3Fixture();
});
afterEach(() => f.close());
async function ready(employee = true) {
  f.start(f.coder);
  const delivery = (await f.delivery()).data;
  // Add a verifier with no assignment, then bind the delivery as submit_delivery would.
  const verifier = f.apply((s, a, p) =>
    createWorkItem(
      s,
      a,
      {
        card_id: f.card.id,
        title: "Extra review",
        kind: "verify",
        role_id: "reviewer",
        required: true,
        target_work_item_id: f.produce.id,
        completion_criteria: ["review"],
      },
      p,
    ),
  ).data;
  f.store.uow.run((tx) => {
    tx.deliveries.put(f.id, {
      ...delivery,
      requested_verifiers: [...delivery.requested_verifiers, verifier.id],
    });
    tx.work_items.put(f.id, { ...verifier, status: "ready" });
    if (employee)
      tx.employees.put({
        id: "E-100",
        name: "Auto reviewer",
        title: "Reviewer",
        bio: "",
        avatar: null,
        role_id: "reviewer",
        launch_profile_ref: null,
        status: "active",
        created_at: f.clock.now(),
        updated_at: f.clock.now(),
      } as Employee);
  });
  return { verifier, delivery };
}
const cycle = (store = f.store) => {
  runSystemRules(store, f.id, f.clock);
  routeProjectEvents(store, f.id, { clock: f.clock });
};

test("C-237 dispatch rule scan assigns before routing, recovers after restart, and keeps manual PM behavior when off", async () => {
  const { verifier, delivery } = await ready();
  const before = f.state().events.length;
  cycle();
  expect(f.state().events.length).toBe(before);
  expect(
    f.store
      .listNotifications({ project_id: f.id })
      .some(
        (n) =>
          n.event_id ===
            f.state().events.find((e) => e.type === "delivery_submitted")?.id &&
          n.recipient.kind === "pm_ops",
      ),
  ).toBe(true);
  f.apply((s, a, p) =>
    setProjectPreferences(s, a, { system_auto_assign_verifiers: true }, p),
  );
  cycle();
  const assigned = f
    .state()
    .work_items.find((w) => w.id === verifier.id)?.assignment_id;
  expect(assigned).toBeDefined();
  expect(
    f.state().assignments.find((a) => a.id === assigned)?.employee_id,
  ).toBe("E-100");
  expect(
    f
      .state()
      .timeline.some(
        (e) => e.author === "system" && e.work_item_id === verifier.id,
      ),
  ).toBe(true);
  expect(
    f.store.listNotifications({ project_id: f.id, assignment_id: assigned })
      .length,
  ).toBeGreaterThan(0);
  const restarted = Store.open({ dataDir: required(f.dataDir) });
  try {
    cycle(restarted);
  } finally {
    restarted.close();
  }
  expect(
    f
      .state()
      .events.filter(
        (e) =>
          e.type === "work_item_assigned" &&
          (e.payload as { work_item_id?: string }).work_item_id === verifier.id,
      ),
  ).toHaveLength(1);
  expect(
    f.state().deliveries.find((d) => d.id === delivery.id)?.status,
  ).not.toBe("superseded");
});

test("C-237 failure is audited once and visible in Needs You without Ops", async () => {
  const { verifier } = await ready(false);
  f.apply((s, a, p) =>
    setProjectPreferences(s, a, { system_auto_assign_verifiers: true }, p),
  );
  cycle();
  cycle();
  const deferred = f
    .state()
    .events.filter((e) => e.type === "system_assignment_deferred");
  expect(deferred).toHaveLength(1);
  expect(
    needsYou(f.state(), f.clock.now()).system_rule_attention,
  ).toMatchObject([
    { work_item_id: verifier.id, detail: expect.stringContaining("没有合格") },
  ]);
  expect(
    f.store
      .listNotifications({ project_id: f.id })
      .filter(
        (n) =>
          n.recipient.kind === "pm_ops" &&
          n.event_id ===
            f.state().events.find((e) => e.type === "delivery_submitted")?.id,
      ),
  ).toEqual([]);
  expect(
    f.store
      .listNotifications({ project_id: f.id })
      .filter((n) => n.event_id === deferred[0]?.id)
      .map((n) => n.recipient),
  ).toEqual([{ kind: "needs_you" }]);
  expect(
    f.state().work_items.find((w) => w.id === verifier.id)?.assignment_id,
  ).toBeUndefined();
});

test("C-237 pending timer and count persist through store reopen without duplicate notifications", async () => {
  await ready(false);
  f.apply((s, a, p) =>
    setProjectPreferences(
      s,
      a,
      {
        system_reminders: true,
        system_reminder_policy: {
          min_minutes: 1,
          max_minutes: 30,
          min_count: 1,
          max_count: 5,
          unassigned_ready_after_minutes: 2,
          pre_merge_check_pending_after_minutes: null,
          repeat: false,
          repeat_interval_minutes: null,
          max_reminders: 1,
        },
      },
      p,
    ),
  );
  cycle();
  f.advance(120_000);
  cycle();
  const sent = f
    .state()
    .events.filter((e) => e.type === "system_wait_reminded");
  expect(sent).toHaveLength(1);
  const restarted = Store.open({ dataDir: required(f.dataDir) });
  try {
    cycle(restarted);
    f.advance(600_000);
    cycle(restarted);
  } finally {
    restarted.close();
  }
  expect(
    f.state().events.filter((e) => e.type === "system_wait_reminded"),
  ).toHaveLength(1);
  expect(
    f.store
      .listNotifications({ project_id: f.id })
      .filter((n) => n.event_id === sent[0]?.id),
  ).toHaveLength(1);
});

async function immediateFixture(flowVersion = 1) {
  f.start(f.coder);
  const verifier = f.apply((s, a, p) =>
    createWorkItem(
      s,
      a,
      {
        card_id: f.card.id,
        title: "Immediate review",
        kind: "verify",
        role_id: "reviewer",
        required: true,
        target_work_item_id: f.produce.id,
        completion_criteria: ["review"],
      },
      p,
    ),
  ).data;
  f.store.uow.run((tx) =>
    tx.employees.put({
      id: "E-100",
      name: "Immediate reviewer",
      title: "Reviewer",
      bio: "",
      avatar: null,
      role_id: "reviewer",
      launch_profile_ref: null,
      status: "active",
      created_at: f.clock.now(),
      updated_at: f.clock.now(),
    } as Employee),
  );
  f.apply((s, a, p) =>
    setProjectPreferences(
      s,
      a,
      { system_auto_assign_verifiers: flowVersion < 5 },
      p,
    ),
  );
  f.store.uow.run((tx) =>
    tx.cards.put(f.id, { ...f.card, flow_version: flowVersion }),
  );
  const params = {
    work_item_id: f.produce.id,
    kind: "code" as const,
    summary: "Ready immediately",
    subject: { kind: "git_head" as const, value: "a".repeat(40) },
    requested_verifiers: [f.verify.id, verifier.id],
  };
  const caller = f.actor(f.coder);
  const prepare = () =>
    prepareDelivery(f.state(), caller, params, {
      verify: async () => ({ ok: true, value: [] }),
    });
  const proof = unwrap(await prepare());
  const commit = (store: Store, rollback = false) =>
    store.uow.run((tx) => {
      const effect = unwrap(
        submitDelivery(loadCommandState(tx, f.id), caller, params, proof, {
          clock: f.clock,
          ids: tx.ids,
        }),
      );
      persistEffect(tx, f.id, effect);
      if (rollback) throw new Error("Synthetic persistence failure");
      return effect;
    });
  return { verifier, commit };
}

test.each([1, 5])(
  "C1 flow %s delivery transaction persists assignment and reserves token metadata before any dispatch tick, with atomic rollback",
  async (version) => {
    const { verifier, commit } = await immediateFixture(version);
    const before = f.state();
    expect(() => commit(f.store, true)).toThrow(
      "Synthetic persistence failure",
    );
    expect(f.state().deliveries).toEqual(before.deliveries);
    expect(f.state().assignments).toEqual(before.assignments);
    expect(f.state().events).toEqual(before.events);
    const effect = commit(f.store);
    const assigned = required(
      f.state().work_items.find((w) => w.id === verifier.id)?.assignment_id,
    );
    expect(effect.token_requests.map((t) => t.assignment_id)).toContain(
      assigned,
    );
    expect(
      f.state().assignments.find((a) => a.id === assigned)?.employee_id,
    ).toBe("E-100");
    expect(f.state().runs).toEqual(before.runs);
    routeProjectEvents(f.store, f.id, { clock: f.clock });
    expect(
      f.store
        .listNotifications({ project_id: f.id, assignment_id: assigned })
        .some((n) => n.event_id === effect.events[0]?.id),
    ).toBe(true);
    cycle();
    expect(
      f
        .state()
        .assignments.filter(
          (a) => a.scope === "work_item" && a.work_item_id === verifier.id,
        ),
    ).toHaveLength(1);
  },
);

test.each([1, 5])(
  "C1 flow %s overlapping prepared deliveries and a second connection's recovery scan create only one identity",
  async (version) => {
    const { verifier, commit } = await immediateFixture(version);
    const other = Store.open({ dataDir: required(f.dataDir) });
    try {
      // Both requests passed preparation before either write, just as concurrent MCP submissions do.
      const results = await Promise.all([
        Promise.resolve().then(() => commit(f.store)),
        Promise.resolve().then(() => commit(other)),
        Promise.resolve().then(() => cycle(other)),
      ]);
      expect(results[0]?.token_requests).toHaveLength(1);
      expect(results[1]?.token_requests).toEqual([]);
      expect(
        f
          .state()
          .assignments.filter(
            (a) => a.scope === "work_item" && a.work_item_id === verifier.id,
          ),
      ).toHaveLength(1);
      expect(
        f
          .state()
          .events.filter(
            (e) =>
              e.type === "work_item_assigned" &&
              (e.payload as { work_item_id: string }).work_item_id ===
                verifier.id,
          ),
      ).toHaveLength(1);
      expect(
        f.state().deliveries.filter((d) => d.status !== "superseded"),
      ).toHaveLength(1);
    } finally {
      other.close();
    }
  },
);

test("B3a: transactional scan creates one current completion after all product reviews, including restart/replay", async () => {
  f.store.uow.run((tx) => tx.cards.put(f.id, { ...f.card, flow_version: 5 }));
  f.start(f.coder);
  const product = (await f.delivery()).data;
  cycle();
  expect(
    f.state().deliveries.filter((v) => v.kind === "card_completion"),
  ).toEqual([]);
  f.start(f.reviewer);
  f.review(product.id);
  // Two independent observers must settle against fresh SQLite state.
  const restarted = Store.open({ dataDir: required(f.dataDir) });
  try {
    await Promise.all([
      Promise.resolve().then(() => cycle()),
      Promise.resolve().then(() => cycle(restarted)),
    ]);
    cycle(restarted);
  } finally {
    restarted.close();
  }
  const completions = f
    .state()
    .deliveries.filter((v) => v.kind === "card_completion");
  expect(completions).toHaveLength(1);
  expect(completions[0]).toMatchObject({
    subject: product.subject,
    status: "submitted",
    system_completion: {
      products: [{ delivery_id: product.id, plain_summary: null }],
      reviews: [{ acceptance_evidence_missing: true }],
    },
  });
  const completionId = required(completions[0]).id;
  expect(
    f
      .state()
      .timeline.find(
        (t) => t.delivery_id === completionId && t.type === "delivery",
      )?.author,
  ).toBe("system");
  expect(
    f.store
      .listNotifications({ project_id: f.id, assignment_id: f.pm.id })
      .some(
        (n) =>
          n.kind === "completion" &&
          n.event_id ===
            f
              .state()
              .events.find(
                (e) =>
                  e.type === "delivery_submitted" &&
                  (e.payload as { delivery_id?: string }).delivery_id ===
                    completionId,
              )?.id,
      ),
  ).toBe(true);
  expect(
    f.store
      .listNotifications({ project_id: f.id, assignment_id: f.coder.id })
      .some((n) => n.kind === "completion"),
  ).toBe(false);
  f.start(f.pm);
  f.review(completionId, false, f.pm);
  cycle();
  expect(f.state().cards.find((c) => c.id === f.card.id)?.status).toBe(
    "awaiting_merge",
  );
  expect(
    f.state().deliveries.filter((v) => v.kind === "card_completion"),
  ).toHaveLength(1);
});

test("B3a: missing independent reviewer is routed once to Ops and visible until requirements are repaired", async () => {
  f.store.uow.run((tx) =>
    tx.cards.put(f.id, {
      ...f.card,
      flow_version: 5,
      risk_tags: ["security"],
      high_risk: true,
    }),
  );
  f.start(f.coder);
  await f.delivery();
  cycle();
  cycle();
  expect(
    f.state().deliveries.filter((v) => v.kind === "card_completion"),
  ).toEqual([]);
  expect(
    f.state().events.filter((e) => e.type === "system_completion_deferred"),
  ).toHaveLength(1);
  expect(
    f.store
      .listNotifications({ project_id: f.id })
      .filter((n) =>
        f
          .state()
          .events.some(
            (e) =>
              e.id === n.event_id &&
              [
                "system_completion_deferred",
                "high_risk_review_required",
              ].includes(e.type),
          ),
      ),
  ).toHaveLength(1);
  expect(
    needsYou(f.state(), f.clock.now()).system_rule_attention,
  ).toMatchObject([
    { card_id: f.card.id, detail: expect.stringContaining("独立复核") },
  ]);
});

test("B3a: the scan aggregates a real pass with pre-existing issues and an undelivered optional producer", async () => {
  f.store.uow.run((tx) => tx.cards.put(f.id, { ...f.card, flow_version: 5 }));
  f.extra("coder");
  f.start(f.coder);
  const product = (await f.delivery()).data;
  f.start(f.reviewer);
  const review = f.apply(
    (s, a, p) =>
      submitReview(
        s,
        a,
        {
          delivery_id: product.id,
          target_sha: product.subject.value,
          kind: "code",
          issues: [
            {
              severity: "major",
              must_fix: true,
              pre_existing: true,
              description: "Existing unrelated issue",
            },
          ],
        },
        p,
      ),
    f.actor(f.reviewer),
  ).data;
  expect(review).toMatchObject({ verdict: "pass", blocking: false });
  cycle();
  const completion = required(
    f.state().deliveries.find((v) => v.kind === "card_completion"),
  );
  expect(completion.system_completion).toMatchObject({
    products: [{ delivery_id: product.id, subject: product.subject }],
    reviews: [{ review_id: review.id, issues: review.issues }],
  });
  const restarted = Store.open({ dataDir: required(f.dataDir) });
  try {
    cycle(restarted);
  } finally {
    restarted.close();
  }
  expect(
    f.state().deliveries.filter((v) => v.kind === "card_completion"),
  ).toEqual([completion]);
});

test("B3a: internal submission errors fail the scan without partially persisting a completion", async () => {
  f.store.uow.run((tx) => tx.cards.put(f.id, { ...f.card, flow_version: 5 }));
  f.start(f.coder);
  const product = (await f.delivery()).data;
  f.start(f.reviewer);
  f.review(product.id);
  const current = required(
    f.state().deliveries.find((v) => v.id === product.id),
  );
  f.store.uow.run((tx) =>
    tx.deliveries.put(f.id, {
      ...current,
      attachments: ["missing-attachment"],
    }),
  );
  const before = f.state();
  expect(() => runSystemRules(f.store, f.id, f.clock)).toThrow(
    "missing-attachment",
  );
  expect(f.state().deliveries).toEqual(before.deliveries);
  expect(f.state().events).toEqual(before.events);
  expect(f.state().timeline).toEqual(before.timeline);
  expect(f.state().work_items).toEqual(before.work_items);
});

test("B3a: persistence failure rolls back completion, event and acceptance readiness together", async () => {
  f.store.uow.run((tx) => tx.cards.put(f.id, { ...f.card, flow_version: 5 }));
  f.start(f.coder);
  const product = (await f.delivery()).data;
  f.start(f.reviewer);
  f.review(product.id);
  const before = f.state();
  // The unit of work's exception path is exercised after producing the full effect.
  expect(() =>
    f.store.uow.run((tx) => {
      const effect = unwrap(
        systemCompleteCard(
          loadCommandState(tx, f.id),
          { kind: "system", project_id: f.id },
          { card_id: f.card.id },
          { clock: f.clock, ids: tx.ids },
        ),
      );
      persistEffect(tx, f.id, effect);
      throw new Error("synthetic persistence failure");
    }),
  ).toThrow("synthetic persistence failure");
  expect(f.state().deliveries).toEqual(before.deliveries);
  expect(f.state().events).toEqual(before.events);
  expect(f.state().work_items).toEqual(before.work_items);
  cycle();
  expect(
    f.state().deliveries.filter((v) => v.kind === "card_completion"),
  ).toHaveLength(1);
});

test.each([undefined, false, true])(
  "C1 future scan assigns with legacy switch %s, and restart does not duplicate",
  async (enabled) => {
    const { verifier } = await ready();
    f.store.uow.run((tx) => tx.cards.put(f.id, { ...f.card, flow_version: 5 }));
    if (enabled !== undefined)
      f.apply((s, a, p) =>
        setProjectPreferences(
          s,
          a,
          { system_auto_assign_verifiers: enabled },
          p,
        ),
      );
    cycle();
    const assigned = required(
      f.state().work_items.find((w) => w.id === verifier.id)?.assignment_id,
    );
    const reopened = Store.open({ dataDir: required(f.dataDir) });
    try {
      cycle(reopened);
    } finally {
      reopened.close();
    }
    expect(
      f
        .state()
        .assignments.filter(
          (a) => a.scope === "work_item" && a.work_item_id === verifier.id,
        ),
    ).toHaveLength(1);
    expect(
      f.store.listNotifications({ project_id: f.id, assignment_id: assigned })
        .length,
    ).toBeGreaterThan(0);
    expect(
      f.store
        .listNotifications({ project_id: f.id })
        .filter(
          (n) =>
            n.recipient.kind === "pm_ops" &&
            n.seq >=
              required(
                f.state().events.find((e) => e.type === "delivery_submitted"),
              ).seq,
        ),
    ).toEqual([]);
  },
);

test("C1 disabled legacy switch still projects future assignment failures without a generic duplicate", async () => {
  const { verifier } = await ready(false);
  f.store.uow.run((tx) => tx.cards.put(f.id, { ...f.card, flow_version: 5 }));
  cycle();
  cycle();
  expect(
    f.state().events.filter((e) => e.type === "system_assignment_deferred"),
  ).toHaveLength(1);
  expect(
    needsYou(f.state(), f.clock.now()).system_rule_attention,
  ).toMatchObject([
    {
      card_id: f.card.id,
      work_item_id: verifier.id,
      detail: expect.stringContaining("没有合格"),
    },
  ]);
  expect(
    f.store
      .listNotifications({ project_id: f.id })
      .filter(
        (n) =>
          n.recipient.kind === "pm_ops" &&
          n.seq >=
            required(
              f.state().events.find((e) => e.type === "delivery_submitted"),
            ).seq,
      ),
  ).toEqual([]);
  expect(
    f.store
      .listNotifications({ project_id: f.id })
      .filter((n) => n.recipient.kind === "needs_you"),
  ).toHaveLength(1);
});

test("C-383 maintenance cancels legacy open actions on cancelled cards exactly once", () => {
  const original = f.card;
  f.store.uow.run((tx) => {
    tx.cards.put(f.id, { ...original, status: "cancelled" });
    const id = tx.ids.next(f.id, "human_action");
    tx.human_actions.put(f.id, {
      id,
      key: id,
      card_id: original.id,
      requested_by: "human",
      instructions: "Legacy task",
      why_human: "Host access",
      expected_return: "Evidence",
      blocked_work_items: [],
      status: "open",
      ready_when: { kind: "manual" },
    });
  });
  cycle();
  expect(f.state().human_actions[0]).toMatchObject({
    status: "cancelled",
    cancellation: { source: "card_cancelled" },
  });
  expect(f.state().human_actions[0]?.result).toBeUndefined();
  const events = f
    .state()
    .events.filter((e) => e.type === "human_action_cancelled");
  expect(events).toHaveLength(1);
  cycle();
  expect(
    f.state().events.filter((e) => e.type === "human_action_cancelled"),
  ).toEqual(events);
});
