import type { DatabaseSync } from "node:sqlite";
import {
  type CardId,
  type DormantLoader,
  type Event,
  EventLog,
  EventLogView,
  isProjectMergeEventType,
  type ProjectId,
} from "@cardigan/domain";
import { prepare } from "./statements.js";

/** C-639: the Store's `listStreams` result (an immutable log view). */
export type EventStreams = EventLogView;

/**
 * C-671 `slim`: rows that existed when a project was first read and belong to
 * a card closed at that time stay dormant (indexed, not kept decoded) unless
 * their type is resident. Later rows are always decoded.
 */
interface Dormancy {
  readonly closed: ReadonlySet<string>;
  /** Rowid watermark of the first read. */
  readonly until: number;
  /** C-796: rowids of dispatch records no journal read needs decoded. */
  readonly dispatch?: ReadonlySet<number>;
}

type Snapshot = {
  /** Global events rowid watermark this snapshot has read through. */
  through: number;
  dormancy?: Dormancy;
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

  /**
   * C-671: with `resident` (the `slim` scope), closed cards' rows of other
   * types load dormant and are decoded from the table when first read.
   * C-796: with `dispatch` (every scope but `full`), so do the GitHub
   * dispatch records `dormantDispatchRows` picks.
   */
  constructor(
    private readonly resident?: ReadonlySet<string>,
    private readonly dispatch = false,
  ) {}

  transaction(db: DatabaseSync) {
    const { resident, dispatch } = this;
    const first = (project: ProjectId, until: number) =>
      resident || dispatch
        ? firstRead(db, project, until, resident, dispatch)
        : undefined;
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
          "SELECT rowid AS r, doc FROM events NOT INDEXED WHERE rowid > ? AND rowid <= ? AND project_id = ? ORDER BY rowid",
        )
        .iterate(previous?.through ?? 0, through, project);
      // C-649: the first read decodes straight into a fresh log (no row array
      // or per-stream copy), which keeps the restart peak and RSS down.
      if (!previous) {
        const next = load(rows, through, first(project, through));
        pending.set(project, settled(next));
        return next.view;
      }
      const added = decode(rows, previous.dormancy);
      // Another project's rows move the watermark without changing this view.
      if (added.length === 0) {
        pending.set(project, settled({ ...previous, through }));
        return previous.view;
      }
      const next = extend(previous, added, through);
      pending.set(project, settled(next));
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
        const added = decode(rows, previous.dormancy);
        const through = count < limit ? max : last;
        next = added.length
          ? extend(previous, added, through)
          : { ...previous, through };
      } else {
        next = load(rows, max, first(project, max));
        if (count >= limit) next = { ...next, through: last };
      }
      pending.set(project, settled(next));
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
      /**
       * C-652: `projectMergeEvents` from the same view's type index, the same
       * rows as the SQL `type GLOB 'merge_batch_*'` read without parsing them.
       * C-774: before this connection has decoded the project's history, read
       * those few rows by the type index instead of decoding the whole log
       * (a closed card's detail must not pay a cold history load).
       */
      projectMergeEvents: (project: ProjectId): Event[] =>
        pending.has(project) || this.committed.has(project)
          ? listStreams(project).matching("", "type", isProjectMergeEventType)
          : prepare(
              db,
              "SELECT doc FROM events WHERE project_id = ? AND stream = '' AND (type = 'merge_queue_configured' OR type GLOB 'merge_batch_*') ORDER BY seq",
            )
              .all(project)
              .map((row) => JSON.parse(String(row.doc)) as Event),
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
  first?: { dormancy: Dormancy; loader: DormantLoader },
): Snapshot {
  const log = new EventLog();
  log.loader = first?.loader;
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
    if (first && dormant(first.dormancy, row, event)) log.appendDormant(event);
    else log.append(event);
  }
  // The rare rebuild decodes everything, so it needs no dormancy.
  if (disordered) return rebuild([], disordered, through);
  return {
    through,
    log,
    view: new EventLogView(log, log.end),
    ...(first ? { dormancy: first.dormancy } : {}),
  };
}

/**
 * C-796: once a snapshot has read through its first-read watermark, no later
 * row can be dormant, so the dormancy inputs (closed cards, dispatch rowids)
 * are dropped instead of being kept for the process lifetime.
 */
function settled(snapshot: Snapshot): Snapshot {
  if (!snapshot.dormancy || snapshot.through < snapshot.dormancy.until)
    return snapshot;
  const { dormancy: _done, ...rest } = snapshot;
  return rest;
}

/** C-671: whether a row read now stays dormant under `dormancy`. */
const dormant = (
  dormancy: Dormancy | undefined,
  row: Record<string, unknown>,
  event: Event,
) => {
  if (dormancy === undefined || Number(row.r) > dormancy.until) return false;
  if (dormancy.dispatch?.has(Number(row.r))) return true;
  const resident = RESIDENT.get(dormancy);
  return (
    resident !== undefined &&
    event.card_id !== undefined &&
    dormancy.closed.has(event.card_id) &&
    !resident.has(event.type)
  );
};
const RESIDENT = new WeakMap<Dormancy, ReadonlySet<string>>();

