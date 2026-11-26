import type { HarnessActivity } from "@cardigan/domain";
import { type HarnessActivityInspection, tryHostOpsLock } from "@cardigan/host";
import { afterEach, beforeEach, expect, test } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { InactiveRunReaper, inactiveGraceFor } from "./dispatch-inactive.js";

// C-752: replay of sensen C-155 A-399 / R-3420 on a remote worker. The
// session's transcript is readable (write time) but yields no session
// metadata; before the fix the 60-minute stop never became due.
let f: ReturnType<typeof recoveryFixture>;
beforeEach(() => {
  f = recoveryFixture("worker");
});
afterEach(() => f.close());

function remoteClaude(resource_keys?: readonly string[]) {
  const a = f.target.assignment;
  f.session(a, false);
  const run = f.latest();
  f.store.uow.run((tx) =>
    tx.runs.put(f.project, {
      ...run,
      harness: "claude-code",
      ...(resource_keys ? { resource_keys } : {}),
    }),
  );
  f.advance(60_000);
  const file: HarnessActivity = {
    assignment_id: a.id,
    run_id: run.id,
    runtime_key: JSON.stringify(f.refFor(a)),
    session_id: "session-399",
    updated_at: f.clock.now(),
    written_at: f.clock.now(),
    stale_after_ms: 600_000,
    source: "claude-code:transcript_mtime",
  };
  return { a, run, file };
}

function reaper(
  t: ReturnType<typeof remoteClaude>,
  extra: Partial<ConstructorParameters<typeof InactiveRunReaper>[0]> = {},
) {
  // The stop-time read finds the transcript but no session metadata.
  const row: HarnessActivityInspection = {
    status: "unassociated",
    fileActivity: t.file,
  };
  return new InactiveRunReaper({
    store: f.store,
    runtime: f.runtime,
    clock: f.clock,
    afterMs: 60 * 60_000,
    harnessFileActivity: () => t.file,
    inspectHarnessActivity: async () => new Map([[t.a.id, row]]),
    alert: () => {},
    ...extra,
  });
}
// Remote stops run beside the tick; wait for them without closing the reaper.
const tick = async (r: InactiveRunReaper) => {
  await r.tick([f.project]);
  const { remoteStops } = r as unknown as {
    remoteStops: Map<string, Promise<void>>;
  };
  await Promise.all(remoteStops.values());
};

test("A-399: a remote Claude session silent for 60 minutes after its last transcript write is stopped and noted", async () => {
  const t = remoteClaude();
  f.advance(60 * 60_000 - 1000);
  await tick(reaper(t));
  expect(f.runtime.release).not.toHaveBeenCalled();
  f.advance(1000);
  await tick(reaper(t));
  expect(f.runtime.release).toHaveBeenCalledTimes(1);
  expect(f.latest()).toMatchObject({ id: t.run.id, status: "cancelled" });
  expect(
    f.state().events.find((e) => e.type === "run_inactivity_stop_requested")
      ?.payload,
  ).toMatchObject({ evidence: "transcript_write" });
  expect(
    f
      .state()
      .timeline.filter((e) => e.body.startsWith("失活回收"))
      .map((e) => e.run_id),
  ).toEqual([t.run.id]);
});

test("without any transcript evidence the remote session is still never stopped on MCP silence", async () => {
  const t = remoteClaude();
  f.advance(3 * 60 * 60_000);
  await tick(
    reaper(t, {
      harnessFileActivity: () => undefined,
      inspectHarnessActivity: async () =>
        new Map([[t.a.id, { status: "missing" as const }]]),
    }),
  );
  expect(f.runtime.release).not.toHaveBeenCalled();
});

test("a human attached to the terminal holds the stop until they leave", async () => {
  const t = remoteClaude();
  f.advance(61 * 60_000);
  const unlock = await tryHostOpsLock(f.store, f.project, t.a.id, "host-ops", {
    kind: "attach",
    mode: "interactive",
    started_at: f.clock.now(),
  });
  if (!unlock) throw new Error("expected the attach lock");
  try {
    await tick(reaper(t));
    expect(f.runtime.release).not.toHaveBeenCalled();
    expect(f.latest().status).toBe("running");
  } finally {
    await unlock();
  }
  await tick(reaper(t));
  expect(f.runtime.release).toHaveBeenCalledTimes(1);
});

test("a shorter grace for scarce resources is off unless configured, and only for Runs holding one", async () => {
  const scarce = { afterMs: 30 * 60_000, resources: ["ios.simulator"] };
  expect(inactiveGraceFor(f.latest(), 60 * 60_000, scarce)).toBe(60 * 60_000);
  const t = remoteClaude(["ios.simulator"]);
  expect(inactiveGraceFor(f.latest(), 60 * 60_000, undefined)).toBe(
    60 * 60_000,
  );
  expect(
    inactiveGraceFor(f.latest(), 60 * 60_000, {
      ...scarce,
      resources: ["android.emulator"],
    }),
  ).toBe(60 * 60_000);
  f.advance(30 * 60_000);
  await tick(reaper(t));
  expect(f.runtime.release).not.toHaveBeenCalled();
  await tick(reaper(t, { scarce }));
  expect(f.runtime.release).toHaveBeenCalledTimes(1);
  expect(
    f.state().events.find((e) => e.type === "run_inactivity_stop_requested")
      ?.payload,
  ).toMatchObject({ after_ms: 30 * 60_000 });
});
