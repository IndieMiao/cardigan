import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ProjectId } from "@cardigan/domain";
import { prepare } from "./statements.js";
import type { StoreTransactionContext } from "./store.js";

export type ExtChannelActivation = { epoch: string; watermark: number };
export function extChannelActivation(db: DatabaseSync, name: string) {
  return prepare(
    db,
    "SELECT epoch,watermark,fingerprint FROM ext_message_channels WHERE name=?",
  ).get(name) as (ExtChannelActivation & { fingerprint: string }) | undefined;
}

/** Caller owns the configuration activation transaction. No raw settings are persisted. */
export function activateExtChannels(
  db: DatabaseSync,
  tx: StoreTransactionContext,
  fingerprints: Map<string, string>,
  now: string,
) {
  const active = new Map<string, ExtChannelActivation>();
  for (const { name } of prepare(
    db,
    "SELECT name FROM ext_message_channels",
  ).all()) {
    if (!fingerprints.has(String(name)))
      prepare(db, "DELETE FROM ext_message_channels WHERE name=?").run(name!);
  }
  for (const [name, fingerprint] of fingerprints) {
    let row = extChannelActivation(db, name);
    if (row?.fingerprint !== fingerprint) {
      const watermark = Number(
        prepare(db, "SELECT COALESCE(MAX(rowid),0) AS n FROM events").get()!.n,
      );
      row = { epoch: randomUUID(), watermark, fingerprint };
      prepare(
        db,
        "INSERT OR REPLACE INTO ext_message_channels(name,fingerprint,epoch,watermark) VALUES(?,?,?,?)",
      ).run(name, fingerprint, row.epoch, watermark);
      // Every extant row precedes the cutoff just taken under the writer lock.
      invalidateExtHistory(db, tx, name, null, now);
    }
    active.set(name, row);
  }
  return active;
}

/** On rebind, also retire rows for no-longer-reachable binding generations. */
export function invalidateExtHistory(
  db: DatabaseSync,
  tx: StoreTransactionContext,
  name: string,
  keep: string | null,
  now: string,
) {
  // Named params keep this predicate identical for rows and quiet checkpoints.
  const target = `(channel = :name OR channel GLOB :pattern) AND (:keep IS NULL OR channel <> :keep)`;
  const params = { name, pattern: `${name}:*`, keep };
  prepare(db, `DELETE FROM ext_message_quiet_overflow WHERE ${target}`).run(
    params,
  );
  prepare(db, `DELETE FROM ext_message_rate_batches WHERE ${target}`).run(
    params,
  );
  const rows = prepare(
    db,
    `UPDATE ext_message_outbox SET status='skipped',updated_at=:now,lease_id=NULL,lease_until=NULL WHERE status IN ('pending','failed') AND ${target} RETURNING project_id`,
  ).all({ ...params, now });
  const counts = new Map<ProjectId, number>();
  for (const row of rows) {
    const project = row.project_id as ProjectId;
    counts.set(project, (counts.get(project) ?? 0) + 1);
  }
  for (const [project, count] of counts)
    tx.events.append(project, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(project),
      type: "ext_message_history_invalidated",
      actor: { kind: "system", project_id: project },
      created_at: now,
      payload: { channel: name, count },
    });
}

export function afterExtWatermark(
  db: DatabaseSync,
  project: string,
  source: string,
  watermark: number,
) {
  return !!prepare(
    db,
    "SELECT 1 FROM events WHERE project_id=? AND id=? AND rowid>?",
  ).get(project, source, watermark);
}

/** Advisory outside a claim; authoritative only under the writer lock. */
export function extAttemptSlots(
  db: DatabaseSync,
  channel: string,
  at: number,
  limit: number,
) {
  const used = Number(
    prepare(
      db,
      "SELECT COUNT(*) AS n FROM ext_message_attempts WHERE channel=? AND at>?",
    ).get(channel, at - 60_000)?.n,
  );
  return Math.max(0, limit - used);
}

