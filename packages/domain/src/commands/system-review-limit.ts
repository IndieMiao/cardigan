import type { Actor, Decision } from "../entities.js";
import type { DecisionId, EventId } from "../ids.js";
import {
  fullGitSha,
  type SystemReviewLimitCandidate,
  type SystemReviewLimitFailure,
  type SystemReviewLimitProof,
  safeSystemReviewLimitFailure,
  systemReviewLimitFailureCategories,
  systemReviewLimitFailureStages,
  touchesRoleRules,
  validRoleRulePaths,
  validSystemReviewLimitMax,
} from "../system-review-limit.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
} from "./core.js";
import {
  delegationAllowed,
  hasActivePmOps,
  mergeNeedsHuman,
} from "./delegation.js";
import { projectPreferences } from "./preferences.js";
import { recordDecisionResolution } from "./review-limit-resolution.js";
import { currentReviewTarget, reviewRound } from "./review-round.js";

function eligible(
  d: CommandDraft,
  q: Decision,
): SystemReviewLimitCandidate | undefined {
  const pref = projectPreferences(d.state);
  const max = pref.system_review_limit_max_raises;
  const paths = pref.role_rule_paths;
  if (
    pref.system_review_limit_raise !== true ||
    !max ||
    !validSystemReviewLimitMax(max) ||
    !paths?.length ||
    !validRoleRulePaths(paths) ||
    q.trigger !== "review_limit" ||
    q.status !== "open" ||
    q.decider !== "role:pm" ||
    q.resolution ||
    q.human_required_reason ||
    q.category !== "general" ||
    !q.blocking ||
    q.affected_work_items.length !== 1 ||
    !q.card_id ||
    !delegationAllowed(d, q) ||
    !hasActivePmOps(d, "update_work_item") ||
    mergeNeedsHuman(d.list("decisions"), d.list("cards"), q.card_id)
  )
    return;
  const card = d.list("cards").find((c) => c.id === q.card_id);
  const item = d
    .list("work_items")
    .find((w) => w.id === q.affected_work_items[0]);
  if (
    !card?.base_branch ||
    ["backlog", "done", "cancelled", "awaiting_merge"].includes(card.status) ||
    !item ||
    item.card_id !== card.id ||
    item.kind !== "verify" ||
    item.role_id === "independent_reviewer" ||
    item.status !== "waiting_decision" ||
    item.replaced_by_work_item_id ||
    !Number.isSafeInteger(item.max_review_rounds + 1) ||
    reviewRound(d, item) !== item.max_review_rounds + 1
  )
    return;
  const used = d.state.events.filter(
    (e) =>
      e.actor.kind === "system" &&
      e.type === "system_review_limit_raised" &&
      (e.payload as Record<string, unknown>).work_item_id === item.id,
  ).length;
  if (used >= max) return;
  const prior = d
    .list("reviews")
    .filter((r) => r.work_item_id === item.id)
    .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
  const target = currentReviewTarget(d, item);
  const previous = d
    .list("deliveries")
    .find((v) => v.id === prior?.delivery_id);
  if (
    prior?.verdict !== "pass" ||
    prior.withdrawn ||
    prior.issues.some((i) => i.must_fix && !i.pre_existing) ||
    !target ||
    !previous ||
    target.id === previous.id ||
    target.work_item_id !== previous.work_item_id ||
    (target.kind === "card_completion") !==
      (previous.kind === "card_completion") ||
    target.subject.kind !== "git_head" ||
    previous.subject.kind !== "git_head" ||
    prior.target_sha !== previous.subject.value ||
    !previous.requested_verifiers.includes(item.id) ||
    !fullGitSha(target.subject.value) ||
    !fullGitSha(previous.subject.value)
  )
    return;
  // A currently outstanding issue from another verifier must not be hidden by this pass.
  if (
    d
      .list("reviews")
      .some(
        (r) =>
          !r.withdrawn &&
          r.issues.some((i) => i.must_fix && !i.pre_existing) &&
          d
            .list("deliveries")
            .some(
              (v) =>
                v.id === r.delivery_id &&
                v.status !== "superseded" &&
                d
                  .list("work_items")
                  .some(
                    (w) => w.id === v.work_item_id && w.card_id === card.id,
                  ),
            ),
      )
  )
    return;
  return {
    decision_id: q.id,
    card_id: card.id,
    work_item_id: item.id,
    review_id: prior.id,
    previous_delivery_id: previous.id,
    previous_sha: previous.subject.value,
    delivery_id: target.id,
    delivery_sha: target.subject.value,
    base_branch: card.base_branch,
    max_auto_raises: max,
    role_rule_paths: paths,
  };
}

