import {
  type CommandPorts,
  type EventId,
  formatTimelineEntryId,
} from "@cardigan/domain";

/** Discardable command effects; a read transaction never allocates persistent IDs. */
export function previewPorts(now: string): CommandPorts {
  const unavailable = (): never => {
    throw new Error("Preview cannot allocate entity IDs");
  };
  return {
    clock: { now: () => now },
    ids: {
      next: unavailable,
      nextAttachmentId: unavailable,
      nextEventId: () => "preview" as EventId,
      nextEventSequence: () => 1,
      nextTimelineEntryId: (_project, card) => {
        const id = formatTimelineEntryId(card, 1);
        if (!id.ok) throw new Error(id.error.message);
        return id.value;
      },
    },
  };
}
