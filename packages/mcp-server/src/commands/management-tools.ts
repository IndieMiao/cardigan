import {
  type Actor,
  assignOrDefer,
  builtinCardTemplatesForFlow,
  type Clock,
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  completeHumanAction,
  createCard,
  createWorkItem,
  decisionCategories,
  issueInstruction,
  latestCardTemplate,
  MAX_DECISION_ATTACHMENTS,
  parseId,
  postComment,
  projectFlowVersion,
  type Result,
  recordDecision,
  releaseAssignment,
  replaceVerificationWorkItem,
  reportBlocker,
  requestDecision,
  requestHumanAction,
  resolveDelegatedDecision,
  setMergeSolo,
  setMergeWindow,
  states,
  type ToolName,
  triageHumanAction,
  updateCard,
  updateWorkItem,
  validateWorkItemRequirements,
  validationFailed,
} from "@cardigan/domain";
import { z } from "zod";
import { agentCard } from "../tools/shared.js";
import { defineTool } from "../tools/types.js";
import { executeCommand, projectRepositories } from "./execute.js";
import { entryId, id, idempotency_key, plainSummary } from "./schemas.js";

const text = z.string().min(1);
const pausePlan = z
  .object({
    owner: id("assignment"),
    confirmers: z.array(id("assignment")).min(1),
    next_step: text,
    review_at: text.optional(),
  })
  .strict()
  .optional()
  .describe(
    "轮限暂停必填：本卡当前负责人、待确认人、下一步动作；复查时间默认 30 分钟后",
  );
const terminal = z
  .object({
    target: text,
    login: text,
    command: text,
    expected_output: text,
    on_failure: text,
  })
  .strict()
  .optional()
  .describe(
    "需要人在终端执行操作时填写；command 为原样复制的完整命令，不含凭据。",
  );
const subject = z.object({
  kind: z.enum(["git_head", "artifact_sha256", "doc_version"]),
  value: text,
});
const refs = z.array(
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("card"), id: id("card") }),
    z.object({ kind: z.literal("work_item"), id: id("work_item") }),
    z.object({ kind: z.literal("assignment"), id: id("assignment") }),
    z.object({ kind: z.literal("run"), id: id("run") }),
    z.object({ kind: z.literal("review"), id: id("review") }),
    z.object({ kind: z.literal("timeline_entry"), id: entryId }),
    z.object({ kind: z.literal("delivery"), id: id("delivery") }),
    z.object({ kind: z.literal("decision"), id: id("decision") }),
    z.object({ kind: z.literal("human_action"), id: id("human_action") }),
    z.object({ kind: z.literal("pr"), url: z.url() }),
  ]),
);
const viaAuthor = z
  .string()
  .refine(
    (s) =>
      s === "human" ||
      s === "system" ||
      (s.startsWith("assignment:") && parseId("assignment", s.slice(11)).ok),
    "Invalid author",
  );
/** C-192: optional suggestion on a decision handed to the human. */
const suggestion = z
  .object({ option: text, rationale: text, return_reason: text.optional() })
  .optional();
/** C-212: when a Needs You item may be shown; it exists (and holds merges) from the start. */
const cardReady = [
  z.object({ kind: z.literal("card_delivery"), card_id: id("card") }),
  z.object({ kind: z.literal("card_merged"), card_id: id("card") }),
] as const;
const readyWhen = (manual: boolean) =>
  (manual
    ? z.discriminatedUnion("kind", [
        ...cardReady,
        z.object({ kind: z.literal("manual") }),
      ])
    : z.discriminatedUnion("kind", [...cardReady])
  )
    .optional()
    .describe(
      manual
        ? "Defer until a card gets a new delivery, a card merges, or PM Ops releases it (manual). Use instead of writing 'do this later' in the text. Merge-holding items still show once their card submits completion."
        : "Human decisions only: defer until a card gets a new delivery or merges. Use instead of writing 'decide this later' in the text.",
    );
const requirements = z
  .object({
    os: text.optional(),
    arch: text.optional(),
    capabilities: z.array(text).optional(),
    tags: z.array(text).optional(),
  })
  .strict()
  .transform((input, ctx) => {
    const result = validateWorkItemRequirements(input);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: result.error.message });
      return z.NEVER;
    }
    return result.value;
  });
