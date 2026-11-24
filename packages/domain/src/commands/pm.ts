import { cardDependenciesAllowStart } from "../card-dependencies.js";
import type {
  Actor,
  Assignment,
  Card,
  MergeClassificationInput,
  UiStateAndSave,
  WorkItem,
} from "../entities.js";
import type { Result } from "../errors.js";
import { eventsOfType } from "../event-index.js";
import { projectFlowVersion, validFlowVersion } from "../flow.js";
import type { RunId, WorkItemId } from "../ids.js";
import {
  mergeMachineRequirements,
  type WorkItemRequirements,
} from "../machine-requirements.js";
import {
  humanCardTemplates,
  independentReviewMaxRounds,
  initialReviewMaxRounds,
  reviewMaxRounds,
} from "../preferences.js";
import { parseCardPriority } from "../priority.js";
import { storyProgress, storyTerminal } from "../story.js";
import {
  builtinCardTemplatesForFlow,
  type CardTemplate,
  isStoryTemplate,
  latestCardTemplate,
  requiresUiStateAndSave,
} from "../templates.js";
import { transition } from "../transitions.js";
import {
  type AssignWorkItemParams,
  assignWorkItem,
} from "./assign-work-item.js";
import {
  applyCardDependencies,
  type CardDependencyInput,
  dependencyChangeNotice,
  dependencyState,
  requireCardDependencyStart,
} from "./card-dependencies.js";
import { applyCardHold, type CardHoldInput } from "./card-hold.js";
import {
  type CommandDraft,
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  ensure,
  text,
  unwrap,
} from "./core.js";
import { recordFrameworkLinks } from "./framework-dependencies.js";
import { cancelCardHumanActions } from "./human-action-lifecycle.js";
import { bindRequiredVerifier } from "./late-verifier.js";
import { syncRiskTagMerge } from "./merge.js";
import { applyMergeClassification } from "./merge-classification.js";
import {
  applyPreMergeCheck,
  type PreMergeCheckInput,
} from "./pre-merge-checks.js";
import { projectPreferences } from "./preferences.js";
import { deferResume } from "./resume-attention.js";
import {
  queueResumedRun,
  resumeBlockReason,
  resumeWork,
} from "./resumption.js";
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
      | "parent_card_id"
      | "deadline"
      | "template"
      | "acceptance_criteria"
      | "state_and_save"
    >
  > &
  CardDependencyInput & {
    readonly template_id?: string;
    readonly work_item_requirements?: Readonly<
      Record<string, WorkItemRequirements>
    >;
    readonly priority?: number | string;
  };
function stateAndSaveCriterion(
  plan: UiStateAndSave | undefined,
  required: boolean,
): string | undefined {
  if (!required && plan === undefined) return undefined;
  ensure(
    required,
    "validation_failed",
    "填写状态与保存请选择有设计总监验收的界面或设计模板",
  );
  if (plan === "无写入") return undefined;
  ensure(
    plan && typeof plan === "object" && !Array.isArray(plan),
    "validation_failed",
    "请填写状态与保存（state_and_save）：保存时机、离页行为、失败提示和读写一致性；纯展示填“无写入”",
  );
  const labels = {
    save_timing: "保存时机",
    leave_behavior: "离页行为",
    failure_feedback: "失败提示",
    consistency: "读写一致性",
  } as const;
  ensure(
    Object.keys(plan).every((key) => Object.hasOwn(labels, key)),
    "validation_failed",
    "状态与保存只接受保存时机、离页行为、失败提示和读写一致性",
  );
  const fields = Object.entries(labels).map(([key, label]) => {
    const value = plan[key as keyof typeof labels];
    ensure(
      typeof value === "string" && value.trim(),
      "validation_failed",
      `状态与保存：请填写${label}`,
    );
    return `${label}：${value}`;
  });
  return `设计验收须确认状态与保存：${fields.join("；")}`;
}

/** The latest active template a new card may use, resolved like `create_card`. */
export function creatableCardTemplate(
  d: CommandDraft,
  templateId: string,
): CardTemplate {
  const state = d.state;
  const template =
    latestCardTemplate(d.ports?.templates ?? [], templateId) ??
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
  ensure(template.status === "active", "validation_failed", "停用模板不能建卡");
  return template;
}

