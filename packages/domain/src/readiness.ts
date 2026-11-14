// C-212: readiness conditions for Needs You items.
//
// A ready condition only defers when a human action or a human decision is
// shown in Needs You. It never changes whether the item exists, whether it
// blocks work or holds a merge: those rules keep reading the item itself.
// Readiness is derived from the current state (cards and deliveries), so no
// background job has to flip it; the only stored fact is a PM's manual
// release.
import type {
  Decision,
  Delivery,
  Event,
  HumanAction,
  ReadyCondition,
} from "./entities.js";
import type { CardId, DeliveryId } from "./ids.js";
import { parseId } from "./ids.js";
import type { CardStatus } from "./states.js";

export interface ReadinessState {
  readonly cards: readonly {
    readonly id: CardId;
    readonly status: CardStatus;
  }[];
  readonly deliveries: readonly Delivery[];
  readonly work_items: readonly {
    readonly id: string;
    readonly card_id: CardId;
  }[];
}

const sequence = (id: DeliveryId) => {
  const parsed = parseId("delivery", id);
  return parsed.ok ? parsed.value.sequence : 0;
};

/** Deliveries of one card, oldest first. */
export function cardDeliveries(
  state: ReadinessState,
  card_id: CardId,
): Delivery[] {
  const items = new Set(
    state.work_items.filter((w) => w.card_id === card_id).map((w) => w.id),
  );
  return state.deliveries
    .filter((v) => items.has(v.work_item_id))
    .sort((a, b) => sequence(a.id) - sequence(b.id));
}

/** The first delivery that satisfies a `card_delivery` condition, if any. */
function firstNewDelivery(
  state: ReadinessState,
  cond: Extract<ReadyCondition, { kind: "card_delivery" }>,
) {
  const floor = cond.after ? sequence(cond.after) : 0;
  return cardDeliveries(state, cond.card_id).find(
    (v) => sequence(v.id) > floor,
  );
}

const closed = (state: ReadinessState, card_id: CardId) =>
  ["done", "cancelled"].includes(
    state.cards.find((c) => c.id === card_id)?.status ?? "",
  );

/**
 * Whether the condition itself is met. A card that was cancelled meets every
 * condition about it, so a deferred item can never wait on it forever.
 */
export function readyConditionMet(
  state: ReadinessState,
  cond: ReadyCondition,
): boolean {
  switch (cond.kind) {
    case "manual":
      return false;
    case "card_merged":
      return closed(state, cond.card_id);
    case "card_delivery":
      return (
        closed(state, cond.card_id) ||
        firstNewDelivery(state, cond) !== undefined
      );
  }
}

type Deferrable =
  | Pick<
      HumanAction,
      | "card_id"
      | "ready_when"
      | "ready_released"
      | "blocks_merge"
      | "blocked_work_items"
    >
  | Pick<Decision, "card_id" | "affected_cards" | "ready_when">;

/**
 * Cards whose merge or work the item holds; at their completion request the
 * item may never stay hidden. A human action holds its card when it blocks
 * the merge or pauses work; a human decision is part of every card it names.
 */
export function heldCards(item: Deferrable): CardId[] {
  if ("blocked_work_items" in item)
    return item.card_id &&
      (item.blocks_merge === true || item.blocked_work_items.length > 0)
      ? [item.card_id]
      : [];
  return [
    ...new Set([
      ...(item.card_id ? [item.card_id] : []),
      ...item.affected_cards,
    ]),
  ];
}

function completionSubmitted(state: ReadinessState, card_id: CardId) {
  return cardDeliveries(state, card_id).some(
    (v) => v.kind === "card_completion" && v.status !== "superseded",
  );
}

/**
 * Whether a Needs You item is shown now. Items without a condition are
 * always ready. A deferred item that holds a card surfaces as soon as that
 * card asks to complete, whatever its condition says: readiness may delay an
 * item but never hide it from the merge it holds.
 */
export function needsYouItemReady(
  state: ReadinessState,
  item: Deferrable,
): boolean {
  const cond = item.ready_when;
  if (!cond) return true;
  if ("ready_released" in item && item.ready_released) return true;
  if (readyConditionMet(state, cond)) return true;
  return heldCards(item).some((id) => completionSubmitted(state, id));
}

