import { type CardDerivedFields, deriveCardFields } from "../card-derived.js";
import {
  deriveCardStatus,
  deriveReviewMatrix,
  isReviewStale,
} from "../derived.js";
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
import { isRoleActive, type Role, roleKind } from "../role.js";
import {
  builtinCardTemplates,
  type CardTemplate,
  latestCardTemplate,
} from "../templates.js";
import { type CommandDraft, type CommandState, command } from "./core.js";
import { decisionFollowupNeedsHuman } from "./decision-followup.js";
import { hasActivePmOps, isPmOps } from "./delegation.js";
import { availableWorkItemEmployees } from "./employee-assignment.js";
import { failedConfirmedMergeCheck, latestMergeCheck } from "./merge-check.js";
import { mergeCheckBlockers } from "./merge-check-blockers.js";
import {
  mergeCheckEndedWithoutPass,
  mergeConfirmationWaitingForCheck,
  pmFailedMergeCheck,
  pmFailedMergeCheckOptions,
  pmMergeBlockers,
} from "./merge-delegation.js";
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
  const blockers = mergeCheckBlockers(d.state, id);
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
    ...(blockers.length ? { merge_check_blockers: blockers } : {}),
    ...fields,
  };
}
export function projectSnapshot(state: CommandState, actor: Actor) {
  return command(state, actor, "project_snapshot", undefined, (d) => {
    d.pm();
    d.projectAccess();
    return {
      project_id: state.project_id,
      available_employees: availableWorkItemEmployees(state)
        .filter(
          (employee) =>
            employee.role_id !== "host_ops" &&
            isRoleActive(state.roles, employee.role_id),
        )
        .map(({ id, name, title, role_id }) => ({ id, name, title, role_id })),
      cards: d.list("cards").map((c) => cardView(d, c.id)),
    };
  });
}

/** One template as `list_templates` shows it: enough for a PM to pick one. */
function templateSummary(template: CardTemplate) {
  return {
    id: template.id,
    version: template.version,
    title: template.title,
    description: template.description,
    builtin: template.builtin,
    requires_repo: template.requires_repo,
    merge: template.merge,
    primary_work_item_key: template.primary_work_item_key,
    work_items: template.work_items.map((item) => ({
      key: item.key,
      title: item.title,
      role_id: item.role_id,
      kind: item.kind,
      required: item.required,
    })),
  };
}

/**
 * V12b: the latest active version of every card template this project can
 * use (host-provided, project-stored, builtin). Read-only; standing PM only.
 */
export function listTemplates(state: CommandState, actor: Actor) {
  return command(state, actor, "list_templates", undefined, (d) => {
    d.pm();
    d.projectAccess();
    const all = [
      ...(d.ports?.templates ?? []),
      ...d.list("card_templates"),
      ...builtinCardTemplates,
    ];
    const templates = [...new Set(all.map((t) => t.id))]
      .sort()
      .flatMap((id) => {
        const latest = latestCardTemplate(all, id);
        return latest?.status === "active" ? [templateSummary(latest)] : [];
      });
    return { project_id: state.project_id, templates };
  });
}

/**
 * Stored role documents are full `Role`s; pre-M2 rows may only carry the
 * `RoleReference` fields, so every descriptive field is optional here.
 */
type StoredRole = CommandState["roles"][number] &
  Partial<Pick<Role, "display_name" | "kind" | "worktree" | "abilities">>;

/**
 * V12b: the latest active version of every role in this project. Prompts
 * (`core_prompt`, `instructions`) and launch policy are deliberately omitted.
 */
