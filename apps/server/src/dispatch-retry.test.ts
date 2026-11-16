import {
  type Assignment,
  abortDispatch,
  acknowledgeRun,
  claimDispatchStop,
  dispatchRun,
  finishRun,
  listNeedsYou,
  queueRun,
  type Run,
  startDispatchStop,
} from "@cardigan/domain";
import { runCapacitySnapshot } from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
import {
  beginDispatchRetry,
  beginLaunchAttempt,
  finishBellAttempt,
  listBellAttempts,
  Store,
  tokensForAssignment,
  unfinishedBellAttempts,
} from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { standingResolver } from "./assembly.js";
import { resolveServerConfig } from "./config.js";
import { Dispatcher } from "./dispatch.js";
import { retryDispatchedRuns } from "./dispatch-retry.js";

let f: ReturnType<typeof recoveryFixture>;
beforeEach(() => {
  f = recoveryFixture();
});
afterEach(() => f.close());
const fail = () =>
  vi.mocked(f.runtime.wake).mockResolvedValue({
    ok: false,
    error: { code: "runtime_timeout", message: "uncertain" },
  });
const start = () => {
  const id = f.latest().id;
  f.apply(
    (s, a, p) => acknowledgeRun(s, a, { run_id: id }, p),
    f.actorFor(f.target.assignment),
  );
};
const count = (type: string) =>
  f.state().events.filter((e) => e.type === type).length;
const dispatcher = (extra: Partial<typeof f.options> = {}) =>
  new Dispatcher({
    ...f.options,
    standing: standingResolver(f.store),
    ...extra,
  });

const occupied = () =>
  f.store.uow.read((tx) =>
    runCapacitySnapshot(f.store, tx).occupied.get("local"),
  );

test("C-339: settled and ordinary failed history does not add retry state reads", async () => {
  const original = f.latest();
  const source = f
    .state()
    .events.find((e) => e.id === original.trigger_event_id);
  if (!source) throw new Error("Missing source event");
  f.store.uow.run((tx) => {
    for (let i = 0; i < 600; i++) {
      const { started_at, ...base } = original;
      const cause = {
        ...source,
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(f.project, source.card_id),
      };
      tx.events.append(f.project, cause);
      tx.runs.put(f.project, {
        ...base,
        trigger_event_id: cause.id,
        id: tx.ids.next(f.project, "run"),
        status: i % 2 ? "completed" : "failed",
        ...(i % 2 ? { started_at } : {}),
        outcome: i % 2 ? "completed" : "failed",
      });
    }
  });
  const loadState = vi.fn(loadCommandState);
  const settle = vi.fn();
  const policy = {
    timeoutMs: 600000,
    retryBaseMs: 30000,
    maxRetries: 4,
    leaseMs: 60000,
  };
  await retryDispatchedRuns(
    { ...f.options, clock: f.clock, loadState },
    f.project,
    policy,
    settle,
  );
  expect(loadState).toHaveBeenCalledTimes(1);
  expect(f.runtime.status).not.toHaveBeenCalled();
  expect(settle).not.toHaveBeenCalled();
  f.skipEvents();
  // A new, legitimate failed bell is still discovered alongside that history.
  fail();
  f.comment();
  const d = dispatcher();
  await d.tick();
  const run = f.latest();
  f.advance(30000);
  await d.tick();
  expect(f.latest().id).toBe(run.id);
  expect(f.runtime.wake).toHaveBeenCalledTimes(2);
});

test("C-339: late recovery evidence refreshes after cross-connection commit, not rollback", async () => {
  f.comment();
  await dispatcher().tick();
  const run = f.latest();
  const policy = {
    timeoutMs: 600000,
    retryBaseMs: 30000,
    maxRetries: 4,
    leaseMs: 60000,
  };
  const retry = () =>
    retryDispatchedRuns(
      { ...f.options, clock: f.clock },
      f.project,
      policy,
      vi.fn(),
    );
  const emit = (store: Store, type: string, payload: Record<string, string>) =>
    store.uow.run((tx) =>
      tx.events.append(f.project, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(f.project, f.target.card.id),
        card_id: f.target.card.id,
        type,
        payload,
        actor: { kind: "system", project_id: f.project },
        created_at: f.clock.now(),
      }),
    );
  f.store.uow.run((tx) =>
    tx.runs.put(f.project, {
      ...run,
      status: "failed",
      outcome: "failed",
      finished_at: f.clock.now(),
    }),
  );
  emit(f.store, "run_dispatch_aborted", { run_id: run.id });
  await retry();
  expect(count("run_dispatch_stalled")).toBe(0);
  const recovered = {
    replacement_run_id: run.id,
    assignment_id: run.assignment_id,
  };
  expect(() =>
    f.store.uow.run((tx) => {
      tx.events.append(f.project, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(f.project),
        type: "run_dispatch_recovered",
        actor: { kind: "system", project_id: f.project },
        payload: recovered,
        created_at: f.clock.now(),
      });
      throw new Error("rollback");
    }),
  ).toThrow("rollback");
  await retry();
  expect(count("run_dispatch_stalled")).toBe(0);
  const other = Store.open({ dataDir: f.dataDir });
  try {
    emit(other, "run_dispatch_recovered", recovered);
    await retry();
    expect(count("run_dispatch_stalled")).toBe(1);
    expect(
      f.state().events.find((e) => e.type === "run_dispatch_stalled")?.payload,
    ).toMatchObject({ run_id: run.id, reason: "recovery_startup_failed" });
    emit(other, "run_dispatch_recovered", recovered);
    emit(other, "run_dispatch_aborted", { run_id: run.id });
    await retry();
    expect(count("run_dispatch_stalled")).toBe(1);
  } finally {
    other.close();
  }
});

