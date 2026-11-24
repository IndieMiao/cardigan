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
  "credential",
  "publish",
] as const;
export type DecisionCategory = (typeof decisionCategories)[number];
export const delegationCategories = [
  ...decisionCategories,
  "sensitive",
] as const;
export type DelegationCategory = (typeof delegationCategories)[number];
export const highRiskCategories: readonly DecisionCategory[] = [
  "spending",
  "account",
  "data_deletion",
  "credential",
  "publish",
];
export const defaultDecisionDelegation: Readonly<
  Record<DelegationCategory, boolean>
> = {
  general: true,
  feature_detail: true,
  scope_change: true,
  spending: false,
  account: false,
  permission: true,
  data_deletion: false,
  credential: false,
  publish: false,
  sensitive: false,
};
/** C-237: every value (including allowed ranges) is explicitly chosen by the human. */
export interface SystemReminderPolicy {
  readonly min_minutes: number;
  readonly max_minutes: number;
  readonly min_count: number;
  readonly max_count: number;
  readonly unassigned_ready_after_minutes: number | null;
  readonly pre_merge_check_pending_after_minutes: number | null;
  readonly repeat: boolean;
  readonly repeat_interval_minutes: number | null;
  readonly max_reminders: number;
}
/** C-238: no path defaults; empty lists remain uncertain. */
export interface MergeShadowPolicy {
  readonly role_rule_paths: readonly string[];
  readonly release_paths: readonly string[];
}
export interface ProjectPreferences {
  readonly machine_preference?: readonly string[];
  /** Same-project reference reads; only the human may change this default-on switch. */
  readonly cross_card_read?: boolean;
  /** Flow v2 A3b: human-only brake; absent means false. Consumed by A3a. */
  readonly auto_merge_paused?: boolean;
  /** Flow Lite: human-only, audited; applies to every existing card. */
  readonly auto_merge?: "off" | "on";
  readonly high_risk_paths?: readonly string[];
  /** D6: human-maintained; .github/** is mandatory. Absent uses defaults. */
  readonly auto_security_paths?: readonly string[];
  /** Human-only default for new cards; missing means 1. */
  readonly flow_version?: number;
  /** Legacy C-239 proof policy; Flow Lite extends review budgets without this opt-in. */
  readonly system_review_limit_raise?: boolean;
  readonly system_review_limit_max_raises?: number | null;
  readonly role_rule_paths?: readonly string[] | null;
  readonly system_merge_shadow?: boolean;
  readonly system_merge_shadow_policy?: MergeShadowPolicy | null;
  readonly system_auto_assign_verifiers?: boolean;
  readonly system_reminders?: boolean;
  readonly pm_owner_messages?: boolean;
  readonly system_reminder_policy?: SystemReminderPolicy | null;
  readonly id: ProjectId;
  readonly auto_merge_after_minutes: number | null;
  /** C-200: remaining context percentages, never cumulative token usage. */
  readonly context_handoff_remaining_pct?: number;
  readonly context_restart_remaining_pct?: number;
  /**
   * C-177: minutes a PM-held merge confirmation may stay open after its check
   * concluded before PM Ops and the human are alerted. Absent means the default.
   */
  readonly merge_confirm_stall_after_minutes?: number;
  /** C-180: default duration of an explicit merge hold, in minutes. */
  readonly merge_confirm_snooze_default_minutes?: number;
  /** C-193: maximum duration from the first hold of a merge confirmation. */
  readonly merge_confirm_snooze_max_minutes?: number;
  /** Missing entries use the documented defaults, including on existing projects. */
  readonly decision_delegation?: Readonly<
    Partial<Record<DelegationCategory, boolean>>
  >;
  /** Merge confirmations go to PM Ops unless this is explicitly false (§7.4). */
  readonly pm_merge_confirmation?: boolean;
  /** C-310: default on; only human settings may change it. */
  readonly pm_confirm_role_rule_implementations?: boolean;
  /** C-309: human-decided scope/permission merges; absent means enabled. */
  readonly pm_confirm_human_decided_merges?: boolean;
  /**
   * P2a-14 ⑧ gray switch, off unless explicitly true: whether the independent
   * reviewer's browser screenshot check may count toward PM Ops confirming a
   * UI card's merge. Off keeps C-86 (a human still checks the screenshots).
   * It does not decide who gets a browser: that is the role's `browser`
   * capability plus the host's install. Turned on only after the 5-card trial.
   */
  readonly enable_reviewer_browser?: boolean;
  /**
   * Board lanes the human folded (true) or unfolded (false) by hand. A lane
   * without an entry follows the default: empty lanes start collapsed.
   */
  readonly board_collapsed_lanes?: Readonly<
    Partial<Record<CardStatus, boolean>>
  >;
  /**
   * C-253: initial review limit of new verifiers other than the independent
   * reviewer. Existing work items keep the limit recorded at creation.
   */
  readonly review_max_rounds?: number;
  /** C-253: initial review limit of new `independent_reviewer` verifiers. */
  readonly independent_review_max_rounds?: number;
  /** C-301: explicit human authorization; absent means off. */
  readonly independent_review_limit_delegation?: boolean;
  /** Legacy delegated-raise preference, retained for historical settings/audit. */
  readonly independent_review_limit_delegation_max?: number | null;
  /**
   * C-265: runtime switch for the host's loop timing (`tick_profile` lines).
   * Off unless explicitly true; only the human changes it (local CLI). The
   * server measures while any project on the host has it on, or while
   * `CARDIGAN_TICK_PROFILE=1` forces it on.
   */
  readonly tick_profile?: boolean;
  /**
   * C-684: templates a person may open cards from in Workbench or the local
   * CLI. Absent means only the story template; Agents, PM and the system are
   * not limited, nor are story children opened from a confirmed proposal.
   */
  readonly human_card_templates?: readonly string[];
}
/** C-684: the story template is always open to people. */
export const STORY_TEMPLATE_ID = "story";
export const DEFAULT_HUMAN_CARD_TEMPLATES: readonly string[] = [
  STORY_TEMPLATE_ID,
];
export const humanCardTemplates = (p?: ProjectPreferences): readonly string[] =>
  p?.human_card_templates ?? DEFAULT_HUMAN_CARD_TEMPLATES;
