import type { Card, Decider, RoleReference, WorkItem } from "./entities.js";
import type { RoleId } from "./ids.js";

export type TemplateWorkItem = {
  readonly requirements?: import("./machine-requirements.js").WorkItemRequirements;
  readonly key: string;
  readonly title: string;
  readonly role_id: RoleId;
  readonly required: boolean;
  readonly completion_criteria?: readonly string[];
  /** C-612: keys of same-template items this one waits for (set as `depends_on`). */
  readonly depends_on?: readonly string[];
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
  readonly story?: true;
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
/** Flow v2 B3b: registered separately when the fifth flow level is enabled. */
export const developmentCardTemplateV2 = {
  ...developmentCardTemplate,
  version: 2,
  description: "工程开发与代码审核，由系统汇总完成申请",
  completion: { mode: "review", reviewer: "system" },
  work_items: [
    developmentCardTemplate.work_items[0],
    {
      ...developmentCardTemplate.work_items[1],
      completion_criteria: [
        "逐条对照验收标准；测试范围为本地相关测试 + 远程预检通过",
      ],
    },
  ],
} as const satisfies CardTemplate;
/** UI implementation follows the same Flow Lite completion path as dev@2. */
export const uiCardTemplate = {
  ...developmentCardTemplateV2,
  id: "ui",
  version: 1,
  title: "界面卡",
  description:
    "界面卡默认使用：前端开发、按规范清单设计验收与代码审核；已有界面卡不迁移",
  work_items: [
    {
      ...developmentCardTemplateV2.work_items[0],
      title: "前端开发",
      role_id: "frontend_engineer",
      completion_criteria: [
        "按 docs/design/ui-guidelines.md 的界面验收清单逐条自查，附 1440/390 亮暗主题的前后截图、与卡片页同宽同主题的并排截图和关键测量",
      ],
    },
    {
      key: "design_review",
      title: "界面验收",
      kind: "verify",
      role_id: "design_director",
      required: true,
      target_work_item_key: "development",
      completion_criteria: [
        "逐条对照 docs/design/ui-guidelines.md 的界面验收清单与基准截图，给出通过/不通过/未核、截图证据和测量值；绑定当前交付与完整 SHA",
      ],
    },
    developmentCardTemplateV2.work_items[1],
  ],
} as const satisfies CardTemplate;
/** Evidence is checked against trusted probe events before a product can be delivered. */
export const integrationCardTemplate = {
  ...developmentCardTemplateV2,
  id: "integration",
  version: 1,
  title: "集成验证",
  description: "开发、当前版本真实冒烟附件、代码审核与合并",
  work_items: [
    {
      ...developmentCardTemplateV2.work_items[0],
      completion_criteria: [
        "提交当前任务与版本的主机真实冒烟附件，确认资源清理完成",
      ],
    },
    developmentCardTemplateV2.work_items[1],
  ],
} as const satisfies CardTemplate;
export const productCardTemplate = {
  ...developmentCardTemplate,
  id: "product",
  title: "产品卡",
  description: "产品与界面开发、代码审核和 PM 完成验收；界面卡另补设计验收",
  work_items: [...developmentCardTemplateV2.work_items, acceptance],
} as const satisfies CardTemplate;
export const fastPatchCardTemplate = {
  ...developmentCardTemplateV2,
  id: "fast_patch",
  version: 1,
  title: "快速补丁",
  description: "单人开发与子进程自审，系统汇总；高危改动自动转普通通道",
  work_items: [developmentCardTemplate.work_items[0]],
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
export const storyCardTemplate = {
  ...generalCardTemplate,
  id: "story",
  story: true,
  title: "需求卡",
  description: "由 Office 拆解需求，人确认完成",
  work_items: [
    {
      key: "decomposition",
      title: "拆解",
      kind: "produce",
      role_id: "pm",
      required: true,
    },
  ],
} as const satisfies CardTemplate;
/** Only immutable, store-registered templates carry story behavior. */
export function isStoryTemplate(template: CardTemplate): boolean {
  return (
    template.builtin && (template.story === true || template.id === "story")
  );
}
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
      // p2v-12 §2.3: the default `designer` role is verify-only and cannot
      // produce; projects that registered a produce `designer` keep their
      // stored v1 template.
      role_id: "ui_ux_designer",
      required: true,
    },
    acceptance,
  ],
} as const satisfies CardTemplate;
/** p2v-12 §2.4: design draft → design director review → human approval. */
export const designCardTemplate = {
  id: "design",
  title: "设计稿",
  description: "界面与交互设计、设计总监审核，由人拍板",
  version: 1,
  builtin: true,
  status: "active",
  requires_repo: false,
  merge: "none",
  require_acceptance_criteria: true,
  primary_work_item_key: "design_production",
  completion: { mode: "review", reviewer: "human" },
  work_items: [
    {
      key: "design_production",
      title: "设计产出",
      kind: "produce",
      role_id: "ui_ux_designer",
      required: true,
    },
    {
      key: "design_review",
      title: "设计审核",
      kind: "verify",
      role_id: "design_director",
      required: true,
      target_work_item_key: "design_production",
    },
    // No pm_acceptance: the human completion review below is the acceptance
    // (plan §2.4 "人拍板，不是 PM"). A required verify item without a target
    // can review neither the design nor a human-reviewed completion request.
  ],
} as const satisfies CardTemplate;
/**
 * C-612 packaging card: build → signing → smoke → publication → release
 * notes, each step waiting for the previous one. One release-chain approval
 * covers the intake, signing, signed intake and publication steps.
 */
