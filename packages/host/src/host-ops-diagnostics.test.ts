import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHostOpsAssignment,
  HOST_OPS_ROLE_TOOLS,
  type Runtime,
} from "@cardigan/domain";
import {
  authenticate,
  hostOpsTools,
  loadCommandState,
  persistEffect,
  type ToolContext,
  unwrap,
} from "@cardigan/mcp-server";
import { parseLaunchConfig } from "@cardigan/roles";
import { recordWorkerUsage, Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { writeDeploymentRecord } from "./deployment-audit.js";
import { HostOpsService } from "./host-ops.js";
import { UpstreamHealthMonitor } from "./upstream-health.js";
import { workerHelperDigests } from "./worker-helper-release.js";
import {
  notifyHelperMismatch,
  workerPreparationOutcome,
} from "./worker-maintenance.js";

test("host ops returns deployment and upstream diagnostics together and revalidates access after IO", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cg-host-ops-diagnostics-"));
  const store = Store.open({ dataDir });
  const project = "cardigan";
  const clock = { now: () => "2026-11-13T00:00:00.000Z" };
  const runtime = {
    release: vi.fn(),
    wake: vi.fn(),
    diagnostics: () => ({
      active: 2,
      queued: 3,
      completed: 7,
      queue_timeouts: 0,
      max_concurrent: 4,
      queue_wait_ms: 30000,
      last: { wait_ms: 4, round_trip_ms: 12, error_category: null },
      event_subscriptions: 1,
      event_consumers: 15,
      status_requests: 2,
    }),
  };
  const monitor = new UpstreamHealthMonitor(
    parseLaunchConfig({
      providers: {
        relay: {
          harness: "codex",
          upstream: {
            group: "fixture",
            probe_url: "https://gateway.example.invalid",
          },
        },
      },
      profiles: { fixture: { harness: "codex", provider: "relay" } },
      upstream_health: {
        probe: { interval_ms: 100, timeout_ms: 20, stale_after_ms: 200 },
      },
    }),
    runtime as unknown as Runtime,
    clock,
    async () => ({ status: "unreachable", failure: "connection_error" }),
  );
  const service = new HostOpsService({
    store,
    runtime: runtime as unknown as Runtime,
    clock,
    upstreamMonitor: monitor,
    snapshot: async () => ({ model: "fixture", agent_cli_version: "fixture" }),
  });
  try {
    store.createProject({ id: project });
    const assignment = store.uow.run((tx) => {
      tx.roles.put(project, {
        role_id: "host_ops",
        role_version: 1,
        allowed_tools: HOST_OPS_ROLE_TOOLS,
        capabilities: [],
      });
      const effect = unwrap(
        createHostOpsAssignment(
          loadCommandState(tx, project),
          { kind: "human", project_id: project },
          {},
          { ids: tx.ids, clock },
        ),
      );
      persistEffect(tx, project, effect);
      return effect.data.assignment;
    });
    const token = store.issueToken({
      project_id: project,
      assignment_id: assignment.id,
      role: { role_version: 1, allowed_tools: HOST_OPS_ROLE_TOOLS },
    });
    const revalidateToken = vi.fn(() => {
      if (!store.verifyToken(token.token)) throw new Error("revoked");
    });
    const context: ToolContext = {
      store,
      identity: unwrap(authenticate(store, token.token)),
      revalidateToken,
    };
    writeDeploymentRecord(store, project, {
      attempt: "combined-diagnostics",
      from: "a".repeat(40),
      to: "b".repeat(40),
      status: "deployed",
      build: "passed",
      ready: true,
      downtime_ms: 12,
      summary: "ready and both ports verified",
    });
    monitor.schedule();
    await vi.waitFor(() =>
      expect(
        monitor.diagnostics(
          store.uow.read((tx) => loadCommandState(tx, project)),
        ).providers[0]?.status,
      ).toBe("unreachable"),
    );
    const read = hostOpsTools({ hostOps: service.tools }).find(
      (t) => t.name === "host_ops_read_diagnostics",
    );
    if (!read) throw new Error("Missing diagnostics tool");
    store.uow.run((tx) => {
      notifyHelperMismatch(
        tx,
        project,
        "worker-a",
        clock,
        "worker helper 与当前部署的 SHA-256 不一致",
        { helper_upgrade: { machine_id: "worker-a", binding: "a".repeat(64) } },
      );
      workerPreparationOutcome(
        store,
        tx,
        project,
        "worker-b",
        "binding",
        clock,
        "worker_disk_error",
        { failures: 1, duration_ms: 1000 },
      );
    });
    // C-666: each worker's latest usage report for this project only.
    const usage = {
      observed_at: "2026-11-13T00:00:00.000Z",
      status: "measured" as const,
      measured: {
        measured_at: "2026-11-13T00:00:00.000Z",
        free_bytes: 9 * 1024 ** 3,
        total_bytes: 228 * 1024 ** 3,
        worktrees: { bytes: 85 * 1024 ** 3, directories: 40 },
        builds: { bytes: 42 * 1024 ** 3, directories: 34 },
        runs: { bytes: 24 * 1024 ** 3, directories: 50 },
        complete: true,
      },
    };
    recordWorkerUsage(store, project, "worker-a", usage);
    recordWorkerUsage(store, project, "worker-b", {
      observed_at: "2026-11-13T00:00:00.000Z",
      status: "skipped",
      skipped_reason: "helper_outdated",
    });
    store.createProject({ id: "other" });
    recordWorkerUsage(store, "other", "worker-c", usage);
    const view = await read.handler(read.input.parse({}), context);
    expect((view as { worker_usage: unknown }).worker_usage).toEqual([
      { machine_id: "worker-a", ...usage },
      {
        machine_id: "worker-b",
        observed_at: "2026-11-13T00:00:00.000Z",
        status: "skipped",
        skipped_reason: "helper_outdated",
      },
    ]);
    expect(view).toMatchObject({
      worker_maintenance: expect.arrayContaining([
        ...Object.entries(workerHelperDigests()).map(([name, digest]) =>
          expect.objectContaining({
            instructions: expect.stringContaining(`${digest}  ${name}`),
          }),
        ),
        expect.objectContaining({
          instructions: expect.stringContaining("worker_disk_error"),
        }),
      ]),
      runtime_calls: {
        active: 2,
        queued: 3,
        max_concurrent: 4,
        queue_wait_ms: 30000,
        event_subscriptions: 1,
        last: { wait_ms: 4, round_trip_ms: 12 },
      },
      deployment: {
        records: [
          expect.objectContaining({
            attempt: "combined-diagnostics",
            status: "deployed",
            ready: true,
          }),
        ],
      },
      upstream_health: {
        classification_available: true,
        providers: [
          expect.objectContaining({ provider: "relay", status: "unreachable" }),
        ],
      },
    });
    expect(revalidateToken).toHaveBeenCalledTimes(2);
    expect(runtime.release).not.toHaveBeenCalled();
    expect(runtime.wake).not.toHaveBeenCalled();
    await expect(
      read.handler(read.input.parse({ project_id: "other" }), context),
    ).rejects.toMatchObject({ code: "unauthorized" });
    const revoke = vi.fn(() => {
      if (revoke.mock.calls.length === 2)
        throw new Error("revoked after diagnostics IO");
    });
    await expect(
      read.handler(read.input.parse({}), {
        ...context,
        revalidateToken: revoke,
      }),
    ).rejects.toThrow("revoked after diagnostics IO");
  } finally {
    await service.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("discard the retired monitor's late observation before reconcile", async () => {
  const store = Store.open({ dbPath: ":memory:" });
  store.createProject({ id: "fixture" });
  const config = () =>
    parseLaunchConfig({ profiles: { p: { harness: "codex", model: "m" } } });
  let current = config();
  const scheduled = Promise.withResolvers<Record<string, never>>();
  const observe = vi
    .spyOn(UpstreamHealthMonitor.prototype, "observe")
    .mockImplementationOnce(async () => scheduled.promise);
  const reconcile = vi.spyOn(UpstreamHealthMonitor.prototype, "reconcile");
  const failed = vi.spyOn(UpstreamHealthMonitor.prototype, "observationFailed");
  const svc = new HostOpsService({
    store,
    get upstream() {
      return current;
    },
    runtime: {} as Runtime,
    snapshot: async () => ({ model: "m", agent_cli_version: "1" }),
  });
  try {
    await svc.tick();
    expect(observe).toHaveBeenCalledOnce();
    current = config();
    await svc.tick();
    scheduled.resolve({});
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reconcile).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    await svc.tick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reconcile).toHaveBeenCalledOnce();
  } finally {
    scheduled.resolve({});
    await svc.close();
    store.close();
    vi.restoreAllMocks();
  }
});
