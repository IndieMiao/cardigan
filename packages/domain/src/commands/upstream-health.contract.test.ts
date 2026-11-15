import { expect, test } from "vitest";
import type { Event, JsonValue } from "../entities.js";
import {
  DEFAULT_UPSTREAM_POLICY,
  diagnoseUpstream,
  diagnoseUpstreams,
  type SessionActivity,
  type UpstreamProbe,
  type UpstreamTarget,
  upstreamCluster,
  upstreamIncident,
} from "../upstream-health.js";
import type { CommandState } from "./core.js";
import {
  apply,
  assignment,
  fixture,
  id,
  ports,
  run,
  value,
} from "./test-fixtures.js";
import { recordUpstreamHealth } from "./upstream-health.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}

function scenario() {
  const allocator = ports();
  const at = (minutes: number) =>
    new Date(
      Date.parse("2026-01-01T00:00:00.000Z") + minutes * 60_000,
    ).toISOString();
  let now = at(0);
  let state: CommandState = {
    ...fixture(),
    assignments: [assignment(1), assignment(2), assignment(3)],
    runs: [run(1), run(2), run(3)],
    events: [],
  };
  const targets: UpstreamTarget[] = [1, 2, 3].map((n) => ({
    assignment_id: id("assignment", n),
    provider: n === 3 ? "codex" : "claude",
    group: "relay",
  }));
  const probe = (status: UpstreamProbe["status"]): UpstreamProbe[] => [
    {
      provider: "claude",
      group: "relay",
      status,
      checked_at: now,
      ...(status === "unreachable"
        ? { last_failure_at: now, failure: "connection_error" as const }
        : {}),
    },
  ];
  const fact = (type: string, payload: JsonValue, time = now) => {
    const e: Event = {
      id: allocator.ids.nextEventId(),
      seq: allocator.ids.nextEventSequence(state.project_id),
      type,
      actor: { kind: "system", project_id: state.project_id },
      payload,
      created_at: time,
    };
    state = { ...state, events: [...state.events, e] };
    return e;
  };
  const inactive = (n: number, time = now, runNumber = n) =>
    fact(
      "run_inactive",
      {
        assignment_id: id("assignment", n),
        run_id: id("run", runNumber),
        reason: "mcp_inactivity",
      },
      time,
    );
  const record = (
    probes = probe("unknown"),
    activity: SessionActivity = {},
  ) => {
    const effect = value(
      recordUpstreamHealth(
        state,
        { kind: "system", project_id: state.project_id },
        { targets, probes, activity, policy: DEFAULT_UPSTREAM_POLICY },
        { ...allocator, clock: { now: () => now } },
      ),
    );
    state = apply(state, effect);
    return effect;
  };
  const diagnosis = (
    n = 1,
    probes = probe("unknown"),
    activity: SessionActivity = {},
  ) => {
    const individual = targets.map((target) =>
      diagnoseUpstream(
        state,
        target,
        targets,
        probes,
        DEFAULT_UPSTREAM_POLICY,
        now,
        activity,
      ),
    );
    // Every recovery/recurrence/publication scenario below also checks batch parity.
    expect(
      diagnoseUpstreams(
        state,
        targets,
        probes,
        DEFAULT_UPSTREAM_POLICY,
        now,
        activity,
      ),
    ).toEqual(individual);
    return required(individual[n - 1]);
  };
  return {
    at,
    fact,
    inactive,
    record,
    diagnosis,
    probe,
    targets,
    state: () => state,
    replace: (next: CommandState) => {
      state = next;
    },
    advance: (m: number) => {
      now = at(m);
    },
  };
}

test("a failed connection blocks restart and durably notifies Office and the human once", () => {
  const f = scenario();
  const effect = f.record(f.probe("unreachable"));
  expect(f.diagnosis(1, f.probe("unreachable"))).toMatchObject({
    cause: "upstream_unreachable",
    action: "wait",
  });
  expect(effect.data).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ recipient: { kind: "pm_office" } }),
    ]),
  );
  expect(f.state().human_actions).toHaveLength(1);
  expect(f.record(f.probe("unreachable")).events).toEqual([]);
  f.replace(JSON.parse(JSON.stringify(f.state())) as CommandState);
  expect(f.record(f.probe("unreachable")).events).toEqual([]);
  expect(f.state().human_actions).toHaveLength(1);
});

