import type {
  Actor,
  Author,
  Decision,
  HumanAction,
  TimelineEntry,
  WorkItem,
} from "../entities.js";
import type {
  AttachmentId,
  CardId,
  DecisionId,
  HumanActionId,
  WorkItemId,
} from "../ids.js";
import { commentMentions } from "../mentions.js";
import { decisionCategories, highRiskCategories } from "../preferences.js";
import { extractReferences } from "../references.js";
import { decisionAttachments } from "./decision-attachments.js";
import {
  buildSuggestion,
  type DecisionSuggestionInput,
  suggestionStale,
} from "./decision-suggestion.js";
import {
  assignDecision,
  delegationAllowed,
  delegationAuthority,
  grantDecisionCategory,
  handoffDecision,
  hasActivePmOps,
  isPmOps,
  mergeDelegationAuthority,
  mergeRequiresHuman,
} from "./delegation.js";
import {
  pmFailedMergeCheck,
  pmMergeBlockers,
  pmMergeCheckFailureAuthority,
} from "./merge-delegation.js";
import { snoozeMergeConfirmation } from "./merge-snooze.js";
import { resolveReviewLimit } from "./review-limit-resolution.js";

export { extractReferences } from "../references.js";
export {
  decisionAttachments,
  MAX_DECISION_ATTACHMENTS,
} from "./decision-attachments.js";

import { transition } from "../transitions.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  text,
  unwrap,
} from "./core.js";
import { endRun } from "./end-run.js";
import { resolveHumanCompletionReview } from "./human-completion.js";
import { requestMergeChanges } from "./merge.js";
import { failedConfirmedMergeCheck, requeueMergeCheck } from "./merge-check.js";
import { queueResumedRun, resumeWork } from "./resumption.js";
import { recordDecisionResolution } from "./review-limit-resolution.js";
import { activeWork } from "./workflow.js";