export function createCard(
  state: CommandState,
  actor: Actor,
  p: CreateCardParams,
  ports: CommandPorts,
) {
  return command(state, actor, "create_card", ports, (d) =>
    createCardInDraft(d, p),
  );
}

/**
 * C-684: `create_card` from the people's entry points (Workbench and the local
 * CLI). A person may only use the templates the project opened to people
 * (story by default); Agents, PM and the system keep `createCard`, and story
 * children opened from a confirmed proposal go through `createCardInDraft`.
 */
export function createHumanCard(
  state: CommandState,
  actor: Actor,
  p: CreateCardParams,
  ports: CommandPorts,
) {
  return command(state, actor, "create_card", ports, (d) => {
    if (actor.kind === "human") {
      const template = creatableCardTemplate(
        d,
        p.template_id ?? p.template ?? "dev",
      );
      const allowed = humanCardTemplates(projectPreferences(d.state));
      if (!allowed.includes(template.id)) {
        const titles = allowed.map((id) => {
          try {
            return creatableCardTemplate(d, id).title;
          } catch {
            return id;
          }
        });
        ensure(
          false,
          "validation_failed",
          `人只能开${titles.join("、")}；“${template.title}”需由所有者在设置 → 偏好 → 人可开的卡片模板中放开`,
        );
      }
    }
    return createCardInDraft(d, p);
  });
}

export interface CardCreationOptions {
  /**
   * Story children may name only a repository registered for this project
   * (C-587); plain create_card keeps its explicit repo + branch semantics.
   */
  readonly registered_repo_only?: boolean;
}

