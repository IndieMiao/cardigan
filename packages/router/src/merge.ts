import type { AssignmentId, CardId, RunId } from "@cardigan/domain";
import type { NotificationKind, RoutedNotification } from "./types.js";

/**
 * M3 plan §3.2 / development plan §6.7: several pending notifications for one
 * Assignment become a single bell, carrying the seq range and a summary:
 *
 * ```
 * [bell] card=C-123 asg=A-17 seq=17..25 summary="1 delivery, 2 reviews, 5 comments"
 * → 请调用 card.get_updates 读取详情
 * ```
 */
export interface BellMessage {
  readonly card_id: CardId;
  readonly run_id?: RunId;
  readonly assignment_id: AssignmentId;
  readonly from_seq: number;
  readonly to_seq: number;
  /** `1 delivery, 2 reviews, 5 comments` */
  readonly summary: string;
  /** The whole message, both lines, ready to hand to `Runtime.wake`. */
  readonly text: string;
}

/** Notification kinds that appear in the summary, in the order §6.7 lists them. */
const SUMMARY_LABELS: readonly {
  readonly kind: NotificationKind;
  readonly label: readonly [singular: string, plural: string];
}[] = [
  { kind: "card", label: ["card", "cards"] },
  { kind: "assignment", label: ["assignment", "assignments"] },
  { kind: "delivery", label: ["delivery", "deliveries"] },
  { kind: "review", label: ["review", "reviews"] },
  { kind: "comment", label: ["comment", "comments"] },
  { kind: "instruction", label: ["instruction", "instructions"] },
  { kind: "decision", label: ["decision", "decisions"] },
  { kind: "dependency", label: ["dependency change", "dependency changes"] },
  { kind: "completion", label: ["completion request", "completion requests"] },
  { kind: "human_action", label: ["human action", "human actions"] },
  { kind: "run_attention", label: ["run attention", "run attention"] },
  { kind: "escalation", label: ["escalation", "escalations"] },
  { kind: "needs_you", label: ["needs-you item", "needs-you items"] },
];

/** Count one bucket per kind, in the fixed §6.7 order. */
export function summarizeNotifications(
  notifications: readonly Pick<RoutedNotification, "kind">[],
): string {
  const counts = new Map<NotificationKind, number>();
  for (const notification of notifications) {
    counts.set(notification.kind, (counts.get(notification.kind) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const { kind, label } of SUMMARY_LABELS) {
    const count = counts.get(kind);
    if (count === undefined) continue;
    parts.push(`${count} ${label[count === 1 ? 0 : 1]}`);
    counts.delete(kind);
  }
  // A kind added later must not be silently dropped from the summary.
  for (const [kind, count] of counts) parts.push(`${count} ${kind}`);
  return parts.join(", ");
}

/**
 * Merge one Assignment's pending notifications on one card into one bell.
 *
 * Returns `undefined` when there is nothing to deliver, which keeps the
 * "repeat notifications do not ring twice" rule in one place: the caller passes
 * only notifications that have not been delivered at least as far as their seq.
 */
export function mergeNotifications(input: {
  readonly card_id: CardId;
  readonly assignment_id: AssignmentId;
  /**
   * The Run this bell belongs to. §6.2 puts it in the first line, and an Agent
   * needs it for `finish_run` / `heartbeat`; without it a host-started Agent
   * cannot close its Run.
   */
  readonly run_id?: RunId | undefined;
  readonly notifications: readonly Pick<
    RoutedNotification,
    "seq" | "kind" | "summary"
  >[];
}): BellMessage | undefined {
  if (input.notifications.length === 0) return undefined;
  const seqs = input.notifications.map((notification) => notification.seq);
  const from_seq = Math.min(...seqs);
  const to_seq = Math.max(...seqs);
  const summary = summarizeNotifications(input.notifications);
  const text = [
    `[bell] card=${input.card_id} asg=${input.assignment_id}${input.run_id === undefined ? "" : ` run=${input.run_id}`} seq=${from_seq}..${to_seq} summary="${summary}"`,
    "→ 请调用 card.get_updates 读取详情",
  ].join("\n");
  return {
    card_id: input.card_id,
    assignment_id: input.assignment_id,
    ...(input.run_id === undefined ? {} : { run_id: input.run_id }),
    from_seq,
    to_seq,
    summary,
    text,
  };
}
