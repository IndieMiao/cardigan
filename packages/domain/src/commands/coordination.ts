import { categoryDelegated } from "../decision-authorization.js";
import {
  decisionQuestionBinding,
  heldByReviewDecision,
} from "../decision-question.js";
import type {
  Actor,
  Assignment,
  Author,
  Decision,
  HumanAction,
  HumanDecidedMergeBasis,
  MergeDecisionEvidence,
  PlainSummary,
  ReviewPauseInput,
  TimelineEntry,
  WorkItem,
} from "../entities.js";
import { flowAtLeast } from "../flow.js";
import type {
  AssignmentId,
  AttachmentId,
  CardId,
  DecisionId,
  HumanActionId,
  WorkItemId,
} from "../ids.js";
import { commentMentions } from "../mentions.js";
import { mergeOverrideReasonError } from "../merge-override.js";
import { latestPrecheckConflict } from "../precheck.js";
import { decisionCategories, highRiskCategories } from "../preferences.js";
import {
  heldCards,
  needsYouItemReady,
  normalizeReadyCondition,
  pausedCards,
  type ReadyConditionInput,
} from "../readiness.js";
import { extractReferences } from "../references.js";
import { remoteExitAction } from "../remote-worker-loss.js";
import { isRoleActive } from "../role.js";
import type { RoleRuleBasis } from "../role-rule.js";
import { storyProgress, storyTerminal } from "../story.js";
import type { StoryDiscussion } from "../story-discussion.js";
import type { ResumeCondition } from "../work-wait.js";
import {
  workerAgentToolsAction,
  workerHelperAction,
} from "../worker-helper-action.js";
import { requireCardDependencyStart } from "./card-dependencies.js";
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
  handoffIndependentReviewLimits,
  hasActivePmOps,
  isPmOps,
  mergeDelegationAuthority,
  mergeRequiresHuman,
  riskTagAutoMergeAllowed,
} from "./delegation.js";
import { resolveDeliveryRework } from "./delivery-rework.js";
import {
  buildHumanDecidedMergeBasis,
  humanDecidedMergeQuestions,
} from "./human-decided-merge.js";
import { independentReviewLimitItem } from "./independent-review-limit-delegation.js";
import { syncHumanDecidedMerges } from "./merge.js";
import {
  currentMergeConfirmations,
  humanMergeBlockers,
  pmFailedMergeCheck,
  pmMergeBlockers,
  pmMergeCheckFailureAuthority,
  pmSystemMergeReturnAuthority,
} from "./merge-delegation.js";
import { snoozeMergeConfirmation } from "./merge-snooze.js";
import { bindOwnerRecord, type OwnerRecordInput } from "./owner-record.js";
import { buildPlainSummary, samePlainSummary } from "./plain-summary.js";
import { authorPrecheckWait } from "./precheck-wait.js";
import {
  type ReviewAlignmentComment,
  recordReviewAlignment,
} from "./review-alignment.js";
import {
  isReviewLimitOption,
  resolveReviewLimit,
} from "./review-limit-resolution.js";
import {
  checkPlanSupersession,
  type ReviewPlanComment,
  recordReviewPlan,
} from "./review-strategy.js";
import { roleRuleMergeReason } from "./role-rule-implementation.js";
import { suggestSourceMergeUnrelated } from "./source-merge.js";
import { storyDiscussionChange } from "./story-discussion.js";
import {
  suggestionProgressEvents,
  suggestionProgressToken,
} from "./suggestion-progress.js";
import {
  systemMergeEnabled,
  systemMergeHumanReason,
} from "./system-merge-policy.js";
import { commandWithReadyVerifiers as command } from "./system-rules.js";
import {
  autoResumeUsed,
  baselineBlockerReason,
  pendingBaselineConflict,
  validateResumeCondition,
} from "./work-waits.js";

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
  ensure,
  text,
  unwrap,
} from "./core.js";
import { endRun } from "./end-run.js";
import {
  classifyOrdinaryHost,
  type LegacyHostResult,
  type OrdinaryHostBasis,
  verifyHostResult,
} from "./host-action-evidence.js";
import {
  completeActionDraft,
  humanOnlyAction,
} from "./human-action-completion.js";
import { resolveHumanCompletionReview } from "./human-completion.js";
import { requestMergeChanges } from "./merge.js";
import {
  failedConfirmedMergeCheck,
  failedCurrentMergeCheck,
  requeueMergeCheck,
} from "./merge-check.js";
import { queueResumedRun, resumeWork } from "./resumption.js";
import { recordDecisionResolution } from "./review-limit-resolution.js";
import { activeWork } from "./workflow.js";

