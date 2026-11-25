import type { Event } from "./entities.js";
import { isTelemetryEvent } from "./telemetry.js";

/**
 * C-640: append-only project event log with incremental indexes.
 *
 * The Store appends every decoded event exactly once (O(Δ) per event, no copy
 * or re-sort of a stream). Readers never see the mutable arrays: an
 * `EventLogView` is bounded by ordinal watermarks taken when it was created, so
 * a later append — committed or not — cannot change what an existing view, its
 * materialized arrays or its index answers contain. Uncommitted events live in
 * a separate overlay log that is folded into the base only on COMMIT; a
 * rolled-back overlay is simply dropped.
 *
 * History order is the CommandState contract: project stream first, then each
 * card stream in the caller's card order, seq ascending inside a stream.
 *
 * C-643: every stream is also kept split into business and telemetry segments,
 * so the telemetry-free command-state stream (`commandHistory`) and the
 * telemetry journal are concatenations like `history`, with the same filter.
 */

/** Index kinds kept per event; `type` is the event type, the rest payload fields. */
export type EventIndexKind =
  | "type"
  | "decision_id"
  | "human_action_id"
  | "completion_id"
  | "work_item_id"
  | "resume_work_items"
  | "batch";

/**
 * C-671: the `batch` index key of an event at batch level that names no
 * batch (`payload.level === "batch"` without `batch_id`).
 */
export const BATCH_LEVEL_KEY = "\u0000level";

const FIELDS = [
  "decision_id",
  "human_action_id",
  "completion_id",
  "work_item_id",
] as const;

/** Index keys to select: a list, or a predicate over the keys present. */
export type IndexKeys = readonly unknown[] | ((key: unknown) => boolean);

/** Keys `EventLog.append` indexes the event under for `kind`. */
export function indexKeysOf(
  event: Event,
  kind: EventIndexKind,
): readonly unknown[] {
  if (kind === "type") return [event.type];
  const payload = event.payload as Record<string, unknown> | null;
  if (!payload || typeof payload !== "object") return [];
  // C-671: merge batch evidence, for batch read scopes (any `batch_id` value).
  if (kind === "batch")
    return payload.batch_id !== undefined
      ? [payload.batch_id]
      : payload.level === "batch"
        ? [BATCH_LEVEL_KEY]
        : [];
  const value = payload[kind];
  if (kind === "resume_work_items") return Array.isArray(value) ? value : [];
  return typeof value === "string" ? [value] : [];
}

/**
 * C-671: an event the Store indexed but did not keep decoded (a closed card's
 * event of a type that no hot path reads). It carries what indexes and history
 * filters look at; the first reader that needs the event itself makes its log
 * decode the stream's dormant events through `EventLog.loader`. Every array or
 * answer handed out holds decoded events only.
 */
export class DormantEvent {
  constructor(
    readonly id: string,
    readonly seq: number,
    readonly type: string,
    readonly card_id: string | undefined,
    /** Payload index keys, in `append` order, so another log can re-index it. */
    readonly keys: readonly (readonly [EventIndexKind, unknown])[],
  ) {}
}
type Entry = Event | DormantEvent;
/** What history filters and stream lookups read: decoded or dormant alike. */
type Head = {
  readonly id: string;
  readonly type: string;
  readonly card_id?: string | undefined;
};
/**
 * C-671: the Store's reader of dormant events: the events of `stream` with
 * these seqs (ascending), in the same order. Rows are immutable, so a later
 * read returns what the log indexed.
 */
export type DormantLoader = (
  stream: string,
  seqs: readonly number[],
) => readonly Event[];

type Seg = { readonly events: Entry[]; readonly ords: number[] };
/**
 * Per-stream ordinals of one index key (events resolve through `EventLog.at`);
 * `total` counts every entry appended.
 */
class Bucket extends Map<string, number[]> {
  total = 0;
}
type Results = Map<
  string,
  Map<unknown, { total: number; events: readonly Event[] }>
>;

const streamOf = (event: Pick<Head, "card_id">) => event.card_id ?? "";
const noEvents: readonly Event[] = Object.freeze([]);

/**
 * C-639 hot history: the project stream and streams in `full` keep every
 * event; any other stream drops events whose type is in `omit`.
 */
export interface HistoryFilter {
  readonly full: ReadonlySet<string>;
  readonly omit: ReadonlySet<string>;
  /**
   * C-671: when set, streams outside `full` also drop every type not in
   * `keep` (the cold-card whitelist).
   */
  readonly keep?: ReadonlySet<string>;
  /**
   * C-649: project-stream events left out by id (retention). Reuse the same
   * set object while it does not change: views share answers by its identity.
   */
  readonly dropped?: ReadonlySet<string>;
}

/**
 * Cache key of a type set; insertion order, no sort. Equal sets built in a
 * different order only miss the cache, distinct sets never share a key.
 */