export function issueInstruction(
  state: CommandState,
  actor: Actor,
  p: { card_id: CardId; work_item_id: WorkItemId; body: string },
  ports: CommandPorts,
) {
  return command(state, actor, "issue_instruction", ports, (d) => {
    ensure(
      actor.kind === "human" ||
        (d.assignment?.scope === "standing" &&
          d.assignment.role_id === "pm" &&
          d.assignment.standing_mode === "ops"),
      "forbidden_tool",
      "Only the human or standing PM Ops can issue instructions",
    );
    const card = d.card(p.card_id),
      item = d.work(p.work_item_id);
    ensure(
      item.card_id === card.id,
      "validation_failed",
      "Work item belongs to another card",
    );
    ensure(
      !["done", "cancelled", "awaiting_merge"].includes(card.status) &&
        !["accepted", "passed", "cancelled"].includes(item.status),
      "illegal_transition",
      "Cannot instruct closed work or a card awaiting merge",
    );
    text(p.body, "body");
    d.emit(
      "instruction_issued",
      card.id,
      { work_item_id: item.id },
      {
        type: "instruction",
        body: p.body,
        work_item_id: item.id,
        refs: extractReferences(p.body),
      },
    );
    return d.timeline[0];
  });
}
export function postComment(
  state: CommandState,
  actor: Actor,
  p: Pick<TimelineEntry, "card_id" | "body"> &
    Partial<
      Pick<
        TimelineEntry,
        "work_item_id" | "mentions" | "reply_to" | "refs" | "supersedes"
      >
    >,
  ports: CommandPorts,
) {
  return command(state, actor, "post_comment", ports, (d) => {
    d.card(p.card_id);
    text(p.body, "body");
    if (p.work_item_id)
      ensure(
        d.work(p.work_item_id).card_id === p.card_id,
        "validation_failed",
        "Work item belongs to another card",
      );
    for (const id of [p.reply_to, p.supersedes].filter(
      (id) => id !== undefined,
    )) {
      const entry = state.timeline.find((entry) => entry.id === id);
      ensure(entry, "not_found", "Referenced timeline entry was not found");
      ensure(
        entry.card_id === p.card_id,
        "validation_failed",
        "Reply/supersession must stay on this card",
      );
      if (id === p.supersedes)
        ensure(
          entry.author === d.author,
          "unauthorized",
          "Only the same author can supersede a comment",
        );
    }
    const refs = [
      ...new Map(
        [...(p.refs ?? []), ...extractReferences(p.body)].map((ref) => [
          JSON.stringify(ref),
          ref,
        ]),
      ).values(),
    ];
    d.emit(
      "comment_posted",
      p.card_id,
      { body: p.body },
      {
        type: "comment",
        body: p.body,
        refs,
        mentions: commentMentions(
          p.body,
          p.mentions ?? [],
          state.employees ?? [],
          state.roles.map((role) => role.role_id),
        ),
        ...(p.work_item_id ? { work_item_id: p.work_item_id } : {}),
        ...(p.reply_to ? { reply_to: p.reply_to } : {}),
        ...(p.supersedes ? { supersedes: p.supersedes } : {}),
      },
    );
    return d.timeline[0];
  });
}
function paused(
  d: CommandDraft,
  item: WorkItem,
  kind: "blocked" | "waiting_decision",
) {
  if (item.status === "blocked" || item.status === "waiting_decision") return;
  const next =
    d.assignment?.scope === "work_item" && d.assignment.work_item_id === item.id
      ? activeWork(d, item)
      : item;
  ensure(
    next.status === "in_progress",
    "illegal_transition",
    `Cannot pause work item ${item.id} (${item.kind}:${item.status}); work is not in progress`,
  );
  d.put(
    "work_items",
    d.move(next, kind === "blocked" ? "block" : "request_decision"),
  );
}
function endForDecision(
  d: CommandDraft,
  summary: string,
  items: readonly WorkItem[],
) {
  const assignments = new Set(
    [
      ...(d.assignment?.scope === "standing" ? [d.assignment.id] : []),
      ...items.map((w) => w.assignment_id),
    ].filter((id) => id !== undefined),
  );
  for (const run of d
    .list("runs")
    .filter(
      (run) => assignments.has(run.assignment_id) && run.status === "running",
    )) {
    endRun(d, run, "blocked", summary);
  }
}
export function reportBlocker(
  state: CommandState,
  actor: Actor,
  p: { work_item_id: WorkItemId; reason: string; needs: "role" | "human" },
  ports: CommandPorts,
) {
  return command(state, actor, "report_blocker", ports, (d) => {
    const item = d.ownWork(p.work_item_id);
    text(p.reason, "reason");
    ensure(
      p.needs === "role" || p.needs === "human",
      "validation_failed",
      "Unknown blocker owner",
    );
    paused(d, item, "blocked");
    d.put("work_items", {
      ...d.work(item.id),
      reported_blocker: {
        reason: p.reason,
        needs: p.needs,
        reported_by: d.author,
        reported_at: d.now,
      },
    });
    d.emit(
      "blocker_reported",
      item.card_id,
      { work_item_id: item.id, needs: p.needs },
      { type: "status_change", body: p.reason, work_item_id: item.id },
    );
    return {
      work_item_id: item.id,
      guidance:
        p.needs === "human"
          ? "Use request_human_action or request_decision to request human intervention"
          : "Notify the responsible role",
    };
  });
}
export type RequestDecisionParams = Pick<
  Decision,
  | "kind"
  | "question"
  | "context"
  | "options"
  | "recommended"
  | "affected_cards"
  | "affected_work_items"
  | "blocking"
  | "decider"
