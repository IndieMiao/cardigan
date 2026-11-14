import type { GitCentralPort } from "./git-port.js";
import type {
  CardId,
  DecisionId,
  DeliveryId,
  ReviewId,
  WorkItemId,
} from "./ids.js";

/** Host-selected facts, never accepted by an Agent tool. */
export interface SystemReviewLimitCandidate {
  readonly decision_id: DecisionId;
  readonly card_id: CardId;
  readonly work_item_id: WorkItemId;
  readonly review_id: ReviewId;
  readonly previous_delivery_id: DeliveryId;
  readonly previous_sha: string;
  readonly delivery_id: DeliveryId;
  readonly delivery_sha: string;
  readonly base_branch: string;
  readonly max_auto_raises: number;
  readonly role_rule_paths: readonly string[];
}
export interface SystemReviewLimitProof {
  readonly candidate: SystemReviewLimitCandidate;
  readonly base_sha: string;
  readonly merged_tree: string;
  readonly delivery_tree: string;
  /** Includes both previous->delivery and baseline->delivery; renames include both names. */
  readonly changed_paths: readonly string[];
}
/** Diagnostics are fixed labels only; no exception messages, paths, stderr or credentials. */
export const systemReviewLimitFailureStages = {
  repository: "准备中心仓库",
  baseline: "读取可信基线",
  delivery_refs: "核对固定交付引用",
  ancestry: "核对祖先关系",
  merge_tree: "计算干净合并树",
  delivery_tree: "读取交付树",
  changed_paths: "读取变更路径",
  baseline_recheck: "重查可信基线",
  proof: "调用证明程序",
} as const;
export const systemReviewLimitFailureCategories = {
  access_denied: "访问被拒绝",
  timeout: "执行超时",
  unsupported_git: "Git 功能不受支持",
  unavailable: "所需资源不可用",
  git_error: "Git 执行失败",
  unexpected_error: "发生未预期异常",
} as const;
export interface SystemReviewLimitFailure {
  readonly stage: keyof typeof systemReviewLimitFailureStages;
  readonly category: keyof typeof systemReviewLimitFailureCategories;
}
export type SystemReviewLimitOutcome =
  | SystemReviewLimitProof
  | { readonly failure: SystemReviewLimitFailure }
  | null;

/** Reconstruct from allowlists at persistence, even for a malformed host result. */
export function safeSystemReviewLimitFailure(
  value: unknown,
): SystemReviewLimitFailure {
  const f =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    stage:
      typeof f.stage === "string" &&
      Object.hasOwn(systemReviewLimitFailureStages, f.stage)
        ? (f.stage as SystemReviewLimitFailure["stage"])
        : "proof",
    category:
      typeof f.category === "string" &&
      Object.hasOwn(systemReviewLimitFailureCategories, f.category)
        ? (f.category as SystemReviewLimitFailure["category"])
        : "unexpected_error",
  };
}
export type SystemReviewLimitGitPort = Pick<
  GitCentralPort,
  "readRef" | "treeOfCommit" | "mergeTree" | "isAncestor"
> & {
  changedPaths(
    repository: string,
    base: string,
    head: string,
  ): Promise<readonly string[]>;
};

/** Explicit literal repository paths, optionally ending in /** for a subtree. */
export function validRoleRulePaths(
  value: unknown,
): value is readonly string[] | null {
  return (
    value === null ||
    (Array.isArray(value) &&
      value.every(
        (p) =>
          typeof p === "string" &&
          /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+(?:\/\*\*)?$/.test(p) &&
          !p.split("/").some((segment) => segment === "." || segment === ".."),
      ))
  );
}
export function validSystemReviewLimitMax(
  value: unknown,
): value is number | null {
  return (
    value === null ||
    (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
  );
}
export function touchesRoleRules(
  paths: readonly string[],
  rules: readonly string[],
) {
  return paths.some((path) =>
    rules.some((rule) => {
      const subtree = rule.endsWith("/**");
      const root = subtree ? rule.slice(0, -3) : rule;
      return path === root || (subtree && path.startsWith(`${root}/`));
    }),
  );
}
export const fullGitSha = (value: string) =>
  /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
