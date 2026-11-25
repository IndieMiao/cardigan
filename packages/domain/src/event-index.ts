import type { Event } from "./entities.js";
import {
  attachEventIndex,
  type EventIndexKind,
  EventLogView,
  type HistoryFilter,
  type HistoryIndex,
  historyIndex,
  streamHistory,
} from "./event-log.js";
import { isTelemetryEvent, TELEMETRY_EVENT_TYPES } from "./telemetry.js";

export { isTelemetryEvent, TELEMETRY_EVENT_TYPES };

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
 *
 * C-643: the command-state stream leaves telemetry (`TELEMETRY_EVENT_TYPES`)
 * out and keeps it in a journal attached to the array. Every lookup below
 * still answers over the complete history: a Store command history carries the
 * full history's index, other arrays consult their journal.
 */
const byId = new WeakMap<readonly Event[], ReadonlyMap<string, Event>>();
const byType = new WeakMap<
  readonly Event[],
  ReadonlyMap<string, readonly Event[]>
>();
const noEvents: readonly Event[] = Object.freeze([]);

interface TelemetryJournal {
  /** Telemetry events, in the order of the full history. */
  readonly telemetry: () => readonly Event[];
  readonly full: () => readonly Event[];
}
// Keyed by the command-state event array, like every index in this module.
const journals = new WeakMap<readonly Event[], TelemetryJournal>();

function attach(
  events: readonly Event[],
  telemetry: () => readonly Event[],
  build: () => readonly Event[],
) {
  let journal: readonly Event[] | undefined;
  let full: readonly Event[] | undefined;
  journals.set(events, {
    telemetry: () => (journal ??= telemetry()),
    full: () => (full ??= build()),
  });
  if (guarded()) for (const event of events) sources.set(event, events);
  return events;
}

/**
 * C-655: a `filter`, `map` or spread of a command-state array is a new array
 * without the journal, so a telemetry lookup on it silently answers without
 * telemetry. While the guard is on (the test setup turns it on; production
 * never pays for it), such a lookup throws instead. An array counts as derived
 * when it has no journal or index, holds no telemetry, and every event came
 * from a command-state array; it throws only if that source's journal has the
 * telemetry asked for (same type on the same cards, or the same id). Fixtures
 * and raw stream reads keep telemetry inline and stay unchecked.
 */
const GUARD = Symbol.for("cardigan.telemetryQueryGuard");
type GuardHost = { [GUARD]?: boolean };
export function setTelemetryQueryGuard(on: boolean): void {
  (globalThis as GuardHost)[GUARD] = on;
}
const guarded = () => (globalThis as GuardHost)[GUARD] === true;
// Guard only: the latest command-state array each event was seen in.
const sources = new WeakMap<Event, readonly Event[]>();
interface Derivation {
  readonly source: readonly Event[];
  readonly cards: ReadonlySet<string | undefined>;
}
const derivations = new WeakMap<readonly Event[], Derivation | null>();

function derivation(events: readonly Event[]): Derivation | undefined {
  if (!events.length || journals.has(events) || historyIndex(events)) return;
  let found = derivations.get(events);
  if (found === undefined) {
    const source = events[0] && sources.get(events[0]);
    found =
      source && events.every((e) => !isTelemetryEvent(e) && sources.has(e))
        ? { source, cards: new Set(events.map((e) => e.card_id)) }
        : null;
    derivations.set(events, found);
  }
  return found ?? undefined;
}

function lostTelemetry(what: string): never {
  throw new Error(
    `C-655: ${what} on an array derived from command-state events misses telemetry; derive it with flatMapEvents or appendEvents, or query the command-state array`,
  );
}

function guardType(events: readonly Event[], type: string) {
  if (!guarded()) return;
  const from = derivation(events);
  if (
    from &&
    eventsOfType(from.source, type).some((e) => from.cards.has(e.card_id))
  )
    lostTelemetry(`eventsOfType(…, "${type}")`);
}

function guardId(events: readonly Event[], id: string) {
  if (!guarded()) return;
  const from = derivation(events);
  if (from && idIndex(telemetryEvents(from.source)).has(id))
    lostTelemetry(`eventById(…, "${id}")`);
}

function guardJournal(events: readonly Event[], what: string) {
  if (!guarded()) return;
  const from = derivation(events);
  if (
    from &&
    telemetryEvents(from.source).some((e) => from.cards.has(e.card_id))
  )
    lostTelemetry(what);
}

const splitParts = new WeakMap<
  readonly Event[],
  { readonly business: readonly Event[]; readonly telemetry: readonly Event[] }
>();
function splitPart(part: readonly Event[]) {
  let split = splitParts.get(part);
  if (!split) {
    const business: Event[] = [];
    const telemetry: Event[] = [];
    for (const event of part)
      (isTelemetryEvent(event) ? telemetry : business).push(event);
    split = { business, telemetry };
    splitParts.set(part, split);
  }
  return split;
}

/**
 * C-643: the command-state event stream for ordered history parts (project
 * stream, then card streams). Telemetry is left out of the returned array and
 * kept in its journal. Immutable parts are split once.
 */
export function commandEventHistory(
  parts: readonly (readonly Event[])[],
): readonly Event[] {
  const split = parts.map(splitPart);
  const telemetry = split.flatMap((s) => s.telemetry);
  return attach(
    split.flatMap((s) => s.business),
    () => telemetry,
    () => parts.flat(),
  );
}