> & {
  readonly card_id?: CardId;
  readonly category: NonNullable<Decision["category"]>;
  readonly target?: Extract<Decision, { kind: "approve" }>["target"];
  readonly attachment_ids?: readonly AttachmentId[];
  /** C-167: `false` marks a D12 decision as unrelated to its cards' merge content. */
  readonly merge_related?: boolean;
  /** C-192: suggested option for the human; must match `recommended`. */
  readonly suggestion?: DecisionSuggestionInput;
};
export function requestDecision(
  state: CommandState,
  actor: Actor,
  p: RequestDecisionParams,
  ports: CommandPorts,
) {
  return command(state, actor, "request_decision", ports, (d) => {
    if (p.card_id) d.card(p.card_id);
    else d.projectAccess();
    text(p.question, "question");
    text(p.context, "context");
    text(p.decider, "decider");
    ensure(
      p.decider !== "role:host_ops" &&
        (d.assignment?.role_id !== "host_ops" ||
          p.decider === "human" ||
          p.decider === "role:pm"),
      "unauthorized",
      "主机运维不能作为决策人，只能向人或 PM 请求拍板",
    );
    ensure(
      decisionCategories.includes(p.category),
      "validation_failed",
      "Decision category is required",
    );
    ensure(
      p.decider === "human" ||
        (p.decider.startsWith("role:") &&
          state.roles.some((r) => `role:${r.role_id}` === p.decider)),
      "validation_failed",
      "Unknown decider",
    );
    ensure(
      (!highRiskCategories.includes(p.category) &&
        (p.category !== "scope_change" || p.decider === "role:pm")) ||
        p.decider === "human",
      "unauthorized",
      "Sensitive decisions require the human",
    );
    ensure(
      p.kind === "choose" || p.kind === "approve",
      "validation_failed",
      "Unknown decision kind",
    );
    ensure(
      p.options.length > 0 &&
        new Set(p.options.map((o) => o.key)).size === p.options.length &&
        p.options.every(
          (o) => o.key.trim() && o.description.trim() && o.impact.trim(),
        ) &&
        p.options.some((o) => o.key === p.recommended),
      "validation_failed",
      "Options and recommendation must be explicit",
    );
    ensure(
      !p.suggestion || p.suggestion.option === p.recommended,
      "validation_failed",
      "suggestion.option 必须与 recommended 一致",
    );
    if (p.kind === "approve") {
      ensure(
        p.target,
        "validation_failed",
        "Approval must bind to a delivery or subject",
      );
      if ("delivery_id" in p.target)
        d.work(d.get("deliveries", p.target.delivery_id).work_item_id);
      else {
        text(p.target.subject.value, "approval subject");
        ensure(
          ["git_head", "artifact_sha256", "doc_version"].includes(
            p.target.subject.kind,
          ),
          "validation_failed",
          "Invalid approval subject",
        );
      }
    }
    const own =
      p.blocking && d.assignment?.scope === "work_item"
        ? d.ownWork(d.assignment.work_item_id)
        : undefined;
    const waitingForOthers =
      own?.kind === "produce" && ["delivered", "accepted"].includes(own.status);
    const items = [
      ...new Set([
        ...p.affected_work_items,
        ...(own && !waitingForOthers ? [own.id] : []),
      ]),
    ].map((id) => d.work(id));
    const cards = [
      ...new Set([
        ...(p.card_id ? [p.card_id] : []),
        ...p.affected_cards,
        ...items.map((w) => w.card_id),
      ]),
    ];
    for (const id of cards) d.card(id);
    const attachment_ids = decisionAttachments(d, p.attachment_ids, cards);
    // C-167: only a human raiser can say a D12 question is not about what the
    // card merges (an Agent's own label is no authorization, review V-540 and
    // V-543), and only when it touches no produce work item and binds no
    // approval target; anything else stays merge-related (human merge).
    // Agents raise project-wide questions without card_id/affected_cards.
    const mergeUnrelated = p.merge_related === false;
    if (mergeUnrelated) {
      ensure(
        d.author === "human",
        "unauthorized",
        "只有人能把拍板标为与合并无关；与卡片无关的全局问题请不填 card_id 和 affected_cards 发起",
      );
      ensure(
        highRiskCategories.includes(p.category) &&
          !p.target &&
          items.every((w) => w.kind !== "produce"),
        "validation_failed",
        "只有不涉及产出工作项、也不绑定审批对象的高风险拍板（花钱、账号、权限、删除数据）才能标为与合并无关",
      );
    }
    if (p.blocking) {
      for (const item of items) paused(d, item, "waiting_decision");
      endForDecision(d, p.question, items);
    }
    const id = d.ids.next(state.project_id, "decision");
    const base = {
      id,
      key: id,
      ...(p.card_id ? { card_id: p.card_id } : {}),
      raised_by: d.author,
      category: p.category,
      question: p.question,
      context: mergeUnrelated
        ? `${p.context}\n\n发起人标注：此拍板与 ${cards.join("、") || "任何卡片"} 的合并内容无关，不改变合并确认由谁处理。`
        : p.context,
      ...(mergeUnrelated ? { merge_related: false as const } : {}),
      options: p.options,
      recommended: p.recommended,
      affected_cards: cards,
      affected_work_items: items.map((w) => w.id),
      ...(attachment_ids.length ? { attachment_ids } : {}),
      ...(p.suggestion
        ? {
            suggestion: buildSuggestion(
              d,
              {
                options: p.options,
                ...(p.card_id ? { card_id: p.card_id } : {}),
                affected_cards: cards,
              },
              p.suggestion,
            ),
          }
        : {}),
      blocking: p.blocking,
      decider: p.decider,
      doc_refs: [],
      status: "open" as const,
    };
    const decision: Decision = assignDecision(
      d,
      p.kind === "approve"
        ? {
            ...base,
            kind: "approve",
            target: p.target as NonNullable<typeof p.target>,
          }
        : { ...base, kind: "choose" },
    );
    d.put("decisions", decision);
    for (const card of cards.length ? cards : [undefined])
      d.emit(
        "decision_requested",
        card,
        { decision_id: id, affected_work_items: decision.affected_work_items },
        { type: "decision_request", body: p.question, decision_id: id },
      );
    // §7.4 (C-167): a merge-related D12 or scope question makes the merge
    // confirmations of its own cards human-only, and that sticks: the handoff
    // writes human_required_reason, so no timeout auto-merge. Other cards'
    // confirmations and merge-unrelated questions leave them untouched.
    if (
      !mergeUnrelated &&
      (p.category === "scope_change" || highRiskCategories.includes(p.category))
    ) {
      const reason = `${id} 涉及${p.category === "scope_change" ? "需求范围变化" : "高风险事项（花钱、账号、权限或删除数据）"}，此卡片的合并确认须由人亲自确认，不适用超时自动合并。`;
      for (const q of d.list("decisions"))
        if (
          q.trigger === "merge_confirmation" &&
          q.card_id &&
          cards.includes(q.card_id) &&
          ["open", "provisional", "snoozed"].includes(q.status) &&
          !q.human_required_reason
        )
          handoffDecision(d, q, reason, undefined, true);
    }
    return decision;
  });
}
export function recordDecision(
  state: CommandState,
  actor: Actor,
  input: {
    decision_id: DecisionId;
    option: string;
    rationale: string;
    snooze_until?: string;
    raw_quote: string;
    via_chain?: readonly Author[];
    batch?: string;
    delegate_future?: boolean;
    /** C-192: the human clicked "按建议处理"; never accepted from Agents. */
    via_suggestion?: boolean;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "record_decision", ports, (d) => {
    const held = d.get("decisions", input.decision_id);
    let p = input;
    if (p.via_suggestion) {
      ensure(
        actor.kind === "human",
        "forbidden_tool",
        "按建议处理只能由人亲自操作，Agent 不能代人提交",
      );
      ensure(
        held.suggestion &&
          ["open", "provisional", "snoozed"].includes(held.status),
        "validation_failed",
        "这条拍板没有可用的建议",
      );
      ensure(
        !suggestionStale(state, held),
        "stale_target",
        "建议已过期：交付、合并检查或合并前核对在建议之后有变化，请按当前情况选择",
      );
      ensure(
        p.option === held.suggestion.option,
        "validation_failed",
        "按建议处理只能提交建议的选项",
      );
      const extra = p.raw_quote.trim();
      p = {
        ...p,
        raw_quote: `按建议处理：${p.option}${extra ? `。${extra}` : ""}`,
        rationale: p.rationale.trim() || held.suggestion.rationale,
      };
    }
    // §7.4 (C-65): the human may answer a merge confirmation PM Ops still
    // holds without turning delegation off; it becomes the human's answer.
    const takenOver =
      actor.kind === "human" &&
      held.decider === "role:pm" &&
      held.trigger === "merge_confirmation" &&
      ["open", "provisional", "snoozed"].includes(held.status);
    const decision: Decision = takenOver ? { ...held, decider: "human" } : held;
    // C-79: a confirmed merge handed back after failure may still retain
    // role:pm as its historical decider. Preserve that authorization record.
    const returningConfirmed =
      decision.trigger === "merge_confirmation" &&
      decision.status === "resolved" &&
      decision.resolution?.option === "merge" &&
      p.option === "request_changes";
    ensure(
      (actor.kind === "human" &&
        (decision.decider === "human" || returningConfirmed)) ||
        (actor.kind === "assignment" &&
          actor.role_id === "pm" &&
          d.assignment?.scope === "standing" &&
          d.assignment.standing_mode !== "ops" &&
          decision.decider !== "role:pm" &&
          decision.category !== "scope_change" &&
          !highRiskCategories.includes(decision.category ?? "general") &&
          actor.allowed_tools.includes("record_decision")),
      "forbidden_tool",
      "Only PM Office or the designated human can record decisions",
    );
    // §7.4: a sensitive or PM-escalated merge needs a human Actor; PM Office
    // transcription would record resolved_by=human without one.
    ensure(
      actor.kind === "human" || !mergeRequiresHuman(state, decision),
      "forbidden_tool",
      "此合并确认须由人在 Workbench 或本机 CLI 确认，PM 不能代记",
    );
    // C-104: a human-required decision (e.g. a template's human completion
    // review) also needs a human Actor; PM Office may not transcribe it.
    ensure(
      actor.kind === "human" || !decision.human_required_reason,
      "forbidden_tool",
      "此决定须由人在 Workbench 或本机 CLI 亲自确认，PM 不能代记",
    );
    if (decision.card_id) d.card(decision.card_id);
    else d.projectAccess();
    text(p.raw_quote, "raw_quote");
    text(p.rationale, "rationale");
    ensure(
      decision.options.some((o) => o.key === p.option),
      "validation_failed",
      "Option is not part of this decision",
    );
    // D12 permits human CLI confirmation; scope changes retain the browser-only rule.
    ensure(
      decision.category !== "scope_change" ||
        (actor.kind === "human" && ports.human_confirmation === "workbench"),
      "unauthorized",
      "未授权的需求范围变化只能由人在 Workbench 确认",
    );
    if (p.delegate_future) grantDecisionCategory(d, decision);
    if (returningConfirmed) {
      ensure(
        actor.kind === "human",
        "forbidden_tool",
        "只有人可以退回已确认的合并",
      );
      return returnConfirmedMerge(d, decision, p.rationale, p.raw_quote);
    }
    return resolveDecisionDraft(
      d,
      decision,
      takenOver ? { ...p, taken_over_from: "role:pm" } : p,
      false,
    );
  });
}
/**
 * Withdraw a confirmed merge whose current check failed or timed out (P2a-1
 * §2.6). The human (record_decision) and PM Ops (resolve_delegated_decision)
 * share this effect: completion superseded, producer back to
 * changes_requested, verifiers back to todo, confirmation superseded.
 */