test("timeout recovery queues behind occupied capacity and dispatches once when the slot opens", async () => {
  f.comment();
  await dispatcher().tick();
  const original = f.latest();
  const busy = f.create();
  const running = f.session(busy.assignment, false);
  f.skipEvents();
  const d = dispatcher({
    runLimit: () => 1,
    dispatchTimeoutMs: 100,
    inactiveCancelAfterMs: null,
  });
  f.advance(100);
  await d.tick();
  const replacement = f.latest();
  expect(replacement).toMatchObject({
    status: "queued",
    queue_reason: "concurrency_limit",
  });
  expect(f.state().runs.find((r) => r.id === original.id)?.status).toBe(
    "cancelled",
  );
  expect(occupied()).toBe(1);
  expect(f.options.startRun).not.toHaveBeenCalled();
  expect(
    f.state().events.find((e) => e.type === "run_dispatch_recovered")?.actor,
  ).toMatchObject({ kind: "system" });
  // A healthy capacity wait must outlive the dispatch timeout without escalation.
  f.advance(600000);
  await d.tick();
  expect(f.latest()).toMatchObject({ id: replacement.id, status: "queued" });
  expect(count("run_dispatch_stalled")).toBe(0);
  f.apply(
    (s, a, p) =>
      finishRun(
        s,
        a,
        {
          run_id: running.id,
          outcome: "completed",
          summary: "slot available",
        },
        p,
      ),
    f.actorFor(busy.assignment),
  );
  expect(occupied()).toBe(0);
  await d.tick();
  expect(f.latest()).toMatchObject({
    id: replacement.id,
    status: "dispatched",
  });
  expect(f.options.startRun).toHaveBeenCalledOnce();
  expect(occupied()).toBe(1);
  expect(count("run_dispatch_recovered")).toBe(1);
});

test("unconfirmed dispatch stop holds capacity through unknown status and restart", async () => {
  f.comment();
  await dispatcher().tick();
  const original = f.latest();
  const token = f.store.issueToken({
    project_id: f.project,
    assignment_id: original.assignment_id,
    role: { role_version: 1, allowed_tools: ["whoami"] },
  });
  const other = f.create();
  f.session(other.assignment);
  const waiting = f.apply((s, a, p) =>
    queueRun(
      s,
      a,
      {
        assignment_id: other.assignment.id,
        model: "fixture",
        agent_cli_version: "fixture",
      },
      p,
    ),
  );
  f.store.uow.run((tx) =>
    tx.runs.put(f.project, { ...waiting, queue_reason: "concurrency_limit" }),
  );
  f.skipEvents();
  const release = vi.mocked(f.runtime.release).getMockImplementation();
  if (!release) throw new Error("Missing release fixture");
  vi.mocked(f.runtime.release).mockImplementation(async () => {
    f.store.uow.run((tx) => {
      const run = tx.runs.get(f.project, original.id);
      if (run) tx.runs.put(f.project, { ...run, status: "unknown" });
    });
    return {
      ok: false,
      error: { code: "runtime_timeout", message: "unconfirmed" },
    };
  });
  const options = {
    runLimit: () => 1,
    dispatchTimeoutMs: 100,
    inactiveCancelAfterMs: null,
  };
  f.advance(100);
  await dispatcher(options).tick();
  expect(f.latest()).toMatchObject({
    id: original.id,
    status: "unknown",
    dispatch_stop: { stopping: true },
  });
  expect(occupied()).toBe(1);
  expect(f.store.verifyToken(token.token)).toBeDefined();
  expect(f.state().runs.find((r) => r.id === waiting.id)?.status).toBe(
    "queued",
  );
  vi.mocked(f.runtime.release).mockImplementation(release);
  f.advance(60001);
  const reopened = Store.open({ dataDir: f.dataDir });
  try {
    await dispatcher({ ...options, store: reopened }).tick();
  } finally {
    reopened.close();
  }
  expect(f.store.verifyToken(token.token)).toBeUndefined();
  expect(
    f.state().runs.find((r) => r.id === original.id)?.dispatch_stop,
  ).toBeUndefined();
  expect(f.state().runs.find((r) => r.id === waiting.id)?.status).toBe(
    "dispatched",
  );
  expect(f.latest()).toMatchObject({
    status: "queued",
    queue_reason: "concurrency_limit",
  });
  expect(occupied()).toBe(1);
  expect(count("run_dispatch_recovered")).toBe(1);
});

