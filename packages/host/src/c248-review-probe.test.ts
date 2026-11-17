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
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { writeDeploymentRecord } from "./deployment-audit.js";
import { HostOpsService } from "./host-ops.js";
import { UpstreamHealthMonitor } from "./upstream-health.js";

test("C-248 regression: request process must see the background probe", async () => {
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
  const readerStore = Store.open({ dataDir });
  const service = new HostOpsService({
    store: readerStore,
    runtime: runtime as unknown as Runtime,
    clock,
    upstream: parseLaunchConfig({
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
    monitor.reconcile(store, project);
    const read = hostOpsTools({ hostOps: service.tools }).find(
      (t) => t.name === "host_ops_read_diagnostics",
    );
    if (!read) throw new Error("Missing diagnostics tool");
    const view = await read.handler(read.input.parse({}), context);
    expect(view).toMatchObject({
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
    await monitor.close();
    readerStore.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

import { recordUpstreamHealth } from "@cardigan/domain";
import {
  fixture,
  assignment as makeAssignment,
  run as makeRun,
  ports,
  value,
} from "../../domain/src/commands/test-fixtures.js";

test("C-248 regression: split request monitor must not authorize recovery during fresh failed probe", async () => {
  let now = "2026-01-01T00:10:00.000Z";
  const config = parseLaunchConfig({
    providers: {
      relay: {
        harness: "codex",
        upstream: { group: "relay", probe_url: "https://fixture.invalid" },
      },
    },
    profiles: { agent: { harness: "codex", provider: "relay" } },
    upstream_health: {
      probe: { interval_ms: 100, timeout_ms: 20, stale_after_ms: 200 },
    },
  });
  const clock = { now: () => now };
  const background = new UpstreamHealthMonitor(
    config,
    {} as Runtime,
    clock,
    async () => ({ status: "unreachable", failure: "connection_error" }),
  );
  const web = new UpstreamHealthMonitor(config, {} as Runtime, clock);
  const allocator = ports();
  const project = fixture().project_id;
  const event = (
    type: string,
    payload: Record<string, unknown>,
    at: string,
  ) => ({
    id: allocator.ids.nextEventId(),
    seq: allocator.ids.nextEventSequence(project),
    type,
    payload,
    created_at: at,
    actor: { kind: "system" as const, project_id: project },
  });
  const state = {
    ...fixture(),
    assignments: [makeAssignment(1), makeAssignment(2)],
    runs: [1, 2].map((n) => ({ ...makeRun(n), launch_profile_ref: "agent" })),
    events: [
      event(
        "upstream_incident_started",
        {
          group: "relay",
          providers: ["relay"],
          assignment_ids: ["A-1", "A-2"],
        },
        "2026-01-01T00:00:00.000Z",
      ),
      event(
        "run_inactive",
        { assignment_id: "A-1", run_id: "R-1", reason: "mcp_inactivity" },
        "2026-01-01T00:00:00.000Z",
      ),
      event(
        "upstream_probe_changed",
        {
          provider: "relay",
          group: "relay",
          status: "unreachable",
          checked_at: now,
          last_failure_at: now,
          failure: "connection_error",
        },
        now,
      ),
    ],
  };
  try {
    background.schedule();
    await vi.waitFor(() =>
      expect(background.diagnostics(state).providers[0]?.status).toBe(
        "unreachable",
      ),
    );
    now = "2026-01-01T00:10:00.100Z";
    const activity = {
      "A-1": "idle" as const,
      "A-2": { working_at: "2026-01-01T00:10:00.050Z" },
    };
    const backgroundDiagnosis = background.diagnosis(
      state,
      "A-1",
      undefined,
      activity,
    );
    const webDiagnosis = web.diagnosis(state, "A-1", undefined, activity);
    const effects = (monitor: UpstreamHealthMonitor) =>
      value(
        recordUpstreamHealth(
          state,
          { kind: "system", project_id: project },
          monitor.view(state, activity),
          { ...allocator, clock },
        ),
      );
    const result = {
      background: {
        probe: background.diagnostics(state).providers[0]?.status,
        action: backgroundDiagnosis.action,
        events: effects(background).events.map((e) => e.type),
      },
      web: {
        probe: web.diagnostics(state).providers[0]?.status,
        action: webDiagnosis.action,
        events: effects(web).events.map((e) => e.type),
      },
    };
    console.log("C248_REVIEW_PROOF", JSON.stringify(result));
    expect(result.web.action).toBe(result.background.action);
    expect(result.web.events).not.toContain("upstream_recovery_ready");
  } finally {
    await background.close();
    await web.close();
  }
});
