import type { Event } from "./entities.js";

/**
 * C-221: keyed event lookup. Event collections are immutable snapshots (every
 * appended event yields a new array: Store stream caches, command drafts and
 * fixtures all copy), so an index keyed by the array's identity cannot go
 * stale; a rolled-back snapshot keeps its own index. Weak keys free unused ones.
 */
const byId = new WeakMap<readonly Event[], ReadonlyMap<string, Event>>();

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