test("failed attempts persist through backoff and one recovery, then escalate after retry exhaustion", async () => {
  fail();
  const provision = vi.mocked(f.options.startRun).getMockImplementation();
  if (!provision) throw new Error("Missing startup fixture");
  vi.mocked(f.options.startRun).mockImplementation(async (input) => {
    await provision(input);
    throw new Error("uncertain startup delivery");
  });
  f.comment();
  await dispatcher().tick();
  const original = f.latest();
  const history = (id: typeof original.id) =>
    listBellAttempts(f.store.database, f.project).filter(
      (a) => a.run_id === id,
    );
  expect(history(original.id)).toMatchObject([
    { outcome: "failed", finished_at: f.clock.now() },
  ]);
  for (const [i, delay] of [30000, 60000, 120000, 240000].entries()) {
    f.advance(delay - 1);
    await dispatcher().tick();
    expect(f.runtime.wake).toHaveBeenCalledTimes(i + 1);
    f.advance(1);
    const reopened = Store.open({ dataDir: f.dataDir });
    try {
      await dispatcher({ store: reopened }).tick();
    } finally {
      reopened.close();
    }
    expect(f.runtime.wake).toHaveBeenCalledTimes(i + 2);
    expect(f.latest().id).toBe(original.id);
    // Each fresh dispatcher (a restart) also asks once in its C-247 startup
    // check; the live terminal is left to the retry path below.
    expect(f.runtime.status).toHaveBeenCalledTimes(1 + 3 * (i + 1));
    expect(f.state().human_actions).toEqual([]);
    const attempts = history(original.id);
    expect(attempts).toHaveLength(i + 2);
    expect(new Set(attempts.map((a) => a.id)).size).toBe(i + 2);
    expect(
      attempts.every((a) => a.outcome === "failed" && a.finished_at !== null),
    ).toBe(true);
    expect(f.notes()[0]).toMatchObject({
      status: "delivery_failed",
      attempts: i + 2,
    });
  }
  await dispatcher().tick();
  expect(f.latest().id).not.toBe(original.id);
  expect(f.latest()).toMatchObject({
    status: "dispatched",
    kind: original.kind,
    model: original.model,
  });
  expect(f.state().runs.find((r) => r.id === original.id)?.status).toBe(
    "cancelled",
  );
  expect(count("run_dispatch_recovered")).toBe(1);
  expect(f.notes()[0]?.status).toBe("resolved");
  const originalHistory = history(original.id);
  const replacement = f.latest();
  expect(history(replacement.id)).toMatchObject([{ outcome: "failed" }]);
  for (const delay of [30000, 60000, 120000, 240000]) {
    const before = history(replacement.id).length;
    f.advance(delay - 1);
    await dispatcher().tick();
    expect(history(replacement.id)).toHaveLength(before);
    f.advance(1);
    await dispatcher().tick();
    expect(history(replacement.id)).toHaveLength(before + 1);
    expect(f.state().human_actions).toHaveLength(0);
  }
  await dispatcher().tick();
  await dispatcher().tick();
  expect(history(original.id)).toEqual(originalHistory);
  expect(history(replacement.id)).toHaveLength(5);
  expect(
    history(replacement.id).every(
      (a) => a.outcome === "failed" && a.finished_at !== null,
    ),
  ).toBe(true);
  expect(count("run_dispatch_recovered")).toBe(1);
  expect(count("run_dispatch_stalled")).toBe(1);
  expect(f.state().human_actions).toMatchObject([{ status: "open" }]);
});

test("successful send without run_started times out once; second timeout creates a visible Needs You action", async () => {
  f.comment();
  const d = dispatcher({ dispatchTimeoutMs: 100 });
  await d.tick();
  const original = f.latest();
  f.advance(99);
  await d.tick();
  expect(f.latest().id).toBe(original.id);
  f.advance(1);
  await d.tick();
  expect(f.latest().id).not.toBe(original.id);
  expect(f.latest().status).toBe("dispatched");
  f.advance(100);
  await d.tick();
  await dispatcher({ dispatchTimeoutMs: 100 }).tick();
  expect(count("run_dispatch_recovered")).toBe(1);
  expect(count("run_dispatch_stalled")).toBe(1);
  expect(f.runtime.wake).toHaveBeenCalledTimes(1);
  expect(f.options.startRun).toHaveBeenCalledOnce();
  const result = listNeedsYou(f.state(), {
    kind: "human",
    project_id: f.project,
  });
  expect(result.ok && result.value.data.human_actions).toHaveLength(1);
  expect(f.state().human_actions[0]?.instructions).toContain(f.target.card.id);
  expect(f.state().human_actions[0]?.instructions).toContain(
    `cardigan assignment start ${f.target.assignment.id}`,
  );
  expect(
    f.state().timeline.some((e) => e.body.includes("已自动恢复过一次")),
  ).toBe(true);
  start();
  await d.tick();
  expect(f.state().human_actions[0]?.status).toBe("cancelled");
  expect(f.notes().some((n) => n.status === "needs_attention")).toBe(false);
});

