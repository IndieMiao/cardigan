import type { Assignment, Event } from "./entities.js";
import type { AssignmentId } from "./ids.js";
import {
  contextUsageThresholds,
  type ProjectPreferences,
} from "./preferences.js";

export interface ContextUsage {
  readonly agent: "claude" | "codex" | "pi";
  readonly session_id: string;
  readonly transcript_path: string | null;
  readonly cwd: string;
  readonly model: string | null;
  readonly context_tokens: number;
  readonly context_window_size: number;
  readonly used_percentage: number;
  readonly updated_at: string;
}
export interface ContextObservation extends ContextUsage {
  readonly assignment_id: AssignmentId;
  readonly runtime_key: string;
  readonly source: string;
}
export type ContextLevel = "handoff" | "restart";

export function contextUsageFresh(
  usage: ContextUsage,
  now: string,
  staleAfterMs: number,
) {
  const age = Date.parse(now) - Date.parse(usage.updated_at);
  return (
    Number.isFinite(age) &&
    age >= 0 &&
    age <= staleAfterMs &&
    Number.isFinite(usage.context_tokens) &&
    usage.context_tokens >= 0 &&
    Number.isFinite(usage.context_window_size) &&
    usage.context_window_size > 0 &&
    Number.isFinite(usage.used_percentage) &&
    usage.used_percentage >= 0 &&
    usage.used_percentage ===
      Math.round((usage.context_tokens / usage.context_window_size) * 1000) / 10
  );
}
export function contextUsageLevel(
  usage: ContextUsage,
  preferences?: ProjectPreferences,
): ContextLevel | undefined {
  const thresholds = contextUsageThresholds(preferences);
  const remaining = Math.round((100 - usage.used_percentage) * 10) / 10;
  return remaining <= thresholds.restart
    ? "restart"
    : remaining <= thresholds.handoff
      ? "handoff"
      : undefined;
}
export function contextNoticeRecorded(
  events: readonly Event[],
  observation: ContextObservation,
  level: ContextLevel,
) {
  return events.some(
    (e) =>
      e.type === "context_usage_notice" &&
      (e.payload as { assignment_id?: string }).assignment_id ===
        observation.assignment_id &&
      (e.payload as { session_id?: string }).session_id ===
        observation.session_id &&
      (e.payload as { level?: string }).level === level,
  );
}
/** Recheck the runtime generation after IO; an old cache cannot rotate its successor. */
export function contextObservationCurrent(
  a: Assignment,
  usage: ContextObservation,
  events: readonly Event[],
) {
  if (
    a.id !== usage.assignment_id ||
    a.status !== "active" ||
    JSON.stringify(a.runtime_ref) !== usage.runtime_key
  )
    return false;
  const session = a.runtime_ref?.agent_session_id ?? a.session_ref;
  if (session && session !== usage.session_id) return false;
  const replaced = events
    .filter(
      (e) =>
        [
          "session_replaced",
          "standing_session_restarted",
          "assignment_resumed",
          "host_ops_action_finished",
        ].includes(e.type) &&
        (e.payload as { assignment_id?: string }).assignment_id === a.id,
    )
    .reduce(
      (latest, e) => Math.max(latest, Date.parse(e.created_at)),
      Date.parse(a.created_at),
    );
  return Date.parse(usage.updated_at) >= replaced;
}
