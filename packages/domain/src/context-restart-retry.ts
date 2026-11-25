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

/**
 * C-745: the reason a closed session may get one more automatic attempt —
 * its last attempt failed only because the upstream diagnosis itself was
 * unavailable, which says nothing about the line or the session.
 */
const DIAGNOSIS_UNAVAILABLE_REASONS: ReadonlySet<string> = new Set([
  "upstream_diagnosis_unavailable",
  "upstream_observation_failed",
]);

/**
 * C-745: why the upstream diagnosis was unavailable when a recovery or a
 * context restart was held: the project or provider-group classification had
 * failed (with the failure's start, count and error type when known), the
 * session's provider could not be resolved, or there was no diagnosis at all.
 */
// A type alias, not an interface, so it stays assignable to event JSON.
export type UpstreamHoldDetail = {
  readonly sub_reason:
    | "classification_failed"
    | "provider_not_resolved"
    | "no_diagnosis";
  readonly classification_failed_since?: string;
  readonly classification_failure_count?: number;
  readonly classification_error_type?: string;
};
const SUB_REASONS: ReadonlySet<string> = new Set([
  "classification_failed",
  "provider_not_resolved",
  "no_diagnosis",
]);
/** Copy only the known, bounded fields of a host-reported hold detail. */
export function upstreamHoldDetailPayload(
  detail: UpstreamHoldDetail | undefined,
): UpstreamHoldDetail | undefined {
  if (!detail || !SUB_REASONS.has(detail.sub_reason)) return undefined;
  const since = detail.classification_failed_since;
  const count = detail.classification_failure_count;
  const type = detail.classification_error_type;
  return {
    sub_reason: detail.sub_reason,
    ...(typeof since === "string" && Number.isFinite(Date.parse(since))
      ? { classification_failed_since: since }
      : {}),
    ...(Number.isSafeInteger(count) && (count as number) > 0
      ? { classification_failure_count: count as number }
      : {}),
    ...(typeof type === "string" && type.trim()
      ? { classification_error_type: type.trim().slice(0, 80) }
      : {}),
  };
}
/** A short human-readable suffix for the hold detail, empty without one. */
export function upstreamHoldDetailText(detail: UpstreamHoldDetail | undefined) {
  if (!detail) return "";
  const since = detail.classification_failed_since
    ? `，分类失败自 ${detail.classification_failed_since} 起`
    : "";
  const count = detail.classification_failure_count
    ? `，连续 ${detail.classification_failure_count} 次`
    : "";
  return `（${detail.sub_reason}${since}${count}）`;
}

interface RestartResultPayload {
  readonly action_id?: string;
  readonly assignment_id?: string;
  readonly result?: string;
  readonly reason?: string;
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

/** Any sign that this attempt may have signalled or settled its old session. */
function stopMayHaveStarted(events: readonly Event[], actionId: string) {
  return (
    eventsOfType(events, "host_ops_action_finished").some(
      (e) => (e.payload as { action_id?: string }).action_id === actionId,
    ) ||
    eventsOfType(events, "host_ops_action_deferred").some((e) => {
      const p = e.payload as { action_id?: string; reason?: string };
      return (
        p.action_id === actionId &&
        p.reason === "automatic_context_stop_started"
      );
    })
  );
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
 * - `recoverable` (C-745): the last attempt failed for good only because the
 *   upstream diagnosis was unavailable, and the session has not had its one
 *   extra attempt after the diagnosis recovered yet;
 * - `closed`: an attempt is in flight, succeeded or failed for good.
 */
export function contextRestartRetryState(
  events: readonly Event[],
  assignment: AssignmentId,
  session: string,
  now: string,
): "fresh" | "due" | "waiting" | "recoverable" | "closed" {
  const all = sessionAttempts(events, assignment, session);
  if (all.length === 0) return "fresh";
  const results = new Map(
    eventsOfType(events, "context_session_restart_result").map((e) => [
      (e.payload as RestartResultPayload).action_id,
      e.payload as RestartResultPayload,
    ]),
  );
  // The extra attempt starts a new chain; only it and its retries decide.
  const recovery = all.findIndex(
    (e) =>
      (e.payload as { diagnosis_recovery_retry?: boolean })
        .diagnosis_recovery_retry === true,
  );
  const attempts = recovery >= 0 ? all.slice(recovery) : all;
  let retryAt = Number.NEGATIVE_INFINITY;
  for (const [i, attempt] of attempts.entries()) {
    const result = results.get(attempt.id);
    if (result?.result !== CONTEXT_RESTART_RETRY_SCHEDULED)
      return recovery < 0 &&
        i === attempts.length - 1 &&
        result?.result === "failed" &&
        DIAGNOSIS_UNAVAILABLE_REASONS.has(result.reason ?? "") &&
        !stopMayHaveStarted(events, attempt.id)
        ? "recoverable"
        : "closed";
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
