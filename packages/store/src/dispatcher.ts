import type { DatabaseSync } from "node:sqlite";
import type {
  AssignmentId,
  DeliveryId,
  Notification,
  ProjectId,
  Run,
  RunId,
} from "@cardigan/domain";

export interface ReviewWakeBinding {
  readonly delivery_id: DeliveryId;
  readonly target_sha: string;
  /** Written before external IO. Absence on a tracked intent proves pre-send. */
  readonly sending_at?: string;
  /** Final adapter guard positively refused this attempt after the caller allowed it. */
  readonly refused_at?: string;
}
export interface BellAttempt {
  readonly review_wake?: ReviewWakeBinding;
  readonly project_id: ProjectId;
  readonly id: string;
  readonly assignment_id: AssignmentId;
  readonly run_id: RunId;
  /** The Run was already running when this inbox intent was claimed. */
  readonly continuation?: true;
  readonly notification_ids: readonly string[];
  readonly started_at: string;
  readonly lease_until: string;
  readonly finished_at: string | null;
  readonly outcome: "sent" | "failed" | null;
}
export type BeginBellAttempt = Omit<
  BellAttempt,
  "finished_at" | "outcome" | "continuation" | "review_wake"
>;
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
): BellAttempt {
  return beginAttempt(db, input, false);
}

/** An explicit host launch has no inbox notification but shares its exclusion. */
export function beginLaunchAttempt(
  db: DatabaseSync,
  input: Omit<BeginBellAttempt, "notification_ids">,
): BellAttempt {
  return beginAttempt(db, { ...input, notification_ids: [] }, true);
}

