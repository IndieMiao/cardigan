import type { CommandState } from "./commands/core.js";
import { eventById } from "./event-index.js";
import { flowAtLeast } from "./flow.js";
import type { Notification } from "./notification.js";

const field = (p: unknown, name: string) =>
  p && typeof p === "object" ? (p as Record<string, unknown>)[name] : undefined;
const requests = new Set([
  "decision_requested",
  "decision_suggestion_progress",
  "human_action_requested",
  "needs_you_item_ready",
]);

/** Results still need delivery. Only a proved-obsolete request may be retired. */
export function pmNotificationState(
  state: CommandState,
  n: Notification,
): "urgent" | "ordinary" | "obsolete" {
  const event = eventById(state.events, n.event_id);
  if (!event) return "urgent";
  const qid = field(event.payload, "decision_id"),
    hid = field(event.payload, "human_action_id");
  const request = requests.has(event.type);
  if (request && qid) {
    const q = state.decisions.find((q) => q.id === qid);
    if (!q) return "urgent";
    return ["open", "provisional", "snoozed"].includes(q.status)
      ? "urgent"
      : "obsolete";
  }
  if (request && hid) {
    const h = state.human_actions.find((h) => h.id === hid);
    return !h || h.status === "open" ? "urgent" : "obsolete";
  }
  if (request && !qid && !hid) return "urgent";
  if (
    state.work_items.some(
      (w) =>
        w.card_id === n.card_id &&
        ["blocked", "waiting_decision"].includes(w.status),
    )
  )
    return "urgent";
  if (
    state.decisions.some(
      (q) =>
        q.card_id === n.card_id &&
        ["open", "provisional", "snoozed"].includes(q.status) &&
        (q.trigger === "merge_confirmation" || q.blocking),
    )
  )
    return "urgent";
  if (
    ["run_attention", "escalation"].includes(n.kind) ||
    [
      "run_dispatch_stalled",
      "run_preparation_stalled",
      "run_inactive",
      "runtime_disconnected",
    ].includes(event.type)
  )
    return "urgent";
  return "ordinary";
}

export function newPmNotification(
  state: CommandState,
  n: Notification,
): boolean {
  const card = state.cards.find((c) => c.id === n.card_id);
  return (
    !!card &&
    flowAtLeast(card, 6) &&
    n.status === "pending" &&
    n.attempts === 0 &&
    !n.run_id
  );
}

/** N1: stable partition within eligible slots, separately for each original recipient. */
export function orderPmNotificationGroups<T>(
  queue: readonly T[],
  inspect: (value: T) => { recipient: string; urgent: boolean } | undefined,
): T[] {
  const out = [...queue];
  const groups = new Map<
    string,
    { slots: number[]; urgent: T[]; ordinary: T[] }
  >();
  queue.forEach((value, index) => {
    const info = inspect(value);
    if (!info) return;
    const group = groups.get(info.recipient) ?? {
      slots: [],
      urgent: [],
      ordinary: [],
    };
    group.slots.push(index);
    (info.urgent ? group.urgent : group.ordinary).push(value);
    groups.set(info.recipient, group);
  });
  for (const group of groups.values()) {
    const values = [...group.urgent, ...group.ordinary];
    group.slots.forEach((slot, index) => {
      out[slot] = values[index] as T;
    });
  }
  return out;
}
