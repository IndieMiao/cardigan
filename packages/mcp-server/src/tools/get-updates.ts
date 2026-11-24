import {
  authorView,
  type CardId,
  type Event,
  isOfficeOnDuty,
  mergeBatchReadScope,
  OFFICE_DIGEST_EVENT_TYPES,
  type OfficeDigest,
  officeDigest,
  officeDigestSince,
  resolvePendingAttachmentRefs,
} from "@cardigan/domain";
import { z } from "zod";
import type { McpReadContext } from "../backend.js";
import { publicSourceMergeData } from "../source-merge-public.js";
import { PROJECT_STREAM, requireCard } from "./shared.js";
import { defineTool } from "./types.js";

/**
 * Events and timeline entries after a cursor (§6.1 step 4, §9.2).
 *
 * Passing `card_id` selects that card's stream; leaving it out reads the
 * project-level stream, matching the store and the domain port. Each stream has
 * its own ACK cursor, so both reads continue where `ack_events` left off.
 *
 * Without an explicit `since_seq` the read starts after the caller's saved ACK
 * cursor for that card, so an agent that already acknowledged does not re-read
 * the same events. Only the caller's own cursor is used: the assignment comes
 * from the token, never from the arguments.
 *
 * C-722: the project-stream read of this project's PM Office on duty also
 * carries `office_digest`, the routine card progress that does not ring the
 * Office (see `officeDigest`). It is derived from events and the Office's own
 * ACK cursors; reading it changes nothing.
 */
export const getUpdatesTool = defineTool({
  name: "get_updates",
  description:
    "Return events and timeline entries after since_seq for a card or the project stream",
  input: z.object({
    card_id: z.string().min(1).optional(),
    since_seq: z.number().int().min(0).optional(),
  }),
  handler: ({ card_id, since_seq }, { store, identity }) => {
    const project_id = identity.actor.project_id;
    const cardId = card_id === undefined ? undefined : (card_id as CardId);
    if (cardId !== undefined) {
      requireCard(store, identity, cardId);
    }

    // The cursor is per stream (§6.1 step 4): the card's stream or, without a
    // card, the project-level one — symmetric with `ack_events` (S5).
    const stream = cardId ?? PROJECT_STREAM;
    const acked =
      store.uow.read((tx) =>
        tx.cursors.get(project_id, {
          assignment_id: identity.actor.assignment_id,
          card_id: stream as CardId,
        }),
      )?.acked_seq ?? 0;
    const start = since_seq ?? acked;

    const updates = store.getUpdates({
      project_id,
      ...(cardId === undefined ? {} : { card_id: cardId }),
      since_seq: start,
    });

    const batchScope = store.uow.read((tx) =>
      mergeBatchReadScope(
        {
          project_id,
          cards: tx.cards.list(project_id),
          work_items: tx.work_items.list(project_id),
          project_preferences: tx.project_preferences?.list(project_id) ?? [],
          events: [
            ...(tx.events.listStreams?.(project_id)?.get("") ??
              tx.events.listAfter(project_id, undefined, 0)),
            ...updates.events,
          ],
        },
        tx.assignments.get(project_id, identity.actor.assignment_id),
      ),
    );
    const authors = store.uow.read((tx) => ({
      assignments: tx.assignments.list(project_id),
      employees: tx.employees?.list() ?? [],
      members: tx.members?.list() ?? [],
    }));
    // C-615: a comment's `attachment-new-N` reads as the number it got. Only
    // cards with such a comment read their attachments.
    const pending = new Set(
      updates.timeline
        .filter((entry) => entry.body.includes("attachment-new-"))
        .map((entry) => entry.card_id),
    );
    const attachments = new Map(
      pending.size
        ? store.uow.read((tx) =>
            [...pending].map(
              (card) =>
                [
                  card,
                  tx.cardSources?.(project_id, card).attachments ??
                    tx.attachments
                      .list(project_id)
                      .filter((a) => a.card_id === card),
                ] as const,
            ),
          )
        : [],
    );
    const uploads = (card: CardId) => attachments.get(card) ?? [];
    const digest =
      cardId === undefined
        ? store.uow.read((tx) =>
            readOfficeDigest(tx, project_id, identity.actor.assignment_id),
          )
        : undefined;
    return publicSourceMergeData({
      ...(digest ? { office_digest: digest } : {}),
      card_id: cardId ?? null,
      since_seq: start,
      latest_seq: updates.latest_seq,
      events: updates.events.flatMap(batchScope.event).map((event) => ({
        ...event,
        ...authorView(
          authors,
          event.actor.kind === "assignment"
            ? `assignment:${event.actor.assignment_id}`
            : event.actor.kind,
        ),
      })),
      timeline: updates.timeline.map(batchScope.timeline).map((entry) => ({
        ...entry,
        body: resolvePendingAttachmentRefs(
          entry.body,
          entry,
          uploads(entry.card_id),
        ),
        ...authorView(authors, entry.author),
      })),
    });
  },
});

/** C-722: only the caller's own project, and only when it is the Office on duty. */
function readOfficeDigest(
  tx: McpReadContext,
  project_id: Parameters<McpReadContext["cards"]["list"]>[0],
  assignment_id: Parameters<McpReadContext["assignments"]["get"]>[1],
): OfficeDigest | undefined {
  const office = tx.assignments.get(project_id, assignment_id);
  const streams = tx.events.listStreams?.(project_id);
  if (!office || !isOfficeOnDuty(office) || !streams) return undefined;
  const cursors = tx.cursors
    .list(project_id)
    .filter((c) => c.assignment_id === office.id);
  const projectCursor =
    cursors.find((c) => (c.card_id as string) === "")?.acked_seq ?? 0;
  const projectEvents =
    projectCursor > 0 ? (streams.get("") ?? []) : ([] as readonly Event[]);
  const since = officeDigestSince(office, projectEvents, projectCursor);
  const byStream = streams.ofTypes
    ? streams.ofTypes(OFFICE_DIGEST_EVENT_TYPES)
    : streams;
  function* cardEvents(): Generator<Event> {
    for (const [stream, events] of byStream) {
      if (stream === "") continue;
      // Streams are in seq order; skip whole streams older than the window.
      if ((events.at(-1)?.created_at ?? "") < since) continue;
      yield* events;
    }
  }
  return officeDigest({
    project_id,
    office,
    events: cardEvents(),
    since,
    cursors,
    cards: tx.cards.list(project_id),
  });
}
