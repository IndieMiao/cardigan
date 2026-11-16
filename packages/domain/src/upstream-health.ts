import type { CommandState } from "./commands/core.js";
import { lastRunActivity } from "./commands/inactive-run.js";
import type { Event } from "./entities.js";
import type { AssignmentId, EventId } from "./ids.js";
import { UpstreamHealthSnapshot } from "./upstream-health-snapshot.js";

export interface UpstreamPolicy {
  readonly inactive_session_count: number;
  readonly inactivity_window_ms: number;
  readonly recurrence_window_ms: number;
}
export const DEFAULT_UPSTREAM_POLICY: UpstreamPolicy = {
  inactive_session_count: 3,
  inactivity_window_ms: 600_000,
  recurrence_window_ms: 900_000,
};
export interface UpstreamTarget {
  readonly assignment_id: AssignmentId;
  readonly provider: string;
  readonly group: string;
}
export interface UpstreamProbe {
  readonly provider: string;
  readonly group: string;
  readonly status: "reachable" | "unreachable" | "unknown";
  readonly checked_at?: string;
  readonly last_failure_at?: string;
  readonly failure?: "connection_error" | "tls_error" | "timeout";
}
export interface UpstreamIncident {
  readonly id: EventId;
  readonly group: string;
  readonly started_at: string;
  readonly assignment_ids: readonly AssignmentId[];
}
export type SessionActivity = Readonly<
  Record<
    string,
    | "working"
    | "idle"
    | "unknown"
    | { readonly working_at: string }
    | {
        readonly error: "rate_limit" | "server_error" | "stream_disconnected";
        readonly at: string;
      }
  >
>;
export function sessionIsWorking(sample: SessionActivity[string] | undefined) {
  return (
    sample === "working" ||
    (typeof sample === "object" && "working_at" in sample)
  );
}
export function sessionUpstreamError(
  sample: SessionActivity[string] | undefined,
) {
  return typeof sample === "object" && "error" in sample ? sample : undefined;
}
const fields = (e: Event) => e.payload as Record<string, unknown>;
const unfinished = (status: string) =>
  !["completed", "failed", "cancelled"].includes(status);
