import {
  createWorkItem,
  type Employee,
  setProjectPreferences,
} from "@cardigan/domain";
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
