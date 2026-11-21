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

/** Same order and duplicates as filter; never cache a clock-dependent answer. */
export function eventsOfType(events: readonly Event[], type: string) {
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
  let index = byId.get(events);
  if (!index) {
    const map = new Map<string, Event>();
    for (const e of events) if (!map.has(e.id)) map.set(e.id, e);
    index = map;
    byId.set(events, index);
  }
  return id === undefined ? undefined : index.get(id);
}
