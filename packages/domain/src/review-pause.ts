import type { Decision, ReviewPause } from "./entities.js";

export function pendingPause(q: Decision) {
  return q.trigger === "review_limit" &&
    q.status === "provisional" &&
    q.resolution?.option === "pause"
    ? q.review_pause
    : undefined;
}
export function pauseOwners(p: ReviewPause) {
  return p.proposal
    ? p.confirmers.filter((id) => !p.confirmations.some((c) => c.by === id))
    : [p.owner];
}
export function pauseLabel(p: ReviewPause) {
  if (!p.proposal) return "待方案";
  return pauseOwners(p).length ? "待确认" : "待 PM 结案恢复";
}

const discussions = new WeakMap<readonly Decision[], Map<string, Decision>>();
export function pauseDiscussionFor(
  decisions: readonly Decision[],
  recipient: string,
) {
  let index = discussions.get(decisions);
  if (!index) {
    index = new Map();
    for (const q of decisions) {
      const p = pendingPause(q);
      if (p)
        for (const id of pauseOwners(p)) if (!index.has(id)) index.set(id, q);
    }
    discussions.set(decisions, index);
  }
  return index.get(recipient);
}