function returnConfirmedMerge(
  d: CommandDraft,
  decision: Decision,
  reason: string,
  raw_quote: string,
  delegated?: { readonly notice: string; readonly proxy_authority: string },
) {
  ensure(
    failedConfirmedMergeCheck(d.state, decision),
    "illegal_transition",
    "已确认的合并只有在当前完成申请的最新检查失败或超时时才能退回修改；检查通过、排队或运行中均不能退回。",
  );
  requestMergeChanges(d, decision, reason, raw_quote, delegated);
  const superseded: Decision = {
    ...decision,
    status: unwrap(transition("decision", decision.status, "supersede")),
  };
  d.put("decisions", superseded);
  return superseded;
}
function resolveDecisionDraft(
  d: CommandDraft,
  decision: Decision,
  p: {
    option: string;
    rationale: string;
    snooze_until?: string;
    raw_quote: string;
    via_chain?: readonly Author[];
    batch?: string;
    notice?: string;
    taken_over_from?: "role:pm";
    via_suggestion?: boolean;
  },
  delegated: boolean,
) {
  ensure(
    p.snooze_until === undefined ||
      (decision.trigger === "merge_confirmation" && p.option === "hold"),
    "validation_failed",
    "snooze_until 只能用于暂缓合并确认",
  );
  if (decision.trigger === "merge_confirmation" && p.option === "hold")
    return snoozeMergeConfirmation(d, decision, p);
  const actor = d.actor;
  const result = recordDecisionResolution(d, decision, {
    option: p.option,
    rationale: p.rationale,
    resolved_by: decision.decider === "human" ? "human" : d.author,
    via: delegated
      ? "delegated"
      : actor.kind === "human"
        ? "needs_you"
        : "pm_office_chat",
    ...(delegated
      ? {
          proxy_authority:
            decision.trigger === "merge_confirmation"
              ? mergeDelegationAuthority(d)
              : delegationAuthority(d, decision.category ?? "general"),
        }
      : {}),
    ...(delegated && p.notice?.trim() ? { notice: p.notice.trim() } : {}),
    ...(p.taken_over_from ? { taken_over_from: p.taken_over_from } : {}),
    ...(p.via_suggestion && !delegated
      ? { via_suggestion: true as const }
      : {}),
    raw_quote: p.raw_quote,
    via_chain: [...(p.via_chain ?? []), d.author],
    ...(p.batch ? { batch: p.batch } : {}),
    at: d.now,
  });
  if (
    decision.trigger === "merge_confirmation" &&
    p.option === "request_changes"
  )
    requestMergeChanges(d, decision, p.rationale, p.raw_quote);
  if (decision.trigger === "completion_review")
    resolveHumanCompletionReview(d, decision, p.option);
  return result;
}

