import type { Event } from "./entities.js";
import {
  type EventIndexKind,
  EventLogView,
  type IndexKeys,
  indexKeysOf,
} from "./event-log.js";
import type { CardId, ProjectId } from "./ids.js";
import type { EventRepository } from "./ports.js";

/** The event reader of a transaction (`tx.events`). */
export type StreamEventReader = Pick<EventRepository, "listAfter"> & {
  listStreams?(project: ProjectId): ReadonlyMap<string, readonly Event[]>;
};

/**
 * C-652: one stream's events (`card` absent: the project stream) indexed
 * under `kind` with a key in `keys`, seq ascending. A Store view answers from
 * its index; any other reader filters `listAfter(project, card, 0)` the same.
 */
export function streamEventsBy(
  events: StreamEventReader,
  project: ProjectId,
  card: CardId | undefined,
  kind: EventIndexKind,
  keys: IndexKeys,
): readonly Event[] {
  const view = events.listStreams?.(project);
  if (view instanceof EventLogView)
    return view.matching(card ?? "", kind, keys);
  const match =
    typeof keys === "function" ? keys : (key: unknown) => keys.includes(key);
  return events
    .listAfter(project, card, 0)
    .filter((event) => indexKeysOf(event, kind).some(match));
}
