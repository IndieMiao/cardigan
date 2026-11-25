import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import type {
  AssignmentId,
  EventId,
  Runtime,
  UpstreamDiagnosis,
} from "@cardigan/domain";
import { parseLaunchConfig } from "@cardigan/roles";
import type { Store } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import {
  fixture,
  id,
  ports,
  run,
} from "../../domain/src/commands/test-fixtures.js";
import {
  probeUpstreamConnection,
  UpstreamHealthMonitor,
  upstreamHoldReason,
} from "./upstream-health.js";

const configuration = () =>
  parseLaunchConfig({
    providers: {
      relay: {
        harness: "codex",
        env: { OPENAI_BASE_URL: "https://must-not-infer.invalid" },
        secret_env: { OPENAI_API_KEY: "secret-name" },
        upstream: {
          group: "shared",
          probe_url: "https://gateway.example.invalid",
        },
      },
      absent: { harness: "pi" },
    },
    profiles: { agent: { harness: "codex", provider: "relay" } },
    upstream_health: {
      probe: { interval_ms: 100, timeout_ms: 20, stale_after_ms: 200 },
    },
  });
const monitors: UpstreamHealthMonitor[] = [];
afterEach(async () => {
  await Promise.all(monitors.splice(0).map((m) => m.close()));
});

