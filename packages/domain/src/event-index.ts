import type { Event } from "./entities.js";
import {
  attachEventIndex,
  type EventIndexKind,
  type HistoryIndex,
  historyIndex,
} from "./event-log.js";

/**
 * C-221: keyed event lookup. Event collections are immutable snapshots (every
 * appended event yields a new array: Store stream caches, command drafts and
 * fixtures all copy), so an index keyed by the array's identity cannot go
 * stale; a rolled-back snapshot keeps its own index. Weak keys free unused ones.
 *
 * C-640: a Store history array (`EventLogView.history`) and an
 * `appendEvents` result carry an attached index maintained on append, so
 * lookups on them never rebuild over the whole array. Any other array keeps
 * the lazy per-array index below with identical results.
 */
const byId = new WeakMap<readonly Event[], ReadonlyMap<string, Event>>();
const byType = new WeakMap<
  readonly Event[],
  ReadonlyMap<string, readonly Event[]>
>();
const noEvents: readonly Event[] = Object.freeze([]);

function typeBucket(events: readonly Event[], type: string) {
  let index = byType.get(events);
  if (!index) {
    const map = new Map<string, Event[]>();
    for (const event of events) {
      const list = map.get(event.type);
      if (list) list.push(event);
      else map.set(event.type, [event]);
    }
    index = map;
    byType.set(events, index);
  }
  return index.get(type) ?? noEvents;
}

/** Same order and duplicates as filter; never cache a clock-dependent answer. */
export function eventsOfType(events: readonly Event[], type: string) {
  return query(events, "type", type);
}
// Immutable snapshots retain the original order within every bucket. Build
// each requested lookup once, including when many candidates share one card.
function keyedEvents(keys: (e: Event) => readonly unknown[]) {
  const cache = new WeakMap<readonly Event[], Map<unknown, Event[]>>();
  return (events: readonly Event[], key: unknown): readonly Event[] => {
    let index = cache.get(events);
    if (!index) {
      index = new Map();
      for (const event of events) {
        for (const value of keys(event)) {
          const list = index.get(value);
          if (list) list.push(event);
          else index.set(value, [event]);
        }
      }
      cache.set(events, index);
    }
    return index.get(key) ?? noEvents;
  };
}
const fieldIndex = (field: string) =>
  keyedEvents((e) => {
    const value = (e.payload as Record<string, unknown> | null)?.[field];
    return typeof value === "string" ? [value] : [];
  });
const plain: Record<
  Exclude<EventIndexKind, "type">,
  (events: readonly Event[], key: unknown) => readonly Event[]
> = {
  decision_id: fieldIndex("decision_id"),
  completion_id: fieldIndex("completion_id"),
  work_item_id: fieldIndex("work_item_id"),
  resume_work_items: keyedEvents((e) => {
    const p = e.payload;
    return p &&
      typeof p === "object" &&
      "resume_work_items" in p &&
      Array.isArray(p.resume_work_items)
      ? p.resume_work_items
      : [];
  }),
};
const forCard = keyedEvents((e) => (e.card_id ? [e.card_id] : []));

function query(
  events: readonly Event[],
  kind: EventIndexKind,
  key: unknown,
): readonly Event[] {
  const index = historyIndex(events);
  if (index) return index.query(kind, key);
  return kind === "type"
    ? typeof key === "string"
      ? typeBucket(events, key)
      : noEvents
    : plain[kind](events, key);
}

export const eventsForDecision = (events: readonly Event[], key: string) =>
  query(events, "decision_id", key);
export const eventsForCompletion = (events: readonly Event[], key: string) =>
  query(events, "completion_id", key);
export const eventsForWorkItem = (events: readonly Event[], key: string) =>
  query(events, "work_item_id", key);
export const resumeEventsForItem = (events: readonly Event[], key: string) =>
  query(events, "resume_work_items", key);
export const cardEventsOfType = (
  events: readonly Event[],
  card: string,
  type: string,
): readonly Event[] => {
  const index = historyIndex(events);
  if (index) return index.card(card, type);
  return forCard(typeBucket(events, type), card);
};

const byTypes = new WeakMap<readonly Event[], Map<string, readonly Event[]>>();
/**
 * C-649: same as `events.filter((e) => types.includes(e.type))`, answered
 * from an attached index when there is one.
 */
