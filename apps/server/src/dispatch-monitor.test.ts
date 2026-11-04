import { afterEach, beforeEach, expect, test } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { runtimeEvents } from "../test-support/runtime-events.js";
import { RuntimeMonitor } from "./dispatch-monitor.js";

let f: ReturnType<typeof recoveryFixture>,
  events: ReturnType<typeof runtimeEvents>,
  monitor: RuntimeMonitor;
beforeEach(() => {
  f = recoveryFixture();
  f.session(f.target.assignment, false);
  f.skipEvents();
  events = runtimeEvents();
  monitor = new RuntimeMonitor({
    store: f.store,
    runtime: events.source,
    clock: f.clock,
  });
  monitor.reconcile();
});
afterEach(async () => {
  await monitor.stop();
  f.close();
});
const state = () =>
  f.state().assignments.find((a) => a.id === f.target.assignment.id)
    ?.runtime_state;
const alive = (seq: number, index?: number) =>
  events.send(
    {
      seq,
      type: "snapshot",
      observations: [
        {
          terminal_ref: f.refFor(f.target.assignment).terminal_ref,
          status: { process: "alive", agent: "idle", observed_seq: seq },
        },
      ],
    },
    index,
  );
const lost = (seq = 1, type = "lost") =>
  events.send({
    seq,
    type,
    terminal_ref: f.refFor(f.target.assignment).terminal_ref,
  });
const expectState = async (s: string) => {
  await expect.poll(state).toBe(s);
};

test.each(["lost", "finished", "terminal.finished", "removed"])(
  "§13.9 %s makes the Assignment/Run unknown without completing work",
  async (type) => {
    const work = f.state().work_items;
    lost(1, type);
    await expectState("unknown");
    expect(f.latest().status).toBe("unknown");
    expect(f.state().work_items).toEqual(work);
    expect(f.store.listNotifications({ project_id: f.project })).toEqual([]);
  },
);

test("§13.9 a new observation reconnects unknown, duplicate/older observations cannot roll it back", async () => {
  lost(3);
  await expectState("unknown");
  alive(2);
  alive(3);
  await new Promise((resolve) => setImmediate(resolve));
  expect(state()).toBe("unknown");
  alive(4);
  await expectState("idle");
  expect(f.latest().status).toBe("running");
  lost(3);
  await new Promise((resolve) => setImmediate(resolve));
  expect(state()).toBe("idle");
  expect(f.state().runs).toHaveLength(2);
  expect(
    f.state().events.filter((e) => e.type === "runtime_reconnected"),
  ).toHaveLength(1);
});

test("§13.9 persisted first loss survives restart, expires after five minutes and never auto-takes over", async () => {
  lost();
  await expectState("unknown");
  f.advance(120000);
  lost(2);
  await new Promise((resolve) => setImmediate(resolve));
  await monitor.stop();
  monitor = new RuntimeMonitor({
    store: f.store,
    runtime: events.source,
    clock: f.clock,
    eventSilenceMs: 3600000,
  });
  monitor.reconcile();
  f.advance(179999);
  monitor.reconcile();
  expect(state()).toBe("unknown");
  f.advance(1);
  monitor.reconcile();
  expect(state()).toBe("lost");
  alive(9);
  await new Promise((resolve) => setImmediate(resolve));
  monitor.reconcile();
  expect(state()).toBe("lost");
  expect(f.latest().status).toBe("unknown");
  expect(f.state().runs).toHaveLength(2);
  const notes = f.store.listNotifications({ project_id: f.project });
  expect(notes.map((n) => n.recipient.kind).sort()).toEqual([
    "needs_you",
    "pm_office",
  ]);
  expect(
    f.state().events.filter((e) => e.type === "runtime_lost"),
  ).toHaveLength(1);
});

test("§13.9 a recovered connection starts a new loss grace period", async () => {
  lost();
  await expectState("unknown");
  f.advance(290000);
  alive(2);
  await expectState("idle");
  lost(3);
  await expectState("unknown");
  f.advance(10000);
  monitor.reconcile();
  expect(state()).toBe("unknown");
  f.advance(290000);
  monitor.reconcile();
  expect(state()).toBe("lost");
});

test.each(["error", "eof", "missing"])(
  "§13.9 subscription %s is uncertainty, and a fresh snapshot can confirm reconnection",
  async (mode) => {
    const session = events.sessions[0];
    if (!session) throw new Error("Missing subscription");
    if (mode === "error")
      session.push({
        ok: false,
        error: { code: "runtime_unavailable", message: "disconnected" },
      });
    else if (mode === "eof") session.end();
    else events.send({ type: "snapshot", seq: 1 });
    await expectState("unknown");
    if (mode === "missing") session.end();
    await new Promise((resolve) => setImmediate(resolve));
    monitor.reconcile();
    alive(1);
    await expectState("idle");
  },
);

test("§13.9 equal-seq heartbeats keep the stream alive; silence triggers unknown and honors configured grace", async () => {
  await monitor.stop();
  monitor = new RuntimeMonitor({
    store: f.store,
    runtime: events.source,
    clock: f.clock,
    eventSilenceMs: 100,
    lossGraceMs: 200,
  });
  monitor.reconcile();
  alive(1);
  await new Promise((resolve) => setImmediate(resolve));
  f.advance(99);
  events.send({ seq: 1, type: "heartbeat" });
  await new Promise((resolve) => setImmediate(resolve));
  f.advance(99);
  monitor.reconcile();
  expect(state()).toBe("running");
  f.advance(1);
  monitor.reconcile();
  expect(state()).toBe("unknown");
  f.advance(199);
  monitor.reconcile();
  expect(state()).toBe("unknown");
  f.advance(1);
  monitor.reconcile();
  expect(state()).toBe("lost");
});

test("stale terminal events cannot affect a replacement Session; stop aborts subscriptions without losing it", async () => {
  const a = f.state().assignments.find((a) => a.id === f.target.assignment.id);
  if (!a?.runtime_ref) throw new Error("Missing runtime");
  const ref = a.runtime_ref;
  f.store.uow.run((tx) =>
    tx.assignments.put(f.project, {
      ...a,
      runtime_ref: { ...ref, terminal_ref: "replacement" },
    }),
  );
  lost();
  await new Promise((resolve) => setImmediate(resolve));
  expect(state()).toBe("running");
  monitor.reconcile();
  expect(events.sessions[0]?.signal?.aborted).toBe(true);
  expect(events.sessions.at(-1)?.ref.terminal_ref).toBe("replacement");
  await monitor.stop();
  expect(events.sessions.every((s) => s.signal?.aborted)).toBe(true);
  expect(state()).toBe("running");
});

test("completed Runs do not become unknown when the terminal exits", async () => {
  f.complete();
  const before = state();
  lost();
  await new Promise((resolve) => setImmediate(resolve));
  monitor.reconcile();
  expect(f.latest().status).toBe("completed");
  expect(state()).toBe(before);
  expect(events.sessions[0]?.signal?.aborted).toBe(true);
});

test.each([{ lossGraceMs: 0 }, { eventSilenceMs: Number.NaN }])(
  "rejects invalid monitor configuration %j",
  (config) => {
    expect(
      () =>
        new RuntimeMonitor({
          store: f.store,
          runtime: events.source,
          ...config,
        }),
    ).toThrow("Invalid runtime monitor");
  },
);