function beginAttempt(
  db: DatabaseSync,
  input: BeginBellAttempt,
  launch: boolean,
  retry = false,
): BellAttempt {
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
  const run = row && (JSON.parse(String(row.doc)) as Run);
  if (
    !run ||
    run.assignment_id !== input.assignment_id ||
    (launch && run.status !== "queued")
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
  // Persist the claim-time fact, never infer it from the Run at lease expiry.
  const continuation = run.status === "running";
  db.prepare(`INSERT INTO bell_attempts
    (project_id, id, assignment_id, run_id, notification_ids, started_at, lease_until, continuation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    input.project_id,
    input.id,
    input.assignment_id,
    input.run_id,
    JSON.stringify(input.notification_ids),
    input.started_at,
    input.lease_until,
    Number(continuation),
  );
  return {
    ...input,
    ...(continuation ? { continuation: true } : {}),
    finished_at: null,
    outcome: null,
  };
}
/** Annotate only an unfinished, owned intent. A replayed callback cannot cross
 * twice, change the target, or resurrect an intent withdrawn by another tick. */
export function bindReviewWake(
  db: DatabaseSync,
  attempt: BellAttempt,
  binding: ReviewWakeBinding,
  sendingAt?: string,
) {
  requireTransaction(db);
  const target = {
    delivery_id: binding.delivery_id,
    target_sha: binding.target_sha,
  };
  const before = JSON.stringify(target);
  const after =
    sendingAt === undefined
      ? before
      : JSON.stringify({ ...target, sending_at: sendingAt });
  return (
    Number(
      db
        .prepare(
          `UPDATE bell_attempts SET review_wake = ? WHERE project_id = ? AND id = ? AND assignment_id = ? AND run_id = ? AND finished_at IS NULL AND review_wake IS ?`,
        )
        .run(
          after,
          attempt.project_id,
          attempt.id,
          attempt.assignment_id,
          attempt.run_id,
          sendingAt === undefined ? null : before,
        ).changes,
    ) === 1
  );
}
/** A positive adapter acknowledgement of non-delivery supersedes the send intent. */
export function confirmReviewNotSent(db: DatabaseSync, attempt: BellAttempt) {
  requireTransaction(db);
  db.prepare(`UPDATE bell_attempts SET review_wake=json_remove(review_wake,'$.sending_at')
      WHERE project_id=? AND id=? AND finished_at IS NULL AND review_wake IS NOT NULL`).run(
    attempt.project_id,
    attempt.id,
  );
}
/** A final adapter refusal is stronger than the local permission to send.
 * Keep the receipt on its exact claim. After lease expiry it can clarify that
 * claim only while it is still the latest, unacknowledged, unfenced repair. */
export function settleWakeWithdrawal(
  db: DatabaseSync,
  attempt: BellAttempt,
  at: string,
) {
  requireTransaction(db);
  if (!attempt.review_wake)
    return withdrawBellAttempt(db, attempt.project_id, attempt.id);
  timestamp(at);
  return (
    Number(
      db
        .prepare(`UPDATE bell_attempts SET outcome='failed', finished_at=?,
    review_wake=json_set(json_remove(review_wake,'$.sending_at'),'$.refused_at',?)
    WHERE project_id=? AND id=? AND assignment_id=? AND run_id=? AND started_at <= ?
      AND json_extract(review_wake,'$.delivery_id')=? AND json_extract(review_wake,'$.target_sha')=?
      AND (finished_at IS NULL OR (outcome='failed' AND json_extract(review_wake,'$.sending_at') IS NOT NULL))
      AND NOT EXISTS (SELECT 1 FROM bell_attempts later WHERE later.project_id=bell_attempts.project_id
        AND later.run_id=bell_attempts.run_id AND later.rowid > bell_attempts.rowid)
      AND EXISTS (SELECT 1 FROM runs r WHERE r.project_id=bell_attempts.project_id AND r.id=bell_attempts.run_id
        AND json_extract(r.doc,'$.status')='dispatched' AND json_extract(r.doc,'$.started_at') IS NULL
        AND json_extract(r.doc,'$.dispatch_stop') IS NULL AND json_extract(r.doc,'$.inactivity_stop') IS NULL)`)
        .run(
          at,
          at,
          attempt.project_id,
          attempt.id,
          attempt.assignment_id,
          attempt.run_id,
          at,
          attempt.review_wake.delivery_id,
          attempt.review_wake.target_sha,
        ).changes,
    ) === 1
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
/** Withdraw a reservation only when the caller proved no external delivery occurred.
 * Caller records the withdrawal with the Run wait in the same transaction. */
export function withdrawBellAttempt(
  db: DatabaseSync,
  project: ProjectId,
  id: string,
): boolean {
  requireTransaction(db);
  return (
    Number(
      db
        .prepare(
          `DELETE FROM bell_attempts WHERE project_id = ? AND id = ? AND finished_at IS NULL
           AND json_extract(review_wake, '$.sending_at') IS NULL`,
        )
        .run(project, id).changes,
    ) === 1
  );
}
/** Unfinished intents survive restart; only expired leases may be recovered. */
export function unfinishedBellAttempts(
  db: DatabaseSync,
  project: ProjectId,
  assignment?: AssignmentId,
): BellAttempt[] {
  return readAttempts(db, project, true, { assignment });
}

/** Delivery history also covers explicit CLI starts, which have no notification. */
export function listBellAttempts(
  db: DatabaseSync,
  project: ProjectId,
  run?: RunId,
): BellAttempt[] {
  return readAttempts(db, project, false, { run });
}
function readAttempts(
  db: DatabaseSync,
  project: ProjectId,
  unfinished: boolean,
  scope: { assignment?: AssignmentId | undefined; run?: RunId | undefined },
): BellAttempt[] {
  return db
    .prepare(
      `SELECT * FROM bell_attempts WHERE project_id = ? ${unfinished ? "AND finished_at IS NULL" : ""}
       ${scope.assignment === undefined ? "" : "AND assignment_id = ?"}
       ${scope.run === undefined ? "" : "AND run_id = ?"} ORDER BY started_at, rowid`,
    )
    .all(
      project,
      ...(scope.assignment === undefined ? [] : [scope.assignment]),
      ...(scope.run === undefined ? [] : [scope.run]),
    )
    .map((row) => ({
      project_id: String(row.project_id) as ProjectId,
      id: String(row.id),
      assignment_id: String(row.assignment_id) as AssignmentId,
      run_id: String(row.run_id) as RunId,
      notification_ids: JSON.parse(String(row.notification_ids)) as string[],
      ...(row.review_wake
        ? {
            review_wake: JSON.parse(
              String(row.review_wake),
            ) as ReviewWakeBinding,
          }
        : {}),
      ...(row.continuation === 1 ? { continuation: true as const } : {}),
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
