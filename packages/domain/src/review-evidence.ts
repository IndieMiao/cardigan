import { reviewPassed } from "./derived.js";
import type { PlatformBlocker, Review } from "./entities.js";
import type { WorkItemId } from "./ids.js";

/**
 * C-618: platform blockers a reviewer may cite for pending evidence. Each is a
 * system record the control plane can check without trusting the reviewer.
 */
export const PLATFORM_BLOCKER_KINDS: readonly PlatformBlocker["kind"][] = [
  "card_merged",
  "deployment_ready",
];
export const MAX_PENDING_EVIDENCE = 10;

/** A pure evidence wait: neither a rejection nor a pass. */
export function evidenceWait(
  review: Partial<Pick<Review, "verdict" | "evidence_pending">>,
): boolean {
  return !!review.evidence_pending && review.verdict !== "reject";
}

/**
 * The verifier's newest pending evidence that no later pass has settled.
 * Code rejections carry it forward; a pass or a withdrawn review never
 * revives an older list.
 */
export function outstandingEvidence(
  reviews: readonly Review[],
  workItemId: WorkItemId,
): Review | undefined {
  const own = reviews
    .filter((r) => r.work_item_id === workItemId && !r.withdrawn)
    .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)));
  for (const review of own) {
    if (review.evidence_pending) return review;
    if (reviewPassed(review)) return undefined;
  }
  return undefined;
}

export function platformBlockerLabel(blocker: PlatformBlocker): string {
  return blocker.kind === "card_merged"
    ? `平台卡 ${blocker.target_id} 合并`
    : `提交 ${blocker.target_id.slice(0, 12)} 部署`;
}
