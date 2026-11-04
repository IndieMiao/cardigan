import type { CardId } from "@cardigan/domain";
import { z } from "zod";
import { requireCard } from "./shared.js";
import { defineTool } from "./types.js";

/**
 * Events and timeline entries after a cursor (§6.1 step 4, §9.2).
 *
 * Passing `card_id` selects that card's stream; leaving it out reads the
 * project-level stream, matching the store and the domain port.
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
      requireCard(store, project_id, cardId);
    }

    const updates = store.getUpdates({
      project_id,
      ...(cardId === undefined ? {} : { card_id: cardId }),
      since_seq: since_seq ?? 0,
    });

    return {
      card_id: cardId ?? null,
      since_seq: since_seq ?? 0,
      latest_seq: updates.latest_seq,
      events: updates.events,
      timeline: updates.timeline,
    };
  },
});
