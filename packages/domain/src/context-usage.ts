import type { Assignment, Event } from "./entities.js";
import { eventsOfType } from "./event-index.js";
import type { AgentBinary } from "./harness.js";
import type { AssignmentId } from "./ids.js";
import {
  contextUsageThresholds,
  type ProjectPreferences,
} from "./preferences.js";

export interface ContextUsage {
  readonly agent: AgentBinary;
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
  return eventsOfType(events, "context_usage_notice").some(
    (e) =>
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
  usage: Pick<
    ContextObservation,
    "assignment_id" | "runtime_key" | "session_id" | "updated_at"
  >,
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
  return Date.parse(usage.updated_at) >= contextGenerationStart(a, events);
}

const GENERATION_EVENTS = [
  "session_replaced",
  "standing_session_restarted",
  "assignment_resumed",
  "host_ops_action_finished",
] as const;
/** Earliest attributable observation for the current assignment generation (epoch ms). */
export function contextGenerationStart(
  a: Assignment,
  events: readonly Event[],
) {
  // C-670: only the four generation types, through the typed index.
  let latest = Date.parse(a.created_at);
  for (const type of GENERATION_EVENTS)
    for (const e of eventsOfType(events, type))
      if ((e.payload as { assignment_id?: string }).assignment_id === a.id)
        latest = Math.max(latest, Date.parse(e.created_at));
  return latest;
}
