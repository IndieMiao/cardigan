import type {
  Actor,
  Card,
  MergeClassificationInput,
  WorkItem,
} from "../entities.js";
import { projectFlowVersion, validFlowVersion } from "../flow.js";
import type { RunId, WorkItemId } from "../ids.js";
import {
  independentReviewMaxRounds,
  initialReviewMaxRounds,
  reviewMaxRounds,
} from "../preferences.js";
import { parseCardPriority } from "../priority.js";
import {
  builtinCardTemplatesForFlow,
  latestCardTemplate,
} from "../templates.js";
import { transition } from "../transitions.js";
import {
  type AssignWorkItemParams,
  assignWorkItem,
} from "./assign-work-item.js";
import {
  type CommandPorts,
  type CommandState,
  ensure,
  text,
  unwrap,
} from "./core.js";
import { syncRiskTagMerge } from "./merge.js";
import { applyMergeClassification } from "./merge-classification.js";
import {
  applyPreMergeCheck,
  type PreMergeCheckInput,
} from "./pre-merge-checks.js";
import { projectPreferences } from "./preferences.js";
import { canResume, queueResumedRun, resumeWork } from "./resumption.js";
import {
  type ReviewLimitResolution,
  resolveReviewLimit,
} from "./review-limit-resolution.js";
import { invalidateReviewReuse } from "./review-reuse.js";
import { commandWithReadyVerifiers as command } from "./system-rules.js";
import {
  resolveCardTemplate,
  validateCardTemplate,
  validateTemplateFlow,
} from "./templates.js";

export type { AssignWorkItemParams } from "./assign-work-item.js";

export type CreateCardParams = Pick<
  Card,
  "title" | "goal" | "source" | "repo" | "base_branch"
> &
  Partial<
    Pick<
      Card,
      | "out_of_scope"
      | "related_cards"
      | "deadline"
      | "template"
      | "acceptance_criteria"
    >
  > & { readonly template_id?: string; readonly priority?: number | string };