const typesKey = (values: Iterable<string>) => [...values].join("\u0000");
const droppedSets = new WeakMap<ReadonlySet<string>, number>();
let droppedSerial = 0;
/** Identity token of a dropped-id set; empty sets drop nothing and share one. */
const droppedKey = (dropped: ReadonlySet<string> | undefined) => {
  if (!dropped?.size) return "";
  let serial = droppedSets.get(dropped);
  if (serial === undefined) {
    serial = ++droppedSerial;
    droppedSets.set(dropped, serial);
  }
  return String(serial);
};
/** Which streams of `order` the filter trims, plus its omitted types. */
const filterKey = (order: readonly string[], filter?: HistoryFilter) => {
  if (!filter) return "";
  let flags = "";
  for (const stream of order)
    flags += stream !== "" && !filter.full.has(stream) ? "1" : "0";
  const keep = filter.keep ? typesKey(filter.keep) : "*";
  return `${flags}\u0001${typesKey(filter.omit)}\u0004${keep}\u0003${droppedKey(filter.dropped)}`;
};
/**
 * C-671: lookups on a history answer over the history without its `keep`
 * whitelist: the whitelist bounds what scans of the array see, while indexed
 * lookups decode the dormant events they ask for.
 */
const lookupFilter = (filter: HistoryFilter | undefined) =>
  filter?.keep
    ? {
        full: filter.full,
        omit: filter.omit,
        ...(filter.dropped ? { dropped: filter.dropped } : {}),
      }
    : filter;
/** Whether `filter` trims `type` from the streams outside `filter.full`. */
const trims = (filter: HistoryFilter, type: string) =>
  filter.omit.has(type) ||
  (filter.keep !== undefined && !filter.keep.has(type));
/** Whether `filter` removes `event` (on stream `stream`) from a history. */
const filtered = (
  filter: HistoryFilter | undefined,
  stream: string,
  event: Head,
) =>
  filter !== undefined &&
  (stream === ""
    ? filter.dropped?.has(event.id) === true
    : !filter.full.has(stream) && trims(filter, event.type));

function push(
  segments: Map<string, Seg>,
  stream: string,
  event: Entry,
  ord: number,
) {
  const seg = segments.get(stream);
  if (seg) {
    seg.events.push(event);
    seg.ords.push(ord);
  } else segments.set(stream, { events: [event], ords: [ord] });
}

