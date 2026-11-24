import { expect, test } from "vitest";
import type { CommandState } from "./commands/core.js";
import { lastRunActivity } from "./commands/inactive-run.js";
import {
  assignment,
  fixture,
  id,
  ports,
  run,
} from "./commands/test-fixtures.js";
import { recordUpstreamHealth } from "./commands/upstream-health.js";
import type { Event } from "./entities.js";
import type { AssignmentId, EventId } from "./ids.js";
import * as indexed from "./upstream-health.js";
import {
  DEFAULT_UPSTREAM_POLICY,
  type SessionActivity,
  sessionIsWorking,
  sessionUpstreamError,
  type UpstreamIncident,
  type UpstreamPolicy,
  type UpstreamProbe,
  type UpstreamTarget,
} from "./upstream-health.js";

// Frozen linear oracle from b4d1e1b90f4f1f953839f130a85c48d37c53a66e.
// Keep its array predicates independent of the production snapshot implementation.
const fields = (e: Event) => e.payload as Record<string, unknown>;
const unfinished = (status: string) =>
  !["completed", "failed", "cancelled"].includes(status);
function hasUnfinishedUpstreamRun(state: CommandState, id: AssignmentId) {
  return state.runs.some((r) => r.assignment_id === id && unfinished(r.status));
}
function upstreamIncident(
  state: Pick<CommandState, "events">,
  group: string,
): UpstreamIncident | undefined {
  const start = state.events.findLast(
    (e) => e.type === "upstream_incident_started" && fields(e).group === group,
  );
  if (
    !start ||
    state.events.some(
      (e) =>
        e.type === "upstream_incident_resolved" &&
        fields(e).incident_id === start.id,
    )
  )
    return;
  const ids = new Set(fields(start).assignment_ids as AssignmentId[]);
  for (const e of state.events)
    if (
      e.type === "upstream_incident_expanded" &&
      fields(e).incident_id === start.id
    )
      for (const id of fields(e).assignment_ids as AssignmentId[]) ids.add(id);
  return {
    id: start.id,
    group,
    started_at: start.created_at,
    assignment_ids: [...ids],
  };
}
function lastUpstreamInactivity(
  state: CommandState,
  id: AssignmentId,
  activity: SessionActivity = {},
): Event | undefined {
  if (sessionIsWorking(activity[id])) return;
  const a = state.assignments.find((a) => a.id === id);
  if (a?.status !== "active" || a.external) return;
  return state.events.findLast((e) => {
    if (
      !["run_inactive", "run_dispatch_stalled"].includes(e.type) ||
      fields(e).assignment_id !== id
    )
      return false;
    const run = state.runs.find(
      (r) => r.id === fields(e).run_id && r.assignment_id === id,
    );
    return (
      run &&
      unfinished(run.status) &&
      Math.max(
        Date.parse(a.last_mcp_activity_at ?? "") || 0,
        Date.parse(run.started_at ?? "") || 0,
        Date.parse(run.heartbeat_at ?? "") || 0,
      ) <= Date.parse(e.created_at)
    );
  });
}
function upstreamActivityAfter(
  state: CommandState,
  id: AssignmentId,
  since: string,
  activity: SessionActivity = {},
) {
  const a = state.assignments.find((a) => a.id === id);
  if (a?.status !== "active") return false;
  const sample = activity[id];
  return [
    typeof sample === "object" && "working_at" in sample
      ? sample.working_at
      : undefined,
    a.last_mcp_activity_at,
    ...state.runs
      .filter((r) => r.assignment_id === id)
      .flatMap((r) => [r.started_at, r.heartbeat_at]),
  ].some((at) => at && Date.parse(at) > Date.parse(since));
}
function recurrentUpstreamFailure(
  state: CommandState,
  id: AssignmentId,
  policy: UpstreamPolicy,
) {
  const inactive = lastUpstreamInactivity(state, id);
  if (!inactive) return;
  const assignment = state.assignments.find((a) => a.id === id);
  const run = state.runs.find(
    (r) => r.id === fields(inactive).run_id && r.assignment_id === id,
  );
  if (!assignment || !run) return;
  // The watchdog reports silence after its grace period. Recurrence is about
  // when that silence began, not when the delayed alert was emitted.
  const inactiveSince =
    inactive.type === "run_inactive"
      ? lastRunActivity(run, assignment)
      : Date.parse(inactive.created_at);
  return state.events.findLast((e) => {
    if (
      e.type !== "host_ops_action_finished" ||
      fields(e).assignment_id !== id ||
      String(fields(e).result).startsWith("withdrawn_")
    )
      return false;
    const request = state.events.find(
      (taken) => taken.id === fields(e).action_id,
    );
    if (
      !request ||
      fields(request).context_usage ||
      fields(request).tool === "host_ops_cancel_run"
    )
      return false;
    const elapsed = inactiveSince - Date.parse(e.created_at);
    return elapsed >= 0 && elapsed <= policy.recurrence_window_ms;
  });
}
function serverFailureFor(state: CommandState, inactive: Event) {
  const assignment = state.assignments.find(
    (a) => a.id === fields(inactive).assignment_id,
  );
  const run = state.runs.find(
    (r) =>
      r.id === fields(inactive).run_id && r.assignment_id === assignment?.id,
  );
  if (!assignment || !run) return;
  const lastActivity = lastRunActivity(run, assignment);
  return state.events.findLast(
    (e) =>
      ["bell_delivery_failed", "bell_delivery_attempt_failed"].includes(
        e.type,
      ) &&
      fields(e).assignment_id === fields(inactive).assignment_id &&
      fields(e).run_id === fields(inactive).run_id &&
      Date.parse(e.created_at) >= lastActivity &&
      Date.parse(e.created_at) <= Date.parse(inactive.created_at) &&
      ["before_wake_failed", "wake_failed", "delivery_call_failed"].includes(
        String(fields(e).reason),
      ),
  );
}

