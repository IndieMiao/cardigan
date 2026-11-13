import {
  type CommandState,
  type JsonValue,
  PM_MERGE_STALL_KIND,
  type PmMergeStallOptions,
  pmMergeStallAttention,
  pmMergeStallNotice,
} from "@cardigan/domain";
import { payloadString } from "@cardigan/router";
import {
  moveNotification,
  recordNotification,
  type Store,
  type StoreTransactionContext,
} from "@cardigan/store";

/**
 * C-177: called inside dispatcher maintenance (no Run, no token). Alerts once
 * per confirmation and wait period, and resolves its markers once the
 * confirmation is handled or its wait restarts.
 */
export function escalatePmMergeStalls(
  tx: StoreTransactionContext,
  store: Store,
  state: CommandState,
  at: string,
  options: PmMergeStallOptions = {},
) {
  const findings = pmMergeStallAttention(state, at, options);
  const current = new Set(findings.map((f) => `${f.decision_id}@${f.since}`));
  const keyOf = (payload: JsonValue) =>
    `${payloadString(payload, "decision_id")}@${payloadString(payload, "since")}`;
  for (const n of store.listNotifications({ project_id: state.project_id })) {
    if (["acked", "resolved"].includes(n.status)) continue;
    const event = state.events.find((e) => e.id === n.event_id);
    if (
      event?.type !== PM_MERGE_STALL_KIND ||
      current.has(keyOf(event.payload))
    )
      continue;
    moveNotification(store.database, {
      project_id: state.project_id,
      id: n.id,
      event: "resolve",
      at,
    });
  }
  for (const finding of findings) {
    if (
      state.events.some(
        (e) =>
          e.type === PM_MERGE_STALL_KIND &&
          keyOf(e.payload) === `${finding.decision_id}@${finding.since}`,
      )
    )
      continue;
    const event = {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(state.project_id, finding.card_id),
      card_id: finding.card_id,
      type: PM_MERGE_STALL_KIND,
      actor: { kind: "system" as const, project_id: state.project_id },
      payload: {
        ...finding,
        notice: pmMergeStallNotice(finding.card_id, finding.waited_ms),
      },
      created_at: at,
    };
    tx.events.append(state.project_id, event);
    const notice = recordNotification(store.database, {
      project_id: state.project_id,
      event_id: event.id,
      card_id: event.card_id,
      seq: event.seq,
      recipient: { kind: "needs_you" },
      kind: "escalation",
      at,
    }).notification;
    moveNotification(store.database, {
      project_id: state.project_id,
      id: notice.id,
      event: "needs_attention",
      at,
    });
    recordNotification(store.database, {
      project_id: state.project_id,
      event_id: event.id,
      card_id: event.card_id,
      seq: event.seq,
      recipient: { kind: "pm_ops" },
      kind: "escalation",
      at,
    });
  }
}
