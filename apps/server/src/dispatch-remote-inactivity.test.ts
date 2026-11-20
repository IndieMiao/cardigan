import {
  createHostOpsAssignment,
  type HarnessActivity,
  HOST_OPS_ROLE_TOOLS,
} from "@cardigan/domain";
import type { HarnessActivityInspection } from "@cardigan/host";
import { afterEach, beforeEach, expect, test } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { runtimeEvents } from "../test-support/runtime-events.js";
import { Dispatcher } from "./dispatch.js";
import { RuntimeMonitor } from "./dispatch-monitor.js";
import { needsYou } from "./web/read.js";

let f: ReturnType<typeof recoveryFixture>;
beforeEach(() => {
  f = recoveryFixture("worker");
});
afterEach(() => f.close());
function session(harness: "claude-code" | "codex" | "pi") {
  const a = f.target.assignment;
  f.session(a, false);
  const run = f.latest();
  f.store.uow.run((tx) => tx.runs.put(f.project, { ...run, harness }));
  return { a, ref: f.refFor(a), run };
}
test.each(["claude-code", "codex", "pi"] as const)(
  "remote %s missing evidence is a notice, not a stall or host handoff",
  async (harness) => {
    f.store.uow.run((tx) =>
      tx.roles.put(f.project, {
        role_id: "host_ops",
        role_version: 1,
        allowed_tools: HOST_OPS_ROLE_TOOLS,
        capabilities: [],
      }),
    );
    f.apply((s, a, p) => createHostOpsAssignment(s, a, {}, p));
    const { a, ref, run } = session(harness);
    f.skipEvents();
    f.advance(61 * 60_000);
    let sample: HarnessActivity | undefined;
    const config = {
      ...f.options,
      inactivityGraceMs: 15 * 60_000,
      inactiveCancelAfterMs: 60 * 60_000,
      harnessActivity: () => sample,
      inspectHarnessActivity: async () =>
        new Map([
          [
            a.id,
            sample
              ? { status: "fresh" as const, activity: sample }
              : { status: "read_failed" as const },
          ],
        ]),
    };
    let d = new Dispatcher(config);
    const tick = async () => {
      await d.tick();
      await new Promise<void>((r) => setImmediate(r));
    };
    const facts = (type: string) =>
      f
        .state()
        .events.filter(
          (e) =>
            e.type === type &&
            (e.payload as { run_id?: string }).run_id === run.id,
        );
    try {
      await tick();
      d.close();
      d = new Dispatcher(config);
      await tick();
      const notices = facts("run_remote_activity_missing");
      expect(notices.map((e) => e.payload)).toMatchObject([
        { reason: "远程活动来源缺失" },
      ]);
      expect(
        f.store
          .listNotifications({ project_id: f.project })
          .filter((n) => n.event_id === notices[0]?.id),
      ).toEqual([]);
      expect(facts("run_inactive")).toEqual([]);
      expect(f.runtime.release).not.toHaveBeenCalled();
      expect(f.state().human_actions).toEqual([]);
      sample = {
        assignment_id: a.id,
        run_id: run.id,
        runtime_key: JSON.stringify(ref),
        session_id: "fixture",
        source: `${harness}:session_metadata`,
        updated_at: f.clock.now(),
        stale_after_ms: 600_000,
      };
      await tick();
      expect(facts("run_inactive")).toEqual([]);
      f.advance(15 * 60_000);
      await tick();
      expect(facts("run_inactive").map((e) => e.payload)).toMatchObject([
        { activity_status: "stale", activity_source: sample.source },
      ]);
    } finally {
      d.close();
    }
  },
);

test("an explicit remote Claude exit is actionable even without transcript activity", async () => {
  const { a, ref } = session("claude-code");
  const events = runtimeEvents();
  const monitor = new RuntimeMonitor({
    store: f.store,
    runtime: events.source,
    clock: f.clock,
  });
  try {
    monitor.reconcile();
    events.send({
      seq: 1,
      type: "terminal.finished",
      terminal_ref: ref.terminal_ref,
    });
    await expect.poll(() => f.latest().status).toBe("unknown");
    expect(
      f.state().events.findLast((e) => e.type === "runtime_disconnected")
        ?.payload,
    ).toMatchObject({ assignment_id: a.id, cause: "exit" });
    expect(
      needsYou(f.state(), f.clock.now()).incidents.map((i) => i.id),
    ).toContain(a.id);
  } finally {
    await monitor.stop();
  }
});

test("a pending worker inspection does not delay the local inactivity alert", async () => {
  const remote = session("claude-code");
  const local = f.create("local");
  const run = f.session(local.assignment, false);
  f.skipEvents();
  f.advance(15 * 60_000);
  const pending =
    Promise.withResolvers<Map<typeof remote.a.id, HarnessActivityInspection>>();
  const d = new Dispatcher({
    ...f.options,
    inactiveCancelAfterMs: null,
    inspectHarnessActivity: async (_project, target, localOnly) => {
      if (target === remote.a.id) return pending.promise;
      expect(localOnly).toBe(true);
      return new Map();
    },
  });
  try {
    await d.tick();
    await new Promise<void>((r) => setImmediate(r));
    const inactive = f.state().events.filter((e) => e.type === "run_inactive");
    expect(inactive.map((e) => e.payload)).toMatchObject([{ run_id: run.id }]);
    pending.resolve(
      new Map([
        [
          remote.a.id,
          {
            status: "fresh",
            activity: {
              assignment_id: remote.a.id,
              run_id: remote.run.id,
              runtime_key: JSON.stringify(remote.ref),
              session_id: "fixture",
              source: "claude-code:session_metadata",
              updated_at: f.clock.now(),
              stale_after_ms: 600_000,
            },
          },
        ],
      ]),
    );
    await new Promise<void>((r) => setImmediate(r));
    expect(
      f.state().events.filter((e) => e.type === "run_inactive"),
    ).toHaveLength(1);
    expect(
      f.state().events.some((e) => e.type === "run_remote_activity_missing"),
    ).toBe(false);
  } finally {
    d.close();
    pending.resolve(new Map());
  }
});
