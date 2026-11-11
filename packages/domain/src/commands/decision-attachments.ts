import type { AttachmentId, CardId } from "../ids.js";
import { type CommandDraft, ensure } from "./core.js";

/**
 * Upper bound on attachments one decision may reference (C-95). The product
 * limit is still open; keep it adjustable here only.
 */
export const MAX_DECISION_ATTACHMENTS = 6;
/**
 * §6: a decision may only show attachments already on this project's decision
 * card or its affected cards; the project-scoped state rejects other projects.
 */
export function decisionAttachments(
  d: CommandDraft,
  ids: readonly AttachmentId[] | undefined,
  cards: readonly CardId[],
): readonly AttachmentId[] {
  if (!ids?.length) return [];
  ensure(
    ids.length <= MAX_DECISION_ATTACHMENTS,
    "validation_failed",
    `A decision can reference at most ${MAX_DECISION_ATTACHMENTS} attachments`,
  );
  ensure(
    new Set(ids).size === ids.length,
    "validation_failed",
    "Duplicate attachment reference",
  );
  for (const id of ids)
    ensure(
      cards.includes(d.get("attachments", id).card_id),
      "validation_failed",
      `Attachment ${id} does not belong to the decision's cards`,
    );
  return [...ids];
}
