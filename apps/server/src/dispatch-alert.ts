import type {
  Assignment,
  CardId,
  CommandState,
  Event,
  Notification,
  Run,
  RunId,
} from "@cardigan/domain";
import { describePreparationFailure, redactFailureLine } from "@cardigan/host";
import {
  moveNotification,
  recordNotification,
  type Store,
  type StoreTransactionContext,
} from "@cardigan/store";
import type { StandingResolver } from "./dispatch-inbox.js";

/** Sanitized cause of a failed bell delivery, stored on the failure event. */
export interface DeliveryFailure {
  readonly category: string;
  readonly exit_code?: number;
  readonly message: string;
}
/** Where a bell delivery failed: Git preparation, the wake call, or other calls. */
export type DeliveryStage = "before_wake" | "wake" | "delivery_call";
/** Stable reason plus sanitized cause for a thrown delivery error (C-68). */
export function deliveryFailure(
  stage: DeliveryStage,
  error: unknown,
): { reason: string; failure: DeliveryFailure } {
  const { retryable: _, ...failure } = describePreparationFailure(error);
  return { reason: `${stage}_failed`, failure };
}
/** A wake call that returned a runtime error (it did not throw). */
export function wakeFailure(error: {
  readonly code: string;
  readonly message: string;
}): { reason: string; failure: DeliveryFailure } {
  return {
    reason: "wake_failed",
    failure: {
      category: error.code,
      message: redactFailureLine(error.message),
    },
  };
}
/** One sanitized server-log line for a failed delivery. */
export function deliveryFailureLine(input: {
  project: string;
  assignment: string;
  run: string;
  reason: string;
  failure: DeliveryFailure;
}): string {
  const { failure } = input;
  return `bell delivery failed: project=${input.project} asg=${input.assignment} run=${input.run} reason=${input.reason} category=${failure.category}${failure.exit_code === undefined ? "" : ` exit=${failure.exit_code}`} message=${failure.message}`;
}
/**
 * Audit-only record of a failed attempt that C-56 recovery will retry: the
 * card keeps the real cause, but nobody is notified (no alert per attempt).
 */
export function deliveryAttemptFailed(
  tx: StoreTransactionContext,
  state: CommandState,
  at: string,
  input: {
    assignment: Assignment;
    run_id: RunId;
    reason: string;
    error: DeliveryFailure;
    notification_ids: readonly string[];
    card_id?: CardId | undefined;
  },
) {
  const project = state.project_id;
  tx.events.append(project, {
    id: tx.ids.nextEventId(),
    seq: tx.ids.nextEventSequence(project, input.card_id),
    ...(input.card_id ? { card_id: input.card_id } : {}),
    type: "bell_delivery_attempt_failed",
    actor: { kind: "system", project_id: project },
    created_at: at,
    payload: {
      assignment_id: input.assignment.id,
      run_id: input.run_id,
      reason: input.reason,
      error: { ...input.error },
      notification_ids: [...input.notification_ids],
    },
  });
}
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
    error?: DeliveryFailure;
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
      ...(input.error ? { error: { ...input.error } } : {}),
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
