import {
  authorView,
  type CardId,
  mergeBatchReadScope,
  resolvePendingAttachmentRefs,
} from "@cardigan/domain";
import { z } from "zod";
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
    return publicSourceMergeData({
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