/** Claim once before Git IO. A crash or failed proof leaves the decision with PM Ops; no automatic retry. */
export function beginSystemReviewLimitRaise(
  state: CommandState,
  actor: Actor,
  p: { decision_id: DecisionId },
  ports: CommandPorts,
) {
  return command(state, actor, "system_review_limit", ports, (d) => {
    const q = d.list("decisions").find((q) => q.id === p.decision_id);
    if (
      !q ||
      d.state.events.some(
        (e) =>
          e.type === "system_review_limit_attempted" &&
          (e.payload as Record<string, unknown>).decision_id === q.id,
      )
    )
      return null;
    const candidate = eligible(d, q);
    if (!candidate) return null;
    const event = d.emit("system_review_limit_attempted", candidate.card_id, {
      ...candidate,
    });
    return { attempt_id: event.id, candidate };
  });
}

/** Fresh transaction: the claim and Git evidence cannot override a PM pause, handoff or new delivery. */
export function finishSystemReviewLimitRaise(
  state: CommandState,
  actor: Actor,
  p: {
    attempt_id: EventId;
    proof: SystemReviewLimitProof | null;
    failure?: SystemReviewLimitFailure;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "system_review_limit", ports, (d) => {
    const attempt = d.state.events.find(
      (e) =>
        e.id === p.attempt_id &&
        e.type === "system_review_limit_attempted" &&
        e.actor.kind === "system",
    );
    if (
      !attempt ||
      d.state.events.some(
        (e) =>
          e.type === "system_review_limit_checked" &&
          (e.payload as Record<string, unknown>).attempt_id === attempt.id,
      )
    )
      return null;
    const claimed = attempt.payload as unknown as SystemReviewLimitCandidate;
    const q = d.list("decisions").find((q) => q.id === claimed.decision_id);
    const candidate = q && eligible(d, q);
    const proof = p.proof;
    const failure =
      p.failure === undefined
        ? undefined
        : safeSystemReviewLimitFailure(p.failure);
    const equal = (a: unknown, b: unknown) =>
      JSON.stringify(a) === JSON.stringify(b);
    const accepted = !!(
      !failure &&
      q &&
      candidate &&
      equal(candidate, claimed) &&
      proof &&
      equal(proof.candidate, candidate) &&
      fullGitSha(proof.base_sha) &&
      fullGitSha(proof.merged_tree) &&
      proof.merged_tree === proof.delivery_tree &&
      Array.isArray(proof.changed_paths) &&
      proof.changed_paths.every(
        (path) => typeof path === "string" && path.length > 0,
      ) &&
      !touchesRoleRules(proof.changed_paths, candidate.role_rule_paths)
    );
    d.emit(
      "system_review_limit_checked",
      attempt.card_id,
      {
        attempt_id: attempt.id,
        decision_id: claimed.decision_id,
        accepted,
        ...(failure ? { failure: { ...failure } } : {}),
      },
      failure
        ? {
            type: "system",
            work_item_id: claimed.work_item_id,
            decision_id: claimed.decision_id,
            body: `系统自动加轮核验失败：${systemReviewLimitFailureStages[failure.stage]}时${systemReviewLimitFailureCategories[failure.category]}。未自动加轮；请项目经理排查主机，本次不会自动重试。`,
          }
        : undefined,
    );
    if (!accepted || !q || !candidate || !proof) return null;
    const rationale =
      "系统核对：上一轮审核通过且无必须修复项，新交付的树完全等于已审版本干净合入可信基线的结果，未命中角色规则路径，累计加轮未超过项目上限。增加一轮后仍须重新审核。";
    d.emit(
      "system_review_limit_raised",
      candidate.card_id,
      {
        ...candidate,
        attempt_id: attempt.id,
        base_sha: proof.base_sha,
        merged_tree: proof.merged_tree,
        delivery_tree: proof.delivery_tree,
        changed_paths: [...proof.changed_paths],
        rule: "clean_merge_tree_equal",
      },
      {
        type: "system",
        work_item_id: candidate.work_item_id,
        decision_id: q.id,
        body: rationale,
      },
    );
    return recordDecisionResolution(d, q, {
      option: "raise_limit",
      rationale,
      raw_quote: rationale,
      resolved_by: d.author,
      via: "delegated",
      via_chain: [d.author],
      proxy_authority: `project:${state.project_id}/system_review_limit_raise`,
      at: d.now,
    });
  });
}