test.each(["exited", "unknown"] as const)(
  "retry checks the terminal and skips wake when process is %s",
  async (process) => {
    fail();
    f.comment();
    // One process: a restart would run the C-247 startup check instead.
    const d = dispatcher();
    await d.tick();
    vi.mocked(f.runtime.status).mockResolvedValue({
      ok: true,
      value: { process, agent: "unknown", observed_seq: 2 },
    });
    f.advance(30000);
    await d.tick();
    expect(f.runtime.wake).toHaveBeenCalledOnce();
    expect(f.runtime.status).toHaveBeenCalledTimes(2);
    expect(f.state().runs).toHaveLength(2);
  },
);

test("MCP start during terminal inspection wins over a retry claim", async () => {
  fail();
  f.comment();
  await dispatcher().tick();
  vi.mocked(f.runtime.status).mockImplementation(async () => {
    start();
    return {
      ok: true,
      value: { process: "alive", agent: "working", observed_seq: 2 },
    };
  });
  f.advance(30000);
  await dispatcher().tick();
  expect(f.runtime.wake).toHaveBeenCalledOnce();
  f.advance(600000);
  await dispatcher().tick();
  expect(count("run_dispatch_recovered")).toBe(0);
});

test("two dispatchers share a retry lease and a late ACK wins over failure", async () => {
  fail();
  f.comment();
  await dispatcher().tick();
  let release!: () => void;
  vi.mocked(f.runtime.wake).mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    start();
    const note = f.notes()[0];
    if (!note?.card_id) throw new Error("Missing notice");
    f.store.ackEvents({
      project_id: f.project,
      assignment_id: f.target.assignment.id,
      card_id: note.card_id,
      up_to_seq: note.seq,
    });
    return { ok: false, error: { code: "runtime_timeout", message: "late" } };
  });
  f.advance(30000);
  const sending = dispatcher().tick();
  try {
    await expect
      .poll(() => unfinishedBellAttempts(f.store.database, f.project).length)
      .toBe(1);
    await dispatcher().tick();
    expect(f.runtime.wake).toHaveBeenCalledTimes(2);
  } finally {
    release();
    await sending;
  }
  expect(f.notes()[0]?.status).toBe("acked");
  expect(f.latest().status).toBe("running");
});

test("explicit CLI launch with no notifications also retries and recovers from its durable intent", async () => {
  const run = f.apply((s, a, p) =>
    queueRun(
      s,
      a,
      {
        assignment_id: f.target.assignment.id,
        model: "fixture",
        agent_cli_version: "fixture",
      },
      p,
    ),
  );
  f.store.uow.run(() =>
    beginLaunchAttempt(f.store.database, {
      id: "cli-launch",
      project_id: f.project,
      assignment_id: run.assignment_id,
      run_id: run.id,
      started_at: f.clock.now(),
      lease_until: new Date(Date.parse(f.clock.now()) + 1000).toISOString(),
    }),
  );
  f.apply((s, a, p) => dispatchRun(s, a, { run_id: run.id }, p));
  f.store.uow.run(() =>
    finishBellAttempt(
      f.store.database,
      f.project,
      "cli-launch",
      "failed",
      f.clock.now(),
    ),
  );
  f.skipEvents();
  expect(f.notes()).toEqual([]);
  f.advance(30000);
  await dispatcher().tick();
  expect(f.runtime.wake).toHaveBeenCalledOnce();
  expect(vi.mocked(f.runtime.wake).mock.calls[0]?.[1]).toContain(
    `run=${run.id}`,
  );
  f.advance(600000);
  await dispatcher().tick();
  expect(count("run_dispatch_recovered")).toBe(1);
});

test("active PM Ops receives plain language escalation in its inbox", async () => {
  const ops = f.pm();
  f.store.uow.run((tx) =>
    tx.assignments.put(f.project, { ...ops, standing_mode: "ops" }),
  );
  f.session(ops, false); // A busy Ops keeps the alert visible in its inbox.
  f.skipEvents();
  f.comment();
  const d = dispatcher({ dispatchTimeoutMs: 100 });
  await d.tick();
  f.advance(100);
  await d.tick();
  f.advance(100);
  await d.tick();
  expect(f.state().human_actions).toEqual([]);
  const event = f.state().events.find((e) => e.type === "run_dispatch_stalled");
  expect(event?.payload).toMatchObject({ audience: "pm_ops" });
  expect(
    f.store
      .listNotifications({ project_id: f.project })
      .find((n) => n.event_id === event?.id && n.recipient.kind === "pm_ops")
      ?.status,
  ).toBe("pending");
});

test("500-minute-old watchdog attention resolves after the Run finishes or the Assignment releases", async () => {
  f.session(f.target.assignment, false);
  f.skipEvents();
  // Preserve the legacy alert scenario independently of C-54's optional reaper.
  const d = dispatcher({ inactivityGraceMs: 1, inactiveCancelAfterMs: null });
  f.advance(500 * 60000);
  await d.tick();
  expect(f.notes()[0]?.status).toBe("needs_attention");
  f.complete();
  f.skipEvents();
  await d.tick();
  expect(f.notes()[0]?.status).toBe("resolved");
  const another = f.create();
  f.session(another.assignment, false);
  f.skipEvents();
  f.advance(500 * 60000);
  await d.tick();
  f.store.uow.run((tx) =>
    tx.assignments.put(f.project, {
      ...another.assignment,
      status: "released",
    }),
  );
  await d.tick();
  expect(
    f.store.listNotifications({
      project_id: f.project,
      assignment_id: another.assignment.id,
    })[0]?.status,
  ).toBe("resolved");
});