/** Template IDs as `manage_card_template` accepts them. */
export const validHumanCardTemplateId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 64 &&
  (value === "fast_patch" || /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value));
/** Lane status keys accepted in `board_collapsed_lanes`. */
export function isBoardLane(value: string): value is CardStatus {
  return (states.card as readonly string[]).includes(value);
}
export function tickProfileOn(preferences?: ProjectPreferences): boolean {
  return preferences?.tick_profile === true;
}
export const pmConfirmRoleRuleImplementations = (p?: ProjectPreferences) =>
  p?.pm_confirm_role_rule_implementations !== false;

export function pmMergeConfirmation(preferences?: ProjectPreferences): boolean {
  return preferences?.pm_merge_confirmation !== false;
}
export function pmConfirmHumanDecidedMerges(
  preferences?: ProjectPreferences,
): boolean {
  return preferences?.pm_confirm_human_decided_merges !== false;
}
export function reviewerBrowserEnabled(
  preferences?: ProjectPreferences,
): boolean {
  return preferences?.enable_reviewer_browser === true;
}
export function decisionDelegation(
  preferences?: ProjectPreferences,
): Readonly<Record<DelegationCategory, boolean>> {
  return {
    ...defaultDecisionDelegation,
    ...preferences?.decision_delegation,
  };
}
/** C-253 defaults (user decision 2026-11-14) and the accepted range. */
export const DEFAULT_REVIEW_MAX_ROUNDS = 5;
export const DEFAULT_INDEPENDENT_REVIEW_MAX_ROUNDS = 3;
/**
 * Largest accepted review limit, 依据 Q-420 (2026-11-14: 最多填 20). The only
 * definition: the server, CLI and Workbench settings page all read it from here.
 */
