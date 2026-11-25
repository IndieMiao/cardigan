import { authorView } from "../author-view.js";
import type { Author, Decision, Event } from "../entities.js";
import { cardEventsOfType } from "../event-index.js";
import type { CommandState } from "./core.js";

export const SUGGESTION_REMINDER_WINDOW_MS = 5 * 60_000;

const field = (event: Event, name: string): unknown =>
  event.payload && typeof event.payload === "object"
    ? (event.payload as Record<string, unknown>)[name]
    : undefined;

function progressEvent(event: Event): boolean {
  switch (event.type) {
    case "comment_posted":
      return event.actor.kind !== "system";
    case "merge_check_finished":
      return ["passed", "failed"].includes(String(field(event, "status")));
    case "delivery_submitted":
    case "review_submitted":
    case "completion_reviewed":
    case "human_action_completed":
      return true;
    default:
      return false;
  }
}

/** Every type `progressEvent` can accept. */
const PROGRESS_TYPES = [
  "comment_posted",
  "merge_check_finished",
  "delivery_submitted",
  "review_submitted",
  "completion_reviewed",
  "human_action_completed",
];
const indexes = new WeakMap<readonly Event[], Map<string, Event[]>>();
/**
 * C-671: one card's progress events from the per-card type index, so a
 * resolved decision's closed card still answers in the `slim` command state
 * without decoding other cards' history.
 */
function progressFor(events: readonly Event[], card: string) {
  let index = indexes.get(events);
  if (!index) {
    index = new Map();
    indexes.set(events, index);
  }
  let list = index.get(card);
  if (!list) {
    const seen = new Set<string>();
    list = PROGRESS_TYPES.flatMap((type) =>
      cardEventsOfType(events, card, type),
    )
      .sort((a, b) => a.seq - b.seq)
      .filter((event) => {
        if (!progressEvent(event) || seen.has(event.id)) return false;
        seen.add(event.id);
        return true;
      });
    index.set(card, list);
  }
  return list;
}

/** Only cards in this project and in the current decision scope contribute. */
export function suggestionProgressEvents(state: CommandState, q: Decision) {
  const baseline = q.suggestion?.evidence_baseline;
  if (!baseline) return [];
  const scoped = new Set([q.card_id, ...q.affected_cards]);
  return state.cards
    .filter((c) => c.project_id === state.project_id && scoped.has(c.id))
    .flatMap((c) =>
      progressFor(state.events, c.id).filter(
        (e) =>
          e.actor.project_id === state.project_id &&
          baseline[c.id] !== undefined &&
          e.seq > (baseline[c.id] ?? Number.POSITIVE_INFINITY),
      ),
    )
    .sort(
      (a, b) =>
        a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
    );
}

/** Exact evidence acknowledged by the human; no content or credentials. */
export function suggestionProgressToken(state: CommandState, q: Decision) {
  return JSON.stringify(
    suggestionProgressEvents(state, q)
      .map((e) => e.id)
      .sort(),
  );
}

export function suggestionProgressView(state: CommandState, q: Decision) {
  const events = suggestionProgressEvents(state, q);
  if (!events.length) return undefined;
  return {
    count: events.length,
    token: suggestionProgressToken(state, q),
    entries: events.map((event) => {
      const author: Author =
        event.actor.kind === "assignment"
          ? `assignment:${event.actor.assignment_id}`
          : event.actor.kind;
      const sensitive = state.cards.find(
        (c) => c.id === event.card_id,
      )?.sensitive;
      // Use the existing visible timeline text, never raw event payloads/logs.
      const entry = state.timeline.find(
        (t) =>
          t.card_id === event.card_id &&
          t.event_seq === event.seq &&
          !t.retracted,
      );
      const label =
        event.type === "comment_posted"
          ? "新增评论"
          : event.type === "merge_check_finished"
            ? "合并检查结束"
            : event.type === "delivery_submitted"
              ? "新交付"
              : event.type === "human_action_completed"
                ? "人工待办已完成"
                : "新审核结论";
      return {
        id: event.id,
        card_id: event.card_id,
        at: event.created_at,
        author_display: authorView(state, author).author_display,
        summary: sensitive
          ? "敏感卡片有新进展，请在卡片中查看"
          : entry?.body.slice(0, 300) || label,
      };
    }),
  };
}

export function suggestionReminderDue(
  state: CommandState,
  q: Decision,
  now: string,
) {
  if (!["open", "provisional", "snoozed"].includes(q.status)) return false;
  const events = suggestionProgressEvents(state, q);
  const previous = q.suggestion?.progress_notice;
  return (
    events.some((e) => !previous?.event_ids.includes(e.id)) &&
    (!previous ||
      Date.parse(now) - Date.parse(previous.at) >=
        SUGGESTION_REMINDER_WINDOW_MS)
  );
}