export function resolveDelegatedDecision(
  state: CommandState,
  actor: Actor,
  p: {
    decision_id: DecisionId;
    option: string;
    rationale: string;
    snooze_until?: string;
    escalate?: boolean;
    /** Needs You notice; required when PM Ops confirms a merge (§7.4). */
    notice?: string;
    /** C-95: card attachments to show the human; only with `escalate`. */
    attachment_ids?: readonly AttachmentId[];
    /** C-192: suggestion shown to the human; only with `escalate`. */
    suggestion?: DecisionSuggestionInput;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "resolve_delegated_decision", ports, (d) => {
    ensure(
      isPmOps(d),
      "forbidden_tool",
      "Only standing PM Ops can decide under project authorization",
    );
    const q = d.get("decisions", p.decision_id);
    // P2a-1 §2.6: a failed or timed-out check may also be handled on a
    // confirmed merge, whoever confirmed it; D12/scope cards stay human.
    const failed = pmFailedMergeCheck(state, q);
    const confirmedFailed = !!failed && q.status === "resolved";
    const timeoutRecheck =
      !!failed &&
      mergeRequiresHuman(state, q) &&
      p.option === "recheck" &&
      !p.escalate;
    ensure(
      timeoutRecheck ||
        (confirmedFailed && !mergeRequiresHuman(state, q)) ||
        (q.decider === "role:pm" &&
          ["open", "provisional", "snoozed"].includes(q.status) &&
          delegationAllowed(d, q)),
      "unauthorized",
      q.trigger === "merge_confirmation" && mergeRequiresHuman(state, q)
        ? "此合并确认须由人处理，PM 只能重新检查明确的超时失败，不能退回或代确认合并"
        : "Decision is not authorized for PM Ops",
    );
    text(p.rationale, "rationale");
    ensure(
      !p.attachment_ids?.length || !!p.escalate,
      "validation_failed",
      "attachment_ids 只能在交给人（escalate）时提供",
    );
    ensure(
      !p.suggestion || !!p.escalate,
      "validation_failed",
      "suggestion 只能在交给人（escalate）时提供",
    );
    if (failed && !p.escalate) {
      ensure(
        !confirmedFailed ||
          p.option === "request_changes" ||
          p.option === "recheck",
        "validation_failed",
        "已确认合并的检查失败或超时后，PM 只能 request_changes、recheck 或交人",
      );
      if (p.option === "request_changes" || p.option === "recheck") {
        // §7.4: PM handling a failed check is synced to the human's notices.
        text(p.notice, "notice");
        const delegated = {
          notice: (p.notice ?? "").trim(),
          proxy_authority: pmMergeCheckFailureAuthority(state.project_id),
        };
        if (p.option === "recheck") {
          requeueMergeCheck(d, q.card_id as CardId, {
            ...delegated,
            decision_id: q.id,
            rationale: p.rationale,
          });
          return d.get("decisions", q.id);
        }
        if (confirmedFailed)
          return returnConfirmedMerge(
            d,
            q,
            p.rationale,
            p.rationale,
            delegated,
          );
      }
    }
    ensure(
      !!p.escalate ||
        p.option !== "recheck" ||
        q.trigger !== "merge_confirmation",
      "illegal_transition",
      "只有当前完成申请的最新检查失败或超时时才能重新检查",
    );
    if (p.escalate) {
      const attachment_ids = decisionAttachments(d, p.attachment_ids, [
        ...(q.card_id ? [q.card_id] : []),
        ...q.affected_cards,
      ]);
      const suggestion = p.suggestion
        ? buildSuggestion(d, q, p.suggestion)
        : undefined;
      handoffDecision(
        d,
        {
          ...q,
          ...(attachment_ids.length ? { attachment_ids } : {}),
          ...(suggestion ? { suggestion, recommended: suggestion.option } : {}),
        },
        `项目经理升级给你：${p.rationale}`,
        undefined,
        q.trigger === "merge_confirmation",
      );
      return d.get("decisions", q.id);
    }
    if (q.trigger === "merge_confirmation" && p.option === "merge") {
      const blockers = pmMergeBlockers(state, q);
      ensure(
        blockers.length === 0,
        "illegal_transition",
        `PM 只能在闸门检查、验证全部通过且无 must_fix 时确认合并，否则只能 hold、request_changes 或交人：${blockers.join("；")}`,
      );
      text(p.notice, "notice");
    }
    if (q.trigger === "review_limit") {
      ensure(
        p.option === "raise_limit" || p.option === "pause",
        "validation_failed",
        "Unknown review limit option",
      );
      const id = q.affected_work_items[0];
      ensure(id, "invariant_violation", "Missing review limit target");
      const item = d.work(id);
      resolveReviewLimit(d, item, {
        decision_id: q.id,
        option: p.option,
        rationale: p.rationale,
      });
      return d.get("decisions", q.id);
    }
    ensure(
      q.options.some((o) => o.key === p.option),
      "validation_failed",
      "Option is not part of this decision",
    );
    return resolveDecisionDraft(d, q, { ...p, raw_quote: p.rationale }, true);
  });
}