export function issueInstruction(
  state: CommandState,
  actor: Actor,
  p: {
    card_id: CardId;
    work_item_id: WorkItemId;
    body: string;
    /** C-619: ask the verifier held by this pending review-limit decision. */
    decision_id?: DecisionId | undefined;
  },
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
    const question =
      p.decision_id === undefined
        ? undefined
        : decisionQuestion(d, item, d.get("decisions", p.decision_id));
    d.emit(
      "instruction_issued",
      card.id,
      {
        work_item_id: item.id,
        ...(question
          ? {
              decision_id: question.decision,
              decision_question: question.binding,
            }
          : {}),
      },
      {
        type: "instruction",
        body: p.body,
        work_item_id: item.id,
        ...(question ? { decision_id: question.decision } : {}),
        refs: extractReferences(p.body),
      },
    );
    return d.timeline[0];
  });
}
/** C-619: only the verifier held by this pending decision can be asked. */
function decisionQuestion(d: CommandDraft, item: WorkItem, q: Decision) {
  ensure(
    !!heldByReviewDecision(d.list("decisions"), item, q.id),
    "illegal_transition",
    `${item.id} 没有在等待 ${q.id}：只能向正在等待该审核拍板的审核项提问`,
  );
  const binding = decisionQuestionBinding(item, d.list("deliveries"));
  ensure(!!binding, "illegal_transition", `${item.id} 尚无负责的审核员`);
  return { decision: q.id, binding };
}
export function postComment(
  state: CommandState,
  actor: Actor,
  p: Pick<TimelineEntry, "card_id" | "body"> & {
    story_discussion?: StoryDiscussion;
    story_summary?: boolean;
    host_result_for?: HumanActionId;
    host_report_for?: HumanActionId;
    review_plan?: ReviewPlanComment;
    review_alignment?: ReviewAlignmentComment;
  } & Partial<
      Pick<
        TimelineEntry,
        "work_item_id" | "mentions" | "reply_to" | "refs" | "supersedes"
      >
    >,
  ports: CommandPorts,
) {
  return command(state, actor, "post_comment", ports, (d) => {
    const card = d.card(p.card_id);
    text(p.body, "body");
    ensure(
      !p.story_discussion ||
        !(
          p.story_summary ||
          p.host_report_for ||
          p.host_result_for ||
          p.review_plan ||
          p.review_alignment ||
          p.work_item_id ||
          p.supersedes
        ),
      "validation_failed",
      "需求讨论必须是单独的卡片评论",
    );
    const discussion =
      p.story_discussion && storyDiscussionChange(d, card, p.story_discussion);
    const body = discussion
      ? [p.body, ...discussion.lines].join("\n\n")
      : p.body;
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
      if (id === p.supersedes) {
        ensure(
          entry.author === d.author,
          "unauthorized",
          "Only the same author can supersede a comment",
        );
        ensure(
          !card.story?.question_groups?.some(
            (group) =>
              group.id === entry.id ||
              group.questions.some((q) => q.resolution?.entry_id === entry.id),
          ),
          "illegal_transition",
          "不能替换需求问题清单或已绑定的答复、默认记录；可回复原评论继续讨论",
        );
        checkPlanSupersession(d, entry, p.review_plan);
      }
    }
    if (p.host_report_for) {
      const action = d.get("human_actions", p.host_report_for);
      const a = d.assignment;
      const operator =
        a?.scope === "standing" &&
        isRoleActive(state.roles, a.role_id) &&
        ((a.role_id === "host_ops" && !a.external) ||
          (a.role_id === "pm" && a.standing_mode === "office" && a.external) ||
          (isPmOps(d) &&
            internalHostFollowup(action) &&
            action.host_assignment_id === a.id));
      ensure(
        !p.host_result_for &&
          action.card_id === p.card_id &&
          action.status === "open" &&
          action.triage === "host" &&
          (actor.kind === "human" || operator),
        "unauthorized",
        "仅实际执行者可回填同卡主机待办的最终结果；进度或代转述请用普通回帖",
      );
    }
    const resultFor = p.host_report_for ?? p.host_result_for;
    const refs = [
      ...new Map(
        [
          ...(p.refs ?? []),
          ...(resultFor
            ? [{ kind: "human_action" as const, id: resultFor }]
            : []),
          ...extractReferences(body),
        ].map((ref) => [JSON.stringify(ref), ref]),
      ).values(),
    ];
    d.emit(
      "comment_posted",
      p.card_id,
      {
        body,
        host_report_for: p.host_report_for ?? null,
      },
      {
        type: "comment",
        ...(p.host_report_for ? { human_action_id: p.host_report_for } : {}),
        body,
        refs,
        mentions: commentMentions(
          p.story_discussion?.action === "answer"
            ? `${p.body}\n${p.story_discussion.answer}`
            : p.body,
          p.mentions ?? [],
          state.employees ?? [],
          state.roles.map((role) => role.role_id),
        ),
        ...(p.work_item_id ? { work_item_id: p.work_item_id } : {}),
        ...(p.reply_to ? { reply_to: p.reply_to } : {}),
        ...(p.supersedes ? { supersedes: p.supersedes } : {}),
      },
    );
    if (discussion && d.timeline[0]) discussion.apply(d.timeline[0].id);
    if (p.story_summary) {
      ensure(
        d.assignment?.scope === "standing" &&
          d.assignment.role_id === "pm" &&
          d.assignment.standing_mode === "office",
        "unauthorized",
        "只有常驻 Office 可提交需求总结",
      );
      ensure(
        !card.hold && card.status !== "backlog",
        "illegal_transition",
        "需求卡尚未排期或已暂停",
      );
      requireCardDependencyStart(d, card);
      const progress = storyProgress(d.list("cards"), card);
      ensure(
        card.story &&
          !storyTerminal(card) &&
          progress.total > 0 &&
          progress.finished === progress.total,
        "illegal_transition",
        "需求卡的子卡尚未全部结束或需求卡已关闭",
      );
      const item = d
        .list("work_items")
        .find(
          (w) => w.card_id === card.id && w.template_key === "decomposition",
        );
      ensure(
        item && d.timeline[0],
        "invariant_violation",
        "缺少拆解项或总结记录",
      );
      if (item.status !== "delivered")
        d.put("work_items", d.move(item, "story_summary_submitted"));
      d.put("cards", {
        ...card,
        story: { ...card.story, summary_entry_id: d.timeline[0].id },
      });
      d.emit("story_summary_submitted", card.id, {
        entry_id: d.timeline[0].id,
      });
    }
    if (p.review_plan && d.timeline[0])
      recordReviewPlan(d, d.timeline[0], p.review_plan);
    if (p.review_alignment && d.timeline[0]) {
      ensure(
        !p.review_plan,
        "validation_failed",
        "review_alignment 与 review_plan 不能同时提交",
      );
      recordReviewAlignment(d, d.timeline[0], p.review_alignment);
    }
    if (p.host_result_for) {
      const action = d.get("human_actions", p.host_result_for);
      ensure(
        d.assignment?.scope === "standing" &&
          d.assignment.role_id === "host_ops" &&
          isRoleActive(state.roles, "host_ops") &&
          !d.assignment.external &&
          action.host_assignment_id === d.assignment.id &&
          action.card_id === p.card_id &&
          internalHostFollowup(action) &&
          needsYouItemReady(readinessOf(d), action),
        "unauthorized",
        "只能回填明确交给当前主机运维且已就绪的非阻塞待办",
      );
      completeActionDraft(d, { human_action_id: action.id, text: p.body });
    }
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
  decisionId: DecisionId,
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
    endRun(d, run, "blocked", summary, {
      reason: "blocking_decision",
      decision_id: decisionId,
    });
  }
}
export function reportBlocker(
  state: CommandState,
  actor: Actor,
  p: {
    work_item_id: WorkItemId;
    reason: string;
    needs: "role" | "human";
    resume_when?: ResumeCondition;
  },
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
    const conflict = pendingBaselineConflict(d, item);
    const registeredBase = d.assignment?.base_sha;
    const condition =
      p.resume_when ??
      (conflict &&
      registeredBase &&
      p.needs === "role" &&
      baselineBlockerReason(p.reason)
        ? { kind: "baseline_updated" as const, target_id: registeredBase }
        : undefined);
    if (condition) validateResumeCondition(d, item, condition);
    const latestConflict = latestPrecheckConflict(
      d.state.events,
      item,
      d.state.project_id,
    );
    const conflictWait =
      latestConflict &&
      (condition?.kind === "baseline_updated" ||
        (condition?.kind === "precheck_finished" &&
          condition.target_id === latestConflict.attempt_id));
    const authorWait = authorPrecheckWait(d, item, condition, p.needs);
    const disabled = conflictWait
      ? !conflict
      : authorWait
        ? authorWait.consumed
        : autoResumeUsed(d, item, condition);
    paused(d, item, "blocked");
    d.put("work_items", {
      ...d.work(item.id),
      reported_blocker: {
        reason: p.reason,
        needs: p.needs,
        reported_by: d.author,
        reported_at: d.now,
        ...(condition ? { resume_when: condition } : {}),
        ...(disabled ? { auto_resume_disabled: true } : {}),
      },
    });
    d.emit(
      "blocker_reported",
      item.card_id,
      {
        work_item_id: item.id,
        needs: p.needs,
        ...(condition ? { resume_when: { ...condition } } : {}),
        ...(disabled ? { auto_resume_disabled: true } : {}),
      },
      { type: "status_change", body: p.reason, work_item_id: item.id },
    );
    return {
      work_item_id: item.id,
      guidance: disabled
        ? "自动恢复后再次阻塞，请 PM 核查并人工恢复"
        : authorWait
          ? "请结束当前 Run。预检结束后系统按本次预检恢复；同一提交反复失败交 PM 核查。"
          : condition
            ? "系统将在解除条件满足且其它阻塞清除后自动恢复一次，请结束当前 Run 等待"
            : p.needs === "human"
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
  /** C-202: plain-language summary; required when `decider` is the human. */
  readonly plain_summary?: PlainSummary;
  /** C-304: explicit human-only reason; requires decider=human. */
  readonly human_required_reason?: string;
  /** C-212: defer when a human decision is shown in Needs You. */
  readonly ready_when?: ReadyConditionInput;
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
    if (p.human_required_reason !== undefined) {
      text(p.human_required_reason, "human_required_reason");
      ensure(
        p.decider === "human",
        "validation_failed",
        "强制交人理由只能用于 decider=human 的拍板",
      );
    }
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
      p.decider === "human" ||
        !highRiskCategories.includes(p.category) ||
        p.decider === "role:pm",
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
    // C-202: every decision raised for the human carries a plain summary.
    // A decision for PM that falls back to the human (no PM Ops able to take
    // it) is checked after routing below.
    const plainSummary =
      p.decider === "human" || p.plain_summary !== undefined
        ? buildPlainSummary(p.plain_summary)
        : undefined;
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
    const targets = cards.map((id) => d.card(id));
    const storyQuestion = p.card_id
      ? targets[0]?.story
      : targets.length > 0 && targets.every((c) => c.story);
    if (
      storyQuestion &&
      d.assignment?.scope === "standing" &&
      d.assignment.role_id === "pm" &&
      d.assignment.standing_mode === "office"
    ) {
      ensure(
        ["scope_change", "spending", "credential"].includes(p.category),
        "validation_failed",
        "需求卡仅为方向、范围、花钱或凭据分歧发起拍板；其它正式授权在对应工作卡或项目上办理，不得用问题清单代批",
      );
    }
    const readyWhen = p.ready_when
      ? readyCondition(
          d,
          p.ready_when,
          {
            held: cards,
            paused: pausedCards(readinessOf(d), {
              blocking: p.blocking,
              affected_work_items: items.map((w) => w.id),
            }),
          },
          false,
        )
      : undefined;
    ensure(
      !readyWhen || p.decider === "human",
      "validation_failed",
      "只有交给人的拍板可以带就绪条件",
    );
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
    const id = d.ids.next(state.project_id, "decision");
    if (p.blocking) {
      for (const item of items) paused(d, item, "waiting_decision");
      endForDecision(d, id, p.question, items);
    }
    const base = {
      ...(d.assignment?.scope === "work_item"
        ? { pm_triage: true as const }
        : {}),
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
                affected_work_items: items.map((w) => w.id),
                ...(p.kind === "approve" && p.target
                  ? { target: p.target }
                  : {}),
              },
              p.suggestion,
            ),
          }
        : {}),
      ...(plainSummary ? { plain_summary: plainSummary } : {}),
      ...(d.assignment?.scope === "standing" &&
      d.assignment.role_id === "pm" &&
      p.card_id &&
      p.decider === "human"
        ? { handoff_group: `${p.card_id}/${p.category}` }
        : {}),
      ...(p.human_required_reason !== undefined
        ? { human_required_reason: p.human_required_reason.trim() }
        : {}),
      ...(readyWhen ? { ready_when: readyWhen } : {}),
      blocking: p.blocking,
      decider:
        d.assignment?.scope === "work_item" ? ("role:pm" as const) : p.decider,
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
    ensure(
      decision.decider !== "human" || !!plainSummary,
      "validation_failed",
      "现在没有能代为处理的后台项目经理，这条拍板会直接交给人，所以必须带人话概述（plain_summary）：请用白话写清“改了什么”“对你的影响”“风险”三项（没有风险就写“无”）",
    );
    d.put("decisions", decision);
    const routing =
      decision.pm_triage || decision.delegation_authority
        ? {
            routed_to: decision.decider,
            routing_reason:
              decision.delegation_authority ??
              "先由 PM 分拣；处理仍须符合当前类别授权",
          }
        : {};
    for (const card of cards.length ? cards : [undefined])
      d.emit(
        "decision_requested",
        card,
        {
          decision_id: id,
          affected_work_items: decision.affected_work_items,
          ...routing,
        },
        {
          type: "decision_request",
          body: decision.pm_triage
            ? `${p.question}\n已进入 PM 待办，尚未授权处理或交人`
            : decision.delegation_authority
              ? `${p.question}\n已按常驻授权转给 PM`
              : p.question,
          decision_id: id,
        },
      );
    // §7.4 (C-167): a merge-related D12 or scope question makes the merge
    // confirmations of its own cards human-only, and that sticks: the handoff
    // writes human_required_reason, so no timeout auto-merge. Other cards'
    // confirmations and merge-unrelated questions leave them untouched.
    if (
      !mergeUnrelated &&
      highRiskCategories.includes(p.category) &&
      !categoryDelegated(
        d.list("project_preferences").find((p) => p.id === d.state.project_id),
        [...d.state.events, ...d.events],
        p.category,
      )
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
      syncHumanDecidedMerges(d);
    }
    handoffIndependentReviewLimits(d, cards);
    return { ...decision, ...routing };
  });
}
const pendingDecision = (q: Decision) =>
  ["open", "provisional", "snoozed"].includes(q.status);