export function eventsOfTypes(
  events: readonly Event[],
  types: readonly string[],
): readonly Event[] {
  const index = historyIndex(events);
  if (index) return index.ofTypes(types);
  const unique = [...new Set(types)];
  if (unique.length === 1) return typeBucket(events, unique[0] as string);
  let cache = byTypes.get(events);
  if (!cache) {
    cache = new Map();
    byTypes.set(events, cache);
  }
  const key = unique.join("\u0000");
  let found = cache.get(key);
  if (!found) {
    const wanted = new Set(unique);
    const kept = events.filter((e) => wanted.has(e.type));
    found = kept.length ? kept : noEvents;
    cache.set(key, found);
  }
  return found;
}

const byStream = new WeakMap<readonly Event[], Map<string, readonly Event[]>>();
/**
 * C-649: same as `events.filter((e) => (e.card_id ?? "") === (card ?? ""))`:
 * one stream (the project stream for `undefined`), in history order.
 */
export function streamEvents(
  events: readonly Event[],
  card: string | undefined,
): readonly Event[] {
  const stream = card ?? "";
  const index = historyIndex(events);
  if (index) return index.stream(stream);
  let cache = byStream.get(events);
  if (!cache) {
    cache = new Map();
    byStream.set(events, cache);
  }
  let found = cache.get(stream);
  if (!found) {
    const kept = events.filter((e) => (e.card_id ?? "") === stream);
    found = kept.length ? kept : noEvents;
    cache.set(stream, found);
  }
  return found;
}

const bySeq = keyedEvents((e) => [`${e.card_id ?? ""}\u0000${e.seq}`]);
/** C-649: same as filtering one stream (see `streamEvents`) by `seq`. */
export const eventsAtSeq = (
  events: readonly Event[],
  card: string | undefined,
  seq: number,
): readonly Event[] =>
  historyIndex(events)?.atSeq(card ?? "", seq) ??
  bySeq(events, `${card ?? ""}\u0000${seq}`);

/** Same result as `events.find((e) => e.id === id)`: the first match wins. */
export function eventById(
  events: readonly Event[],
  id: string | undefined,
): Event | undefined {
  if (id === undefined) return undefined;
  const attached = historyIndex(events);
  if (attached) return attached.byId(id);
  let index = byId.get(events);
  if (!index) {
    const map = new Map<string, Event>();
    for (const e of events) if (!map.has(e.id)) map.set(e.id, e);
    index = map;
    byId.set(events, index);
  }
  return index.get(id);
}

/**
 * Derived history `[...base, ...tail]`: answers combine the base's index with
 * a small index over the tail instead of re-indexing the whole array.
 */
class AppendedIndex implements HistoryIndex {
  readonly #cache = new Map<string, Map<unknown, readonly Event[]>>();
  constructor(
    private readonly base: readonly Event[],
    private readonly tail: readonly Event[],
  ) {}

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

  #join(head: readonly Event[], tail: readonly Event[]) {
    if (!tail.length) return head;
    if (!head.length) return tail;
    return [...head, ...tail];
  }

  query(kind: EventIndexKind, key: unknown): readonly Event[] {
    return this.#memo(kind, key, () =>
      this.#join(query(this.base, kind, key), query(this.tail, kind, key)),
    );
  }

  card(card: string, type: string): readonly Event[] {
    return this.#memo(`card:${type}`, card, () =>
      this.#join(
        cardEventsOfType(this.base, card, type),
        cardEventsOfType(this.tail, card, type),
      ),
    );
  }

  byId(id: string): Event | undefined {
    return eventById(this.base, id) ?? eventById(this.tail, id);
  }

  ofTypes(types: readonly string[]): readonly Event[] {
    return this.#memo("types", [...new Set(types)].join("\u0000"), () =>
      this.#join(
        eventsOfTypes(this.base, types),
        eventsOfTypes(this.tail, types),
      ),
    );
  }

  stream(stream: string): readonly Event[] {
    return this.#memo("stream", stream, () =>
      this.#join(
        streamEvents(this.base, stream),
        streamEvents(this.tail, stream),
      ),
    );
  }

  atSeq(stream: string, seq: number): readonly Event[] {
    return this.#join(
      eventsAtSeq(this.base, stream, seq),
      eventsAtSeq(this.tail, stream, seq),
    );
  }
}

/**
 * `[...base, ...tail]` whose lookups reuse the base's index (a Store history
 * or an earlier `appendEvents` result) and index only the tail. The tail is
 * copied, so later pushes to a draft's event list do not leak in.
 */
export function appendEvents(
  base: readonly Event[],
  tail: readonly Event[],
): readonly Event[] {
  if (!tail.length) return base;
  const events = [...base, ...tail];
  attachEventIndex(events, new AppendedIndex(base, [...tail]));
  return events;
}
