import { autoRiskMergeReason } from "../auto-risk.js";
import { deriveReviewMatrix } from "../derived.js";
import type { Card, Decision, PlainSummary, ToolName } from "../entities.js";
import { flowAtLeast } from "../flow.js";
import type { CardId } from "../ids.js";
import {
  type DecisionCategory,
  decisionDelegation,
  highRiskCategories,
  type ProjectPreferences,
  pmConfirmHumanDecidedMerges,
  pmMergeConfirmation,
} from "../preferences.js";
import { type CommandDraft, type CommandState, ensure } from "./core.js";
import {
  mergeContentDecisions,
  personallyResolved,
} from "./human-decided-merge.js";
import {
  INDEPENDENT_REVIEW_LIMIT_HUMAN_REASON,
  independentReviewLimitDelegationAllowed,
  independentReviewLimitItem,
} from "./independent-review-limit-delegation.js";
import { systemHandoffPlainSummary } from "./plain-summary.js";
import type { RoleRuleState } from "./role-rule-implementation.js";
import { roleRuleMergeReason } from "./role-rule-implementation.js";

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
/**
 * Human-flagged sensitive cards, D12 high-risk categories and scope changes on a card keep its merge
 * confirmation with the human (§7.4): decisions on or affecting the card,
 * plus the decision the card was created from (`source.kind=decision`), so
 * work derived from a project-level sensitive decision is not "ordinary".
 * Withdrawn questions on the card no longer count.
 */
/**
 * C-167: only the human can declare a D12 question unrelated to its cards'
 * merge content (`merge_related=false`, raised by human). requestDecision
 * rejects the label from anyone else; this check repeats the rule so a label
 * without a human raiser never lifts the human-merge requirement. The separate
 * C-309 preference permits only personally resolved scope/permission questions.
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
): string | undefined {
  const card = cards.find((c) => c.id === card_id);
  // C-65: the human's own flag wins over any category; agents cannot set it.
  if (card?.sensitive) return SENSITIVE_CARD_REASON;
  const sourceId =
    card?.source.kind === "decision" ? card.source.decision_id : undefined;
  const sensitive = (card ? mergeContentDecisions(decisions, card) : []).find(
    (q) =>
      (q.category === "scope_change" ||
        (!!q.category && highRiskCategories.includes(q.category))) &&
      !(
        (q.category === "scope_change" || q.category === "permission") &&
        pmConfirmHumanDecidedMerges(preferences) &&
        personallyResolved(q)
      ),
  );
  return sensitive
    ? `卡片${sensitive.id === sourceId ? "来源拍板" : ""}涉及${sensitive.category === "scope_change" ? "需求范围变化" : "高风险事项（花钱、账号、权限或删除数据）"}（${sensitive.id}），合并须由人确认。`
    : undefined;
}
/** Human-only merge confirmation: sensitive card or PM handed it over (§7.4). */
export function mergeRequiresHuman(
  state: {
    readonly project_id?: CommandState["project_id"];
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
    (!!autoRiskMergeReason(state, q.card_id) ||
      !!roleRuleMergeReason(state, q) ||
      !!q.human_required_reason ||
      !q.card_id ||
      !!mergeNeedsHuman(
        state.decisions,
        state.cards,
        q.card_id,
        state.project_preferences?.find((p) => p.id === state.project_id),
      ))
  );
}
type DelegationSubject = Pick<
  Decision,
  "category" | "trigger" | "card_id" | "human_required_reason"
> &
  Partial<
    Pick<Decision, "affected_work_items" | "role_rule_basis" | "kind">
  > & {
    readonly target?:
      | { readonly delivery_id: import("../ids.js").DeliveryId }
      | { readonly subject: import("../entities.js").DeliverySubject };
  };
