import { type CardDerivedFields, deriveCardFields } from "../card-derived.js";
import { deriveCardStatus, deriveReviewMatrix } from "../derived.js";
import type {
  Actor,
  Card,
  CardView,
  Decision,
  Delivery,
  Review,
  WorkItem,
} from "../entities.js";
import type { CardId } from "../ids.js";
import { requesterNotificationRecipient } from "../notification.js";
import type { Clock } from "../ports.js";
import { reviewLimitAttention } from "../review-limit-attention.js";
import { type CommandDraft, type CommandState, command } from "./core.js";
import { latestMergeCheck } from "./merge-check.js";
import { resolveCardTemplate } from "./templates.js";

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
  const merge_check = completion
    ? latestMergeCheck(d.state.events, id, completion.id)
    : undefined;
  const fields = deriveCardFields({
    card,
    template: resolveCardTemplate(d, card),
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
    ...(merge_check ? { merge_check } : {}),
    ...fields,
  };
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

const numericId = (id: string): number => {
  const digits = /(\d+)\)?$/.exec(id)?.[1];
  return digits === undefined ? 0 : Number(digits);
};
const newest = <T extends { readonly id: string }>(
  values: readonly T[],
): T | undefined =>
  [...values].sort(
    (left, right) => numericId(right.id) - numericId(left.id),
  )[0];

/** Every card a decision names, with the title the Needs You page shows. */
function relatedCards(
  cards: readonly Card[],
  decision: Decision,
): readonly { readonly id: string; readonly title: string }[] {
  const ids = [
    ...new Set([
      ...(decision.card_id === undefined ? [] : [decision.card_id]),
      ...decision.affected_cards,
    ]),
  ];
  return ids.flatMap((id) => {
    const card = cards.find((candidate) => candidate.id === id);
    return card === undefined ? [] : [{ id: card.id, title: card.title }];
  });
}

/**
 * What a merge confirmation will merge.
 *
 * Candidate deliveries follow `mergePlan`: each producing work item's newest
 * non-superseded Git delivery that is accepted. Reviews are the latest current
 * conclusion per verifier; the completion's known gaps travel with it so the
 * human can decide before the merge.
 */
function mergeConfirmation(
  decision: Decision,
  items: readonly WorkItem[],
  deliveries: readonly Delivery[],
  reviews: readonly Review[],
) {
  if (decision.trigger !== "merge_confirmation") return null;
  const cardItems = items.filter((item) => item.card_id === decision.card_id);
  const products = cardItems
    .filter((item) => item.kind === "produce")
    .sort((left, right) => numericId(left.id) - numericId(right.id));
  const candidates = products.flatMap((item) => {
    const delivery = newest(
      deliveries.filter(
        (candidate) =>
          candidate.work_item_id === item.id &&
          candidate.kind !== "card_completion" &&
          candidate.status !== "superseded",
      ),
    );
    if (delivery?.status !== "accepted" || delivery.subject.kind !== "git_head")
      return [];
    return [
      {
        id: delivery.id,
        work_item_id: item.id,
        work_item_title: item.title,
        subject: delivery.subject,
        summary: delivery.summary,
      },
    ];
  });
  let completionTarget: Delivery["id"] | undefined;
  if (decision.kind === "approve") {
    const target = decision.target;
    if ("delivery_id" in target) completionTarget = target.delivery_id;
  }
  const completion =
    (completionTarget === undefined
      ? undefined
      : deliveries.find((delivery) => delivery.id === completionTarget)) ??
    newest(
      deliveries.filter(
        (delivery) =>
          delivery.kind === "card_completion" &&
          delivery.status !== "superseded" &&
          cardItems.some((item) => item.id === delivery.work_item_id),
      ),
    );
  const current = new Map<string, Delivery>();
  for (const candidate of candidates) {
    const delivery = deliveries.find((entry) => entry.id === candidate.id);
    if (delivery !== undefined) current.set(delivery.id, delivery);
  }
  if (completion !== undefined) current.set(completion.id, completion);
  const latest = new Map<string, Review>();
  for (const review of reviews) {
    const delivery = current.get(review.delivery_id);
    if (
      delivery === undefined ||
      review.target_sha !== delivery.subject.value ||
      delivery.status === "superseded"
    )
      continue;
    const previous = latest.get(review.work_item_id);
    if (previous === undefined || numericId(review.id) > numericId(previous.id))
      latest.set(review.work_item_id, review);
  }
  const reviewRows = [...latest.values()]
    .sort(
      (left, right) =>
        numericId(left.work_item_id) - numericId(right.work_item_id),
    )
    .map((review) => {
      const item = items.find((entry) => entry.id === review.work_item_id);
      return {
        id: review.id,
        delivery_id: review.delivery_id,
        work_item_id: review.work_item_id,
        work_item_title: item?.title ?? null,
        role_id: item?.role_id ?? null,
        kind: review.kind,
        verdict: review.verdict,
        target_sha: review.target_sha,
        issues: review.issues,
      };
    });
  return {
    completion:
      completion === undefined
        ? null
        : {
            id: completion.id,
            work_item_id: completion.work_item_id,
            summary: completion.summary,
            subject: completion.subject,
          },
    deliveries: candidates,
    reviews: reviewRows,
    known_gaps: completion?.known_gaps ?? [],
  };
}

