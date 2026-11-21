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
    notices: () =>
      f.state().events.filter((e) => e.type === "run_local_activity_missing"),
    alerts: () => f.state().events.filter((e) => e.type === "run_inactive"),
  };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("C-417: without the pre-alert inspection an empty cache is unknown", async () => {
  const t = fixture(false);
  await t.d.tick();
  expect(t.alerts()).toHaveLength(0);
  expect(t.notices()).toHaveLength(1);
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
])("C-417: %s is routed once according to its evidence", async (mode) => {
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
  const confirmed = ["stale", "rate_limit", "stream_disconnected"].includes(
    mode,
  );
  const again = new Dispatcher({ ...t.options, inactiveCancelAfterMs: null });
  dispatchers.push(again);
  await again.tick();
  await flush();
  expect(t.alerts()).toHaveLength(confirmed ? 1 : 0);
  expect(t.notices()).toHaveLength(confirmed ? 0 : 1);
  const event = [...t.alerts(), ...t.notices()][0];
  expect(JSON.stringify(event)).not.toContain("SECRET-READ-ERROR");
  expect(
    t.f.store
      .listNotifications({ project_id: t.f.project })
      .filter((n) => n.event_id === event?.id && n.recipient.kind === "pm_ops"),
  ).toHaveLength(confirmed ? 1 : 0);
});

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
  expect(t.notices()).toHaveLength(1);
  expect(t.notices()[0]?.payload).toMatchObject({
    activity_check: "timeout",
    activity_status: "missing",
    activity_source: "本机活动来源缺失",
  });
  t.resolve({ status: "fresh", activity: t.activity });
  await flush();
  await t.d.tick();
  expect(t.notices()).toHaveLength(1);
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

test("C-541: absent transcript falls back to output; only sustained silence issues the foreground handoff", async () => {
  const t = fixture();
  const terminal = vi.fn(async () => ({
    ok: true as const,
    value: { digest: "first", foreground: { key: "pid-one", command: "node" } },
  }));
  const runtime = { ...t.runtime, terminalActivity: terminal };
  const inspect = vi.fn(
    async () => new Map([[t.a.id, { status: "missing" as const }]]),
  );
  const d = new Dispatcher({
    ...t.options,
    runtime,
    inspectHarnessActivity: inspect,
    inactiveCancelAfterMs: null,
  });
  dispatchers.push(d);
  const tick = async () => {
    await d.tick();
    await flush();
  };
  await tick();
  expect(inspect).toHaveBeenCalledWith(t.f.project, t.a.id, false);
  expect(terminal).toHaveBeenCalledWith(t.a.runtime_ref, t.f.project, t.a.id);
  expect(t.alerts()).toHaveLength(0); // No fabricated last-write time from the first screen.
  t.f.advance(16 * 60_000);
  terminal.mockResolvedValue({
    ok: true,
    value: {
      digest: "new-output",
      foreground: { key: "pid-one", command: "node" },
    },
  });
  await tick();
  expect(t.alerts()).toHaveLength(0);
  t.f.advance(15 * 60_000);
  await tick();
  expect(t.alerts().map((e) => e.payload)).toMatchObject([
    {
      activity_status: "stale",
      activity_source: "terminal_output",
      reason: "前台命令 node 已运行至少 31 分钟，无近期输出",
    },
  ]);
  expect(JSON.stringify(t.alerts())).not.toContain("pid-one");
  expect(JSON.stringify(t.alerts())).not.toContain("new-output");
  await tick();
  expect(t.alerts()).toHaveLength(1);
});

test("C-541: a missing-source notice does not consume a later confirmed stall; current file writes win over stale protocol records", async () => {
  const t = fixture();
  const transcript = { ...t.activity, source: "codex:transcript_mtime" };
  const command = { command: "node web.mjs", since: t.f.clock.now() };
  let row: HarnessActivityInspection = { status: "missing" };
  const d = new Dispatcher({
    ...t.options,
    inactiveCancelAfterMs: null,
    inspectHarnessActivity: async () => new Map([[t.a.id, row]]),
  });
  dispatchers.push(d);
  const tick = async () => {
    await d.tick();
    await flush();
  };
  await tick();
  expect(t.notices()).toHaveLength(1);
  for (let i = 0; i < 2; i++) {
    t.f.advance(16 * 60_000);
    row = {
      status: "stale",
      activity: t.activity,
      fileActivity: { ...transcript, updated_at: t.f.clock.now() },
      foreground: command,
    };
    await tick();
    expect(t.alerts()).toHaveLength(0);
  }
  t.f.advance(15 * 60_000);
  await tick();
  expect(t.alerts().map((e) => e.payload)).toMatchObject([
    {
      activity_source: "codex:transcript_mtime",
      reason: "前台命令 node web.mjs 已运行至少 47 分钟，无近期输出",
    },
  ]);
  expect(t.notices()).toHaveLength(1);
});
