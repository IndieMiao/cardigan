import type { WorkItem } from "../entities.js";
import { beginReviewRound } from "../transitions.js";
import { type CommandDraft, ensure, unwrap } from "./core.js";

export const workCompleted = (item: WorkItem) =>
  item.kind === "produce"
    ? item.status === "accepted"
    : item.status === "passed";

export const reviewRound = (d: CommandDraft, item: WorkItem) =>
  d.list("reviews").filter((r) => r.work_item_id === item.id).length + 1;

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
