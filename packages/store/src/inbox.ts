import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  AssignmentId,
  CardId,
  EventId,
  Notification,
  NotificationEvent,
  NotificationStatus,
  ProjectId,
} from "@cardigan/domain";
import { nextNotificationStatus } from "@cardigan/domain";

/**
 * M3.3: the router inbox (M3 plan §3.2) and the Router cursor.
 *
 * The unique key is (project, event, recipient): reprocessing an event from any
 * cursor position never notifies twice, which is what makes the Router safe to
 * restart (M3.4). Status changes go through the domain transition table, so the
 * store cannot invent a state the state machine forbids.
 */

export interface RecordNotificationInput {
  readonly project_id: ProjectId;
  readonly event_id: EventId;
  readonly recipient: Notification["recipient"];
  readonly card_id?: CardId | undefined;
  readonly seq: number;
  readonly kind: string;
  /** Called at most once per (event, recipient); skipped rows return false. */
  readonly id?: string;
  readonly at?: string;
}

const recipientAssignment = (recipient: Notification["recipient"]): string =>
  recipient.kind === "assignment" ? recipient.assignment_id : "";

function decode(row: unknown): Notification {
  return JSON.parse((row as { doc: string }).doc) as Notification;
}

/** Insert a notification unless the (event, recipient) pair already exists. */
export function recordNotification(
  db: DatabaseSync,
  input: RecordNotificationInput,
  now: () => string = () => new Date().toISOString(),
): { readonly created: boolean; readonly notification: Notification } {
  const at = input.at ?? now();
  const existing = db
    .prepare(
      "SELECT doc FROM notifications WHERE project_id = ? AND event_id = ? AND recipient_kind = ? AND assignment_id = ?",
    )
    .get(
      input.project_id,
      input.event_id,
      input.recipient.kind,
      recipientAssignment(input.recipient),
    ) as { doc: string } | undefined;
  if (existing !== undefined) {
    return { created: false, notification: decode(existing) };
  }
  const notification: Notification = {
    id: input.id ?? `ntf_${randomBytes(12).toString("hex")}`,
    project_id: input.project_id,
    event_id: input.event_id,
    recipient: input.recipient,
    ...(input.card_id === undefined ? {} : { card_id: input.card_id }),
    seq: input.seq,
    kind: input.kind,
    status: "pending",
    attempts: 0,
    created_at: at,
    updated_at: at,
  };
  db.prepare(
    `INSERT INTO notifications
       (project_id, id, event_id, recipient_kind, assignment_id, card_id, seq, kind, status, attempts, next_attempt_at, doc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.project_id,
    notification.id,
    notification.event_id,
    notification.recipient.kind,
    recipientAssignment(notification.recipient),
    notification.card_id ?? null,
    notification.seq,
    notification.kind,
    notification.status,
    0,
    null,
    JSON.stringify(notification),
  );
  return { created: true, notification };
}

export interface NotificationQuery {
  readonly project_id: ProjectId;
  readonly status?: NotificationStatus | undefined;
  readonly recipient_kind?: Notification["recipient"]["kind"] | undefined;
  readonly assignment_id?: AssignmentId | undefined;
  readonly card_id?: CardId | undefined;
}

/** Notifications matching the query, oldest seq first. */
export function listNotifications(
  db: DatabaseSync,
  query: NotificationQuery,
): Notification[] {
  const conditions = ["project_id = ?"];
  const values: Array<string | number> = [query.project_id];
  if (query.status !== undefined) {
    conditions.push("status = ?");
    values.push(query.status);
  }
  if (query.recipient_kind !== undefined) {
    conditions.push("recipient_kind = ?");
    values.push(query.recipient_kind);
  }
  if (query.assignment_id !== undefined) {
    conditions.push("assignment_id = ?");
    values.push(query.assignment_id);
  }
  if (query.card_id !== undefined) {
    conditions.push("card_id = ?");
    values.push(query.card_id);
  }
  return db
    .prepare(
      `SELECT doc FROM notifications WHERE ${conditions.join(" AND ")} ORDER BY seq, id`,
    )
    .all(...values)
    .map(decode);
}

/** Pending (or belled) notifications grouped by recipient (M3.3). */
export function notificationsByRecipient(
  db: DatabaseSync,
  project_id: ProjectId,
  statuses: readonly NotificationStatus[] = ["pending", "belled"],
): Map<string, Notification[]> {
  const groups = new Map<string, Notification[]>();
  for (const notification of listNotifications(db, { project_id })) {
    if (!statuses.includes(notification.status)) continue;
    const key =
      notification.recipient.kind === "assignment"
        ? `assignment:${notification.recipient.assignment_id}`
        : notification.recipient.kind;
    groups.set(key, [...(groups.get(key) ?? []), notification]);
  }
  return groups;
}

export interface MoveNotificationInput {
  readonly project_id: ProjectId;
  readonly id: string;
  readonly event: NotificationEvent;
  readonly at?: string;
  /** Extra facts the dispatcher writes in the same step (attempts, bell…). */
  readonly patch?: Partial<
    Pick<Notification, "attempts" | "next_attempt_at" | "bell" | "run_id">
  >;
}

/** Apply one notification event; the transition table rejects illegal moves. */
export function moveNotification(
  db: DatabaseSync,
  input: MoveNotificationInput,
  now: () => string = () => new Date().toISOString(),
): Notification {
  const row = db
    .prepare("SELECT doc FROM notifications WHERE project_id = ? AND id = ?")
    .get(input.project_id, input.id) as { doc: string } | undefined;
  if (row === undefined) throw new Error(`notification ${input.id} not found`);
  const current = decode(row);
  const transition = nextNotificationStatus(current.status, input.event);
  if (!transition.ok) throw new Error(transition.error.message);
  const next: Notification = {
    ...current,
    ...input.patch,
    status: transition.value,
    updated_at: input.at ?? now(),
  };
  db.prepare(
    "UPDATE notifications SET status = ?, attempts = ?, next_attempt_at = ?, doc = ? WHERE project_id = ? AND id = ?",
  ).run(
    next.status,
    next.attempts,
    next.next_attempt_at ?? null,
    JSON.stringify(next),
    input.project_id,
    input.id,
  );
  return next;
}

/**
 * §3.2: a notification is confirmed once the Assignment's ACK cursor for that
 * card is at or past its seq. Called after `ack_events`; returns how many rows
 * moved, so the dispatcher can stop counting them as pending.
 */
export function acknowledgeNotifications(
  db: DatabaseSync,
  project_id: ProjectId,
  assignment_id: AssignmentId,
  at: string = new Date().toISOString(),
): number {
  const rows = listNotifications(db, { project_id, assignment_id });
  let acked = 0;
  for (const notification of rows) {
    if (notification.recipient.kind !== "assignment") continue;
    if (notification.status === "acked") continue;
    const cursor = db
      .prepare(
        "SELECT acked_seq FROM cursors WHERE project_id = ? AND assignment_id = ? AND card_id = ?",
      )
      .get(project_id, assignment_id, notification.card_id ?? "") as
      | { acked_seq: number }
      | undefined;
    if (cursor === undefined || cursor.acked_seq < notification.seq) continue;
    moveNotification(
      db,
      { project_id, id: notification.id, event: "ack", at },
      () => at,
    );
    acked += 1;
  }
  return acked;
}

/**
 * The Router's position in one event stream (0 = nothing consumed). Event seqs
 * are per stream, so the cursor must be too: `stream` is the card id, or
 * `PROJECT_EVENT_STREAM` (`""`) for project-level events.
 */
export function routerCursor(
  db: DatabaseSync,
  project_id: ProjectId,
  stream: string,
): number {
  const row = db
    .prepare(
      "SELECT last_seq FROM router_cursors WHERE project_id = ? AND stream = ?",
    )
    .get(project_id, stream) as { last_seq: number } | undefined;
  return row?.last_seq ?? 0;
}

/**
 * Move the Router cursor forward. It never rewinds: a stale consumer must not
 * make the router re-emit notifications (the unique key would ignore them, but
 * the cursor itself has to stay monotonic to be trustworthy).
 */
export function advanceRouterCursor(
  db: DatabaseSync,
  project_id: ProjectId,
  stream: string,
  last_seq: number,
  at: string = new Date().toISOString(),
): number {
  if (!Number.isSafeInteger(last_seq) || last_seq < 0)
    throw new Error("Router cursor must be a non-negative integer");
  const current = routerCursor(db, project_id, stream);
  if (last_seq <= current) return current;
  db.prepare(
    `INSERT INTO router_cursors (project_id, stream, last_seq, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (project_id, stream) DO UPDATE SET last_seq = excluded.last_seq, updated_at = excluded.updated_at`,
  ).run(project_id, stream, last_seq, at);
  return last_seq;
}
