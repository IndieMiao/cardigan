import type { DatabaseSync } from "node:sqlite";
import type { Event, ProjectId } from "@cardigan/domain";
import { prepare } from "./statements.js";

/**
 * Streams not read for this many snapshot generations are dropped from the
 * decoded cache; a later read decodes them again from SQLite (C-639).
 */
const IDLE_GENERATIONS = 64;

/** Event streams of one project at one committed (or pending) `through` rowid. */
export interface EventStreams extends ReadonlyMap<string, readonly Event[]> {
  /** Highest events rowid this snapshot covers. */
  readonly through: number;
  /**
   * Events whose type is in `types` (or, with `exclude`, not in it), grouped
   * by stream in seq order. Built once per type set and maintained
   * incrementally; never decodes other rows.
   */
  ofTypes(
    types: ReadonlySet<string>,
    exclude?: boolean,
  ): ReadonlyMap<string, readonly Event[]>;
}

type Owner = {
  readonly db: DatabaseSync;
  readonly project: ProjectId;
  generation: number;
  readonly touched: Map<string, number>;
};
type Subset = {
  readonly types: ReadonlySet<string>;
  readonly exclude: boolean;
  readonly streams: Map<string, readonly Event[]>;
};

const none: readonly Event[] = Object.freeze([]);

function decode(doc: unknown): Event {
  return JSON.parse(doc as string) as Event;
}
type Row = Record<string, unknown> & { event?: Event };
/** One decoded object per row, shared by full streams and type subsets. */
const eventOf = (row: Row) => {
  row.event ??= decode(row.doc);
  return row.event;
};

/** Append rows read in rowid order; sort only when a writer interleaved seqs. */
function appendTo(
  streams: Map<string, readonly Event[]>,
  added: ReadonlyMap<string, Event[]>,
) {
  for (const [key, events] of added) {
    const before = streams.get(key) ?? none;
    const merged = [...before, ...events];
    let ordered = true;
    for (let i = Math.max(1, before.length); i < merged.length; i++)
      if ((merged[i - 1] as Event).seq > (merged[i] as Event).seq) {
        ordered = false;
        break;
      }
    streams.set(key, ordered ? merged : merged.sort((a, b) => a.seq - b.seq));
  }
}

function group(rows: readonly Row[], keep: (row: Row) => boolean) {
  const added = new Map<string, Event[]>();
  for (const row of rows) {
    if (!keep(row)) continue;
    const key = String(row.stream);
    let events = added.get(key);
    if (!events) {
      events = [];
      added.set(key, events);
    }
    events.push(eventOf(row));
  }
  return added;
}

class Snapshot implements EventStreams, ReadonlyMap<string, readonly Event[]> {
  readonly [Symbol.toStringTag] = "EventStreams";
  constructor(
    private readonly owner: Owner,
    readonly through: number,
    /** Decoded full streams; a cache of immutable rows at or below `through`. */
    readonly loaded: Map<string, readonly Event[]>,
    readonly subsets: Subset[],
  ) {}