/** Number of leading ordinals below `limit` (ordinals ascend inside a segment). */
function below(ords: readonly number[], limit: number): number {
  const n = ords.length;
  if (n === 0 || (ords[n - 1] as number) < limit) return n;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((ords[mid] as number) < limit) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Mutable, append-only storage. Only the Store (or a test) appends; ordinals
 * are `start`, `start + 1`, … in append order.
 */
export class EventLog {
  readonly streams = new Map<string, Seg>();
  /** C-643: the same streams without telemetry. */
  readonly commandStreams = new Map<string, Seg>();
  /** C-643: only the telemetry of each stream. */
  readonly telemetryStreams = new Map<string, Seg>();
  readonly ids = new Map<string, number>();
  readonly #all: Entry[] = [];
  readonly buckets = new Map<EventIndexKind, Map<unknown, Bucket>>();
  /** Base-only materialized stream prefixes, shared by views with equal prefixes. */
  readonly materialized = new Map<
    string,
    { count: number; events: readonly Event[] }
  >();
  /**
   * C-639: base-only stream prefixes without one omitted type set, per C-643
   * partition (keyed by partition, then stream).
   */
  readonly trimmed = new Map<
    string,
    {
      count: number;
      omit: ReadonlySet<string>;
      keep: ReadonlySet<string> | undefined;
      events: readonly Event[];
    }
  >();
  /**
   * Answers computed by head views for the latest history order, reused while
   * the key's bucket has not grown (unchanged keys stay O(1) across appends).
   */
  results: { order: string; answers: Results } | undefined;
  /** C-671: decodes dormant events; the Store sets it before appending any. */
  loader: DormantLoader | undefined;
  /** C-671: dormant entries not decoded yet, per stream. */
  readonly #dormant = new Map<string, number>();
  constructor(readonly start = 0) {}

  get end(): number {
    return this.start + this.#all.length;
  }

  /** Every event in append order (decodes dormant ones: rare paths and tests). */
  get all(): readonly Event[] {
    for (const stream of [...this.#dormant.keys()]) this.resolve(stream);
    return this.#all as Event[];
  }

  lastSeq(stream: string): number | undefined {
    return this.streams.get(stream)?.events.at(-1)?.seq;
  }

  append(event: Event): void {
    const ord = this.#add(event);
    const stream = streamOf(event);
    const payload = event.payload as Record<string, unknown> | null;
    if (payload && typeof payload === "object") {
      for (const field of FIELDS) {
        const value = payload[field];
        if (typeof value === "string") this.#index(field, value, stream, ord);
      }
      const resume = payload.resume_work_items;
      if (Array.isArray(resume))
        for (const value of resume)
          this.#index("resume_work_items", value, stream, ord);
      for (const key of indexKeysOf(event, "batch"))
        this.#index("batch", key, stream, ord);
    }
  }

  /**
   * C-671: index `event` exactly like `append`, but keep only a dormant
   * stand-in; `loader` decodes it again when a reader needs it.
   */
  appendDormant(event: Event): void {
    const keys: [EventIndexKind, unknown][] = [];
    for (const kind of FIELDS)
      for (const key of indexKeysOf(event, kind)) keys.push([kind, key]);
    for (const key of indexKeysOf(event, "resume_work_items"))
      keys.push(["resume_work_items", key]);
    for (const key of indexKeysOf(event, "batch")) keys.push(["batch", key]);
    this.#addDormant(
      new DormantEvent(event.id, event.seq, event.type, event.card_id, keys),
    );
  }

  /** Append every entry of `other` (a committed overlay), dormant ones included. */
  appendLog(other: EventLog): void {
    this.loader ??= other.loader;
    for (const entry of other.#all)
      if (entry instanceof DormantEvent) this.#addDormant(entry);
      else this.append(entry);
  }

  #addDormant(entry: DormantEvent) {
    const ord = this.#add(entry);
    const stream = streamOf(entry);
    for (const [kind, key] of entry.keys) this.#index(kind, key, stream, ord);
    this.#dormant.set(stream, (this.#dormant.get(stream) ?? 0) + 1);
  }

  /** Stream, ids and type index of one entry; returns its ordinal. */
  #add(entry: Entry): number {
    const ord = this.end;
    const stream = streamOf(entry);
    this.#all.push(entry);
    push(this.streams, stream, entry, ord);
    push(
      isTelemetryEvent(entry) ? this.telemetryStreams : this.commandStreams,
      stream,
      entry,
      ord,
    );
    if (!this.ids.has(entry.id)) this.ids.set(entry.id, ord);
    this.#index("type", entry.type, stream, ord);
    return ord;
  }

  #index(kind: EventIndexKind, key: unknown, stream: string, ord: number) {
    let keys = this.buckets.get(kind);
    if (!keys) {
      keys = new Map();
      this.buckets.set(kind, keys);
    }
    let bucket = keys.get(key);
    if (!bucket) {
      bucket = new Bucket();
      keys.set(key, bucket);
    }
    bucket.total++;
    const ords = bucket.get(stream);
    if (ords) ords.push(ord);
    else bucket.set(stream, [ord]);
  }

  /** C-671: how many entries are still dormant. */
  get dormant(): number {
    let n = 0;
    for (const count of this.#dormant.values()) n += count;
    return n;
  }

  /** C-671: whether `stream` still holds dormant entries. */
  hasDormant(stream: string): boolean {
    return this.#dormant.has(stream);
  }

  /**
   * C-671: decode the stream's dormant entries in place, or only those at
   * `ords`. Ordinals and indexes stay as they are; views see the same events,
   * now decoded. One loader call per stream.
   */
  resolve(stream: string, ords?: readonly number[]): void {
    if (!this.#dormant.has(stream)) return;
    const seg = this.streams.get(stream) as Seg;
    const at: number[] = [];
    if (ords) {
      const found = new Set<number>();
      for (const ord of ords) {
        const i = below(seg.ords, ord);
        if (seg.ords[i] === ord && seg.events[i] instanceof DormantEvent)
          found.add(i);
      }
      at.push(...[...found].sort((a, b) => a - b));
    } else
      for (let i = 0; i < seg.events.length; i++)
        if (seg.events[i] instanceof DormantEvent) at.push(i);
    if (!at.length) return;
    const loader = this.loader;
    if (!loader) throw new Error("C-671: dormant events without a loader");
    const loaded = loader(
      stream,
      at.map((i) => (seg.events[i] as DormantEvent).seq),
    );
    if (loaded.length !== at.length)
      throw new Error(`C-671: stream ${stream} lost dormant events`);
    for (const [k, i] of at.entries()) {
      const dormant = seg.events[i] as DormantEvent;
      const event = loaded[k] as Event;
      if (
        event.id !== dormant.id ||
        event.seq !== dormant.seq ||
        event.type !== dormant.type ||
        streamOf(event) !== stream
      )
        throw new Error(`C-671: stream ${stream} changed under its log`);
      const ord = seg.ords[i] as number;
      this.#all[ord - this.start] = event;
      seg.events[i] = event;
      const part = (
        isTelemetryEvent(event) ? this.telemetryStreams : this.commandStreams
      ).get(stream) as Seg;
      part.events[below(part.ords, ord)] = event;
    }
    const left = (this.#dormant.get(stream) as number) - at.length;
    if (left > 0) this.#dormant.set(stream, left);
    else this.#dormant.delete(stream);
  }

  /**
   * C-671: decode the dormant entries among the first `n` of `seg` (a segment
   * of this log's `stream`, any partition) that `wanted` accepts.
   */
  decodeWhere(
    stream: string,
    seg: {
      readonly events: readonly Entry[];
      readonly ords: readonly number[];
    },
    n: number,
    wanted?: (entry: Head) => boolean,
  ): void {
    if (!this.#dormant.has(stream)) return;
    const ords: number[] = [];
    for (let i = 0; i < n; i++) {
      const entry = seg.events[i] as Entry;
      if (entry instanceof DormantEvent && (!wanted || wanted(entry)))
        ords.push(seg.ords[i] as number);
    }
    if (ords.length) this.resolve(stream, ords);
  }

  /** Event by ordinal, for ordinals owned by this log (C-671: decoded on demand). */
  at(ord: number): Event | undefined {
    const entry = this.#all[ord - this.start];
    if (!(entry instanceof DormantEvent)) return entry;
    this.resolve(streamOf(entry), [ord]);
    return this.#all[ord - this.start] as Event;
  }

  /** C-671: the entry at `ord` without decoding it (filters look at type and id). */
  entryAt(ord: number): Event | DormantEvent | undefined {
    return this.#all[ord - this.start];
  }
}

/** Stream segments of one log: all events, or one C-643 partition of them. */
type Partition = "streams" | "commandStreams" | "telemetryStreams";

const sameOrder = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/** Indexed lookups over one materialized history array (see `attachEventIndex`). */
export interface HistoryIndex {
  query(kind: EventIndexKind, key: unknown): readonly Event[];
  card(card: string, type: string): readonly Event[];
  byId(id: string): Event | undefined;
  /** C-649: events of any of `types`, in history order (duplicates ignored). */
  ofTypes(types: readonly string[]): readonly Event[];
  /** C-649: the events of one stream ("" is the project stream), in history order. */
  stream(stream: string): readonly Event[];
  /** C-649: the events of one stream with this seq, in history order. */
  atSeq(stream: string, seq: number): readonly Event[];
  /** C-671: the events with any key of `kind`, in history order. */
  keyed(kind: EventIndexKind): readonly Event[];
}

/**
 * Immutable read view: base events with ordinal < `baseEnd`, then overlay
 * events with ordinal < `end`. Implements the Store's `listStreams` map.
 */
export class EventLogView implements ReadonlyMap<string, readonly Event[]> {
  readonly #streams = new Map<string, readonly Event[]>();
  #keys: readonly string[] | undefined;
  readonly #histories = new Map<
    Partition,
    { order: readonly string[]; filter: string; events: readonly Event[] }
  >();
  #index:
    | { order: readonly string[]; filter: string; index: ViewIndex }
    | undefined;
  #subsets: Map<string, ReadonlyMap<string, readonly Event[]>> | undefined;
  constructor(
    readonly base: EventLog,
    readonly baseEnd: number,
    readonly overlay?: EventLog,
    readonly end: number = baseEnd,
  ) {}

  #segment(log: EventLog | undefined, stream: string, limit: number) {
    const seg = log?.streams.get(stream);
    return seg ? below(seg.ords, limit) : 0;
  }

  /** Stream keys in first-append order, limited to streams this view contains. */
  keys(): MapIterator<string> {
    if (!this.#keys) {
      const keys: string[] = [];
      for (const [key, seg] of this.base.streams)
        if ((seg.ords[0] as number) < this.baseEnd) keys.push(key);
      if (this.overlay)
        for (const [key, seg] of this.overlay.streams)
          if (
            (seg.ords[0] as number) < this.end &&
            !this.#segment(this.base, key, this.baseEnd)
          )
            keys.push(key);
      this.#keys = keys;
    }
    return this.#keys[Symbol.iterator]() as MapIterator<string>;
  }

  get size(): number {
    return [...this.keys()].length;
  }

  /**
   * Same as `events.listAfter(project, stream || undefined, since)`: the
   * stream's events with seq > `since`, seq ascending, in a fresh array.
   */
  after(stream: string, since: number): Event[] {
    const out: Event[] = [];
    const take = (log: EventLog | undefined, limit: number) => {
      const seg = log?.streams.get(stream);
      if (!log || !seg) return;
      const n = below(seg.ords, limit);
      let lo = 0;
      let hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if ((seg.events[mid] as Entry).seq <= since) lo = mid + 1;
        else hi = mid;
      }
      // C-671: a read past the cursor decodes dormant events; an empty one does not.
      if (lo < n)
        log.decodeWhere(
          stream,
          { events: seg.events.slice(lo, n), ords: seg.ords.slice(lo, n) },
          n - lo,
        );
      for (let i = lo; i < n; i++) out.push(seg.events[i] as Event);
    };
    take(this.base, this.baseEnd);
    take(this.overlay, this.end);
    return out;
  }

  has(key: string): boolean {
    return (
      this.#segment(this.base, key, this.baseEnd) > 0 ||
      this.#segment(this.overlay, key, this.end) > 0
    );
  }

  get(key: string): readonly Event[] | undefined {
    const known = this.#streams.get(key);
    if (known) return known;
    const own = this.#segment(this.base, key, this.baseEnd);
    const extra = this.#segment(this.overlay, key, this.end);
    if (!own && !extra) return undefined;
    let events: readonly Event[];
    const shared = this.base.materialized.get(key);
    if (shared?.count === own && !extra) events = shared.events;
    else {
      // C-671: a whole stream is a read of every event in it.
      this.base.resolve(key);
      this.overlay?.resolve(key);
      const head = (this.base.streams.get(key)?.events.slice(0, own) ??
        []) as Event[];
      const tail = this.overlay?.streams.get(key)?.events.slice(0, extra) as
        | Event[]
        | undefined;
      events = tail?.length ? head.concat(tail) : head;
      if (!extra) this.base.materialized.set(key, { count: own, events });
    }
    this.#streams.set(key, events);
    return events;
  }

  *values(): MapIterator<readonly Event[]> {
    for (const key of this.keys()) yield this.get(key) as readonly Event[];
  }

  *entries(): MapIterator<[string, readonly Event[]]> {
    for (const key of this.keys())
      yield [key, this.get(key) as readonly Event[]];
  }

  [Symbol.iterator](): MapIterator<[string, readonly Event[]]> {
    return this.entries();
  }

  forEach(
    fn: (
      value: readonly Event[],
      key: string,
      map: ReadonlyMap<string, readonly Event[]>,
    ) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.entries())
      fn.call(thisArg, value, key, this);
  }

  /**
   * Flat history in `order` (one pass, no sort) with its index attached, so
   * `eventsOfType` and friends answer from the log instead of rebuilding.
   * The same order (and filter) returns the same array. C-639: `filter`
   * drops omitted types from streams outside `filter.full`, index included.
   */
  history(order: readonly string[], filter?: HistoryFilter): readonly Event[] {
    return this.#history("streams", order, filter);
  }

  /**
   * C-643: `history(order, filter)` without telemetry. It carries the same
   * index as that history, so lookups keep answering over every kept event.
   */
  commandHistory(
    order: readonly string[],
    filter?: HistoryFilter,
  ): readonly Event[] {
    return this.#history("commandStreams", order, filter);
  }

  /** C-643: only the telemetry of `history(order, filter)`, in the same order. */
  telemetryHistory(
    order: readonly string[],
    filter?: HistoryFilter,
  ): readonly Event[] {
    return this.#history("telemetryStreams", order, filter);
  }

  #history(
    partition: Partition,
    order: readonly string[],
    filter?: HistoryFilter,
  ): readonly Event[] {
    const key = filterKey(order, filter);
    const cached = this.#histories.get(partition);
    if (cached?.filter === key && sameOrder(cached.order, order))
      return cached.events;
    // One exact-size concat over the segments; no per-event push or sort.
    const parts: (readonly Event[])[] = [];
    const part = (
      log: EventLog | undefined,
      stream: string,
      seg: Seg | undefined,
      limit: number,
    ) => {
      if (!log || !seg) return;
      const n = below(seg.ords, limit);
      if (!n) return;
      log.decodeWhere(stream, seg, n);
      parts.push(
        (n === seg.events.length
          ? seg.events
          : seg.events.slice(0, n)) as Event[],
      );
    };
    const trim = (
      log: EventLog | undefined,
      stream: string,
      seg: Seg | undefined,
      limit: number,
    ) => {
      if (!log || !seg || !filter) return;
      const n = below(seg.ords, limit);
      const kept: Event[] = [];
      // C-671: trimmed dormant events are never decoded.
      const keeps = (entry: Head) => !trims(filter, entry.type);
      log.decodeWhere(stream, seg, n, keeps);
      for (let i = 0; i < n; i++)
        if (keeps(seg.events[i] as Entry)) kept.push(seg.events[i] as Event);
      if (kept.length) parts.push(kept);
    };
    for (const stream of order) {
      if (filter && stream !== "" && !filter.full.has(stream)) {
        // Base prefix is shared across views while the stream does not grow.
        const seg = this.base[partition].get(stream);
        const own = seg ? below(seg.ords, this.baseEnd) : 0;
        const trimmedKey =
          partition === "streams" ? stream : `${partition}\u0000${stream}`;
        const shared = this.base.trimmed.get(trimmedKey);
        if (
          shared &&
          shared.count === own &&
          shared.omit === filter.omit &&
          shared.keep === filter.keep
        ) {
          if (shared.events.length) parts.push(shared.events);
        } else if (own) {
          const before = parts.length;
          trim(this.base, stream, seg, this.baseEnd);
          this.base.trimmed.set(trimmedKey, {
            count: own,
            omit: filter.omit,
            keep: filter.keep,
            events:
              parts.length > before ? (parts.at(-1) as Event[]) : noEvents,
          });
        }
        trim(
          this.overlay,
          stream,
          this.overlay?.[partition].get(stream),
          this.end,
        );
        continue;
      }
      const dropped = stream === "" ? filter?.dropped : undefined;
      if (dropped?.size) {
        // C-649: project-stream retention removes these events by id.
        for (const [log, limit] of [
          [this.base, this.baseEnd],
          [this.overlay, this.end],
        ] as const) {
          const seg = log?.[partition].get(stream);
          if (!log || !seg) continue;
          const n = below(seg.ords, limit);
          const kept: Event[] = [];
          const keeps = (entry: Head) => !dropped.has(entry.id);
          log.decodeWhere(stream, seg, n, keeps);
          for (let i = 0; i < n; i++)
            if (keeps(seg.events[i] as Entry))
              kept.push(seg.events[i] as Event);
          if (kept.length) parts.push(kept);
        }
        continue;
      }
      part(this.base, stream, this.base[partition].get(stream), this.baseEnd);
      part(
        this.overlay,
        stream,
        this.overlay?.[partition].get(stream),
        this.end,
      );
    }
    const events = ([] as Event[]).concat(...parts);
    // The telemetry list is a plain journal; lookups go through the others.
    if (partition !== "telemetryStreams")
      attachEventIndex(events, this.#indexFor(order, lookupFilter(filter)));
    this.#histories.set(partition, { order: [...order], filter: key, events });
    return events;
  }

  /** One index per order and filter, shared by the full and partitioned histories. */
  #indexFor(
    order: readonly string[],
    filter: HistoryFilter | undefined,
  ): ViewIndex {
    const key = filterKey(order, filter);
    const cached = this.#index;
    if (cached?.filter === key && sameOrder(cached.order, order))
      return cached.index;
    const index = new ViewIndex(this, order, filter, key);
    this.#index = { order: [...order], filter: key, index };
    return index;
  }

  /**
   * C-639: events whose type is in `types`, grouped by stream in seq order;
   * streams without one are absent. Answered from the type index.
   */
  ofTypes(types: ReadonlySet<string>): ReadonlyMap<string, readonly Event[]> {
    const key = typesKey(types);
    this.#subsets ??= new Map();
    const known = this.#subsets.get(key);
    if (known) return known;
    const ords = (log: EventLog | undefined, limit: number) => {
      const found = new Map<string, number[]>();
      if (!log) return found;
      const index = log.buckets.get("type");
      for (const type of types) {
        const bucket = index?.get(type);
        if (!bucket) continue;
        for (const [stream, list] of bucket) {
          const n = below(list, limit);
          if (!n) continue;
          const into = found.get(stream);
          if (into) for (let i = 0; i < n; i++) into.push(list[i] as number);
          else found.set(stream, list.slice(0, n));
        }
      }
      return found;
    };
    const own = ords(this.base, this.baseEnd);
    const extra = ords(this.overlay, this.end);
    const streams = new Map<string, readonly Event[]>();
    for (const stream of new Set([...own.keys(), ...extra.keys()])) {
      // Ordinals ascend with seq inside a stream; several types interleave.
      const events: Event[] = [];
      const a = own.get(stream);
      if (a) {
        if (types.size > 1) a.sort((x, y) => x - y);
        this.base.resolve(stream, a);
        for (const ord of a) events.push(this.base.entryAt(ord) as Event);
      }
      const b = extra.get(stream);
      if (b && this.overlay) {
        if (types.size > 1) b.sort((x, y) => x - y);
        this.overlay.resolve(stream, b);
        for (const ord of b) events.push(this.overlay.entryAt(ord) as Event);
      }
      streams.set(stream, events);
    }
    this.#subsets.set(key, streams);
    return streams;
  }

  /**
   * Bucket segments of this view in history `rank` order. C-671: entries
   * `skip` rejects (by stream, id and type) are left out without decoding.
   */
  collect(
    rank: ReadonlyMap<string, number>,
    pick: (log: EventLog) => ReadonlyMap<string, number[]> | undefined,
    skip?: (stream: string, entry: Head) => boolean,
  ): readonly Event[] {
    const own = pick(this.base);
    const extra = this.overlay ? pick(this.overlay) : undefined;
    if (!own && !extra) return noEvents;
    const streams: string[] = [];
    if (own)
      for (const stream of own.keys())
        if (rank.has(stream)) streams.push(stream);
    if (extra)
      for (const stream of extra.keys())
        if (rank.has(stream) && !own?.has(stream)) streams.push(stream);
    if (streams.length > 1)
      streams.sort((a, b) => (rank.get(a) as number) - (rank.get(b) as number));
    const events: Event[] = [];
    const take = (log: EventLog, stream: string, ords: number[], n: number) => {
      const kept: number[] = [];
      let dormant = false;
      for (let i = 0; i < n; i++) {
        const ord = ords[i] as number;
        const entry = log.entryAt(ord) as Entry;
        if (skip?.(stream, entry)) continue;
        kept.push(ord);
        if (entry instanceof DormantEvent) dormant = true;
      }
      if (dormant) log.resolve(stream, kept);
      for (const ord of kept) events.push(log.entryAt(ord) as Event);
    };
    for (const stream of streams) {
      const a = own?.get(stream);
      if (a) take(this.base, stream, a, below(a, this.baseEnd));
      const b = extra?.get(stream);
      if (b && this.overlay) take(this.overlay, stream, b, below(b, this.end));
    }
    return events.length ? events : noEvents;
  }

  /**
   * C-652: the stream's events indexed under `kind` with a key in `keys`, seq
   * ascending, in a fresh array. Same as filtering `after(stream, 0)` with
   * `indexKeysOf`, but touches only the matching events.
   */
  matching(stream: string, kind: EventIndexKind, keys: IndexKeys): Event[] {
    const out: Event[] = [];
    const take = (log: EventLog | undefined, limit: number) => {
      const buckets = log?.buckets.get(kind);
      if (!log || !buckets) return;
      const lists: (readonly number[])[] = [];
      const add = (bucket: Bucket | undefined) => {
        const ords = bucket?.get(stream);
        if (ords) lists.push(ords);
      };
      if (typeof keys === "function") {
        for (const [key, bucket] of buckets) if (keys(key)) add(bucket);
      } else for (const key of keys) add(buckets.get(key));
      if (!lists.length) return;
      const ords =
        lists.length === 1
          ? (lists[0] as readonly number[])
          : lists.flat().sort((a, b) => a - b);
      const n = below(ords, limit);
      // One event can sit in a bucket twice (repeated resume_work_items).
      const kept: number[] = [];
      let last = -1;
      for (let i = 0; i < n; i++) {
        const ord = ords[i] as number;
        if (ord === last) continue;
        last = ord;
        kept.push(ord);
      }
      log.resolve(stream, kept);
      for (const ord of kept) out.push(log.entryAt(ord) as Event);
    };
    take(this.base, this.baseEnd);
    take(this.overlay, this.end);
    return out;
  }

  /** The view's event with this id, if any (event ids are unique per project). */
  eventWithId(id: string): Event | undefined {
    const ord = this.base.ids.get(id);
    if (ord !== undefined && ord < this.baseEnd) return this.base.at(ord);
    const extra = this.overlay?.ids.get(id);
    if (extra !== undefined && extra < this.end) return this.overlay?.at(extra);
    return undefined;
  }

  /** C-671: `eventWithId` without decoding a dormant entry. */
  entryWithId(id: string): Head | undefined {
    const ord = this.base.ids.get(id);
    if (ord !== undefined && ord < this.baseEnd) return this.base.entryAt(ord);
    const extra = this.overlay?.ids.get(id);
    if (extra !== undefined && extra < this.end)
      return this.overlay?.entryAt(extra);
    return undefined;
  }
}

