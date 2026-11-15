import type { WorkItem } from "../entities.js";
import { beginReviewRound } from "../transitions.js";
import { type CommandDraft, ensure, unwrap } from "./core.js";
import { reviewRound } from "./review-round.js";

export { reviewRound } from "./review-round.js";

import { workCompleted } from "./work-status.js";

export { workCompleted } from "./work-status.js";

/**
 * M5.S S6: whether a Run could start this work item right now.
 *
 * A bell that comes from `assign` (an Agent or the PM assigning through MCP)
 * must not wake an Agent that has nothing to do yet: a verify item waits for
 * its target delivery and a produce item for its dependencies — both are woken
 * by their own bell when that happens (§6.4). The rule mirrors `activeWork`
 * without moving anything; the Run itself still advances the item.
 */
export function canStartWork(input: {
  readonly item: WorkItem;
  readonly work_items: readonly WorkItem[];
}): boolean {
  const { item } = input;
  if (item.kind === "verify") return item.status === "ready";
  if (item.status === "ready" || item.status === "changes_requested")
    return true;
  if (item.status !== "todo") return false;
  return item.depends_on.every((id) => {
    const dependency = input.work_items.find(
      (candidate) => candidate.id === id,
    );
    return dependency !== undefined && workCompleted(dependency);
  });
}

// Only the caller's current Run can activate its work; waiting/terminal states stay intact.
export function activeWork(d: CommandDraft, item: WorkItem): WorkItem {
  let next = d.ownWork(item.id);
  if (next.kind === "produce" && next.status === "todo") {
    d.currentRun();
    ensure(
      next.depends_on.every((id) => workCompleted(d.work(id))),
      "invariant_violation",
      `Dependencies are not complete for ${item.id}`,
    );
    next = d.move(next, "dependencies_met");
  }
  if (
    next.status === "ready" ||
    (next.kind === "produce" && next.status === "changes_requested")
  ) {
    d.currentRun();
    if (next.kind === "verify") {
      const round = reviewRound(d, next);
      ensure(
        round <= next.max_review_rounds,
        "illegal_transition",
        `Review round limit has been reached for ${item.id} (${item.kind}:${item.status})`,
      );
      return {
        ...next,
        status: unwrap(
          beginReviewRound(next.status, round, next.max_review_rounds),
        ),
      };
    }
    return d.move(next, "run_started");
  }
  return next;
}
