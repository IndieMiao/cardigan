import * as crypto from "node:crypto";
import type { Card, Decision, Event } from "./entities.js";

type SourceCard = Pick<Card, "id" | "source"> &
  Partial<Pick<Card, "project_id">>;

/** Bind consent to this card and this revision of its source, never to all cards
 * referring to the same decision. Audit revisions prevent change-and-restore. */
export function sourceMergeBasis(
  card: SourceCard,
  source: Decision,
  events: readonly Event[],
) {
  // A pure digest binds the full revision without copying restricted source text
  // into another card's decision, events, or command response.
  return `sha256:${crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        card.id,
        card.source,
        source.id,
        source.category,
        source.question,
        source.context,
        source.options,
        source.status,
        source.resolution,
        source.superseded_by,
        events
          .filter(
            (e) =>
              (e.card_id === card.id &&
                ["card_updated", "delivery_submitted"].includes(e.type)) ||
              (e.type.startsWith("decision_") &&
                (e.payload as { decision_id?: unknown } | null)?.decision_id ===
                  source.id),
          )
          .map((e) => e.id)
          .sort(),
      ]),
    )
    .digest("hex")}`;
}

export function sourceMergeConfirmation(
  card: SourceCard,
  source: Decision,
  events: readonly Event[],
) {
  if (
    card.source.kind !== "decision" ||
    card.source.decision_id !== source.id ||
    source.status !== "resolved" ||
    source.superseded_by ||
    !card.project_id
  )
    return undefined;
  const basis = sourceMergeBasis(card, source, events);
  return events.findLast((e) => {
    const p = e.payload as {
      source_decision_id?: unknown;
      source_basis?: unknown;
      rationale?: unknown;
    } | null;
    return (
      e.type === "source_merge_unrelated_confirmed" &&
      e.actor.kind === "human" &&
      e.actor.project_id === card.project_id &&
      e.card_id === card.id &&
      p?.source_decision_id === source.id &&
      p.source_basis === basis &&
      typeof p.rationale === "string" &&
      p.rationale.trim().length > 0
    );
  });
}
