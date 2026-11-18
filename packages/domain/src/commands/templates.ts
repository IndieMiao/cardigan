import type { Actor } from "../entities.js";
import type { AttachmentId, CardId } from "../ids.js";
import { validateWorkItemRequirements } from "../machine-requirements.js";
import type { CardTemplate, CardTemplateDefinition } from "../templates.js";
import {
  activeTemplateRole,
  builtinCardTemplatesForFlow,
  builtinCardTemplateVersions,
  cardTemplate,
  latestCardTemplate,
} from "../templates.js";
import { transition } from "../transitions.js";
import { requireCardDependencies } from "./card-dependencies.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  text,
  unwrap,
} from "./core.js";
import { workCompleted } from "./work-status.js";

/** Phase 3 can replace this boundary without exposing editing tools to Agents today. */
export function canManageCardTemplates(actor: Actor): boolean {
  return actor.kind === "human";
}
export function canMarkCardDone(actor: Actor): boolean {
  return actor.kind === "human";
}
export function validateTemplateFlow(
  template: CardTemplate,
  version: number,
): void {
  ensure(
    template.completion.mode !== "review" ||
      template.completion.reviewer !== "system" ||
      version >= 5,
    "validation_failed",
    "系统汇总完成申请的模板需要流程版本第五级或更高",
  );
}
export function resolveCardTemplate(
  d: CommandDraft,
  card: Parameters<typeof cardTemplate>[0],
): CardTemplate {
  const template = cardTemplate(card, [
    ...(d.ports?.templates ?? []),
    ...d.list("card_templates"),
  ]);
  ensure(template, "not_found", "卡片使用的模板版本不存在");
  return template;
}
export function validateCardTemplate(
  definition: CardTemplateDefinition,
  roles: CommandState["roles"],
): void {
  ensure(
    definition &&
      typeof definition.id === "string" &&
      (definition.id === "fast_patch" ||
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(definition.id)),
    "validation_failed",
    "模板编号只能含小写字母、数字和短横线",
  );
  text(definition.title, "模板标题");
  ensure(
    typeof definition.description === "string" &&
      typeof definition.requires_repo === "boolean" &&
      typeof definition.require_acceptance_criteria === "boolean",
    "validation_failed",
    "模板描述和布尔字段不合法",
  );
  ensure(
    ["none", "confirm", "auto"].includes(definition.merge) &&
      (definition.merge === "none" || definition.requires_repo),
    "validation_failed",
    "需要合并的模板必须要求仓库",
  );
  ensure(
    Array.isArray(definition.work_items),
    "validation_failed",
    "模板工作项必须是数组",
  );
  const keys = new Set<string>();
  for (const w of definition.work_items) {
    ensure(
      w &&
        ["produce", "verify"].includes(w.kind) &&
        typeof w.required === "boolean",
      "validation_failed",
      "工作项类型或必需标记不合法",
    );
    if (w.requirements !== undefined)
      unwrap(validateWorkItemRequirements(w.requirements));
    text(w.key, "工作项 key");
    text(w.title, "工作项标题");
    ensure(
      w.completion_criteria === undefined ||
        (Array.isArray(w.completion_criteria) &&
          w.completion_criteria.every(
            (criterion: unknown) =>
              typeof criterion === "string" && criterion.trim(),
          )),
      "validation_failed",
      "工作项完成标准必须是非空文本数组",
    );
    ensure(!keys.has(w.key), "validation_failed", "工作项 key 必须唯一");
    keys.add(w.key);
    const role = activeTemplateRole(roles, w.role_id);
    ensure(role, "validation_failed", `角色 ${w.role_id} 未登记或已停用`);
    // Legacy roles did not declare work-item capabilities; this grants no tools.
    ensure(
      role.capabilities.length === 0 ||
        role.allowed_tools.includes(
          w.kind === "produce" ? "submit_delivery" : "submit_review",
        ),
      "validation_failed",
      `角色 ${w.role_id} 不能承担${w.kind === "produce" ? "产出" : "验证"}`,
    );
    if (w.target_work_item_key !== undefined)
      ensure(
        w.kind === "verify" &&
          definition.work_items.some(
            (t) => t.key === w.target_work_item_key && t.kind === "produce",
          ),
        "validation_failed",
        "验证目标必须是同模板的产出项",
      );
  }
  ensure(
    definition.primary_work_item_key === null ||
      definition.work_items.some(
        (w) =>
          w.key === definition.primary_work_item_key && w.kind === "produce",
      ),
    "validation_failed",
    "主产出 key 必须指向产出项或为空",
  );
  const completion = definition.completion;
  ensure(
    completion && ["review", "human_mark_done"].includes(completion.mode),
    "validation_failed",
    "完成方式不合法",
  );
  if (completion.mode === "review") {
    ensure(
      definition.primary_work_item_key !== null,
      "validation_failed",
      "审核完成必须有主产出项",
    );
    ensure(
      completion.reviewer === "human" ||
        completion.reviewer === "system" ||
        (typeof completion.reviewer === "string" &&
          /^role:.+/.test(completion.reviewer)),
      "validation_failed",
      "完成审核者不合法",
    );
    if (completion.reviewer === "system") {
      ensure(
        !definition.work_items.some(
          (w) => w.kind === "verify" && !w.target_work_item_key,
        ),
        "validation_failed",
        "系统汇总模板不能包含无产出目标的完成验收项",
      );
    } else if (completion.reviewer !== "human") {
      const role = activeTemplateRole(roles, completion.reviewer.slice(5));
      ensure(
        role &&
          (role.capabilities.length === 0 ||
            role.allowed_tools.includes("submit_review")),
        "validation_failed",
        "完成审核角色未登记、停用或不能验证",
      );
      ensure(
        definition.work_items.some(
          (w) =>
            w.kind === "verify" &&
            !w.target_work_item_key &&
            w.required &&
            `role:${w.role_id}` === completion.reviewer,
        ),
        "validation_failed",
        "完成审核必须有该角色的必需验收项",
      );
    }
  }
}
export type TemplateChange =
  | { action: "add" | "update"; definition: CardTemplateDefinition }
  | { action: "copy"; template_id: string; new_id: string; version?: number }
  | { action: "activate" | "deactivate"; template_id: string }
  | { action: "rollback"; template_id: string; version: number };
