import { acknowledgeRun, postComment } from "@cardigan/domain";
import { listBellAttempts, unfinishedBellAttempts } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { standingResolver } from "./assembly.js";
import { Dispatcher } from "./dispatch.js";
import { startDispatchLoop } from "./dispatch-loop.js";
import { RuntimeMonitor } from "./dispatch-monitor.js";

// C-247: shutdown stops new dispatch; startup checks Runs a previous process
// left dispatched without run_started instead of waiting for the timeout.
let f: ReturnType<typeof recoveryFixture>;
beforeEach(() => {
  f = recoveryFixture();
});
afterEach(() => f.close());
const count = (type: string) =>
  f.state().events.filter((e) => e.type === type).length;
const dispatcher = (extra: Partial<typeof f.options> = {}) =>
  new Dispatcher({
    ...f.options,
    standing: standingResolver(f.store),
    ...extra,
  });
const gone = () =>
  vi.mocked(f.runtime.status).mockResolvedValue({
    ok: false,
    error: { code: "runtime_not_found", message: "gone" },
  });
const runOf = (id: string) => f.state().runs.find((r) => r.id === id);

test("dispatched just before shutdown: the next process recovers it in its first tick without spending the recovery", async () => {
  f.comment();
  await dispatcher().tick();
  const original = f.latest();
  expect(original.status).toBe("dispatched");
  // The server stops and the terminal does not survive the restart.
  gone();
  f.advance(1000);
  await dispatcher().tick();
  expect(runOf(original.id)).toMatchObject({
    status: "cancelled",
    outcome: "failed",
  });
  expect(runOf(original.id)?.dispatch_stop).toBeUndefined();
  const recovered = f
    .state()
    .events.find((e) => e.type === "run_dispatch_recovered");
  expect(recovered?.payload).toMatchObject({
    run_id: original.id,
    reason: "server_restart",
  });
  expect(count("run_dispatch_stop_requested")).toBe(1);
  expect(count("run_dispatch_aborted")).toBe(1);
  // The same tick launches the replacement; no 10-minute wait.
  const replacement = f.latest();
  expect(replacement.id).not.toBe(original.id);
  expect(replacement.status).toBe("dispatched");
  expect(f.options.startRun).toHaveBeenCalledOnce();
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(
    f.state().timeline.some((e) => e.body.includes("不占用此 Assignment")),
  ).toBe(true);
  // The Assignment's single timeout recovery is still available.
  // Back to the fixture runtime: launched terminals are alive until released.
  vi.mocked(f.runtime.status).mockRestore();
  const d = dispatcher({ dispatchTimeoutMs: 100 });
  await d.tick();
  f.advance(100);
  await d.tick();
  expect(count("run_dispatch_recovered")).toBe(2);
  expect(count("run_dispatch_stalled")).toBe(0);
  expect(
    f
      .state()
      .events.filter((e) => e.type === "run_dispatch_recovered")
      .map((e) => (e.payload as { reason: string }).reason),
  ).toEqual(["server_restart", "dispatch_timeout"]);
});

test("startup leaves a live terminal to the timeout and asks again while status is unknown", async () => {
  f.comment();
  await dispatcher().tick();
  const original = f.latest();
  vi.mocked(f.runtime.status).mockResolvedValue({
    ok: true,
    value: { process: "unknown", agent: "unknown", observed_seq: 1 },
  });
  const d = dispatcher();
  await d.tick();
  expect(runOf(original.id)?.status).toBe("dispatched");
  expect(count("run_dispatch_stop_requested")).toBe(0);
  // Still unknown: asked again, still untouched.
  const asked = vi.mocked(f.runtime.status).mock.calls.length;
  await d.tick();
  expect(vi.mocked(f.runtime.status).mock.calls.length).toBeGreaterThan(asked);
  expect(runOf(original.id)?.status).toBe("dispatched");
  // Alive: the terminal may still be starting, so the startup check lets go.
  vi.mocked(f.runtime.status).mockResolvedValue({
    ok: true,
    value: { process: "alive", agent: "idle", observed_seq: 2 },
  });
  await d.tick();
  gone();
  await d.tick();
  expect(runOf(original.id)?.status).toBe("dispatched");
  expect(count("run_dispatch_stop_requested")).toBe(0);
  expect(count("run_dispatch_recovered")).toBe(0);
});

test("startup never recovers a Run whose Agent started meanwhile", async () => {
  f.comment();
  await dispatcher().tick();
  const original = f.latest();
  gone();
  // An Agent that started meanwhile is never recovered.
  f.apply(
    (s, a, p) => acknowledgeRun(s, a, { run_id: original.id }, p),
    f.actorFor(f.target.assignment),
  );
  await dispatcher().tick();
  expect(runOf(original.id)?.status).not.toBe("cancelled");
  expect(count("run_dispatch_stop_requested")).toBe(0);
});

