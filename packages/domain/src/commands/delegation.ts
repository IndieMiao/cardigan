import { autoRiskMergeReason } from "../auto-risk.js";
import {
  categoryAuthorization,
  categoryDelegated,
} from "../decision-authorization.js";
import { deriveReviewMatrix, reviewPassed } from "../derived.js";
import type {
  Card,
  Decision,
  Event,
  PlainSummary,
  ToolName,
} from "../entities.js";
import { appendEvents, eventsForDecision } from "../event-index.js";
import { flowAtLeast } from "../flow.js";
import { highRiskProducts } from "../high-risk.js";
import type { CardId } from "../ids.js";
import {
  type DecisionCategory,
  decisionDelegation,
  highRiskCategories,
  type ProjectPreferences,
  pmMergeConfirmation,
} from "../preferences.js";
import { type CommandDraft, type CommandState, ensure } from "./core.js";
import { mergeContentDecisions } from "./human-decided-merge.js";
import {
  INDEPENDENT_REVIEW_LIMIT_HUMAN_REASON,
  independentReviewLimitItem,
} from "./independent-review-limit-delegation.js";
import { systemHandoffPlainSummary } from "./plain-summary.js";
import type { RoleRuleState } from "./role-rule-implementation.js";

export function hasActivePmOps(d: CommandDraft, tool?: ToolName) {
  return d
    .list("assignments")
    .some(
      (a) =>
        a.status === "active" &&
        a.scope === "standing" &&
        a.role_id === "pm" &&
        a.standing_mode === "ops" &&
        (!tool ||
          d.state.roles.some(
            (r) =>
              r.role_id === a.role_id &&
              r.role_version === a.role_version &&
              r.allowed_tools.includes(tool),
          )),
    );
}
export function isPmOps(d: CommandDraft) {
  return (
    d.assignment?.scope === "standing" &&
    d.assignment.role_id === "pm" &&
    d.assignment.standing_mode === "ops"
  );
}
export const SENSITIVE_CARD_REASON = "卡片已被人标为敏感，合并须由人亲自确认。";
/** Only the human can declare a business question unrelated to merge content.
 * Source exclusions require separate card-bound human consent.
 */
export function mergeUnrelatedConfirmed(
  q: Pick<Decision, "merge_related" | "raised_by">,
): boolean {
  return q.merge_related === false && q.raised_by === "human";
}
export function mergeNeedsHuman(
  decisions: readonly Decision[],
  cards: readonly Pick<Card, "id" | "source" | "sensitive">[],
  card_id: CardId,
  preferences?: ProjectPreferences,
  events: readonly Event[] = [],
): string | undefined {
  const card = cards.find((c) => c.id === card_id);
  // C-65: the human's own flag wins over any category; agents cannot set it.
  if (card?.sensitive && !categoryDelegated(preferences, events, "sensitive"))
    return SENSITIVE_CARD_REASON;
  const sourceId =
    card?.source.kind === "decision" ? card.source.decision_id : undefined;
  const sensitive = (
    card ? mergeContentDecisions(decisions, card, events) : []
  ).find(
    (q) =>
      !!q.category &&
      highRiskCategories.includes(q.category) &&
      !categoryDelegated(preferences, events, q.category),
  );

  return sensitive
    ? `卡片${sensitive.id === sourceId ? "来源拍板" : ""}涉及高风险事项（花钱、凭据、账号、删除数据或对外发布）（${sensitive.id}），合并须由人确认。`
    : undefined;
}
/** Personal consent follows current sensitive flags and high-risk content categories. */
export function mergeRequiresHuman(
  state: {
    readonly project_id?: CommandState["project_id"];
    readonly events?: readonly Event[];
    readonly project_preferences?: readonly ProjectPreferences[];
    readonly decisions: readonly Decision[];
    readonly cards: readonly Pick<
      Card,
      "id" | "source" | "sensitive" | "flow_version"
    >[];
  } & Partial<RoleRuleState>,
  q: Decision,
): boolean {
  return (
    q.trigger === "merge_confirmation" &&
    (q.source_unrelated_human_required === true ||
      !!autoRiskMergeReason(state, q.card_id) ||
      !q.card_id ||
      !!mergeNeedsHuman(
        state.decisions,
        state.cards,
        q.card_id,
        state.project_preferences?.find((p) => p.id === state.project_id),
        state.events,
      ))
  );
}
type DelegationSubject = Pick<
  Decision,
  "category" | "trigger" | "card_id" | "human_required_reason"
> &
  Partial<
    Pick<
      Decision,
      | "affected_work_items"
      | "review_limit_group"
      | "role_rule_basis"
      | "kind"
      | "source_unrelated_human_required"
    >
  > & {
    readonly target?:
      | { readonly delivery_id: import("../ids.js").DeliveryId }
      | { readonly subject: import("../entities.js").DeliverySubject };
  };