/** A merge confirmation the system still holds; PM may only hold or return it. */
const systemHeldMerge = (q: Decision) =>
  q.trigger === "merge_confirmation" &&
  q.decider === "system" &&
  pendingDecision(q);
/**
 * C-591: PM Ops or PM Office holds or returns a merge confirmation the system
 * holds, with a reason and the basis it relies on (e.g. the human's answer or
 * a review). Returning has the same effect as the human's request-changes;
 * only the system or the human can confirm the merge itself.
 */
function pmHandleSystemMerge(
  d: CommandDraft,
  q: Decision,
  p: {
    option: string;
    rationale: string;
    basis: string | undefined;
    raw_quote: string;
    snooze_until?: string;
  },
) {
  ensure(
    p.option === "hold" || p.option === "request_changes",
    "unauthorized",
    "系统处理的合并确认只能由系统或人确认合并；PM 只能暂缓（hold）或退回修改（request_changes）",
  );
  ensure(
    q.options.some((o) => o.key === p.option),
    "validation_failed",
    "Option is not part of this decision",
  );
  // A human-only reason (sensitive card, policy change, ...) that the system
  // has not handed over yet still keeps PM out, as before.
  const card = q.card_id ? d.card(q.card_id) : undefined;
  const humanReason =
    !card || !systemMergeEnabled(d.state, card)
      ? "自动合并授权已关闭，须由人处理。"
      : (systemMergeHumanReason(d.state, q) ??
        (mergeRequiresHuman(d.state, q)
          ? "此合并确认须由人处理。"
          : undefined));
  ensure(
    !humanReason,
    "unauthorized",
    `${humanReason ?? ""}PM 不能暂缓或退回，请交人在 Workbench 或本机 CLI 处理`,
  );
  text(p.rationale, "rationale");
  ensure(
    typeof p.basis === "string" && p.basis.trim().length > 0,
    "validation_failed",
    "暂缓或退回系统处理的合并确认须写明依据（例如人的拍板或审核结论）",
  );
  ensure(
    p.snooze_until === undefined || p.option === "hold",
    "validation_failed",
    "snooze_until 只能用于暂缓合并确认",
  );
  const proxy_authority = pmSystemMergeReturnAuthority(d.state.project_id);
  const notice = `${p.rationale.trim()}\n依据：${p.basis.trim()}`;
  return resolveDecisionDraft(
    d,
    q,
    {
      option: p.option,
      rationale: p.rationale,
      raw_quote: p.raw_quote,
      notice,
      proxy_authority,
      ...(p.snooze_until !== undefined ? { snooze_until: p.snooze_until } : {}),
      ...(p.option === "hold"
        ? { delegated_merge: { notice, proxy_authority } }
        : {}),
    },
    true,
  );
}

