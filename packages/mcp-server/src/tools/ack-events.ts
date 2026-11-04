import type { CardId } from "@cardigan/domain";
import { z } from "zod";
import { ToolError } from "../errors.js";
import { requireCard } from "./shared.js";
import { defineTool } from "./types.js";

/**
 * Move this assignment's read cursor forward (§9.2).
 *
 * The cursor belongs to the token's assignment, so a caller cannot advance
 * another assignment's cursor. Backwards or repeated acks are no-ops and a
 * sequence past the newest event is rejected (see the store).
 */
export const ackEventsTool = defineTool({
  name: "ack_events",
  description: "Advance this assignment's cursor for a card up to a sequence",
  input: z.object({
    card_id: z.string().min(1),
    up_to_seq: z.number().int().min(0),
  }),
  handler: ({ card_id, up_to_seq }, { store, identity }) => {
    const project_id = identity.actor.project_id;
    const cardId = card_id as CardId;
    requireCard(store, project_id, cardId);

    const result = store.ackEvents({
      project_id,
      assignment_id: identity.actor.assignment_id,
      card_id: cardId,
      up_to_seq,
    });

    if (!result.ok) {
      throw new ToolError(
        result.error.code,
        result.error.message,
        result.error.details,
      );
    }
    return { card_id: cardId, ...result.value };
  },
});
