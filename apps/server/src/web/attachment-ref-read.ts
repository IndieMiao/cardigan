import type { CardId, ProjectId } from "@cardigan/domain";
import type { Store } from "@cardigan/store";
import { HttpRejection } from "./http.js";
import { referencedAttachmentViews } from "./read.js";
import { emptyState, withReferences } from "./sql-state.js";

/** At most this many numbers per read; a body rarely names more. */
export const MAX_ATTACHMENT_REFS = 100;

/**
 * C-615: other cards' attachments that a card page names by number but did
 * not receive with the card: a draft's preview, or timeline pages loaded or
 * kept across a refresh. Same rule as `referenced_attachments`: a sensitive
 * card's attachment, any other card's while cross-card reading is off, or a
 * missing number is left out, so the body keeps it as text.
 */
export function readAttachmentRefs(
  store: Store,
  project_id: ProjectId,
  card_id: CardId,
  idsParam: string | null,
) {
  const ids = [
    ...new Set(
      (idsParam ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  if (
    ids.length > MAX_ATTACHMENT_REFS ||
    ids.some((id) => !/^attachment-[1-9][0-9]{0,15}$/u.test(id))
  )
    throw new HttpRejection(400, "validation_failed", "附件编号无效");
  return store.uow.read((tx) => {
    if (!tx.cards.get(project_id, card_id)) return undefined;
    if (!ids.length) return { attachments: [] };
    const state = withReferences(
      store,
      emptyState(tx, project_id),
      ids.join("\n"),
    );
    return {
      attachments: referencedAttachmentViews(state, card_id, ids),
    };
  });
}