type MergeRiskState = Pick<
  CommandState,
  "cards" | "decisions" | "work_items" | "deliveries" | "reviews"
> &
  Partial<Pick<CommandState, "project_id" | "project_preferences" | "events">>;

/** Compatibility predicate for authorization callers; both gates must pass. */
export function riskTagAutoMergeAllowed(
  state: MergeRiskState,
  q: DelegationSubject,
): boolean {
  const card = state.cards.find((c) => c.id === q.card_id);
  return (
    q.trigger === "merge_confirmation" &&
    !!card &&
    mergeRiskBlockers(state, card).length === 0
  );
}

/** Personal consent cannot stand in for a review, nor a review for consent. */
export function mergeRiskBlockers(state: MergeRiskState, card: Card): string[] {
  const human = mergeNeedsHuman(
    state.decisions,
    state.cards,
    card.id,
    state.project_preferences?.find((p) => p.id === state.project_id),
    state.events,
  );
  const blockers = human ? [human] : [];
  const items = state.work_items.filter((w) => w.card_id === card.id);
  if (!items.some((w) => w.kind === "produce" && w.status !== "cancelled"))
    return [...blockers, "卡片没有未取消的产出项"];
  const producers = highRiskProducts(state, card);
  if (!producers.length) return blockers;
  const current = producers.flatMap((w) => {
    const latest = state.deliveries
      .filter(
        (v) =>
          v.work_item_id === w.id &&
          v.kind !== "card_completion" &&
          v.status !== "superseded",
      )
      .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
    return latest ? [latest] : [];
  });
  const verifiers = items.filter(
    (w) =>
      w.kind === "verify" &&
      w.role_id === "independent_reviewer" &&
      w.required &&
      w.status === "passed" &&
      !w.replaced_by_work_item_id,
  );
  // Review identity/version is authoritative; similarly named advisory checks
  // and a passed work item alone cannot grant merge authority.
  const matrix = deriveReviewMatrix(current, verifiers, state.reviews);
  if (
    current.length !== producers.length ||
    !current.every((v) =>
      matrix.some((r) => r.delivery_id === v.id && reviewPassed(r)),
    )
  )
    blockers.push("高危交付须有当前有效的必需独立复核");
  return blockers;
}
function projectPreference(d: CommandDraft) {
  return d.list("project_preferences").find((p) => p.id === d.state.project_id);
}
/** Old uncategorized decisions remain human-only until explicitly classified. */
export function delegationAllowed(d: CommandDraft, q: DelegationSubject) {
  if (
    (!q.trigger || q.trigger === "worktree_cleanup") &&
    q.card_id &&
    d.list("cards").some((c) => c.id === q.card_id && c.sensitive) &&
    !categoryDelegated(
      projectPreference(d),
      appendEvents(d.state.events, d.events),
      "sensitive",
    )
  )
    return false;
  // Authorize the scope of a shared decision before either lane can consume it.
  // Its resolution and notice, on the other hand, describe only the actual participants.
  if (q.trigger === "review_limit" && q.review_limit_group)
    return (
      !!q.card_id &&
      !q.human_required_reason &&
      !["done", "cancelled"].includes(d.get("cards", q.card_id).status) &&
      categoryDelegated(
        projectPreference(d),
        appendEvents(d.state.events, d.events),
        "general",
      )
    );
  const independent = independentReviewLimitItem(d, q);
  if (independent)
    return (
      !q.human_required_reason &&
      !["done", "cancelled"].includes(
        d.get("cards", independent.card_id).status,
      )
    );
  if (q.trigger === "merge_confirmation")
    return (
      d.state.project_settings?.merge_gate_enabled !== false &&
      !q.source_unrelated_human_required &&
      !d.list("cards").some((c) => c.id === q.card_id && flowAtLeast(c, 4)) &&
      pmMergeConfirmation(projectPreference(d)) &&
      !autoRiskMergeReason(
        {
          cards: d.list("cards"),
          work_items: d.list("work_items"),
          deliveries: d.list("deliveries"),
        },
        q.card_id,
      ) &&
      !!q.card_id &&
      !mergeNeedsHuman(
        d.list("decisions"),
        d.list("cards"),
        q.card_id,
        projectPreference(d),
        appendEvents(d.state.events, d.events),
      ) &&
      riskTagAutoMergeAllowed(
        {
          project_id: d.state.project_id,
          project_preferences: d.list("project_preferences"),
          cards: d.list("cards"),
          decisions: d.list("decisions"),
          work_items: d.list("work_items"),
          deliveries: d.list("deliveries"),
          reviews: d.list("reviews"),
          events: appendEvents(d.state.events, d.events),
        },
        q,
      )
    );
  return (
    // Dedicated human workflow triggers keep their own guards; a general note
    // does not override ordinary category delegation.
    (!q.trigger ||
      q.trigger === "review_limit" ||
      q.trigger === "held_assignment_resume" ||
      // C-747: keep or back up and remove a released worktree follows its
      // category (data_deletion) like an ordinary question.
      q.trigger === "worktree_cleanup") &&
    !!q.category &&
    categoryDelegated(
      projectPreference(d),
      appendEvents(d.state.events, d.events),
      q.category,
    )
  );
}
function preferenceAudit(d: CommandDraft, preference: string) {
  return appendEvents(d.state.events, d.events)
    .filter(
      (e) =>
        e.type === "project_preferences_updated" &&
        typeof e.payload === "object" &&
        e.payload !== null &&
        "preference" in e.payload &&
        e.payload.preference === preference,
    )
    .at(-1);
}
export function independentReviewDelegationAuthority(d: CommandDraft) {
  return `project:${d.state.project_id}/flow-lite/B6`;
}
/** Policy evidence for a delegated merge confirmation. */
export function mergeDelegationAuthority(d: CommandDraft) {
  const audit = preferenceAudit(d, "pm_merge_confirmation");
  return projectPreference(d)?.pm_merge_confirmation !== undefined
    ? `project:${d.state.project_id}/pm_merge_confirmation${audit ? `/event:${audit.id}` : ""}`
    : `project:${d.state.project_id}/default-pm-merge-confirmation`;
}
export function delegationAuthority(
  d: CommandDraft,
  category: DecisionCategory,
) {
  const preference = projectPreference(d);
  const audit = highRiskCategories.includes(category)
    ? categoryAuthorization(appendEvents(d.state.events, d.events), category)
    : preferenceAudit(d, "decision_delegation");
  return preference?.decision_delegation?.[category] !== undefined
    ? `project:${d.state.project_id}/decision_delegation/${category}${audit ? `/event:${audit.id}` : ""}`
    : `project:${d.state.project_id}/default-decision-delegation/${category}`;
}
export function assignDecision(d: CommandDraft, q: Decision): Decision {
  if (
    (q.decider === "human" || q.decider === "role:pm") &&
    delegationAllowed(d, q) &&
    hasActivePmOps(
      d,
      q.trigger === "review_limit"
        ? "update_work_item"
        : "resolve_delegated_decision",
    )
  )
    return {
      ...q,
      decider: "role:pm",
      delegation_authority: independentReviewLimitItem(d, q)
        ? independentReviewDelegationAuthority(d)
        : q.trigger === "merge_confirmation"
          ? mergeDelegationAuthority(d)
          : delegationAuthority(d, q.category as DecisionCategory),
    };
  if (independentReviewLimitItem(d, q))
    return {
      ...q,
      decider: "human",
      human_required_reason:
        q.human_required_reason ?? INDEPENDENT_REVIEW_LIMIT_HUMAN_REASON,
    };
  // This inbox is durable even while Ops is unavailable; it is not delegation.
  if (q.pm_triage) return { ...q, decider: "role:pm" };
  if (q.decider === "role:pm") return { ...q, decider: "human" };
  return q;
}
export function handoffDecision(
  d: CommandDraft,
  q: Decision,
  reason: string,
  assignmentId?: string,
  humanRequired = false,
  /** C-202: audit of a PM rewrite of the plain summary on escalation. */
  plainSummaryRewrite?: { readonly previous: PlainSummary | null },
) {
  // C-202: nothing reaches the human without a plain summary. When the system
  // hands over a decision that has none, it writes one itself; merge
  // confirmations keep the completion's (older ones show context as before).
  const generated =
    !q.plain_summary && q.trigger !== "merge_confirmation"
      ? systemHandoffPlainSummary(q)
      : undefined;
  const independent = independentReviewLimitItem(d, q);
  d.put("decisions", {
    ...q,
    decider: "human",
    context: `${q.context}\n\n${reason}`,
    ...(humanRequired || independent
      ? {
          human_required_reason: independent
            ? (q.human_required_reason ?? reason)
            : reason,
        }
      : {}),
    ...(generated ? { plain_summary: generated } : {}),
  });
  d.emit(
    "decision_requested",
    q.card_id,
    {
      decision_id: q.id,
      ...(q.handoff_group ? { handoff_group: q.handoff_group } : {}),
      affected_work_items: [...q.affected_work_items],
      previous_decider: q.decider,
      reason,
      ...(assignmentId ? { assignment_id: assignmentId } : {}),
      ...(generated ? { plain_summary_source: "system" } : {}),
      ...(plainSummaryRewrite && q.plain_summary
        ? {
            plain_summary_rewrite: {
              previous: plainSummaryRewrite.previous
                ? { ...plainSummaryRewrite.previous }
                : null,
              next: { ...q.plain_summary },
              by: d.author,
            },
          }
        : {}),
    },
    {
      type: "decision_request",
      decision_id: q.id,
      body: plainSummaryRewrite
        ? `${reason}\n（${plainSummaryRewrite.previous ? "项目经理改写了人话概述" : "项目经理补写了人话概述"}）`
        : reason,
    },
  );
}
export function handoffUnauthorizedDecisions(
  d: CommandDraft,
  reason: string,
  assignmentId?: string,
) {
  for (const q of d.list("decisions")) {
    if (
      q.decider === "role:pm" &&
      !q.pm_triage &&
      ["open", "provisional", "snoozed"].includes(q.status) &&
      (!hasActivePmOps(
        d,
        q.trigger === "review_limit"
          ? "update_work_item"
          : "resolve_delegated_decision",
      ) ||
        !delegationAllowed(d, q))
    )
      handoffDecision(d, q, reason, assignmentId);
  }
}
export function handoffIndependentReviewLimits(
  d: CommandDraft,
  cards: readonly CardId[],
) {
  for (const q of d.list("decisions"))
    if (
      q.decider === "role:pm" &&
      q.card_id &&
      cards.includes(q.card_id) &&
      ["open", "provisional"].includes(q.status) &&
      independentReviewLimitItem(d, q) &&
      !delegationAllowed(d, q)
    )
      handoffDecision(
        d,
        q,
        "独立复核加轮已不满足常驻授权条件，此拍板须由人确认。",
      );
}
export function grantDecisionCategory(d: CommandDraft, q: Decision) {
  ensure(
    d.actor.kind === "human" &&
      q.category &&
      q.trigger !== "merge_confirmation" &&
      q.trigger !== "accepted_delivery_rework" &&
      !highRiskCategories.includes(q.category),
    "unauthorized",
    "此类别不可授权给 PM",
  );
  const old = d
    .list("project_preferences")
    .find((p) => p.id === d.state.project_id) ?? {
    id: d.state.project_id,
    auto_merge_after_minutes: null,
  };
  const grants = decisionDelegation(old);
  if (grants[q.category]) return;
  const next = { ...grants, [q.category]: true };
  d.put("project_preferences", { ...old, decision_delegation: next });
  d.emit("project_preferences_updated", undefined, {
    preference: "decision_delegation",
    old_value: grants,
    new_value: next,
    decision_id: q.id,
  });
}

