import { createHash, randomUUID } from "node:crypto";
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

export const extEventWatermark = (db: DatabaseSync) =>
  Number(
    prepare(db, "SELECT COALESCE(MAX(rowid),0) AS n FROM events").get()!.n,
  );

// YAML identity alone cannot prove the state of its separate credential files.
// Consume the proof in the activation transaction so later rotations cannot rewind.
function takePublicationCutoff(db: DatabaseSync, publication?: string) {
  if (!publication) return;
  const row = prepare(
    db,
    "SELECT watermark,fingerprints FROM feishu_settings_publications WHERE publication=? AND fingerprints IS NOT NULL",
  ).get(publication);
  if (!row) return;
  prepare(
    db,
    "UPDATE feishu_settings_publications SET fingerprints=NULL WHERE publication=?",
  ).run(publication);
  return {
    watermark: Number(row.watermark),
    fingerprints: new Map<string, string>(JSON.parse(String(row.fingerprints))),
  };
}

/** Caller owns the configuration activation transaction. No raw settings are persisted. */
export function activateExtChannels(
  db: DatabaseSync,
  tx: StoreTransactionContext,
  fingerprints: Map<string, string>,
  now: string,
  publication?: string,
) {
  const receipt = takePublicationCutoff(db, publication);
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
    const matchesPublication = receipt?.fingerprints.get(name) === fingerprint;
    if (row?.fingerprint !== fingerprint || (receipt && !matchesPublication)) {
      const watermark =
        receipt && matchesPublication
          ? receipt.watermark
          : extEventWatermark(db);
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

/**
 * C-580: the stored key of a project filter scope. A digest, never the
 * identifier itself: the excluded list is free text in the private
 * configuration and must not leave it even when it holds a credential.
 */
export const extFilterProjectScope = (project: string) =>
  `project:${createHash("sha256").update(project).digest("hex")}`;

/**
 * C-580: record the push filter of the configuration being activated and
 * return the cutoff of every enabled scope. A scope switched from off to on
 * starts at the event position of the settings save that published this
 * configuration (the publication's recorded watermark), or of this
 * activation when no save is recorded (a hand-edited file). A scope without a
 * record compares against `defaults`, the filter in force before any record
 * existed. Project scopes no longer excluded are switched on. Caller owns the
 * activation transaction.
 */
export function activateExtFilterMarks(
  db: DatabaseSync,
  kinds: Readonly<Record<string, boolean>>,
  defaults: Readonly<Record<string, boolean>>,
  excludedProjects: readonly string[],
  publication?: string,
): Map<string, number> {
  const scopes = new Map<string, boolean>(
    Object.entries(kinds).map(([kind, on]) => [`kind:${kind}`, on]),
  );
  for (const row of prepare(
    db,
    "SELECT scope FROM ext_message_filter_marks WHERE scope GLOB 'project:*'",
  ).all())
    scopes.set(String(row.scope), true);
  for (const id of excludedProjects)
    scopes.set(extFilterProjectScope(id), false);
  const marks = new Map<string, number>();
  let cutoff: number | undefined;
  const switchedOn = () => {
    if (cutoff !== undefined) return cutoff;
    const saved = publication
      ? prepare(
          db,
          "SELECT watermark FROM feishu_settings_publications WHERE publication=?",
        ).get(publication)
      : undefined;
    cutoff = saved ? Number(saved.watermark) : extEventWatermark(db);
    return cutoff;
  };
  for (const [scope, on] of scopes) {
    const row = prepare(
      db,
      "SELECT enabled,watermark FROM ext_message_filter_marks WHERE scope=?",
    ).get(scope);
    const was = row
      ? Number(row.enabled) === 1
      : scope.startsWith("kind:")
        ? defaults[scope.slice("kind:".length)] !== false
        : true;
    let watermark = row ? Number(row.watermark) : 0;
    if (on && !was) watermark = switchedOn();
    if (!row || was !== on || Number(row.watermark) !== watermark)
      prepare(
        db,
        "INSERT OR REPLACE INTO ext_message_filter_marks(scope,enabled,watermark) VALUES(?,?,?)",
      ).run(scope, on ? 1 : 0, watermark);
    if (on) marks.set(scope, watermark);
  }
  return marks;
}

/**
 * C-580: the recorded filter (as last saved or activated) excludes this item.
 * Used to settle a send that was already in flight when the filter changed:
 * its failure must not become a retry or an undelivered notice.
 */
export function extFilterExcludes(
  db: DatabaseSync,
  project: string,
  kind: string,
  source: string,
): boolean {
  for (const scope of [`kind:${kind}`, extFilterProjectScope(project)]) {
    const row = prepare(
      db,
      "SELECT enabled,watermark FROM ext_message_filter_marks WHERE scope=?",
    ).get(scope);
    if (!row) continue;
    if (Number(row.enabled) !== 1) return true;
    const watermark = Number(row.watermark);
    if (watermark > 0 && !afterExtWatermark(db, project, source, watermark))
      return true;
  }
  return false;
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