/** Check the creation form without allocating IDs or changing the draft. */
export function prepareCardCreation(
  d: CommandDraft,
  p: CreateCardParams,
  options: CardCreationOptions = {},
) {
  const state = d.state;
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
  const template = creatableCardTemplate(d, templateId);
  const story = isStoryTemplate(template);
  validateCardTemplate(template, state.roles, { story });
  ensure(
    p.work_item_requirements === undefined ||
      (p.work_item_requirements !== null &&
        typeof p.work_item_requirements === "object" &&
        !Array.isArray(p.work_item_requirements) &&
        Object.keys(p.work_item_requirements).every((key) =>
          template.work_items.some((w) => w.key === key),
        )),
    "validation_failed",
    "work_item_requirements 必须按模板工作项 key 指定需求",
  );
  const registry = d.ports?.project_repositories;
  const only = registry?.length === 1 ? registry[0] : undefined;
  const repo =
    p.repo ??
    (template.requires_repo || p.base_branch !== undefined
      ? only?.repo
      : undefined);
  // Only the registration naming this very repository may supply its branch.
  const registration =
    repo === undefined ? undefined : registry?.find((r) => r.repo === repo);
  const base_branch = p.base_branch ?? registration?.base_branch ?? undefined;
  if (template.requires_repo || repo !== undefined) text(repo, "repo");
  ensure(
    !options.registered_repo_only ||
      registry === undefined ||
      repo === undefined ||
      registration !== undefined,
    "validation_failed",
    `仓库（repo）${repo} 不是当前项目登记的仓库`,
  );
  if (template.requires_repo || repo !== undefined || base_branch !== undefined)
    text(base_branch, "base_branch");
  ensure(
    base_branch === undefined || repo !== undefined,
    "validation_failed",
    "基线分支需要仓库（repo）",
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
  const priority = parseCardPriority(p.priority === undefined ? 0 : p.priority);
  ensure(priority !== undefined, "validation_failed", "Invalid priority");
  for (const id of p.related_cards ?? []) d.card(id);
  const flow_version = projectFlowVersion(projectPreferences(state));
  ensure(
    validFlowVersion(flow_version),
    "validation_failed",
    "项目流程版本尚未开放",
  );
  validateTemplateFlow(template, flow_version);
  const saveCriterion = stateAndSaveCriterion(
    p.state_and_save,
    requiresUiStateAndSave(template),
  );
  const parent =
    p.parent_card_id === undefined ? undefined : d.card(p.parent_card_id);
  if (parent) {
    ensure(
      !story &&
        parent.story &&
        !parent.parent_card_id &&
        !storyTerminal(parent),
      "validation_failed",
      "父卡必须是同项目未结束的需求卡，需求卡不能作为子卡",
    );
  }
  return {
    acceptance,
    template,
    story,
    flow_version,
    priority,
    saveCriterion,
    parent,
    repo,
    base_branch,
  };
}

/**
 * The whole of `create_card` inside an existing draft, so one command can open
 * several cards and roll every one of them back together (C-503).
 */
export function createCardInDraft(
  d: CommandDraft,
  p: CreateCardParams & { readonly story_source?: Card["story_source"] },
  options: CardCreationOptions = {},
): Card {
  const state = d.state;
  {
    const {
      acceptance,
      template,
      story,
      flow_version,
      priority,
      saveCriterion,
      parent,
      repo,
      base_branch,
    } = prepareCardCreation(d, p, options);
    if (parent?.story) {
      if (parent.story.summary_entry_id) {
        const { summary_entry_id: _old, ...story } = parent.story;
        d.put("cards", { ...parent, story });
      }
      const item = d
        .list("work_items")
        .find(
          (w) => w.card_id === parent.id && w.template_key === "decomposition",
        );
      if (
        item &&
        (item.status === "delivered" ||
          (item.status === "todo" &&
            !parent.hold &&
            parent.status !== "backlog"))
      )
        d.put("work_items", d.move(item, "story_child_added"));
    }
    const id = d.ids.next(state.project_id, "card");
    let card: Card = {
      id,
      project_id: state.project_id,
      title: p.title,
      goal: p.goal,
      ...(p.state_and_save === undefined
        ? {}
        : { state_and_save: p.state_and_save }),
      acceptance_criteria: [...acceptance],
      source: p.source,
      ...(repo === undefined ? {} : { repo }),
      ...(base_branch === undefined ? {} : { base_branch }),
      ...(story ? { story: {} } : {}),
      ...(p.parent_card_id ? { parent_card_id: p.parent_card_id } : {}),
      ...(p.story_source ? { story_source: p.story_source } : {}),
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
    card = applyCardDependencies(d, card, p);
    if (
      !card.early_start &&
      (card.wait_for_dependencies ||
        !cardDependenciesAllowStart(dependencyState(d), card))
    )
      card = { ...card, status: "backlog" };
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
        completion_criteria: [
          ...acceptance,
          ...(w.completion_criteria ?? []),
          ...(saveCriterion &&
          (w.key === template.primary_work_item_key ||
            (w.role_id === "design_director" &&
              w.target_work_item_key === template.primary_work_item_key))
            ? [saveCriterion]
            : []),
        ],
        template_key: w.key,
        ...(w.requirements === undefined &&
        p.work_item_requirements?.[w.key] === undefined
          ? {}
          : {
              requirements: unwrap(
                mergeMachineRequirements(
                  w.requirements,
                  p.work_item_requirements?.[w.key],
                ),
              ),
            }),
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
        ...(card.parent_card_id ? { parent_card_id: card.parent_card_id } : {}),
        template_version: template.version,
        ...(p.is_ui_framework !== undefined
          ? { is_ui_framework: p.is_ui_framework }
          : {}),
        ...(card.depends_on_cards
          ? { depends_on_cards: card.depends_on_cards }
          : {}),
        ...(p.early_start !== undefined
          ? {
              early_start: card.early_start ?? null,
              dependency_reason: p.dependency_reason ?? "",
            }
          : {}),
      },
      { type: "system", body: dependencyChangeNotice(card, p) },
    );
    if (card.parent_card_id)
      d.emit(
        "story_child_added",
        card.parent_card_id,
        { child_card_id: card.id },
        {
          type: "system",
          body: `已关联子卡 ${card.id}`,
          refs: [{ kind: "card", id: card.id }],
        },
      );
    recordFrameworkLinks(d, card);
    return card;
  }
}
export interface StoryChildChoice {
  readonly action: "cancel" | "detach";
  readonly ids: readonly Card["id"][];
}
function cancelCardWork(d: CommandDraft, card: Card) {
  const cancelledRunIds: RunId[] = [];
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
  return cancelledRunIds;
}
function settleStoryChildren(
  d: CommandDraft,
  parent: Card,
  choice?: StoryChildChoice,
) {
  const active = storyProgress(d.list("cards"), parent).children.filter(
    (c) => !storyTerminal(c),
  );
  if (!choice && !active.length) return;
  ensure(
    choice &&
      ["detach", "cancel"].includes(choice.action) &&
      Array.isArray(choice.ids) &&
      choice.ids.length === active.length &&
      active.every((c) => choice.ids.includes(c.id)),
    "validation_failed",
    `请确认未结束子卡并选择一并取消或保留脱离：${active.map((c) => c.id).join("、") || "无"}`,
  );
  for (const { id } of active) {
    const child = d.card(id);
    if (choice.action === "detach") {
      const { parent_card_id: _, ...detached } = child;
      d.put("cards", detached);
      d.emit(
        "story_child_detached",
        id,
        { parent_card_id: parent.id },
        { type: "status_change", body: `已脱离取消的需求卡 ${parent.id}` },
      );
    } else {
      const cancelled_run_ids = cancelCardWork(d, child);
      d.put("cards", {
        ...child,
        status: unwrap(transition("card", child.status, "cancel")),
      });
      cancelCardHumanActions(d, id);
      d.emit(
        "card_updated",
        id,
        {
          card_id: id,
          status: "cancelled",
          cancelled_run_ids,
          parent_card_id: parent.id,
        },
        { type: "status_change", body: `随需求卡 ${parent.id} 一并取消` },
      );
    }
  }
}
export function updateCard(
  state: CommandState,
  actor: Actor,
  p: CardDependencyInput & {
    card_id: Card["id"];
    title?: string;
    goal?: string;
    acceptance_criteria?: readonly string[];
    priority?: number | string;
    deadline?: string | null;
    status?: Card["status"];
    story_children?: StoryChildChoice;
    risk_tags?: Card["risk_tags"];
    high_risk?: boolean;
    hold?: CardHoldInput;
    /** C-160: add or update one pre-merge check; not mixed with other edits. */
    pre_merge_check?: PreMergeCheckInput;
    merge_classification?: MergeClassificationInput;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "update_card", ports, (d) => {
    d.pm();
    const card = d.card(p.card_id);
    if (p.story_children !== undefined)
      ensure(
        card.story && p.status === "cancelled",
        "validation_failed",
        "子卡选择只用于取消需求卡",
      );
    if (card.story && p.status === "cancelled")
      ensure(actor.kind === "human", "unauthorized", "只有人能取消需求卡");
    if (p.hold !== undefined) {
      ensure(
        Object.keys(p).every((key) => ["card_id", "hold"].includes(key)),
        "validation_failed",
        "暂停操作不能与其他卡片修改混用",
      );
      return applyCardHold(d, card, p.hold);
    }
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
          p.deadline === undefined &&
          p.status === undefined &&
          p.is_ui_framework === undefined &&
          p.depends_on_cards === undefined &&
          p.wait_for_dependencies === undefined &&
          p.early_start === undefined &&
          p.dependency_reason === undefined &&
          p.risk_tags === undefined &&
          p.high_risk === undefined,
        "validation_failed",
        "pre_merge_check 不能与其他卡片修改混用",
      );
      return applyPreMergeCheck(d, card, p.pre_merge_check);
    }
    if (p.title !== undefined) text(p.title, "title");
    if (p.goal !== undefined) text(p.goal, "goal");
    if (p.deadline != null) text(p.deadline, "deadline");
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
    const dependencyCard = applyCardDependencies(d, card, p);
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
      if (p.status === "todo") {
        ensure(!card.hold, "illegal_transition", "卡片已暂停，请先解除暂停");
        requireCardDependencyStart(d, dependencyCard);
      }
    }
    const cancelling = status === "cancelled" && card.status !== "cancelled";
    if (cancelling && card.story)
      settleStoryChildren(d, card, p.story_children);
    const cancelledRunIds = cancelling ? cancelCardWork(d, card) : [];
    const { deadline: previousDeadline, ...base } = dependencyCard;
    const deadline = p.deadline === undefined ? previousDeadline : p.deadline;
    const result: Card = {
      ...base,
      ...(deadline == null ? {} : { deadline }),
      status,
      ...(p.status !== undefined &&
      p.wait_for_dependencies === undefined &&
      card.wait_for_dependencies === true
        ? { wait_for_dependencies: false }
        : {}),
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
    if (status === "cancelled") cancelCardHumanActions(d, card.id);
    const notes = [dependencyChangeNotice(result, p)];
    if (p.deadline !== undefined && p.deadline !== (previousDeadline ?? null))
      notes.push(
        p.deadline === null ? "截止日期已清除" : `截止日期：${p.deadline}`,
      );
    d.emit(
      "card_updated",
      card.id,
      {
        card_id: card.id,
        status,
        ...(p.deadline !== undefined
          ? {
              previous_deadline: previousDeadline ?? null,
              deadline: p.deadline,
            }
          : {}),
        ...(p.is_ui_framework !== undefined
          ? { is_ui_framework: p.is_ui_framework }
          : {}),
        ...(p.depends_on_cards !== undefined
          ? {
              previous_depends_on_cards: card.depends_on_cards ?? [],
              depends_on_cards: result.depends_on_cards ?? [],
            }
          : {}),
        ...(p.wait_for_dependencies !== undefined
          ? { wait_for_dependencies: p.wait_for_dependencies }
          : {}),
        ...(p.early_start !== undefined
          ? {
              early_start: result.early_start ?? null,
              dependency_reason: p.dependency_reason ?? "",
            }
          : {}),
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
      { type: "status_change", body: notes.join("\n") },
    );
    recordFrameworkLinks(d, result, card);
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
  requirements?: WorkItemRequirements;
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
    ensure(!card.story, "illegal_transition", "需求卡只有常驻 Office 的拆解项");
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
      ...(p.requirements === undefined
        ? {}
        : { requirements: unwrap(mergeMachineRequirements(p.requirements)) }),
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
    return bindRequiredVerifier(d, item);
  });
}
export function updateWorkItem(
  state: CommandState,
  actor: Actor,
  p: {
    work_item_id: WorkItemId;
    requirements?: WorkItemRequirements;
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
      ...(p.requirements === undefined
        ? {}
        : {
            requirements: unwrap(
              mergeMachineRequirements(
                item.template_key
                  ? resolveCardTemplate(d, card).work_items.find(
                      (w) => w.key === item.template_key,
                    )?.requirements
                  : undefined,
                p.requirements,
              ),
            ),
          }),
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
    if (resume || confirmReported) {
      const reason = resumeBlockReason(d, result);
      // A status-only confirmation may clear the reported blocker independently.
      // For a mixed request either all fields take effect or none do. The reason
      // is an audit fact, not a partial update to the item.
      const compound = Object.keys(p).some(
        (key) => key !== "status" && key !== "work_item_id",
      );
      if (reason && (!confirmReported || compound)) {
        deferResume(d, item, reason);
        return item;
      }
    }
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
        ...(p.requirements === undefined
          ? {}
          : {
              requirements: { ...result.requirements },
              previous_requirements: { ...item.requirements },
            }),
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
    else if (confirmReported || resume) {
      const reason = resumeBlockReason(d, result);
      if (reason) deferResume(d, result, reason, event.id);
    }
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

/** Interactive entry points commit a PM handoff, not an empty/partial Assignment, on zero matches. */
export function assignOrDefer(
  ...args: Parameters<typeof assign>
): Result<CommandEffect<Assignment | { deferred: true; reason: string }>> {
  const result = assign(...args);
  if (result.ok || !result.error.details?.no_matching_machine) return result;
  const [state, actor, p, ports] = args;
  const reason = result.error.message;
  return command(state, actor, "assign", ports, (d) => {
    d.pm();
    const item = d.work(p.work_item_id);
    const body = `未能为 ${item.id} 选机，请 PM 安排：${reason}`;
    const previous = eventsOfType(
      state.events,
      "system_assignment_deferred",
    ).findLast(
      (e) =>
        e.card_id === item.card_id &&
        (e.payload as Record<string, unknown>).work_item_id === item.id &&
        (e.payload as Record<string, unknown>).interactive === true,
    );
    if (
      !previous ||
      (previous.payload as Record<string, unknown>).reason !== reason
    )
      d.emit(
        "system_assignment_deferred",
        item.card_id,
        { work_item_id: item.id, interactive: true, reason, body },
        { type: "system", work_item_id: item.id, body },
      );
    return { deferred: true as const, reason };
  });
}
