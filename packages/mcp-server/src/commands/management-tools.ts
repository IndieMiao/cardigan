import {
  type Actor,
  assign,
  builtinCardTemplates,
  type Clock,
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  createCard,
  createWorkItem,
  decisionCategories,
  issueInstruction,
  latestCardTemplate,
  MAX_DECISION_ATTACHMENTS,
  parseId,
  postComment,
  type Result,
  recordDecision,
  releaseAssignment,
  replaceVerificationWorkItem,
  reportBlocker,
  requestDecision,
  requestDeliveryPrecheck,
  requestHumanAction,
  resolveDelegatedDecision,
  states,
  type ToolName,
  triageHumanAction,
  updateCard,
  updateWorkItem,
  validationFailed,
} from "@cardigan/domain";
import { z } from "zod";
import { agentCard } from "../tools/shared.js";
import { defineTool } from "../tools/types.js";
import { executeCommand } from "./execute.js";
import { entryId, id, idempotency_key, plainSummary } from "./schemas.js";

const text = z.string().min(1);
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
const schemas = {
  issue_instruction: {
    card_id: id("card"),
    work_item_id: id("work_item"),
    body: text,
  },
  post_comment: {
    card_id: id("card"),
    body: text,
    work_item_id: id("work_item").optional(),
    mentions: z.array(text).optional(),
    reply_to: entryId.optional(),
    refs: refs.optional(),
    supersedes: entryId.optional(),
  },
  report_blocker: {
    work_item_id: id("work_item"),
    reason: text,
    needs: z.enum(["role", "human"]),
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
        "Omit (and leave affected_cards empty) for a project-wide question. A spending/account/permission/data_deletion or scope_change question on a card hands that card's merge confirmation to the human, who must then confirm it personally (no auto-merge)",
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
  },
  triage_human_action: {
    human_action_id: id("human_action"),
    disposition: z
      .enum(["done", "host", "human", "release"])
      .describe(
        "release: show an action already triaged human/host whose ready_when is not met yet (PM manual release); only rationale is needed.",
      ),
    rationale: text,
    title: text.max(80).optional(),
    todo: text
      .max(80)
      .optional()
      .describe(
        "One plain line saying what the reader has to do; shown under the title, everything else is folded.",
      ),
    host_operator: z
      .enum(["external", "host_ops"])
      .optional()
      .describe(
        "With host only: external = an operator outside host_ops (e.g. the external PM Office) performs it and host_ops is not woken; omitted = host_ops.",
      ),
    ready_when: readyWhen(true),
    summary: text.optional(),
    why_human: text.optional(),
    expected_outcome: text.optional(),
    instructions: text.optional(),
    expected_return: text.optional(),
  },
  record_decision: {
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
    ready_when: readyWhen(true),
    card_id: id("card"),
    instructions: text,
    why_human: text,
    expected_return: text,
    blocked_work_items: z.array(id("work_item")),
    blocks_merge: z
      .boolean()
      .optional()
      .describe(
        "Hold this card's merge until the action is done. Omit for read-only requests (logs, diagnostics); listing blocked_work_items already holds the merge.",
      ),
    due: text.optional(),
  },
  create_card: {
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
    card_id: id("card"),
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
    status: z.enum(states.card).optional(),
    risk_tags: z
      .array(z.enum(["security", "permission", "numeric_rule"]))
      .optional()
      .describe(
        "代码风险标签，仅 PM 或人可写；传 [] 清空。非人验收卡须配套必需的独立复核验证项",
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
    manual_assign: z.boolean().optional(),
    work_item_id: id("work_item"),
    title: text.optional(),
    completion_criteria: z.array(text).optional(),
    required: z.boolean().optional(),
    status: z.enum([...states.produce, ...states.verify]).optional(),
    max_review_rounds: z.number().int().positive().optional(),
    review_limit_decision: z
      .object({
        decision_id: id("decision"),
        option: z.enum(["raise_limit", "pause", "escalate"]),
        rationale: text,
      })
      .describe(
        "PM Ops only: resolve a delegated review limit with a reason; raise_limit adds one round, pause keeps it blocked, escalate sends the same decision to the human.",
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
    os: text.optional(),
    arch: text.optional(),
    required_tags: z.array(text).optional(),
  },
  release_assignment: {
    assignment_id: id("assignment"),
  },
};

function assignPending(...args: Parameters<typeof assign>) {
  const result = assign(...args);
  if (!result.ok) return result;
  return {
    ok: true as const,
    value: {
      ...result.value,
      data: {
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
    defineTool({
      name: "request_delivery_precheck",
      description:
        "PM: request or reuse a precheck of a current product delivery in this project. Uses the configured remote executor and commands; never authorizes merging.",
      input: z
        .object({ delivery_id: id("delivery"), idempotency_key })
        .strict(),
      handler: ({ idempotency_key, ...params }, context) =>
        executeCommand(
          context,
          "request_delivery_precheck",
          idempotency_key,
          params,
          requestDeliveryPrecheck,
          clock,
        ),
    }),
    wire(
      "release_assignment",
      "Release a work-item Assignment as PM Ops. Unfinished Runs must first be stopped with cardigan assignment stop <A-n>. Standing Assignments can only be released by the human.",
      releaseAssignment,
    ),
    wire("post_comment", "Post a comment and references.", postComment),
    wire(
      "issue_instruction",
      "Instruct an unfinished work item as PM Ops.",
      issueInstruction,
    ),
    wire("report_blocker", "Report a work item blocker.", reportBlocker),
    wire(
      "resolve_delegated_decision",
      "Resolve an authorized decision as PM Ops, with a rationale, or escalate it to the human. Merge confirmations: hold records a required rationale and optional snooze_until (default 240 minutes, configurable); it reopens automatically at expiry. Choose merge only when list_needs_you shows no merge_blockers, and pass a notice (what changed, impact on the human, risks or follow-ups) for the Needs You notices. When the current merge check failed or timed out (list_needs_you pm_queue.failed_merge_checks, including confirmed merges), choose request_changes (real failure; rationale names the failing case and fix direction) or recheck (flaky: timeout or load), always with a notice; human-decided scope/permission merges require decision_evidence when the human-only project preference is enabled; other human-only conditions remain enforced.",
      resolveDelegatedDecision,
    ),
    wire(
      "triage_human_action",
      "Triage an action as PM Ops. For done, record work actually completed within your existing authority. For host/human, supply title, todo (one line: what to do), summary (what this is), why_human, instructions (numbered steps), expected_outcome, expected_return, and rationale in plain language; for host also host_operator. Set ready_when when it cannot be done yet; release shows a deferred action. You may clarify an open handoff without completing it.",
      triageHumanAction,
    ),
    wire("request_decision", "Request a scoped decision.", requestDecision),
    wire(
      "record_decision",
      "Record a decision through PM Office.",
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
            const selectedTemplate =
              latestCardTemplate(
                state.card_templates ?? [],
                p.template_id ?? p.template ?? "dev",
              ) ??
              latestCardTemplate(
                builtinCardTemplates,
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
              out_of_scope,
              related_cards,
              priority,
              deadline,
              template,
              template_id,
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
      "Assign work; credentials must be provisioned by the host.",
      assignPending,
    ),
    wire(
      "replace_verification_work_item",
      "PM Ops: replace a cancelled or released template verifier with a new unassigned item on the same card and template key. Inherits its target and requirements; invalidates affected deliveries and completion requests, which must be submitted again.",
      replaceVerificationWorkItem,
    ),
  ];
}
