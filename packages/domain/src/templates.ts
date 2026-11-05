import type { Decider } from "./entities.js";
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
export interface CardTemplate {
  readonly id: string;
  readonly title: string;
  readonly require_acceptance_criteria: boolean;
  readonly primary_work_item_key: string;
  readonly completion_reviewer: Decider;
  readonly merge_policy: "confirm" | "auto";
  readonly work_items: readonly TemplateWorkItem[];
}
export const PM_ACCEPTANCE_WORK_ITEM_KEY = "pm_acceptance";

export const developmentCardTemplate = {
  id: "dev",
  title: "开发卡",
  require_acceptance_criteria: true,
  primary_work_item_key: "development",
  completion_reviewer: "role:pm",
  merge_policy: "confirm",
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
    {
      key: PM_ACCEPTANCE_WORK_ITEM_KEY,
      title: "PM 验收",
      kind: "verify",
      role_id: "pm",
      required: true,
    },
  ],
} as const satisfies CardTemplate;