type Row = { readonly event: Event; readonly dormant: boolean };
function decode(
  rows: Iterable<Record<string, unknown>>,
  dormancy: Dormancy | undefined,
): Row[] {
  const added: Row[] = [];
  for (const row of rows) {
    const event = JSON.parse(row.doc as string) as Event;
    added.push({ event, dormant: dormant(dormancy, row, event) });
  }
  return added;
}

/**
 * C-671: the closed cards of a project's first read, and the reader that
 * decodes their dormant rows again by (stream, seq) — rows are never updated
 * or deleted, so the read returns what the log indexed.
 */
function firstRead(
  db: DatabaseSync,
  project: ProjectId,
  until: number,
  resident: ReadonlySet<string> | undefined,
  dispatch: boolean,
): { dormancy: Dormancy; loader: DormantLoader } {
  const closed = new Set(
    prepare(
      db,
      "SELECT id FROM cards WHERE project_id = ? AND json_extract(doc, '$.status') IN ('done', 'cancelled')",
    )
      .all(project)
      .map((row) => String(row.id)),
  );
  const dormancy: Dormancy = {
    closed,
    until,
    ...(dispatch
      ? { dispatch: dormantDispatchRows(db, project, until, closed) }
      : {}),
  };
  if (resident) RESIDENT.set(dormancy, resident);
  const loader: DormantLoader = (stream, seqs) => {
    const wanted = new Set(seqs);
    const found: Event[] = [];
    for (const row of prepare(
      db,
      "SELECT seq, doc FROM events WHERE project_id = ? AND stream = ? AND seq >= ? AND seq <= ? ORDER BY seq",
    ).iterate(project, stream, seqs[0] ?? 0, seqs.at(-1) ?? -1))
      if (wanted.has(Number(row.seq)))
        found.push(JSON.parse(row.doc as string) as Event);
    return found;
  };
  return { dormancy, loader };
}

/**
 * C-796: the project's GitHub dispatch records (rowid <= `until`) that stay
 * dormant. The journal reads only the newest system record of each attempt
 * (`Map.set(payload.attempt, …)` over a stream), so a record is dormant when
 *
 * - a later system record of the same stream, type and (string) attempt
 *   supersedes it; or
 * - it is that newest record on a card closed now, and retired: finished,
 *   and either cleaned up (`deleted`) or without a candidate ref. Such an
 *   intent holds no executor and no branch; the journal skips it while its
 *   card stays closed and decodes it again if the card reopens.
 *
 * Every other record (unfinished intents above all) stays decoded. Rows are
 * read in seq order per stream, the order the log keeps them in.
 */
function dormantDispatchRows(
  db: DatabaseSync,
  project: ProjectId,
  until: number,
  closed: ReadonlySet<string>,
): Set<number> {
  const rows = new Set<number>();
  type Newest = { r: number; retired: boolean };
  let group: string | undefined;
  let stream = "";
  let newest = new Map<string, Newest>();
  const flush = () => {
    if (closed.has(stream))
      for (const { r, retired } of newest.values()) if (retired) rows.add(r);
    newest = new Map();
  };
  for (const row of prepare(
    db,
    "SELECT rowid AS r, type, stream, json_extract(doc, '$.actor.kind', '$.payload.attempt', '$.payload.finished', '$.payload.deleted', '$.payload.candidate') AS f FROM events WHERE project_id = ? AND type IN ('github_check_dispatch', 'github_probe_dispatch') AND rowid <= ? ORDER BY type, stream, seq",
  ).iterate(project, until)) {
    const key = `${row.type as string}\u0000${row.stream as string}`;
    if (key !== group) {
      if (group !== undefined) flush();
      group = key;
      stream = row.stream as string;
    }
    const [actor, attempt, finished, deleted, candidate] = JSON.parse(
      row.f as string,
    ) as unknown[];
    if (actor !== "system" || typeof attempt !== "string") continue;
    const r = Number(row.r);
    const previous = newest.get(attempt);
    if (previous) rows.add(previous.r);
    newest.set(attempt, {
      r,
      retired:
        finished === true &&
        (deleted === true || candidate === null || candidate === undefined),
    });
  }
  if (group !== undefined) flush();
  return rows;
}

/** Append to the transaction overlay, or rebuild when a stream's seq goes back. */
function extend(
  previous: Snapshot,
  added: readonly Row[],
  through: number,
): Snapshot {
  const overlay = previous.overlay ?? new EventLog(previous.log.end);
  overlay.loader ??= previous.log.loader;
  const last = new Map<string, number | undefined>();
  const lastSeq = (stream: string) => {
    if (!last.has(stream))
      last.set(stream, overlay.lastSeq(stream) ?? previous.log.lastSeq(stream));
    return last.get(stream);
  };
  for (const { event } of added) {
    const stream = event.card_id ?? "";
    const seq = lastSeq(stream);
    if (seq !== undefined && event.seq <= seq)
      return rebuild(
        [previous.view],
        added.map((row) => row.event),
        through,
      );
    last.set(stream, event.seq);
  }
  for (const { event, dormant } of added)
    if (dormant) overlay.appendDormant(event);
    else overlay.append(event);
  return {
    ...(previous.dormancy ? { dormancy: previous.dormancy } : {}),
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
  log.appendLog(overlay);
  // Keep the transaction's view: base(< start) + overlay equals base(< end).
  return {
    ...(snapshot.dormancy ? { dormancy: snapshot.dormancy } : {}),
    through: snapshot.through,
    log,
    view: snapshot.view,
  };
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
