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
