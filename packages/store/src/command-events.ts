import type { DatabaseSync } from "node:sqlite";
import {
  type CardId,
  type Event,
  EventLog,
  EventLogView,
  isProjectMergeEventType,
  type ProjectId,
} from "@cardigan/domain";

type Snapshot = {
  /** Global events rowid watermark this snapshot has read through. */
  through: number;
  /** Shared append-only log; only COMMIT appends to it. */
  log: EventLog;
  /** Transaction-local rows (other connections' and our own) not yet published. */
  overlay?: EventLog;
  view: EventLogView;
};

/**
 * Events are append-only. C-640: decoded history and its indexes are kept in a
 * per-project `EventLog` that grows in place, so a new event costs O(Δ): no
 * stream is copied or re-sorted. Rows read inside a transaction go to a
 * transaction-local overlay; COMMIT folds it into the shared log, ROLLBACK
 * drops it. Every `listStreams` result is an immutable `EventLogView`.
 */
export class CommandEvents {
  private committed = new Map<ProjectId, Snapshot>();

  transaction(db: DatabaseSync) {
    const pending = new Map<ProjectId, Snapshot>();
    const listStreams = (project: ProjectId): EventLogView => {
      const through = Number(
        (
          db
            .prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM events")
            .get() as { n: number }
        ).n,
      );
      const previous = pending.get(project) ?? this.committed.get(project);
      if (previous?.through === through) return previous.view;
      const rows = db
        .prepare(
          "SELECT doc FROM events NOT INDEXED WHERE rowid > ? AND rowid <= ? AND project_id = ? ORDER BY rowid",
        )
        .all(previous?.through ?? 0, through, project);
      // Another project's rows move the watermark without changing this view.
      if (previous && rows.length === 0) {
        pending.set(project, { ...previous, through });
        return previous.view;
      }
      const added = rows.map((row) => JSON.parse(row.doc as string) as Event);
      const next = previous
        ? extend(previous, added, through)
        : rebuild([], added, through);
      pending.set(project, next);
      return next.view;
    };
    return {
      listStreams: (
        project: ProjectId,
      ): ReadonlyMap<string, readonly Event[]> => listStreams(project),
      /**
       * C-640: the transaction's `events.listAfter` answered from the same
       * view (own writes included): no SQL scan or per-row JSON.parse.
       */
      listAfter: (
        project: ProjectId,
        card: CardId | undefined,
        since: number,
      ): readonly Event[] => listStreams(project).after(card ?? "", since),
      /**
       * C-652: `projectMergeEvents` from the same view's type index, the same
       * rows as the SQL `type GLOB 'merge_batch_*'` read without parsing them.
       */
      projectMergeEvents: (project: ProjectId): Event[] =>
        listStreams(project).matching("", "type", isProjectMergeEventType),
      commit: () => {
        for (const [project, snapshot] of pending)
          this.committed.set(project, publish(snapshot));
      },
    };
  }
}

/** Append to the transaction overlay, or rebuild when a stream's seq goes back. */
function extend(
  previous: Snapshot,
  added: readonly Event[],
  through: number,
): Snapshot {
  const overlay = previous.overlay ?? new EventLog(previous.log.end);
  const last = new Map<string, number | undefined>();
  const lastSeq = (stream: string) => {
    if (!last.has(stream))
      last.set(stream, overlay.lastSeq(stream) ?? previous.log.lastSeq(stream));
    return last.get(stream);
  };
  for (const event of added) {
    const stream = event.card_id ?? "";
    const seq = lastSeq(stream);
    if (seq !== undefined && event.seq <= seq)
      return rebuild([previous.view], added, through);
    last.set(stream, event.seq);
  }
  for (const event of added) overlay.append(event);
  return {
    through,
    log: previous.log,
    overlay,
    view: new EventLogView(
      previous.log,
      previous.log.end,
      overlay,
      overlay.end,
    ),
  };
}

/**
 * Rare path (fixtures, out-of-order seq): a fresh log in stream/seq order.
 * The new log is private to this transaction until COMMIT publishes it.
 */
function rebuild(
  views: readonly EventLogView[],
  added: readonly Event[],
  through: number,
): Snapshot {
  const streams = new Map<string, Event[]>();
  for (const view of views)
    for (const [key, events] of view) streams.set(key, [...events]);
  for (const event of added) {
    const key = event.card_id ?? "";
    const events = streams.get(key);
    if (events) events.push(event);
    else streams.set(key, [event]);
  }
  const log = new EventLog();
  for (const events of streams.values())
    for (const event of events.sort((a, b) => a.seq - b.seq)) log.append(event);
  return { through, log, view: new EventLogView(log, log.end) };
}

/** Fold a committed overlay into the shared log; older views keep their watermarks. */
function publish(snapshot: Snapshot): Snapshot {
  const { log, overlay } = snapshot;
  if (!overlay) return snapshot;
  if (log.end !== overlay.start) {
    // Defensive: never splice an overlay onto a log that moved underneath it.
    return rebuild([snapshot.view], [], snapshot.through);
  }
  for (const event of overlay.all) log.append(event);
  // Keep the transaction's view: base(< start) + overlay equals base(< end).
  return { through: snapshot.through, log, view: snapshot.view };
}