test("dispatch timeout is configurable and rejects invalid values", () => {
  expect(resolveServerConfig({}).dispatchTimeoutMs).toBe(600000);
  expect(
    resolveServerConfig({ CARDIGAN_DISPATCH_TIMEOUT_MS: "1234" })
      .dispatchTimeoutMs,
  ).toBe(1234);
  expect(() =>
    resolveServerConfig({ CARDIGAN_DISPATCH_TIMEOUT_MS: "0" }),
  ).toThrow();
  expect(() => dispatcher({ dispatchTimeoutMs: 0 })).toThrow(
    "Invalid dispatcher",
  );
});

test("an in-flight delivery lease prevents timeout recovery until settlement", async () => {
  f.comment();
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  vi.mocked(f.runtime.wake).mockImplementationOnce(async () => {
    entered.resolve();
    await released.promise;
    return { ok: true, value: { sent: true } };
  });
  const sending = dispatcher({ dispatchTimeoutMs: 100 }).tick();
  try {
    // The lease is written before asynchronous lock acquisition and wake.
    // Advancing time at that earlier point can race activation/settlement.
    await Promise.race([
      entered.promise,
      sending.then(() => {
        throw new Error("Delivery settled without entering wake");
      }),
    ]);
    expect(unfinishedBellAttempts(f.store.database, f.project)).toHaveLength(1);
    f.advance(101);
    await dispatcher({ dispatchTimeoutMs: 100 }).tick();
    expect(count("run_dispatch_recovered")).toBe(0);
  } finally {
    released.resolve();
    await sending;
  }
  await dispatcher({ dispatchTimeoutMs: 100 }).tick();
  expect(count("run_dispatch_recovered")).toBe(1);
});

test("unconfirmed terminal stop escalates without cancelling or requeuing", async () => {
  f.comment();
  const d = dispatcher({ dispatchTimeoutMs: 100 });
  await d.tick();
  const original = f.latest();
  f.store.issueToken({
    project_id: f.project,
    assignment_id: original.assignment_id,
    role: { role_version: 1, allowed_tools: ["whoami"] },
  });
  vi.mocked(f.runtime.status).mockResolvedValue({
    ok: true,
    value: { process: "unknown", agent: "unknown", observed_seq: 2 },
  });
  f.advance(100);
  await d.tick();
  expect(f.latest()).toMatchObject({
    ...original,
    dispatch_stop: { stopping: true },
  });
  expect(count("run_dispatch_recovered")).toBe(0);
  expect(count("run_dispatch_stalled")).toBe(1);
  expect(
    tokensForAssignment(
      f.store.database,
      f.project,
      original.assignment_id,
    ).every((t) => t.revoked_at === null),
  ).toBe(true);
  expect(f.state().human_actions[0]?.instructions).toContain(
    "无法确认旧终端已停止",
  );
});

test("confirmed stop precedes atomic cancellation, token revocation and queueing", async () => {
  f.comment();
  const d = dispatcher({ dispatchTimeoutMs: 100 });
  await d.tick();
  const original = f.latest();
  f.store.issueToken({
    project_id: f.project,
    assignment_id: original.assignment_id,
    role: { role_version: 1, allowed_tools: ["whoami"] },
  });
  const release = f.runtime.release;
  f.runtime.release = vi.fn(async (...args) => {
    expect(f.latest().status).toBe("dispatched");
    expect(
      tokensForAssignment(
        f.store.database,
        f.project,
        original.assignment_id,
      ).every((t) => t.revoked_at === null),
    ).toBe(true);
    // The live monitor observes exit concurrently with the stop operation.
    f.store.uow.run((tx) => {
      const current = tx.runs.get(f.project, original.id);
      const owner = tx.assignments.get(f.project, original.assignment_id);
      if (!current || !owner) throw new Error("Missing run");
      tx.runs.put(f.project, { ...current, status: "unknown" });
      tx.assignments.put(f.project, { ...owner, runtime_state: "unknown" });
    });
    return release(...args);
  });
  f.advance(100);
  await d.tick();
  expect(f.runtime.release).toHaveBeenCalledOnce();
  expect(
    tokensForAssignment(
      f.store.database,
      f.project,
      original.assignment_id,
    ).every((t) => t.revoked_at !== null),
  ).toBe(true);
  expect(count("run_dispatch_aborted")).toBe(1);
  expect(count("run_dispatch_recovered")).toBe(1);
  expect(f.options.startRun).toHaveBeenCalledOnce();
});

test("fresh MCP activity during the stop preflight prevents release and cancellation", async () => {
  f.comment();
  const d = dispatcher({ dispatchTimeoutMs: 100 });
  await d.tick();
  vi.mocked(f.runtime.status).mockImplementationOnce(async () => {
    start();
    return {
      ok: true,
      value: { process: "alive", agent: "working", observed_seq: 2 },
    };
  });
  f.advance(100);
  await d.tick();
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(f.latest().status).toBe("running");
  expect(count("run_dispatch_recovered")).toBe(0);
});