export const REVIEW_MAX_ROUNDS_CEILING = 20;
export function reviewMaxRounds(preferences?: ProjectPreferences): number {
  return preferences?.review_max_rounds ?? DEFAULT_REVIEW_MAX_ROUNDS;
}
export function independentReviewMaxRounds(
  preferences?: ProjectPreferences,
): number {
  return (
    preferences?.independent_review_max_rounds ??
    DEFAULT_INDEPENDENT_REVIEW_MAX_ROUNDS
  );
}
/** Initial limit for a new verifier of `roleId`, from the project preferences. */
export function initialReviewMaxRounds(
  roleId: string,
  preferences?: ProjectPreferences,
): number {
  return roleId === "independent_reviewer"
    ? independentReviewMaxRounds(preferences)
    : reviewMaxRounds(preferences);
}
export function validReviewMaxRounds(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= REVIEW_MAX_ROUNDS_CEILING
  );
}
/** Q-507: exactly three lifetime delegated raises per independent verifier. */
export const INDEPENDENT_REVIEW_DELEGATION_MAX = 3;
export function validIndependentReviewDelegationMax(
  value: unknown,
): value is number {
  return value === INDEPENDENT_REVIEW_DELEGATION_MAX;
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

export function mergeConfirmSnoozeDefaultMinutes(
  preferences?: ProjectPreferences,
): number {
  return preferences?.merge_confirm_snooze_default_minutes ?? 240;
}

export function mergeConfirmSnoozeMaxMinutes(
  preferences?: ProjectPreferences,
): number {
  return preferences?.merge_confirm_snooze_max_minutes ?? 4320;
}

export function validMergeConfirmSnoozeMaxMinutes(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 60 &&
    value <= 10080
  );
}

export function contextUsageThresholds(preferences?: ProjectPreferences) {
  return {
    handoff: preferences?.context_handoff_remaining_pct ?? 20,
    restart: preferences?.context_restart_remaining_pct ?? 15,
  };
}
export function validContextPercentage(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value < 100
  );
}

/** No operational defaults. Safe integer checks protect arithmetic, not product policy. */
export function validSystemReminderPolicy(
  value: unknown,
): value is SystemReminderPolicy | null {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as SystemReminderPolicy;
  const keys = [
    "min_minutes",
    "max_minutes",
    "min_count",
    "max_count",
    "unassigned_ready_after_minutes",
    "pre_merge_check_pending_after_minutes",
    "repeat",
    "repeat_interval_minutes",
    "max_reminders",
  ];
  if (
    Object.keys(p).some((k) => !keys.includes(k)) ||
    keys.some((k) => !Object.hasOwn(p, k))
  )
    return false;
  const positive = (n: unknown): n is number =>
    typeof n === "number" && Number.isSafeInteger(n) && n > 0;
  if (
    ![
      p.min_minutes,
      p.max_minutes,
      p.min_count,
      p.max_count,
      p.max_reminders,
    ].every(positive)
  )
    return false;
  if (
    !Number.isSafeInteger(p.max_minutes * 60_000) ||
    p.min_minutes > p.max_minutes ||
    p.min_count > p.max_count ||
    p.max_reminders < p.min_count ||
    p.max_reminders > p.max_count ||
    typeof p.repeat !== "boolean"
  )
    return false;
  const minutes = (n: unknown) =>
    positive(n) && n >= p.min_minutes && n <= p.max_minutes;
  return (
    [
      p.unassigned_ready_after_minutes,
      p.pre_merge_check_pending_after_minutes,
    ].every((n) => n === null || minutes(n)) &&
    (p.repeat
      ? minutes(p.repeat_interval_minutes)
      : p.repeat_interval_minutes === null)
  );
}

/** Literal repository paths; patterns are validated separately. */
export function validMergePath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !/[\\*?[\]{}]/u.test(path) &&
    [...path].every(
      (char) => char.charCodeAt(0) > 32 && char.charCodeAt(0) !== 127,
    ) &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}
