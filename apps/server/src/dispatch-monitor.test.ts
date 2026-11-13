import type { RunOutcome } from "@cardigan/domain";
import { issueTokenInTransaction } from "@cardigan/host";
import { authenticate, serverTools, unwrap } from "@cardigan/mcp-server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { runtimeEvents } from "../test-support/runtime-events.js";
import { RuntimeMonitor } from "./dispatch-monitor.js";

let f: ReturnType<typeof recoveryFixture>,
  events: ReturnType<typeof runtimeEvents>,
  monitor: RuntimeMonitor,
  token: ReturnType<typeof issueTokenInTransaction>;
beforeEach(() => {
  f = recoveryFixture();
  f.session(f.target.assignment, false);
  f.skipEvents();
  token = issue();
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
const issue = () =>
  f.store.uow.run((tx) =>
    issueTokenInTransaction(tx, f.project, f.target.assignment.id, {
      role_version: f.target.assignment.role_version,
      allowed_tools: ["finish_run"],
    }),
  );
const finish = async (outcome: RunOutcome = "completed", summary = "Done") => {
  const tool = serverTools({ clock: f.clock }).find(
    (t) => t.name === "finish_run",
  );
  if (!tool) throw new Error("Missing finish_run tool");
  return tool.handler(
    tool.input.parse({
      idempotency_key: "deferred-finish",
      run_id: f.latest().id,
      outcome,
      summary,
      // Caller-supplied evidence is not part of the tool schema.
      run_token: { id: "caller-injected" },
    }),
    {
      store: f.store,
      identity: unwrap(authenticate(f.store, token.token)),
      revalidateToken: () => {
        if (!f.store.verifyToken(token.token)) throw new Error("Revoked Token");
      },
    },
  );
};
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

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test.each(["error", "eof"])(
  "C-219 subscription %s reconnects silently until consecutive failures reach the limit",
  async (mode) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const session = events.sessions.at(-1);
      if (!session) throw new Error("Missing subscription");
      if (mode === "error")
        session.push({
          ok: false,
          error: { code: "runtime_unavailable", message: "disconnected" },
        });
      else session.end();
      await flush();
      expect(state()).toBe(attempt < 3 ? "running" : "unknown");
      monitor.reconcile();
    }
    alive(1);
    await expectState("idle");
    expect(f.latest().status).toBe("running");
    expect(
      f.state().events.filter((e) => e.type === "runtime_disconnected"),
    ).toHaveLength(1);
  },
);

test.each(["missing", "exited", "unknown", "not_found"])(
  "C-219 explicit terminal %s still disconnects immediately",
  async (mode) => {
    if (mode === "not_found")
      events.sessions[0]?.push({
        ok: false,
        error: { code: "runtime_not_found", message: "gone" },
      });
    else
      events.send({
        seq: 1,
        type: "snapshot",
        observations:
          mode === "missing"
            ? []
            : [
                {
                  terminal_ref: f.refFor(f.target.assignment).terminal_ref,
                  status: {
                    process: mode as "exited" | "unknown",
                    agent: "idle",
                    observed_seq: 1,
                  },
                },
              ],
      });
    await expectState("unknown");
  },
);

test("C-219 equal-seq heartbeats refresh silence; silent subscriptions reconnect before disconnecting", async () => {
  await monitor.stop();
  monitor = new RuntimeMonitor({
    store: f.store,
    runtime: events.source,
    clock: f.clock,
    eventSilenceMs: 100,
    reconcileIntervalMs: 100,
    lossGraceMs: 200,
    maxConsecutiveFailures: 2,
  });
  monitor.reconcile();
  alive(1);
  await flush();
  f.advance(99);
  events.send({ seq: 1, type: "heartbeat" });
  await flush();
  f.advance(99);
  monitor.reconcile();
  expect(state()).toBe("running");
  const before = events.sessions.length;
  f.advance(1);
  monitor.reconcile();
  expect(state()).toBe("running");
  expect(events.sessions).toHaveLength(before + 1);
  f.advance(100);
  monitor.reconcile();
  expect(state()).toBe("unknown");
  f.advance(199);
  monitor.reconcile();
  expect(state()).toBe("unknown");
  f.advance(1);
  monitor.reconcile();
  expect(state()).toBe("lost");
});

test("C-219 a 60-second blocked reconcile with queued stream data does not disconnect or abort it", async () => {
  alive(1);
  await flush();
  f.advance(60_000);
  alive(2);
  monitor.reconcile();
  await flush();
  monitor.reconcile();
  expect(state()).toBe("running");
  expect(events.sessions).toHaveLength(1);
  expect(events.sessions[0]?.signal?.aborted).toBe(false);
  expect(f.state().events.some((e) => e.type === "runtime_disconnected")).toBe(
    false,
  );
});

test("C-219 synchronous work inside reconcile is also excluded from silence", async () => {
  const original = f.store.uow.read.bind(f.store.uow);
  const spy = vi
    .spyOn(f.store.uow, "read")
    .mockImplementationOnce((operation) => {
      f.advance(60_000);
      return original(operation);
    });
  monitor.reconcile();
  spy.mockRestore();
  monitor.reconcile();
  expect(events.sessions).toHaveLength(1);
  alive(1);
  await flush();
  expect(state()).toBe("running");
});

