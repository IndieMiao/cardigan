import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import type { Runtime } from "@cardigan/domain";
import { parseLaunchConfig } from "@cardigan/roles";
import type { Store } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { fixture, run } from "../../domain/src/commands/test-fixtures.js";
import {
  probeUpstreamConnection,
  UpstreamHealthMonitor,
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