/** Literal Git evidence, not a pattern: all filename characters except NUL are ordinary. */
export function validChangedPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.includes("\u0000") &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}
/** Quote display text separately from the original path used for classification/audit data. */
export function displayChangedPath(path: string): string {
  return JSON.stringify(path).replace(
    /[\p{Cc}\p{Zl}\p{Zp}]/gu,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
/** Exact path, directory/**, or a nonempty final filename prefix followed by *. */
export function validMergePathList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((pattern) => {
      if (typeof pattern !== "string") return false;
      if (pattern.endsWith("/**")) return validMergePath(pattern.slice(0, -3));
      if (pattern.endsWith("*")) {
        const prefix = pattern.slice(0, -1);
        return validMergePath(prefix) && !prefix.endsWith("/");
      }
      return validMergePath(pattern);
    })
  );
}
/** Callers validate both the pattern list and literal changed paths first. */
export function mergePathMatches(path: string, pattern: string): boolean {
  if (pattern.endsWith("/**"))
    return (
      path === pattern.slice(0, -3) || path.startsWith(pattern.slice(0, -2))
    );
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return path.startsWith(prefix) && !path.slice(prefix.length).includes("/");
  }
  return path === pattern;
}
export const DEFAULT_AUTO_SECURITY_PATHS: readonly string[] = [
  ".github/**",
  "packages/store/migrations/**",
  "packages/host/src/deployment*",
  "apps/cli/src/self-deploy.ts",
];
export function autoSecurityPaths(p?: ProjectPreferences): readonly string[] {
  return [
    ...new Set([
      ".github/**",
      ...(p?.auto_security_paths ?? DEFAULT_AUTO_SECURITY_PATHS),
    ]),
  ];
}
export function validAutoSecurityPaths(
  value: unknown,
): value is readonly string[] {
  return validMergePathList(value) && value.includes(".github/**");
}
export function validMergeShadowPolicy(
  value: unknown,
): value is MergeShadowPolicy | null {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as MergeShadowPolicy | undefined;
  return (
    !!p &&
    Object.keys(p).length === 2 &&
    validMergePathList(p.role_rule_paths) &&
    validMergePathList(p.release_paths)
  );
}

export function autoMergePaused(preferences?: ProjectPreferences): boolean {
  return preferences?.auto_merge_paused === true;
}

export function crossCardRead(
  preferences?: Pick<ProjectPreferences, "cross_card_read">,
): boolean {
  return preferences?.cross_card_read !== false;
}

/** Flow Lite is independent of the card flow rollout. */
export const autoMergeOn = (p?: ProjectPreferences): boolean =>
  p?.auto_merge === "on";
export const DEFAULT_HIGH_RISK_PATHS: readonly string[] = [
  ".github/**",
  "packages/store/migrations/**",
  "packages/store/src/snapshot-migration.ts",
  "packages/store/src/priority-migration.ts",
  "packages/store/src/id-format-migration.ts",
  "packages/store/src/employee-migration.ts",
  "packages/host/src/deployment*",
  "apps/cli/src/self-deploy.ts",
  "packages/host/src/agent-git.ts",
  "packages/host/src/merge-push-config.ts",
  "packages/host/src/github-client.ts",
  "packages/roles/src/compile.ts",
  "packages/roles/src/assignment.ts",
  "packages/roles/src/schema.ts",
  "deploy/mobile-signing/**",
  "packages/mcp-server/src/tools/mobile-signing.ts",
  "apps/server/src/mobile-signing.ts",
  "apps/server/src/publish-artifact.ts",
  "apps/server/src/publication-target.ts",
  "packages/mcp-server/src/tools/publish-artifact.ts",
  "packages/domain/src/artifact-publication.ts",
  "deploy/worker-files.py",
  "deploy/worker-primitives.py",
  "deploy/worker-preflight.mjs",
  "packages/host/src/launch*",
  "packages/host/src/runtime-targets.ts",
  "packages/host/src/runtime-workers-config.ts",
  "packages/host/src/github-check*",
  "packages/host/src/merge-gate-executors.ts",
  "packages/store/src/tokens.ts",
  "packages/domain/src/preferences.ts",
  "packages/domain/src/commands/preferences.ts",
  "packages/domain/src/commands/delegation.ts",
  "packages/domain/src/commands/system-merge*",
  "packages/domain/src/commands/review-reuse.ts",
  "packages/domain/src/commands/review-context.ts",
  "packages/git-service/src/review-equivalence.ts",
  "packages/mcp-server/src/auth.ts",
  "packages/runtime-herdr/src/agent-ssh*",
  "packages/runtime-herdr/src/agent-files.ts",
  "packages/runtime-herdr/src/execution.ts",
  "packages/runtime-herdr/src/worker-*",
  "packages/git-transport/src/central.ts",
];
export const highRiskPaths = (p?: ProjectPreferences): readonly string[] =>
  p?.high_risk_paths ?? DEFAULT_HIGH_RISK_PATHS;