/** One plain line for the "稍后" list. */
export function readyConditionLabel(cond: ReadyCondition): string {
  switch (cond.kind) {
    case "manual":
      return "等项目经理放行";
    case "card_merged":
      return `等 ${cond.card_id} 合并`;
    case "card_delivery":
      return `等 ${cond.card_id} 出现新交付`;
  }
}

/** Raw condition as accepted from MCP parameters. */
export type ReadyConditionInput =
  | { readonly kind: "card_delivery"; readonly card_id: string }
  | { readonly kind: "card_merged"; readonly card_id: string }
  | { readonly kind: "manual" };

/**
 * Validate a requested condition and pin `card_delivery` to the card's newest
 * delivery so only a later one meets it. Returns an error message instead of
 * throwing so callers keep their own error codes.
 */
export function normalizeReadyCondition(
  state: ReadinessState,
  input: ReadyConditionInput,
  /** Cards the item holds (see `heldCards`). */
  held: readonly CardId[],
  allowManual: boolean,
): ReadyCondition | string {
  if (input.kind === "manual")
    return allowManual ? { kind: "manual" } : "这类事项不支持等项目经理放行";
  if (input.kind !== "card_delivery" && input.kind !== "card_merged")
    return "未知的就绪条件";
  const card = state.cards.find((c) => c.id === input.card_id);
  if (!card) return `就绪条件引用的卡片 ${input.card_id} 不存在`;
  if (["done", "cancelled"].includes(card.status))
    return `${card.id} 已经结束，条件已满足，请不带就绪条件直接发起`;
  if (input.kind === "card_merged") {
    if (held.includes(card.id))
      return `这个事项挡着 ${card.id} 的合并或工作，不能等 ${card.id} 合并，会互相等待`;
    return { kind: "card_merged", card_id: card.id };
  }
  const latest = cardDeliveries(state, card.id).at(-1);
  return {
    kind: "card_delivery",
    card_id: card.id,
    ...(latest ? { after: latest.id } : {}),
  };
}

/**
 * Items this event made ready: the event is the one that first met the
 * condition (or surfaced a merge-holding item at completion). Used to ring
 * the item's audience exactly when it appears. Manual releases are routed
 * from their own event.
 */
export function readinessTriggeredBy<H extends HumanAction, Q extends Decision>(
  state: ReadinessState & {
    readonly human_actions: readonly H[];
    readonly decisions: readonly Q[];
  },
  event: Pick<Event, "type" | "card_id" | "payload">,
): { human_actions: H[]; decisions: Q[] } {
  const card_id = event.card_id;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  if (!card_id) return { human_actions: [], decisions: [] };
  const delivery =
    event.type === "delivery_submitted" &&
    typeof payload.delivery_id === "string"
      ? state.deliveries.find((v) => v.id === payload.delivery_id)
      : undefined;
  const closedNow =
    event.type === "card_merged" ||
    event.type === "card_marked_done" ||
    (event.type === "card_updated" && payload.status === "cancelled");
  const triggered = (item: Deferrable): boolean => {
    const cond = item.ready_when;
    if (!cond || ("ready_released" in item && item.ready_released))
      return false;
    if (!needsYouItemReady(state, item)) return false;
    if (cond.kind !== "manual" && cond.card_id === card_id) {
      if (closedNow) return true;
      if (
        cond.kind === "card_delivery" &&
        delivery &&
        firstNewDelivery(state, cond)?.id === delivery.id
      )
        return true;
    }
    // Surfaced by its own card's completion request, condition still unmet.
    return (
      delivery?.kind === "card_completion" &&
      heldCards(item).includes(card_id) &&
      !readyConditionMet(state, cond)
    );
  };
  return {
    human_actions: state.human_actions.filter(
      (h) => h.status === "open" && triggered(h),
    ),
    decisions: state.decisions.filter(
      (q) =>
        q.decider === "human" &&
        ["open", "provisional", "snoozed"].includes(q.status) &&
        triggered(q),
    ),
  };
}
