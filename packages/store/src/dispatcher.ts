import type { DatabaseSync } from "node:sqlite";
import type {
  AssignmentId,
  Notification,
  ProjectId,
  Run,
  RunId,
} from "@cardigan/domain";

export interface BellAttempt {
  readonly project_id: ProjectId;
  readonly id: string;
  readonly assignment_id: AssignmentId;
  readonly run_id: RunId;
  readonly notification_ids: readonly string[];
  readonly started_at: string;
  readonly lease_until: string;
  readonly finished_at: string | null;
  readonly outcome: "sent" | "failed" | null;
}
export type BeginBellAttempt = Omit<BellAttempt, "finished_at" | "outcome">;
const requireTransaction = (db: DatabaseSync) => {
  if (!db.isTransaction)
    throw new Error("Bell attempts require an open transaction");
};
const timestamp = (value: string) => {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value)
    throw new Error("Expected an ISO timestamp");
  return time;
};
/** Caller commits this intent together with queue/dispatch and notification facts. */
export function beginBellAttempt(
  db: DatabaseSync,
  input: BeginBellAttempt,
): void {
  requireTransaction(db);
  if (
    !input.id ||
    timestamp(input.lease_until) <= timestamp(input.started_at) ||
    input.notification_ids.length === 0 ||
    input.notification_ids.length > 1000 ||
    new Set(input.notification_ids).size !== input.notification_ids.length
  )
    throw new Error("Invalid bell attempt");
  const row = db
    .prepare("SELECT doc FROM runs WHERE project_id = ? AND id = ?")
    .get(input.project_id, input.run_id);
  if (
    !row ||
    (JSON.parse(String(row.doc)) as Run).assignment_id !== input.assignment_id
  )
    throw new Error("Bell Run does not belong to its Assignment");
  const read = db.prepare(
    "SELECT status, doc FROM notifications WHERE project_id = ? AND id = ?",
  );
  for (const id of input.notification_ids) {
    const notification = read.get(input.project_id, id);
    if (
      !notification ||
      !["pending", "belled"].includes(String(notification.status))
    )
      throw new Error("Bell notification is missing or no longer deliverable");
    const recipient = (JSON.parse(String(notification.doc)) as Notification)
      .recipient;
    if (
      recipient.kind === "assignment" &&
      recipient.assignment_id !== input.assignment_id
    )
      throw new Error("Bell notification belongs to another Assignment");
  }
  db.prepare(`INSERT INTO bell_attempts
    (project_id, id, assignment_id, run_id, notification_ids, started_at, lease_until)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    input.project_id,
    input.id,
    input.assignment_id,
    input.run_id,
    JSON.stringify(input.notification_ids),
    input.started_at,
    input.lease_until,
  );
}
/** A late completion cannot overwrite recovery's already-settled outcome. */
export function finishBellAttempt(
  db: DatabaseSync,
  project: ProjectId,
  id: string,
  outcome: "sent" | "failed",
  at: string,
): boolean {
  requireTransaction(db);
  timestamp(at);
  const result = db
    .prepare(`UPDATE bell_attempts SET outcome = ?, finished_at = ?
    WHERE project_id = ? AND id = ? AND finished_at IS NULL AND started_at <= ?`)
    .run(outcome, at, project, id, at);
  return Number(result.changes) === 1;
}
/** Unfinished intents survive restart; only expired leases may be recovered. */
export function unfinishedBellAttempts(
  db: DatabaseSync,
  project: ProjectId,
): BellAttempt[] {
  return db
    .prepare(
      "SELECT * FROM bell_attempts WHERE project_id = ? AND finished_at IS NULL ORDER BY started_at, id",
    )
    .all(project)
    .map((row) => ({
      project_id: String(row.project_id) as ProjectId,
      id: String(row.id),
      assignment_id: String(row.assignment_id) as AssignmentId,
      run_id: String(row.run_id) as RunId,
      notification_ids: JSON.parse(String(row.notification_ids)) as string[],
      started_at: String(row.started_at),
      lease_until: String(row.lease_until),
      finished_at: null,
      outcome: null,
    }));
}