test("startup waits for an in-flight delivery lease before deciding", async () => {
  f.comment();
  await dispatcher().tick();
  const original = f.latest();
  gone();
  // A previous process is still mid-delivery for this Assignment.
  f.store.uow.run(() =>
    f.store.database
      .prepare(
        `INSERT INTO bell_attempts (project_id, id, assignment_id, run_id, notification_ids, started_at, lease_until)
         VALUES (?, ?, ?, ?, '[]', ?, ?)`,
      )
      .run(
        f.project,
        "inflight",
        original.assignment_id,
        original.id,
        f.clock.now(),
        new Date(Date.parse(f.clock.now()) + 60000).toISOString(),
      ),
  );
  const d = dispatcher();
  await d.tick();
  expect(runOf(original.id)?.status).toBe("dispatched");
  expect(count("run_dispatch_stop_requested")).toBe(0);
  // The lease expires and routing settles it; the same process then recovers.
  f.advance(60000);
  await d.tick();
  expect(
    unfinishedBellAttempts(f.store.database, f.project).map((a) => a.id),
  ).not.toContain("inflight");
  await d.tick();
  expect(runOf(original.id)?.status).toBe("cancelled");
  expect(count("run_dispatch_recovered")).toBe(1);
});

test("two processes racing the startup check recover the Run exactly once", async () => {
  f.comment();
  await dispatcher().tick();
  const original = f.latest();
  gone();
  await Promise.all([dispatcher().tick(), dispatcher().tick()]);
  expect(runOf(original.id)?.status).toBe("cancelled");
  expect(count("run_dispatch_recovered")).toBe(1);
  expect(count("run_dispatch_stop_finished")).toBe(1);
  expect(
    f
      .state()
      .runs.filter(
        (r) =>
          r.assignment_id === original.assignment_id &&
          !["cancelled", "completed", "failed"].includes(r.status),
      ),
  ).toHaveLength(1);
});

test("shutdown during runtime inspection claims nothing; the next process delivers once", async () => {
  f.comment();
  const d = dispatcher();
  vi.mocked(f.runtime.status).mockImplementationOnce(async () => {
    d.close();
    return {
      ok: true,
      value: { process: "alive", agent: "idle", observed_seq: 1 },
    };
  });
  const before = f.state().runs.length;
  await d.tick();
  expect(f.state().runs).toHaveLength(before);
  expect(f.runtime.wake).not.toHaveBeenCalled();
  expect(f.options.startRun).not.toHaveBeenCalled();
  expect(listBellAttempts(f.store.database, f.project)).toEqual([]);
  expect(f.notes()[0]?.status).toBe("pending");
  // A closed dispatcher does not start another tick's work either.
  await d.tick();
  expect(f.runtime.wake).not.toHaveBeenCalled();
  await dispatcher().tick();
  expect(f.runtime.wake).toHaveBeenCalledOnce();
  expect(f.latest().status).toBe("dispatched");
});

test("shutdown after a claim either completes the dispatch or leaves the Run queued, and skips later candidates", async () => {
  const other = f.create();
  f.session(other.assignment);
  f.skipEvents();
  f.comment();
  f.apply((s, a, p) =>
    postComment(
      s,
      a,
      {
        card_id: other.card.id,
        work_item_id: other.item.id,
        body: "Read updates",
      },
      p,
    ),
  );
  let d: Dispatcher | undefined;
  const beforeWake = vi.fn(async () => {
    d?.close();
    return undefined;
  });
  d = dispatcher({ beforeWake });
  await d.tick();
  // The first claimed delivery had already dispatched its Run: it lands.
  expect(beforeWake).toHaveBeenCalledOnce();
  expect(f.runtime.wake).toHaveBeenCalledOnce();
  const runs = f
    .state()
    .runs.filter((r) => ["dispatched", "queued"].includes(r.status));
  expect(runs.map((r) => r.status)).toEqual(["dispatched"]);
  expect(
    listBellAttempts(f.store.database, f.project).every(
      (a) => a.outcome === "sent",
    ),
  ).toBe(true);
  expect(unfinishedBellAttempts(f.store.database, f.project)).toEqual([]);
  // The other Assignment was never claimed; the next process delivers it.
  await dispatcher().tick();
  expect(f.runtime.wake).toHaveBeenCalledTimes(2);
});

test("stopping the dispatch loop closes the dispatcher before draining", async () => {
  const close = vi.fn();
  let release = () => {};
  const tick = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const loop = startDispatchLoop({
    dispatcher: { tick, close },
    onError: () => {},
  });
  await vi.waitFor(() => expect(tick).toHaveBeenCalledOnce());
  const stopped = loop.stop();
  expect(close).toHaveBeenCalledOnce();
  release();
  await stopped;
  expect(tick).toHaveBeenCalledOnce();
});