/**
 * C-643 + C-640: the command-state stream for `order` (project stream "" plus
 * card ids), optionally trimmed by the C-639 hot `filter`. A Store view
 * concatenates its business segments and attaches the index of
 * `history(order, filter)`; that history and the telemetry journal are only
 * materialized when a rule asks for them. Other maps split their streams.
 */
export function commandStreamHistory(
  streams: ReadonlyMap<string, readonly Event[]>,
  order: readonly string[],
  filter?: HistoryFilter,
): readonly Event[] {
  if (!(streams instanceof EventLogView))
    return commandEventHistory(
      order.map((id) =>
        filter ? streamHistory(streams, [id], filter) : (streams.get(id) ?? []),
      ),
    );
  const events = streams.commandHistory(order, filter);
  if (!journals.has(events))
    attach(
      events,
      () => streams.telemetryHistory(order, filter),
      () => streams.history(order, filter),
    );
  return events;
}

/** Telemetry journal of a command-state event array; empty for plain arrays. */
export function telemetryEvents(events: readonly Event[]): readonly Event[] {
  const journal = journals.get(events);
  if (journal) return journal.telemetry();
  guardJournal(events, "telemetryEvents(…)");
  return noEvents;
}

/**
 * The complete history in its original order, including telemetry. Plain
 * arrays (fixtures, raw stream reads) already are complete.
 */
export function fullEventHistory(events: readonly Event[]): readonly Event[] {
  const journal = journals.get(events);
  if (journal) return journal.full();
  guardJournal(events, "fullEventHistory(…)");
  return events;
}
const completeHistory = (events: readonly Event[]) =>
  journals.get(events)?.full() ?? events;

/**
 * `events.flatMap(each)` (scoping, redaction, filtering), applying the same
 * function to the telemetry journal so derived read states keep it.
 */
export function flatMapEvents(
  events: readonly Event[],
  each: (event: Event) => readonly Event[],
): readonly Event[] {
  const next = events.flatMap(each);
  const journal = journals.get(events);
  if (!journal) return next;
  return attach(
    next,
    () => journal.telemetry().flatMap(each),
    () => journal.full().flatMap(each),
  );
}

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
    events = completeHistory(events);
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
  human_action_id: fieldIndex("human_action_id"),
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
  if (kind !== "type") return plain[kind](events, key);
  if (typeof key !== "string") return noEvents;
  if (!TELEMETRY_EVENT_TYPES.has(key)) return typeBucket(events, key);
  const journal = journals.get(events);
  if (journal) return typeBucket(journal.telemetry(), key);
  guardType(events, key);
  return typeBucket(events, key);
}

export const eventsForDecision = (events: readonly Event[], key: string) =>
  query(events, "decision_id", key);
export const eventsForHumanAction = (events: readonly Event[], key: string) =>
  query(events, "human_action_id", key);
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
  return forCard(eventsOfType(events, type), card);
};

const byTypes = new WeakMap<readonly Event[], Map<string, readonly Event[]>>();
/**
 * C-649: same as `fullEventHistory(events).filter((e) =>
 * types.includes(e.type))` (C-643: over the complete history, telemetry
 * included), answered from an attached index when there is one.
 */
export function eventsOfTypes(
  events: readonly Event[],
  types: readonly string[],
): readonly Event[] {
  const index = historyIndex(events);
  if (index) return index.ofTypes(types);
  const unique = [...new Set(types)];
  if (unique.length === 1) return eventsOfType(events, unique[0] as string);
  // Business types are all in the command-state array itself; only telemetry
  // needs the complete history (and its C-655 guard on derived arrays).
  if (unique.some((type) => TELEMETRY_EVENT_TYPES.has(type)))
    events = fullEventHistory(events);
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
 * C-649: same as `fullEventHistory(events).filter((e) => (e.card_id ?? "")
 * === (card ?? ""))`: one stream (the project stream for `undefined`) of the
 * complete history, in history order.
 */
export function streamEvents(
  events: readonly Event[],
  card: string | undefined,
): readonly Event[] {
  const stream = card ?? "";
  const index = historyIndex(events);
  if (index) return index.stream(stream);
  events = completeHistory(events);
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
/** C-649: same as filtering one complete stream (see `streamEvents`) by `seq`. */
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
  const found = idIndex(events).get(id);
  if (found) return found;
  const journal = journals.get(events);
  if (journal) return idIndex(journal.telemetry()).get(id);
  guardId(events, id);
  return undefined;
}
function idIndex(events: readonly Event[]): ReadonlyMap<string, Event> {
  let index = byId.get(events);
  if (!index) {
    const map = new Map<string, Event>();
    for (const e of events) if (!map.has(e.id)) map.set(e.id, e);
    index = map;
    byId.set(events, index);
  }
  return index;
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
 * copied, so later pushes to a draft's event list do not leak in. C-643: the
 * result keeps the base's telemetry journal, extended by telemetry in the tail.
 */
export function appendEvents(
  base: readonly Event[],
  tail: readonly Event[],
): readonly Event[] {
  if (!tail.length) return base;
  const added = [...tail];
  // C-655: the tail copy is part of this history, not derived from it.
  if (guarded()) derivations.set(added, null);
  const events = [...base, ...added];
  attachEventIndex(events, new AppendedIndex(base, added));
  const journal = journals.get(base);
  if (journal)
    attach(
      events,
      () => {
        const extra = added.filter(isTelemetryEvent);
        return extra.length
          ? [...journal.telemetry(), ...extra]
          : journal.telemetry();
      },
      () => [...journal.full(), ...added],
    );
  return events;
}