test("PM Ops delivery failure escalates to Needs You without notifying itself repeatedly", async () => {
  const ops = f.pm();
  f.store.uow.run((tx) =>
    tx.assignments.put(f.project, { ...ops, standing_mode: "ops" }),
  );
  f.session(ops);
  f.skipEvents();
  const run = f.apply((s, a, p) =>
    queueRun(
      s,
      a,
      { assignment_id: ops.id, model: "fixture", agent_cli_version: "fixture" },
      p,
    ),
  );
  f.apply((s, a, p) => dispatchRun(s, a, { run_id: run.id }, p));
  const d = dispatcher({ dispatchTimeoutMs: 100 });
  f.advance(100);
  await d.tick();
  f.advance(100);
  await d.tick();
  await d.tick();
  expect(count("run_dispatch_recovered")).toBe(1);
  expect(count("run_dispatch_stalled")).toBe(1);
  expect(f.state().human_actions).toHaveLength(1);
  expect(f.options.startRun).toHaveBeenCalledOnce();
});

test("release in flight rejects late MCP start and finish before atomic recovery and revocation", async () => {
  f.comment();
  const d = dispatcher({ dispatchTimeoutMs: 100 });
  await d.tick();
  const run = f.latest();
  f.store.issueToken({
    project_id: f.project,
    assignment_id: run.assignment_id,
    role: { role_version: 1, allowed_tools: ["whoami"] },
  });
  const release = f.runtime.release;
  f.runtime.release = vi.fn(async (...args) => {
    const state = f.state(),
      actor = f.actorFor(f.target.assignment);
    f.store.uow.run((tx) => {
      const ports = { clock: f.clock, ids: tx.ids };
      expect(acknowledgeRun(state, actor, { run_id: run.id }, ports).ok).toBe(
        false,
      );
      expect(
        finishRun(
          state,
          actor,
          { run_id: run.id, outcome: "completed", summary: "late" },
          ports,
        ).ok,
      ).toBe(false);
    });
    return release(...args);
  });
  f.advance(100);
  await d.tick();
  expect(f.state().runs.find((r) => r.id === run.id)?.status).toBe("cancelled");
  expect(
    tokensForAssignment(f.store.database, f.project, run.assignment_id).every(
      (t) => t.revoked_at !== null,
    ),
  ).toBe(true);
  expect(count("run_dispatch_stop_finished")).toBe(1);
  expect(count("run_dispatch_recovered")).toBe(1);
});

test("restart takes over an expired stop after monitor records unknown and ignores the original late result", async () => {
  f.comment();
  const options = { dispatchTimeoutMs: 100 };
  await dispatcher(options).tick();
  const run = f.latest();
  f.store.issueToken({
    project_id: f.project,
    assignment_id: run.assignment_id,
    role: { role_version: 1, allowed_tools: ["whoami"] },
  });
  let complete!: () => void;
  const release = f.runtime.release;
  f.runtime.release = vi.fn(async (...args) => {
    await release(...args); // Terminal really exited before the response arrived.
    f.store.uow.run((tx) => {
      const current = tx.runs.get(f.project, run.id),
        a = tx.assignments.get(f.project, run.assignment_id);
      if (!current || !a) throw new Error("Missing stop target");
      tx.runs.put(f.project, { ...current, status: "unknown" });
      tx.assignments.put(f.project, { ...a, runtime_state: "unknown" });
    });
    await new Promise<void>((resolve) => {
      complete = resolve;
    });
    return { ok: true, value: undefined };
  });
  f.advance(100);
  const stopping = dispatcher(options).tick();
  try {
    await expect.poll(() => f.latest().status).toBe("unknown");
    expect(unfinishedBellAttempts(f.store.database, f.project)).toEqual([]);
    const reopened = Store.open({ dataDir: f.dataDir });
    try {
      await dispatcher({ ...options, store: reopened }).tick();
      expect(count("run_dispatch_recovered")).toBe(0);
      f.advance(60001);
      await dispatcher({ ...options, store: reopened }).tick();
    } finally {
      reopened.close();
    }
    expect(count("run_dispatch_recovered")).toBe(1);
    expect(f.state().runs.find((r) => r.id === run.id)?.status).toBe(
      "cancelled",
    );
    expect(
      tokensForAssignment(f.store.database, f.project, run.assignment_id).every(
        (t) => t.revoked_at !== null,
      ),
    ).toBe(true);
  } finally {
    complete();
    await stopping;
  }
  await dispatcher(options).tick();
  expect(count("run_dispatch_recovered")).toBe(1);
  expect(count("run_dispatch_stop_finished")).toBe(1);
  expect(f.runtime.release).toHaveBeenCalledOnce();
});