const schemas = {
  set_merge_solo: { card_id: id("card"), solo: z.boolean(), reason: text },
  set_merge_window: { card_id: id("card"), open: z.boolean(), reason: text },
  issue_instruction: {
    card_id: id("card"),
    work_item_id: id("work_item"),
    body: text,
    decision_id: id("decision").optional(),
  },
  post_comment: {
    story_discussion: z
      .discriminatedUnion("action", [
        z
          .object({
            action: z.literal("ask"),
            questions: z
              .array(
                z
                  .object({ question: text, recommended: text, impact: text })
                  .strict(),
              )
              .min(1),
          })
          .strict(),
        z
          .object({
            action: z.literal("propose"),
            children: z
              .array(
                z
                  .object({
                    title: text,
                    template_id: text,
                    goal: text.describe("子卡目标摘要"),
                    acceptance_criteria: z
                      .array(text)
                      .min(1)
                      .describe("验收要点，至少一条"),
                    depends_on: z
                      .array(z.number().int().positive())
                      .optional()
                      .describe("依赖的方案内子卡序号（从 1 起）"),
                    depends_on_cards: z
                      .array(id("card"))
                      .optional()
                      .describe("依赖的已有卡片"),
                    priority: z.number().int().min(0).max(4).optional(),
                    owner_role: text.describe("负责角色编号"),
                    state_and_save: z
                      .union([z.literal("无写入"), z.record(z.string(), text)])
                      .optional()
                      .describe("界面模板必填：状态与保存"),
                    repo: text.optional(),
                    base_branch: text.optional(),
                  })
                  .strict(),
              )
              .min(1)
              .optional()
              .describe(
                "带版本的拆解方案：每项一张子卡。修订即提交新版本，人只能确认最新版本；省略时为纯正文方案",
              ),
          })
          .strict(),
      ])
      .optional()
      .describe(
        "常驻 Office 在需求卡发问题清单（ask），或提交拆解方案（propose，未答题按默认；带 children 时生成可由人一键确认开卡的新版本，不代替确认）。",
      ),
    story_summary: z
      .boolean()
      .optional()
      .describe("常驻 Office 在子卡全部结束后提交对照总结，由人标记需求卡完成"),
    card_id: id("card"),
    body: text,
    work_item_id: id("work_item").optional(),
    mentions: z.array(text).optional(),
    review_plan: z
      .object({
        decision_id: id("decision"),
        step: z.enum(["propose", "confirm"]),
      })
      .strict()
      .optional()
      .describe(
        "暂停或换做法：负责人提交方案，待确认人 reply_to 当前方案并确认方向，不等于审核通过",
      ),
    review_alignment: z
      .object({
        work_item_id: id("work_item"),
        step: z.enum(["propose", "confirm", "dispute"]),
        invariants: z.array(text).min(1).max(10).optional(),
      })
      .strict()
      .optional()
      .describe(
        "对齐回合（连续第 3 次驳回后）：作者或审核员用 propose 提出 1–10 条不变量（invariants），对方 reply_to 该条后 confirm 同意或 dispute 写明分歧；同意后写入 card.invariants 并恢复审核，分歧交 PM 裁决",
      ),
    host_report_for: id("human_action")
      .optional()
      .describe(
        "Attest to your own completed host work on this card for PM verification. Does not close the action; omit for progress, dispatch or second-hand reports.",
      ),
    host_result_for: id("human_action")
      .optional()
      .describe(
        "Host Ops only: record the final result and complete this assigned internal host diagnostic. Omit on progress comments.",
      ),
    reply_to: entryId.optional(),
    refs: refs.optional(),
    supersedes: entryId.optional(),
  },
  report_blocker: {
    work_item_id: id("work_item"),
    reason: text,
    needs: z.enum(["role", "human"]),
    resume_when: z
      .object({
        kind: z.enum([
          "precheck_finished",
          "merge_check_finished",
          "github_run_completed",
          "card_merged",
          "deployment_ready",
          "baseline_updated",
          "decision_resolved",
        ]),
        target_id: z.string().min(1).max(100),
      })
      .optional()
      .describe(
        "Automatically resume when the same-project target settles. Use an attempt ID, bound GitHub run ID, card ID, full deployed SHA, decision ID, or the registered baseline SHA for baseline_updated. Each new author precheck can resume its own wait. Repeated failures of the same HEAD, exhausted candidate-conflict recovery and other repeated blockers go to PM.",
      ),
  },
  request_decision: {
    human_required_reason: text
      .optional()
      .describe(
        "With decider=human: explicit reason this decision must be made personally by the human (numeric, behavior or role rules, scope changes required by AGENTS.md). Overrides standing delegation; PM cannot approve or transcribe it. Omit to keep category delegation. Delegated responses include routed_to and routing_reason and the timeline says 已按常驻授权转给 PM.",
      ),
    ready_when: readyWhen(false),
    card_id: id("card")
      .optional()
      .describe(
        "Omit (and leave affected_cards empty) for a project-wide question. A spending/account/credential/data_deletion/publish question requires human merge confirmation. Permission, scope changes and general human_required_reason do not add a mandatory human merge gate.",
      ),
    kind: z.enum(["choose", "approve"]),
    category: z.enum(decisionCategories),
    question: text,
    context: text,
    options: z
      .array(z.object({ key: text, description: text, impact: text }))
      .min(1),
    recommended: text,
    suggestion: suggestion.describe(
      "Suggested answer shown to the human with a one-click button; option must equal recommended. Required by PM rules when handing a matter to the human.",
    ),
    plain_summary: plainSummary
      .optional()
      .describe(
        "Required when decider=human: the plain summary the human reads first (what changed, impact, risk).",
      ),
    affected_cards: z.array(id("card")),
    affected_work_items: z.array(id("work_item")),
    blocking: z.boolean(),
    decider: z.union([z.literal("human"), z.string().regex(/^role:.+/u)]),
    target: z
      .union([z.object({ delivery_id: id("delivery") }), z.object({ subject })])
      .optional(),
    attachment_ids: z
      .array(text)
      .max(MAX_DECISION_ATTACHMENTS)
      .optional()
      .describe(
        "Existing attachments on this card or affected_cards to show with the question, in display order",
      ),
  },
  resolve_delegated_decision: {
    pause_plan: pausePlan,
    source_unrelated: z
      .object({ decision_id: id("decision"), rationale: text })
      .strict()
      .optional()
      .describe(
        "仅建议来源拍板与本卡合并无关：与 escalate=true、option=merge 单独提交；不批准合并，只有人能在 Needs You 确认。",
      ),
    decision_evidence: z
      .array(
        z
          .object({
            decision_id: id("decision"),
            option: text,
            completion_id: id("delivery"),
            delivery_id: id("delivery"),
            target_sha: z.string().regex(/^[0-9a-f]{40}$/i),
            evidence: text,
          })
          .strict(),
      )
      .optional()
      .describe(
        "确认人已拍板的范围或权限合并时必填：每条拍板与每项当前产出交付逐项对应，含当前完成申请和完整提交号；不一致或超出授权须交人",
      ),
    snooze_until: text
      .optional()
      .describe(
        "With merge hold only: future ISO timestamp with timezone. Omit to use the project default; rationale is the required hold reason.",
      ),
    decision_id: id("decision"),
    role_rule_basis: z
      .object({
        completion_id: id("delivery"),
        inventories: z.array(
          z
            .object({
              delivery_id: id("delivery"),
              base_sha: text,
              sha: text,
              tree_sha: text,
            })
            .strict(),
        ),
        mappings: z.array(
          z
            .object({
              delivery_id: id("delivery"),
              edit_id: text,
              category: z.literal("body"),
              decision_id: id("decision"),
              quote: text,
              explanation: text,
            })
            .strict(),
        ),
      })
      .strict()
      .optional()
      .describe(
        "With merge only: cover every host inventory body edit with an audited human decision; bind the current completion, full SHAs, tree and base. Unknown or permission/review changes remain human-only.",
      ),
    option: text,
    rationale: text,
    escalate: z.boolean().optional(),
    suggestion: suggestion.describe(
      "With escalate only: on an open human-held decision, refreshes only the suggestion and evidence baseline (omit attachments/plain_summary/notice/snooze_until); otherwise hands off to the human. Your suggested option (merge or request_changes for merge confirmations) and a one-line reason, shown to the human with a one-click button; with request_changes also return_reason, prefilled for the human. Required by PM rules when escalating.",
    ),
    plain_summary: plainSummary
      .optional()
      .describe(
        "With escalate only: required when the decision has no plain summary yet; otherwise rewrites it (the rewrite is audited).",
      ),
    notice: text.optional(),
    attachment_ids: z
      .array(text)
      .max(MAX_DECISION_ATTACHMENTS)
      .optional()
      .describe(
        "With escalate only: existing attachments on the decision's cards to show the human, in display order",
      ),
    owner_record: z
      .strictObject({
        timeline_entry_id: entryId,
        attachment_id: text.optional(),
      })
      .optional()
      .describe(
        "所有者已在卡上明确答复这条 PM 拍板时，你在原有授权内作决定，并引用原话作依据（C-n#N），不必再请所有者重选；正式答复和理由仍是你的。原话须为所有者本人在本拍板所在卡片上的评论（拍板不涉及其它卡）：在拍板提出之后、只对应本拍板（引用本拍板或回复拍板请求，所回复的内容也不涉及其它拍板），整条只写一句明确选择（如“Q-1 选 X”），未撤回或改写、之后无新答复、交付未变。attachment_id 只认所有者上传在这条评论上的附件。服务端原样抄录原话作为依据，不算所有者亲自确认；不增加授权，不与 escalate、合并或其它依据同用。不满足时按现有途径处理。",
      ),
  },
  complete_host_action: {
    human_action_id: id("human_action"),
    text,
  },
  triage_human_action: {
    human_action_id: id("human_action"),
    disposition: z
      .enum(["done", "host", "human", "release"])
      .describe(
        "release: show an action already triaged human/host whose ready_when is not met yet (PM manual release); only rationale is needed.",
      ),
    legacy_host_result: z
      .strictObject({ entry: entryId, result_quote: text, verification: text })
      .optional()
      .describe(
        "For pre-protocol reports by the executor assigned at posting time: cite their original comment linked to the action or replying directly to its request or formal handoff. Quote the actual final outcome verbatim and explain how you independently checked it; progress or a second-hand report is not a result.",
      ),
    ordinary_host_basis: z
      .strictObject({ request: entryId, explanation: text })
      .optional()
      .describe(
        "For an unclassified host action only: cite its original request (C-n#N) and explain why it is not human-only. Omit if uncertain; never infer safety from a result report.",
      ),
    rationale: text.describe(
      "For host → done, cite the executor’s same-card result comment (C-n#N) linked to the action.",
    ),
    title: text.max(80).optional(),
    todo: text
      .max(80)
      .optional()
      .describe(
        "One plain line saying what the reader has to do; shown under the title, everything else is folded.",
      ),
    host_assignment_id: id("assignment")
      .optional()
      .describe(
        "Required with host/external: exact active external PM Office Assignment; rewriting explicitly transfers responsibility.",
      ),
    host_diagnostic: z
      .literal(true)
      .optional()
      .describe(
        "Internal read-only diagnostic: bind a result author (host_ops or fallback PM Ops). May reassign eligible legacy or deferred actions. Omit for ordinary host work.",
      ),
    host_operator: z
      .enum(["external", "host_ops"])
      .optional()
      .describe(
        "With host only: external = an operator outside host_ops (e.g. the external PM Office) performs it and host_ops is not woken; omitted = host_ops.",
      ),
    ready_when: readyWhen(true),
    blocks_merge: z
      .boolean()
      .optional()
      .describe(
        "With human/host handoff only: false explicitly reclassifies an old hold as post-merge follow-up; true requires a credential or external-account prerequisite. Omit to preserve the existing hold.",
      ),
    prerequisite: z.enum(["credential", "external_account"]).optional(),
    summary: text.optional(),
    why_human: text.optional(),
    expected_outcome: text.optional(),
    instructions: text.optional(),
    terminal,
    expected_return: text.optional(),
  },
  record_decision: {
    pause_plan: pausePlan,
    snooze_until: text
      .optional()
      .describe(
        "With merge hold only: future ISO timestamp with timezone. Omit to use the project default; rationale is the required hold reason.",
      ),
    decision_id: id("decision"),
    option: text,
    rationale: text,
    raw_quote: text,
    via_chain: z.array(viaAuthor).optional(),
    batch: text.optional(),
  },
  request_human_action: {
    category: z
      .enum(decisionCategories)
      .optional()
      .describe(
        "标记待办本身涉及的事项；花钱、凭据和账号、删除数据、对外发布只能由人结项。",
      ),
    ready_when: readyWhen(true),
    card_id: id("card"),
    terminal,
    instructions: text,
    why_human: text,
    expected_return: text,
    blocked_work_items: z.array(id("work_item")),
    prerequisite: z
      .enum(["credential", "external_account"])
      .optional()
      .describe("阻塞合并时必填：凭据或外部账号前置操作"),
    blocks_merge: z
      .boolean()
      .optional()
      .describe(
        "Only credential or external-account prerequisites may block merge; prerequisite is required with true. Field verification is post-merge follow-up by default.",
      ),
    due: text.optional(),
  },
  create_card: {
    parent_card_id: id("card").optional(),
    state_and_save: z
      .union([
        z.literal("无写入"),
        z.strictObject({
          save_timing: text.describe("保存时机（即时或按组）"),
          leave_behavior: text.describe("离页行为"),
          failure_feedback: text.describe("失败提示"),
          consistency: text.describe("读写一致性做法"),
        }),
      ])
      .optional()
      .describe(
        "状态与保存：模板标有 requires_state_and_save 时必填；纯展示只填“无写入”",
      ),
    work_item_requirements: z
      .record(text, requirements)
      .optional()
      .describe(
        "Additional machine requirements by template work-item key; template defaults and role requirements are retained.",
      ),
    is_ui_framework: z
      .boolean()
      .optional()
      .describe("界面框架卡；有后续依赖时提醒常驻 PM"),
    depends_on_cards: z
      .array(id("card"))
      .optional()
      .describe("同项目前置卡；传 [] 清空"),
    wait_for_dependencies: z
      .boolean()
      .optional()
      .describe("仅明确等待且仍 backlog 的卡在前置完成后自动转 todo"),
    early_start: z
      .boolean()
      .optional()
      .describe("设置或清除提前开工，须有排期权限并填写理由"),
    dependency_reason: text.optional(),
    title: text,
    goal: text,
    acceptance_criteria: z.array(text).default([]),
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("quote"), text }),
      z.object({ kind: z.literal("decision"), decision_id: id("decision") }),
    ]),
    repo: text
      .describe(
        "Defaults to the current project's registered repository when omitted.",
      )
      .optional(),
    base_branch: text
      .describe(
        "Defaults to the current project's default base branch when omitted.",
      )
      .optional(),
    out_of_scope: z.array(text).optional(),
    related_cards: z.array(id("card")).optional(),
    priority: z
      .enum([
        "none",
        "low",
        "medium",
        "high",
        "urgent",
        "无",
        "低",
        "中",
        "高",
        "紧急",
      ])
      .optional(),
    deadline: text.optional(),
    template: text.optional(),
    template_id: text.optional(),
  },
  update_card: {
    is_ui_framework: z
      .boolean()
      .optional()
      .describe("界面框架卡；有后续依赖时提醒常驻 PM"),
    depends_on_cards: z
      .array(id("card"))
      .optional()
      .describe("同项目前置卡；传 [] 清空"),
    wait_for_dependencies: z
      .boolean()
      .optional()
      .describe("仅明确等待且仍 backlog 的卡在前置完成后自动转 todo"),
    early_start: z
      .boolean()
      .optional()
      .describe("设置或清除提前开工，须有排期权限并填写理由"),
    dependency_reason: text.optional(),
    card_id: id("card"),
    hold: z
      .object({ reason: text, resume_condition: text })
      .strict()
      .nullable()
      .optional()
      .describe(
        "常驻 PM 设置暂停原因和恢复条件；传 null 解除。不能与其它字段混用",
      ),
    title: text.optional(),
    goal: text.optional(),
    acceptance_criteria: z.array(text).min(1).optional(),
    priority: z
      .enum([
        "none",
        "low",
        "medium",
        "high",
        "urgent",
        "无",
        "低",
        "中",
        "高",
        "紧急",
      ])
      .optional(),
    deadline: text
      .nullable()
      .optional()
      .describe("卡片截止日期；传 null 清除，省略不改"),
    status: z.enum(states.card).optional(),
    risk_tags: z
      .array(z.enum(["security", "permission", "numeric_rule"]))
      .optional()
      .describe(
        "代码风险标签，仅 PM 或人可写；传 [] 清空。非人验收卡须配套必需的独立复核验证项",
      ),
    merge_classification: z
      .object({
        checked_versions: z.array(
          z
            .object({
              work_item_id: id("work_item"),
              delivery_id: id("delivery"),
              subject: text,
            })
            .strict(),
        ),
        read_through_seq: z.number().int().nonnegative(),
        risk_tags: z.array(z.enum(["security", "permission", "numeric_rule"])),
        risk_reviewed: z.boolean(),
        is_ui: z.boolean(),
        numeric_rules_approved: z.boolean(),
        numeric_decision_ids: z.array(id("decision")),
        not_external_release: z.boolean(),
        no_role_changes: z.boolean(),
        timeline_reviewed: z.boolean(),
      })
      .strict()
      .optional()
      .describe(
        "合并前分类确认：常驻 PM 或人填写全部结论、当前产出交付编号/SHA、已读时间线序号；独立更新，交付变化后失效，仅供影子记录",
      ),
    pre_merge_check: z
      .object({
        label: text.describe("核对项名称，例如“独立安全审核”“截图核对”"),
        status: z.enum(["pending", "passed", "failed"]),
        note: z.string().optional(),
      })
      .strict()
      .optional()
      .describe(
        "C-160 合并前核对项：新增或更新一项，不能与其他字段混用。PM Ops 只能设为 pending；passed/failed 只有 PM Office 能设。固定名称“独立复核”只允许手工设为 pending，其结论由独立复核员提交审核生成。结论只对当前交付版本有效，新版本交付后需重新核对",
      ),
  },
  create_work_item: {
    requirements: requirements.optional(),
    card_id: id("card"),
    title: text,
    kind: z.enum(["produce", "verify"]),
    role_id: text,
    required: z.boolean(),
    completion_criteria: z.array(text),
    depends_on: z.array(id("work_item")).optional(),
    target_work_item_id: id("work_item").optional(),
    max_review_rounds: z.number().int().positive().optional(),
  },
  update_work_item: {
    requirements: requirements
      .optional()
      .describe(
        "Replace item requirements; {} clears custom requirements while retaining template defaults and role constraints. Does not move an existing Assignment.",
      ),
    manual_assign: z.boolean().optional(),
    work_item_id: id("work_item"),
    title: text.optional(),
    completion_criteria: z.array(text).optional(),
    required: z.boolean().optional(),
    status: z.enum([...states.produce, ...states.verify]).optional(),
    max_review_rounds: z.number().int().positive().optional(),
    review_limit_decision: z
      .object({
        pause_plan: pausePlan,
        decision_id: id("decision"),
        option: z.enum([
          "raise_limit",
          "pause",
          "escalate",
          "narrow_scope",
          "change_approach",
          "split_card",
        ]),
        rationale: text,
      })
      .describe(
        "PM Ops only: resolve a delegated review limit with a reason; choose a listed option, or escalate to the human. For narrow_scope specify the excluded scope; for split_card first create the follow-up with this decision as source.",
      )
      .optional(),
  },
  replace_verification_work_item: {
    work_item_id: id("work_item"),
    card_id: id("card"),
    template_key: text,
    reason: text,
  },
  assign: {
    employee_id: text
      .describe("Employee ID (E-n) or active name; omitted selects by role.")
      .optional(),
    work_item_id: id("work_item"),
    role_id: text,
    role_version: z.number().int().positive().optional(),
    machine_id: text.optional(),
    recovery_source: z.enum(["main", "backup"]).optional(),
    confirm_same_machine: z
      .boolean()
      .describe(
        "Explicitly reuse the specified original machine after confirmed exit and release; requires recovery_source.",
      )
      .optional(),
    os: text.optional(),
    arch: text.optional(),
    required_tags: z.array(text).optional(),
  },
  release_assignment: {
    assignment_id: id("assignment"),
    cancel_queued_run_id: id("run").optional(),
  },
};

