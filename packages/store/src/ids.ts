import type { DatabaseSync } from "node:sqlite";
import type {
  AttachmentId,
  CardId,
  EventId,
  IdAllocator,
  ProjectId,
  ReadableIdKind,
  TimelineEntryId,
} from "@cardigan/domain";
import { formatId, formatTimelineEntryId } from "@cardigan/domain";
import { newUlid } from "./ulid.js";

const NEXT_ID =
  "INSERT INTO id_counters (project_id, kind, value) VALUES (?, ?, 1) " +
  "ON CONFLICT (project_id, kind) DO UPDATE SET value = value + 1 RETURNING value";

const NEXT_EVENT_SEQ =
  "INSERT INTO event_counters (project_id, stream, seq) VALUES (?, ?, 1) " +
  "ON CONFLICT (project_id, stream) DO UPDATE SET seq = seq + 1 RETURNING seq";

/** Stream key for project-level events (no card). */
export const PROJECT_EVENT_STREAM = "";

/**
 * Counter-backed allocator. It writes to the same connection (and therefore the
 * same transaction) as the entity changes it numbers, so a rolled-back command
 * does not burn an ID.
 */
export function createIdAllocator(
  db: DatabaseSync,
  nowMs: () => number = () => Date.now(),
): IdAllocator {
  const nextId = db.prepare(NEXT_ID);
  const nextEventSeq = db.prepare(NEXT_EVENT_SEQ);
  return allocator(
    (project_id, kind) =>
      Number((nextId.get(project_id, kind) as { value: number }).value),
    (project_id, stream) =>
      Number((nextEventSeq.get(project_id, stream) as { seq: number }).seq),
    nowMs,
  );
}

/**
 * C-641: an allocator for a read snapshot. It reads each counter once and
 * numbers in memory, without taking the writer lock. Under the writer lock the
 * caller checks `unchanged()` (no other writer took a number since the
 * snapshot) and then `flush()`es the final values in the same transaction.
 */
export interface BufferedIdAllocator {
  readonly ids: IdAllocator;
  unchanged(): boolean;
  flush(): void;
}

export function createBufferedIdAllocator(
  db: DatabaseSync,
  nowMs: () => number = () => Date.now(),
): BufferedIdAllocator {
  const readId = db.prepare(
    "SELECT value AS value FROM id_counters WHERE project_id = ? AND kind = ?",
  );
  const readSeq = db.prepare(
    "SELECT seq AS value FROM event_counters WHERE project_id = ? AND stream = ?",
  );
  const writeId = db.prepare(
    "INSERT INTO id_counters (project_id, kind, value) VALUES (?, ?, ?) " +
      "ON CONFLICT (project_id, kind) DO UPDATE SET value = excluded.value",
  );
  const writeSeq = db.prepare(
    "INSERT INTO event_counters (project_id, stream, seq) VALUES (?, ?, ?) " +
      "ON CONFLICT (project_id, stream) DO UPDATE SET seq = excluded.seq",
  );
  interface Counter {
    readonly event: boolean;
    readonly project: ProjectId;
    readonly key: string;
    readonly base: number;
    value: number;
  }
  const counters = new Map<string, Counter>();
  const current = (c: Pick<Counter, "event" | "project" | "key">) =>
    Number((c.event ? readSeq : readId).get(c.project, c.key)?.value ?? 0);
  const take = (event: boolean, project: ProjectId, key: string) => {
    const id = JSON.stringify([event, project, key]);
    let counter = counters.get(id);
    if (!counter) {
      const base = current({ event, project, key });
      counter = { event, project, key, base, value: base };
      counters.set(id, counter);
    }
    counter.value += 1;
    return counter.value;
  };
  return {
    ids: allocator(
      (project, kind) => take(false, project, kind),
      (project, stream) => take(true, project, stream),
      nowMs,
    ),
    unchanged: () => [...counters.values()].every((c) => current(c) === c.base),
    flush: () => {
      for (const c of counters.values())
        if (c.value !== c.base)
          (c.event ? writeSeq : writeId).run(c.project, c.key, c.value);
    },
  };
}

function allocator(
  counter: (project_id: ProjectId, kind: string) => number,
  eventSequence: (project_id: ProjectId, stream: string) => number,
  nowMs: () => number,
): IdAllocator {
  return {
    next<K extends ReadableIdKind>(project_id: ProjectId, kind: K) {
      const formatted = formatId(kind, counter(project_id, kind));
      if (!formatted.ok) {
        throw new Error(formatted.error.message);
      }
      return formatted.value;
    },
    nextTimelineEntryId(project_id: ProjectId, card_id: CardId) {
      const formatted = formatTimelineEntryId(
        card_id,
        counter(project_id, `timeline_entry:${card_id}`),
      );
      if (!formatted.ok) {
        throw new Error(formatted.error.message);
      }
      return formatted.value;
    },
    nextEventId(): EventId {
      return newUlid(nowMs()) as EventId;
    },
    nextEventSequence(project_id: ProjectId, card_id?: CardId): number {
      return eventSequence(project_id, card_id ?? PROJECT_EVENT_STREAM);
    },
    nextAttachmentId(project_id: ProjectId): AttachmentId {
      // Attachment IDs have no textual format in M1.1; keep them readable and
      // project-local so a later upload task can adopt them as-is.
      return `attachment-${counter(project_id, "attachment")}`;
    },
  };
}

export type { TimelineEntryId };
