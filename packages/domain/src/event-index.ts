import type { Event } from "./entities.js";

/**
 * C-221: keyed event lookup. Event collections are immutable snapshots (every
 * appended event yields a new array: Store stream caches, command drafts and
 * fixtures all copy), so an index keyed by the array's identity cannot go
 * stale; a rolled-back snapshot keeps its own index. Weak keys free unused ones.
 */
const byId = new WeakMap<readonly Event[], ReadonlyMap<string, Event>>();
const byType = new WeakMap<
  readonly Event[],
  ReadonlyMap<string, readonly Event[]>
>();
const noEvents: readonly Event[] = Object.freeze([]);

/**
 * C-643: high-volume host telemetry. These events stay in the event table
 * (timeline, activity, get_updates and bells read them as before), but the
 * command-state event stream excludes them, so generic projections that scan
 * `state.events` no longer walk them. Rules that need them read the journal
 * through the indexed lookups below or `fullEventHistory`.
 */
export const TELEMETRY_EVENT_TYPES: ReadonlySet<string> = new Set([
  "github_check_dispatch",
  "github_probe_dispatch",
  "run_queued",
  "run_dispatched",
  "run_started",
  "run_finished",
  "assignment_branch_backed_up",
  "session_maintenance_changed",
]);
export const isTelemetryEvent = (event: Pick<Event, "type">) =>
  TELEMETRY_EVENT_TYPES.has(event.type);

interface TelemetryJournal {
  /** Telemetry events, in the order of the full history. */
  readonly telemetry: readonly Event[];
  readonly full: () => readonly Event[];
}
// Keyed by the command-state event array, like every index in this module.
const journals = new WeakMap<readonly Event[], TelemetryJournal>();

function attach(
  events: readonly Event[],
  telemetry: readonly Event[],
  build: () => readonly Event[],
) {
  let full: readonly Event[] | undefined;
  journals.set(events, { telemetry, full: () => (full ??= build()) });
  return events;
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
  return attach(
    split.flatMap((s) => s.business),
    split.flatMap((s) => s.telemetry),
    () => parts.flat(),
  );
}

/** Telemetry journal of a command-state event array; empty for plain arrays. */
export function telemetryEvents(events: readonly Event[]): readonly Event[] {
  return journals.get(events)?.telemetry ?? noEvents;
}

/**
 * The complete history in its original order, including telemetry. Plain
 * arrays (fixtures, raw stream reads) already are complete.
 */
export function fullEventHistory(events: readonly Event[]): readonly Event[] {
  return journals.get(events)?.full() ?? events;
}

/** `[...events, ...added]`, keeping the telemetry journal of `events`. */
export function appendEvents(
  events: readonly Event[],
  added: readonly Event[],
): readonly Event[] {
  const next = [...events, ...added];
  const journal = journals.get(events);
  if (!journal) return next;
  const extra = added.filter(isTelemetryEvent);
  return attach(
    next,
    extra.length ? [...journal.telemetry, ...extra] : journal.telemetry,
    () => [...journal.full(), ...added],
  );
}

/** Same order and duplicates as filter; never cache a clock-dependent answer. */
export function eventsOfType(events: readonly Event[], type: string) {
  const journal = TELEMETRY_EVENT_TYPES.has(type)
    ? journals.get(events)
    : undefined;
  if (journal) events = journal.telemetry;
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
// Immutable snapshots retain the original order within every bucket. Build
// each requested lookup once, including when many candidates share one card.
function keyedEvents(keys: (e: Event) => readonly unknown[]) {
  const cache = new WeakMap<readonly Event[], Map<unknown, Event[]>>();
  return (events: readonly Event[], key: string): readonly Event[] => {
    events = fullEventHistory(events);
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
const byField = (field: string) =>
  keyedEvents((e) => {
    const value = (e.payload as Record<string, unknown> | null)?.[field];
    return typeof value === "string" ? [value] : [];
  });
export const eventsForDecision = byField("decision_id");
export const eventsForCompletion = byField("completion_id");
export const eventsForWorkItem = byField("work_item_id");
export const resumeEventsForItem = keyedEvents((e) => {
  const p = e.payload;
  return p &&
    typeof p === "object" &&
    "resume_work_items" in p &&
    Array.isArray(p.resume_work_items)
    ? p.resume_work_items
    : [];
});
const forCard = keyedEvents((e) => (e.card_id ? [e.card_id] : []));
export const cardEventsOfType = (
  events: readonly Event[],
  card: string,
  type: string,
) => forCard(eventsOfType(events, type), card);

/** Same result as `events.find((e) => e.id === id)`: the first match wins. */
export function eventById(
  events: readonly Event[],
  id: string | undefined,
): Event | undefined {
  if (id === undefined) return undefined;
  const found = idIndex(events).get(id);
  if (found) return found;
  const journal = journals.get(events);
  return journal && idIndex(journal.telemetry).get(id);
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