function assignPending(...args: Parameters<typeof assignOrDefer>) {
  const result = assignOrDefer(...args);
  if (!result.ok) return result;
  return {
    ok: true as const,
    value: {
      ...result.value,
      data:
        "deferred" in result.value.data
          ? result.value.data
          : {
              ...result.value.data,
              token_status: result.value.token_requests.length
                ? "pending_host_issuance"
                : "host_managed",
            },
    },
  };
}

function cardReply(result: ReturnType<typeof createCard>) {
  if (!result.ok) return result;
  return {
    ok: true as const,
    value: { ...result.value, data: agentCard(result.value.data) },
  };
}

export function managementTools(clock?: Clock) {
  function wire<P, T>(
    name: keyof typeof schemas & ToolName,
    description: string,
    reduce: (
      s: CommandState,
      a: Actor,
      p: P,
      ports: CommandPorts,
    ) => Result<CommandEffect<T>>,
  ) {
    return defineTool({
      name,
      description,
      input: z.object({ ...schemas[name], idempotency_key }),
      handler: ({ idempotency_key, ...params }, context) =>
        executeCommand(
          context,
          name,
          idempotency_key,
          params as P,
          reduce,
          clock,
        ),
    });
  }
  return [
    wire(
      "release_assignment",
      "Release a work-item Assignment as PM Ops. To cancel a never-dispatched, unreserved queue (including a confirmed clean preparation retry) without a session and reselect its machine, supply cancel_queued_run_id; then assign the same work item without machine_id. Other unfinished Runs must first be stopped with cardigan assignment stop <A-n>. Standing Assignments can only be released by the human.",
      releaseAssignment,
    ),
    defineTool({
      name: "post_comment",
      description: "Post a comment and references.",
      input: z.object({ ...schemas.post_comment, idempotency_key }),
      handler: ({ idempotency_key, ...params }, context) =>
        executeCommand(
          context,
          "post_comment",
          idempotency_key,
          params,
          (s, a, p, ports) =>
            postComment(
              s,
              a,
              p as Parameters<typeof postComment>[2],
              p.story_discussion?.action === "propose" &&
                p.story_discussion.children
                ? {
                    ...ports,
                    project_repositories: projectRepositories(
                      context.store,
                      a.project_id,
                    ),
                  }
                : ports,
            ),
          clock,
        ),
    }),
    wire(
      "issue_instruction",
      "Instruct an unfinished work item as PM Ops. To ask a verifier held by a pending review-limit decision (confirm a direction, add an opinion) pass that decision_id: only that verifier's Assignment is woken, it may answer with post_comment (reply_to the instruction), its reply reaches PM Ops, and it still cannot submit a review, change the decision or advance the merge. Ordinary comments do not wake a waiting verifier.",
      issueInstruction,
    ),
    wire("report_blocker", "Report a work item blocker.", reportBlocker),
    wire(
      "resolve_delegated_decision",
      "Resolve an authorized decision as PM Ops, with a rationale, or escalate it to the human. Merge confirmations: hold records a required rationale and optional snooze_until (default 240 minutes, configurable); it reopens automatically at expiry. Choose merge only when list_needs_you shows no merge_blockers, and pass a notice (what changed, impact on the human, risks or follow-ups) for the Needs You notices. When the current merge check failed or timed out (list_needs_you pm_queue.failed_merge_checks, including confirmed merges), choose request_changes (real failure; rationale names the failing case and fix direction) or recheck (flaky: timeout or load), always with a notice; human-decided scope/permission merges require decision_evidence when the human-only project preference is enabled; other human-only conditions remain enforced. A system-held merge confirmation (decider=system) accepts only hold or request_changes, with the rationale and a notice citing the basis (e.g. the human's answer or a review); merge stays with the system or the human. When the owner already answered a PM-routed decision on the card, decide it yourself and pass owner_record to cite the owner's verbatim comment as evidence instead of asking again; your answer and rationale stay yours, and it adds no authority.",
      resolveDelegatedDecision,
    ),
    wire(
      "triage_human_action",
      "Triage an action as PM Ops. For done, record work actually completed within your existing authority. For host/human, supply title, todo (one line: what to do), summary (what this is), why_human, instructions (numbered steps), expected_outcome, expected_return, and rationale in plain language; for host also host_operator, and for external the exact host_assignment_id. Set ready_when when it cannot be done yet; release shows a deferred action. You may clarify an open handoff without completing it.",
      triageHumanAction,
    ),
    wire(
      "complete_host_action",
      "Complete your assigned external host action as PM Office, with a required execution result. This does not grant host execution authority.",
      completeHumanAction,
    ),
    wire("request_decision", "Request a scoped decision.", requestDecision),
    wire(
      "record_decision",
      "Record a decision through PM Office. A system-held merge confirmation (decider=system) accepts only hold or request_changes, with the rationale and raw_quote citing the basis.",
      recordDecision,
    ),
    wire(
      "request_human_action",
      "Request an action only a human can perform.",
      requestHumanAction,
    ),
    defineTool({
      name: "create_card",
      description:
        "Create a card from a project template (default dev). Non-repository templates can omit repo and base_branch. Omit repo to use this project's registered repository; omit base_branch to use its default base branch. Explicit values keep the existing validation rules.",
      input: z.object({ ...schemas.create_card, idempotency_key }),
      handler: ({ idempotency_key, ...params }, context) =>
        executeCommand(
          context,
          "create_card",
          idempotency_key,
          params,
          (state, actor, p, ports) => {
            // Resolve only on a cache miss, inside the same transaction as the card.
            // The raw request remains the idempotency fingerprint across config changes.
            const project =
              p.repo === undefined || p.base_branch === undefined
                ? context.store.getProject?.(actor.project_id)
                : undefined;
            const selectedTemplate = latestCardTemplate(
              [
                ...(state.card_templates ?? []),
                ...builtinCardTemplatesForFlow(
                  projectFlowVersion(
                    state.project_preferences?.find(
                      (preference) => preference.id === state.project_id,
                    ),
                  ),
                ),
              ],
              p.template_id ?? p.template ?? "dev",
            );
            const repo =
              p.repo ??
              (selectedTemplate?.requires_repo
                ? project?.repo_path
                : undefined);
            const base_branch =
              p.base_branch ?? (repo ? project?.base_branch : undefined);
            if (selectedTemplate?.requires_repo && !repo)
              return validationFailed(
                "No registered repository; register the project repository or provide repo explicitly",
              );
            if (repo && !base_branch)
              return validationFailed(
                "No default base branch; register the project baseline or provide base_branch explicitly",
              );
            const {
              state_and_save,
              depends_on_cards,
              is_ui_framework,
              wait_for_dependencies,
              early_start,
              dependency_reason,
              out_of_scope,
              related_cards,
              parent_card_id,
              priority,
              deadline,
              template,
              template_id,
              work_item_requirements,
              repo: _repo,
              base_branch: _base,
              ...required
            } = p;
            return cardReply(
              createCard(
                state,
                actor,
                {
                  ...required,
                  ...(parent_card_id === undefined ? {} : { parent_card_id }),
                  ...(state_and_save === undefined ? {} : { state_and_save }),
                  ...(work_item_requirements === undefined
                    ? {}
                    : { work_item_requirements }),
                  ...(depends_on_cards === undefined
                    ? {}
                    : { depends_on_cards }),
                  ...(is_ui_framework === undefined ? {} : { is_ui_framework }),
                  ...(wait_for_dependencies === undefined
                    ? {}
                    : { wait_for_dependencies }),
                  ...(early_start === undefined ? {} : { early_start }),
                  ...(dependency_reason === undefined
                    ? {}
                    : { dependency_reason }),
                  ...(repo == null ? {} : { repo }),
                  ...(base_branch == null ? {} : { base_branch }),
                  ...(out_of_scope === undefined ? {} : { out_of_scope }),
                  ...(related_cards === undefined ? {} : { related_cards }),
                  ...(priority === undefined ? {} : { priority }),
                  ...(deadline === undefined ? {} : { deadline }),
                  ...(template === undefined ? {} : { template }),
                  ...(template_id === undefined ? {} : { template_id }),
                },
                ports,
              ),
            );
          },
          clock,
        ),
    }),
    wire(
      "set_merge_solo",
      "Standing PM Ops: set whether a card merges in its own checked batch; reason required.",
      setMergeSolo,
    ),
    wire(
      "set_merge_window",
      "Standing PM Ops: open or close a merge window; reason required. Sensitive windows can only be closed by the human.",
      setMergeWindow,
    ),
    wire(
      "update_card",
      "Update card metadata or planning state, or one pre-merge check (pre_merge_check).",
      (...args: Parameters<typeof updateCard>) =>
        cardReply(updateCard(...args)),
    ),
    wire(
      "create_work_item",
      "Create a producing or verifying work item.",
      createWorkItem,
    ),
    wire(
      "update_work_item",
      "Update work item metadata or permitted resumption.",
      updateWorkItem,
    ),
    wire(
      "assign",
      "Assign work; omitted machine selects automatically. A deferred response has no Assignment or token. Credentials must be provisioned by the host.",
      assignPending,
    ),
    wire(
      "replace_verification_work_item",
      "PM Ops: replace a cancelled or released template verifier with a new unassigned item on the same card and template key. Inherits its target and requirements; invalidates affected deliveries and completion requests, which must be submitted again.",
      replaceVerificationWorkItem,
    ),
  ];
}