export function recordDecision(
  state: CommandState,
  actor: Actor,
  input: {
    decision_id: DecisionId;
    option: string;
    rationale: string;
    snooze_until?: string;
    pause_plan?: ReviewPauseInput;
    raw_quote: string;
    via_chain?: readonly Author[];
    batch?: string;
    delegate_future?: boolean;
    /** Q-440: explicit human override; blank reasons and Agent actors are rejected. */
    merge_override_reason?: string;
    /** C-192: the human clicked "按建议处理"; never accepted from Agents. */
    via_suggestion?: boolean;
    suggestion_progress_token?: string;
    suggestion_version?: number;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "record_decision", ports, (d) => {
    const held = d.get("decisions", input.decision_id);
    let p = input;
    if (p.merge_override_reason !== undefined) {
      ensure(
        actor.kind === "human",
        "forbidden_tool",
        "强行确认合并只能由人亲自操作，Agent 和 PM 不能代办",
      );
      ensure(
        held.trigger === "merge_confirmation" &&
          p.option === "merge" &&
          !p.via_suggestion,
        "validation_failed",
        "强行确认只能用于单独确认合并",
      );
      text(p.merge_override_reason, "强行合并理由");
      const reasonError = mergeOverrideReasonError(p.merge_override_reason);
      ensure(!reasonError, "validation_failed", reasonError ?? "");
      ensure(
        !!held.card_id &&
          currentMergeConfirmations(state, held.card_id).some(
            (q) => q.id === held.id,
          ),
        "stale_target",
        "合并确认已过期，不能强行确认旧的完成申请",
      );
    }
    let mergeOverride:
      | { reason: string; blockers: readonly string[] }
      | undefined;
    if (p.via_suggestion) {
      ensure(
        actor.kind === "human",
        "forbidden_tool",
        "按建议处理只能由人亲自操作，Agent 不能代人提交",
      );
      // A confirmed merge whose check then failed can still be returned on
      // a suggestion (P2a-1 §2.6); returnConfirmedMerge checks the failure.
      ensure(
        held.suggestion &&
          (["open", "provisional", "snoozed"].includes(held.status) ||
            (held.status === "resolved" &&
              held.trigger === "merge_confirmation" &&
              held.resolution?.option === "merge" &&
              p.option === "request_changes")),
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
      ensure(
        p.suggestion_version === (held.suggestion.version ?? 0),
        "stale_target",
        "建议已更新，请刷新并查看当前建议后再按建议处理",
      );
      ensure(
        p.suggestion_progress_token === undefined
          ? !suggestionProgressEvents(state, held).length
          : p.suggestion_progress_token ===
              suggestionProgressToken(state, held),
        "stale_target",
        "建议生成后有新进展，请刷新并确认已查看后再按建议处理",
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
      (held.decider === "role:pm" || held.decider === "system") &&
      (held.decider === "role:pm" || held.trigger === "merge_confirmation") &&
      ["open", "provisional", "snoozed"].includes(held.status);
    const decision: Decision = takenOver
      ? {
          ...held,
          decider: "human",
          ...(independentReviewLimitItem(d, held)
            ? {
                human_required_reason:
                  held.human_required_reason ??
                  "独立复核加轮已由人接手，后续处理须由人亲自确认",
              }
            : {}),
        }
      : held;
    // C-79: a confirmed merge handed back after failure may still retain
    // role:pm as its historical decider. Preserve that authorization record.
    const returningConfirmed =
      decision.trigger === "merge_confirmation" &&
      decision.status === "resolved" &&
      decision.resolution?.option === "merge" &&
      p.option === "request_changes";
    // C-591: PM Office may also hold or return a system-held merge
    // confirmation, citing the quoted basis; it can never confirm the merge.
    if (
      actor.kind === "assignment" &&
      actor.role_id === "pm" &&
      d.assignment?.scope === "standing" &&
      d.assignment.standing_mode !== "ops" &&
      actor.allowed_tools.includes("record_decision") &&
      systemHeldMerge(held)
    ) {
      ensure(
        p.pause_plan === undefined && !p.delegate_future,
        "validation_failed",
        "系统处理的合并确认，PM 只能暂缓（hold）或退回修改（request_changes）",
      );
      if (held.card_id) d.card(held.card_id);
      text(p.raw_quote, "raw_quote");
      return pmHandleSystemMerge(d, held, {
        option: p.option,
        rationale: p.rationale,
        basis: p.raw_quote,
        raw_quote: p.raw_quote,
        ...(p.snooze_until !== undefined
          ? { snooze_until: p.snooze_until }
          : {}),
      });
    }
    ensure(
      (actor.kind === "human" &&
        (decision.decider === "human" || returningConfirmed)) ||
        (actor.kind === "assignment" &&
          actor.role_id === "pm" &&
          d.assignment?.scope === "standing" &&
          d.assignment.standing_mode !== "ops" &&
          decision.decider !== "role:pm" &&
          decision.decider !== "system" &&
          !highRiskCategories.includes(decision.category ?? "general") &&
          actor.allowed_tools.includes("record_decision")),
      "forbidden_tool",
      actor.kind === "assignment" && decision.decider === "role:pm"
        ? "这条拍板路由给 PM Ops，PM Office 不能代记；所有者已在卡上答复时，由 PM Ops 在授权范围内自行决定并引用原话作依据（resolve_delegated_decision 的 owner_record）"
        : "Only PM Office or the designated human can record decisions",
    );
    // §7.4: a sensitive or PM-escalated merge needs a human Actor; PM Office
    // transcription would record resolved_by=human without one.
    ensure(
      actor.kind === "human" ||
        (!mergeRequiresHuman(state, decision) &&
          (decision.trigger !== "merge_confirmation" ||
            !humanDecidedMergeQuestions(state, decision.card_id).length) &&
          !(
            decision.trigger === "merge_confirmation" &&
            state.cards.find((c) => c.id === decision.card_id)?.risk_tags
              ?.length &&
            !riskTagAutoMergeAllowed(state, decision)
          )),
      "forbidden_tool",
      "此合并确认须由人在 Workbench 或本机 CLI 确认，PM 不能代记",
    );
    // C-104: a human-required decision (e.g. a template's human completion
    // review) also needs a human Actor; PM Office may not transcribe it.
    ensure(
      actor.kind === "human" ||
        !decision.human_required_reason ||
        (!decision.trigger &&
          !highRiskCategories.includes(decision.category ?? "general")),
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
    if (decision.trigger === "merge_confirmation" && p.option === "merge") {
      const blockers = humanMergeBlockers(d.state, decision);
      if (p.merge_override_reason !== undefined)
        mergeOverride = { reason: p.merge_override_reason.trim(), blockers };
      else
        ensure(
          blockers.length === 0,
          "illegal_transition",
          `等待中：\n${blockers.join("\n")}`,
          { merge_blockers: blockers },
        );
    }
    if (p.delegate_future) grantDecisionCategory(d, decision);
    if (returningConfirmed) {
      ensure(
        actor.kind === "human",
        "forbidden_tool",
        "只有人可以退回已确认的合并",
      );
      return returnConfirmedMerge(
        d,
        decision,
        p.rationale,
        p.raw_quote,
        undefined,
        !!p.via_suggestion,
      );
    }
    return resolveDecisionDraft(
      d,
      decision,
      {
        ...p,
        ...(takenOver
          ? { taken_over_from: held.decider as "role:pm" | "system" }
          : {}),
        ...(mergeOverride ? { merge_override: mergeOverride } : {}),
      },
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
  viaSuggestion = false,
) {
  ensure(
    failedConfirmedMergeCheck(d.state, decision),
    "illegal_transition",
    "已确认的合并只有在当前完成申请的最新检查失败或超时时才能退回修改；检查通过、排队或运行中均不能退回。",
  );
  requestMergeChanges(d, decision, reason, raw_quote, delegated, viaSuggestion);
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
    pause_plan?: ReviewPauseInput;
    raw_quote: string;
    via_chain?: readonly Author[];
    batch?: string;
    notice?: string;
    taken_over_from?: "role:pm" | "system";
    merge_override?: { reason: string; blockers: readonly string[] };
    via_suggestion?: boolean;
    human_decided_merge_basis?: HumanDecidedMergeBasis;
    /** C-591: delegated authority other than the PM merge preference. */
    proxy_authority?: string;
    /** C-617: validated owner answer cited as evidence; never the formal answer. */
    owner_record?: import("../entities.js").OwnerEvidence;
    delegated_merge?: {
      readonly notice: string;
      readonly proxy_authority: string;
    };
  },
  delegated: boolean,
) {
  ensure(
    p.snooze_until === undefined ||
      (decision.trigger === "merge_confirmation" && p.option === "hold"),
    "validation_failed",
    "snooze_until 只能用于暂缓合并确认",
  );
  if (
    decision.trigger === "merge_confirmation" &&
    p.option === "merge" &&
    decision.card_id
  )
    ensure(
      !d.card(decision.card_id).hold,
      "illegal_transition",
      "卡片已暂停，请先解除暂停",
    );
  if (decision.trigger === "merge_confirmation" && p.option === "hold")
    return snoozeMergeConfirmation(d, decision, {
      ...p,
      ...(p.delegated_merge ? { delegated: p.delegated_merge } : {}),
    });
  const actor = d.actor;
  const result = recordDecisionResolution(
    d,
    decision,
    {
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
              p.proxy_authority ??
              (decision.trigger === "merge_confirmation"
                ? mergeDelegationAuthority(d)
                : delegationAuthority(d, decision.category ?? "general")),
          }
        : {}),
      ...(delegated &&
      decision.category &&
      highRiskCategories.includes(decision.category)
        ? {
            notice: `PM 依常驻授权代拍；授权依据：${delegationAuthority(d, decision.category)}\n${p.notice?.trim() || p.rationale}`,
          }
        : delegated && p.notice?.trim()
          ? { notice: p.notice.trim() }
          : {}),
      ...(p.taken_over_from ? { taken_over_from: p.taken_over_from } : {}),
      ...(p.merge_override ? { merge_override: p.merge_override } : {}),
      ...(p.via_suggestion && !delegated
        ? { via_suggestion: true as const }
        : {}),
      ...(p.human_decided_merge_basis
        ? { human_decided_merge_basis: p.human_decided_merge_basis }
        : {}),
      ...(p.owner_record ? { owner_record: p.owner_record } : {}),
      raw_quote: p.raw_quote,
      via_chain: [...(p.via_chain ?? []), d.author],
      ...(p.batch ? { batch: p.batch } : {}),
      at: d.now,
    },
    p.pause_plan,
  );
  if (
    decision.trigger === "merge_confirmation" &&
    p.option === "request_changes"
  )
    requestMergeChanges(
      d,
      decision,
      p.rationale,
      p.raw_quote,
      undefined,
      !!p.via_suggestion && !delegated,
    );
  if (decision.trigger === "accepted_delivery_rework")
    resolveDeliveryRework(d, decision, p.option);
  if (decision.trigger === "completion_review")
    resolveHumanCompletionReview(d, decision, p.option);
  if (
    decision.category === "scope_change" ||
    decision.category === "permission"
  )
    syncHumanDecidedMerges(d);
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
    pause_plan?: ReviewPauseInput;
    escalate?: boolean;
    role_rule_basis?: RoleRuleBasis;
    decision_evidence?: readonly MergeDecisionEvidence[];
    source_unrelated?: { decision_id: DecisionId; rationale: string };
    /** Needs You notice; required when PM Ops confirms a merge (§7.4). */
    notice?: string;
    /** C-95: card attachments to show the human; only with `escalate`. */
    attachment_ids?: readonly AttachmentId[];
    /** C-192: suggestion shown to the human; only with `escalate`. */
    suggestion?: DecisionSuggestionInput;
    /**
     * C-202: plain summary for the human; only with `escalate`. Required when
     * the decision has none yet, otherwise an audited rewrite.
     */
    plain_summary?: PlainSummary;
    /**
     * C-617: the owner's answer already on the card. Requires the same
     * authorization as a PM decision; it never adds authority.
     */
    owner_record?: OwnerRecordInput;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "resolve_delegated_decision", ports, (d) => {
    ensure(
      isPmOps(d),
      "forbidden_tool",
      "Only standing PM Ops can decide under project authorization",
    );
    let q = d.get("decisions", p.decision_id);
    if (p.owner_record !== undefined)
      ensure(
        !p.escalate &&
          p.source_unrelated === undefined &&
          p.role_rule_basis === undefined &&
          p.decision_evidence === undefined &&
          p.pause_plan === undefined &&
          p.snooze_until === undefined &&
          p.notice === undefined &&
          p.attachment_ids === undefined &&
          p.suggestion === undefined &&
          p.plain_summary === undefined &&
          !q.trigger,
        "validation_failed",
        "关联所有者原话只用于结案普通拍板，不能与交人、合并、暂停或其它依据一起提交",
      );
    if (p.owner_record !== undefined)
      ensure(
        ["open", "provisional"].includes(q.status) && !q.superseded_by,
        "stale_target",
        "拍板已结案或已被替换，不能重复结案",
      );
    if (p.source_unrelated !== undefined) {
      ensure(
        p.escalate === true &&
          p.option === "merge" &&
          p.suggestion === undefined &&
          p.role_rule_basis === undefined &&
          p.decision_evidence === undefined &&
          p.plain_summary === undefined &&
          p.attachment_ids === undefined &&
          p.snooze_until === undefined &&
          p.notice === undefined,
        "validation_failed",
        "来源无关建议须单独提交，不得混入合并批准或其它授权",
      );
      return suggestSourceMergeUnrelated(d, q, p.source_unrelated);
    }
    if (systemHeldMerge(q)) {
      ensure(
        !p.escalate &&
          p.role_rule_basis === undefined &&
          p.decision_evidence === undefined &&
          p.pause_plan === undefined &&
          p.attachment_ids === undefined &&
          p.suggestion === undefined &&
          p.plain_summary === undefined,
        "validation_failed",
        "系统处理的合并确认，PM 只能暂缓（hold）或退回修改（request_changes），并写明理由和依据（notice）",
      );
      return pmHandleSystemMerge(d, q, {
        option: p.option,
        rationale: p.rationale,
        basis: p.notice,
        raw_quote: p.rationale,
        ...(p.snooze_until !== undefined
          ? { snooze_until: p.snooze_until }
          : {}),
      });
    }
    if (p.role_rule_basis !== undefined) {
      ensure(
        q.trigger === "merge_confirmation" &&
          q.status === "open" &&
          !q.human_required_reason &&
          p.option === "merge" &&
          !p.escalate,
        "unauthorized",
        "只能给当前未强制交人的合并确认补角色依据",
      );
      const candidate = {
        ...q,
        role_rule_basis: p.role_rule_basis,
        decider: "role:pm" as const,
      };
      ensure(
        !roleRuleMergeReason(state, candidate) &&
          delegationAllowed(d, candidate),
        "unauthorized",
        "角色正文依据不完整、失效或属于禁止类别，须交人确认",
      );
      ensure(
        hasActivePmOps(d, "resolve_delegated_decision"),
        "unauthorized",
        "没有活跃 PM Ops",
      );
      q = { ...candidate, delegation_authority: mergeDelegationAuthority(d) };
      d.put("decisions", q);
    }
    ensure(
      p.decision_evidence === undefined ||
        (q.trigger === "merge_confirmation" &&
          p.option === "merge" &&
          !p.escalate),
      "validation_failed",
      "拍板对应依据只能用于 PM 确认合并",
    );
    let basis: HumanDecidedMergeBasis | undefined;
    // C-303: an Ops refresh on a human-held, still pending decision is a
    // suggestion-only write. It cannot resolve, hand off or rewrite authority.
    if (
      q.decider === "human" &&
      p.escalate &&
      p.suggestion &&
      ["open", "provisional", "snoozed"].includes(q.status)
    ) {
      text(p.rationale, "rationale");
      ensure(
        p.plain_summary === undefined &&
          p.attachment_ids === undefined &&
          p.snooze_until === undefined &&
          p.notice === undefined,
        "validation_failed",
        "刷新建议只接受建议内容和复核理由",
      );
      const suggestion = buildSuggestion(d, q, p.suggestion);
      const updated = { ...q, suggestion, recommended: suggestion.option };
      d.put("decisions", updated);
      d.emit(
        "decision_suggestion_updated",
        q.card_id,
        { decision_id: q.id },
        {
          type: "system",
          decision_id: q.id,
          body: `${q.id} 的建议已复核更新，新进展基线已刷新。`,
        },
      );
      return updated;
    }
    // P2a-1 §2.6: a failed or timed-out check may also be handled on a
    // confirmed merge, whoever confirmed it; D12/scope cards stay human.
    ensure(
      !q.card_id ||
        !flowAtLeast(d.card(q.card_id), 2) ||
        !failedCurrentMergeCheck(state, q),
      "unauthorized",
      "新版卡的失败检查由系统退回，不再由 PM 代处理",
    );
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
          (delegationAllowed(d, q) ||
            // A legacy/stale PM-held confirmation must still have a safe
            // escape to the human after its merge eligibility is lost.
            ((q.trigger === "merge_confirmation" || !q.trigger) &&
              p.escalate === true))),
      "unauthorized",
      q.trigger === "merge_confirmation" && mergeRequiresHuman(state, q)
        ? "此合并确认须由人处理，PM 只能重新检查明确的超时失败，不能退回或代确认合并"
        : p.owner_record
          ? "这条拍板未授权 PM 处理；所有者原话不构成新的授权，请交给人（escalate）"
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
    ensure(
      p.plain_summary === undefined || !!p.escalate,
      "validation_failed",
      "plain_summary 只能在交给人（escalate）时提供",
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
      // C-202: the human always gets a plain summary on escalation: the one
      // already on the decision (e.g. from the completion request) or the
      // PM's own; a PM rewrite is recorded in the handoff event.
      ensure(
        p.plain_summary !== undefined || !!q.plain_summary,
        "validation_failed",
        "交给人时必须带人话概述（plain_summary）：这条拍板还没有，请用白话写清“改了什么”“对你的影响”“风险”三项（没有风险就写“无”）",
      );
      const plainSummary =
        p.plain_summary !== undefined
          ? buildPlainSummary(p.plain_summary)
          : q.plain_summary;
      const rewritten =
        p.plain_summary !== undefined &&
        !samePlainSummary(plainSummary, q.plain_summary);
      const handoffGroup =
        !q.trigger && q.card_id && q.category
          ? `${q.card_id}/${q.category}`
          : undefined;
      handoffDecision(
        d,
        {
          ...q,
          ...(handoffGroup ? { handoff_group: handoffGroup } : {}),
          ...(attachment_ids.length ? { attachment_ids } : {}),
          ...(suggestion ? { suggestion, recommended: suggestion.option } : {}),
          ...(plainSummary ? { plain_summary: plainSummary } : {}),
        },
        `项目经理升级给你：${p.rationale}`,
        undefined,
        q.trigger === "merge_confirmation" ||
          !!independentReviewLimitItem(d, q),
        rewritten ? { previous: q.plain_summary ?? null } : undefined,
      );
      // The PM escalates the category together; answers still bind one original question.
      if (handoffGroup)
        for (const sibling of d.list("decisions")) {
          if (
            sibling.id === q.id ||
            sibling.trigger ||
            !sibling.pm_triage ||
            sibling.card_id !== q.card_id ||
            sibling.category !== q.category ||
            sibling.decider !== "role:pm" ||
            !["open", "provisional"].includes(sibling.status)
          )
            continue;
          handoffDecision(
            d,
            { ...sibling, handoff_group: handoffGroup },
            `项目经理合并同卡同类事项交给你：${p.rationale}`,
          );
        }
      return d.get("decisions", q.id);
    }
    if (q.trigger === "merge_confirmation" && p.option === "merge") {
      if (p.decision_evidence?.length)
        basis = buildHumanDecidedMergeBasis(state, q, p.decision_evidence);
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
        isReviewLimitOption(p.option),
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
        ...(p.pause_plan ? { pause_plan: p.pause_plan } : {}),
      });
      return d.get("decisions", q.id);
    }
    ensure(
      q.options.some((o) => o.key === p.option),
      "validation_failed",
      "Option is not part of this decision",
    );
    const { owner_record: ownerInput, ...input } = p;
    const ownerRecord =
      ownerInput && bindOwnerRecord(d, q, p.option, ownerInput);
    return resolveDecisionDraft(
      d,
      q,
      {
        ...input,
        raw_quote: p.rationale,
        ...(basis ? { human_decided_merge_basis: basis } : {}),
        ...(ownerRecord ? { owner_record: ownerRecord } : {}),
      },
      true,
    );
  });
}

