import type { CommandState } from "@cardigan/domain";

const unique = <T extends { readonly id: string }>(values: readonly T[]) => [
  ...new Map(values.map((v) => [v.id, v])).values(),
];
const pending = (status: string) =>
  ["open", "provisional", "snoozed"].includes(status);
const readyCard = (
  item: (CommandState["decisions"] | CommandState["human_actions"])[number],
) =>
  item.ready_when && item.ready_when.kind !== "manual"
    ? [item.ready_when.card_id]
    : [];
const idOrder = <T extends { readonly id: string }>(values: readonly T[]) =>
  [...values].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/**
 * Preserve the old SQL reader's stable tie order: source decisions first,
 * scoped card decisions next, then project candidates and notice dependencies.
 * Build from immutable cached entities; never reload historical JSON. The card
 * closure mirrors scopedCardState, including sources found by dependency expansion.
 */
export function orderedNeedsDecisions(
  state: CommandState,
): CommandState["decisions"] {
  const cards = idOrder(state.cards);
  const decisions = idOrder(state.decisions);
  const items = state.work_items;
  const active = new Set(
    cards
      .filter((c) => !["done", "cancelled"].includes(c.status))
      .map((c) => c.id),
  );
  const candidates = decisions.filter(
    (q) =>
      pending(q.status) ||
      (q.status === "resolved" && (!q.card_id || active.has(q.card_id))),
  );
  const actions = state.human_actions.filter(
    (h) =>
      h.status === "open" ||
      (h.status === "done" && (!h.card_id || active.has(h.card_id))),
  );
  let ids = new Set<string>([
    ...active,
    ...[...candidates, ...actions].flatMap(readyCard),
    ...candidates.flatMap((q) => [
      ...q.affected_cards,
      ...(q.card_id ? [q.card_id] : []),
    ]),
    ...actions.flatMap((h) => (h.card_id ? [h.card_id] : [])),
  ]);
  let scoped: CommandState["decisions"] = [];
  for (;;) {
    const initial = cards.filter((c) => ids.has(c.id));
    const sourceIds = new Set(
      initial.flatMap((c) =>
        c.source.kind === "decision" ? [c.source.decision_id] : [],
      ),
    );
    const sources = decisions.filter((q) => sourceIds.has(q.id));
    const related = new Set([
      ...initial.flatMap((c) => c.related_cards),
      ...sources.flatMap((q) => (q.card_id ? [q.card_id] : [])),
    ]);
    const expanded = unique([
      ...initial,
      ...cards.filter((c) => related.has(c.id)),
    ]);
    const cardIds = new Set(expanded.map((c) => c.id));
    const ownItems = items.filter((w) => cardIds.has(w.card_id));
    const itemIds = new Set(ownItems.map((w) => w.id));
    scoped = unique([
      ...sources,
      ...decisions.filter(
        (q) =>
          (q.card_id && cardIds.has(q.card_id)) ||
          q.affected_cards.some((c) => cardIds.has(c)) ||
          q.affected_work_items.some((w) => itemIds.has(w)),
      ),
    ]);
    const ownActions = state.human_actions.filter(
      (h) =>
        (h.card_id && cardIds.has(h.card_id)) ||
        h.blocked_work_items.some((w) => itemIds.has(w)),
    );
    const dependencyItems = new Set([
      ...scoped.flatMap((q) => q.affected_work_items),
      ...ownItems.flatMap((w) => w.depends_on),
      ...ownActions.flatMap((h) => h.blocked_work_items),
    ]);
    const dependencies = new Set([
      ...scoped.flatMap((q) => q.affected_cards),
      ...unique([
        ...ownItems,
        ...items.filter((w) => dependencyItems.has(w.id)),
      ]).map((w) => w.card_id),
      ...[...scoped, ...ownActions].flatMap(readyCard),
    ]);
    const missing = cards.filter(
      (c) => dependencies.has(c.id) && !cardIds.has(c.id),
    );
    if (!missing.length) break;
    ids = new Set([...cardIds, ...missing.map((c) => c.id)]);
  }
  // Remaining entities stay available to the full source snapshot, after the
  // legacy selected set; only the original order of tied visible items changes.
  return unique([...scoped, ...candidates, ...decisions]);
}