test("shutdown while preparing a queued verification wake withdraws the claim and keeps the Run queued", async () => {
  // Reused verification sessions stay queued until the wake (C-88), so this
  // is the window where a claimed delivery has not crossed dispatch yet.
  const previous = f.latest().id;
  f.store.uow.run((tx) => {
    const produce = tx.work_items.get(f.project, f.target.item.id);
    if (!produce) throw new Error("Missing item");
    const verify = { ...produce, id: "W-900", kind: "verify" as const };
    tx.work_items.put(f.project, {
      ...verify,
      target_work_item_id: produce.id,
    });
    tx.deliveries.put(f.project, {
      id: "D-900",
      work_item_id: produce.id,
      run_id: previous,
      kind: "code",
      summary: "fixture",
      subject: { kind: "git_head", value: "abc" },
      evidence: [],
      attachments: [],
      known_gaps: [],
      requested_verifiers: [],
      status: "submitted",
      created_at: f.clock.now(),
    } as never);
    const a = tx.assignments.get(f.project, f.target.assignment.id);
    if (!a) throw new Error("Missing assignment");
    tx.assignments.put(f.project, { ...a, work_item_id: "W-900" as never });
  });
  f.skipEvents();
  f.comment();
  let d: Dispatcher | undefined;
  d = dispatcher({
    beforeWake: async () => {
      d?.close();
      return undefined;
    },
  });
  const before = f.state().runs.length;
  await d.tick();
  expect(f.runtime.wake).not.toHaveBeenCalled();
  const queued = f.state().runs.filter((r) => r.status === "queued");
  expect(f.state().runs).toHaveLength(before + 1);
  expect(queued).toHaveLength(1);
  expect(listBellAttempts(f.store.database, f.project)).toEqual([]);
  expect(f.notes().every((n) => n.status === "pending")).toBe(true);
  // The next process dispatches the same queued Run once.
  await dispatcher().tick();
  expect(f.runtime.wake).toHaveBeenCalledOnce();
  expect(f.state().runs.find((r) => r.id === queued[0]?.id)?.status).toBe(
    "dispatched",
  );
  expect(f.state().runs).toHaveLength(before + 1);
});

test("real loop: a leftover Run the monitor already marked unknown is still recovered in the first tick", async () => {
  f.comment();
  await dispatcher().tick();
  const original = f.latest();
  expect(original.status).toBe("dispatched");
  gone();
  // The new process's monitor subscribes first and sees the terminal missing.
  const runtime = {
    ...f.runtime,
    events: async function* () {
      yield {
        ok: false as const,
        error: { code: "runtime_not_found" as const, message: "gone" },
      };
    },
  };
  const monitor = new RuntimeMonitor({
    store: f.store,
    clock: f.clock,
    runtime: runtime as never,
  });
  monitor.reconcile();
  await vi.waitFor(() => expect(runOf(original.id)?.status).toBe("unknown"));
  const controller = new AbortController();
  const loop = startDispatchLoop({
    dispatcher: dispatcher(),
    monitor,
    signal: controller.signal,
    onError: (error) => {
      throw error;
    },
  });
  try {
    await vi.waitFor(() => expect(count("run_dispatch_recovered")).toBe(1));
  } finally {
    controller.abort();
    await loop.stop();
  }
  expect(runOf(original.id)).toMatchObject({ status: "cancelled" });
  expect(runOf(original.id)?.dispatch_stop).toBeUndefined();
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(f.options.startRun).toHaveBeenCalledOnce();
  const replacement = f
    .state()
    .runs.filter((r) => r.assignment_id === original.assignment_id)
    .at(-1);
  expect(replacement?.id).not.toBe(original.id);
  expect(replacement?.status).not.toBe("cancelled");
  expect(
    f.state().events.find((e) => e.type === "run_dispatch_recovered")?.payload,
  ).toMatchObject({ run_id: original.id, reason: "server_restart" });
});

test("startup never force-closes a terminal seen alive again between its two observations", async () => {
  f.comment();
  await dispatcher().tick();
  const original = f.latest();
  // First check: missing; the stop's own re-check: alive (still starting).
  vi.mocked(f.runtime.status)
    .mockResolvedValueOnce({
      ok: false,
      error: { code: "runtime_not_found", message: "gone" },
    })
    .mockResolvedValue({
      ok: true,
      value: { process: "alive", agent: "idle", observed_seq: 1 },
    });
  const d = dispatcher();
  await d.tick();
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(runOf(original.id)?.status).toBe("dispatched");
  expect(runOf(original.id)?.dispatch_stop).toBeUndefined();
  expect(count("run_dispatch_stop_started")).toBe(0);
  expect(count("run_dispatch_recovered")).toBe(0);
  expect(
    f
      .state()
      .events.filter((e) => e.type === "run_dispatch_stop_withdrawn")
      .map((e) => (e.payload as { reason: string }).reason),
  ).toEqual(["runtime_not_exited"]);
  expect(f.options.startRun).not.toHaveBeenCalled();
  // Next tick observes alive again and leaves it to the dispatch timeout.
  await d.tick();
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(runOf(original.id)?.status).toBe("dispatched");
  expect(count("run_dispatch_stop_requested")).toBe(1);
});
