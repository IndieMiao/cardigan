import type { Assignment, HarnessActivity, Runtime } from "@cardigan/domain";
import type { HarnessActivityInspection } from "@cardigan/host";
import { afterEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { startControlPlane } from "./assembly.js";
import { Dispatcher } from "./dispatch.js";

const fixtures: ReturnType<typeof dispatchFixture>[] = [];
const dispatchers: Dispatcher[] = [];
afterEach(() => {
  for (const d of dispatchers.splice(0)) d.close();
  for (const f of fixtures.splice(0)) f.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function fixture(inspect = true, timeout = 10_000) {
  const f = dispatchFixture();
  fixtures.push(f);
  const target = f.create();
  const run = f.session(target.assignment, false);
  f.advance(61 * 60_000);
  const a = f.state().assignments.find((a) => a.id === target.assignment.id);
  if (!a) throw new Error("Missing fixture assignment");
  const activity: HarnessActivity = {
    assignment_id: a.id,
    run_id: run.id,
    runtime_key: JSON.stringify(a.runtime_ref),
    session_id: "fixture-session",
    updated_at: f.clock.now(),
    source: "codex:session_metadata",
    stale_after_ms: 600_000,
  };
  const read =
    Promise.withResolvers<
      ReadonlyMap<Assignment["id"], HarnessActivityInspection>
    >();
  let cached: HarnessActivity | undefined;
  const inspection = vi.fn(() =>
    read.promise.then((samples) => {
      cached = samples.get(a.id)?.activity;
      return samples;
    }),
  );
  const runtime = {
    status: vi.fn(async () => ({
      ok: true,
      value: { process: "alive", agent: "idle", observed_seq: 1 },
    })),
    wake: vi.fn(),
    release: vi.fn(),
  } as unknown as Runtime;
  const options = {
    store: f.store,
    runtime,
    clock: f.clock,
    snapshot: async () => ({ model: "fixture", agent_cli_version: "fixture" }),
    inactiveCancelAfterMs: inspect ? 60 * 60_000 : null,
    harnessActivity: () => cached,
    ...(inspect ? { inspectHarnessActivity: inspection } : {}),
    inactivityInspectionTimeoutMs: timeout,
  };
  const d = new Dispatcher(options);
  dispatchers.push(d);
  return {
    f,
    a,
    run,
    activity,
    d,
    options,
    runtime,
    inspection,
    resolve: (sample: HarnessActivityInspection) =>
      read.resolve(new Map([[a.id, sample]])),
    reject: read.reject,
    alerts: () => f.state().events.filter((e) => e.type === "run_inactive"),
  };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("C-417: without the pre-alert inspection an empty cache reproduces the early alert", async () => {
  const t = fixture(false);
  await t.d.tick();
  expect(t.alerts()).toHaveLength(1);
});

test("C-417: pending inspection does not block ticks or stop a busy Run; fresh activity prevents PM alerts", async () => {
  const t = fixture();
  await t.d.tick();
  await t.d.tick();
  expect(t.inspection).toHaveBeenCalledOnce();
  expect(t.alerts()).toEqual([]);
  expect(t.runtime.release).not.toHaveBeenCalled();
  t.resolve({ status: "fresh", activity: t.activity });
  await flush();
  for (let i = 0; i < 3; i++) await t.d.tick();
  expect(t.inspection).toHaveBeenCalledOnce();
  expect(t.alerts()).toEqual([]);
  expect(t.runtime.release).not.toHaveBeenCalled();
  expect(
    t.f.store
      .listNotifications({ project_id: t.f.project })
      .filter((n) => n.kind === "run_attention"),
  ).toEqual([]);
});

test.each([
  "missing",
  "stale",
  "cross_assignment",
  "old_run",
  "old_runtime",
  "old_session",
  "future",
  "read_failed",
  "rate_limit",
  "stream_disconnected",
])(
  "C-417: %s cannot hide real inactivity and only one durable PM alert is emitted",
  async (mode) => {
    const t = fixture();
    await t.d.tick();
    const sample = { ...t.activity };
    if (mode === "stale") sample.updated_at = "2030-01-01T00:00:00.000Z";
    if (mode === "cross_assignment") sample.assignment_id = "A-999";
    if (mode === "old_run") sample.run_id = "R-999";
    if (mode === "old_runtime") sample.runtime_key = "old";
    if (mode === "old_session")
      t.f.store.uow.run((tx) =>
        tx.assignments.put(t.f.project, {
          ...t.a,
          session_ref: "current-session",
        }),
      );
    if (mode === "future") sample.updated_at = "2030-01-01T02:00:00.000Z";
    if (mode === "rate_limit" || mode === "stream_disconnected")
      sample.error = mode;
    if (mode === "read_failed") t.reject(new Error("SECRET-READ-ERROR"));
    else
      t.resolve({
        status: mode === "missing" ? "missing" : "fresh",
        ...(mode === "missing" ? {} : { activity: sample }),
      });
    await flush();
    if (mode === "old_session") {
      // The entire pending result is discarded after generation changes.
      expect(t.alerts()).toEqual([]);
      await t.d.tick();
      await flush();
    }
    expect(t.alerts()).toHaveLength(1);
    const again = new Dispatcher({ ...t.options, inactiveCancelAfterMs: null });
    dispatchers.push(again);
    await again.tick();
    await again.tick();
    expect(t.alerts()).toHaveLength(1);
    expect(JSON.stringify(t.alerts())).not.toContain("SECRET-READ-ERROR");
    const event = t.alerts()[0];
    if (!event) throw new Error("Missing inactivity event");
    expect(
      t.f.store
        .listNotifications({ project_id: t.f.project })
        .filter(
          (n) => n.event_id === event.id && n.recipient.kind === "pm_ops",
        ),
    ).toHaveLength(1);
  },
);

test("C-417: heartbeat during inspection is rechecked before alerting", async () => {
  const t = fixture();
  await t.d.tick();
  const run = t.f.state().runs.find((r) => r.id === t.run.id);
  if (!run) throw new Error("Missing fixture Run");
  t.f.store.uow.run((tx) =>
    tx.runs.put(t.f.project, {
      ...run,
      heartbeat_at: t.f.clock.now(),
    }),
  );
  t.resolve({ status: "missing" });
  await flush();
  expect(t.alerts()).toEqual([]);
});

test("C-417: timeout reports unknown once; a late result cannot retract or duplicate it", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const t = fixture(true, 100);
  await t.d.tick();
  await vi.advanceTimersByTimeAsync(99);
  expect(t.alerts()).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(t.alerts()).toHaveLength(1);
  expect(t.alerts()[0]?.payload).toMatchObject({
    activity_check: "timeout",
    activity_status: "missing",
    activity_source: "活动来源缺失",
  });
  t.resolve({ status: "fresh", activity: t.activity });
  await flush();
  await t.d.tick();
  expect(t.alerts()).toHaveLength(1);
});

test("C-417: closing prevents late diagnostic publication", async () => {
  const t = fixture();
  await t.d.tick();
  t.d.close();
  t.resolve({ status: "missing" });
  await flush();
  expect(t.alerts()).toEqual([]);
});

test.each(["cache", "inspection"])(
  "C-417: control-plane assembly forwards %s activity to the real Dispatcher",
  async (mode) => {
    const t = fixture();
    const ticks = vi.spyOn(Dispatcher.prototype, "tick");
    const errors: unknown[] = [];
    const runtime = {
      ...t.runtime,
      async *events() {
        yield* [] as never[];
      },
    };
    const plane = startControlPlane({
      ...t.options,
      inactiveCancelAfterMs: null,
      runtime,
      harnessActivity:
        mode === "cache" ? () => t.activity : t.options.harnessActivity,
      startRun: async () => {},
      intervalMs: 10_000,
      onError: (error) => errors.push(error),
    });
    try {
      await vi.waitFor(() =>
        expect(
          ticks.mock.settledResults.some((r) => r.type === "fulfilled"),
        ).toBe(true),
      );
      expect(t.alerts()).toEqual([]);
      if (mode === "inspection") {
        expect(t.inspection).toHaveBeenCalledOnce();
        t.resolve({ status: "fresh", activity: t.activity });
        await flush();
        expect(t.alerts()).toEqual([]);
      }
      expect(t.runtime.release).not.toHaveBeenCalled();
      expect(errors).toEqual([]);
    } finally {
      await plane.stop();
    }
  },
);