export function createCard(
  state: CommandState,
  actor: Actor,
  p: CreateCardParams,
  ports: CommandPorts,
) {
  return command(state, actor, "create_card", ports, (d) => {
    d.pm();
    d.projectAccess();
    const acceptance = p.acceptance_criteria ?? [];
    text(p.title, "title");
    text(p.goal, "goal");
    ensure(
      !p.template || !p.template_id || p.template === p.template_id,
      "validation_failed",
      "template 与 template_id 不一致",
    );
    const templateId = p.template_id ?? p.template ?? "dev";
    const template =
      latestCardTemplate(ports.templates ?? [], templateId) ??
      latestCardTemplate(
        [
          ...d.list("card_templates"),
          ...builtinCardTemplatesForFlow(
            projectFlowVersion(
              state.project_preferences?.find((p) => p.id === state.project_id),
            ),
          ),
        ],
        templateId,
      );
    ensure(template, "not_found", "模板不存在");
    ensure(
      template.status === "active",
      "validation_failed",
      "停用模板不能建卡",
    );
    validateCardTemplate(template, state.roles);
    if (template.requires_repo || p.repo !== undefined) text(p.repo, "repo");
    if (
      template.requires_repo ||
      p.repo !== undefined ||
      p.base_branch !== undefined
    )
      text(p.base_branch, "base_branch");
    ensure(
      p.base_branch === undefined || p.repo !== undefined,
      "validation_failed",
      "基线分支需要仓库",
    );
    ensure(
      Array.isArray(acceptance) &&
        (!template.require_acceptance_criteria || acceptance.length > 0) &&
        acceptance.every((s) => typeof s === "string" && s.trim()),
      "validation_failed",
      "Acceptance criteria are required",
    );
    ensure(
      p.source &&
        ((p.source.kind === "quote" &&
          typeof p.source.text === "string" &&
          p.source.text.trim()) ||
          (p.source.kind === "decision" &&
            d.get("decisions", p.source.decision_id))),
      "validation_failed",
      "Card source is required",
    );
    const priority = parseCardPriority(
      p.priority === undefined ? 0 : p.priority,
    );
    ensure(priority !== undefined, "validation_failed", "Invalid priority");
    for (const id of p.related_cards ?? []) d.card(id);
    const id = d.ids.next(state.project_id, "card");
    const flow_version = projectFlowVersion(projectPreferences(state));
    ensure(
      validFlowVersion(flow_version),
      "validation_failed",
      "项目流程版本尚未开放",
    );
    validateTemplateFlow(template, flow_version);
    const card: Card = {
      id,
      project_id: state.project_id,
      title: p.title,
      goal: p.goal,
      acceptance_criteria: [...acceptance],
      source: p.source,
      ...(p.repo === undefined ? {} : { repo: p.repo }),
      ...(p.base_branch === undefined ? {} : { base_branch: p.base_branch }),
      priority,
      status: "todo",
      template: template.id,
      template_version: template.version,
      flow_version,
      merge_policy: template.merge,
      out_of_scope: p.out_of_scope ?? [],
      related_cards: p.related_cards ?? [],
      created_by: d.author,
      created_at: d.now,
      ...(p.deadline ? { deadline: p.deadline } : {}),
    };
    d.put("cards", card);
    const ids = new Map(
      template.work_items.map((w) => [
        w.key,
        d.ids.next(state.project_id, "work_item"),
      ]),
    );
    for (const w of template.work_items) {
      const itemId = ids.get(w.key);
      ensure(itemId, "invariant_violation", "Missing template item");
      const common = {
        id: itemId,
        card_id: id,
        title: w.title,
        role_id: w.role_id,
        required: w.required,
        depends_on: [],
        completion_criteria: [...acceptance, ...(w.completion_criteria ?? [])],
        template_key: w.key,
        status: "todo" as const,
      };
      if (w.kind === "produce")
        d.put("work_items", { ...common, kind: "produce" });
      else
        d.put("work_items", {
          ...common,
          kind: "verify",
          max_review_rounds: initialReviewMaxRounds(
            w.role_id,
            projectPreferences(d.state),
          ),
          ...(w.target_work_item_key !== undefined
            ? {
                target_work_item_id: ids.get(
                  w.target_work_item_key,
                ) as WorkItemId,
              }
            : {}),
        });
    }
    d.emit(
      "card_created",
      id,
      {
        card_id: id,
        template: template.id,
        template_version: template.version,
      },
      { type: "system", body: p.title },
    );
    return card;
  });
}
export function updateCard(
  state: CommandState,
  actor: Actor,
  p: {
    card_id: Card["id"];
    title?: string;
    goal?: string;
    acceptance_criteria?: readonly string[];
    priority?: number | string;
    status?: Card["status"];
    risk_tags?: Card["risk_tags"];
    high_risk?: boolean;
    /** C-160: add or update one pre-merge check; not mixed with other edits. */
    pre_merge_check?: PreMergeCheckInput;
    merge_classification?: MergeClassificationInput;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "update_card", ports, (d) => {
    d.pm();
    const card = d.card(p.card_id);
    if (p.merge_classification !== undefined) {
      ensure(
        Object.keys(p).every((key) =>
          ["card_id", "merge_classification"].includes(key),
        ),
        "validation_failed",
        "分类确认不能与其他卡片修改混用",
      );
      return applyMergeClassification(d, card, p.merge_classification);
    }
    if (p.pre_merge_check !== undefined) {
      ensure(
        p.title === undefined &&
          p.goal === undefined &&
          p.acceptance_criteria === undefined &&
          p.priority === undefined &&
          p.status === undefined &&
          p.risk_tags === undefined &&
          p.high_risk === undefined,
        "validation_failed",
        "pre_merge_check 不能与其他卡片修改混用",
      );
      return applyPreMergeCheck(d, card, p.pre_merge_check);
    }
    if (p.title !== undefined) text(p.title, "title");
    if (p.goal !== undefined) text(p.goal, "goal");
    if (p.high_risk !== undefined)
      ensure(
        d.actor.kind === "human" && typeof p.high_risk === "boolean",
        "unauthorized",
        "只有人能设置高危标记",
      );
    if (p.risk_tags !== undefined)
      ensure(
        Array.isArray(p.risk_tags) &&
          p.risk_tags.every((tag) =>
            ["security", "permission", "numeric_rule"].includes(tag),
          ),
        "validation_failed",
        "risk_tags 只接受 security、permission、numeric_rule 组成的数组；清空请传 []",
      );
    if (p.acceptance_criteria !== undefined)
      ensure(
        (!resolveCardTemplate(d, card).require_acceptance_criteria ||
          p.acceptance_criteria.length > 0) &&
          p.acceptance_criteria.every((s) => s.trim()),
        "validation_failed",
        "Acceptance criteria are required",
      );
    const priority = parseCardPriority(p.priority);
    if (p.priority !== undefined)
      ensure(priority !== undefined, "validation_failed", "Invalid priority");
    let status = card.status;
    if (p.status !== undefined) {
      ensure(
        ["backlog", "todo", "cancelled"].includes(p.status),
        "illegal_transition",
        "Card progress and completion are not manually writable",
      );
      if (p.status !== status)
        status = unwrap(
          transition(
            "card",
            status,
            p.status === "cancelled" ? "cancel" : `set_${p.status}`,
          ),
        );
    }
    const cancelledRunIds: RunId[] = [];
    if (status === "cancelled" && card.status !== "cancelled") {
      const items = d.list("work_items").filter((w) => w.card_id === card.id);
      const itemIds = new Set(items.map((w) => w.id));
      const owners = new Set(
        d
          .list("assignments")
          .filter((a) => a.scope === "work_item" && itemIds.has(a.work_item_id))
          .map((a) => a.id),
      );
      // Queued Runs have not been dispatched. Preserve runtime references;
      // in-flight launches recheck the card and Run before starting the Agent.
      for (const run of d.list("runs")) {
        if (run.status !== "queued" || !owners.has(run.assignment_id)) continue;
        d.put("runs", {
          ...run,
          status: unwrap(transition("run", run.status, "cancel")),
          outcome: "failed",
          summary: "卡片已取消，排队执行已取消",
          finished_at: d.now,
        });
        cancelledRunIds.push(run.id);
      }
      for (const item of items)
        if (
          item.status !== "cancelled" &&
          !(item.kind === "verify" && item.status === "passed")
        )
          d.put("work_items", d.move(item, "cancel"));
    }
    const result: Card = {
      ...card,
      status,
      ...(p.title !== undefined ? { title: p.title } : {}),
      ...(p.goal !== undefined ? { goal: p.goal } : {}),
      ...(p.high_risk !== undefined ? { high_risk: p.high_risk } : {}),
      ...(p.risk_tags !== undefined
        ? { risk_tags: [...new Set(p.risk_tags)] }
        : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(p.acceptance_criteria !== undefined
        ? { acceptance_criteria: p.acceptance_criteria }
        : {}),
    };
    d.put("cards", result);
    d.emit(
      "card_updated",
      card.id,
      {
        card_id: card.id,
        status,
        ...(p.high_risk !== undefined
          ? {
              previous_high_risk: card.high_risk ?? false,
              high_risk: p.high_risk,
            }
          : {}),
        ...(cancelledRunIds.length
          ? { cancelled_run_ids: cancelledRunIds }
          : {}),
        ...(p.risk_tags !== undefined
          ? {
              previous_risk_tags: card.risk_tags ?? [],
              risk_tags: result.risk_tags,
            }
          : {}),
      },
      { type: "status_change", body: result.title },
    );
    invalidateReviewReuse(d);
    if (p.risk_tags !== undefined || p.high_risk !== undefined)
      syncRiskTagMerge(d, d.card(card.id));
    return result;
  });
}
/** Human-only bookkeeping for closed cards; never reopens or cancels work. */
export function supersedeCard(
  state: CommandState,
  actor: Actor,
  p: { card_id: Card["id"]; superseded_by: Card["id"] },
  ports: CommandPorts,
) {
  return command(state, actor, "supersede_card", ports, (d) => {
    const card = d.card(p.card_id);
    ensure(
      card.status === "done" || card.status === "cancelled",
      "illegal_transition",
      "Only done or cancelled cards can be superseded",
    );
    ensure(
      p.superseded_by !== card.id,
      "validation_failed",
      "A card cannot supersede itself",
    );
    const replacement = d.card(p.superseded_by);
    if (
      card.resolution === "superseded" &&
      card.superseded_by === replacement.id
    )
      return card;
    const result: Card = {
      ...card,
      resolution: "superseded",
      superseded_by: replacement.id,
      related_cards: [...new Set([...card.related_cards, replacement.id])],
    };
    d.put("cards", result);
    d.emit(
      "card_superseded",
      card.id,
      { card_id: card.id, superseded_by: replacement.id },
      {
        type: "status_change",
        body: `已被 ${replacement.id} 取代`,
        refs: [{ kind: "card", id: replacement.id }],
      },
    );
    return result;
  });
}

export type CreateWorkItemParams = Pick<
  WorkItem,
  "card_id" | "title" | "kind" | "role_id" | "required" | "completion_criteria"
> & {
  depends_on?: readonly WorkItemId[];
  target_work_item_id?: WorkItemId;
  max_review_rounds?: number;
};
export function createWorkItem(
  state: CommandState,
  actor: Actor,
  p: CreateWorkItemParams,
  ports: CommandPorts,
) {
  return command(state, actor, "create_work_item", ports, (d) => {
    d.pm();
    const card = d.card(p.card_id);
    text(p.title, "title");
    ensure(
      card.status !== "done" && card.status !== "cancelled",
      "illegal_transition",
      "Card is closed",
    );
    ensure(
      state.roles.some((r) => r.role_id === p.role_id),
      "not_found",
      "Role is unknown",
    );
    ensure(
      p.kind === "produce" || p.kind === "verify",
      "validation_failed",
      "Unknown work item kind",
    );
    for (const id of p.depends_on ?? [])
      ensure(
        d.work(id).card_id === card.id,
        "validation_failed",
        "Dependency must belong to the same card",
      );
    if (p.target_work_item_id) {
      const target = d.work(p.target_work_item_id);
      ensure(
        p.kind === "verify" &&
          target.kind === "produce" &&
          target.card_id === card.id,
        "validation_failed",
        "Verification target must be a producing work item on this card",
      );
    }
    const independentReview = p.role_id === "independent_reviewer";
    const preferences = projectPreferences(d.state);
    const independentLimit = independentReviewMaxRounds(preferences);
    const max =
      p.max_review_rounds ?? initialReviewMaxRounds(p.role_id, preferences);
    ensure(
      Number.isSafeInteger(max) && max > 0,
      "validation_failed",
      "Invalid review limit",
    );
    ensure(
      !independentReview || max <= independentLimit || actor.kind === "human",
      "validation_failed",
      `独立复核的初始审核上限不能超过 ${independentLimit} 轮（项目偏好），只有人可以放宽`,
    );
    if (!independentReview && max > reviewMaxRounds(preferences))
      ensure(
        actor.kind === "human" ||
          (d.assignment?.scope === "standing" &&
            actor.kind === "assignment" &&
            !actor.allowed_tools.includes("record_decision")),
        "forbidden_tool",
        "Only PM Ops or the human may raise review limits",
      );
    const common = {
      id: d.ids.next(state.project_id, "work_item"),
      card_id: card.id,
      title: p.title,
      role_id: p.role_id,
      required: p.required,
      completion_criteria: p.completion_criteria,
      depends_on: [...new Set(p.depends_on ?? [])],
      status: "todo" as const,
    };
    const item: WorkItem =
      p.kind === "produce"
        ? { ...common, kind: "produce" }
        : {
            ...common,
            kind: "verify",
            max_review_rounds: max,
            ...(p.target_work_item_id
              ? { target_work_item_id: p.target_work_item_id }
              : {}),
          };
    d.put("work_items", item);
    d.emit(
      "work_item_created",
      card.id,
      { work_item_id: item.id },
      { type: "system", body: item.title, work_item_id: item.id },
    );
    return item;
  });
}
export function updateWorkItem(
  state: CommandState,
  actor: Actor,
  p: {
    work_item_id: WorkItemId;
    status?: WorkItem["status"];
    title?: string;
    completion_criteria?: readonly string[];
    required?: boolean;
    manual_assign?: boolean;
    max_review_rounds?: number;
    review_limit_decision?: ReviewLimitResolution;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "update_work_item", ports, (d) => {
    d.pm();
    const item = d.work(p.work_item_id);
    ensure(
      !item.replaced_by_work_item_id,
      "illegal_transition",
      "已被替换的验证项不能再修改",
    );
    const resume = item.status === "blocked" && p.status === "in_progress";
    const confirmReported =
      p.status === "in_progress" &&
      item.reported_blocker !== undefined &&
      ["blocked", "waiting_decision"].includes(item.status);
    ensure(
      p.status === undefined ||
        p.status === item.status ||
        resume ||
        confirmReported,
      "illegal_transition",
      "Work item progress must follow its workflow events",
    );
    if (p.title !== undefined) text(p.title, "title");
    ensure(
      p.manual_assign === undefined || typeof p.manual_assign === "boolean",
      "validation_failed",
      "manual_assign must be a boolean",
    );
    const card = d.card(item.card_id);
    ensure(
      card.status !== "done" && card.status !== "cancelled",
      "illegal_transition",
      "Card is closed",
    );
    if (p.review_limit_decision) {
      const {
        work_item_id: _id,
        review_limit_decision: resolution,
        ...updates
      } = p;
      ensure(
        Object.values(updates).every((v) => v === undefined),
        "validation_failed",
        "Review limit decisions cannot be combined with other updates",
      );
      return resolveReviewLimit(d, item, resolution);
    }
    ensure(
      !(item.template_key && p.required === false),
      "invariant_violation",
      "The development template's required items cannot be disabled",
    );
    if (p.max_review_rounds !== undefined) {
      ensure(
        item.kind === "verify" &&
          Number.isSafeInteger(p.max_review_rounds) &&
          p.max_review_rounds > 0,
        "validation_failed",
        "Only a verifier has a positive review limit",
      );
      ensure(
        actor.kind === "human" ||
          (d.assignment?.scope === "standing" &&
            actor.kind === "assignment" &&
            !actor.allowed_tools.includes("record_decision")),
        "forbidden_tool",
        "Only PM Ops or the human may change review limits",
      );
      ensure(
        p.max_review_rounds >= item.max_review_rounds,
        "validation_failed",
        "Review limits may only be relaxed",
      );
      const independentLimit = independentReviewMaxRounds(
        projectPreferences(d.state),
      );
      ensure(
        item.role_id !== "independent_reviewer" ||
          p.max_review_rounds <= independentLimit ||
          actor.kind === "human",
        "forbidden_tool",
        `独立复核超过 ${independentLimit} 轮（项目偏好）只能由人确认放宽`,
      );
    }
    let result: WorkItem = {
      ...item,
      ...(p.title !== undefined ? { title: p.title } : {}),
      ...(p.completion_criteria
        ? { completion_criteria: p.completion_criteria }
        : {}),
      ...(p.required !== undefined ? { required: p.required } : {}),
      ...(p.manual_assign !== undefined
        ? { manual_assign: p.manual_assign }
        : {}),
      ...(item.kind === "verify" && p.max_review_rounds !== undefined
        ? { max_review_rounds: p.max_review_rounds }
        : {}),
    };
    if (confirmReported) {
      const { reported_blocker: _confirmed, ...remaining } = result;
      result = remaining;
    }
    if (resume && !confirmReported)
      ensure(
        canResume(d, result),
        "illegal_transition",
        "Work item still has unresolved blockers or an exhausted review limit",
      );
    d.put("work_items", result);
    const resumed =
      resume ||
      confirmReported ||
      (item.status === "waiting_decision" &&
        item.kind === "verify" &&
        p.max_review_rounds !== undefined &&
        p.max_review_rounds > item.max_review_rounds)
        ? resumeWork(d, result)
        : undefined;
    if (resumed) result = resumed;
    const event = d.emit(
      "work_item_updated",
      item.card_id,
      {
        work_item_id: item.id,
        resume_work_items: resumed ? [item.id] : [],
        ...(p.manual_assign !== undefined
          ? {
              manual_assign: p.manual_assign,
              previous_manual_assign: item.manual_assign === true,
            }
          : {}),
        ...(confirmReported ? { reported_blocker_cleared: true } : {}),
        ...(p.max_review_rounds !== undefined
          ? { max_review_rounds: p.max_review_rounds }
          : {}),
      },
      {
        type: "status_change",
        body:
          p.manual_assign === undefined
            ? result.title
            : `${result.title}：${p.manual_assign ? "设置手动指派标记" : "清除手动指派标记"}`,
        work_item_id: item.id,
      },
    );
    if (p.max_review_rounds !== undefined && item.assignment_id) {
      const run = d
        .list("runs")
        .filter((r) => r.assignment_id === item.assignment_id)
        .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
      if (run)
        d.put("runs", {
          ...run,
          review_limit_changes: [
            ...(run.review_limit_changes ?? []),
            {
              event_id: event.id,
              max_review_rounds: p.max_review_rounds,
              actor: d.author,
              at: event.created_at,
            },
          ],
        });
    }
    if (resumed) queueResumedRun(d, item, event);
    invalidateReviewReuse(d);
    if (p.required !== undefined) syncRiskTagMerge(d, d.card(card.id));
    return result;
  });
}
export function assign(
  state: CommandState,
  actor: Actor,
  p: AssignWorkItemParams,
  ports: CommandPorts,
) {
  return command(state, actor, "assign", ports, (d) => {
    d.pm();
    return assignWorkItem(d, p);
  });
}
