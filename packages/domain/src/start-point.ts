import type { Assignment, Card, RoleReference, WorkItem } from "./entities.js";

/**
 * C-728: where a no-merge card's producer checks out. A start point is a full
 * commit SHA (SHA-1 or SHA-256) or a plain branch name; never a revision
 * expression, a full ref or a pattern. The host resolves it in the central
 * repository and distributes the commit to the target machine.
 */
const FULL_SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;

export function isFullCommitSha(value: string): boolean {
  return FULL_SHA.test(value);
}

/** A plain branch name below refs/heads, with the same rules as the central baseline. */
export function validBranchName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    value !== "@" &&
    !value.startsWith("-") &&
    !value.startsWith("refs/") &&
    !/[\s~^:?*[\\]/u.test(value) &&
    ![...value].some((c) => c.charCodeAt(0) < 33 || c.charCodeAt(0) === 127) &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.endsWith(".") &&
    value
      .split("/")
      .every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"))
  );
}

/** The normalized start point, or undefined when the value is not acceptable. */
export function normalizeStartPoint(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (/^[a-fA-F0-9]{40}(?:[a-fA-F0-9]{24})?$/u.test(trimmed))
    return trimmed.toLowerCase();
  // A short hex string is ambiguous with a branch name: require the full SHA.
  if (/^[a-fA-F0-9]{4,63}$/u.test(trimmed)) return undefined;
  return validBranchName(trimmed) ? trimmed : undefined;
}

/**
 * The start point that applies to this producer: the work item's own, then the
 * card's. Only a card that never merges (`merge_policy=none`) uses one; merge
 * cards keep starting from their baseline branch.
 */
export function effectiveStartPoint(
  card: Pick<Card, "merge_policy" | "start_point">,
  item: Pick<WorkItem, "kind" | "start_point">,
): string | undefined {
  if (card.merge_policy !== "none" || item.kind !== "produce") return undefined;
  return item.start_point ?? card.start_point;
}

export const UNREGISTERED_WORKTREE_REASON = "本卡未登记仓库/起点";

/**
 * Why a work-item Assignment that wants source has no worktree. Only a card
 * without a registered repository has this reason; roles without a worktree
 * (`none`) and standing Assignments never need one.
 */
export function worktreeUnavailableReason(
  role: Pick<RoleReference, "worktree"> | undefined,
  assignment: Pick<Assignment, "scope" | "worktree_path">,
  card: Pick<Card, "repo"> | undefined,
): string | undefined {
  if (
    !role?.worktree ||
    role.worktree === "none" ||
    assignment.scope !== "work_item" ||
    assignment.worktree_path ||
    !card ||
    card.repo
  )
    return undefined;
  return UNREGISTERED_WORKTREE_REASON;
}

/** The start/wake prompt line for an Assignment without a worktree. */
export function worktreeUnavailablePrompt(
  reason: string | undefined,
): string | undefined {
  return reason
    ? `${reason}，系统没有准备 worktree。需要源码时请 report_blocker 写明，由 PM 用 cardigan card update --repo/--start-point（或 update_card 的 repo、start_point）补登记后继续。`
    : undefined;
}