/**
 * C-747: open worktree cleanup questions still held by the human move to PM
 * once their category (data_deletion) is delegated and PM Ops can take them:
 * when the human turns the category on, after deployment for questions raised
 * before C-747 (e.g. Q-1370), and when PM Ops was unavailable at request time.
 * A question PM itself escalated to the human stays with the human.
 */
export function routeDelegatedWorktreeCleanups(
  d: CommandDraft,
  note: string,
): Decision[] {
  const moved: Decision[] = [];
  for (const q of d.list("decisions")) {
    if (
      q.trigger !== "worktree_cleanup" ||
      q.decider !== "human" ||
      q.human_required_reason ||
      !["open", "provisional", "snoozed"].includes(q.status) ||
      escalatedByPm(d, q)
    )
      continue;
    const next = assignDecision(d, q);
    if (next.decider !== "role:pm") continue;
    d.put("decisions", next);
    moved.push(next);
    d.emit(
      "decision_requested",
      q.card_id,
      {
        decision_id: q.id,
        ...(q.assignment_id ? { assignment_id: q.assignment_id } : {}),
        previous_decider: "human",
        routed_to: "role:pm",
        routing_reason: next.delegation_authority ?? null,
        delegation_authority: next.delegation_authority ?? null,
        affected_work_items: [],
      },
      { type: "decision_request", decision_id: q.id, body: note },
    );
  }
  return moved;
}
/** PM Ops handed this question to the human itself (`escalate`). */
function escalatedByPm(d: CommandDraft, q: Decision) {
  return [...eventsForDecision(d.state.events, q.id), ...d.events].some(
    (e) =>
      e.type === "decision_requested" &&
      e.actor.kind === "assignment" &&
      e.actor.role_id === "pm" &&
      typeof e.payload === "object" &&
      e.payload !== null &&
      "decision_id" in e.payload &&
      e.payload.decision_id === q.id &&
      "previous_decider" in e.payload &&
      e.payload.previous_decider === "role:pm",
  );
}
