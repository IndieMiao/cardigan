import {
  type Clock,
  type ProjectId,
  refreshTestReviewLimits,
} from "@cardigan/domain";
import type { Store } from "@cardigan/store";
import { applyCommand } from "./commands.js";

/** Separate committed admission step: a rejected launch cannot roll back its budget wait. */
export function settleTestReviewLimits(
  store: Store,
  project: ProjectId,
  clock?: Clock,
) {
  return applyCommand(store, {
    project,
    actor: { kind: "system", project_id: project },
    ...(clock ? { clock } : {}),
    reduce: refreshTestReviewLimits,
  });
}
