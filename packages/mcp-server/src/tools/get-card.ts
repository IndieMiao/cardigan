import type {
  CardId,
  CardStatus,
  CardView,
  CommandState,
  Delivery,
} from "@cardigan/domain";
import {
  authorView,
  CROSS_CARD_REFERENCE_NOTICE,
  cardDependencyView,
  cardReadAccess,
  cardTemplate,
  decisionAuthorView,
  deriveCardFields,
  deriveCardStatus,
  deriveReviewMatrix,
  flowAtLeast,
  latestMergeCheck,
  mergeBatchReadScope,
  mergeClassificationView,
  mergeShadowComparisons,
  mergeStage,
  prechecks,
  precheckView,
  referenceReadState,
  roleRuleDeliveries,
  roleRuleInventory,
  runAuthorView,
  sharedMustFixes,
  storyDiscussionRounds,
  storyProgress,
  verificationActivity,
} from "@cardigan/domain";
import { z } from "zod";
import { ToolError } from "../errors.js";
import { timeRead } from "../read-timing.js";
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
    const timed = <T>(stage: string, fn: () => T) =>
      timeRead(context.recordTiming, stage, fn);
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
    const projection = store.uow.read((tx) => {
      try {
        const project = identity.actor.project_id;
        const projectEvents = timed(
          "sql_streams",
          () =>
            tx.projectMergeEvents?.(project) ??
            tx.events.listAfter(project, undefined, 0),
        );
        const queueConfig = projectEvents.findLast(
          (e) =>
            e.actor.kind === "system" && e.type === "merge_queue_configured",
        );
        const cardEvents = timed("sql_card_events", () =>
          tx.events.listAfter(project, cardId, 0),
        );
        const localEvents = queueConfig
          ? [...projectEvents, ...cardEvents]
          : cardEvents;
        // The visibility projection needs attachment owners (timeline or delivery)
        // for a child and its immediate parent, never unrelated project streams.
        const sourceIds = new Set([cardId]);
        if (card.parent_card_id) sourceIds.add(card.parent_card_id);
        const sources = timed("sql_card_sources", () => {
          if (!tx.cardSources) return undefined;
          const own = tx.cardSources(project, cardId);
          if (!card.parent_card_id || card.parent_card_id === cardId)
            return own;
          const parent = tx.cardSources(project, card.parent_card_id);
          return {
            timeline: [...own.timeline, ...parent.timeline],
            attachments: [...own.attachments, ...parent.attachments],
          };
        });
        const snapshot = timed(
          "sql_state",
          (): CommandState => ({
            project_id: project,
            ...(queueConfig?.payload
              ? {
                  project_settings: {
                    merge_gate_enabled: true,
                    merge_queue: queueConfig.payload as unknown as NonNullable<
                      NonNullable<
                        CommandState["project_settings"]
                      >["merge_queue"]
                    >,
                  },
                }
              : {}),
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
            attachments:
              sources?.attachments ??
              tx.attachments
                .list(project)
                .filter((a) => sourceIds.has(a.card_id)),
            timeline:
              sources?.timeline ??
              tx.timeline.list(project).filter((e) => sourceIds.has(e.card_id)),
            events: localEvents,
            employees: tx.employees?.list() ?? [],
            members: tx.members?.list() ?? [],
            roles: [],
            machines: [],
            cursors: [],
          }),
        );
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
        const visibleIds = new Set(visibleCards.map((c) => c.id));
        const dependency = hasDependencies
          ? timed("dependency", () =>
              cardDependencyView(
                {
                  ...snapshot,
                  cards: visibleCards,
                  events:
                    tx
                      .dependencyEvents?.(project)
                      .filter((e) => e.card_id && visibleIds.has(e.card_id)) ??
                    visibleCards.flatMap((c) =>
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
              ),
            )
          : undefined;
        // Only queue position/window ordering of a merge candidate needs peer streams.
        const streams =
          queueConfig && card.status === "awaiting_merge"
            ? tx.events.listStreams?.(project)
            : undefined;
        const stage = timed("merge_stage", () =>
          mergeStage(
            streams
              ? { ...snapshot, events: [...streams.values()].flat() }
              : snapshot,
            card,
          ),
        );
        const hideBatchEvidence =
          stage?.batch_id &&
          !mergeBatchReadScope(snapshot, read.assignment).canRead(
            stage.batch_id,
          );
        const safeStage =
          stage && hideBatchEvidence
            ? (({ batch_check: _check, ...safe }) => safe)(stage)
            : stage;
        return {
          state: timed("visibility", () =>
            referenceReadState(snapshot, read.assignment),
          ),
          dependency,
          story_progress: card.story
            ? storyProgress(visibleCards, card)
            : undefined,
          merge_stage: safeStage,
        };
      } catch {
        throw ToolError.validation("检查日志列表读取失败。");
      }
    });
    const { state, dependency, merge_stage, story_progress } = projection;
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

    const attempts = timed("check_attempts", () =>
      store.uow.read((tx) => {
        try {
          return authorizeCheckLog(tx, context, cardId);
        } catch (error) {
          if (error instanceof CheckLogAccessError) return [];
          if (error instanceof ToolError && error.code === "unauthorized")
            throw new ToolError("unauthorized", "Token 已失效。");
          throw ToolError.validation("检查日志列表读取失败。");
        }
      }),
    );

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
        decisions: state.decisions.filter(
          (q) => q.card_id === cardId || q.affected_cards.includes(cardId),
        ),
        events,
        runs: state.runs,
        human_actions,
        status,
      });

    const shadow = timed("merge_shadow", () =>
      mergeShadowComparisons(
        {
          events,
          decisions: state.decisions,
        },
        cardId,
      ),
    );
    // Metadata is inherited as a reference, never as a child-owned upload. The
    // filtered source state and the final audit both enforce current access.
    const parentAttachments = card.parent_card_id
      ? state.attachments
          .filter((a) => a.card_id === card.parent_card_id)
          .map((a) => a.id)
      : [];
    const parentReference =
      card.parent_card_id && parentAttachments.length
        ? {
            source_card_id: card.parent_card_id,
            reference_notice: CROSS_CARD_REFERENCE_NOTICE,
            attachment_ids: parentAttachments,
          }
        : undefined;
    auditReferenceRead(
      context,
      parentReference ? [cardId, parentReference.source_card_id] : [cardId],
      "get_card",
    );
    return publicSourceMergeData({
      ...read.provenance,
      ...(parentReference ? { parent_reference: parentReference } : {}),
      timeline: timed("timeline_view", () =>
        state.timeline
          .filter((entry) => entry.card_id === cardId)
          .map((entry) => ({
            ...entry,
            ...authorView(authors, entry.author),
          })),
      ),
      attachments: timed("attachment_views", () =>
        state.attachments
          .filter((a) => a.card_id === cardId)
          .map(({ storage_path: _path, ...metadata }) => metadata),
      ),
      merge_shadow: shadow,
      card: {
        ...agentCard(card),
        ...(card.story
          ? {
              story: {
                ...card.story,
                discussion_rounds: storyDiscussionRounds(card.story),
              },
              story_progress,
            }
          : {}),
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
        ...(merge_stage ? { merge_stage } : {}),
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
      role_rule_inventories: timed("role_rule_inventories", () =>
        roleRuleDeliveries(
          { work_items, deliveries, decisions },
          { card_id: cardId },
        ).map((delivery) => ({
          delivery_id: delivery.id,
          work_item_id: delivery.work_item_id,
          subject: delivery.subject,
          role_rule_inventory: roleRuleInventory(delivery) ?? null,
        })),
      ),
      shared_must_fixes: flowAtLeast(card, 5)
        ? sharedMustFixes(reviews, deliveries, work_items)
        : [],
      reviews: reviews.map((review) => ({
        ...review,
        ...runAuthorView(authors, review.run_id),
      })),
      review_matrix: timed("review_matrix", () =>
        deriveReviewMatrix(deliveries, work_items, reviews),
      ),
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
