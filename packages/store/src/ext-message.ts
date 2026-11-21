import type { DatabaseSync } from "node:sqlite";
import type { ExtMessageItem } from "@cardigan/domain";

import { prepare } from "./statements.js";

export interface ExtMessageRow {
  project_id: string;
  item_kind: ExtMessageItem["kind"];
  item_id: string;
  channel: string;
  event_id: string;
  card_id: string | null;
  status: "pending" | "sent" | "failed" | "skipped";
  attempts: number;
  next_attempt_at: string;
  lease_id: string | null;
  lease_until: string | null;
  last_error:
    | "retryable"
    | "permanent"
    | "timeout"
    | "unknown"
    | "adapter_unavailable"
    | null;
  updated_at: string;
  digest_id: string | null;
}
const key = (r: ExtMessageRow) => [
  r.project_id,
  r.item_kind,
  r.item_id,
  r.channel,
];
/** Primary-key probe: projection never reads the channel's sent history. */
export function hasExtMessage(
  db: DatabaseSync,
  item: ExtMessageItem,
  channel: string,
): boolean {
  return !!prepare(
    db,
    "SELECT 1 FROM ext_message_outbox WHERE project_id=? AND item_kind=? AND item_id=? AND channel=?",
  ).get(item.project_id, item.kind, item.item_id, channel);
}
export interface ExtQuietOverflow {
  readonly stamp: string;
  readonly members: string; // Pre-encoded item keys, never message content.
}
/** Only read the membership document in the read snapshot. */
export function extQuietOverflow(
  db: DatabaseSync,
  project: string,
  channel: string,
): ExtQuietOverflow | null {
  const row = prepare(
    db,
    "SELECT stamp,members FROM ext_message_quiet_overflow WHERE project_id=? AND channel=?",
  ).get(project, channel);
  return row
    ? { stamp: String(row.stamp), members: String(row.members) }
    : null;
}
/** Constant-size fencing check inside the writer transaction. */
export function extQuietStamp(
  db: DatabaseSync,
  project: string,
  channel: string,
): string | null {
  const row = prepare(
    db,
    "SELECT stamp FROM ext_message_quiet_overflow WHERE project_id=? AND channel=?",
  ).get(project, channel);
  return row ? String(row.stamp) : null;
}
export function saveExtQuietOverflow(
  db: DatabaseSync,
  project: string,
  channel: string,
  checkpoint: ExtQuietOverflow | null,
): void {
  if (checkpoint === null) {
    prepare(
      db,
      "DELETE FROM ext_message_quiet_overflow WHERE project_id=? AND channel=?",
    ).run(project, channel);
  } else {
    prepare(
      db,
      `INSERT INTO ext_message_quiet_overflow(project_id,channel,stamp,members) VALUES (?,?,?,?)
      ON CONFLICT(project_id,channel) DO UPDATE SET stamp=excluded.stamp,members=excluded.members`,
    ).run(project, channel, checkpoint.stamp, checkpoint.members);
  }
}
export function projectExtMessage(
  db: DatabaseSync,
  item: ExtMessageItem,
  channel: string,
  now: string,
  deferred = false,
): void {
  prepare(
    db,
    `INSERT OR IGNORE INTO ext_message_outbox
    (project_id,item_kind,item_id,channel,event_id,card_id,status,next_attempt_at,updated_at,digest_id)
    VALUES (?,?,?,?,?,?,'pending',?,?,?)`,
  ).run(
    item.project_id,
    item.kind,
    item.item_id,
    channel,
    item.event_id,
    item.card_id ?? null,
    now,
    now,
    deferred ? "queued" : null,
  );
}

/** Freeze a quiet-hours batch in the same transaction as its first attempt. */
export function groupExtMessage(
  db: DatabaseSync,
  row: ExtMessageRow,
  digest: string,
): void {
  prepare(
    db,
    `UPDATE ext_message_outbox SET digest_id = ?
    WHERE project_id = ? AND item_kind = ? AND item_id = ? AND channel = ?
    AND status = 'pending' AND attempts = 0 AND lease_id IS NULL
    AND (digest_id IS NULL OR digest_id IN ('queued', 'rate:queued'))`,
  ).run(digest, ...key(row));
}
export function listExtMessages(
  db: DatabaseSync,
  project?: string,
): ExtMessageRow[] {
  return prepare(
    db,
    `SELECT * FROM ext_message_outbox${project ? " WHERE project_id = ?" : ""} ORDER BY updated_at, item_id, channel`,
  ).all(...(project ? [project] : [])) as unknown as ExtMessageRow[];
}
/** Exact row lookup and pending-only scans keep sent history out of each sending tick. */
export function getExtMessage(
  db: DatabaseSync,
  row: ExtMessageRow,
): ExtMessageRow | undefined {
  return prepare(
    db,
    "SELECT * FROM ext_message_outbox WHERE project_id=? AND item_kind=? AND item_id=? AND channel=?",
  ).get(...key(row)) as unknown as ExtMessageRow | undefined;
}
export function pendingExtMessages(
  db: DatabaseSync,
  project: string,
  channel: string,
): ExtMessageRow[] {
  return prepare(
    db,
    "SELECT * FROM ext_message_outbox WHERE project_id=? AND channel=? AND status='pending' ORDER BY next_attempt_at,item_id",
  ).all(project, channel) as unknown as ExtMessageRow[];
}
/** Called inside a Store write transaction; stale results cannot overwrite a new attempt. */
export function claimExtMessage(
  db: DatabaseSync,
  row: ExtMessageRow,
  lease: string,
  now: string,
  until: string,
  retryAt: string,
): boolean {
  return (
    prepare(
      db,
      `UPDATE ext_message_outbox SET attempts = attempts + 1, lease_id = ?, lease_until = ?, next_attempt_at = ?, updated_at = ?
    WHERE project_id = ? AND item_kind = ? AND item_id = ? AND channel = ? AND status = 'pending' AND attempts = ? AND next_attempt_at <= ? AND (lease_until IS NULL OR lease_until <= ?)`,
    ).run(lease, until, retryAt, now, ...key(row), row.attempts, now, now)
      .changes === 1
  );
}
export function settleExtMessage(
  db: DatabaseSync,
  row: ExtMessageRow,
  status: ExtMessageRow["status"],
  error: ExtMessageRow["last_error"],
  now: string,
  next: string,
): boolean {
  return (
    prepare(
      db,
      `UPDATE ext_message_outbox SET status = ?, last_error = ?, updated_at = ?, next_attempt_at = ?, lease_id = NULL, lease_until = NULL
    WHERE project_id = ? AND item_kind = ? AND item_id = ? AND channel = ? AND status = 'pending' AND attempts = ? AND lease_id IS ?`,
    ).run(status, error, now, next, ...key(row), row.attempts, row.lease_id)
      .changes === 1
  );
}

/** Fence channel-wide summary membership even if another project/sender was not projected. */
export function pendingExtGroupSize(
  db: DatabaseSync,
  channel: string,
  digest: string,
) {
  return Number(
    prepare(
      db,
      "SELECT COUNT(*) AS n FROM ext_message_outbox WHERE channel=? AND digest_id=? AND status='pending'",
    ).get(channel, digest)?.n,
  );
}