test("C-219 confirmed alive resets the failure streak and stale subscriptions cannot consume the new budget", async () => {
  events.sessions[0]?.end();
  await flush();
  monitor.reconcile();
  alive(1);
  await flush();
  for (let i = 0; i < 2; i++) {
    events.sessions.at(-1)?.end();
    await flush();
    monitor.reconcile();
  }
  expect(state()).toBe("running");
  events.sessions.at(-1)?.end();
  await flush();
  expect(state()).toBe("unknown");
});

test.each(["completed", "blocked", "failed"] as const)(
  "C-219 finish_run(%s) during unknown persists across monitor restart and settles once after alive",
  async (outcome) => {
    lost();
    await expectState("unknown");
    const run = f.latest();
    const work = f.state().work_items;
    await finish(outcome, "Done while disconnected");
    expect(f.latest().pending_finish?.token_id).toBe(token.record.id);
    expect(f.latest()).toMatchObject({
      status: "unknown",
      pending_finish: { outcome },
    });
    expect(f.latest().finished_at).toBeUndefined();
    await monitor.stop();
    monitor = new RuntimeMonitor({
      store: f.store,
      runtime: events.source,
      clock: f.clock,
    });
    monitor.reconcile();
    alive(1);
    await flush();
    expect(f.latest()).toMatchObject({
      status: outcome === "failed" ? "failed" : "completed",
      outcome,
      summary: "Done while disconnected",
    });
    expect(f.latest().pending_finish).toBeUndefined();
    alive(2);
    await flush();
    expect(
      f
        .state()
        .events.filter(
          (e) =>
            e.type === "run_finished" &&
            (e.payload as { run_id?: string }).run_id === run.id,
        ),
    ).toHaveLength(1);
    expect(f.state().work_items).toEqual(work);
  },
);

test("C-219 a pending finish waits for a withdrawn stop fence and a fresh alive observation", async () => {
  lost();
  await expectState("unknown");
  const run = f.latest();
  await finish();
  f.store.uow.run((tx) => {
    const current = tx.runs.get(f.project, run.id);
    if (!current) throw new Error("Missing Run");
    tx.runs.put(f.project, {
      ...current,
      inactivity_stop: {
        attempt_id: "concurrent-stop",
        runtime_ref: f.refFor(f.target.assignment),
        stopping: false,
        lease_until: f.clock.now(),
      },
    });
  });
  alive(2);
  await flush();
  expect(f.latest().status).toBe("running");
  f.store.uow.run((tx) => {
    const current = tx.runs.get(f.project, run.id);
    if (!current) throw new Error("Missing Run");
    const clean = { ...current };
    delete clean.inactivity_stop;
    tx.runs.put(f.project, clean);
  });
  alive(2);
  await flush();
  expect(f.latest().status).toBe("running");
  alive(3);
  await flush();
  expect(f.latest().status).toBe("completed");
});

test("C-219 an unrecovered terminal with a pending finish still expires through the existing lost flow", async () => {
  lost();
  await expectState("unknown");
  await finish();
  f.advance(300_000);
  monitor.reconcile();
  expect(state()).toBe("lost");
  alive(2);
  await flush();
  expect(f.latest().status).toBe("unknown");
  expect(f.latest().finished_at).toBeUndefined();
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

test.each([
  { lossGraceMs: 0 },
  { eventSilenceMs: Number.NaN },
  ...[0, 1, -1, 1.5, Number.NaN, Infinity].map((maxConsecutiveFailures) => ({
    maxConsecutiveFailures,
  })),
])("rejects invalid monitor configuration %j", (config) => {
  expect(
    () =>
      new RuntimeMonitor({
        store: f.store,
        runtime: events.source,
        ...config,
      }),
  ).toThrow("Invalid runtime monitor");
});

test.each(["rotate", "revoke"])(
  "C-219 real Token %s cannot settle an old deferred finish on the same RuntimeRef",
  async (mode) => {
    const reference = f
      .state()
      .assignments.find((a) => a.id === f.target.assignment.id)?.mcp_token_id;
    lost();
    await expectState("unknown");
    const run = f.latest();
    await finish();
    expect(f.latest().pending_finish?.token_id).toBe(token.record.id);
    expect(f.latest().pending_finish?.token_id).not.toBe(reference);
    if (mode === "rotate") {
      const replacement = issue();
      expect(token.record.id).not.toBe(replacement.record.id);
    } else f.store.uow.run((tx) => tx.revokeToken(token.record.id));
    expect(f.store.verifyToken(token.token)).toBeUndefined();
    expect(
      f.state().assignments.find((a) => a.id === f.target.assignment.id)
        ?.mcp_token_id,
    ).toBe(reference);
    await expect(finish()).rejects.toMatchObject({ code: "unauthorized" });
    alive(2);
    await flush();
    expect(f.latest().status).toBe("running");
    expect(f.latest().pending_finish?.token_id).toBe(token.record.id);
    expect(f.latest().finished_at).toBeUndefined();
    expect(
      f
        .state()
        .events.filter(
          (e) =>
            e.type === "run_finished" &&
            (e.payload as { run_id?: string }).run_id === run.id,
        ),
    ).toHaveLength(0);
  },
);

test.each([0, -1, 1.5, Number.NaN, Infinity, 2147483648])(
  "C-219 monitor shares the dispatcher interval error contract for %s",
  (reconcileIntervalMs) => {
    expect(
      () =>
        new RuntimeMonitor({
          store: f.store,
          runtime: events.source,
          reconcileIntervalMs,
        }),
    ).toThrow("Invalid dispatcher interval");
  },
);
