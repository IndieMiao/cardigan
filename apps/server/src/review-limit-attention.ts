import {
  eventsOfType,
  type ProjectId,
  reviewLimitAttention,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import { payloadString } from "@cardigan/router";
import type { Store } from "@cardigan/store";
import { appendAttentionNotice } from "./attention-notice.js";
import type { StateLoader } from "./dispatch-state.js";
import {
  applyMaintenancePlan,
  type MaintenanceWrite,
} from "./maintenance-writes.js";

export function escalateReviewLimitWaits(
  store: Store,
  project: ProjectId,
  at: string,
  load: StateLoader = loadCommandState,
) {
  applyMaintenancePlan(store, project, (tx) => {
    const state = load(tx, project);
    const writes: MaintenanceWrite[] = [];
    const findings = reviewLimitAttention(state, at).filter(
      (f) => f.kind === "review_limit_not_resumed",
    );
    if (!findings.length) return writes;
    const seen = new Set(
      eventsOfType(state.events, "review_limit_not_resumed").map(
        (e) =>
          `${payloadString(e.payload, "decision_id")}/${payloadString(e.payload, "work_item_id")}`,
      ),
    );
    for (const finding of findings) {
      if (seen.has(`${finding.decision_id}/${finding.work_item_id}`)) continue;
      writes.push((tx) =>
        appendAttentionNotice(
          tx,
          store,
          project,
          finding.card_id,
          finding.kind,
          { ...finding },
          at,
        ),
      );
    }
    return writes;
  });
}
