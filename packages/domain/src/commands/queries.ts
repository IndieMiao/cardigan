import { type CardDerivedFields, deriveCardFields } from "../card-derived.js";
import {
  deriveAttachmentApproval,
  deriveCardStatus,
  deriveReviewMatrix,
  isReviewStale,
} from "../derived.js";
import type { Actor, CardView, Cursor, Decision } from "../entities.js";
import type { CardId } from "../ids.js";
import {
  type CommandDraft,
  type CommandState,
  command,
  ensure,
} from "./core.js";

function affects(d: CommandDraft, q: Decision, id: CardId) {
  return (
    q.card_id === id ||
    q.affected_cards.includes(id) ||
    q.affected_work_items.some((wi) => d.get("work_items", wi).card_id === id)
  );
}
type CommandCardView = Omit<CardView, "waiting_on" | "next_owners" | "why"> &
  CardDerivedFields;
function cardView(d: CommandDraft, id: CardId): CommandCardView {
  const card = d.card(id);
  const items = d.list("work_items").filter((w) => w.card_id === id);
  const deliveries = d
    .list("deliveries")
    .filter((v) => items.some((w) => w.id === v.work_item_id));
  const open = d
    .list("decisions")
    .filter(
      (q) =>
        (q.status === "open" || q.status === "provisional") &&
        affects(d, q, id),
    );
  const actions = d
    .list("human_actions")
    .filter(
      (h) =>
        h.status === "open" &&
        (h.card_id === id ||
          h.blocked_work_items.some((wi) => items.some((w) => w.id === wi))),
    );
  const completion = deliveries
    .filter((v) => v.kind === "card_completion" && v.status !== "superseded")
    .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
  const status = deriveCardStatus(card.status, items, completion);
  const fields = deriveCardFields({
    card,
    work_items: items,
    assignments: d.list("assignments"),
    deliveries,
    reviews: d.list("reviews"),
    decisions: open,
    human_actions: actions,
    status,
  });
  return {
    ...card,
    status,
    open_decisions: open.map((q) => q.id),
    review_matrix: deriveReviewMatrix(deliveries, items, d.list("reviews")),
    ...fields,
  };
}
export function whoami(state: CommandState, actor: Actor) {
  return command(state, actor, "whoami", undefined, (d) => {
    ensure(
      d.assignment && actor.kind === "assignment",
      "unauthorized",
      "An assignment token is required",
    );
    const a = d.assignment;
    const item = a.scope === "work_item" ? d.work(a.work_item_id) : undefined;
    return {
      project_id: state.project_id,
      assignment_id: a.id,
      role_id: a.role_id,
      role_version: a.role_version,
      allowed_tools: actor.allowed_tools,
      capabilities: actor.capabilities,
      machine_id: a.machine_id,
      ...(item ? { work_item_id: item.id, card_id: item.card_id } : {}),
      ...(a.worktree_path ? { worktree_path: a.worktree_path } : {}),
      ...(a.branch ? { branch: a.branch } : {}),
    };
  });
}
export function getCard(
  state: CommandState,
  actor: Actor,
  p: { card_id: CardId },
) {
  return command(state, actor, "get_card", undefined, (d) => {
    const card = cardView(d, p.card_id);
    const work_items = d
      .list("work_items")
      .filter((w) => w.card_id === card.id);
    const deliveries = d
      .list("deliveries")
      .filter((v) => work_items.some((w) => w.id === v.work_item_id));
    const reviews = d
      .list("reviews")
      .filter((r) => deliveries.some((v) => v.id === r.delivery_id))
      .map((r) => {
        const target = deliveries.find((v) => v.id === r.delivery_id);
        return {
          ...r,
          stale:
            !target ||
            isReviewStale(r, target) ||
            deliveries.some((v) => v.supersedes === r.delivery_id),
        };
      });
    return {
      card,
      work_items,
      deliveries,
      reviews,
      decisions: d
        .list("decisions")
        .filter((q) => card.open_decisions.includes(q.id)),
      attachments: d
        .list("attachments")
        .filter((a) => a.card_id === card.id)
        .map((a) => ({
          ...a,
          approval_status: deriveAttachmentApproval(a, d.list("decisions")),
        })),
      timeline: state.timeline.filter((e) => e.card_id === card.id),
    };
  });
}
export function getUpdates(
  state: CommandState,
  actor: Actor,
  p: { card_id?: CardId; since_seq?: number } = {},
) {
  return command(state, actor, "get_updates", undefined, (d) => {
    const card_id =
      p.card_id ??
      (d.assignment?.scope === "work_item"
        ? d.work(d.assignment.work_item_id).card_id
        : undefined);
    if (card_id) d.card(card_id);
    else d.projectAccess();
    const cursor = state.cursors.find(
      (c) => c.card_id === card_id && c.assignment_id === d.assignment?.id,
    );
    const since = p.since_seq ?? cursor?.acked_seq ?? 0;
    ensure(
      Number.isSafeInteger(since) && since >= 0,
      "validation_failed",
      "since_seq must be a nonnegative safe integer",
    );
    const events = state.events.filter((e) => e.card_id === card_id);
    return {
      events: events.filter((e) => e.seq > since).sort((a, b) => a.seq - b.seq),
      timeline: card_id
        ? state.timeline
            .filter((e) => e.card_id === card_id && e.event_seq > since)
            .sort((a, b) => a.event_seq - b.event_seq)
        : [],
      latest_seq: Math.max(0, ...events.map((e) => e.seq)),
    };
  });
}
export function ackEvents(
  state: CommandState,
  actor: Actor,
  p: { card_id: CardId; up_to_seq: number },
) {
  return command(state, actor, "ack_events", undefined, (d) => {
    d.card(p.card_id);
    ensure(
      d.assignment,
      "unauthorized",
      "Only an assignment has an event cursor",
    );
    const latest = Math.max(
      0,
      ...state.events.filter((e) => e.card_id === p.card_id).map((e) => e.seq),
    );
    ensure(
      Number.isSafeInteger(p.up_to_seq) &&
        p.up_to_seq >= 0 &&
        p.up_to_seq <= latest,
      "validation_failed",
      "Acknowledgement exceeds the stream or is invalid",
    );
    const existing = state.cursors.find(
      (c) => c.assignment_id === d.assignment?.id && c.card_id === p.card_id,
    );
    const cursor: Cursor = {
      assignment_id: d.assignment.id,
      card_id: p.card_id,
      acked_seq: Math.max(existing?.acked_seq ?? 0, p.up_to_seq),
    };
    if (!existing || cursor.acked_seq !== existing.acked_seq)
      d.put("cursors", cursor);
    return cursor;
  });
}
export function projectSnapshot(state: CommandState, actor: Actor) {
  return command(state, actor, "project_snapshot", undefined, (d) => {
    d.pm();
    d.projectAccess();
    return {
      project_id: state.project_id,
      cards: d.list("cards").map((c) => cardView(d, c.id)),
    };
  });
}
export function listNeedsYou(state: CommandState, actor: Actor) {
  return command(state, actor, "list_needs_you", undefined, (d) => {
    d.pm();
    d.projectAccess();
    const why = (text: string) => [...text].slice(0, 40).join("");
    return {
      decisions: d
        .list("decisions")
        .filter(
          (q) =>
            q.decider === "human" && ["open", "provisional"].includes(q.status),
        )
        .map((q) => ({ ...q, why: why(q.question) })),
      human_actions: d
        .list("human_actions")
        .filter((h) => h.status === "open")
        .map((h) => ({ ...h, why: why(h.why_human) })),
    };
  });
}