test("a probe sends no HTTP bytes or credentials and a completed handshake is only reachability", async () => {
  const received: Buffer[] = [];
  const server = createServer((socket) =>
    socket.on("data", (bytes) => received.push(bytes)),
  );
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  try {
    const address = server.address() as AddressInfo;
    expect(
      await probeUpstreamConnection(
        `http://localhost:${address.port}`,
        1000,
        new AbortController().signal,
      ),
    ).toEqual({ status: "reachable" });
    expect(received).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("sampling is detached, single-flight and stale or missing observations stay unknown", async () => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  let finish!: (value: {
    status: "unreachable";
    failure: "connection_error";
  }) => void;
  const probe = vi.fn(
    () =>
      new Promise<{ status: "unreachable"; failure: "connection_error" }>(
        (resolve) => {
          finish = resolve;
        },
      ),
  );
  const monitor = new UpstreamHealthMonitor(
    configuration(),
    {} as Runtime,
    { now: () => new Date(now).toISOString() },
    probe,
  );
  monitors.push(monitor);
  const state = {
    ...fixture(),
    runs: [{ ...run(1), launch_profile_ref: "agent" }],
  };
  expect(monitor.schedule()).toBeUndefined();
  monitor.schedule();
  await Promise.resolve();
  expect(probe).toHaveBeenCalledTimes(1);
  expect(probe.mock.calls[0]?.[0]).toBe("https://gateway.example.invalid");
  expect(
    monitor.diagnostics(state).providers.every((p) => p.status === "unknown"),
  ).toBe(true);
  finish({ status: "unreachable", failure: "connection_error" });
  await vi.waitFor(() =>
    expect(monitor.diagnostics(state).providers[0]?.status).toBe("unreachable"),
  );
  const failed = monitor.diagnostics(state).providers[0]?.last_failure_at;
  now += 201;
  expect(monitor.diagnostics(state).providers[0]).toMatchObject({
    status: "unknown",
    last_failure_at: failed,
  });
  expect(JSON.stringify(monitor.diagnostics(state))).not.toMatch(
    /secret-name|must-not-infer/,
  );
});

test("missing probe timings performs no network IO and runtime work blocks a false stall", async () => {
  const config = configuration();
  delete config.upstream_health;
  const probe = vi.fn();
  const runtime = {
    status: vi.fn(async () => ({
      ok: true,
      value: { process: "alive", agent: "working", observed_seq: 1 },
    })),
  } as unknown as Runtime;
  const now = "2026-01-01T00:00:00.000Z";
  const monitor = new UpstreamHealthMonitor(
    config,
    runtime,
    { now: () => now },
    probe,
  );
  monitors.push(monitor);
  const base = fixture();
  const state = {
    ...base,
    runs: [{ ...run(1), launch_profile_ref: "agent" }],
    assignments: base.assignments.map((a) => ({
      ...a,
      runtime_ref: {
        harness: "codex" as const,
        machine_id: "local",
        runtime_machine: "local",
        terminal_ref: "fixture",
        agent_name: "fixture",
      },
    })),
  };
  monitor.schedule();
  expect(probe).not.toHaveBeenCalled();
  const activity = await monitor.observe(state);
  expect(monitor.diagnostics(state, activity).sessions[0]).toMatchObject({
    cause: "agent_busy",
    action: "none",
  });
});

test("classification failure blocks recovery without interrupting other projects or leaking errors", () => {
  const monitor = new UpstreamHealthMonitor(configuration(), {} as Runtime, {
    now: () => "2026-01-01T00:00:00.000Z",
  });
  monitors.push(monitor);
  const state = {
    ...fixture(),
    runs: [{ ...run(1), launch_profile_ref: "agent" }],
  };
  const broken = {
    uow: {
      run: () => {
        throw new Error("private store failure");
      },
    },
  } as unknown as Store;
  expect(() => monitor.reconcile(broken, state.project_id)).not.toThrow();
  const view = monitor.diagnostics(state);
  expect(view.classification_available).toBe(false);
  expect(view.sessions[0]).toMatchObject({
    action: "wait",
    evidence: ["classification_failed"],
  });
  expect(JSON.stringify(view)).not.toContain("private store failure");
  expect(
    monitor.diagnostics({
      ...state,
      project_id: "other" as typeof state.project_id,
    }).classification_available,
  ).toBe(true);
});

test.each([40, 80])(
  "diagnostics build one view/targets for %i sessions and preserve individual diagnoses",
  (count) => {
    const base = fixture();
    const first = base.assignments[0];
    if (!first) throw new Error("Missing assignment");
    const state = {
      ...base,
      assignments: Array.from({ length: count }, (_, i) => ({
        ...first,
        id: `A-${i + 1}` as typeof first.id,
      })),
      runs: Array.from({ length: count }, (_, i) => ({
        ...run(1),
        id: `R-${i + 1}` as ReturnType<typeof run>["id"],
        assignment_id: `A-${i + 1}` as typeof first.id,
        launch_profile_ref: "agent",
      })),
    };
    const monitor = new UpstreamHealthMonitor(configuration(), {} as Runtime, {
      now: () => "2026-01-01T00:00:00Z",
    });
    monitors.push(monitor);
    const expected = state.assignments.map((a) =>
      monitor.diagnosis(state, a.id),
    );
    const view = vi.spyOn(monitor, "view"),
      targets = vi.spyOn(monitor, "targets");
    expect(monitor.diagnostics(state).sessions).toEqual(expected);
    expect(view).toHaveBeenCalledTimes(1);
    expect(targets).toHaveBeenCalledTimes(1);
  },
);

test("indexed targets preserve closed-card exclusion, last profile-bearing run, and employee fallback", () => {
  const state = fixture();
  const monitor = new UpstreamHealthMonitor(configuration(), {} as Runtime, {
    now: () => "2026-01-01T00:00:00Z",
  });
  monitors.push(monitor);
  for (const closed of [false, true]) {
    const current = {
      ...state,
      cards: state.cards.map((c) => ({
        ...c,
        status: closed ? ("done" as const) : c.status,
      })),
      runs: [
        { ...run(1), launch_profile_ref: "agent" },
        { ...run(1), id: "R-999" as ReturnType<typeof run>["id"] },
      ],
    };
    const expected = current.assignments
      .filter(
        (a) =>
          a.status === "active" &&
          !a.external &&
          (a.scope !== "work_item" ||
            !current.cards.some(
              (c) =>
                ["done", "cancelled"].includes(c.status) &&
                current.work_items.some(
                  (w) => w.id === a.work_item_id && w.card_id === c.id,
                ),
            )),
      )
      .flatMap((a) => {
        const ref =
          current.runs.findLast(
            (r) => r.assignment_id === a.id && r.launch_profile_ref,
          )?.launch_profile_ref ??
          current.employees?.find((e) => e.id === a.employee_id)
            ?.launch_profile_ref;
        return ref === "agent"
          ? [{ assignment_id: a.id, provider: "relay", group: "shared" }]
          : [];
      });
    expect(monitor.targets(current)).toEqual(expected);
  }
});

test("interaction is sampled only for current unfinished blocked/inactive sessions, expires and invalidates on ref change", async () => {
  let now = Date.parse("2026-01-01T00:20:00.000Z");
  const interaction = vi.fn(async () => ({
    ok: true as const,
    value: "confirmation" as const,
  }));
  const status = vi.fn(async () => ({
    ok: true as const,
    value: {
      process: "alive" as const,
      agent: "blocked" as const,
      observed_seq: 1,
    },
  }));
  const monitor = new UpstreamHealthMonitor(
    configuration(),
    { status, interaction } as unknown as Runtime,
    { now: () => new Date(now).toISOString() },
  );
  monitors.push(monitor);
  const base = fixture();
  const state = {
    ...base,
    runs: [{ ...run(1), launch_profile_ref: "agent" }],
    assignments: base.assignments.map((a) => ({
      ...a,
      runtime_ref: {
        machine_id: "local",
        runtime_machine: "local",
        terminal_ref: "t1",
        agent_name: "fixture",
      },
    })),
  };
  const owner = state.assignments[0];
  if (!owner) throw new Error("Missing fixture owner");
  const fresh = await monitor.observe(state);
  expect(interaction).toHaveBeenCalledTimes(1);
  expect(monitor.diagnosis(state, owner.id, undefined, fresh).cause).toBe(
    "waiting_confirmation",
  );
  expect(JSON.stringify(monitor.diagnostics(state, fresh))).not.toContain(
    "runtime_ref",
  );
  now += 30001;
  expect(monitor.diagnosis(state, owner.id)).toMatchObject({
    cause: "unknown",
    action: "wait",
  });
  now -= 30001;
  const replaced = {
    ...state,
    assignments: state.assignments.map((a) => ({
      ...a,
      runtime_ref: { ...a.runtime_ref, terminal_ref: "t2" },
    })),
  };
  expect(
    monitor.diagnosis(replaced, owner.id, undefined, fresh).cause,
  ).not.toBe("waiting_confirmation");
  await monitor.observe({
    ...state,
    runs: state.runs.map((r) => ({ ...r, status: "completed" as const })),
  });
  expect(interaction).toHaveBeenCalledTimes(1);
});

test.each(["expired", "replaced"] as const)(
  "cached confirmation evidence cannot become an inactivity cluster when %s",
  async (invalid) => {
    let now = Date.parse("2026-01-01T00:20:00.000Z");
    const monitor = new UpstreamHealthMonitor(
      configuration(),
      {
        status: async () => ({
          ok: true,
          value: { process: "alive", agent: "blocked", observed_seq: 1 },
        }),
        interaction: async () => ({ ok: true, value: "confirmation" }),
      } as unknown as Runtime,
      { now: () => new Date(now).toISOString() },
    );
    monitors.push(monitor);
    const base = fixture();
    const p = ports();
    const state = {
      ...base,
      assignments: base.assignments.slice(0, 3).map((a) => ({
        ...a,
        runtime_ref: {
          machine_id: "local",
          runtime_machine: "local",
          terminal_ref: a.id,
          agent_name: "fixture",
        },
      })),
      runs: [1, 2, 3].map((n) => ({ ...run(n), launch_profile_ref: "agent" })),
      events: [1, 2, 3].map((n) => ({
        id: p.ids.nextEventId(),
        seq: n,
        type: "run_inactive",
        actor: { kind: "system" as const, project_id: base.project_id },
        payload: { assignment_id: id("assignment", n), run_id: id("run", n) },
        created_at: new Date(now).toISOString(),
      })),
    };
    await monitor.observe(state);
    if (invalid === "expired") now += 30001;
    else
      state.assignments = state.assignments.map((a) => ({
        ...a,
        runtime_ref: { ...a.runtime_ref, terminal_ref: "replaced" },
      }));
    const view = monitor.diagnostics(state);
    expect(view.sessions).toHaveLength(3);
    for (const session of view.sessions)
      expect(session).toMatchObject({
        cause: "unknown",
        action: "wait",
        evidence: ["runtime_observation_unavailable"],
      });
  },
);

test("C-680: only a line fault holds a recovery as upstream not recovered", () => {
  const d = (
    cause: UpstreamDiagnosis["cause"],
    evidence: string[] = [],
    incident = false,
  ): UpstreamDiagnosis => ({
    assignment_id: "A-1" as AssignmentId,
    provider: "deepseek",
    group: "deepseek",
    cause,
    action: "wait",
    evidence,
    ...(incident ? { incident_id: "E-1" as EventId } : {}),
  });
  expect(upstreamHoldReason(d("upstream_unreachable"))).toBe(
    "upstream_recovery_not_ready",
  );
  expect(upstreamHoldReason(d("upstream_suspected"))).toBe(
    "upstream_recovery_not_ready",
  );
  expect(upstreamHoldReason(d("runtime_exited", [], true))).toBe(
    "upstream_recovery_not_ready",
  );
  // No incident, no failed probe, no API error: name the real condition.
  expect(upstreamHoldReason(d("agent_busy", ["harness_working"]))).toBe(
    "agent_busy",
  );
  expect(upstreamHoldReason(d("waiting_interaction"))).toBe(
    "waiting_interaction",
  );
  expect(upstreamHoldReason(d("server_problem"))).toBe("server_problem");
  expect(
    upstreamHoldReason(
      d("unknown", ["multiple_inactive_sessions_require_investigation"]),
    ),
  ).toBe("session_state_unconfirmed");
  expect(upstreamHoldReason(d("unknown", ["classification_failed"]))).toBe(
    "upstream_diagnosis_unavailable",
  );
  expect(upstreamHoldReason(d("unknown", ["provider_not_resolved"]))).toBe(
    "upstream_diagnosis_unavailable",
  );
  expect(upstreamHoldReason(undefined)).toBe("upstream_diagnosis_unavailable");
});
