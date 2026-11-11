import type { Assignment, Author, Timestamp, WorkItem } from "./entities.js";
import { type Result, validationFailed } from "./errors.js";
import type { AssignmentId, CardId, EventId, ProjectId, RunId } from "./ids.js";
import type { NotificationStatus } from "./states.js";
import { transition } from "./transitions.js";

/** Match Card MCP's requireCard scope check within a project snapshot. */
export function assignmentCanReadCard(
  assignment: Assignment,
  card_id: CardId,
  work_items: readonly WorkItem[],
): boolean {
  return (
    assignment.scope === "standing" ||
    work_items.some(
      (item) => item.id === assignment.work_item_id && item.card_id === card_id,
    )
  );
}

/**
 * M3.2: the notification (and escalation) state machine.
 *
 * One row per (event, recipient) — the uniqueness belongs to the store (M3.3) —
 * with the lifecycle of development plan §4.4:
 *
 * ```
 * pending ──bell──▶ belled ──ack──▶ acked
 *    │                 │
 *    ├────ack──────────┘
 *    ├──deliver_failed──▶ delivery_failed ──ack──▶ acked
 *    └──needs_attention─▶ needs_attention
 * ```
 *
 * Answered, escalated or resolved notifications never ring again. The host
 * resolves obsolete attention without advancing the Agent's ACK cursor.
 */
export type NotificationEvent =
  | "bell"
  | "ack"
  | "retry"
  | "deliver_failed"
  | "needs_attention"
  | "resolve";

/** Who a notification is for (mirrors the router's recipient kinds). */
export type NotificationRecipient =
  | { readonly kind: "assignment"; readonly assignment_id: AssignmentId }
  | { readonly kind: "pm_ops" }
  | { readonly kind: "pm_office" }
  | { readonly kind: "needs_you" };

/** A resolved request returns to its owner, then Ops, then the human. Timed follow-ups can skip the requester. */
export function requesterNotificationRecipient(
  author: Author,
  assignments: readonly Assignment[],
  options: { readonly skip_requester?: boolean } = {},
): NotificationRecipient | undefined {
  if (!author.startsWith("assignment:")) return undefined;
  const owner = assignments.find((a) => `assignment:${a.id}` === author);
  if (!options.skip_requester && owner?.status === "active")
    return { kind: "assignment", assignment_id: owner.id };
  return assignments.some(
    (a) =>
      a.status === "active" &&
      a.scope === "standing" &&
      a.role_id === "pm" &&
      a.standing_mode === "ops",
  )
    ? { kind: "pm_ops" }
    : { kind: "needs_you" };
}

export interface Notification {
  /** Opaque id; the store assigns it (M3.3). */
  readonly id: string;
  readonly project_id: ProjectId;
  /** The event that produced this notification. */
  readonly event_id: EventId;
  /** Unique per (event_id, recipient) in the store (M3.3). */
  readonly recipient: NotificationRecipient;
  readonly card_id?: CardId;
  /** Seq of the producing event, so an ACK cursor can confirm it (§3.2). */
  readonly seq: number;
  /** Notification kind from `@cardigan/router`. */
  readonly kind: string;
  readonly status: NotificationStatus;
  /** How many bells were sent (used by the exponential backoff of §3.3). */
  readonly attempts: number;
  readonly next_attempt_at?: Timestamp;
  /** The bell text of the last successful merge (§3.2). */
  readonly bell?: string;
  readonly run_id?: RunId;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

/** Apply one notification event through the shared transition table. */
export function nextNotificationStatus(
  from: NotificationStatus,
  event: NotificationEvent,
): Result<NotificationStatus> {
  const result = transition("notification", from, event);
  if (result.ok) return result;
  return validationFailed(`Cannot apply ${event} to notification:${from}`);
}

/** Terminal states never ring again, whatever the dispatcher retries. */
export const isTerminalNotification = (status: NotificationStatus): boolean =>
  status === "acked" || status === "needs_attention" || status === "resolved";

/** Human readable reason for the two escalation states (§3.3). */
export const isEscalatedNotification = (status: NotificationStatus): boolean =>
  status === "needs_attention" || status === "delivery_failed";
