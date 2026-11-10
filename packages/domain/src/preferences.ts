import type { ProjectId } from "./ids.js";

export const decisionCategories = [
  "general",
  "feature_detail",
  "scope_change",
  "spending",
  "account",
  "permission",
  "data_deletion",
] as const;
export type DecisionCategory = (typeof decisionCategories)[number];
export const highRiskCategories: readonly DecisionCategory[] = [
  "spending",
  "account",
  "permission",
  "data_deletion",
];
export const defaultDecisionDelegation: Readonly<
  Record<DecisionCategory, boolean>
> = {
  general: true,
  feature_detail: true,
  scope_change: false,
  spending: false,
  account: false,
  permission: false,
  data_deletion: false,
};
export interface ProjectPreferences {
  readonly id: ProjectId;
  readonly auto_merge_after_minutes: number | null;
  /** Missing entries use the documented defaults, including on existing projects. */
  readonly decision_delegation?: Readonly<
    Partial<Record<DecisionCategory, boolean>>
  >;
  /** Merge confirmations go to PM Ops unless this is explicitly false (§7.4). */
  readonly pm_merge_confirmation?: boolean;
}
export function pmMergeConfirmation(preferences?: ProjectPreferences): boolean {
  return preferences?.pm_merge_confirmation !== false;
}
export function decisionDelegation(
  preferences?: ProjectPreferences,
): Readonly<Record<DecisionCategory, boolean>> {
  return {
    ...defaultDecisionDelegation,
    ...preferences?.decision_delegation,
    spending: false,
    account: false,
    permission: false,
    data_deletion: false,
  };
}
export function validAutoMergeMinutes(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 1 &&
      value <= 1440)
  );
}