export function requestHumanAction(
  state: CommandState,
  actor: Actor,
  p: Pick<
    HumanAction,
    "instructions" | "why_human" | "expected_return" | "blocked_work_items"
  > & { card_id: CardId; due?: string; blocks_merge?: boolean },
  ports: CommandPorts,
) {
  return command(state, actor, "request_human_action", ports, (d) => {
    d.card(p.card_id);
    text(p.instructions, "instructions");
    text(p.why_human, "why_human");
    text(p.expected_return, "expected_return");
    const items = [...new Set(p.blocked_work_items)].map((id) => d.work(id));
    ensure(
      items.every((w) => w.card_id === p.card_id),
      "validation_failed",
      "Human action items must belong to its card",
    );
    for (const item of items) paused(d, item, "blocked");
    const id = d.ids.next(state.project_id, "human_action");
    const action: HumanAction = {
      id,
      key: id,
      card_id: p.card_id,
      requested_by: d.author,
      instructions: p.instructions,
      why_human: p.why_human,
      expected_return: p.expected_return,
      blocked_work_items: items.map((w) => w.id),
      status: "open",
      triage: hasActivePmOps(d, "triage_human_action") ? "pm_ops" : "human",
      ...(p.due ? { due: p.due } : {}),
      ...(p.blocks_merge ? { blocks_merge: true } : {}),
    };
    d.put("human_actions", action);
    d.emit(
      "human_action_requested",
      p.card_id,
      {
        human_action_id: id,
        blocked_work_items: action.blocked_work_items,
        ...(action.blocks_merge ? { blocks_merge: true } : {}),
      },
      { type: "human_action", body: p.instructions, human_action_id: id },
    );
    return action;
  });
}
// Human-only application entry, not an additional MCP tool.
export function completeHumanAction(
  state: CommandState,
  actor: Actor,
  p: {
    human_action_id: HumanActionId;
    text: string;
    attachments?: readonly string[];
  },
  ports: CommandPorts,
) {
  return command(state, actor, "request_human_action", ports, (d) => {
    ensure(
      actor.kind === "human",
      "unauthorized",
      "Only the human can complete a human action",
    );
    return completeActionDraft(d, p);
  });
}
/** Internal: shared by human-only commands that also complete a Needs You item. */
export function completeActionDraft(
  d: CommandDraft,
  p: {
    human_action_id: HumanActionId;
    text: string;
    attachments?: readonly string[];
  },
) {
  const action = d.get("human_actions", p.human_action_id);
  text(p.text, "result");
  if (action.card_id) d.card(action.card_id);
  for (const id of p.attachments ?? [])
    ensure(
      d.get("attachments", id).card_id === action.card_id,
      "validation_failed",
      "Attachment belongs to another card",
    );
  const result: HumanAction = {
    ...action,
    status: unwrap(transition("human_action", action.status, "complete")),
    result: { text: p.text, attachments: p.attachments ?? [], at: d.now },
  };
  d.put("human_actions", result);
  const resumed: WorkItem[] = [];
  for (const id of action.blocked_work_items) {
    const item = d.work(id);
    if (resumeWork(d, item)) resumed.push(item);
  }
  const event = d.emit(
    "human_action_completed",
    action.card_id,
    {
      human_action_id: action.id,
      resume_work_items: resumed.map((item) => item.id),
    },
    { type: "human_action", body: p.text, human_action_id: action.id },
  );
  for (const item of resumed) queueResumedRun(d, item, event);
  return result;
}
export function triageHumanAction(
  state: CommandState,
  actor: Actor,
  p: {
    human_action_id: HumanActionId;
    disposition: "done" | "host" | "human";
    rationale: string;
    title?: string;
    summary?: string;
    why_human?: string;
    expected_outcome?: string;
    instructions?: string;
    expected_return?: string;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "triage_human_action", ports, (d) => {
    ensure(
      isPmOps(d),
      "forbidden_tool",
      "Only PM Ops can triage human actions",
    );
    const action = d.get("human_actions", p.human_action_id);
    ensure(
      action.status === "open",
      "illegal_transition",
      "Only an open human action can be triaged",
    );
    text(p.rationale, "rationale");
    if (p.disposition === "done") {
      ensure(
        action.triage === "pm_ops",
        "unauthorized",
        "An action already handed to the human cannot be completed by PM",
      );
      return completeActionDraft(d, {
        human_action_id: action.id,
        text: p.rationale,
      });
    }
    ensure(
      p.disposition === "host" || p.disposition === "human",
      "validation_failed",
      "Unknown disposition",
    );
    text(p.title, "title");
    ensure(
      [...p.title.trim()].length <= 80 && !/[\r\n]/u.test(p.title),
      "validation_failed",
      "Title must be one line, at most 80 characters",
    );
    text(p.summary, "summary");
    text(p.why_human, "why_human");
    text(p.expected_outcome, "expected_outcome");
    text(p.instructions, "instructions");
    text(p.expected_return, "expected_return");
    const handoff = {
      title: p.title.trim(),
      summary: p.summary,
      why_human: p.why_human,
      instructions: p.instructions,
      expected_outcome: p.expected_outcome,
      expected_return: p.expected_return,
      rewritten_by: d.author,
      rewritten_at: d.now,
    };
    const next: HumanAction = {
      ...action,
      triage: p.disposition,
      triage_rationale: p.rationale,
      handoff,
    };
    d.put("human_actions", next);
    d.emit(
      "human_action_requested",
      action.card_id,
      {
        human_action_id: action.id,
        disposition: p.disposition,
        reason: p.rationale,
        handoff,
      },
      {
        type: "human_action",
        human_action_id: action.id,
        body: `项目经理已改写${p.disposition === "host" ? "主机操作" : "待你执行"}：${p.title.trim()}\n\n这是什么：${p.summary}\n\n为什么需要你：${p.why_human}\n\n怎么做：${p.instructions}\n\n做完会怎样：${p.expected_outcome}\n\n完成后请回传：${p.expected_return}\n\n分拣理由：${p.rationale}`,
      },
    );
    return next;
  });
}
