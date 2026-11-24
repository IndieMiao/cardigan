import type { DatabaseSync } from "node:sqlite";
import {
  type CardId,
  type Event,
  EventLog,
  EventLogView,
  type ProjectId,
} from "@cardigan/domain";
import { prepare } from "./statements.js";

/** C-639: the Store's `listStreams` result (an immutable log view). */
export type EventStreams = EventLogView;

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
        .iterate(previous?.through ?? 0, through, project);
      // C-649: the first read decodes straight into a fresh log (no row array
      // or per-stream copy), which keeps the restart peak and RSS down.
      if (!previous) {
        const next = load(rows, through);
        pending.set(project, next);
        return next.view;
      }
      const added: Event[] = [];
      for (const row of rows)
        added.push(JSON.parse(row.doc as string) as Event);
      // Another project's rows move the watermark without changing this view.
      if (added.length === 0) {
        pending.set(project, { ...previous, through });
        return previous.view;
      }
      const next = extend(previous, added, through);
      pending.set(project, next);
      return next.view;
    };
    /**
     * C-649: decode at most `limit` more rows of this project, so a restart
     * can warm a large history in short slices. True once caught up with the
     * transaction's newest row.
     */
    const warm = (project: ProjectId, limit: number): boolean => {
      const max = Number(
        (
          db
            .prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM events")
            .get() as { n: number }
        ).n,
      );
      const previous = pending.get(project) ?? this.committed.get(project);
      const from = previous?.through ?? 0;
      if (from >= max) return true;
      let last = from;
      let count = 0;
      const rows = (function* () {
        for (const row of db
          .prepare(
            "SELECT rowid AS r, doc FROM events NOT INDEXED WHERE rowid > ? AND rowid <= ? AND project_id = ? ORDER BY rowid LIMIT ?",
          )
          .iterate(from, max, project, limit)) {
          last = Number(row.r);
          count++;
          yield row;
        }
      })();
      let next: Snapshot;
      if (previous) {
        const added: Event[] = [];
        for (const row of rows)
          added.push(JSON.parse(row.doc as string) as Event);
        const through = count < limit ? max : last;
        next = added.length
          ? extend(previous, added, through)
          : { ...previous, through };
      } else {
        next = load(rows, max);
        if (count >= limit) next = { ...next, through: last };
      }
      pending.set(project, next);
      return count < limit;
    };
    return {
      listStreams: (project: ProjectId): EventStreams => listStreams(project),
      warm,
      /**
       * C-640: the transaction's `events.listAfter` answered from the same
       * view (own writes included): no SQL scan or per-row JSON.parse.
       */
      listAfter: (
        project: ProjectId,
        card: CardId | undefined,
        since: number,
      ): readonly Event[] => listStreams(project).after(card ?? "", since),
      commit: () => {
        for (const [project, snapshot] of pending)
          this.committed.set(project, publish(snapshot));
      },
    };
  }
}

/**
 * First read of a project: append rows in commit order while every stream's
 * seq ascends (the normal case); otherwise fall back to the sorted rebuild.
 * The fresh log is private to this transaction until COMMIT publishes it.
 */
function load(
  rows: Iterable<Record<string, unknown>>,
  through: number,
): Snapshot {
  const log = new EventLog();
  let disordered: Event[] | undefined;
  for (const row of rows) {
    const event = JSON.parse(row.doc as string) as Event;
    if (disordered) {
      disordered.push(event);
      continue;
    }
    const seq = log.lastSeq(event.card_id ?? "");
    if (seq !== undefined && event.seq <= seq) {
      disordered = [...log.all, event];
      continue;
    }
    log.append(event);
  }
  if (disordered) return rebuild([], disordered, through);
  return { through, log, view: new EventLogView(log, log.end) };
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

/** C-639 host facts for the hot command state that live outside entity lists. */
export interface HotStateHints {
  /** The stream card of each existing event id; project-stream events map to undefined. */
  eventCards(
    project: ProjectId,
    ids: readonly string[],
  ): ReadonlyMap<string, string | undefined>;
  /** Cards with an undelivered or unresolved inbox notification. */
  liveNotificationCards(project: ProjectId): readonly string[];
  /** C-649: project-stream events with an undelivered or unresolved notification. */
  liveNotificationEvents(project: ProjectId): readonly string[];
}

export function hotStateHints(db: DatabaseSync): HotStateHints {
  return {
    eventCards: (project, ids) => {
      const found = new Map<string, string | undefined>();
      const byId = prepare(
        db,
        "SELECT card_id FROM events WHERE project_id = ? AND id = ?",
      );
      for (const id of ids) {
        const row = byId.get(project, id);
        if (row) found.set(id, (row.card_id as string | null) ?? undefined);
      }
      return found;
    },
    liveNotificationCards: (project) =>
      prepare(
        db,
        "SELECT DISTINCT card_id FROM notifications WHERE project_id = ? AND status IN ('pending','belled','delivery_failed','needs_attention') AND card_id IS NOT NULL",
      )
        .all(project)
        .map((row) => String(row.card_id)),
    liveNotificationEvents: (project) =>
      prepare(
        db,
        "SELECT DISTINCT event_id FROM notifications WHERE project_id = ? AND status IN ('pending','belled','delivery_failed','needs_attention') AND card_id IS NULL",
      )
        .all(project)
        .map((row) => String(row.event_id)),
  };
}
