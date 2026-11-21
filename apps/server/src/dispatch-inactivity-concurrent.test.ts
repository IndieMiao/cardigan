import type { Assignment, HarnessActivity, Runtime } from "@cardigan/domain";
import type { HarnessActivityInspection } from "@cardigan/host";
import { afterEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher } from "./dispatch.js";

const fixtures: ReturnType<typeof dispatchFixture>[] = [];
const dispatchers: Dispatcher[] = [];
afterEach(() => {
  for (const d of dispatchers.splice(0)) d.close();
  for (const f of fixtures.splice(0)) f.close();
  vi.useRealTimers();
});

function fixture() {
  const f = dispatchFixture();
  fixtures.push(f);
  const runs = [f.create(), f.create()].map((t) =>
    f.session(t.assignment, false),
  );
  f.advance(61 * 60_000);
  const targets = runs.map((run) => {
    const assignment = f
      .state()
      .assignments.find((a) => a.id === run.assignment_id);
    if (!assignment) throw new Error("Missing fixture assignment");
    const activity: HarnessActivity = {
      assignment_id: assignment.id,
      run_id: run.id,
      runtime_key: JSON.stringify(assignment.runtime_ref),
      session_id: "fixture-session",
      updated_at: f.clock.now(),
      source: "codex:session_metadata",
      stale_after_ms: 600_000,
    };
    return { assignment, run, activity };
  });
  const [first, second] = targets;
  if (!first || !second) throw new Error("Missing fixture targets");
  const cached = new Map<Assignment["id"], HarnessActivity>([
    [
      second.assignment.id,
      {
        ...second.activity,
        updated_at: new Date(Date.parse(f.clock.now()) - 599_500).toISOString(),
      },
    ],
  ]);
  const read =
    Promise.withResolvers<
      ReadonlyMap<Assignment["id"], HarnessActivityInspection>
    >();
  const inspection = vi.fn(() =>
    read.promise.then((samples) => {
      cached.clear();
      for (const [id, sample] of samples)
        if (sample.activity) cached.set(id, sample.activity);
      return samples;
    }),
  );
  const runtime = {
    status: vi.fn(async () => ({
      ok: true,
      value: { process: "alive", agent: "idle", observed_seq: 1 },
    })),
    release: vi.fn(async () => ({ ok: true, value: undefined })),
    wake: vi.fn(),
  } as unknown as Runtime;
  const d = new Dispatcher({
    store: f.store,
    clock: f.clock,
    runtime,
    snapshot: async () => ({ model: "fixture", agent_cli_version: "fixture" }),
    harnessActivity: (_project, id) => cached.get(id),
    inspectHarnessActivity: inspection,
  });
  dispatchers.push(d);
  return {
    f,
    d,
    first,
    second,
    runtime,
    inspection,
    read,
    fresh: new Map(
      targets.map((t) => [
        t.assignment.id,
        { status: "fresh" as const, activity: t.activity },
      ]),
    ),
    notices: () =>
      f.state().events.filter((e) => e.type === "run_local_activity_missing"),
    alerts: () => f.state().events.filter((e) => e.type === "run_inactive"),
  };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("C-417: a later due Run joins the active inspection before it can be stopped", async () => {
  const t = fixture();
  await t.d.tick();
  expect(t.inspection).toHaveBeenCalledOnce();
  expect(t.runtime.release).not.toHaveBeenCalled();
  t.f.advance(1_000);
  await t.d.tick();
  expect(t.runtime.release).not.toHaveBeenCalled();
  expect(t.f.state().runs.every((r) => !r.inactivity_stop)).toBe(true);
  t.read.resolve(t.fresh);
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

test("C-417: later due Runs share the original deadline without extending it", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const t = fixture();
  await t.d.tick();
  t.f.advance(9_000);
  await vi.advanceTimersByTimeAsync(9_000);
  await t.d.tick();
  t.f.advance(999);
  await vi.advanceTimersByTimeAsync(999);
  await t.d.tick();
  expect(t.alerts()).toEqual([]);
  expect(t.runtime.release).not.toHaveBeenCalled();
  t.f.advance(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(t.notices()).toHaveLength(2);
  for (const alert of t.notices())
    expect(alert.payload).toMatchObject({ activity_check: "timeout" });
  await t.d.tick();
  expect(t.runtime.release).toHaveBeenCalledTimes(2);
  expect(t.inspection).toHaveBeenCalledOnce();
  t.read.resolve(t.fresh);
  await flush();
  expect(t.notices()).toHaveLength(2);
});

test.each(["runtime", "session"])(
  "C-417: repeated ticks retain the joined Run's original %s generation",
  async (mode) => {
    const t = fixture();
    await t.d.tick();
    t.f.advance(1_000);
    await t.d.tick();
    t.f.store.uow.run((tx) =>
      tx.assignments.put(t.f.project, {
        ...t.second.assignment,
        ...(mode === "runtime"
          ? {
              runtime_ref: {
                ...t.f.refFor(t.second.assignment),
                terminal_ref: "replacement",
              },
            }
          : { session_ref: "replacement" }),
      }),
    );
    await t.d.tick();
    t.read.resolve(
      new Map([
        [
          t.first.assignment.id,
          { status: "fresh", activity: t.first.activity },
        ],
      ]),
    );
    await flush();
    expect(t.alerts()).toEqual([]);
    expect(t.runtime.release).not.toHaveBeenCalled();
    await t.d.tick();
    await flush();
    expect(t.inspection).toHaveBeenCalledTimes(2);
    expect(t.notices()).toHaveLength(1);
    expect(t.notices()[0]?.payload).toMatchObject({
      run_id: t.second.run.id,
      activity_check: "completed",
    });
  },
);

test("C-417: a heartbeat on a joined Run is rechecked before publishing", async () => {
  const t = fixture();
  await t.d.tick();
  t.f.advance(1_000);
  await t.d.tick();
  t.f.store.uow.run((tx) => {
    const run = tx.runs.get(t.f.project, t.second.run.id);
    if (!run) throw new Error("Missing fixture Run");
    tx.runs.put(t.f.project, { ...run, heartbeat_at: t.f.clock.now() });
  });
  t.read.resolve(
    new Map([
      [t.first.assignment.id, { status: "fresh", activity: t.first.activity }],
    ]),
  );
  await flush();
  await t.d.tick();
  expect(t.alerts()).toEqual([]);
  expect(t.runtime.release).not.toHaveBeenCalled();
});

test.each(["missing", "read_failed"])(
  "C-417: %s also settles later due Runs without another grace period",
  async (mode) => {
    const t = fixture();
    await t.d.tick();
    t.f.advance(1_000);
    await t.d.tick();
    if (mode === "missing") t.read.resolve(new Map());
    else t.read.reject(new Error("fixture read failure"));
    await flush();
    expect(t.notices()).toHaveLength(2);
    await t.d.tick();
    expect(t.inspection).toHaveBeenCalledOnce();
    expect(t.runtime.release).toHaveBeenCalledTimes(2);
  },
);
