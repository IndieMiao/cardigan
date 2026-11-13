import type { Assignment, Card, Decision, ToolName } from "../entities.js";
import type { CardId } from "../ids.js";
import {
  type DecisionCategory,
  decisionDelegation,
  highRiskCategories,
  pmMergeConfirmation,
} from "../preferences.js";
import { type CommandDraft, ensure } from "./core.js";

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
 * without a human raiser never lifts the human-merge requirement. Answering
 * a question is not an authorization to skip the human merge (review V-543).
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
): string | undefined {
  const card = cards.find((c) => c.id === card_id);
  // C-65: the human's own flag wins over any category; agents cannot set it.
  if (card?.sensitive) return SENSITIVE_CARD_REASON;
  const sourceId =
    card?.source.kind === "decision" ? card.source.decision_id : undefined;
  const sensitive = decisions.find(
    (q) =>
      // System confirmations (merge, worktree cleanup) are not card content.
      q.trigger !== "merge_confirmation" &&
      q.trigger !== "worktree_cleanup" &&
      (q.id === sourceId ||
        (!mergeUnrelatedConfirmed(q) &&
          q.status !== "withdrawn" &&
          (q.card_id === card_id || q.affected_cards.includes(card_id)))) &&
      (q.category === "scope_change" ||
        (!!q.category && highRiskCategories.includes(q.category))),
  );
  return sensitive
    ? `卡片${sensitive.id === sourceId ? "来源拍板" : ""}涉及${sensitive.category === "scope_change" ? "需求范围变化" : "高风险事项（花钱、账号、权限或删除数据）"}（${sensitive.id}），合并须由人确认。`
    : undefined;
}
/** Human-only merge confirmation: sensitive card or PM handed it over (§7.4). */
export function mergeRequiresHuman(
  state: {
    readonly decisions: readonly Decision[];
    readonly cards: readonly Pick<Card, "id" | "source" | "sensitive">[];
  },
  q: Decision,
): boolean {
  return (
    q.trigger === "merge_confirmation" &&
    (!!q.human_required_reason ||
      !q.card_id ||
      !!mergeNeedsHuman(state.decisions, state.cards, q.card_id))
  );
}
type DelegationSubject = Pick<
  Decision,
  "category" | "trigger" | "card_id" | "human_required_reason"
>;
function projectPreference(d: CommandDraft) {
  return d.list("project_preferences").find((p) => p.id === d.state.project_id);
}
/** Old uncategorized decisions remain human-only until explicitly classified. */
export function delegationAllowed(d: CommandDraft, q: DelegationSubject) {
  if (q.trigger === "merge_confirmation")
    return (
      pmMergeConfirmation(projectPreference(d)) &&
      !q.human_required_reason &&
      !!q.card_id &&
      !mergeNeedsHuman(d.list("decisions"), d.list("cards"), q.card_id)
    );
  return (
    // A human-required decision (e.g. a template's human completion review)
    // ignores the delegation preference (p2v-12 §2.4, C-104 security review).
    !q.human_required_reason &&
    !!q.category &&
    !highRiskCategories.includes(q.category) &&
    decisionDelegation(projectPreference(d))[q.category]
  );
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
  const audit = preferenceAudit(d, "decision_delegation");
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
      delegation_authority:
        q.trigger === "merge_confirmation"
          ? mergeDelegationAuthority(d)
          : delegationAuthority(d, q.category as DecisionCategory),
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
) {
  d.put("decisions", {
    ...q,
    decider: "human",
    context: `${q.context}\n\n${reason}`,
    ...(humanRequired ? { human_required_reason: reason } : {}),
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
    },
    { type: "decision_request", decision_id: q.id, body: reason },
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
export function handoffWithoutOps(d: CommandDraft, assignment: Assignment) {
  if (
    assignment.scope !== "standing" ||
    assignment.role_id !== "pm" ||
    assignment.standing_mode !== "ops"
  )
    return;
  const reason = `后台项目经理 ${assignment.id} 已${assignment.status === "suspended" ? "暂停" : "释放"}，项目已无活跃后台，待处理事项转交给你。`;
  handoffUnauthorizedDecisions(d, reason, assignment.id);
  if (hasActivePmOps(d, "triage_human_action")) return;
  for (const action of d.list("human_actions")) {
    if (action.status !== "open" || action.triage !== "pm_ops") continue;
    d.put("human_actions", {
      ...action,
      triage: "human",
      triage_rationale: reason,
    });
    d.emit(
      "human_action_requested",
      action.card_id,
      { human_action_id: action.id, reason },
      { type: "human_action", human_action_id: action.id, body: reason },
    );
  }
}
export function grantDecisionCategory(d: CommandDraft, q: Decision) {
  ensure(
    d.actor.kind === "human" &&
      q.category &&
      q.trigger !== "merge_confirmation" &&
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
