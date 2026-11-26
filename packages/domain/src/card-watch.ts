import type { Card, Event } from "./entities.js";
import { eventsOfType } from "./event-index.js";
import type { AssignmentId, CardId, EventId } from "./ids.js";

/**
 * C-763: a PM's one-shot "tell me when that card reaches X" note. Folded from
 * events, never a gate: registering changes no card, work item or Run, and
 * nothing reads a watch to decide whether work may proceed or merge.
 */
export const CARD_WATCH_REGISTERED = "card_watch_registered";
/** The target reached the requested state. */
export const CARD_WATCH_TRIGGERED = "card_watch_triggered";
/** The target closed another way (cancelled, superseded, done without merge). */
export const CARD_WATCH_ENDED = "card_watch_ended";

export const CARD_WATCH_UNTIL = ["done", "merged", "cancelled"] as const;
export type CardWatchUntil = (typeof CARD_WATCH_UNTIL)[number];
export const CARD_WATCH_UNTIL_LABELS: Readonly<Record<CardWatchUntil, string>> =
  { done: "完成", merged: "合并", cancelled: "取消" };

/** Open watches one recipient may hold at a time. */
export const CARD_WATCH_OPEN_LIMIT = 20;
export const CARD_WATCH_NOTE_MAX_LENGTH = 200;

export type CardWatchRecipient =
  | { readonly kind: "assignment"; readonly assignment_id: AssignmentId }
  | { readonly kind: "pm_ops" };

export interface CardWatchRegistered {
  readonly target_card_id: CardId;
  readonly until: CardWatchUntil;
  readonly recipient: CardWatchRecipient;
  /** The card where the registrant waits; bells are posted there. */
  readonly context_card_id?: CardId;
  readonly note?: string;
}

export type CardWatchEndReason =
  | "cancelled"
  | "superseded"
  | "duplicate"
  | "wontdo"
  | "done"
  | "done_without_merge";
export const CARD_WATCH_END_LABELS: Readonly<
  Record<CardWatchEndReason, string>
> = {
  cancelled: "已取消",
  superseded: "已被取代",
  duplicate: "已作为重复关闭",
  wontdo: "已关闭不做",
  done: "已完成",
  done_without_merge: "未合并即已完成",
};

export interface CardWatch extends CardWatchRegistered {
  /** The registration event; the watch's identity. */
  readonly id: EventId;
  /** The stream the registration (and its settlement) lives in. */
  readonly card_id: CardId;
  readonly registered_by: string;
  readonly registered_at: string;
  readonly settled_by?: EventId;
}

const recipientKey = (r: CardWatchRecipient) =>
  r.kind === "assignment" ? `assignment:${r.assignment_id}` : r.kind;
export const sameCardWatchRecipient = (
  a: CardWatchRecipient,
  b: CardWatchRecipient,
) => recipientKey(a) === recipientKey(b);

const authorOf = (e: Event) =>
  e.actor.kind === "assignment"
    ? `assignment:${e.actor.assignment_id}`
    : e.actor.kind;

/** Every watch of this project in registration order, with its settlement. */
export function cardWatches(
  events: readonly Event[],
  project_id: string,
): readonly CardWatch[] {
  const registered = eventsOfType(events, CARD_WATCH_REGISTERED).filter(
    (e) => e.actor.project_id === project_id && e.card_id,
  );
  if (!registered.length) return [];
  const settled = new Map<string, EventId>();
  for (const type of [CARD_WATCH_TRIGGERED, CARD_WATCH_ENDED])
    for (const e of eventsOfType(events, type)) {
      const watch = (e.payload as { watch_id?: unknown } | null)?.watch_id;
      if (
        e.actor.kind === "system" &&
        e.actor.project_id === project_id &&
        typeof watch === "string" &&
        !settled.has(watch)
      )
        settled.set(watch, e.id);
    }
  return registered.map((e) => {
    const p = e.payload as unknown as CardWatchRegistered;
    const settled_by = settled.get(e.id);
    return {
      target_card_id: p.target_card_id,
      until: p.until,
      recipient: p.recipient,
      ...(p.context_card_id ? { context_card_id: p.context_card_id } : {}),
      ...(p.note ? { note: p.note } : {}),
      id: e.id,
      card_id: e.card_id as CardId,
      registered_by: authorOf(e),
      registered_at: e.created_at,
      ...(settled_by ? { settled_by } : {}),
    };
  });
}

export const openCardWatches = (events: readonly Event[], project_id: string) =>
  cardWatches(events, project_id).filter((w) => !w.settled_by);

export type CardWatchOutcome =
  | { readonly kind: "reached"; readonly evidence_event_id?: EventId }
  | { readonly kind: "ended"; readonly reason: CardWatchEndReason };

/** Trusted merge record of this card (system actor, same project). */
export function cardMergedEvent(events: readonly Event[], card: Card) {
  return eventsOfType(events, "card_merged").findLast(
    (e) =>
      e.card_id === card.id &&
      e.actor.kind === "system" &&
      e.actor.project_id === card.project_id,
  );
}

const closedReason = (card: Card): CardWatchEndReason =>
  card.resolution && card.resolution !== "done"
    ? card.resolution
    : card.status === "cancelled"
      ? "cancelled"
      : "done";

/**
 * Where the target stands for this watch: reached, closed another way, or
 * still open (undefined). Only a closed card or a trusted merge settles it.
 */
export function cardWatchOutcome(
  events: readonly Event[],
  card: Card,
  until: CardWatchUntil,
): CardWatchOutcome | undefined {
  if (until === "merged") {
    const merged = cardMergedEvent(events, card);
    if (merged) return { kind: "reached", evidence_event_id: merged.id };
  }
  if (card.status !== "done" && card.status !== "cancelled") return undefined;
  const reason = closedReason(card);
  if (until === "done" && reason === "done") return { kind: "reached" };
  if (until === "cancelled" && card.status === "cancelled")
    return { kind: "reached" };
  return {
    kind: "ended",
    reason:
      until === "merged" && reason === "done" ? "done_without_merge" : reason,
  };
}
