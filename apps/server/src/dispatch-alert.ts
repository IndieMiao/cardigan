import type {
  Assignment,
  CardId,
  CommandState,
  Event,
  Notification,
  Run,
  RunId,
} from "@cardigan/domain";
import {
  moveNotification,
  recordNotification,
  type Store,
  type StoreTransactionContext,
} from "@cardigan/store";
import type { StandingResolver } from "./dispatch-inbox.js";

export const unfinishedRun = (r: Run) =>
  !["completed", "failed", "cancelled"].includes(r.status);
export type AlertAudience = "ops" | "human" | "human_only";
export function alertAudience(
  a: Assignment,
  state: CommandState,
  standing?: StandingResolver,
  notes: readonly Notification[] = [],
): AlertAudience {
  if (
    notes.some((n) => n.recipient.kind === "pm_office") ||
    standing?.(state.project_id, "pm_office", state) === a.id
  )
    return "human_only";
  if (
    notes.some((n) => n.recipient.kind === "pm_ops") ||
    standing?.(state.project_id, "pm_ops", state) === a.id
  )
    return "human";
  return "ops";
}
/** Caller owns the transaction: the fact and all escalation recipients commit together. */
export function dispatchAlert(
  tx: StoreTransactionContext,
  store: Store,
  state: CommandState,
  at: string,
  input: {
    assignment: Assignment;
    type: string;
    reason: string;
    audience: AlertAudience;
    card_id?: CardId | undefined;
    run_id?: RunId | undefined;
    notification_ids?: readonly string[];
    mark?: boolean;
  },
) {
  const project = state.project_id;
  const event: Event = {
    id: tx.ids.nextEventId(),
    seq: tx.ids.nextEventSequence(project, input.card_id),
    ...(input.card_id ? { card_id: input.card_id } : {}),
    type: input.type,
    actor: { kind: "system", project_id: project },
    created_at: at,
    payload: {
      assignment_id: input.assignment.id,
      reason: input.reason,
      ...(input.run_id ? { run_id: input.run_id } : {}),
      notification_ids: input.notification_ids ?? [],
    },
  };
  tx.events.append(project, event);
  const record = (recipient: Notification["recipient"]) =>
    recordNotification(store.database, {
      project_id: project,
      event_id: event.id,
      card_id: event.card_id,
      seq: event.seq,
      recipient,
      kind:
        recipient.kind === "needs_you" || recipient.kind === "pm_office"
          ? "needs_you"
          : "run_attention",
      at,
    }).notification;
  if (input.mark) {
    const n = record({
      kind: "assignment",
      assignment_id: input.assignment.id,
    });
    moveNotification(store.database, {
      project_id: project,
      id: n.id,
      event: "needs_attention",
      at,
      patch: input.run_id ? { run_id: input.run_id } : {},
    });
  }
  if (input.audience === "ops") record({ kind: "pm_ops" });
  else {
    record({ kind: "needs_you" });
    if (input.audience === "human") record({ kind: "pm_office" });
  }
}
