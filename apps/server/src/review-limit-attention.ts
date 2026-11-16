import { type CommandState, reviewLimitAttention } from "@cardigan/domain";
import { payloadString } from "@cardigan/router";
import {
  moveNotification,
  recordNotification,
  type Store,
  type StoreTransactionContext,
} from "@cardigan/store";

/** Called inside dispatcher maintenance, independent of active Runs and Git setup. */
export function escalateReviewLimitWaits(
  tx: StoreTransactionContext,
  store: Store,
  state: CommandState,
  at: string,
) {
  for (const finding of reviewLimitAttention(state, at)) {
    // B2 records and routes its exception atomically with the original command.
    if (finding.kind === "review_limit_auto_raise_exhausted") continue;
    if (
      state.events.some(
        (e) =>
          e.type === finding.kind &&
          payloadString(e.payload, "decision_id") === finding.decision_id &&
          payloadString(e.payload, "work_item_id") === finding.work_item_id,
      )
    )
      continue;
    const event = {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(state.project_id, finding.card_id),
      card_id: finding.card_id,
      type: finding.kind,
      actor: { kind: "system" as const, project_id: state.project_id },
      payload: { ...finding },
      created_at: at,
    };
    tx.events.append(state.project_id, event);
    // Keep a durable attention marker and notify Ops using the existing inbox.
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
