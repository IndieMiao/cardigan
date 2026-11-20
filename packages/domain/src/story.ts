import type { Card } from "./entities.js";

export const storyTerminal = (card: Pick<Card, "status">) =>
  card.status === "done" || card.status === "cancelled";

/** Callers must supply only visible cards. Never embed child content or attachments. */
export function storyProgress(cards: readonly Card[], parent: Card) {
  const children = cards
    .filter(
      (c) =>
        c.project_id === parent.project_id && c.parent_card_id === parent.id,
    )
    .map(({ id, title, status }) => ({ id, title, status }));
  const counts = {
    backlog: 0,
    todo: 0,
    in_progress: 0,
    review: 0,
    awaiting_merge: 0,
    done: 0,
    cancelled: 0,
  };
  for (const child of children) counts[child.status]++;
  return {
    children,
    counts,
    finished: counts.done + counts.cancelled,
    total: children.length,
  };
}
