import type { Assignment, Decision, ToolName } from "../entities.js";
import {
  type DecisionCategory,
  decisionDelegation,
  highRiskCategories,
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
/** Old uncategorized decisions remain human-only until explicitly classified. */
export function delegationAllowed(
  d: CommandDraft,
  q: Pick<Decision, "category" | "trigger">,
) {
  return (
    q.trigger !== "merge_confirmation" &&
    !!q.category &&
    !highRiskCategories.includes(q.category) &&
    decisionDelegation(
      d.list("project_preferences").find((p) => p.id === d.state.project_id),
    )[q.category]
  );
}
export function delegationAuthority(
  d: CommandDraft,
  category: DecisionCategory,
) {
  const preference = d
    .list("project_preferences")
    .find((p) => p.id === d.state.project_id);
  const audit = [...d.state.events, ...d.events]
    .filter(
      (e) =>
        e.type === "project_preferences_updated" &&
        typeof e.payload === "object" &&
        e.payload !== null &&
        "preference" in e.payload &&
        e.payload.preference === "decision_delegation",
    )
    .at(-1);
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
      delegation_authority: delegationAuthority(
        d,
        q.category as DecisionCategory,
      ),
    };
  if (q.decider === "role:pm") return { ...q, decider: "human" };
  return q;
}
export function handoffDecision(
  d: CommandDraft,
  q: Decision,
  reason: string,
  assignmentId?: string,
) {
  d.put("decisions", {
    ...q,
    decider: "human",
    context: `${q.context}\n\n${reason}`,
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
      ["open", "provisional"].includes(q.status) &&
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
