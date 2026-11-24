import type { Delivery, Run, WorkItem } from "../entities.js";
import { appendEvents, eventById } from "../event-index.js";
import type { EventId } from "../ids.js";
import { streakAlignment } from "../review-convergence.js";
import { evidenceWait } from "../review-evidence.js";
import type { CommandDraft } from "./core.js";

/** Only the first product of a trusted conflict fix inherits its source marker. */
export function conflictRepairEvent(
  d: CommandDraft,
  item: WorkItem,
  run: Run,
  completion: boolean,
): EventId | undefined {
  const deliveries = d
    .list("deliveries")
    .filter((v) => v.work_item_id === item.id);
  if (completion) {
    const product = deliveries.find(
      (v) => v.kind !== "card_completion" && v.status !== "superseded",
    );
    const eventId = product?.merge_conflict_event_id;
    return eventId &&
      !deliveries.some(
        (v) =>
          v.kind === "card_completion" && v.merge_conflict_event_id === eventId,
      )
      ? eventId
      : undefined;
  }
  let sourceRun = run;
  let trigger = eventById(d.state.events, sourceRun.trigger_event_id);
  const visited = new Set<EventId>();
  // Both host restarts and automatic recovery retain the same logical fix.
  // Follow mixed/repeated recovery chains, validating every Run/event binding.
  while (
    trigger &&
    ["run_dispatch_recovered", "host_ops_action_finished"].includes(
      trigger.type,
    )
  ) {
    if (visited.has(trigger.id)) return undefined;
    visited.add(trigger.id);
    const recovery = trigger.payload as {
      assignment_id?: string;
      run_id?: string;
      previous_run_id?: string;
      replacement_run_id?: string;
      original_trigger_event_id?: string;
    };
    const hostRestart = trigger.type === "host_ops_action_finished";
    const previous = d
      .list("runs")
      .find(
        (r) =>
          r.id === (hostRestart ? recovery.previous_run_id : recovery.run_id),
      );
    if (
      trigger.actor.kind !== "system" ||
      recovery.assignment_id !== sourceRun.assignment_id ||
      (hostRestart ? recovery.run_id : recovery.replacement_run_id) !==
        sourceRun.id ||
      !previous ||
      previous.assignment_id !== sourceRun.assignment_id ||
      previous.kind !== sourceRun.kind ||
      previous.trigger_event_id !== recovery.original_trigger_event_id
    )
      return undefined;
    sourceRun = previous;
    trigger = eventById(d.state.events, sourceRun.trigger_event_id);
  }
  const payload = trigger?.payload as { work_item_id?: string } | undefined;
  return run.kind === "fix" &&
    trigger?.type === "merge_conflicted" &&
    trigger.actor.kind === "system" &&
    trigger.card_id === item.card_id &&
    payload?.work_item_id === item.id &&
    !deliveries.some((v) => v.merge_conflict_event_id === trigger.id)
    ? trigger.id
    : undefined;
}

export function currentReviewTarget(d: CommandDraft, item: WorkItem) {
  return d
    .list("deliveries")
    .find(
      (v) =>
        v.status !== "superseded" && v.requested_verifiers.includes(item.id),
    );
}

/** Budget measures rejected reviews; pass, conditional and reuse never spend it. */
export function reviewRound(
  d: CommandDraft,
  item: WorkItem,
  _target?: Delivery,
) {
  return (
    d
      .list("reviews")
      .filter((r) => r.work_item_id === item.id && r.verdict === "reject")
      .length + 1
  );
}

/**
 * A pass or conditional result ends a rejection streak; reuse spends no rounds.
 * C-618: a pure platform evidence wait neither extends nor ends it.
 */
export function rejectionStreak(d: CommandDraft, item: WorkItem) {
  const reviews = d
    .list("reviews")
    .filter((r) => r.work_item_id === item.id && !evidenceWait(r))
    .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)));
  const end = reviews.findIndex((r) => r.verdict !== "reject");
  return end === -1 ? reviews : reviews.slice(0, end);
}

export function reviewRejectionsNeedAttention(d: CommandDraft, item: WorkItem) {
  const streak = rejectionStreak(d, item);
  if (streak.length < 3) return false;
  // C-610: an agreed alignment round settles the rest of its streak.
  if (streakAlignment(item, streak)?.status === "agreed") return false;
  return !appendEvents(d.state.events, d.events).some(
    (e) =>
      e.type === "review_limit_rejections_acknowledged" &&
      (e.payload as Record<string, unknown>).review_id === streak[0]?.id &&
      (e.payload as Record<string, unknown>).work_item_id === item.id,
  );
}

/** C-610: the alignment round of the current streak, while still undecided. */
export function openAlignment(d: CommandDraft, item: WorkItem) {
  const alignment = streakAlignment(item, rejectionStreak(d, item));
  return alignment?.status === "open" ? alignment : undefined;
}
