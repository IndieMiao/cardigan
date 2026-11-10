import type { Card, Decider, RoleReference, WorkItem } from "./entities.js";
import type { RoleId } from "./ids.js";

export type TemplateWorkItem = {
  readonly key: string;
  readonly title: string;
  readonly role_id: RoleId;
  readonly required: boolean;
} & (
  | { readonly kind: "produce"; readonly target_work_item_key?: never }
  | { readonly kind: "verify"; readonly target_work_item_key?: string }
);
export interface CardTemplateDefinition {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly requires_repo: boolean;
  readonly merge: "none" | "confirm" | "auto";
  readonly require_acceptance_criteria: boolean;
  readonly work_items: readonly TemplateWorkItem[];
  readonly primary_work_item_key: string | null;
  readonly completion:
    | { readonly mode: "review"; readonly reviewer: Decider }
    | { readonly mode: "human_mark_done" };
}
export interface CardTemplate extends CardTemplateDefinition {
  readonly version: number;
  readonly builtin: boolean;
  readonly status: "active" | "inactive";
}
export const PM_ACCEPTANCE_WORK_ITEM_KEY = "pm_acceptance";
const acceptance = {
  key: PM_ACCEPTANCE_WORK_ITEM_KEY,
  title: "PM 验收",
  kind: "verify",
  role_id: "pm",
  required: true,
} as const;
export const developmentCardTemplate = {
  id: "dev",
  title: "开发卡",
  description: "开发、代码审核与完成验收",
  version: 1,
  builtin: true,
  status: "active",
  requires_repo: true,
  merge: "confirm",
  require_acceptance_criteria: true,
  primary_work_item_key: "development",
  completion: { mode: "review", reviewer: "role:pm" },
  work_items: [
    {
      key: "development",
      title: "开发",
      kind: "produce",
      role_id: "coder",
      required: true,
    },
    {
      key: "code_review",
      title: "代码审核",
      kind: "verify",
      role_id: "reviewer",
      required: true,
      target_work_item_key: "development",
    },
    acceptance,
  ],
} as const satisfies CardTemplate;
export const generalCardTemplate = {
  id: "general",
  title: "通用任务",
  description: "由人记录结果并标记完成",
  version: 1,
  builtin: true,
  status: "active",
  requires_repo: false,
  merge: "none",
  require_acceptance_criteria: false,
  primary_work_item_key: null,
  completion: { mode: "human_mark_done" },
  work_items: [],
} as const satisfies CardTemplate;
export const artifactCardTemplate = {
  id: "artifact",
  title: "产出物",
  description: "文件或文档产出与完成验收",
  version: 1,
  builtin: true,
  status: "active",
  requires_repo: false,
  merge: "none",
  require_acceptance_criteria: true,
  primary_work_item_key: "production",
  completion: { mode: "review", reviewer: "role:pm" },
  work_items: [
    {
      key: "production",
      title: "产出",
      kind: "produce",
      role_id: "designer",
      required: true,
    },
    acceptance,
  ],
} as const satisfies CardTemplate;
export const builtinCardTemplates: readonly CardTemplate[] = [
  developmentCardTemplate,
  generalCardTemplate,
  artifactCardTemplate,
];

/** Historical cards resolve v1; never silently use a newer definition. */
export function cardTemplate(
  card: Pick<Card, "template" | "template_version">,
  templates: readonly CardTemplate[] = [],
): CardTemplate | undefined {
  const version = card.template_version ?? 1;
  return [...templates, ...builtinCardTemplates].find(
    (t) => t.id === card.template && t.version === version,
  );
}
export function latestCardTemplate(
  templates: readonly CardTemplate[],
  id: string,
): CardTemplate | undefined {
  return templates
    .filter((t) => t.id === id)
    .sort((a, b) => b.version - a.version)[0];
}
export function isCompletionVerifier(
  template: CardTemplate,
  item: WorkItem,
): boolean {
  return (
    template.completion.mode === "review" &&
    item.kind === "verify" &&
    !item.target_work_item_id &&
    template.work_items.some(
      (w) =>
        w.key === item.template_key &&
        w.kind === "verify" &&
        !w.target_work_item_key,
    ) &&
    `role:${item.role_id}` === template.completion.reviewer
  );
}
/** Role references from pre-V9 databases have no status and remain active. */
export function activeTemplateRole(
  roles: readonly RoleReference[],
  id: string,
): RoleReference | undefined {
  const role = roles
    .filter((r) => r.role_id === id)
    .sort((a, b) => b.role_version - a.role_version)[0];
  return role?.status === "inactive" ? undefined : role;
}
