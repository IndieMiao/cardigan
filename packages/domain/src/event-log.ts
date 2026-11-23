import type { Event } from "./entities.js";

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
 */

/** Index kinds kept per event; `type` is the event type, the rest payload fields. */
export type EventIndexKind =
  | "type"
  | "decision_id"
  | "completion_id"
  | "work_item_id"
  | "resume_work_items";

const FIELDS = ["decision_id", "completion_id", "work_item_id"] as const;

type Seg = { readonly events: Event[]; readonly ords: number[] };
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

const streamOf = (event: Event) => event.card_id ?? "";
const noEvents: readonly Event[] = Object.freeze([]);

function push(
  segments: Map<string, Seg>,
  stream: string,
  event: Event,
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
  readonly ids = new Map<string, number>();
  readonly all: Event[] = [];
  readonly buckets = new Map<EventIndexKind, Map<unknown, Bucket>>();
  /** Base-only materialized stream prefixes, shared by views with equal prefixes. */
  readonly materialized = new Map<
    string,
    { count: number; events: readonly Event[] }
  >();
  /**
   * Answers computed by head views for the latest history order, reused while
   * the key's bucket has not grown (unchanged keys stay O(1) across appends).
   */
  results: { order: string; answers: Results } | undefined;
  constructor(readonly start = 0) {}

  get end(): number {
    return this.start + this.all.length;
  }

  lastSeq(stream: string): number | undefined {
    return this.streams.get(stream)?.events.at(-1)?.seq;
  }

  append(event: Event): void {
    const ord = this.end;
    const stream = streamOf(event);
    this.all.push(event);
    push(this.streams, stream, event, ord);
    if (!this.ids.has(event.id)) this.ids.set(event.id, ord);
    this.#index("type", event.type, stream, ord);
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
    }
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

  /** Event by ordinal, for ordinals owned by this log. */
  at(ord: number): Event | undefined {
    return this.all[ord - this.start];
  }
}

/** Indexed lookups over one materialized history array (see `attachEventIndex`). */
export interface HistoryIndex {
  query(kind: EventIndexKind, key: unknown): readonly Event[];
  card(card: string, type: string): readonly Event[];
  byId(id: string): Event | undefined;
}

/**
 * Immutable read view: base events with ordinal < `baseEnd`, then overlay
 * events with ordinal < `end`. Implements the Store's `listStreams` map.
 */
export class EventLogView implements ReadonlyMap<string, readonly Event[]> {
  readonly #streams = new Map<string, readonly Event[]>();
  #keys: readonly string[] | undefined;
  #history: { order: readonly string[]; events: readonly Event[] } | undefined;
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
      if (!seg) return;
      const n = below(seg.ords, limit);
      let lo = 0;
      let hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if ((seg.events[mid] as Event).seq <= since) lo = mid + 1;
        else hi = mid;
      }
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
      const head = this.base.streams.get(key)?.events.slice(0, own) ?? [];
      const tail = this.overlay?.streams.get(key)?.events.slice(0, extra);
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
   * The same order returns the same array.
   */
  history(order: readonly string[]): readonly Event[] {
    const cached = this.#history;
    if (
      cached?.order.length === order.length &&
      cached.order.every((id, i) => id === order[i])
    )
      return cached.events;
    // One exact-size concat over the segments; no per-event push or sort.
    const parts: (readonly Event[])[] = [];
    const part = (seg: Seg | undefined, limit: number) => {
      if (!seg) return;
      const n = below(seg.ords, limit);
      if (n)
        parts.push(
          n === seg.events.length ? seg.events : seg.events.slice(0, n),
        );
    };
    for (const stream of order) {
      part(this.base.streams.get(stream), this.baseEnd);
      part(this.overlay?.streams.get(stream), this.end);
    }
    const events = ([] as Event[]).concat(...parts);
    attachEventIndex(events, new ViewIndex(this, order));
    this.#history = { order: [...order], events };
    return events;
  }

  /** Bucket segments of this view in history `rank` order. */
  collect(
    rank: ReadonlyMap<string, number>,
    pick: (log: EventLog) => ReadonlyMap<string, number[]> | undefined,
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
    for (const stream of streams) {
      const a = own?.get(stream);
      if (a) {
        const n = below(a, this.baseEnd);
        for (let i = 0; i < n; i++)
          events.push(this.base.at(a[i] as number) as Event);
      }
      const b = extra?.get(stream);
      if (b && this.overlay) {
        const n = below(b, this.end);
        for (let i = 0; i < n; i++)
          events.push(this.overlay.at(b[i] as number) as Event);
      }
    }
    return events.length ? events : noEvents;
  }

  /** The view's event with this id, if any (event ids are unique per project). */
  eventWithId(id: string): Event | undefined {
    const ord = this.base.ids.get(id);
    if (ord !== undefined && ord < this.baseEnd) return this.base.at(ord);
    const extra = this.overlay?.ids.get(id);
    if (extra !== undefined && extra < this.end) return this.overlay?.at(extra);
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
  ) {
    for (const [i, stream] of order.entries())
      if (!this.#rank.has(stream)) this.#rank.set(stream, i);
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
      const events = view.collect(this.#rank, (log) =>
        log.buckets.get(kind)?.get(key),
      );
      answers?.set(key, { total, events });
      return events;
    });
  }

  #answers(kind: EventIndexKind) {
    if (this.#order === undefined)
      this.#order = [...this.#rank.keys()].join("\u0000");
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
    if (!card || !this.#rank.has(card)) return noEvents;
    return this.#memo(`card:${type}`, card, () => {
      const one = new Map([[card, 0]]);
      return this.view.collect(one, (log) => {
        const seg = log.buckets.get("type")?.get(type)?.get(card);
        return seg ? new Map([[card, seg]]) : undefined;
      });
    });
  }

  byId(id: string): Event | undefined {
    const event = this.view.eventWithId(id);
    return event && this.#rank.has(streamOf(event)) ? event : undefined;
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
): readonly Event[] {
  if (streams instanceof EventLogView) return streams.history(order);
  return order.flatMap((id) => streams.get(id) ?? []);
}
