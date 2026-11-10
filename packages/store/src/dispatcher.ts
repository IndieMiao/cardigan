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
  beginAttempt(db, input, false);
}

/** An explicit host launch has no inbox notification but shares its exclusion. */
export function beginLaunchAttempt(
  db: DatabaseSync,
  input: Omit<BeginBellAttempt, "notification_ids">,
): void {
  beginAttempt(db, { ...input, notification_ids: [] }, true);
}

function beginAttempt(
  db: DatabaseSync,
  input: BeginBellAttempt,
  launch: boolean,
  retry = false,
): void {
  requireTransaction(db);
  if (
    !input.id ||
    timestamp(input.lease_until) <= timestamp(input.started_at) ||
    (!launch && !retry && input.notification_ids.length === 0) ||
    input.notification_ids.length > 1000 ||
    new Set(input.notification_ids).size !== input.notification_ids.length
  )
    throw new Error("Invalid bell attempt");
  if (
    unfinishedBellAttempts(db, input.project_id).some((a) =>
      a.notification_ids.some((id) => input.notification_ids.includes(id)),
    )
  )
    throw new Error("Bell notification is already in flight");
  const row = db
    .prepare("SELECT doc FROM runs WHERE project_id = ? AND id = ?")
    .get(input.project_id, input.run_id);
  if (
    !row ||
    (JSON.parse(String(row.doc)) as Run).assignment_id !==
      input.assignment_id ||
    (launch && (JSON.parse(String(row.doc)) as Run).status !== "queued")
  )
    throw new Error("Bell Run does not belong to its Assignment");
  const read = db.prepare(
    "SELECT status, doc FROM notifications WHERE project_id = ? AND id = ?",
  );
  for (const id of input.notification_ids) {
    const notification = read.get(input.project_id, id);
    if (
      !notification ||
      !["pending", "belled", "delivery_failed"].includes(
        String(notification.status),
      )
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
  return readAttempts(db, project, true);
}

/** Delivery history also covers explicit CLI starts, which have no notification. */
export function listBellAttempts(
  db: DatabaseSync,
  project: ProjectId,
): BellAttempt[] {
  return readAttempts(db, project, false);
}
function readAttempts(
  db: DatabaseSync,
  project: ProjectId,
  unfinished: boolean,
): BellAttempt[] {
  return db
    .prepare(
      `SELECT * FROM bell_attempts WHERE project_id = ? ${unfinished ? "AND finished_at IS NULL" : ""} ORDER BY started_at, rowid`,
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
      finished_at: row.finished_at === null ? null : String(row.finished_at),
      outcome: row.outcome as BellAttempt["outcome"],
    }));
}

/** Retry an existing dispatched Run, including a CLI start without inbox rows. */
export function beginDispatchRetry(
  db: DatabaseSync,
  input: BeginBellAttempt,
): void {
  const run = db
    .prepare("SELECT doc FROM runs WHERE project_id = ? AND id = ?")
    .get(input.project_id, input.run_id);
  if (!run || (JSON.parse(String(run.doc)) as Run).status !== "dispatched")
    throw new Error("Only an unstarted dispatched Run can retry delivery");
  beginAttempt(db, input, false, true);
}