export function extAttemptAvailable(
  db: DatabaseSync,
  channel: string,
  at: number,
  limit: number,
) {
  return extAttemptSlots(db, channel, at, limit) > 0;
}

/** Called in the same IMMEDIATE transaction as the outbox lease. */
export function reserveExtAttempt(
  db: DatabaseSync,
  channel: string,
  at: number,
  limit: number,
  lease: string,
  sendBy: number,
) {
  prepare(db, "DELETE FROM ext_message_attempts WHERE channel=? AND at<=?").run(
    channel,
    at - 60_000,
  );
  if (!extAttemptAvailable(db, channel, at, limit)) return false;
  prepare(
    db,
    "INSERT INTO ext_message_attempts(lease,channel,at) VALUES(?,?,?)",
  ).run(lease, channel, sendBy);
  return true;
}

/** An unobserved dispatch stays charged through its send deadline plus a full window. */
export function finishExtAttempt(
  db: DatabaseSync,
  lease: string,
  finishedAt: number | null,
) {
  if (finishedAt === null)
    prepare(db, "DELETE FROM ext_message_attempts WHERE lease=?").run(lease);
  else
    prepare(db, "UPDATE ext_message_attempts SET at=? WHERE lease=?").run(
      finishedAt,
      lease,
    );
}

/** Snapshot the finite cohort at the first available slot, not at saturation:
 * new arrivals while the channel was full must be included, but later traffic
 * must not indefinitely postpone the already waiting recipients' summary. */
export function extRateBatch(db: DatabaseSync, channel: string): number | null {
  const row = prepare(
    db,
    "SELECT through FROM ext_message_rate_batches WHERE channel=?",
  ).get(channel);
  return row?.through != null ? Number(row.through) : null;
}
export function collectingExtRateBatch(db: DatabaseSync, channel: string) {
  return !!prepare(
    db,
    "SELECT 1 FROM ext_message_rate_batches WHERE channel=? AND through IS NULL",
  ).get(channel);
}
export function deferExtRateBatch(db: DatabaseSync, channel: string) {
  prepare(
    db,
    "INSERT OR IGNORE INTO ext_message_rate_batches(channel,through) VALUES(?,NULL)",
  ).run(channel);
}
export function openExtRateBatch(db: DatabaseSync, channel: string) {
  prepare(
    db,
    "UPDATE ext_message_rate_batches SET through=(SELECT COALESCE(MAX(rowid),0) FROM events) WHERE channel=? AND through IS NULL",
  ).run(channel);
}
export function closeExtRateBatch(
  db: DatabaseSync,
  channel: string,
  through: number,
) {
  // Rows that were quiet or temporarily ineligible still belong to an open
  // batch. Release the old source fence, not their durable summary marker.
  if (
    prepare(
      db,
      "SELECT 1 FROM ext_message_outbox WHERE channel=? AND digest_id='rate:queued' AND status='pending' LIMIT 1",
    ).get(channel)
  ) {
    prepare(
      db,
      "UPDATE ext_message_rate_batches SET through=NULL WHERE channel=? AND through=?",
    ).run(channel, through);
    return;
  }
  prepare(
    db,
    "DELETE FROM ext_message_rate_batches WHERE channel=? AND through=?",
  ).run(channel, through);
}

/** Last synchronous authorization before invoking a port; all members and the
 * recipient epoch must still belong to this attempt in one SQLite snapshot. */
export function ownsExtDispatch(
  db: DatabaseSync,
  name: string,
  epoch: string,
  lease: string,
  members: number,
  digest: string | null,
) {
  return !!prepare(
    db,
    `SELECT 1 FROM ext_message_channels WHERE name=? AND epoch=? AND
    (SELECT COUNT(*) FROM ext_message_outbox WHERE lease_id=? AND digest_id IS ? AND status='pending')=?`,
  ).get(name, epoch, lease, digest, members);
}