test("three distinct sessions in the inclusive window share an outage across providers, but not direct lines", () => {
  const f = scenario();
  f.inactive(1, f.at(0));
  f.inactive(2, f.at(5));
  f.inactive(3, f.at(10));
  expect(
    upstreamCluster(f.state(), f.targets, DEFAULT_UPSTREAM_POLICY, {}),
  ).toHaveLength(3);
  f.record();
  expect(f.diagnosis()).toMatchObject({
    cause: "upstream_suspected",
    action: "wait",
  });
  const direct = { ...required(f.targets[2]), group: "direct" };
  expect(
    diagnoseUpstream(
      f.state(),
      direct,
      [required(f.targets[0]), required(f.targets[1]), direct],
      f.probe("unknown"),
      DEFAULT_UPSTREAM_POLICY,
      f.at(10),
      {},
    ),
  ).toMatchObject({ cause: "unknown", action: "wait" });
  const g = scenario();
  g.inactive(1, g.at(0));
  g.inactive(1, g.at(1));
  g.inactive(2, g.at(2));
  expect(
    upstreamCluster(g.state(), g.targets, DEFAULT_UPSTREAM_POLICY, {}),
  ).toEqual([]);
  g.inactive(3, g.at(12.0001));
  expect(
    upstreamCluster(g.state(), g.targets, DEFAULT_UPSTREAM_POLICY, {}),
  ).toEqual([]);
});

test("MCP silence alone does not label a long test as stuck; one confirmed idle session uses the v3 fallback", () => {
  const f = scenario();
  f.inactive(1);
  expect(
    f.diagnosis(1, f.probe("reachable"), { "A-1": "working" }),
  ).toMatchObject({ cause: "agent_busy", action: "none" });
  expect(f.diagnosis(1, f.probe("reachable"))).toMatchObject({
    cause: "unknown",
    action: "wait",
  });
  expect(f.diagnosis(1, f.probe("reachable"), { "A-1": "idle" })).toMatchObject(
    { cause: "agent_stalled", action: "restart_once" },
  );
  expect(f.diagnosis(1, f.probe("unknown"), { "A-1": "idle" })).toMatchObject({
    cause: "unknown",
    action: "restart_once",
  });
  f.inactive(2);
  f.inactive(3);
  expect(
    upstreamCluster(f.state(), f.targets, DEFAULT_UPSTREAM_POLICY, {
      "A-1": "working",
    }),
  ).toEqual([]);
});

test("recovery requires the full window and activity evidence, then permits only one request across restarts", () => {
  const f = scenario();
  for (const n of [1, 2, 3]) f.inactive(n);
  f.record();
  const incident = required(upstreamIncident(f.state(), "relay"));
  f.advance(10);
  expect(f.diagnosis(1, f.probe("reachable")).action).toBe("wait");
  f.replace({
    ...f.state(),
    assignments: f
      .state()
      .assignments.map((a) =>
        a.id === "A-3" ? { ...a, last_mcp_activity_at: f.at(1) } : a,
      ),
  });
  f.advance(9.9999);
  expect(f.diagnosis().action).toBe("wait");
  f.advance(10);
  expect(f.diagnosis()).toMatchObject({
    action: "restart_once",
    incident_id: incident.id,
  });
  expect(
    f.record().events.some((e) => e.type === "upstream_recovery_ready"),
  ).toBe(true);
  expect(
    f.record().events.some((e) => e.type === "upstream_recovery_ready"),
  ).toBe(false);
  f.fact("host_ops_action_taken", {
    assignment_id: "A-1",
    tool: "host_ops_restart_assignment",
    upstream_incident_id: incident.id,
  });
  f.replace(JSON.parse(JSON.stringify(f.state())) as CommandState);
  expect(f.diagnosis().action).toBe("wait");
  expect(f.diagnosis().evidence).toContain("recovery_already_requested");
});