test("persisted stop survives process loss with no live original call", async () => {
  f.comment();
  await dispatcher().tick();
  const run = f.latest();
  const claimed = f.apply(
    (s, a, p) =>
      claimDispatchStop(
        s,
        a,
        {
          run_id: run.id,
          lease_ms: 100,
          reason: "dispatch_timeout",
        },
        p,
      ),
    { kind: "system", project_id: f.project },
  );
  if (!claimed?.dispatch_stop) throw new Error("Missing stop");
  f.apply(
    (s, a, p) =>
      startDispatchStop(
        s,
        a,
        { run_id: run.id, attempt_id: claimed.dispatch_stop?.attempt_id ?? "" },
        p,
      ),
    { kind: "system", project_id: f.project },
  );
  vi.mocked(f.runtime.status).mockResolvedValue({
    ok: true,
    value: { process: "exited", agent: "unknown", observed_seq: 3 },
  });
  f.advance(101);
  const reopened = Store.open({ dataDir: f.dataDir });
  try {
    await dispatcher({ store: reopened }).tick();
  } finally {
    reopened.close();
  }
  expect(count("run_dispatch_recovered")).toBe(1);
  expect(f.runtime.release).not.toHaveBeenCalled();
});

test("failed token revocation rolls back cancellation and requeue; persisted stop retries settlement", async () => {
  f.comment();
  const d = dispatcher({ dispatchTimeoutMs: 100 });
  await d.tick();
  const run = f.latest();
  f.store.issueToken({
    project_id: f.project,
    assignment_id: run.assignment_id,
    role: { role_version: 1, allowed_tools: ["whoami"] },
  });
  f.store.database.exec(
    "CREATE TRIGGER fail_revoke BEFORE UPDATE OF revoked_at ON tokens BEGIN SELECT RAISE(ABORT, 'test revoke failure'); END",
  );
  f.advance(100);
  try {
    await expect(d.tick()).rejects.toThrow("test revoke failure");
  } finally {
    f.store.database.exec("DROP TRIGGER fail_revoke");
  }
  expect(f.latest()).toMatchObject({
    id: run.id,
    status: "dispatched",
    dispatch_stop: { stopping: true },
  });
  expect(count("run_dispatch_recovered")).toBe(0);
  expect(
    tokensForAssignment(f.store.database, f.project, run.assignment_id).every(
      (t) => t.revoked_at === null,
    ),
  ).toBe(true);
  f.advance(60001);
  await dispatcher({ dispatchTimeoutMs: 100 }).tick();
  expect(count("run_dispatch_stop_finished")).toBe(1);
  expect(count("run_dispatch_recovered")).toBe(1);
  expect(f.runtime.release).toHaveBeenCalledOnce();
});

test("unconfirmed stop stays fenced and a later confirmed exit completes the same recovery", async () => {
  f.comment();
  const d = dispatcher({ dispatchTimeoutMs: 100 });
  await d.tick();
  vi.mocked(f.runtime.status).mockResolvedValue({
    ok: true,
    value: { process: "unknown", agent: "unknown", observed_seq: 2 },
  });
  f.advance(100);
  await d.tick();
  expect(f.state().human_actions[0]?.status).toBe("open");
  expect(f.latest().dispatch_stop?.stopping).toBe(true);
  vi.mocked(f.runtime.status).mockResolvedValue({
    ok: true,
    value: { process: "exited", agent: "unknown", observed_seq: 3 },
  });
  f.advance(60001);
  await d.tick();
  expect(count("run_dispatch_recovered")).toBe(1);
  expect(count("run_dispatch_stop_finished")).toBe(1);
  expect(f.state().human_actions[0]?.status).toBe("cancelled");
  expect(f.latest().dispatch_stop).toBeUndefined();
});

test.each([false, true])(
  "recovery startup compensation escalates once and remains actionable (Ops=%s)",
  async (withOps) => {
    if (withOps) {
      const ops = f.pm();
      f.store.uow.run((tx) =>
        tx.assignments.put(f.project, { ...ops, standing_mode: "ops" }),
      );
      f.session(ops, false);
      f.skipEvents();
    }
    f.comment();
    const d = dispatcher({ dispatchTimeoutMs: 600000 });
    await d.tick();
    vi.mocked(f.options.startRun).mockImplementationOnce(async ({ run }) => {
      f.advance(65000);
      f.apply((s, a, p) =>
        abortDispatch(s, a, { run_id: run.id, reason: "startup_failed" }, p),
      );
      throw new Error("host compensation");
    });
    f.advance(600000);
    await d.tick();
    expect(f.latest().status).toBe("cancelled");
    const reopened = Store.open({ dataDir: f.dataDir });
    try {
      await dispatcher({ store: reopened, dispatchTimeoutMs: 600000 }).tick();
    } finally {
      reopened.close();
    }
    f.advance(600000);
    await d.tick();
    expect(count("run_dispatch_stalled")).toBe(1);
    const incident = f
      .state()
      .events.find((e) => e.type === "run_dispatch_stalled");
    expect(incident?.payload).toMatchObject({
      reason: "recovery_startup_failed",
      waited_ms: 665000,
      body: expect.stringContaining(
        "派发后已等待 11 分钟，自动恢复后的启动失败",
      ),
      audience: withOps ? "pm_ops" : "needs_you",
    });
    if (withOps) {
      expect(f.state().human_actions).toHaveLength(0);
      expect(
        f.store
          .listNotifications({ project_id: f.project })
          .some(
            (n) =>
              n.event_id === incident?.id &&
              n.recipient.kind === "pm_ops" &&
              n.status === "pending",
          ),
      ).toBe(true);
    } else {
      const needs = listNeedsYou(f.state(), {
        kind: "human",
        project_id: f.project,
      });
      expect(needs.ok && needs.value.data.human_actions).toHaveLength(1);
      expect(f.state().human_actions[0]).toMatchObject({ status: "open" });
      expect(f.state().human_actions[0]?.instructions).toContain(
        "cardigan assignment start",
      );
      expect(f.state().human_actions[0]?.instructions).toContain(
        "派发后已等待 11 分钟，自动恢复后的启动失败",
      );
      f.session(f.target.assignment);
      f.skipEvents();
      await d.tick();
      expect(f.state().human_actions[0]?.status).toBe("cancelled");
    }
  },
);

