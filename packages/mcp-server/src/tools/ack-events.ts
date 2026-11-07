import type { CardId } from "@cardigan/domain";
import { z } from "zod";
import { ToolError } from "../errors.js";
import { PROJECT_STREAM, requireCard } from "./shared.js";
import { defineTool } from "./types.js";

/**
 * Move this assignment's read cursor forward (§9.2).
 *
 * The cursor belongs to the token's assignment, so a caller cannot advance
 * another assignment's cursor. Backwards or repeated acks are no-ops and a
 * sequence past the newest event is rejected (see the store).
 *
 * Passing `card_id` acks that card's stream; leaving it out acks the
 * project-level stream, mirroring `get_updates` (S5). Without this a standing
 * PM could read project events but never move past them.
 */
export const ackEventsTool = defineTool({
  name: "ack_events",
  description:
    "Advance this assignment's cursor for a card, or for the project stream when card_id is omitted",
  input: z.object({
    card_id: z.string().min(1).optional(),
    up_to_seq: z.number().int().min(0),
  }),
  handler: ({ card_id, up_to_seq }, { store, identity }) => {
    const project_id = identity.actor.project_id;
    const cardId = card_id === undefined ? undefined : (card_id as CardId);
    if (cardId !== undefined) {
      requireCard(store, identity, cardId);
    }

    const result = store.ackEvents({
      project_id,
      assignment_id: identity.actor.assignment_id,
      card_id: cardId ?? PROJECT_STREAM,
      up_to_seq,
    });

    if (!result.ok) {
      throw new ToolError(
        result.error.code,
        result.error.message,
        result.error.details,
      );
    }
    return { card_id: cardId ?? null, ...result.value };
  },
});
