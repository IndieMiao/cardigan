import type { Actor } from "../entities.js";
import { type CommandPorts, type CommandState, command } from "./core.js";
import { requestReviewLimit } from "./review-limit.js";
import {
  currentReviewTarget,
  reviewRejectionsNeedAttention,
  reviewRound,
} from "./review-round.js";

/** Host admission/maintenance: persist the existing limit workflow before a failing start. */
export function refreshTestReviewLimits(
  state: CommandState,
  actor: Actor,
  ports: CommandPorts,
) {
  return command(state, actor, "refresh_test_review_limits", ports, (d) => {
    const paused: string[] = [];
    for (const item of d.list("work_items")) {
      if (
        item.kind !== "verify" ||
        !["ready", "in_progress", "waiting_decision"].includes(item.status) ||
        ["done", "cancelled", "awaiting_merge"].includes(
          d.card(item.card_id).status,
        )
      )
        continue;
      if (
        !currentReviewTarget(d, item) ||
        (reviewRound(d, item) <= item.max_review_rounds &&
          item.status !== "waiting_decision" &&
          !reviewRejectionsNeedAttention(d, item))
      )
        continue;
      requestReviewLimit(d, item);
      if (d.work(item.id).status === "waiting_decision") paused.push(item.id);
    }
    return paused;
  });
}