test.each([
  "retry",
  "timeout",
  "stopping",
  "recovery_failed",
  "running",
  "expired_lease",
] as const)(
  "external Office ignores stale %s records across dispatcher restarts",
  async (scenario) => {
    const pm = f.pm();
    const previousRun = f.latest();
    // Seed legacy host records directly: normal queue/launch already rejects external identities.
    const external = f.store.uow.run((tx) => {
      const base: Assignment = {
        ...pm,
        id: tx.ids.next(f.project, "assignment"),
        standing_mode: "office",
        external: true,
        runtime_state: "running",
      };
      const a = {
        ...base,
        runtime_ref: f.refFor(base),
        session_ref: "external-session",
      };
      tx.assignments.put(f.project, a);
      const runId = tx.ids.next(f.project, "run");
      const emit = (type: string, payload: Record<string, string>) => {
        const event = {
          id: tx.ids.nextEventId(),
          seq: tx.ids.nextEventSequence(f.project),
          type,
          actor: { kind: "system" as const, project_id: f.project },
          payload,
          created_at: f.clock.now(),
        };
        tx.events.append(f.project, event);
        return event;
      };
      const event = emit("run_dispatched", {
        run_id: runId,
        assignment_id: a.id,
      });
      const {
        started_at: _started,
        finished_at: _finished,
        ...snapshot
      } = previousRun;
      const run: Run = {
        ...snapshot,
        id: runId,
        assignment_id: a.id,
        trigger_event_id: event.id,
        status:
          scenario === "recovery_failed"
            ? "cancelled"
            : scenario === "running"
              ? "running"
              : scenario === "expired_lease"
                ? "queued"
                : "dispatched",
        outcome: null,
        ...(scenario === "running" ? { started_at: f.clock.now() } : {}),
        ...(scenario === "stopping"
          ? {
              dispatch_stop: {
                attempt_id: event.id,
                runtime_ref: a.runtime_ref,
                lease_until: f.clock.now(),
                stopping: true,
                reason: "dispatch_timeout" as const,
              },
            }
          : {}),
      };
      tx.runs.put(f.project, run);
      if (scenario === "recovery_failed") {
        emit("run_dispatch_recovered", {
          replacement_run_id: runId,
          assignment_id: a.id,
        });
        emit("run_dispatch_aborted", { run_id: runId });
      }
      if (["retry", "timeout", "expired_lease"].includes(scenario)) {
        const intent = {
          id: "external-intent",
          project_id: f.project,
          assignment_id: a.id,
          run_id: run.id,
          started_at: f.clock.now(),
          lease_until: new Date(Date.parse(f.clock.now()) + 1).toISOString(),
        };
        if (scenario === "expired_lease")
          beginLaunchAttempt(f.store.database, intent);
        else {
          beginDispatchRetry(f.store.database, {
            ...intent,
            notification_ids: [],
          });
          finishBellAttempt(
            f.store.database,
            f.project,
            intent.id,
            scenario === "retry" ? "failed" : "sent",
            f.clock.now(),
          );
        }
      }
      return a;
    });
    const issued = f.store.issueToken({
      project_id: f.project,
      assignment_id: external.id,
      role: { role_version: 1, allowed_tools: ["whoami"] },
    });
    f.skipEvents();
    const snapshot = () => ({
      state: f.state(),
      tokens: tokensForAssignment(f.store.database, f.project, external.id),
      attempts: listBellAttempts(f.store.database, f.project),
      notes: f.store.listNotifications({ project_id: f.project }),
    });
    const before = snapshot();
    const beforeWake = vi.fn(async () => "prepared");
    for (const elapsed of [scenario === "retry" ? 20 : 3_600_001, 3_600_001]) {
      f.advance(elapsed);
      await dispatcher({
        dispatchTimeoutMs: 100,
        deliveryRetryBaseMs: 10,
        beforeWake,
      }).tick();
      expect(snapshot()).toEqual(before);
      expect(f.store.verifyToken(issued.token)).toBeDefined();
    }
    for (const method of [
      f.runtime.status,
      f.runtime.wake,
      f.runtime.release,
      f.runtime.provision,
      f.runtime.resume_or_replace,
      f.options.startRun,
      beforeWake,
    ])
      expect(method).not.toHaveBeenCalled();
  },
);
