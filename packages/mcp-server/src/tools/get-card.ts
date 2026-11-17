import type {
  CardId,
  CardStatus,
  CardView,
  CommandState,
  Delivery,
} from "@cardigan/domain";
import {
  authorView,
  cardDependencyView,
  cardReadAccess,
  cardTemplate,
  decisionAuthorView,
  deriveCardFields,
  deriveCardStatus,
  deriveReviewMatrix,
  latestMergeCheck,
  mergeClassificationView,
  mergeShadowComparisons,
  prechecks,
  precheckView,
  referenceReadState,
  roleRuleDeliveries,
  roleRuleInventory,
  runAuthorView,
  verificationActivity,
} from "@cardigan/domain";
import { z } from "zod";
import { ToolError } from "../errors.js";
import { publicSourceMergeData } from "../source-merge-public.js";
import { authorizeCheckLog, CheckLogAccessError } from "./get-check-log.js";
import { auditReferenceRead, referenceCard } from "./reference-read.js";
import { agentCard } from "./shared.js";
import { defineTool } from "./types.js";

/** Numeric part of a readable ID such as `D-12` or `V-3`. */
function idNumber(id: string): number {
  const digits = /(\d+)\)?$/.exec(id)?.[1];
  return digits === undefined ? 0 : Number(digits);
}

const RECENT_DELIVERY_LIMIT = 10;

/**
 * Card, work items, open decisions, recent deliveries, review matrix and the
 * three derived card fields (§9.2).
 *
 * Everything derived — status, matrix, staleness, `waiting_on`, `next_owners`
 * and `why` — comes from the domain (M1.2 / M1.2b); this tool only gathers the
 * rows and shapes the response.
 */