/** Latest explicit error on the caller-selected line, never an error message. */
function latestHarnessFailure(
  targets: readonly UpstreamTarget[],
  activity: SessionActivity,
) {
  return targets
    .flatMap((target) => {
      const error = sessionUpstreamError(activity[target.assignment_id]);
      return error && Number.isFinite(Date.parse(error.at))
        ? [{ ...error, assignment_id: target.assignment_id }]
        : [];
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
}

/** Recovery must postdate every known failure, including errors whose samples have expired. */
function upstreamRecoverySince(
  incident: UpstreamIncident,
  probes: readonly UpstreamProbe[],
  targets: readonly UpstreamTarget[] = [],
  activity: SessionActivity = {},
  events: readonly Event[] = [],
) {
  const error = latestHarnessFailure(
    targets.filter((t) => t.group === incident.group),
    activity,
  );
  const failures = [
    ...probes
      .filter((p) => p.group === incident.group)
      .map((p) => p.last_failure_at),
    error?.at,
    ...events
      .filter(
        (e) =>
          e.type === "upstream_harness_failed" &&
          fields(e).group === incident.group,
      )
      .map((e) => fields(e).last_failure_at),
  ].flatMap((at) =>
    typeof at === "string" && Number.isFinite(Date.parse(at))
      ? [Date.parse(at)]
      : [],
  );
  const latest = Math.max(Date.parse(incident.started_at), ...failures);
  return Number.isFinite(latest)
    ? new Date(latest).toISOString()
    : incident.started_at;
}
/** Count distinct Assignments in a sliding event-time window, never just MCP silence. */
function upstreamCluster(
  state: CommandState,
  targets: readonly UpstreamTarget[],
  policy: UpstreamPolicy,
  activity: SessionActivity,
) {
  const events = targets
    .filter((t) => !sessionIsWorking(activity[t.assignment_id]))
    .flatMap((t) => {
      const sample = sessionUpstreamError(activity[t.assignment_id]);
      if (sample) return [{ id: t.assignment_id, at: Date.parse(sample.at) }];
      const e = lastUpstreamInactivity(state, t.assignment_id);
      return e && !serverFailureFor(state, e)
        ? [{ id: t.assignment_id, at: Date.parse(e.created_at) }]
        : [];
    })
    .sort((a, b) => a.at - b.at);
  for (const e of events) {
    const cluster = events.filter(
      (other) =>
        other.at >= e.at && other.at - e.at <= policy.inactivity_window_ms,
    );
    if (cluster.length >= policy.inactive_session_count)
      return cluster.map((x) => x.id);
  }
  return [];
}
type UpstreamCause =
  | "upstream_unreachable"
  | "upstream_suspected"
  | "agent_busy"
  | "agent_stalled"
  | "server_problem"
  | "unknown"
  | "healthy";
interface UpstreamDiagnosis {
  readonly assignment_id: AssignmentId;
  readonly provider: string;
  readonly group: string;
  readonly cause: UpstreamCause;
  readonly action: "wait" | "restart_once" | "human" | "none";
  readonly evidence: readonly string[];
  readonly incident_id?: EventId;
}
function diagnoseUpstream(
  state: CommandState,
  target: UpstreamTarget,
  targets: readonly UpstreamTarget[],
  probes: readonly UpstreamProbe[],
  policy: UpstreamPolicy,
  now: string,
  activity: SessionActivity = {},
  ignoreAction?: EventId,
): UpstreamDiagnosis {
  return diagnoseUpstreamWithMemo(
    state,
    target,
    targets,
    probes,
    policy,
    now,
    activity,
    ignoreAction,
  );
}

/** One snapshot-scoped analysis, with no cache crossing revisions or observations. */
function diagnoseUpstreams(
  state: CommandState,
  targets: readonly UpstreamTarget[],
  probes: readonly UpstreamProbe[],
  policy: UpstreamPolicy,
  now: string,
  activity: SessionActivity = {},
): UpstreamDiagnosis[] {
  const cache = new Map<string, unknown>();
  const memo = <T>(key: string, build: () => T): T => {
    if (!cache.has(key)) cache.set(key, build());
    return cache.get(key) as T;
  };
  return targets.map((target) =>
    diagnoseUpstreamWithMemo(
      state,
      target,
      targets,
      probes,
      policy,
      now,
      activity,
      undefined,
      memo,
    ),
  );
}

function diagnoseUpstreamWithMemo(
  state: CommandState,
  target: UpstreamTarget,
  targets: readonly UpstreamTarget[],
  probes: readonly UpstreamProbe[],
  policy: UpstreamPolicy,
  now: string,
  activity: SessionActivity,
  ignoreAction?: EventId,
  memo: <T>(key: string, build: () => T) => T = (_key, build) => build(),
): UpstreamDiagnosis {
  const base = { ...target };
  const group = memo(`group:${target.group}`, () =>
    targets.filter((t) => t.group === target.group),
  );
  const incident = memo(`incident:${target.group}`, () =>
    upstreamIncident(state, target.group),
  );
  const recurrent = sessionIsWorking(activity[target.assignment_id])
    ? undefined
    : recurrentUpstreamFailure(state, target.assignment_id, policy);
  if (recurrent)
    return {
      ...base,
      cause: "upstream_suspected",
      action: "human",
      evidence: ["recurrence_after_recovery", recurrent.id],
    };
  const failed = probes.filter(
    (p) => p.group === target.group && p.status === "unreachable",
  );
  const clustered = memo(`cluster:${target.group}`, () =>
    upstreamCluster(state, group, policy, activity),
  );
  const unavailable = failed.length > 0 || clustered.length > 0 || incident;
  if (unavailable) {
    const evidence = [
      ...(failed.length ? ["connection_probe_failed"] : []),
      ...(clustered.length ? ["clustered_inactivity"] : []),
    ];
    const recovered = memo(
      `recovered:${target.group}`,
      () =>
        incident &&
        group.some((t) =>
          upstreamActivityAfter(
            state,
            t.assignment_id,
            upstreamRecoverySince(
              incident,
              probes,
              group,
              activity,
              state.events,
            ),
            activity,
          ),
        ),
    );
    const used =
      incident &&
      state.events.find(
        (e) =>
          e.type === "host_ops_action_taken" &&
          e.id !== ignoreAction &&
          fields(e).assignment_id === target.assignment_id &&
          fields(e).upstream_incident_id === incident.id,
      );
    const ready =
      !failed.length &&
      incident &&
      recovered &&
      lastUpstreamInactivity(state, target.assignment_id) &&
      Date.parse(now) - Date.parse(incident.started_at) >=
        policy.inactivity_window_ms &&
      !used;
    return {
      ...base,
      cause: failed.length ? "upstream_unreachable" : "upstream_suspected",
      action:
        ready && !sessionIsWorking(activity[target.assignment_id])
          ? "restart_once"
          : "wait",
      evidence: [
        ...evidence,
        ...(sessionIsWorking(activity[target.assignment_id])
          ? ["harness_working"]
          : []),
        ...(recovered
          ? ["activity_recovered"]
          : ["awaiting_activity_recovery"]),
        ...(used ? ["recovery_already_requested"] : []),
      ],
      ...(incident ? { incident_id: incident.id } : {}),
    };
  }
  if (sessionIsWorking(activity[target.assignment_id]))
    return {
      ...base,
      cause: "agent_busy",
      action: "none",
      evidence: ["harness_working"],
    };
  const sample = sessionUpstreamError(activity[target.assignment_id]);
  if (sample)
    return {
      ...base,
      cause: "upstream_suspected",
      action: "wait",
      evidence: ["harness_upstream_error", sample.error],
    };
  const inactive = lastUpstreamInactivity(state, target.assignment_id);
  if (!inactive)
    return { ...base, cause: "healthy", action: "none", evidence: [] };
  // Structured source, never error text: a server/Git/wake failure is not an API failure.
  const serverFailure = serverFailureFor(state, inactive);
  if (serverFailure)
    return {
      ...base,
      cause: "server_problem",
      action: "wait",
      evidence: [serverFailure.type, String(fields(serverFailure).reason)],
    };
  const reachable = probes.some(
    (p) => p.provider === target.provider && p.status === "reachable",
  );
  if (
    memo(
      `inactive_count:${target.group}`,
      () =>
        group.filter(
          (t) =>
            !sessionIsWorking(activity[t.assignment_id]) &&
            lastUpstreamInactivity(state, t.assignment_id),
        ).length,
    ) > 1
  )
    return {
      ...base,
      cause: "unknown",
      action: "wait",
      evidence: ["multiple_inactive_sessions_require_investigation"],
    };
  if (activity[target.assignment_id] === "idle")
    return {
      ...base,
      cause: reachable ? "agent_stalled" : "unknown",
      action: "restart_once",
      evidence: [
        "single_session_inactive",
        "harness_idle",
        ...(reachable
          ? ["connection_probe_passed"]
          : ["line_unknown_v3_fallback"]),
      ],
    };
  return {
    ...base,
    cause: "unknown",
    action: "wait",
    evidence: ["mcp_inactivity_is_not_proof_of_stall"],
  };
}

const at = (minutes: number) =>
  new Date(Date.parse("2026-01-01T00:00:00Z") + minutes * 60_000).toISOString();
function observations() {
  const state: CommandState = {
    ...fixture(),
    assignments: [assignment(1), assignment(2), assignment(3)],
    runs: [run(1), run(2), run(3)],
    events: [],
  };
  const events: Event[] = [];
  const allocator = ports();
  const fact = (type: string, payload: Event["payload"], minute: number) => {
    const e: Event = {
      id: allocator.ids.nextEventId(),
      seq: 100 - events.length,
      actor: { kind: "system", project_id: state.project_id },
      type,
      payload,
      created_at: at(minute),
    };
    events.push(e);
    return e;
  };
  for (let n = 1; n <= 3; n++) {
    const taken = fact(
      "host_ops_action_taken",
      {
        assignment_id: id("assignment", n),
        tool: "host_ops_restart_assignment",
      },
      -2,
    );
    fact(
      "host_ops_action_finished",
      {
        assignment_id: id("assignment", n),
        action_id: taken.id,
        result: "restarted",
      },
      -1,
    );
    fact(
      "run_inactive",
      { assignment_id: id("assignment", n), run_id: id("run", n) },
      10,
    );
    fact(
      "run_dispatch_stalled",
      { assignment_id: id("assignment", n), run_id: id("run", n) },
      5,
    );
    fact(
      "run_inactive",
      { assignment_id: id("assignment", n), run_id: "R-missing" },
      20,
    );
  }
  const incident = fact(
    "upstream_incident_started",
    {
      group: "relay",
      assignment_ids: [id("assignment", 2), id("assignment", 1)],
    },
    -20,
  );
  fact(
    "upstream_incident_expanded",
    {
      incident_id: incident.id,
      assignment_ids: [id("assignment", 1), id("assignment", 3)],
    },
    -10,
  );
  fact(
    "upstream_harness_failed",
    { group: "relay", last_failure_at: at(2) },
    2,
  );
  fact(
    "bell_delivery_failed",
    {
      assignment_id: id("assignment", 2),
      run_id: id("run", 2),
      reason: "wake_failed",
    },
    3,
  );
  return { ...state, events };
}
const targets: UpstreamTarget[] = [3, 1, 2].map((n) => ({
  assignment_id: id("assignment", n),
  provider: "relay",
  group: "relay",
}));
const base = observations();
const firstAssignment = base.assignments[0];
const firstRun = base.runs[0];
if (!firstAssignment || !firstRun) throw new Error("Missing fixture");
const variants: Record<string, CommandState> = {
  ordered: base,
  external: {
    ...base,
    assignments: [
      { ...firstAssignment, external: true },
      ...base.assignments.slice(1),
    ],
  },
  released: {
    ...base,
    assignments: [
      { ...firstAssignment, status: "released" },
      ...base.assignments.slice(1),
    ],
  },
  ended: {
    ...base,
    runs: base.runs.map((r) => ({ ...r, status: "completed" })),
  },
  heartbeat_newer: {
    ...base,
    runs: [{ ...firstRun, heartbeat_at: at(11) }, ...base.runs.slice(1)],
  },
  heartbeat_equal: {
    ...base,
    runs: [{ ...firstRun, heartbeat_at: at(5) }, ...base.runs.slice(1)],
  },
  mcp_newer: {
    ...base,
    assignments: [
      { ...firstAssignment, last_mcp_activity_at: at(11) },
      ...base.assignments.slice(1),
    ],
  },
  duplicate_run_first_ended: {
    ...base,
    runs: [{ ...firstRun, status: "failed" }, ...base.runs],
  },
  duplicate_run_first_running: {
    ...base,
    runs: [...base.runs, { ...firstRun, status: "failed" }],
  },
  duplicate_run_other_assignment: {
    ...base,
    runs: [
      { ...firstRun, assignment_id: id("assignment", 2), status: "failed" },
      ...base.runs,
    ],
  },
  duplicate_assignment: {
    ...base,
    assignments: [{ ...firstAssignment, external: true }, ...base.assignments],
  },
  duplicate_request: {
    ...base,
    events: base.events.flatMap((e) =>
      e.type === "host_ops_action_taken"
        ? [
            {
              ...e,
              payload: {
                ...(e.payload as Record<string, string>),
                tool: "host_ops_cancel_run",
              },
            },
            e,
          ]
        : [e],
    ),
  },
  withdrawn_recovery: {
    ...base,
    events: base.events.map((e) =>
      e.type === "host_ops_action_finished"
        ? {
            ...e,
            payload: {
              ...(e.payload as Record<string, string>),
              result: "withdrawn_recovered",
            },
          }
        : e,
    ),
  },
  context_recovery: {
    ...base,
    events: base.events.map((e) =>
      e.type === "host_ops_action_taken"
        ? {
            ...e,
            payload: {
              ...(e.payload as Record<string, string>),
              context_usage: true,
            },
          }
        : e,
    ),
  },
  unknown_run_status: {
    ...base,
    runs: base.runs.map((r) => ({ ...r, status: "queued" })),
  },
  no_recovery: {
    ...base,
    events: base.events.filter((e) => !e.type.startsWith("host_ops_")),
  },
  no_incident: {
    ...base,
    events: base.events.filter(
      (e) => !e.type.startsWith("upstream_") && !e.type.startsWith("host_ops_"),
    ),
  },
  healthy_no_events: { ...base, events: [] },
  resolved_incident: {
    ...base,
    events: [
      ...base.events,
      {
        ...(base.events[0] as Event),
        type: "upstream_incident_resolved",
        payload: {
          incident_id:
            base.events.find((e) => e.type === "upstream_incident_started")
              ?.id ?? "missing",
        },
      },
    ],
  },
  missing_run: { ...base, runs: [] },
  missing_assignment: { ...base, assignments: [] },
  reverse_events: { ...base, events: [...base.events].reverse() },
  invalid_times: {
    ...base,
    runs: base.runs.map((r) => ({
      ...r,
      started_at: "unknown",
      heartbeat_at: "unknown",
    })),
  },
};
for (const [name, state] of Object.entries(variants)) {
  test(`snapshot queries and every diagnosis equal linear baseline: ${name}`, () => {
    const analysis = indexed.createUpstreamHealthAnalysis(state);
    for (const activity of [
      {},
      { "A-1": "working" },
      { "A-1": { working_at: at(12) } },
      { "A-1": "unknown", "A-2": "unknown", "A-3": "unknown" },
      { "A-1": "idle" },
      { "A-1": { error: "server_error", at: at(4) } },
    ] satisfies SessionActivity[]) {
      for (const target of targets) {
        const aid = target.assignment_id;
        expect(analysis.inactivity(aid, activity)).toEqual(
          lastUpstreamInactivity(state, aid, activity),
        );
        expect(analysis.hasUnfinishedRun(aid)).toEqual(
          hasUnfinishedUpstreamRun(state, aid),
        );
        expect(analysis.recurrence(aid, DEFAULT_UPSTREAM_POLICY)).toEqual(
          recurrentUpstreamFailure(state, aid, DEFAULT_UPSTREAM_POLICY),
        );
        for (const since of [at(0), at(5), at(10), "invalid"])
          expect(analysis.activityAfter(aid, since, activity)).toEqual(
            upstreamActivityAfter(state, aid, since, activity),
          );
      }
      expect(analysis.incident("relay")).toEqual(
        upstreamIncident(state, "relay"),
      );
      expect(
        analysis.cluster(targets, DEFAULT_UPSTREAM_POLICY, activity),
      ).toEqual(
        upstreamCluster(state, targets, DEFAULT_UPSTREAM_POLICY, activity),
      );
      for (const status of ["reachable", "unreachable", "unknown"] as const) {
        const probes: UpstreamProbe[] = [
          {
            provider: "relay",
            group: "relay",
            status,
            checked_at: at(25),
            last_failure_at: at(2),
          },
        ];
        expect(
          targets.map((target) =>
            diagnoseUpstream(
              state,
              target,
              targets,
              probes,
              DEFAULT_UPSTREAM_POLICY,
              at(25),
              activity,
            ),
          ),
        ).toEqual(
          diagnoseUpstreams(
            state,
            targets,
            probes,
            DEFAULT_UPSTREAM_POLICY,
            at(25),
            activity,
          ),
        );
        const legacy = diagnoseUpstreams(
          state,
          targets,
          probes,
          DEFAULT_UPSTREAM_POLICY,
          at(25),
          activity,
        );
        expect(
          indexed.diagnoseUpstreams(
            state,
            targets,
            probes,
            DEFAULT_UPSTREAM_POLICY,
            at(25),
            activity,
          ),
        ).toEqual(legacy);
        expect(
          targets.map((target) =>
            indexed.diagnoseUpstream(
              state,
              target,
              targets,
              probes,
              DEFAULT_UPSTREAM_POLICY,
              at(25),
              activity,
            ),
          ),
        ).toEqual(legacy);
      }
    }
  });
}
function counted<T>(items: readonly T[]) {
  let iterations = 0;
  const collection = new Proxy(items, {
    get(target, key, receiver) {
      if (key === Symbol.iterator)
        return function* () {
          iterations++;
          yield* target;
        };
      return Reflect.get(target, key, receiver);
    },
  });
  return { collection, count: () => iterations };
}
test("one record builds each index only once and later calls re-read mutated snapshots", () => {
  const events = counted(base.events),
    runs = counted(base.runs),
    assignments = counted(base.assignments);
  const state = {
    ...base,
    events: events.collection,
    runs: runs.collection,
    assignments: assignments.collection,
  };
  const result = recordUpstreamHealth(
    state,
    { kind: "system", project_id: state.project_id },
    { targets, activity: {}, probes: [], policy: DEFAULT_UPSTREAM_POLICY },
    ports(),
  );
  expect(result.ok).toBe(true);
  expect({
    events: events.count(),
    runs: runs.count(),
    assignments: assignments.count(),
    // C-670: the type and ID indexes are each built once per events array.
  }).toEqual({ events: 2, runs: 1, assignments: 1 });
  // A later record on the same immutable history reuses them: no new scan.
  expect(
    recordUpstreamHealth(
      state,
      { kind: "system", project_id: state.project_id },
      { targets, activity: {}, probes: [], policy: DEFAULT_UPSTREAM_POLICY },
      ports(),
    ).ok,
  ).toBe(true);
  expect(events.count()).toBe(2);
  const before = indexed.lastUpstreamInactivity(state, id("assignment", 1));
  expect(before).toBeDefined();
  const mutable = { ...base, runs: [...base.runs] };
  expect(indexed.lastUpstreamInactivity(mutable, id("assignment", 1))).toEqual(
    before,
  );
  mutable.runs.splice(0, 1, { ...firstRun, heartbeat_at: at(30) });
  expect(
    indexed.lastUpstreamInactivity(mutable, id("assignment", 1)),
  ).toBeUndefined();
  expect(indexed.lastUpstreamInactivity(base, id("assignment", 1))).toEqual(
    before,
  );
  expect(
    indexed.lastUpstreamInactivity(
      { ...mutable, project_id: "other-project" },
      id("assignment", 1),
    ),
  ).toBeUndefined();
});
