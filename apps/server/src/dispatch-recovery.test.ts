import { acknowledgeRun } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { Dispatcher } from "./dispatch.js";

let f: ReturnType<typeof recoveryFixture>;
beforeEach(() => {
  f = recoveryFixture();
});
afterEach(() => f.close());
const alerts = (kind = "pm_ops") =>
  f.store
    .listNotifications({ project_id: f.project })
    .filter((n) => n.recipient.kind === kind);

test("§3.3 retries at 1/2/4/8 minutes, reuses the original Run and escalates once after the final ACK window", async () => {
  f.comment();
  await new Dispatcher(f.options).tick();
  f.complete();
  f.skipEvents();
  for (const [i, delay] of [60000, 120000, 240000, 480000].entries()) {
    f.advance(delay - 1);
    await new Dispatcher(f.options).tick();
    expect(f.runtime.wake).toHaveBeenCalledTimes(i + 1);
    f.advance(1);
    await new Dispatcher(f.options).tick();
    expect(f.runtime.wake).toHaveBeenCalledTimes(i + 2);
    expect(f.notes()[0]?.attempts).toBe(i + 2);
    expect(f.state().runs).toHaveLength(2);
  }
  f.advance(480000 - 1);
  await new Dispatcher(f.options).tick();
  expect(f.notes()[0]?.status).toBe("belled");
  f.advance(1);
  await new Dispatcher(f.options).tick();
  await new Dispatcher(f.options).tick();
  expect(f.notes()[0]?.status).toBe("resolved");
  expect(f.runtime.wake).toHaveBeenCalledTimes(5);
  expect(alerts()).toHaveLength(1);
});

test.each([false, true])(
  "§3.3 an unfinished dispatched/running Run prevents retry (running=%s)",
  async (running) => {
    f.comment();
    const d = new Dispatcher({
      ...f.options,
      inactivityGraceMs: 86400000,
      dispatchTimeoutMs: 86400000,
    });
    await d.tick();
    const run = f.latest();
    if (running)
      f.apply(
        (s, a, p) => acknowledgeRun(s, a, { run_id: run.id }, p),
        f.actorFor(f.target.assignment),
      );
    f.advance(3600000);
    await d.tick();
    expect(f.runtime.wake).toHaveBeenCalledOnce();
    expect(f.notes()[0]).toMatchObject({ status: "belled", attempts: 1 });
    expect(alerts()).toEqual([]);
  },
);

test("§3.3 configurable retry base/limit and ACK before exhaustion stop delivery", async () => {
  f.comment();
  const d = new Dispatcher({ ...f.options, retryBaseMs: 100, maxRetries: 1 });
  await d.tick();
  f.complete();
  f.skipEvents();
  f.advance(100);
  await d.tick();
  expect(f.runtime.wake).toHaveBeenCalledTimes(2);
  const n = f.notes()[0];
  if (!n?.card_id) throw new Error("Missing card notification");
  f.store.ackEvents({
    project_id: f.project,
    assignment_id: f.target.assignment.id,
    card_id: n.card_id,
    up_to_seq: n.seq,
  });
  f.advance(100);
  await d.tick();
  expect(f.notes()[0]?.status).toBe("acked");
  expect(alerts()).toEqual([]);
});

test("C-56 failure on an already completed Run resolves obsolete attention", async () => {
  f.comment();
  const d = new Dispatcher(f.options);
  await d.tick();
  f.complete();
  f.skipEvents();
  vi.mocked(f.runtime.wake).mockResolvedValue({
    ok: false,
    error: { code: "runtime_timeout", message: "uncertain" },
  });
  f.advance(60000);
  await d.tick();
  f.advance(3600000);
  await d.tick();
  expect(f.runtime.wake).toHaveBeenCalledTimes(2);
  expect(f.state().runs).toHaveLength(2);
  expect(f.notes()[0]?.status).toBe("resolved");
  expect(alerts()).toHaveLength(1);
});

test("§3.3 watchdog uses every MCP activity, keeps the Run running and deduplicates across connections", async () => {
  f.session(f.target.assignment, false);
  f.skipEvents();
  const d = new Dispatcher(f.options);
  f.advance(14 * 60000);
  await d.tick();
  expect(alerts()).toEqual([]);
  f.store.touchAssignmentActivity(
    f.project,
    f.target.assignment.id,
    f.clock.now(),
  );
  f.advance(15 * 60000 - 1);
  await d.tick();
  expect(alerts()).toEqual([]);
  f.advance(1);
  await d.tick();
  expect(f.notes()[0]).toMatchObject({
    status: "needs_attention",
    run_id: f.latest().id,
  });
  expect(f.latest().status).toBe("running");
  expect(alerts()).toHaveLength(1);
  const reopened = Store.open({ dataDir: f.dataDir });
  try {
    await new Dispatcher({ ...f.options, store: reopened }).tick();
  } finally {
    reopened.close();
  }
  expect(alerts()).toHaveLength(1);
  expect(f.runtime.wake).not.toHaveBeenCalled();
});

test("§3.3 watchdog grace is configurable, uses the new Run start and ignores completed Runs", async () => {
  f.advance(60000);
  const d = new Dispatcher({ ...f.options, inactivityGraceMs: 100 });
  await d.tick();
  expect(alerts()).toEqual([]);
  f.session(f.target.assignment, false);
  f.skipEvents();
  f.advance(99);
  await d.tick();
  expect(alerts()).toEqual([]);
  f.advance(1);
  await d.tick();
  expect(alerts()).toHaveLength(1);
});

test("§3.3 zero retries escalates after the first ACK window and concurrent retry claims send once", async () => {
  f.comment();
  const d = new Dispatcher({ ...f.options, maxRetries: 0 });
  await d.tick();
  f.complete();
  f.skipEvents();
  f.advance(60000);
  await d.tick();
  expect(f.notes()[0]?.status).toBe("needs_attention");
  expect(f.runtime.wake).toHaveBeenCalledOnce();
  f.comment();
  const other = new Dispatcher(f.options);
  await other.tick();
  f.complete();
  f.skipEvents();
  f.advance(60000);
  await Promise.all([other.tick(), new Dispatcher(f.options).tick()]);
  expect(f.runtime.wake).toHaveBeenCalledTimes(3);
});

test.each([
  { maxRetries: -1 },
  { retryBaseMs: 0 },
  { inactivityGraceMs: Number.NaN },
  { inactivityGraceMs: Number.POSITIVE_INFINITY },
  { maxRetries: 1.5 },
])("rejects invalid policy %o", (policy) => {
  expect(() => new Dispatcher({ ...f.options, ...policy })).toThrow(
    "Invalid dispatcher",
  );
});

test.each([Number.NaN, Number.POSITIVE_INFINITY])(
  "rejects invalid cancellation grace %s independently of watchdog settings",
  (inactiveCancelAfterMs) => {
    expect(
      () => new Dispatcher({ ...f.options, inactiveCancelAfterMs }),
    ).toThrow("Invalid inactive Run cancellation grace");
  },
);

test("disabling inactive cancellation keeps the watchdog active", async () => {
  f.session(f.target.assignment, false);
  f.skipEvents();
  const d = new Dispatcher({
    ...f.options,
    inactivityGraceMs: 100,
    inactiveCancelAfterMs: null,
  });
  f.advance(2 * 60 * 60_000);
  await d.tick();
  expect(alerts()).toHaveLength(1);
  expect(f.latest().status).toBe("running");
  expect(f.runtime.release).not.toHaveBeenCalled();
});
