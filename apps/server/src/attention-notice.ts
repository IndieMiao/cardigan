import type { CardId, JsonValue, ProjectId } from "@cardigan/domain";
import {
  moveNotification,
  recordNotification,
  type Store,
  type StoreTransactionContext,
} from "@cardigan/store";

/** Append the fact, durable marker and Ops notification in one transaction. */
export function appendAttentionNotice(
  tx: StoreTransactionContext,
  store: Store,
  project: ProjectId,
  card: CardId,
  type: string,
  payload: JsonValue,
  at: string,
) {
  const event = {
    id: tx.ids.nextEventId(),
    seq: tx.ids.nextEventSequence(project, card),
    card_id: card,
    type,
    actor: { kind: "system" as const, project_id: project },
    payload,
    created_at: at,
  };
  tx.events.append(project, event);
  // Keep a durable attention marker and notify Ops using the existing inbox.
  const notice = recordNotification(store.database, {
    project_id: project,
    event_id: event.id,
    card_id: event.card_id,
    seq: event.seq,
    recipient: { kind: "needs_you" },
    kind: "escalation",
    at,
  }).notification;
  moveNotification(store.database, {
    project_id: project,
    id: notice.id,
    event: "needs_attention",
    at,
  });
  recordNotification(store.database, {
    project_id: project,
    event_id: event.id,
    card_id: event.card_id,
    seq: event.seq,
    recipient: { kind: "pm_ops" },
    kind: "escalation",
    at,
  });
}
