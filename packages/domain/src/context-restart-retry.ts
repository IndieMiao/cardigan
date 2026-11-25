import type { Assignment, Event } from "./entities.js";
import { eventsOfType } from "./event-index.js";
import type { AssignmentId, HumanActionId } from "./ids.js";

/**
 * C-741: backoff before the system retries an automatic context restart that
 * a temporary condition held (2, 5 and 10 minutes). The host may configure
 * another list; one retry is scheduled per entry, then PM takes over.
 */
export const DEFAULT_CONTEXT_RESTART_RETRY_DELAYS_MS: readonly number[] = [
  2 * 60_000,
  5 * 60_000,
  10 * 60_000,
];

/** The result of an attempt that was held before any stop signal. */
export const CONTEXT_RESTART_RETRY_SCHEDULED = "retry_scheduled";

/**
 * Hold reasons that say nothing about the session itself: the upstream
 * diagnosis, its observation or the session's idle state was not available at
 * stop time. Anything else (launch failures, foreign terminals, preparation)
 * keeps the original single attempt.
 */
const TRANSIENT_REASONS: ReadonlySet<string> = new Set([
  "upstream_diagnosis_unavailable",
  "upstream_recovery_not_ready",
  "upstream_observation_failed",
  "upstream_configuration_changed",
  "session_state_unconfirmed",
  "agent_busy",
  "停止前会话、样本或空闲状态已改变",
  "停止前缺少当前会话的新鲜样本",
]);
export function transientContextRestartReason(reason: string) {
  return TRANSIENT_REASONS.has(reason);
}

interface RestartResultPayload {
  readonly action_id?: string;
  readonly assignment_id?: string;
  readonly result?: string;
  readonly retry_at?: string;
  readonly human_action_id?: string;
  readonly context_usage?: { readonly session_id?: string };
}

/** Automatic context restart attempts on this exact session. */
function sessionAttempts(
  events: readonly Event[],
  assignment: AssignmentId,
  session: string,
) {
  return eventsOfType(events, "host_ops_action_taken").filter((e) => {
    const p = e.payload as {
      assignment_id?: string;
      context_usage?: { session_id?: string };
    };
    return (
      p.assignment_id === assignment && p.context_usage?.session_id === session
    );
  });
}

/** Earlier attempts on this session that ended in a scheduled retry. */
export function contextRestartRetries(
  events: readonly Event[],
  assignment: AssignmentId,
  session: string,
) {
  return eventsOfType(events, "context_session_restart_result").filter((e) => {
    const p = e.payload as RestartResultPayload;
    return (
      p.result === CONTEXT_RESTART_RETRY_SCHEDULED &&
      p.assignment_id === assignment &&
      p.context_usage?.session_id === session
    );
  });
}

/**
 * - `fresh`: nothing was attempted on this session yet;
 * - `due`: every earlier attempt was held and its retry time has come;
 * - `waiting`: a retry is scheduled but not due yet;
 * - `closed`: an attempt is in flight, succeeded or failed for good.
 */
export function contextRestartRetryState(
  events: readonly Event[],
  assignment: AssignmentId,
  session: string,
  now: string,
): "fresh" | "due" | "waiting" | "closed" {
  const attempts = sessionAttempts(events, assignment, session);
  if (attempts.length === 0) return "fresh";
  const results = new Map(
    eventsOfType(events, "context_session_restart_result").map((e) => [
      (e.payload as RestartResultPayload).action_id,
      e.payload as RestartResultPayload,
    ]),
  );
  let retryAt = Number.NEGATIVE_INFINITY;
  for (const attempt of attempts) {
    const result = results.get(attempt.id);
    if (result?.result !== CONTEXT_RESTART_RETRY_SCHEDULED) return "closed";
    retryAt = Math.max(retryAt, Date.parse(result.retry_at ?? ""));
  }
  if (!Number.isFinite(retryAt)) return "closed";
  return Date.parse(now) >= retryAt ? "due" : "waiting";
}

/** The CLI command a human runs to give this standing session a fresh start. */
export function humanRestartCommand(
  a: Pick<Assignment, "role_id" | "scope"> & {
    readonly standing_mode?: string | undefined;
  },
  project?: string,
) {
  const scope = project ? ` --project ${project}` : "";
  if (a.scope !== "standing") return undefined;
  if (a.role_id === "host_ops") return `cardigan host-ops restart${scope}`;
  if (a.role_id !== "pm") return undefined;
  return a.standing_mode === "office"
    ? `cardigan pm restart --office${scope}`
    : a.standing_mode === "ops"
      ? `cardigan pm restart --ops${scope}`
      : `cardigan pm restart --ops${scope}（PM Office 用 --office）`;
}

/**
 * C-741: the failed automatic context restart a system human action asks to
 * recover, with the session that was meant to be replaced.
 */
export function contextRestartRecovery(
  events: readonly Event[],
  human_action_id: HumanActionId,
) {
  const result = eventsOfType(events, "context_session_restart_result").find(
    (e) => {
      const p = e.payload as RestartResultPayload;
      return (
        e.actor.kind === "system" &&
        p.result === "failed" &&
        p.human_action_id === human_action_id &&
        !!p.context_usage
      );
    },
  );
  if (!result) return undefined;
  const p = result.payload as RestartResultPayload;
  const intent = eventsOfType(events, "host_ops_action_taken").find(
    (e) => e.id === p.action_id,
  );
  if (!intent) return undefined;
  return {
    assignment_id: p.assignment_id as AssignmentId,
    runtime_ref: (intent.payload as { runtime_ref?: unknown }).runtime_ref,
  };
}

/** The old session is gone: released, paused, or another terminal is bound. */
export function contextSessionReplaced(
  assignments: readonly Assignment[],
  recovery: { assignment_id: AssignmentId; runtime_ref: unknown },
) {
  const a = assignments.find((a) => a.id === recovery.assignment_id);
  return (
    a?.status !== "active" ||
    JSON.stringify(a.runtime_ref ?? null) !==
      JSON.stringify(recovery.runtime_ref ?? null)
  );
}