  /** Same contract as the former eager map: absent when a stream has no events. */
  get(key: string): readonly Event[] | undefined {
    const { owner } = this;
    owner.touched.set(key, owner.generation);
    let events = this.loaded.get(key);
    if (!events) {
      const rows = prepare(
        owner.db,
        "SELECT doc FROM events WHERE project_id = ? AND stream = ? AND rowid <= ? ORDER BY seq",
      ).all(owner.project, key, this.through);
      events = rows.length ? rows.map((row) => decode(row.doc)) : none;
      this.loaded.set(key, events);
    }
    return events.length ? events : undefined;
  }
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }
  /** Streams in first-append order, like the former eager map. */
  keys(): MapIterator<string> {
    return prepare(
      this.owner.db,
      "SELECT stream FROM events WHERE project_id = ? AND rowid <= ? GROUP BY stream ORDER BY MIN(rowid)",
    )
      .all(this.owner.project, this.through)
      .map((row) => String(row.stream))
      .values();
  }
  get size(): number {
    return [...this.keys()].length;
  }
  *entries(): MapIterator<[string, readonly Event[]]> {
    for (const key of this.keys())
      yield [key, this.get(key) as readonly Event[]];
  }
  *values(): MapIterator<readonly Event[]> {
    for (const [, events] of this.entries()) yield events;
  }
  [Symbol.iterator]() {
    return this.entries();
  }
  forEach(
    fn: (
      value: readonly Event[],
      key: string,
      map: ReadonlyMap<string, readonly Event[]>,
    ) => void,
  ): void {
    for (const [key, events] of this.entries()) fn(events, key, this);
  }

  ofTypes(
    types: ReadonlySet<string>,
    exclude = false,
  ): ReadonlyMap<string, readonly Event[]> {
    const existing = this.subsets.find(
      (s) => s.exclude === exclude && sameTypes(s.types, types),
    );
    if (existing) return existing.streams;
    const list = [...types];
    const streams = new Map<string, readonly Event[]>();
    if (list.length || exclude) {
      const rows = prepare(
        this.owner.db,
        `SELECT stream, doc FROM events WHERE project_id = ? AND type ${exclude ? "NOT IN" : "IN"} (${list.map(() => "?").join(",")}) AND rowid <= ? ORDER BY rowid`,
      ).all(this.owner.project, ...list, this.through) as Row[];
      appendTo(
        streams,
        group(rows, () => true),
      );
    }
    this.subsets.push({ types: new Set(types), exclude, streams });
    return streams;
  }
}

function sameTypes(a: ReadonlySet<string>, b: ReadonlySet<string>) {
  if (a.size !== b.size) return false;
  for (const type of a) if (!b.has(type)) return false;
  return true;
}

/**
 * Events are append-only. Keep decoded streams lazily per stream, but publish
 * a new snapshot only on COMMIT (C-639: no eager decode of closed history).
 */
export class CommandEvents {
  private committed = new Map<ProjectId, Snapshot>();
  private owners = new Map<ProjectId, Owner>();

  private owner(db: DatabaseSync, project: ProjectId): Owner {
    let owner = this.owners.get(project);
    if (!owner || owner.db !== db) {
      owner = { db, project, generation: 0, touched: new Map() };
      this.owners.set(project, owner);
    }
    return owner;
  }

  transaction(db: DatabaseSync) {
    const pending = new Map<ProjectId, Snapshot>();
    return {
      listStreams: (project: ProjectId): EventStreams => {
        const through = Number(
          (
            prepare(
              db,
              "SELECT COALESCE(MAX(rowid), 0) AS n FROM events",
            ).get() as { n: number }
          ).n,
        );
        const previous = pending.get(project) ?? this.committed.get(project);
        if (previous?.through === through) return previous;
        const owner = this.owner(db, project);
        owner.generation++;
        const loaded = new Map<string, readonly Event[]>();
        const subsets: Subset[] = [];
        if (previous && previous.through < through) {
          for (const [key, events] of previous.loaded) {
            const seen = owner.touched.get(key) ?? 0;
            if (owner.generation - seen <= IDLE_GENERATIONS)
              loaded.set(key, events);
            else owner.touched.delete(key);
          }
          for (const subset of previous.subsets)
            subsets.push({ ...subset, streams: new Map(subset.streams) });
          const rows = prepare(
            db,
            "SELECT stream, type, doc FROM events NOT INDEXED WHERE rowid > ? AND rowid <= ? AND project_id = ? ORDER BY rowid",
          ).all(previous.through, through, project) as Row[];
          appendTo(
            loaded,
            group(rows, (row) => loaded.has(String(row.stream))),
          );
          for (const subset of subsets)
            appendTo(
              subset.streams,
              group(
                rows,
                (row) => subset.types.has(String(row.type)) !== subset.exclude,
              ),
            );
        }
        const snapshot = new Snapshot(owner, through, loaded, subsets);
        pending.set(project, snapshot);
        return snapshot;
      },
      commit: () => {
        for (const [project, snapshot] of pending)
          this.committed.set(project, snapshot);
      },
    };
  }
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
  };
}
