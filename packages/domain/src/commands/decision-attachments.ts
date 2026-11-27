import { attachmentReferenceIdsIn } from "../attachment-refs.js";
import type { Card, Delivery } from "../entities.js";
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

/** C-809: what a decision shows, and how many more it left out at the limit. */
export interface DecisionAttachmentSelection {
  readonly attachment_ids?: readonly AttachmentId[];
  readonly attachments_omitted?: number;
}

function capped(
  ids: readonly AttachmentId[],
  room = MAX_DECISION_ATTACHMENTS,
): DecisionAttachmentSelection {
  const shown = ids.slice(0, Math.max(0, room));
  const omitted = ids.length - shown.length;
  return {
    ...(shown.length ? { attachment_ids: shown } : {}),
    ...(omitted > 0 ? { attachments_omitted: omitted } : {}),
  };
}

/** Attachments of this card a decision may show; expired streams never. */
function liveCardAttachments(d: CommandDraft, cards: readonly CardId[]) {
  return d
    .list("attachments")
    .filter((a) => cards.includes(a.card_id) && !a.streamed_artifact?.expired);
}

/**
 * C-809: the files a system decision about a delivery shows — those the
 * delivery lists, then those uploaded onto it; for a system completion also
 * those uploaded onto the product deliveries it sums up. Only the card's own,
 * live attachments, each once, at most {@link MAX_DECISION_ATTACHMENTS}; the
 * rest are counted.
 */
export function deliveryDecisionAttachments(
  d: CommandDraft,
  card: Pick<Card, "id">,
  delivery: Delivery,
): DecisionAttachmentSelection {
  const live = liveCardAttachments(d, [card.id]);
  const own = new Set(live.map((a) => a.id));
  const sources = new Set<string>([
    delivery.id,
    ...(delivery.system_completion?.products.map((p) => p.delivery_id) ?? []),
  ]);
  const uploaded = live
    .filter(
      (a) => a.attach_to.kind === "delivery" && sources.has(a.attach_to.id),
    )
    .map((a) => a.id);
  return capped(
    [...new Set([...delivery.attachments, ...uploaded])].filter((id) =>
      own.has(id),
    ),
  );
}

/**
 * C-809: a raiser's explicit attachments, then the decision cards' live
 * attachments its context names but did not attach, up to the limit. Numbers
 * of other cards' (or missing) attachments stay text and are not counted.
 */
export function referencedDecisionAttachments(
  d: CommandDraft,
  explicit: readonly AttachmentId[],
  context: string,
  cards: readonly CardId[],
): DecisionAttachmentSelection {
  const live = new Set(liveCardAttachments(d, cards).map((a) => a.id));
  const named = attachmentReferenceIdsIn([context]).filter(
    (id) =>
      live.has(id as AttachmentId) && !explicit.includes(id as AttachmentId),
  ) as AttachmentId[];
  const auto = capped(named, MAX_DECISION_ATTACHMENTS - explicit.length);
  const attachment_ids = [...explicit, ...(auto.attachment_ids ?? [])];
  return {
    ...(attachment_ids.length ? { attachment_ids } : {}),
    ...(auto.attachments_omitted
      ? { attachments_omitted: auto.attachments_omitted }
      : {}),
  };
}