export function listNeedsYou(state: CommandState, actor: Actor, clock?: Clock) {
  return command(state, actor, "list_needs_you", undefined, (d) => {
    d.pm();
    d.projectAccess();
    const now = clock?.now();
    const why = (text: string) => [...text].slice(0, 40).join("");
    return {
      attention: now ? reviewLimitAttention(state, now) : [],
      incidents: d
        .list("assignments")
        .filter(
          (a) =>
            a.status === "active" &&
            ["unknown", "lost"].includes(a.runtime_state),
        )
        .map((a) => {
          const fact = (type: string) =>
            state.events.findLast(
              (e) =>
                e.type === type &&
                typeof e.payload === "object" &&
                e.payload !== null &&
                "assignment_id" in e.payload &&
                e.payload.assignment_id === a.id,
            );
          return {
            id: a.id,
            role_id: a.role_id,
            runtime_state: a.runtime_state,
            card_id:
              d.list("work_items").find((w) => w.id === a.work_item_id)
                ?.card_id ?? null,
            disconnected_at: fact("runtime_disconnected")?.created_at ?? null,
            lost_at: fact("runtime_lost")?.created_at ?? null,
            last_run:
              d
                .list("runs")
                .filter((r) => r.assignment_id === a.id)
                .sort(
                  (x, y) => Number(y.id.slice(2)) - Number(x.id.slice(2)),
                )[0] ?? null,
          };
        }),
      decisions: d
        .list("decisions")
        .filter(
          (q) =>
            q.decider === "human" && ["open", "provisional"].includes(q.status),
        )
        .map((q) => {
          // Project decisions have no card timeline; their request event is the creation fact.
          const opened =
            state.events
              .filter(
                (e) =>
                  e.type === "decision_requested" &&
                  typeof e.payload === "object" &&
                  e.payload !== null &&
                  "decision_id" in e.payload &&
                  e.payload.decision_id === q.id,
              )
              .sort((a, b) => a.created_at.localeCompare(b.created_at))[0]
              ?.created_at ??
            state.timeline
              .filter((e) => e.decision_id === q.id)
              .sort((a, b) => a.event_seq - b.event_seq)[0]?.created_at;
          const elapsed =
            opened && now ? Date.parse(now) - Date.parse(opened) : Number.NaN;
          return {
            ...q,
            why: why(q.question),
            opened_at: opened ?? null,
            waited_ms: Number.isFinite(elapsed) ? Math.max(0, elapsed) : null,
            related_cards: relatedCards(d.list("cards"), q),
            merge_confirmation: mergeConfirmation(
              q,
              d.list("work_items"),
              d.list("deliveries"),
              d.list("reviews"),
            ),
          };
        }),
      human_actions: d
        .list("human_actions")
        .filter(
          (h) =>
            h.status === "open" ||
            (h.status === "done" &&
              requesterNotificationRecipient(h.requested_by, state.assignments)
                ?.kind === "needs_you" &&
              (!h.card_id ||
                state.cards.some(
                  (c) =>
                    c.id === h.card_id &&
                    !["done", "cancelled"].includes(c.status),
                ))),
        )
        .map((h) => ({
          ...h,
          why: why(
            h.status === "done"
              ? "已完成，但发起方不可用且无活跃 PM Ops 接手"
              : h.why_human,
          ),
          ...(h.status === "done"
            ? { completion_notice: h.result?.text ?? "" }
            : {}),
        })),
    };
  });
}