/** C-212: validate a requested readiness condition against the draft. */
function readyCondition(
  d: CommandDraft,
  input: ReadyConditionInput,
  owner: { held: readonly CardId[]; paused: readonly CardId[] },
  allowManual: boolean,
) {
  const result = normalizeReadyCondition(
    readinessOf(d),
    input,
    owner,
    allowManual,
  );
  ensure(typeof result !== "string", "validation_failed", String(result));
  return result as Exclude<typeof result, string>;
}
const readinessOf = (d: CommandDraft) => ({
  cards: d.list("cards"),
  deliveries: d.list("deliveries"),
  work_items: d.list("work_items"),
});
function validateTerminal(terminal: HumanAction["terminal"]) {
  if (!terminal) return;
  for (const key of [
    "target",
    "login",
    "command",
    "expected_output",
    "on_failure",
  ] as const)
    text(terminal[key], key);
}
export function requestHumanAction(
  state: CommandState,
  actor: Actor,
  p: Pick<
    HumanAction,
    | "instructions"
    | "why_human"
    | "expected_return"
    | "blocked_work_items"
    | "terminal"
  > & {
    card_id: CardId;
    due?: string;
    category?: HumanAction["category"];
    blocks_merge?: boolean;
    prerequisite?: HumanAction["prerequisite"];
    /** C-212: defer when the action is shown in Needs You. */
    ready_when?: ReadyConditionInput;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "request_human_action", ports, (d) => {
    ensure(
      d.card(p.card_id).status !== "cancelled",
      "illegal_transition",
      "不能为已取消卡片创建待办",
    );
    text(p.instructions, "instructions");
    text(p.why_human, "why_human");
    text(p.expected_return, "expected_return");
    validateTerminal(p.terminal);
    const items = [...new Set(p.blocked_work_items)].map((id) => d.work(id));
    ensure(
      items.every((w) => w.card_id === p.card_id),
      "validation_failed",
      "Human action items must belong to its card",
    );
    ensure(
      p.prerequisite === undefined ||
        ["credential", "external_account"].includes(p.prerequisite),
      "validation_failed",
      "Unknown human action prerequisite",
    );
    ensure(
      !p.blocks_merge || !!p.prerequisite,
      "validation_failed",
      "只有凭据或外部账号前置操作可以阻塞合并",
    );
    ensure(
      p.category === undefined || decisionCategories.includes(p.category),
      "validation_failed",
      "Unknown human action category",
    );
    const blocks = p.blocks_merge === true && !!p.prerequisite;
    const triage = hasActivePmOps(d, "triage_human_action")
      ? "pm_ops"
      : "human";
    const condition =
      p.ready_when ??
      (!blocks && items.length
        ? { kind: "card_merged" as const, card_id: p.card_id }
        : undefined);
    const readyWhen = condition
      ? readyCondition(
          d,
          condition,
          {
            held: blocks ? [p.card_id] : [],
            paused: blocks && items.length ? [p.card_id] : [],
          },
          // Only PM Ops can release a manual condition.
          triage === "pm_ops",
        )
      : undefined;
    if (blocks) for (const item of items) paused(d, item, "blocked");
    const id = d.ids.next(state.project_id, "human_action");
    const action: HumanAction = {
      id,
      key: id,
      card_id: p.card_id,
      requested_by: d.author,
      ...(p.terminal ? { terminal: p.terminal } : {}),
      ...(p.category ? { category: p.category } : {}),
      instructions: p.instructions,
      why_human: p.why_human,
      expected_return: p.expected_return,
      blocked_work_items: blocks ? items.map((w) => w.id) : [],
      ...(!blocks && items.length
        ? { follow_up_work_items: items.map((w) => w.id) }
        : {}),
      ...(p.prerequisite ? { prerequisite: p.prerequisite } : {}),
      status: "open",
      triage,
      ...(readyWhen ? { ready_when: readyWhen } : {}),
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
        ...(action.category ? { category: action.category } : {}),
        ...(action.blocks_merge
          ? { blocks_merge: true, prerequisite: action.prerequisite }
          : {}),
      },
      { type: "human_action", body: p.instructions, human_action_id: id },
    );
    return action;
  });
}
// Execution fences and human prerequisites must never be closed with a comment.
function reportableHostAction(action: HumanAction) {
  return (
    action.requested_by !== "system" &&
    !!action.card_id &&
    !action.blocks_merge &&
    !action.prerequisite &&
    action.blocked_work_items.length === 0
  );
}
function internalHostFollowup(action: HumanAction) {
  return (
    action.triage === "host" &&
    action.host_operator === "host_ops" &&
    action.host_diagnostic === true &&
    reportableHostAction(action)
  );
}
function internalHostOwner(d: CommandDraft, role: "host_ops" | "pm") {
  if (!isRoleActive(d.state.roles, role)) return;
  return d
    .list("assignments")
    .find(
      (a) =>
        a.scope === "standing" &&
        !a.external &&
        a.status === "active" &&
        a.role_id === role &&
        (role === "host_ops" || a.standing_mode === "ops") &&
        d.state.roles.some(
          (r) =>
            r.role_id === role &&
            r.role_version === a.role_version &&
            r.allowed_tools.includes(
              role === "pm" ? "triage_human_action" : "post_comment",
            ),
        ),
    );
}

