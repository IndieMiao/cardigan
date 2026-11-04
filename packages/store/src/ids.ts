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

  const counter = (project_id: ProjectId, kind: string): number => {
    const row = nextId.get(project_id, kind);
    return Number((row as { value: number }).value);
  };

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
      const row = nextEventSeq.get(project_id, card_id ?? PROJECT_EVENT_STREAM);
      return Number((row as { seq: number }).seq);
    },
    nextAttachmentId(project_id: ProjectId): AttachmentId {
      // Attachment IDs have no textual format in M1.1; keep them readable and
      // project-local so a later upload task can adopt them as-is.
      return `attachment-${counter(project_id, "attachment")}`;
    },
  };
}

export type { TimelineEntryId };