function hasUnfinishedUpstreamRunFromSnapshot(
  snapshot: UpstreamHealthSnapshot,
  id: AssignmentId,
) {
  return snapshot.runsFor(id).some((r) => unfinished(r.status));
}
function upstreamIncidentFromSnapshot(
  snapshot: UpstreamHealthSnapshot,
  group: string,
): UpstreamIncident | undefined {
  const start = snapshot.matching("upstream_incident_started", group).at(-1);
  if (
    !start ||
    snapshot.matching("upstream_incident_resolved", start.id).length > 0
  )
    return;
  const ids = new Set(fields(start).assignment_ids as AssignmentId[]);
  for (const e of snapshot.matching("upstream_incident_expanded", start.id))
    for (const id of fields(e).assignment_ids as AssignmentId[]) ids.add(id);
  return {
    id: start.id,
    group,
    started_at: start.created_at,
    assignment_ids: [...ids],
  };
}
function lastUpstreamInactivityFromSnapshot(
  snapshot: UpstreamHealthSnapshot,
  id: AssignmentId,
  activity: SessionActivity = {},
): Event | undefined {
  if (sessionIsWorking(activity[id])) return;
  const a = snapshot.assignment(id);
  if (a?.status !== "active" || a.external) return;
  return snapshot
    .matching("run_inactive|run_dispatch_stalled", id)
    .findLast((e) => {
      const run = snapshot.run(id, fields(e).run_id);
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
function upstreamActivityAfterFromSnapshot(
  snapshot: UpstreamHealthSnapshot,
  id: AssignmentId,
  since: string,
  activity: SessionActivity = {},
) {
  const a = snapshot.assignment(id);
  if (a?.status !== "active") return false;
  const sample = activity[id];
  return [
    typeof sample === "object" && "working_at" in sample
      ? sample.working_at
      : undefined,
    a.last_mcp_activity_at,
    ...snapshot.runsFor(id).flatMap((r) => [r.started_at, r.heartbeat_at]),
  ].some((at) => at && Date.parse(at) > Date.parse(since));
}
function recurrentUpstreamFailureFromSnapshot(
  snapshot: UpstreamHealthSnapshot,
  id: AssignmentId,
  policy: UpstreamPolicy,
) {
  const inactive = lastUpstreamInactivityFromSnapshot(snapshot, id);
  if (!inactive) return;
  const assignment = snapshot.assignment(id);
  const run = snapshot.run(id, fields(inactive).run_id);
  if (!assignment || !run) return;
  // The watchdog reports silence after its grace period. Recurrence is about
  // when that silence began, not when the delayed alert was emitted.
  const inactiveSince =
    inactive.type === "run_inactive"
      ? lastRunActivity(run, assignment)
      : Date.parse(inactive.created_at);
  return snapshot.matching("host_ops_action_finished", id).findLast((e) => {
    if (String(fields(e).result).startsWith("withdrawn_")) return false;
    const request = snapshot.event(fields(e).action_id);
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
function serverFailureForFromSnapshot(
  snapshot: UpstreamHealthSnapshot,
  inactive: Event,
) {
  const assignment = snapshot.assignment(
    fields(inactive).assignment_id as AssignmentId,
  );
  const run =
    assignment && snapshot.run(assignment.id, fields(inactive).run_id);
  if (!assignment || !run) return;
  const lastActivity = lastRunActivity(run, assignment);
  return snapshot
    .matching(
      "bell_delivery_failed|bell_delivery_attempt_failed",
      fields(inactive).assignment_id,
    )
    .findLast(
      (e) =>
        fields(e).run_id === fields(inactive).run_id &&
        Date.parse(e.created_at) >= lastActivity &&
        Date.parse(e.created_at) <= Date.parse(inactive.created_at) &&
        ["before_wake_failed", "wake_failed", "delivery_call_failed"].includes(
          String(fields(e).reason),
        ),
    );
}

/** Latest explicit error on the caller-selected line, never an error message. */
export function latestHarnessFailure(
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
export function upstreamRecoverySince(
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
function upstreamClusterFromSnapshot(
  snapshot: UpstreamHealthSnapshot,
  targets: readonly UpstreamTarget[],
  policy: UpstreamPolicy,
  activity: SessionActivity,
) {
  const events = targets
    .filter((t) => !sessionIsWorking(activity[t.assignment_id]))
    .flatMap((t) => {
      const sample = sessionUpstreamError(activity[t.assignment_id]);
      if (sample) return [{ id: t.assignment_id, at: Date.parse(sample.at) }];
      const e = lastUpstreamInactivityFromSnapshot(snapshot, t.assignment_id);
      return e && !serverFailureForFromSnapshot(snapshot, e)
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
export type UpstreamCause =
  | "upstream_unreachable"
  | "upstream_suspected"
  | "agent_busy"
  | "agent_stalled"
  | "server_problem"
  | "unknown"
  | "healthy";
export interface UpstreamDiagnosis {
  readonly assignment_id: AssignmentId;
  readonly provider: string;
  readonly group: string;
  readonly cause: UpstreamCause;
  readonly action: "wait" | "restart_once" | "human" | "none";
  readonly evidence: readonly string[];
  readonly incident_id?: EventId;
}
export function diagnoseUpstream(
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
    target,
    targets,
    probes,
    policy,
    now,
    activity,
    ignoreAction,
    undefined,
    new UpstreamHealthSnapshot(state),
  );
}

/** One snapshot-scoped analysis, with no cache crossing revisions or observations. */
export function diagnoseUpstreams(
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
  const snapshot = new UpstreamHealthSnapshot(state);
  return targets.map((target) =>
    diagnoseUpstreamWithMemo(
      target,
      targets,
      probes,
      policy,
      now,
      activity,
      undefined,
      memo,
      snapshot,
    ),
  );
}

function diagnoseUpstreamWithMemo(
  target: UpstreamTarget,
  targets: readonly UpstreamTarget[],
  probes: readonly UpstreamProbe[],
  policy: UpstreamPolicy,
  now: string,
  activity: SessionActivity,
  ignoreAction: EventId | undefined,
  memo: <T>(key: string, build: () => T) => T = (_key, build) => build(),
  snapshot: UpstreamHealthSnapshot,
): UpstreamDiagnosis {
  const base = { ...target };
  const group = memo(`group:${target.group}`, () =>
    targets.filter((t) => t.group === target.group),
  );
  const incident = memo(`incident:${target.group}`, () =>
    upstreamIncidentFromSnapshot(snapshot, target.group),
  );
  const recurrent = sessionIsWorking(activity[target.assignment_id])
    ? undefined
    : recurrentUpstreamFailureFromSnapshot(
        snapshot,
        target.assignment_id,
        policy,
      );
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
    upstreamClusterFromSnapshot(snapshot, group, policy, activity),
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
          upstreamActivityAfterFromSnapshot(
            snapshot,
            t.assignment_id,
            upstreamRecoverySince(
              incident,
              probes,
              group,
              activity,
              snapshot.matching("upstream_harness_failed", target.group),
            ),
            activity,
          ),
        ),
    );
    const used =
      incident &&
      snapshot
        .matching("host_ops_action_taken", target.assignment_id)
        .find(
          (e) =>
            e.id !== ignoreAction &&
            fields(e).assignment_id === target.assignment_id &&
            fields(e).upstream_incident_id === incident.id,
        );
    const ready =
      !failed.length &&
      incident &&
      recovered &&
      lastUpstreamInactivityFromSnapshot(snapshot, target.assignment_id) &&
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
  const inactive = lastUpstreamInactivityFromSnapshot(
    snapshot,
    target.assignment_id,
  );
  if (!inactive)
    return { ...base, cause: "healthy", action: "none", evidence: [] };
  // Structured source, never error text: a server/Git/wake failure is not an API failure.
  const serverFailure = serverFailureForFromSnapshot(snapshot, inactive);
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
            lastUpstreamInactivityFromSnapshot(snapshot, t.assignment_id),
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

/** A fresh, invocation-owned analysis; callers must not retain it across observations. */
export function createUpstreamHealthAnalysis(state: CommandState) {
  const snapshot = new UpstreamHealthSnapshot(state);
  return {
    snapshot,
    hasUnfinishedRun: (id: AssignmentId) =>
      hasUnfinishedUpstreamRunFromSnapshot(snapshot, id),
    incident: (group: string) => upstreamIncidentFromSnapshot(snapshot, group),
    inactivity: (id: AssignmentId, activity: SessionActivity = {}) =>
      lastUpstreamInactivityFromSnapshot(snapshot, id, activity),
    activityAfter: (
      id: AssignmentId,
      since: string,
      activity: SessionActivity = {},
    ) => upstreamActivityAfterFromSnapshot(snapshot, id, since, activity),
    recurrence: (id: AssignmentId, policy: UpstreamPolicy) =>
      recurrentUpstreamFailureFromSnapshot(snapshot, id, policy),
    cluster: (
      targets: readonly UpstreamTarget[],
      policy: UpstreamPolicy,
      activity: SessionActivity,
    ) => upstreamClusterFromSnapshot(snapshot, targets, policy, activity),
  };
}
export function hasUnfinishedUpstreamRun(
  state: CommandState,
  id: AssignmentId,
) {
  return createUpstreamHealthAnalysis(state).hasUnfinishedRun(id);
}
export function upstreamIncident(
  state: Pick<CommandState, "events">,
  group: string,
) {
  // This query only reads events; no other collection is consulted.
  return upstreamIncidentFromSnapshot(new UpstreamHealthSnapshot(state), group);
}
export function lastUpstreamInactivity(
  state: CommandState,
  id: AssignmentId,
  activity: SessionActivity = {},
) {
  return createUpstreamHealthAnalysis(state).inactivity(id, activity);
}
export function upstreamActivityAfter(
  state: CommandState,
  id: AssignmentId,
  since: string,
  activity: SessionActivity = {},
) {
  return createUpstreamHealthAnalysis(state).activityAfter(id, since, activity);
}
export function recurrentUpstreamFailure(
  state: CommandState,
  id: AssignmentId,
  policy: UpstreamPolicy,
) {
  return createUpstreamHealthAnalysis(state).recurrence(id, policy);
}
export function upstreamCluster(
  state: CommandState,
  targets: readonly UpstreamTarget[],
  policy: UpstreamPolicy,
  activity: SessionActivity,
) {
  return createUpstreamHealthAnalysis(state).cluster(targets, policy, activity);
}