/** The owner must still be an authorized external Office identity. */
function externalHostOwner(d: CommandDraft, id: AssignmentId): Assignment {
  const owner = d.get("assignments", id);
  ensure(
    owner.status === "active" &&
      owner.scope === "standing" &&
      owner.role_id === "pm" &&
      owner.standing_mode === "office" &&
      owner.external === true &&
      isRoleActive(d.state.roles, owner.role_id) &&
      d.state.roles.some(
        (r) =>
          r.role_id === owner.role_id &&
          r.role_version === owner.role_version &&
          r.allowed_tools.includes("complete_host_action"),
      ),
    "unauthorized",
    "负责人必须是有完成许可的有效外接 PM Office 身份",
  );
  return owner;
}
/** Human and narrowly scoped external Office completion share one transaction. */
export function completeHumanAction(
  state: CommandState,
  actor: Actor,
  p: {
    human_action_id: HumanActionId;
    conclusion?: "exited" | "false_alarm" | "unconfirmed";
    text: string;
    attachments?: readonly string[];
  },
  ports: CommandPorts,
) {
  return command(
    state,
    actor,
    actor.kind === "human" ? "request_human_action" : "complete_host_action",
    ports,
    (d) => {
      if (actor.kind !== "human") {
        const action = d.get("human_actions", p.human_action_id);
        ensure(
          actor.kind === "assignment" &&
            action.triage === "host" &&
            action.host_operator === "external" &&
            action.host_assignment_id === actor.assignment_id,
          "unauthorized",
          "只能完成明确指派给当前身份的外接主机待办",
        );
        externalHostOwner(d, actor.assignment_id);
      }
      return completeActionDraft(d, p);
    },
  );
}
export function triageHumanAction(
  state: CommandState,
  actor: Actor,
  p: {
    human_action_id: HumanActionId;
    disposition: "done" | "host" | "human" | "release";
    terminal?: NonNullable<HumanAction["terminal"]>;
    rationale: string;
    ordinary_host_basis?: OrdinaryHostBasis;
    legacy_host_result?: LegacyHostResult;
    title?: string;
    /** C-212: one plain line saying what the reader has to do. */
    todo?: string;
    /** C-212: with host only; absent means host_ops. */
    host_operator?: "external" | "host_ops";
    /** Opt in to internal read-only diagnosis, not general host work. */
    host_diagnostic?: true;
    host_assignment_id?: AssignmentId;
    /** C-212: replaces the action's readiness condition when rewriting. */
    ready_when?: ReadyConditionInput;
    /** Explicitly retain a prerequisite or reclassify it as a post-merge follow-up. */
    blocks_merge?: boolean;
    prerequisite?: HumanAction["prerequisite"];
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
      (isPmOps(d) && isRoleActive(state.roles, "pm")) || actor.kind === "human",
      "forbidden_tool",
      "Only the human or PM Ops can triage human actions",
    );
    let action = d.get("human_actions", p.human_action_id);
    if (action.card_id)
      ensure(
        d.card(action.card_id).status !== "cancelled",
        "illegal_transition",
        "已取消卡片的待办不能改写",
      );
    ensure(
      action.status === "open",
      "illegal_transition",
      "Only an open human action can be triaged",
    );
    ensure(
      !remoteExitAction(state, action.id) ||
        (actor.kind === "human" && p.disposition === "human"),
      "unauthorized",
      "Remote exit confirmation cannot be delegated",
    );
    text(p.rationale, "rationale");
    ensure(
      !p.legacy_host_result ||
        (isPmOps(d) && p.disposition === "done" && action.triage === "host"),
      "validation_failed",
      "只有后台项目经理核销主机待办时可以核验旧回填",
    );
    if (p.ordinary_host_basis !== undefined) {
      ensure(
        p.disposition === "host" ||
          (p.disposition === "done" && action.triage === "host"),
        "validation_failed",
        "仅在主机交接或结项时核定原始请求",
      );
      action = classifyOrdinaryHost(d, action, p.ordinary_host_basis);
    }
    const external = p.disposition === "host" && p.host_operator === "external";
    ensure(
      external || p.host_assignment_id === undefined,
      "validation_failed",
      "host_assignment_id 只能用于 host/external 交接",
    );
    ensure(
      p.host_diagnostic === undefined ||
        (p.host_diagnostic === true &&
          p.disposition === "host" &&
          !external &&
          reportableHostAction(action)),
      "validation_failed",
      "只有非阻塞的内部卡片诊断可以由运维回填结项",
    );
    ensure(
      !p.host_diagnostic ||
        actor.kind === "human" ||
        action.triage === "host" ||
        action.triage === "pm_ops",
      "unauthorized",
      "未交给主机或后台项目经理的待办不能直接授权诊断结项",
    );
    ensure(
      !p.host_diagnostic || !humanOnlyAction(d, action),
      "unauthorized",
      "交人事项不能标记为可回填诊断",
    );
    ensure(
      actor.kind === "human" ||
        !action.prerequisite ||
        p.blocks_merge !== false,
      "unauthorized",
      "只有人能移除凭据或账号前置分类",
    );
    if (external) {
      text(p.host_assignment_id, "host_assignment_id");
      externalHostOwner(d, p.host_assignment_id);
    }
    const reclassify =
      p.blocks_merge !== undefined || p.prerequisite !== undefined;
    ensure(
      !reclassify || ["host", "human"].includes(p.disposition),
      "validation_failed",
      "Reclassification requires a human or host handoff",
    );
    ensure(
      p.blocks_merge === undefined || typeof p.blocks_merge === "boolean",
      "validation_failed",
      "blocks_merge must be a boolean",
    );
    ensure(
      p.prerequisite === undefined ||
        ["credential", "external_account"].includes(p.prerequisite),
      "validation_failed",
      "Unknown human action prerequisite",
    );
    const blocksMerge = p.blocks_merge ?? action.blocks_merge;
    const prerequisite = p.prerequisite ?? action.prerequisite;
    ensure(
      !reclassify ||
        (blocksMerge === true ? !!prerequisite : p.prerequisite === undefined),
      "validation_failed",
      "Merge blocking requires a credential or external-account prerequisite",
    );
    if (p.disposition === "done") {
      ensure(
        action.triage === "pm_ops" ||
          (action.triage === "host" &&
            reportableHostAction(action) &&
            isPmOps(d) &&
            verifyHostResult(d, action, p.rationale, p.legacy_host_result)),
        "unauthorized",
        "主机待办结项须引用同卡执行者关联本待办的回帖（C-n#N）",
      );
      return completeActionDraft(d, {
        human_action_id: action.id,
        text: p.rationale,
      });
    }
    if (p.disposition === "release") {
      ensure(
        action.triage === "host" || action.triage === "human",
        "illegal_transition",
        "先分拣为 human 或 host，再放行",
      );
      ensure(
        !!action.ready_when && !needsYouItemReady(readinessOf(d), action),
        "illegal_transition",
        "这个事项没有待满足的就绪条件，不需要放行",
      );
      const released: HumanAction = {
        ...action,
        ready_released: { at: d.now, by: d.author, reason: p.rationale },
      };
      d.put("human_actions", released);
      d.emit(
        "human_action_requested",
        action.card_id,
        {
          human_action_id: action.id,
          disposition: action.triage,
          released: true,
          reason: p.rationale,
        },
        {
          type: "human_action",
          human_action_id: action.id,
          body: `项目经理已放行${action.triage === "host" ? "主机操作" : "待你执行"}：${action.handoff?.title ?? action.instructions}\n\n放行理由：${p.rationale}`,
        },
      );
      return released;
    }
    ensure(
      p.disposition === "host" || p.disposition === "human",
      "validation_failed",
      "Unknown disposition",
    );
    ensure(
      p.host_operator === undefined ||
        (p.disposition === "host" &&
          ["external", "host_ops"].includes(p.host_operator)),
      "validation_failed",
      "host_operator 只能在分拣为 host 时填写 external 或 host_ops",
    );
    text(p.title, "title");
    ensure(
      [...p.title.trim()].length <= 80 && !/[\r\n]/u.test(p.title),
      "validation_failed",
      "Title must be one line, at most 80 characters",
    );
    if (p.todo !== undefined) {
      text(p.todo, "todo");
      ensure(
        [...p.todo.trim()].length <= 80 && !/[\r\n]/u.test(p.todo),
        "validation_failed",
        "todo must be one line, at most 80 characters",
      );
    }
    text(p.summary, "summary");
    text(p.why_human, "why_human");
    text(p.expected_outcome, "expected_outcome");
    text(p.instructions, "instructions");
    text(p.expected_return, "expected_return");
    const { prerequisite: _previousPrerequisite, ...original } = action;
    const classified: HumanAction = reclassify
      ? {
          ...original,
          blocks_merge: blocksMerge === true,
          ...(blocksMerge && prerequisite
            ? { prerequisite }
            : {
                blocked_work_items: [],
                follow_up_work_items: [
                  ...new Set([
                    ...(action.follow_up_work_items ?? []),
                    ...action.blocked_work_items,
                  ]),
                ],
              }),
        }
      : action;
    const condition =
      p.ready_when ??
      (reclassify && !blocksMerge && action.card_id
        ? { kind: "card_merged" as const, card_id: action.card_id }
        : undefined);
    const readyWhen = condition
      ? readyCondition(
          d,
          condition,
          {
            held: heldCards(classified),
            paused: pausedCards(readinessOf(d), classified),
          },
          true,
        )
      : action.ready_when;
    validateTerminal(p.terminal);
    ensure(
      !p.terminal ||
        (!workerHelperAction(d.state, action) &&
          !workerAgentToolsAction(d.state, action)),
      "validation_failed",
      "系统升级命令不能改写",
    );
    const handoff = {
      ...(p.terminal ? { terminal: p.terminal } : {}),
      title: p.title.trim(),
      ...(p.todo ? { todo: p.todo.trim() } : {}),
      summary: p.summary,
      why_human: p.why_human,
      instructions: p.instructions,
      expected_outcome: p.expected_outcome,
      expected_return: p.expected_return,
      rewritten_by: d.author,
      rewritten_at: d.now,
    };
    const {
      host_operator: _operator,
      host_diagnostic: _diagnostic,
      host_assignment_id: _owner,
      ready_when: _ready,
      ready_released: _released,
      ...rest
    } = classified;
    let owner = p.host_assignment_id;
    if (p.host_diagnostic) {
      ensure(
        reportableHostAction(classified),
        "validation_failed",
        "诊断不能阻塞工作或合并",
      );
      owner = (internalHostOwner(d, "host_ops") ?? internalHostOwner(d, "pm"))
        ?.id;
      ensure(
        owner,
        "validation_failed",
        "主机待办需要有回填权限的主机运维或后台项目经理",
      );
    }
    const next: HumanAction = {
      ...rest,
      triage: p.disposition,
      ...(p.disposition === "host"
        ? {
            host_operator: p.host_operator ?? "host_ops",
            ...(p.host_diagnostic ? { host_diagnostic: true as const } : {}),
            ...(owner ? { host_assignment_id: owner } : {}),
          }
        : {}),
      triage_rationale: p.rationale,
      handoff,
      ...(readyWhen ? { ready_when: readyWhen } : {}),
      // A new condition needs a new release; keeping the old one keeps it.
      ...(action.ready_released && !condition
        ? { ready_released: action.ready_released }
        : {}),
    };
    d.put("human_actions", next);
    const resumed: WorkItem[] = [];
    if (reclassify && !blocksMerge)
      for (const id of action.blocked_work_items) {
        const item = d.work(id);
        if (["done", "cancelled"].includes(d.card(item.card_id).status))
          continue;
        const result = resumeWork(d, item);
        if (result) resumed.push(result);
      }
    const event = d.emit(
      "human_action_requested",
      action.card_id,
      {
        human_action_id: action.id,
        disposition: p.disposition,
        previous_host_assignment_id: action.host_assignment_id ?? null,
        host_assignment_id: next.host_assignment_id ?? null,
        ...(next.host_operator ? { host_operator: next.host_operator } : {}),
        ...(next.host_diagnostic ? { host_diagnostic: true } : {}),
        ...(next.ready_when ? { ready_when: next.ready_when } : {}),
        reason: p.rationale,
        handoff,
        ...(reclassify
          ? {
              previous_blocks_merge: action.blocks_merge ?? null,
              previous_prerequisite: action.prerequisite ?? null,
              previous_blocked_work_items: action.blocked_work_items,
              blocks_merge: next.blocks_merge,
              prerequisite: next.prerequisite ?? null,
              follow_up_work_items: next.follow_up_work_items ?? [],
              resume_work_items: resumed.map((item) => item.id),
            }
          : {}),
      },
      {
        type: "human_action",
        human_action_id: action.id,
        body: `${actor.kind === "human" ? "你" : "项目经理"}已改写${p.disposition === "host" ? (next.host_operator === "external" ? "主机操作（外接操作员）" : "主机操作") : "待你执行"}：${p.title.trim()}${handoff.todo ? `\n\n你要做什么：${handoff.todo}` : ""}\n\n这是什么：${p.summary}\n\n为什么需要你：${p.why_human}\n\n怎么做：${p.instructions}\n\n做完会怎样：${p.expected_outcome}\n\n完成后请回传：${p.expected_return}\n\n分拣理由：${p.rationale}`,
      },
    );
    for (const item of resumed) queueResumedRun(d, item, event);
    return next;
  });
}
