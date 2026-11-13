import type { CommandState } from "./commands/core.js";
import { lastRunActivity } from "./commands/inactive-run.js";
import type { Event } from "./entities.js";
import type { AssignmentId, EventId } from "./ids.js";

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
  Record<string, "working" | "idle" | "unknown">
>;
const fields = (e: Event) => e.payload as Record<string, unknown>;
const unfinished = (status: string) =>
  !["completed", "failed", "cancelled"].includes(status);
export function hasUnfinishedUpstreamRun(
  state: CommandState,
  id: AssignmentId,
) {
  return state.runs.some((r) => r.assignment_id === id && unfinished(r.status));
}
export function upstreamIncident(
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
export function lastUpstreamInactivity(
  state: CommandState,
  id: AssignmentId,
): Event | undefined {
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
export function upstreamActivityAfter(
  state: CommandState,
  id: AssignmentId,
  since: string,
) {
  const a = state.assignments.find((a) => a.id === id);
  if (a?.status !== "active") return false;
  return [
    a.last_mcp_activity_at,
    ...state.runs
      .filter((r) => r.assignment_id === id)
      .flatMap((r) => [r.started_at, r.heartbeat_at]),
  ].some((at) => at && at > since);
}
export function recurrentUpstreamFailure(
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

/** Recovery evidence must postdate the most recent known connection failure. */
export function upstreamRecoverySince(
  incident: UpstreamIncident,
  probes: readonly UpstreamProbe[],
) {
  return probes
    .filter((p) => p.group === incident.group && p.last_failure_at)
    .reduce(
      (at, p) =>
        p.last_failure_at && p.last_failure_at > at ? p.last_failure_at : at,
      incident.started_at,
    );
}
/** Count distinct Assignments in a sliding event-time window, never just MCP silence. */
export function upstreamCluster(
  state: CommandState,
  targets: readonly UpstreamTarget[],
  policy: UpstreamPolicy,
  activity: SessionActivity,
) {
  const events = targets
    .filter((t) => activity[t.assignment_id] !== "working")
    .flatMap((t) => {
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
  const base = { ...target };
  const group = targets.filter((t) => t.group === target.group);
  const incident = upstreamIncident(state, target.group);
  const recurrent =
    activity[target.assignment_id] === "working"
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
  const clustered = upstreamCluster(state, group, policy, activity);
  const unavailable = failed.length > 0 || clustered.length > 0 || incident;
  if (unavailable) {
    const evidence = [
      ...(failed.length ? ["connection_probe_failed"] : []),
      ...(clustered.length ? ["clustered_inactivity"] : []),
    ];
    const recovered =
      incident &&
      group.some((t) =>
        upstreamActivityAfter(
          state,
          t.assignment_id,
          upstreamRecoverySince(incident, probes),
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
        ready && activity[target.assignment_id] !== "working"
          ? "restart_once"
          : "wait",
      evidence: [
        ...evidence,
        ...(activity[target.assignment_id] === "working"
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
  if (activity[target.assignment_id] === "working")
    return {
      ...base,
      cause: "agent_busy",
      action: "none",
      evidence: ["harness_working"],
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
    group.filter(
      (t) =>
        activity[t.assignment_id] !== "working" &&
        lastUpstreamInactivity(state, t.assignment_id),
    ).length > 1
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
