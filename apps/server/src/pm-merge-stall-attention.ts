import {
  eventById,
  eventsOfType,
  type JsonValue,
  PM_MERGE_STALL_KIND,
  type PmMergeStallOptions,
  type ProjectId,
  pmMergeStallAttention,
  pmMergeStallNotice,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import { payloadString } from "@cardigan/router";
import { moveNotification, type Store } from "@cardigan/store";
import { appendAttentionNotice } from "./attention-notice.js";
import type { StateLoader } from "./dispatch-state.js";
import {
  applyMaintenancePlan,
  type MaintenanceWrite,
} from "./maintenance-writes.js";

export function escalatePmMergeStalls(
  store: Store,
  project: ProjectId,
  at: string,
  options: PmMergeStallOptions = {},
  load: StateLoader = loadCommandState,
) {
  applyMaintenancePlan(
    store,
    project,
    (tx) => {
      const state = load(tx, project);
      const writes: MaintenanceWrite[] = [];
      const findings = pmMergeStallAttention(state, at, options);
      const current = new Set(
        findings.map((f) => `${f.decision_id}@${f.since}`),
      );
      const keyOf = (payload: JsonValue) =>
        `${payloadString(payload, "decision_id")}@${payloadString(payload, "since")}`;
      const stalls = eventsOfType(state.events, PM_MERGE_STALL_KIND);
      if (!findings.length && !stalls.length) return writes;
      const seen = new Set(stalls.map((e) => keyOf(e.payload)));
      for (const n of store.listNotifications({
        project_id: state.project_id,
        statuses: ["pending", "belled", "delivery_failed", "needs_attention"],
      })) {
        const event = eventById(stalls, n.event_id);
        if (
          event?.type !== PM_MERGE_STALL_KIND ||
          current.has(keyOf(event.payload))
        )
          continue;
        writes.push(() =>
          moveNotification(store.database, {
            project_id: state.project_id,
            id: n.id,
            event: "resolve",
            at,
          }),
        );
      }
      for (const finding of findings) {
        if (seen.has(`${finding.decision_id}@${finding.since}`)) continue;
        const payload = {
          ...finding,
          notice: pmMergeStallNotice(finding.card_id, finding.waited_ms),
        };
        writes.push((tx) =>
          appendAttentionNotice(
            tx,
            store,
            project,
            finding.card_id,
            finding.kind,
            payload,
            at,
          ),
        );
      }
      return writes;
    },
    true,
  );
}
