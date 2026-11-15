import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Runtime, recordUpstreamHealth } from "@cardigan/domain";
import { parseLaunchConfig } from "@cardigan/roles";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import {
  assignment,
  fixture,
  ports,
  run,
  value,
} from "../../domain/src/commands/test-fixtures.js";
import {
  type ConnectionProbe,
  UpstreamHealthMonitor,
} from "./upstream-health.js";

function configuration(origin = "https://fixture.invalid") {
  return parseLaunchConfig({
    providers: {
      relay: {
        harness: "codex",
        upstream: { group: "relay", probe_url: origin },
      },
    },
    profiles: { agent: { harness: "codex", provider: "relay" } },
    upstream_health: {
      probe: { interval_ms: 100, timeout_ms: 20, stale_after_ms: 200 },
    },
  });
}

test("a failed sample publication cannot end single-flight while another probe is still pending", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cg-upstream-publication-"));
  const store = Store.open({ dataDir });
  let now = Date.parse("2026-01-01T00:00:00Z");
  const config = parseLaunchConfig({
    providers: {
      fast: {
        harness: "codex",
        upstream: { group: "fast", probe_url: "https://fast.invalid" },
      },
      slow: {
        harness: "codex",
        upstream: { group: "slow", probe_url: "https://slow.invalid" },
      },
    },
    profiles: {},
    upstream_health: {
      probe: { interval_ms: 100, timeout_ms: 20, stale_after_ms: 200 },
    },
  });
  const held = Promise.withResolvers<Awaited<ReturnType<ConnectionProbe>>>();
  const probe = vi.fn<ConnectionProbe>((origin) =>
    origin.includes("slow")
      ? held.promise
      : Promise.resolve({ status: "unreachable", failure: "connection_error" }),
  );
  const prepare = store.database.prepare.bind(store.database);
  let failed = 0;
  const unavailable = vi
    .spyOn(store.database, "prepare")
    .mockImplementation((sql) => {
      if (sql.startsWith("INSERT INTO upstream_probe_samples")) {
        failed++;
        throw new Error("synthetic unavailable publication");
      }
      return prepare(sql);
    });
  const monitor = new UpstreamHealthMonitor(
    config,
    {} as Runtime,
    { now: () => new Date(now).toISOString() },
    probe,
    store,
  );
  try {
    monitor.schedule();
    await vi.waitFor(() => expect(failed).toBe(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    now += 150;
    monitor.schedule();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(
      store.database.prepare("SELECT * FROM upstream_probe_samples").all(),
    ).toEqual([]);
  } finally {
    held.resolve({ status: "reachable" });
    await monitor.close();
    unavailable.mockRestore();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("independent monitors share every completed probe, preserve failures across restart, and reject stale/config-mismatched facts", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cg-upstream-process-"));
  const writer = Store.open({ dataDir });
  const reader = Store.open({ dataDir });
  let now = Date.parse("2026-01-01T00:00:00Z");
  const clock = { now: () => new Date(now).toISOString() };
  const pending = Promise.withResolvers<Awaited<ReturnType<ConnectionProbe>>>();
  const probe = vi
    .fn<ConnectionProbe>()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce({
      status: "unreachable",
      failure: "connection_error",
    })
    .mockResolvedValue({ status: "reachable" });
  let background = new UpstreamHealthMonitor(
    configuration(),
    {} as Runtime,
    clock,
    probe,
    writer,
  );
  const network = vi.fn<ConnectionProbe>();
  const web = new UpstreamHealthMonitor(
    configuration(),
    {} as Runtime,
    clock,
    network,
    reader,
  );
  const state = {
    ...fixture(),
    runs: [{ ...run(1), launch_profile_ref: "agent" }],
  };
  const view = (monitor: UpstreamHealthMonitor) =>
    monitor.diagnostics(state).providers[0];
  try {
    background.schedule();
    await Promise.resolve();
    expect(view(web)?.status).toBe("unknown");
    pending.resolve({ status: "unreachable", failure: "connection_error" });
    await vi.waitFor(() => expect(view(web)?.status).toBe("unreachable"));
    expect(view(web)).toEqual(view(background));
    const firstFailure = view(web)?.last_failure_at;
    // Same status must refresh even when there is no project event/reconcile.
    now += 150;
    background.schedule();
    await vi.waitFor(() =>
      expect(view(web)?.last_failure_at).not.toBe(firstFailure),
    );
    const lastFailure = view(web)?.last_failure_at;
    now += 150;
    expect(view(web)?.status).toBe("unreachable"); // First observation would have expired.
    await background.close();
    background = new UpstreamHealthMonitor(
      configuration(),
      {} as Runtime,
      clock,
      probe,
      writer,
    );
    expect(view(background)).toEqual(view(web));
    background.schedule();
    await vi.waitFor(() => expect(view(web)?.status).toBe("reachable"));
    expect(view(web)?.last_failure_at).toBe(lastFailure);
    const restarted = new UpstreamHealthMonitor(
      configuration(),
      {} as Runtime,
      clock,
      network,
      reader,
    );
    expect(view(restarted)).toEqual(view(web));
    await restarted.close();
    now += 201;
    expect(view(web)).toMatchObject({
      status: "unknown",
      last_failure_at: lastFailure,
    });
    expect(view(web)).toEqual(view(background));
    now -= 1000; // Future-dated observations are also unknown under the original rule.
    expect(view(web)?.status).toBe("unknown");
    const changed = new UpstreamHealthMonitor(
      configuration("https://changed.invalid"),
      {} as Runtime,
      clock,
      network,
      reader,
    );
    expect(view(changed)?.checked_at).toBeUndefined();
    await changed.close();
    expect(network).not.toHaveBeenCalled();
    expect(
      JSON.stringify(
        reader.database.prepare("SELECT * FROM upstream_probe_samples").all(),
      ),
    ).not.toMatch(/fixture\.invalid|changed\.invalid/);
  } finally {
    await background.close();
    await web.close();
    writer.close();
    reader.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("fresh failed probes block request-side recovery events and become recoverable only under the same original rules", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cg-upstream-recovery-"));
  const writer = Store.open({ dataDir }),
    reader = Store.open({ dataDir });
  let now = "2026-01-01T00:10:00.000Z";
  const clock = { now: () => now };
  const result = vi
    .fn<ConnectionProbe>()
    .mockResolvedValueOnce({
      status: "unreachable",
      failure: "connection_error",
    })
    .mockResolvedValue({ status: "reachable" });
  const background = new UpstreamHealthMonitor(
    configuration(),
    {} as Runtime,
    clock,
    result,
    writer,
  );
  const web = new UpstreamHealthMonitor(
    configuration(),
    {} as Runtime,
    clock,
    undefined,
    reader,
  );
  const project = fixture().project_id;
  const allocator = ports();
  const event = (type: string, payload: Record<string, unknown>) => ({
    id: allocator.ids.nextEventId(),
    seq: allocator.ids.nextEventSequence(project),
    type,
    payload,
    created_at: "2026-01-01T00:00:00.000Z",
    actor: { kind: "system" as const, project_id: project },
  });
  const state = {
    ...fixture(),
    assignments: [assignment(1), assignment(2)],
    runs: [1, 2].map((n) => ({ ...run(n), launch_profile_ref: "agent" })),
    events: [
      event("upstream_incident_started", {
        group: "relay",
        providers: ["relay"],
        assignment_ids: ["A-1", "A-2"],
      }),
      event("run_inactive", {
        assignment_id: "A-1",
        run_id: "R-1",
        reason: "mcp_inactivity",
      }),
    ],
  };
  const activity = {
    "A-1": "idle" as const,
    "A-2": { working_at: "2026-01-01T00:10:00.050Z" },
  };
  const effects = (monitor: UpstreamHealthMonitor) =>
    value(
      recordUpstreamHealth(
        state,
        { kind: "system", project_id: project },
        monitor.view(state, activity),
        { ...allocator, clock },
      ),
    ).events.map((e) => e.type);
  try {
    background.schedule();
    await vi.waitFor(() =>
      expect(web.diagnostics(state).providers[0]?.status).toBe("unreachable"),
    );
    now = "2026-01-01T00:10:00.100Z";
    expect(web.diagnosis(state, "A-1", undefined, activity).action).toBe(
      "wait",
    );
    expect(web.diagnosis(state, "A-1", undefined, activity)).toEqual(
      background.diagnosis(state, "A-1", undefined, activity),
    );
    expect(effects(web)).not.toContain("upstream_recovery_ready");
    now = "2026-01-01T00:10:00.201Z";
    expect(web.diagnostics(state).providers[0]?.status).toBe("unknown");
    expect(web.diagnosis(state, "A-1", undefined, activity)).toEqual(
      background.diagnosis(state, "A-1", undefined, activity),
    );
    background.schedule();
    await vi.waitFor(() =>
      expect(web.diagnostics(state).providers[0]?.status).toBe("reachable"),
    );
    expect(web.diagnosis(state, "A-1", undefined, activity).action).toBe(
      "restart_once",
    );
    expect(effects(web)).toContain("upstream_recovery_ready");
    const restarted = new UpstreamHealthMonitor(
      configuration(),
      {} as Runtime,
      clock,
      undefined,
      reader,
    );
    expect(restarted.diagnosis(state, "A-1", undefined, activity)).toEqual(
      web.diagnosis(state, "A-1", undefined, activity),
    );
    await restarted.close();
  } finally {
    await background.close();
    await web.close();
    writer.close();
    reader.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
