import type { ProjectId } from "./ids.js";
import { type CardStatus, states } from "./states.js";

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
  /**
   * C-177: minutes a PM-held merge confirmation may stay open after its check
   * concluded before PM Ops and the human are alerted. Absent means the default.
   */
  readonly merge_confirm_stall_after_minutes?: number;
  /** Missing entries use the documented defaults, including on existing projects. */
  readonly decision_delegation?: Readonly<
    Partial<Record<DecisionCategory, boolean>>
  >;
  /** Merge confirmations go to PM Ops unless this is explicitly false (§7.4). */
  readonly pm_merge_confirmation?: boolean;
  /**
   * Board lanes the human folded (true) or unfolded (false) by hand. A lane
   * without an entry follows the default: empty lanes start collapsed.
   */
  readonly board_collapsed_lanes?: Readonly<
    Partial<Record<CardStatus, boolean>>
  >;
}
/** Lane status keys accepted in `board_collapsed_lanes`. */
export function isBoardLane(value: string): value is CardStatus {
  return (states.card as readonly string[]).includes(value);
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
/** C-177 default for `merge_confirm_stall_after_minutes`. */
export const DEFAULT_MERGE_CONFIRM_STALL_MINUTES = 60;
export function mergeConfirmStallAfterMinutes(
  preferences?: ProjectPreferences,
): number {
  return (
    preferences?.merge_confirm_stall_after_minutes ??
    DEFAULT_MERGE_CONFIRM_STALL_MINUTES
  );
}
export function validMergeConfirmStallMinutes(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 1440
  );
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