export const releaseCardTemplate = {
  id: "release",
  title: "打包发布",
  description: "出包、送签、冒烟、外发与版本说明，按发布链一次授权",
  version: 1,
  builtin: true,
  status: "active",
  requires_repo: true,
  merge: "none",
  require_acceptance_criteria: true,
  primary_work_item_key: "build",
  completion: { mode: "review", reviewer: "role:pm" },
  work_items: [
    {
      key: "build",
      title: "出包",
      kind: "produce",
      role_id: "release_ops",
      required: true,
      completion_criteria: [
        "未签名包以发布链拍板为依据入库，摘要与发布链绑定的未签名摘要一致",
      ],
    },
    {
      key: "signing",
      title: "送签",
      kind: "produce",
      role_id: "release_ops",
      required: true,
      depends_on: ["build"],
      completion_criteria: ["按发布链送签；签后包由系统入库并绑定回执摘要"],
    },
    {
      key: "smoke",
      title: "冒烟",
      kind: "produce",
      role_id: "release_ops",
      required: true,
      depends_on: ["signing"],
      completion_criteria: ["用签后入库的包冒烟，附结果"],
    },
    {
      key: "publish",
      title: "外发",
      kind: "produce",
      role_id: "release_ops",
      required: true,
      depends_on: ["smoke"],
      completion_criteria: ["用发布链拍板外发签后包，附链接、大小和摘要"],
    },
    {
      key: "release_notes",
      title: "版本说明",
      kind: "produce",
      role_id: "release_ops",
      required: true,
      depends_on: ["publish"],
      completion_criteria: ["按外发结果写版本说明"],
    },
    acceptance,
  ],
} as const satisfies CardTemplate;
/** Legacy defaults remain available for projects below flow 5. */
export const builtinCardTemplates: readonly CardTemplate[] = [
  developmentCardTemplate,
  generalCardTemplate,
  storyCardTemplate,
  artifactCardTemplate,
  designCardTemplate,
];
/** Runtime registration follows the project flow; existing snapshots need no rewrite. */
export function builtinCardTemplatesForFlow(
  version = 1,
): readonly CardTemplate[] {
  return version >= 5
    ? [
        developmentCardTemplateV2,
        generalCardTemplate,
        storyCardTemplate,
        artifactCardTemplate,
        designCardTemplate,
        productCardTemplate,
        fastPatchCardTemplate,
        integrationCardTemplate,
        uiCardTemplate,
        releaseCardTemplate,
      ]
    : builtinCardTemplates;
}
/** All immutable source versions, including historical definitions. */
export const builtinCardTemplateVersions: readonly CardTemplate[] = [
  ...builtinCardTemplates,
  developmentCardTemplateV2,
  productCardTemplate,
  fastPatchCardTemplate,
  integrationCardTemplate,
  uiCardTemplate,
  releaseCardTemplate,
];

/** Creation-time input for UI implementations and design-first templates (including copies).
 * This is not a new workflow step or a change to a pinned template definition. */
export function requiresUiStateAndSave(template: CardTemplate): boolean {
  const key = template.primary_work_item_key;
  return (
    template.work_items.some(
      (w) =>
        w.key === key &&
        w.kind === "produce" &&
        (w.role_id === "frontend_engineer" || w.role_id === "ui_ux_designer"),
    ) &&
    template.work_items.some(
      (w) =>
        w.kind === "verify" &&
        w.required &&
        w.role_id === "design_director" &&
        w.target_work_item_key === key,
    )
  );
}

/** Historical cards resolve v1; never silently use a newer definition. */
export function cardTemplate(
  card: Pick<Card, "template" | "template_version">,
  templates: readonly CardTemplate[] = [],
): CardTemplate | undefined {
  const version = card.template_version ?? 1;
  return [...templates, ...builtinCardTemplateVersions].find(
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