export function listRoles(state: CommandState, actor: Actor) {
  return command(state, actor, "list_roles", undefined, (d) => {
    d.pm();
    d.projectAccess();
    const stored = state.roles as readonly StoredRole[];
    const roles = [...new Set(stored.map((r) => r.role_id))]
      .sort()
      .flatMap((id) => {
        if (!isRoleActive(stored, id)) return [];
        const role = stored
          .filter((r) => r.role_id === id)
          .sort((a, b) => b.role_version - a.role_version)[0];
        if (role === undefined) return [];
        return [
          {
            role_id: role.role_id,
            version: role.role_version,
            ...(role.display_name === undefined
              ? {}
              : { display_name: role.display_name }),
            ...(role.kind === undefined
              ? {}
              : {
                  kind: roleKind({
                    kind: role.kind,
                    allowed_tools: role.allowed_tools,
                    capabilities: role.capabilities,
                  }),
                }),
            capabilities: [...role.capabilities],
            ...(role.worktree === undefined ? {} : { worktree: role.worktree }),
            ...(role.abilities === undefined
              ? {}
              : { abilities: [...role.abilities] }),
          },
        ];
      });
    return { project_id: state.project_id, roles };
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
    if (delivery === undefined || isReviewStale(review, delivery)) continue;
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

/** Shared decision presentation for the task list and actionable card details. */
export function decisionActionView(
  state: CommandState,
  q: Decision,
  now?: string,
) {
  const why = (text: string) => [...text].slice(0, 40).join("");
  const failedConfirmation = failedConfirmedMergeCheck(state, q);
  const followup = !failedConfirmation && decisionFollowupNeedsHuman(state, q);
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
  // C-154: still with the human after the PM handed it over (pause, release
  // or withdrawn delegation); Needs You labels it "由 PM 转交".
  const handoff =
    q.decider === "human"
      ? state.events.findLast(
          (e) =>
            e.type === "decision_requested" &&
            typeof e.payload === "object" &&
            e.payload !== null &&
            "decision_id" in e.payload &&
            e.payload.decision_id === q.id &&
            "previous_decider" in e.payload &&
            e.payload.previous_decider === "role:pm",
        )
      : undefined;
  return {
    ...q,
    handed_over_from_pm: handoff
      ? {
          at: handoff.created_at,
          reason: String(
            (handoff.payload as { reason?: unknown }).reason ?? "",
          ),
        }
      : null,
    ...(failedConfirmation
      ? {
          options: q.options.filter((o) => o.key === "request_changes"),
          recommended: "request_changes",
        }
      : {}),
    ...(followup
      ? {
          followup_notice:
            "拍板已完成，尚无落实结果；当前无 PM Ops 接手，请安排跟进。",
        }
      : {}),
    why: why(
      failedConfirmation
        ? "合并检查失败或超时，可退回修改或重新检查"
        : q.question,
    ),
    opened_at: opened ?? null,
    waited_ms: Number.isFinite(elapsed) ? Math.max(0, elapsed) : null,
    related_cards: relatedCards(state.cards, q),
    merge_confirmation: mergeConfirmation(
      q,
      state.work_items,
      state.deliveries,
      state.reviews,
    ),
  };
}

export function listNeedsYou(state: CommandState, actor: Actor, clock?: Clock) {
  return command(state, actor, "list_needs_you", undefined, (d) => {
    d.pm();
    d.projectAccess();
    return needsYouView(d, clock?.now());
  });
}

/** Shared read model; callers enforce their own entry-point authorization. */
export function needsYouView(d: CommandDraft, now?: string) {
  const state = d.state,
    actor = d.actor;
  const waiting = d
    .list("decisions")
    .filter(
      (q) =>
        q.trigger === "merge_confirmation" &&
        ((q.decider === "human" &&
          ["open", "provisional"].includes(q.status)) ||
          !!failedConfirmedMergeCheck(state, q)) &&
        mergeConfirmationWaitingForCheck(state, q),
    );
  // C-171: an ended, unpassed check will not pass by itself, so the human
  // sees that confirmation in the list; only queued/running ones stay summarized.
  const humanWaiting = waiting.filter(
    (q) => !mergeCheckEndedWithoutPass(state, q),
  );
  const why = (text: string) => [...text].slice(0, 40).join("");
  const view = (q: Decision) => decisionActionView(state, q, now);
  return {
    attention: now ? reviewLimitAttention(state, now) : [],
    ...(isPmOps(d)
      ? {
          pm_queue: {
            waiting_merge_checks: waiting,
            decisions: d
              .list("decisions")
              .filter(
                (q) =>
                  q.decider === "role:pm" &&
                  ["open", "provisional"].includes(q.status),
              ),
            // §7.4: why PM Ops cannot choose merge yet (empty = allowed).
            merge_blockers: Object.fromEntries(
              d
                .list("decisions")
                .filter(
                  (q) =>
                    q.decider === "role:pm" &&
                    q.trigger === "merge_confirmation" &&
                    q.status === "open",
                )
                .map((q) => [q.id, pmMergeBlockers(state, q)]),
            ),
            // P2a-1 §2.6: failed or timed-out checks PM Ops may return
            // (request_changes) or recheck, including confirmed merges.
            failed_merge_checks: d.list("decisions").flatMap((q) => {
              const check = pmFailedMergeCheck(state, q);
              return check
                ? [
                    {
                      decision_id: q.id,
                      card_id: q.card_id,
                      confirmation_status: q.status,
                      check,
                      options: pmFailedMergeCheckOptions(state, q),
                    },
                  ]
                : [];
            }),
            human_actions: d
              .list("human_actions")
              .filter((h) => h.status === "open" && h.triage === "pm_ops"),
          },
        }
      : {}),
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
          (q.decider === "human" &&
            ["open", "provisional"].includes(q.status)) ||
          (failedConfirmedMergeCheck(state, q) &&
            // PM Ops handles it and syncs a notice (P2a-1 §2.6).
            !(
              hasActivePmOps(d, "resolve_delegated_decision") &&
              pmFailedMergeCheck(state, q)
            )) ||
          decisionFollowupNeedsHuman(state, q),
      )
      .filter(
        (q) =>
          !mergeConfirmationWaitingForCheck(state, q) ||
          !!mergeCheckEndedWithoutPass(state, q),
      )
      .map(view),
    waiting_merge_checks_count: humanWaiting.length,
    // C-171: which confirmations the summary counts, so the human can open them.
    waiting_merge_check_items: humanWaiting.map((q) => ({
      decision_id: q.id,
      card_id: q.card_id ?? null,
      check_status:
        q.card_id && q.kind === "approve" && "delivery_id" in q.target
          ? (latestMergeCheck(state.events, q.card_id, q.target.delivery_id)
              ?.status ?? null)
          : null,
    })),
    // §7.4 (C-65): merge confirmations PM Ops still holds. Not counted as
    // waiting on the human, but the human may answer them directly.
    pm_held_merges:
      actor.kind === "human"
        ? d
            .list("decisions")
            .filter(
              (q) =>
                q.decider === "role:pm" &&
                q.trigger === "merge_confirmation" &&
                ["open", "provisional"].includes(q.status),
            )
            .map(view)
        : [],
    human_actions: d
      .list("human_actions")
      .filter(
        (h) =>
          (h.status === "open" && h.triage !== "pm_ops") ||
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
            : (h.handoff?.why_human ?? h.why_human),
        ),
        ...(h.status === "done"
          ? { completion_notice: h.result?.text ?? "" }
          : {}),
      })),
  };
}
