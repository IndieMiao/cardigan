import type { Delivery, Run, WorkItem } from "../entities.js";
import type { EventId } from "../ids.js";
import type { CommandDraft } from "./core.js";

/** Only the first product from a system-recorded conflict fix gets an exemption. */
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
  let trigger = d.state.events.find((e) => e.id === sourceRun.trigger_event_id);
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
    trigger = d.state.events.find((e) => e.id === sourceRun.trigger_event_id);
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

/** Each conflict grants at most one free review per verifier, including acceptance. */
export function reviewRound(
  d: CommandDraft,
  item: WorkItem,
  target: Delivery | undefined = currentReviewTarget(d, item),
) {
  const deliveries = new Map(d.list("deliveries").map((v) => [v.id, v]));
  const reviews = d.list("reviews").filter((r) => r.work_item_id === item.id);
  const exemptions = new Set(
    reviews.flatMap((r) => {
      const eventId = deliveries.get(r.delivery_id)?.merge_conflict_event_id;
      return eventId ? [eventId] : [];
    }),
  );
  const free =
    target?.merge_conflict_event_id &&
    !exemptions.has(target.merge_conflict_event_id);
  return Math.max(1, reviews.length - exemptions.size + (free ? 0 : 1));
}