test("silence beginning at fifteen minutes escalates once despite a delayed alert", () => {
  const f = scenario();
  const taken = f.fact("host_ops_action_taken", {
    assignment_id: "A-1",
    tool: "host_ops_restart_assignment",
  });
  f.fact("host_ops_action_finished", {
    assignment_id: "A-1",
    action_id: taken.id,
  });
  f.replace({
    ...f.state(),
    assignments: f
      .state()
      .assignments.map((a) =>
        a.id === "A-1" ? { ...a, last_mcp_activity_at: f.at(15) } : a,
      ),
  });
  f.advance(30);
  f.inactive(1);
  f.record();
  expect(f.diagnosis()).toMatchObject({
    cause: "upstream_suspected",
    action: "human",
  });
  expect(f.state().human_actions).toHaveLength(1);
  f.replace(JSON.parse(JSON.stringify(f.state())) as CommandState);
  expect(f.record().events).toEqual([]);
  f.advance(100);
  expect(f.diagnosis().action).toBe("human");
});

test("structured error origin separates an MCP/server failure from the upstream connection", () => {
  const f = scenario();
  f.inactive(1);
  f.fact("bell_delivery_attempt_failed", {
    assignment_id: "A-1",
    run_id: "R-1",
    reason: "before_wake_failed",
    error: { message: "ECONNREFUSED bearer-should-not-leak" },
  });
  expect(f.diagnosis(1, f.probe("reachable"), { "A-1": "idle" })).toMatchObject(
    { cause: "server_problem", action: "wait" },
  );
  expect(JSON.stringify(f.diagnosis())).not.toContain("bearer-should-not-leak");
  f.record(f.probe("unreachable"));
  expect(f.diagnosis(1, f.probe("unreachable"))).toMatchObject({
    cause: "upstream_unreachable",
    action: "wait",
  });
});

test("two unexplained inactive sessions cannot use the single-session restart rule", () => {
  const f = scenario();
  f.inactive(1);
  f.inactive(2);
  expect(f.diagnosis(1, f.probe("reachable"), { "A-1": "idle" })).toMatchObject(
    {
      cause: "unknown",
      action: "wait",
      evidence: ["multiple_inactive_sessions_require_investigation"],
    },
  );
});

test("multiple server-side delivery failures do not become an upstream cluster", () => {
  const f = scenario();
  for (const n of [1, 2, 3]) {
    f.inactive(n);
    f.fact("bell_delivery_attempt_failed", {
      assignment_id: `A-${n}`,
      run_id: `R-${n}`,
      reason: "wake_failed",
      error: { message: "ECONNRESET" },
    });
  }
  expect(
    upstreamCluster(f.state(), f.targets, DEFAULT_UPSTREAM_POLICY, {}),
  ).toEqual([]);
  f.record();
  expect(f.state().human_actions).toEqual([]);
  expect(f.diagnosis(1, f.probe("reachable"), { "A-1": "idle" }).cause).toBe(
    "server_problem",
  );
});

test.each(["started_at", "heartbeat_at", "last_mcp_activity_at"] as const)(
  "recovery activity in %s makes an old delivery failure irrelevant to a later stall",
  (field) => {
    const f = scenario();
    for (const n of [1, 2, 3]) {
      f.fact("bell_delivery_attempt_failed", {
        assignment_id: `A-${n}`,
        run_id: `R-${n}`,
        reason: "before_wake_failed",
      });
    }
    f.replace({
      ...f.state(),
      runs: f
        .state()
        .runs.map((r) =>
          field === "last_mcp_activity_at" ? r : { ...r, [field]: f.at(1) },
        ),
      assignments: f
        .state()
        .assignments.map((a) =>
          field === "last_mcp_activity_at"
            ? { ...a, last_mcp_activity_at: f.at(1) }
            : a,
        ),
    });
    f.advance(16);
    f.inactive(1);
    expect(
      f.diagnosis(1, f.probe("reachable"), { "A-1": "idle" }),
    ).toMatchObject({
      cause: "agent_stalled",
      action: "restart_once",
    });
    f.inactive(2);
    f.inactive(3);
    expect(
      upstreamCluster(f.state(), f.targets, DEFAULT_UPSTREAM_POLICY, {}),
    ).toHaveLength(3);
    f.record();
    expect(f.diagnosis().cause).toBe("upstream_suspected");
  },
);

