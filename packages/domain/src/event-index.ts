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
const byDecision = new WeakMap<
  readonly Event[],
  ReadonlyMap<unknown, readonly Event[]>
>();

/** Preserve event order; an immutable snapshot gets one decision lookup index. */
export function eventsForDecision(events: readonly Event[], id: string) {
  let index = byDecision.get(events);
  if (!index) {
    const map = new Map<unknown, Event[]>();
    for (const event of events) {
      const p = event.payload;
      if (!p || typeof p !== "object" || !("decision_id" in p)) continue;
      const list = map.get(p.decision_id);
      if (list) list.push(event);
      else map.set(p.decision_id, [event]);
    }
    index = map;
    byDecision.set(events, index);
  }
  return index.get(id) ?? [];
}

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
