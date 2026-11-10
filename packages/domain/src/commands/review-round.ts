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
  let trigger = d.state.events.find((e) => e.id === run.trigger_event_id);
  // A dispatch recovery is the same unstarted fix, with a new queue identity.
  const recovery = trigger?.payload as
    | {
        assignment_id?: string;
        replacement_run_id?: string;
        original_trigger_event_id?: string;
      }
    | undefined;
  if (
    trigger?.type === "run_dispatch_recovered" &&
    trigger.actor.kind === "system" &&
    recovery?.assignment_id === run.assignment_id &&
    recovery.replacement_run_id === run.id
  )
    trigger = d.state.events.find(
      (e) => e.id === recovery.original_trigger_event_id,
    );
  const payload = trigger?.payload as { work_item_id?: string } | undefined;
  return run.kind === "fix" &&
    trigger?.type === "merge_conflicted" &&
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
