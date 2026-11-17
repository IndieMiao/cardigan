import type {
  Assignment,
  Card,
  CardDependencyView,
  Delivery,
  Event,
  WorkItem,
} from "./entities.js";
import type { CardId } from "./ids.js";
import { cardMergeCandidates } from "./merge-candidates.js";
import { type CardTemplate, cardTemplate } from "./templates.js";

export interface CardDependencyState {
  readonly cards: readonly Card[];
  readonly events: readonly Event[];
  readonly card_templates?: readonly CardTemplate[];
  readonly deliveries: readonly Delivery[];
  readonly work_items: readonly WorkItem[];
}

/** A terminal label alone is not proof that a prerequisite completed normally. */
export function cardDependencyComplete(
  state: CardDependencyState,
  card: Card,
): boolean {
  if (card.status !== "done" || (card.resolution && card.resolution !== "done"))
    return false;
  const template = cardTemplate(card, state.card_templates);
  if (!template) return false;
  const policy = card.merge_policy ?? template.merge;
  const events = state.events.filter(
    (e) => e.card_id === card.id && e.actor.project_id === card.project_id,
  );
  if (!["none", "confirm", "auto"].includes(policy)) return false;
  if (
    policy !== "none" &&
    events.some((e) => e.type === "card_merged" && e.actor.kind === "system")
  )
    return true;
  // confirm/auto describe publication policy, not whether this card produced
  // Git commits. Match completionPassed's merge_not_required branch exactly.
  if (cardMergeCandidates(state, card).length) return false;
  if (template.completion.mode === "human_mark_done")
    return events.some(
      (e) => e.type === "card_marked_done" && e.actor.kind === "human",
    );
  if (template.completion.mode !== "review") return false;
  const owners = new Set(
    state.work_items.filter((w) => w.card_id === card.id).map((w) => w.id),
  );
  return state.deliveries.some(
    (v) =>
      v.kind === "card_completion" &&
      v.status === "accepted" &&
      owners.has(v.work_item_id) &&
      events.some((e) => {
        const p = e.payload as Record<string, unknown> | null;
        return (
          p?.delivery_id === v.id &&
          ((e.type === "review_submitted" && p.verdict === "pass") ||
            (e.type === "completion_reviewed" &&
              e.actor.kind === "human" &&
              p.verdict === "pass") ||
            (e.type === "delivery_submitted" &&
              e.actor.kind === "system" &&
              !!v.system_completion) ||
            e.type === "review_reused")
        );
      }),
  );
}

export function unmetCardDependencies(
  state: CardDependencyState,
  card: Card,
): CardId[] {
  return (card.depends_on_cards ?? []).filter((id) => {
    const before = state.cards.find(
      (c) => c.id === id && c.project_id === card.project_id,
    );
    return !before || !cardDependencyComplete(state, before);
  });
}

export function cardDependenciesAllowStart(
  state: CardDependencyState,
  card: Card,
): boolean {
  return !!card.early_start || unmetCardDependencies(state, card).length === 0;
}

export function assignmentDependenciesAllowStart(
  state: CardDependencyState,
  assignment: Assignment,
): boolean {
  if (assignment.scope !== "work_item") return true;
  const item = state.work_items.find((w) => w.id === assignment.work_item_id);
  const card = state.cards.find((c) => c.id === item?.card_id);
  return !card || cardDependenciesAllowStart(state, card);
}

/** Count unfinished vertices on the longest successor path; completed vertices have weight zero. */
export function cardCriticalPathLengths(
  state: CardDependencyState,
): ReadonlyMap<CardId, number> {
  const previous = pathCache.get(state.cards);
  if (
    previous &&
    previous.events === state.events &&
    previous.deliveries === state.deliveries &&
    previous.work_items === state.work_items &&
    previous.card_templates === state.card_templates
  )
    return previous.lengths;
  const cards = new Map(state.cards.map((c) => [c.id, c]));
  const successors = new Map<CardId, CardId[]>();
  const remaining = new Map<CardId, number>();
  const lengths = new Map<CardId, number>();
  const weights = new Map(
    state.cards.map((c) => [c.id, cardDependencyComplete(state, c) ? 0 : 1]),
  );
  for (const card of state.cards) {
    lengths.set(card.id, weights.get(card.id) ?? 1);
    for (const id of new Set(card.depends_on_cards ?? [])) {
      if (cards.get(id)?.project_id !== card.project_id) continue;
      successors.set(id, [...(successors.get(id) ?? []), card.id]);
    }
  }
  const queue: CardId[] = [];
  for (const card of state.cards) {
    const count = successors.get(card.id)?.length ?? 0;
    remaining.set(card.id, count);
    if (!count) queue.push(card.id);
  }
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (!id) continue;
    const card = cards.get(id);
    if (!card) continue;
    for (const previous of new Set(card.depends_on_cards ?? [])) {
      const before = cards.get(previous);
      if (!before || before.project_id !== card.project_id) continue;
      const weight = weights.get(previous) ?? 1;
      lengths.set(
        previous,
        Math.max(lengths.get(previous) ?? 0, weight + (lengths.get(id) ?? 0)),
      );
      const count = (remaining.get(previous) ?? 0) - 1;
      remaining.set(previous, count);
      if (!count) queue.push(previous);
    }
  }
  // Corrupt legacy cycles must not acquire scheduling preference.
  for (const [id, count] of remaining) if (count) lengths.set(id, 0);
  pathCache.set(state.cards, { ...state, lengths });
  return lengths;
}

const pathCache = new WeakMap<
  readonly Card[],
  CardDependencyState & { lengths: ReadonlyMap<CardId, number> }
>();

export function cardDependencyDispatchOrder(
  state: CardDependencyState,
  assignment: Assignment,
): { critical_path_length?: number } {
  if (
    assignment.scope !== "work_item" ||
    !state.cards.some((c) => c.depends_on_cards?.length)
  )
    return {};
  const id = state.work_items.find(
    (w) => w.id === assignment.work_item_id,
  )?.card_id;
  const length = id ? (cardCriticalPathLengths(state).get(id) ?? 0) : 0;
  return length > 1 ? { critical_path_length: length } : {};
}

export function cardDependencyView(
  state: CardDependencyState,
  card: Card,
): CardDependencyView {
  const ref = (c: Card) => ({
    id: c.id,
    title: c.title,
    status: c.status,
    ...(c.resolution ? { resolution: c.resolution } : {}),
    satisfied: cardDependencyComplete(state, c),
  });
  return {
    predecessors: (card.depends_on_cards ?? []).map((id) => {
      const before = state.cards.find(
        (c) => c.id === id && c.project_id === card.project_id,
      );
      return before
        ? ref(before)
        : { id, title: id, status: "unknown" as const, satisfied: false };
    }),
    successors: state.cards
      .filter(
        (c) =>
          c.project_id === card.project_id &&
          c.depends_on_cards?.includes(card.id),
      )
      .map(ref),
    waiting_on: unmetCardDependencies(state, card),
    critical_path_length: cardCriticalPathLengths(state).get(card.id) ?? 0,
  };
}