export function manageCardTemplate(
  state: CommandState,
  actor: Actor,
  p: TemplateChange,
  ports: CommandPorts,
) {
  return command(state, actor, "manage_templates", ports, (d) => {
    ensure(
      canManageCardTemplates(actor),
      "forbidden_tool",
      "只有人能管理卡片模板",
    );
    const templates = [
      ...d.list("card_templates"),
      ...builtinCardTemplateVersions,
    ];
    const id =
      "definition" in p
        ? p.definition.id
        : p.action === "copy"
          ? p.new_id
          : p.template_id;
    const current = latestCardTemplate(templates, id);
    const adding = p.action === "add" || p.action === "copy";
    ensure(
      adding ? !current : current,
      "validation_failed",
      adding ? "模板编号已存在" : "模板不存在",
    );
    ensure(
      !current?.builtin &&
        !builtinCardTemplateVersions.some((t) => t.id === id),
      "validation_failed",
      "内置模板不能修改，请先复制成新编号",
    );
    let definition: CardTemplateDefinition;
    if ("definition" in p) definition = p.definition;
    else if (p.action === "copy" || p.action === "rollback") {
      const source =
        p.version === undefined
          ? (latestCardTemplate(
              [
                ...d.list("card_templates"),
                ...builtinCardTemplatesForFlow(
                  state.project_preferences?.find(
                    (p) => p.id === state.project_id,
                  )?.flow_version,
                ),
              ],
              p.template_id,
            ) ?? latestCardTemplate(templates, p.template_id))
          : templates.find(
              (t) => t.id === p.template_id && t.version === p.version,
            );
      ensure(source, "not_found", "源模板版本不存在");
      definition = { ...source, id };
    } else {
      ensure(current, "not_found", "模板不存在");
      definition = current;
    }
    if (p.action !== "deactivate")
      validateCardTemplate(definition, state.roles);
    // Select fields explicitly: YAML cannot smuggle lifecycle metadata into a version.
    const template: CardTemplate = {
      id,
      title: definition.title,
      description: definition.description,
      requires_repo: definition.requires_repo,
      merge: definition.merge,
      require_acceptance_criteria: definition.require_acceptance_criteria,
      work_items: definition.work_items,
      primary_work_item_key: definition.primary_work_item_key,
      completion: definition.completion,
      version: (current?.version ?? 0) + 1,
      builtin: false,
      status:
        p.action === "deactivate"
          ? "inactive"
          : p.action === "activate" || adding
            ? "active"
            : (current?.status ?? "active"),
    };
    d.put("card_templates", template);
    d.emit("card_template_changed", undefined, {
      template_id: id,
      version: template.version,
      action: p.action,
    });
    return template;
  });
}
export function markCardDone(
  state: CommandState,
  actor: Actor,
  p: { card_id: CardId; result: string; attachments?: readonly AttachmentId[] },
  ports: CommandPorts,
) {
  return command(state, actor, "mark_card_done", ports, (d) => {
    ensure(canMarkCardDone(actor), "forbidden_tool", "只有人能标记卡片完成");
    const card = d.card(p.card_id);
    ensure(!card.hold, "illegal_transition", "卡片已暂停，请先解除暂停");
    requireCardDependencies(d, card);
    ensure(
      resolveCardTemplate(d, card).completion.mode === "human_mark_done",
      "illegal_transition",
      "该模板不允许人标记完成",
    );
    text(p.result, "完成结果");
    ensure(
      d
        .list("work_items")
        .filter((w) => w.card_id === card.id && w.required)
        .every(workCompleted),
      "invariant_violation",
      "必需工作项尚未全部完成",
    );
    for (const id of p.attachments ?? [])
      ensure(
        d.get("attachments", id).card_id === card.id,
        "validation_failed",
        "证据附件不属于此卡片",
      );
    const next = {
      ...card,
      status: unwrap(transition("card", card.status, "human_mark_done")),
      resolution: "done" as const,
    };
    d.put("cards", next);
    d.emit(
      "card_marked_done",
      card.id,
      {
        card_id: card.id,
        result: p.result.trim(),
        attachments: p.attachments ?? [],
      },
      { type: "status_change", body: p.result.trim() },
    );
    return next;
  });
}