export const getCardTool = defineTool({
  name: "get_card",
  description:
    "Return a card with its work items, open decisions, recent deliveries, review matrix and derived fields",
  input: z.object({ card_id: z.string().min(1) }),
  handler: ({ card_id }, context) => {
    const { store, identity } = context;
    const cardId = card_id as CardId;
    const read = store.uow.read((tx) => referenceCard(tx, context, cardId));
    const { card } = read;
    if (read.access === "summary") {
      auditReferenceRead(context, [cardId], "get_card", false);
      return {
        ...read.provenance,
        card: { id: card.id, title: card.title, status: card.status },
      };
    }
    const { state, dependency } = store.uow.read((tx) => {
      try {
        const project = identity.actor.project_id;
        // Card reads need only this card's event stream, never the full project
        // command history or dispatcher cursor/capacity state.
        const snapshot: CommandState = {
          project_id: project,
          project_preferences: tx.project_preferences?.list(project) ?? [],
          card_templates: tx.card_templates?.list(project) ?? [],
          cards: tx.cards.list(project),
          work_items: tx.work_items.list(project),
          assignments: tx.assignments.list(project),
          runs: tx.runs.list(project),
          deliveries: tx.deliveries.list(project),
          reviews: tx.reviews.list(project),
          decisions: tx.decisions.list(project),
          human_actions: tx.human_actions.list(project),
          attachments: tx.attachments.list(project),
          timeline: tx.timeline.list(project),
          events: tx.events.listAfter(project, cardId, 0),
          employees: tx.employees?.list() ?? [],
          members: tx.members?.list() ?? [],
          roles: [],
          machines: [],
          cursors: [],
        };
        const visibleCards = snapshot.cards.filter(
          (c) =>
            cardReadAccess({
              project_id: project,
              assignment: read.assignment,
              card: c,
              work_items: snapshot.work_items,
              preferences: snapshot.project_preferences?.find(
                (p) => p.id === project,
              ),
            }) !== "none",
        );
        const hasDependencies =
          card.depends_on_cards?.length ||
          visibleCards.some((c) => c.depends_on_cards?.includes(cardId));
        const dependency = hasDependencies
          ? cardDependencyView(
              {
                ...snapshot,
                cards: visibleCards,
                events: visibleCards.flatMap((c) =>
                  tx.events
                    .listAfter(project, c.id, 0)
                    .filter((e) =>
                      [
                        "card_merged",
                        "card_marked_done",
                        "review_submitted",
                        "completion_reviewed",
                        "delivery_submitted",
                        "review_reused",
                      ].includes(e.type),
                    ),
                ),
              },
              card,
            )
          : undefined;
        return {
          state: referenceReadState(snapshot, read.assignment),
          dependency,
        };
      } catch {
        throw ToolError.validation("检查日志列表读取失败。");
      }
    });
    const work_items = state.work_items.filter((w) => w.card_id === cardId);
    const works = new Set(work_items.map((w) => w.id));
    const assignments = state.assignments.filter(
      (a) => a.scope === "work_item" && works.has(a.work_item_id),
    );
    const deliveries = state.deliveries.filter((v) =>
      works.has(v.work_item_id),
    );
    const deliveryIds = new Set(deliveries.map((v) => v.id));
    const reviews = state.reviews.filter(
      (r) => works.has(r.work_item_id) || deliveryIds.has(r.delivery_id),
    );
    const decisions = state.decisions.filter(
      (q) =>
        ["open", "provisional"].includes(q.status) &&
        (q.card_id === cardId || q.affected_cards.includes(cardId)),
    );
    const human_actions = state.human_actions.filter(
      (a) =>
        a.status === "open" &&
        (a.card_id === cardId ||
          a.blocked_work_items.some((id) => works.has(id))),
    );

    const events = state.events;
    const authors = {
      assignments,
      templates: state.card_templates ?? [],
      runs: state.runs,
      events,
      employees: state.employees ?? [],
      members: state.members ?? [],
    };

    // The newest completion request decides whether the card is waiting for
    // acceptance (invariant 13: derivation never produces `done`).
    const completion = deliveries
      .filter((delivery) => delivery.kind === "card_completion")
      .sort((left, right) => idNumber(right.id) - idNumber(left.id))[0];

    const status: CardStatus = deriveCardStatus(
      card.status,
      work_items,
      completion,
    );

    const storedMergeCheck =
      completion && completion.status !== "superseded"
        ? latestMergeCheck(events, cardId, completion.id)
        : undefined;

    const mergeCheck = storedMergeCheck
      ? (({ log_ref: _path, ...safe }) => safe)(storedMergeCheck)
      : undefined;

    const attempts = store.uow.read((tx) => {
      try {
        return authorizeCheckLog(tx, context, cardId);
      } catch (error) {
        if (error instanceof CheckLogAccessError) return [];
        if (error instanceof ToolError && error.code === "unauthorized")
          throw new ToolError("unauthorized", "Token 已失效。");
        throw ToolError.validation("检查日志列表读取失败。");
      }
    });

    // Typed against CardView so the tool cannot drift from the domain's
    // derived-field types (M1.2b).
    const template = cardTemplate(card, authors.templates);
    const derived: Pick<CardView, "waiting_on" | "next_owners" | "why"> =
      deriveCardFields({
        card,
        ...(template === undefined ? {} : { template }),
        work_items,
        assignments,
        deliveries,
        reviews,
        decisions,
        human_actions,
        status,
      });

    const shadow = mergeShadowComparisons(
      {
        events,
        decisions: state.decisions,
      },
      cardId,
    );
    auditReferenceRead(context, [cardId], "get_card");
    return publicSourceMergeData({
      ...read.provenance,
      timeline: state.timeline
        .filter((entry) => entry.card_id === cardId)
        .map((entry) => ({
          ...entry,
          ...authorView(authors, entry.author),
        })),
      attachments: state.attachments
        .filter((a) => a.card_id === cardId)
        .map(({ storage_path: _path, ...metadata }) => metadata),
      merge_shadow: shadow,
      card: {
        ...agentCard(card),
        ...(dependency ? { dependency } : {}),
        ...(card.merge_classification
          ? {
              merge_classification: mergeClassificationView(
                { work_items, deliveries },
                card,
              ),
            }
          : {}),
        status,
        stored_status: card.status,
        ...(mergeCheck ? { merge_check: { ...mergeCheck, attempts } } : {}),
        check_attempts: attempts,
        prechecks: prechecks(events, cardId).map(precheckView),
      },
      waiting_on: derived.waiting_on,
      next_owners: derived.next_owners,
      why: derived.why,
      work_items: work_items.map((item) => ({
        ...item,
        verification_activity: verificationActivity(item, {
          ...authors,
          deliveries,
          reviews,
        }),
      })),
      decisions: state.decisions
        .filter(
          (q) => q.card_id === cardId || q.affected_cards.includes(cardId),
        )
        .map((decision) => ({
          ...decision,
          ...decisionAuthorView(authors, decision),
        })),
      open_decisions: decisions.map((decision) => ({
        ...decision,
        ...decisionAuthorView(authors, decision),
      })),
      deliveries: [...deliveries]
        .sort((left, right) => idNumber(right.id) - idNumber(left.id))
        .slice(0, RECENT_DELIVERY_LIMIT)
        .map((delivery) => ({
          ...summarizeDelivery(delivery),
          ...(delivery.system_completion
            ? { author: "system", ...authorView(authors, "system") }
            : runAuthorView(authors, delivery.run_id)),
        })),
      // The mapping requires every current Git product, including those older
      // than the recent-delivery window. Expose only the host-owned inventory,
      // never unrelated evidence (logs, transport details, etc.).
      role_rule_inventories: roleRuleDeliveries(
        { work_items, deliveries, decisions },
        { card_id: cardId },
      ).map((delivery) => ({
        delivery_id: delivery.id,
        work_item_id: delivery.work_item_id,
        subject: delivery.subject,
        role_rule_inventory: roleRuleInventory(delivery) ?? null,
      })),
      reviews: reviews.map((review) => ({
        ...review,
        ...runAuthorView(authors, review.run_id),
      })),
      review_matrix: deriveReviewMatrix(deliveries, work_items, reviews),
      counts: {
        work_items: work_items.length,
        deliveries: deliveries.length,
        reviews: reviews.length,
        open_decisions: decisions.length,
      },
    });
  },
});

function summarizeDelivery(delivery: Delivery): Record<string, unknown> {
  return {
    id: delivery.id,
    work_item_id: delivery.work_item_id,
    run_id: delivery.run_id,
    kind: delivery.kind,
    summary: delivery.summary,
    test_results: delivery.test_results,
    known_gaps: delivery.known_gaps,
    attachments: delivery.attachments,
    requested_verifiers: delivery.requested_verifiers,
    subject: delivery.subject,
    status: delivery.status,
    branch: delivery.branch ?? null,
    pr_url: delivery.pr_url ?? null,
    supersedes: delivery.supersedes ?? null,
    ...(delivery.plain_summary
      ? { plain_summary: delivery.plain_summary }
      : {}),
    ...(delivery.system_completion
      ? { system_completion: delivery.system_completion }
      : {}),
  };
}