/** P2a-14: risk tags never override the existing human-only rules. */
export function riskTagAutoMergeAllowed(
  state: Pick<
    CommandState,
    "cards" | "decisions" | "work_items" | "deliveries" | "reviews"
  > &
    Partial<Pick<CommandState, "project_id" | "project_preferences">>,
  q: DelegationSubject,
): boolean {
  const card = state.cards.find((c) => c.id === q.card_id);
  if (
    q.trigger !== "merge_confirmation" ||
    !card?.risk_tags?.length ||
    !card.risk_tags.every((tag) =>
      ["security", "permission", "numeric_rule"].includes(tag),
    ) ||
    q.human_required_reason ||
    mergeNeedsHuman(
      state.decisions,
      state.cards,
      card.id,
      state.project_preferences?.find((p) => p.id === state.project_id),
    )
  )
    return false;
  const items = state.work_items.filter((w) => w.card_id === card.id);
  const producers = items.filter(
    (w) => w.kind === "produce" && w.status !== "cancelled",
  );
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
  if (!producers.length || current.length !== producers.length) return false;
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
  return current.every((v) =>
    matrix.some((r) => r.delivery_id === v.id && r.verdict === "pass"),
  );
}
function projectPreference(d: CommandDraft) {
  return d.list("project_preferences").find((p) => p.id === d.state.project_id);
}
/** Old uncategorized decisions remain human-only until explicitly classified. */
export function delegationAllowed(d: CommandDraft, q: DelegationSubject) {
  const independent = independentReviewLimitItem(d, q);
  if (independent)
    return (
      !q.human_required_reason &&
      independentReviewLimitDelegationAllowed(d, independent)
    );
  if (q.trigger === "merge_confirmation")
    return (
      !d.list("cards").some((c) => c.id === q.card_id && flowAtLeast(c, 4)) &&
      pmMergeConfirmation(projectPreference(d)) &&
      !q.human_required_reason &&
      !autoRiskMergeReason(
        {
          cards: d.list("cards"),
          work_items: d.list("work_items"),
          deliveries: d.list("deliveries"),
        },
        q.card_id,
      ) &&
      !roleRuleMergeReason(
        {
          ...d.state,
          work_items: d.list("work_items"),
          deliveries: d.list("deliveries"),
          decisions: d.list("decisions"),
          project_preferences: d.list("project_preferences"),
          events: [...d.state.events, ...d.events],
        },
        q,
      ) &&
      !!q.card_id &&
      !mergeNeedsHuman(
        d.list("decisions"),
        d.list("cards"),
        q.card_id,
        projectPreference(d),
      ) &&
      (!d.list("cards").find((c) => c.id === q.card_id)?.risk_tags?.length ||
        riskTagAutoMergeAllowed(
          {
            project_id: d.state.project_id,
            project_preferences: d.list("project_preferences"),
            cards: d.list("cards"),
            decisions: d.list("decisions"),
            work_items: d.list("work_items"),
            deliveries: d.list("deliveries"),
            reviews: d.list("reviews"),
          },
          q,
        ))
    );
  return (
    // A human-required decision (e.g. a template's human completion review)
    // ignores the delegation preference (p2v-12 §2.4, C-104 security review).
    !q.human_required_reason &&
    !!q.category &&
    q.category !== "permission" &&
    decisionDelegation(projectPreference(d))[q.category] &&
    (!highRiskCategories.includes(q.category) ||
      !!humanCategoryAuthorization(d, q.category))
  );
}
/** C-366: cached flags alone cannot authorize the three newly delegable categories. */
function humanCategoryAuthorization(
  d: CommandDraft,
  category: DecisionCategory,
) {
  const audit = [...d.state.events, ...d.events].findLast((e) => {
    const p = e.payload as {
      preference?: string;
      old_value?: Record<string, unknown>;
      new_value?: Record<string, unknown>;
    } | null;
    return (
      e.type === "project_preferences_updated" &&
      p?.preference === "decision_delegation" &&
      p.new_value?.[category] !== p.old_value?.[category]
    );
  });
  if (
    audit?.actor.kind !== "human" ||
    audit.actor.project_id !== d.state.project_id
  )
    return undefined;
  const payload = audit.payload as { new_value?: Record<string, unknown> };
  return payload.new_value?.[category] === true ? audit : undefined;
}
function preferenceAudit(d: CommandDraft, preference: string) {
  return [...d.state.events, ...d.events]
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
  const audit = preferenceAudit(d, "independent_review_limit_delegation");
  const limitAudit = preferenceAudit(
    d,
    "independent_review_limit_delegation_max",
  );
  return `project:${d.state.project_id}/independent_review_limit_delegation${audit ? `/event:${audit.id}` : ""}${limitAudit ? `/limit-event:${limitAudit.id}` : ""}`;
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
    ? humanCategoryAuthorization(d, category)
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
