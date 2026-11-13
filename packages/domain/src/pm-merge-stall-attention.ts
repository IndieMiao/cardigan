import { attempt, type CommandState } from "./commands/core.js";
import { mergeContext } from "./commands/merge.js";
import { projectPreferences } from "./commands/preferences.js";
import type { Decision, Event } from "./entities.js";
import type { CardId, DecisionId, DeliveryId } from "./ids.js";
import { mergeConfirmStallAfterMinutes } from "./preferences.js";

/** C-177: event / finding kind of a PM-held merge confirmation left open too long. */
export const PM_MERGE_STALL_KIND = "pm_merge_confirmation_stalled";

const readinessEvents = new Set([
  "merge_preparation_recorded",
  "merge_check_queued",
  "merge_check_started",
  "merge_check_finished",
  "merge_check_requeued",
]);
/** A check in one of these states will not change by itself. */
const concluded = new Set([
  "passed",
  "failed",
  "timed_out",
  "interrupted",
  "executor_unreachable",
]);

const payloadOf = (e: Event) =>
  typeof e.payload === "object" &&
  e.payload !== null &&
  !Array.isArray(e.payload)
    ? (e.payload as Record<string, unknown>)
    : {};

/**
 * When the current completion became ready for PM Ops: its latest check
 * concluded (passed or ended without passing) or the host verified a noop.
 * Queued or running checks, and no check at all, are not ready.
 */
function readyAt(
  events: readonly Event[],
  card: CardId,
  completion: DeliveryId,
): string | undefined {
  const latest = events
    .filter(
      (e) =>
        e.card_id === card &&
        readinessEvents.has(e.type) &&
        payloadOf(e).completion_id === completion,
    )
    .sort((a, b) => b.seq - a.seq)[0];
  if (!latest) return undefined;
  const p = payloadOf(latest);
  if (latest.type === "merge_preparation_recorded")
    return latest.actor.kind === "system" && p.noop === true
      ? latest.created_at
      : undefined;
  return typeof p.status === "string" && concluded.has(p.status)
    ? latest.created_at
    : undefined;
}

/** The latest state change of the decision (request, handoff, resume …). */
function decisionChangedAt(state: CommandState, q: Decision) {
  return state.events
    .filter(
      (e) =>
        e.type !== PM_MERGE_STALL_KIND &&
        (q.card_id === undefined || e.card_id === q.card_id) &&
        payloadOf(e).decision_id === q.id,
    )
    .sort((a, b) => b.seq - a.seq)[0]?.created_at;
}

export interface PmMergeStallOptions {
  /**
   * Extension point for explicit holds (C-180): return true to suppress the
   * alert for this confirmation at `now`. Defaults to never suppressing.
   */
  readonly suppressed?: (q: Decision, now: string) => boolean;
}

export interface PmMergeStallFinding {
  readonly kind: typeof PM_MERGE_STALL_KIND;
  readonly card_id: CardId;
  readonly decision_id: DecisionId;
  readonly completion_id: DeliveryId;
  /** Start of the current wait; a new value means a new alert period. */
  readonly since: string;
  readonly waited_ms: number;
  readonly threshold_minutes: number;
  readonly detail: string;
}

export function pmMergeStallNotice(card: string, waitedMs: number) {
  return `PM 持有的合并确认已停留 ${Math.floor(waitedMs / 60_000)} 分钟（${card}）`;
}

/**
 * C-177 / §7.4: read-only detection of open merge confirmations PM Ops holds
 * whose check concluded more than `merge_confirm_stall_after_minutes` ago.
 * The wait restarts whenever the decision or the check readiness changes.
 */
export function pmMergeStallAttention(
  state: CommandState,
  now: string,
  options: PmMergeStallOptions = {},
): readonly PmMergeStallFinding[] {
  const threshold = mergeConfirmStallAfterMinutes(projectPreferences(state));
  return state.decisions.flatMap((q): PmMergeStallFinding[] => {
    if (
      q.trigger !== "merge_confirmation" ||
      q.decider !== "role:pm" ||
      q.status !== "open" ||
      q.kind !== "approve" ||
      !("delivery_id" in q.target) ||
      !q.card_id
    )
      return [];
    const card_id = q.card_id;
    const completion_id = q.target.delivery_id;
    // Only cards still awaiting merge, and only the current completion.
    const context = attempt(() => mergeContext(state, card_id));
    if (!context.ok || context.value.target.id !== completion_id) return [];
    const ready = readyAt(state.events, card_id, completion_id);
    if (!ready) return [];
    const changed = decisionChangedAt(state, q);
    const since =
      changed && Date.parse(changed) > Date.parse(ready) ? changed : ready;
    const waited = Date.parse(now) - Date.parse(since);
    if (!Number.isFinite(waited) || waited <= threshold * 60_000) return [];
    if (options.suppressed?.(q, now)) return [];
    return [
      {
        kind: PM_MERGE_STALL_KIND,
        card_id,
        decision_id: q.id,
        completion_id,
        since,
        waited_ms: waited,
        threshold_minutes: threshold,
        detail: `${pmMergeStallNotice(card_id, waited)}：${q.id} 检查结论已出，超过 ${threshold} 分钟仍未处理。`,
      },
    ];
  });
}