test("a completed Run cannot keep an already open outage waiting for activity", () => {
  const f = scenario();
  f.record(f.probe("unreachable"));
  f.replace({
    ...f.state(),
    runs: f.state().runs.map((r) => ({ ...r, status: "completed" as const })),
  });
  f.advance(10);
  f.record(f.probe("reachable"));
  expect(upstreamIncident(f.state(), "relay")).toBeUndefined();
  expect(f.state().human_actions.filter((h) => h.status === "open")).toEqual(
    [],
  );
});

test("a later connection failure invalidates older activity as recovery evidence across restarts", () => {
  const f = scenario();
  f.inactive(1);
  f.record(f.probe("unreachable"));
  f.replace({
    ...f.state(),
    assignments: f
      .state()
      .assignments.map((a) =>
        a.id === "A-3" ? { ...a, last_mcp_activity_at: f.at(1) } : a,
      ),
  });
  f.advance(9);
  const failed = f.probe("unreachable");
  expect(
    f.record(failed).events.some((e) => e.type === "upstream_probe_changed"),
  ).toBe(true);
  f.replace(JSON.parse(JSON.stringify(f.state())) as CommandState);
  f.advance(10);
  const recovered = failed.map((p) => ({ ...p, status: "reachable" as const }));
  expect(f.diagnosis(1, recovered).action).toBe("wait");
  expect(
    f
      .record(recovered)
      .events.some((e) => e.type === "upstream_recovery_ready"),
  ).toBe(false);
  f.replace({
    ...f.state(),
    assignments: f
      .state()
      .assignments.map((a) =>
        a.id === "A-3" ? { ...a, last_mcp_activity_at: f.at(10) } : a,
      ),
  });
  expect(f.diagnosis(1, recovered).action).toBe("restart_once");
});

test("host-only persistence rejects an Agent and invalid policy without effects", () => {
  const f = scenario();
  const p = ports();
  const input = {
    targets: f.targets,
    probes: f.probe("unreachable"),
    activity: {},
    policy: DEFAULT_UPSTREAM_POLICY,
  };
  expect(
    recordUpstreamHealth(
      f.state(),
      { kind: "human", project_id: f.state().project_id },
      input,
      p,
    ).ok,
  ).toBe(false);
  expect(
    recordUpstreamHealth(
      f.state(),
      { kind: "system", project_id: f.state().project_id },
      { ...input, policy: { ...input.policy, inactivity_window_ms: 0 } },
      p,
    ).ok,
  ).toBe(false);
  expect(f.state().events).toEqual([]);
});

test("structured harness errors join the same distinct-session window; working sessions are excluded", () => {
  const f = scenario();
  f.advance(10);
  f.inactive(1, f.at(0));
  const activity: SessionActivity = {
    "A-2": { error: "rate_limit", at: f.at(5) },
    "A-3": { error: "stream_disconnected", at: f.at(10) },
  };
  expect(
    upstreamCluster(f.state(), f.targets, DEFAULT_UPSTREAM_POLICY, activity),
  ).toHaveLength(3);
  expect(
    upstreamCluster(f.state(), f.targets, DEFAULT_UPSTREAM_POLICY, {
      ...activity,
      "A-1": "working",
    }),
  ).toEqual([]);
  f.record([], activity);
  expect(upstreamIncident(f.state(), "relay")?.assignment_ids).toHaveLength(3);
  expect(f.diagnosis(2, [], activity).action).toBe("wait");
  expect(f.record([], activity).events).toEqual([]);
});

test("fresh harness progress is recovery evidence but does not bypass the existing recovery window", () => {
  const f = scenario();
  for (const n of [1, 2, 3]) f.inactive(n);
  f.record();
  f.advance(1);
  const activity: SessionActivity = { "A-3": { working_at: f.at(1) } };
  f.record([], activity);
  expect(f.diagnosis(1, [], activity).action).toBe("wait");
  f.advance(10);
  f.record([], activity);
  expect(f.diagnosis(1, [], activity).action).toBe("restart_once");
  expect(f.diagnosis(3, [], activity).action).toBe("wait");
  f.record([], {
    "A-1": { working_at: f.at(10) },
    "A-2": { working_at: f.at(10) },
    "A-3": { working_at: f.at(10) },
  });
  expect(upstreamIncident(f.state(), "relay")).toBeUndefined();
});

