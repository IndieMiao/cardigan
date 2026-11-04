import type { CardId } from "@cardigan/domain";
import { z } from "zod";
import { requireCard } from "./shared.js";
import { defineTool } from "./types.js";

/**
 * Events and timeline entries after a cursor (§6.1 step 4, §9.2).
 *
 * Passing `card_id` selects that card's stream; leaving it out reads the
 * project-level stream, matching the store and the domain port.
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

    // The project-level stream has no ACK cursor (cursors are per card), so it
    // keeps starting at 0.
    const acked =
      cardId === undefined
        ? 0
        : (store.uow.read((tx) =>
            tx.cursors.get(project_id, {
              assignment_id: identity.actor.assignment_id,
              card_id: cardId,
            }),
          )?.acked_seq ?? 0);
    const start = since_seq ?? acked;

    const updates = store.getUpdates({
      project_id,
      ...(cardId === undefined ? {} : { card_id: cardId }),
      since_seq: start,
    });

    return {
      card_id: cardId ?? null,
      since_seq: start,
      latest_seq: updates.latest_seq,
      events: updates.events,
      timeline: updates.timeline,
    };
  },
});