class ViewIndex implements HistoryIndex {
  readonly #rank = new Map<string, number>();
  readonly #cache = new Map<string, Map<unknown, readonly Event[]>>();
  #order: string | undefined;
  constructor(
    private readonly view: EventLogView,
    order: readonly string[],
    private readonly filter?: HistoryFilter,
    private readonly filterKey = "",
  ) {
    for (const [i, stream] of order.entries())
      if (!this.#rank.has(stream)) this.#rank.set(stream, i);
  }

  /** C-671: entries the filter drops, decided before decoding them. */
  readonly #skip = (stream: string, entry: Head) =>
    filtered(this.filter, stream, entry);

  /** C-639: the same events without those the history filter dropped. */
  #kept(events: readonly Event[]): readonly Event[] {
    const { filter } = this;
    if (!filter || !events.length) return events;
    let out: Event[] | undefined;
    for (let i = 0; i < events.length; i++) {
      const event = events[i] as Event;
      if (filtered(filter, streamOf(event), event)) {
        out ??= events.slice(0, i);
      } else out?.push(event);
    }
    if (!out) return events;
    return out.length ? out : noEvents;
  }

  #memo(space: string, key: unknown, build: () => readonly Event[]) {
    let cache = this.#cache.get(space);
    if (!cache) {
      cache = new Map();
      this.#cache.set(space, cache);
    }
    let events = cache.get(key);
    if (!events) {
      events = build();
      cache.set(key, events);
    }
    return events;
  }

  query(kind: EventIndexKind, key: unknown): readonly Event[] {
    return this.#memo(kind, key, () => {
      const { view } = this;
      const total = view.base.buckets.get(kind)?.get(key)?.total ?? 0;
      const extra = view.overlay?.buckets.get(kind)?.get(key);
      let overlaid = false;
      if (extra)
        for (const seg of extra.values())
          if ((seg[0] as number) < view.end) overlaid = true;
      // Only base-only answers of a head view are shared; overlays never are.
      const answers =
        !overlaid && view.baseEnd === view.base.end
          ? this.#answers(kind)
          : undefined;
      const hit = answers?.get(key);
      if (hit && hit.total === total) return hit.events;
      const events = this.#kept(
        view.collect(
          this.#rank,
          (log) => log.buckets.get(kind)?.get(key),
          this.#skip,
        ),
      );
      answers?.set(key, { total, events });
      return events;
    });
  }

  #answers(kind: EventIndexKind) {
    if (this.#order === undefined)
      this.#order = `${[...this.#rank.keys()].join("\u0000")}\u0002${this.filterKey}`;
    const order = this.#order;
    const base = this.view.base;
    if (base.results?.order !== order)
      base.results = { order, answers: new Map() };
    let answers = base.results.answers.get(kind);
    if (!answers) {
      answers = new Map();
      base.results.answers.set(kind, answers);
    }
    return answers;
  }

  card(card: string, type: string): readonly Event[] {
    // Same as filtering the type bucket by a truthy card_id.
    const { filter } = this;
    if (
      !card ||
      !this.#rank.has(card) ||
      (filter && !filter.full.has(card) && trims(filter, type))
    )
      return noEvents;
    return this.#memo(`card:${type}`, card, () => {
      const one = new Map([[card, 0]]);
      return this.view.collect(one, (log) => {
        const seg = log.buckets.get("type")?.get(type)?.get(card);
        return seg ? new Map([[card, seg]]) : undefined;
      });
    });
  }

  ofTypes(types: readonly string[]): readonly Event[] {
    const unique = [...new Set(types)];
    if (unique.length === 1) return this.query("type", unique[0]);
    return this.#memo("types", typesKey(unique), () =>
      this.#kept(
        this.view.collect(
          this.#rank,
          (log) => {
            const index = log.buckets.get("type");
            let merged: Map<string, number[]> | undefined;
            for (const type of unique) {
              const bucket = index?.get(type);
              if (!bucket) continue;
              merged ??= new Map();
              for (const [stream, ords] of bucket) {
                let into = merged.get(stream);
                if (!into) {
                  into = [];
                  merged.set(stream, into);
                }
                for (const ord of ords) into.push(ord);
              }
            }
            // Ordinals ascend with seq inside a stream; several types interleave.
            if (merged && unique.length > 1)
              for (const ords of merged.values()) ords.sort((a, b) => a - b);
            return merged;
          },
          this.#skip,
        ),
      ),
    );
  }

  stream(stream: string): readonly Event[] {
    if (!this.#rank.has(stream)) return noEvents;
    return this.#memo("stream", stream, () => {
      const out: Event[] = [];
      const take = (log: EventLog | undefined, limit: number) => {
        const seg = log?.streams.get(stream);
        if (!log || !seg) return;
        const n = below(seg.ords, limit);
        const keeps = (entry: Head) => !filtered(this.filter, stream, entry);
        log.decodeWhere(stream, seg, n, keeps);
        for (let i = 0; i < n; i++)
          if (keeps(seg.events[i] as Entry)) out.push(seg.events[i] as Event);
      };
      take(this.view.base, this.view.baseEnd);
      take(this.view.overlay, this.view.end);
      return out.length ? out : noEvents;
    });
  }

  keyed(kind: EventIndexKind): readonly Event[] {
    return this.#memo("keyed", kind, () =>
      this.#kept(
        this.view.collect(
          this.#rank,
          (log) => {
            const buckets = log.buckets.get(kind);
            if (!buckets) return undefined;
            const merged = new Map<string, number[]>();
            for (const bucket of buckets.values())
              for (const [stream, ords] of bucket) {
                const into = merged.get(stream);
                if (into) into.push(...ords);
                else merged.set(stream, [...ords]);
              }
            // One event under several keys of `kind` counts once.
            for (const [stream, ords] of merged)
              merged.set(
                stream,
                [...new Set(ords)].sort((a, b) => a - b),
              );
            return merged;
          },
          this.#skip,
        ),
      ),
    );
  }

  atSeq(stream: string, seq: number): readonly Event[] {
    if (!this.#rank.has(stream)) return noEvents;
    const out: Event[] = [];
    const take = (log: EventLog | undefined, limit: number) => {
      const seg = log?.streams.get(stream);
      if (!log || !seg) return;
      const n = below(seg.ords, limit);
      // Seq ascends inside a stream (the Store rebuilds otherwise).
      let lo = 0;
      let hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if ((seg.events[mid] as Entry).seq < seq) lo = mid + 1;
        else hi = mid;
      }
      let hi2 = lo;
      while (hi2 < n && (seg.events[hi2] as Entry).seq === seq) hi2++;
      const keeps = (entry: Head) => !filtered(this.filter, stream, entry);
      log.decodeWhere(
        stream,
        { events: seg.events.slice(lo, hi2), ords: seg.ords.slice(lo, hi2) },
        hi2 - lo,
        keeps,
      );
      for (let i = lo; i < hi2; i++)
        if (keeps(seg.events[i] as Entry)) out.push(seg.events[i] as Event);
    };
    take(this.view.base, this.view.baseEnd);
    take(this.view.overlay, this.view.end);
    return out.length ? out : noEvents;
  }

  byId(id: string): Event | undefined {
    // C-671: decide on the entry, decode only an event this history keeps.
    const entry = this.view.entryWithId(id);
    return entry &&
      this.#rank.has(streamOf(entry)) &&
      !filtered(this.filter, streamOf(entry), entry)
      ? this.view.eventWithId(id)
      : undefined;
  }
}

const attached = new WeakMap<readonly Event[], HistoryIndex>();

/** Register a prebuilt index for an immutable history array. */
export function attachEventIndex(
  events: readonly Event[],
  index: HistoryIndex,
): void {
  attached.set(events, index);
}

export function historyIndex(
  events: readonly Event[],
): HistoryIndex | undefined {
  return attached.get(events);
}

/**
 * Flat history for `order` (project stream "" plus card ids). A Store view
 * builds it once with its index; any other map keeps the legacy concatenation.
 */
export function streamHistory(
  streams: ReadonlyMap<string, readonly Event[]>,
  order: readonly string[],
  filter?: HistoryFilter,
): readonly Event[] {
  if (streams instanceof EventLogView) return streams.history(order, filter);
  return order.flatMap((stream) => {
    const events = streams.get(stream) ?? [];
    return filter ? events.filter((e) => !filtered(filter, stream, e)) : events;
  });
}