test.each([
  ["2026-01-01T08:08:00+08:00", "wait"],
  ["2026-01-01T08:09:00+08:00", "wait"],
  ["2026-01-01T00:09:00Z", "wait"],
  ["2026-01-01T08:09:00.001+08:00", "restart_once"],
  ["2025-12-31T19:09:00.001-05:00", "restart_once"],
] as const)(
  "recovery compares instants across timezones/precision: %s",
  (at, action) => {
    const f = scenario();
    for (const n of [1, 2, 3]) f.inactive(n);
    f.record();
    f.advance(10);
    const probes: UpstreamProbe[] = [
      {
        provider: "claude",
        group: "relay",
        status: "reachable",
        last_failure_at: f.at(9),
      },
    ];
    const activity = { "A-3": { working_at: at } };
    expect(f.diagnosis(1, probes, activity).action).toBe(action);
    expect(
      f
        .record(probes, activity)
        .events.some((e) => e.type === "upstream_recovery_ready"),
    ).toBe(action === "restart_once");
  },
);

test("latest structured line failure supersedes older recovery evidence and survives sample loss/reload", () => {
  const f = scenario();
  for (const n of [1, 2, 3]) f.inactive(n);
  f.record();
  f.advance(13);
  const witnessAt = (at: string) =>
    f.replace({
      ...f.state(),
      assignments: f
        .state()
        .assignments.map((a) =>
          a.id === "A-3" ? { ...a, last_mcp_activity_at: at } : a,
        ),
    });
  witnessAt(f.at(11));
  const failure: SessionActivity = {
    "A-1": { error: "stream_disconnected", at: "2026-01-01T08:12:00+08:00" },
  };
  expect(f.diagnosis(1, [], failure).action).toBe("wait");
  expect(
    f
      .record([], failure)
      .events.some((e) => e.type === "upstream_recovery_ready"),
  ).toBe(false);
  expect(f.record([], failure).events).toEqual([]);
  f.replace(JSON.parse(JSON.stringify(f.state())) as CommandState);
  expect(f.diagnosis(1, []).action).toBe("wait");
  expect(
    f.record([]).events.some((e) => e.type === "upstream_recovery_ready"),
  ).toBe(false);
  witnessAt("2026-01-01T00:12:00.000Z");
  expect(f.diagnosis(1, [], failure).action).toBe("wait");
  witnessAt("2026-01-01T00:12:00.001Z");
  expect(f.diagnosis(1, [], failure).action).toBe("restart_once");
  expect(
    f
      .record([], failure)
      .events.some((e) => e.type === "upstream_recovery_ready"),
  ).toBe(true);
});

test("incident resolution uses the same persisted error boundary and isolates other lines", () => {
  const f = scenario();
  for (const n of [1, 2, 3]) f.inactive(n);
  f.record();
  f.advance(13);
  f.record([], { "A-1": { error: "server_error", at: f.at(12) } });
  const progress = (at: string): SessionActivity =>
    Object.fromEntries(
      f.targets.map((t) => [t.assignment_id, { working_at: at }]),
    );
  f.record([], progress(f.at(11)));
  expect(upstreamIncident(f.state(), "relay")).toBeDefined();
  f.fact("upstream_harness_failed", {
    group: "other-line",
    last_failure_at: f.at(13),
    failure: "rate_limit",
  });
  f.record([], progress("2026-01-01T00:12:00.001Z"));
  expect(upstreamIncident(f.state(), "relay")).toBeUndefined();
});

test("current errors outside the target line cannot delay recovery", () => {
  const f = scenario();
  for (const n of [1, 2, 3]) f.inactive(n);
  f.record();
  f.advance(13);
  f.replace({
    ...f.state(),
    assignments: f
      .state()
      .assignments.map((a) =>
        a.id === "A-3" ? { ...a, last_mcp_activity_at: f.at(11) } : a,
      ),
  });
  const foreign = {
    assignment_id: id("assignment", 4),
    provider: "direct",
    group: "other-line",
  };
  const activity: SessionActivity = {
    [foreign.assignment_id]: { error: "rate_limit", at: f.at(12) },
  };
  expect(
    diagnoseUpstream(
      f.state(),
      required(f.targets[0]),
      [...f.targets, foreign],
      [],
      DEFAULT_UPSTREAM_POLICY,
      f.at(13),
      activity,
    ).action,
  ).toBe("restart_once");
});
