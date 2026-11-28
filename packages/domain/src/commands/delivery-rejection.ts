import type { Actor, Event, JsonValue } from "../entities.js";
import type { DomainError } from "../errors.js";
import { eventsOfType } from "../event-index.js";
import type { AssignmentId, WorkItemId } from "../ids.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";

/**
 * C-847: a submit_delivery whose caller stopped waiting (it was answered
 * "processing", or its client timed out) and that then failed. The failure
 * is recorded on the card instead of vanishing with the rolled-back
 * transaction: it shows on the timeline, and the next identical call (same
 * Assignment, idempotency key and request) gets the original error once.
 * After that, calls are evaluated against current state again, so fixing
 * the cause and repeating the call still works.
 */
export const DELIVERY_REJECTED_EVENT = "delivery_rejected";
export const DELIVERY_REJECTION_CLAIMED_EVENT = "delivery_rejection_claimed";
/** An unclaimed failure older than this is no longer handed out. */
export const DELIVERY_REJECTION_CLAIM_MS = 60 * 60 * 1000;
const MESSAGE_LIMIT = 4000;

export interface DeliveryRejectionKey {
  readonly assignment_id: AssignmentId;
  readonly work_item_id: WorkItemId;
  readonly idempotency_key: string;
  /** Host digest of the request parameters; compared, never parsed. */
  readonly request_fingerprint: string;
}
export interface DeliveryRejectionRecord extends DeliveryRejectionKey {
  readonly error: DomainError;
}
export interface ClaimedDeliveryRejection {
  readonly error: DomainError;
  readonly settled_at: string;
}

const payloadOf = (e: Event) =>
  e.payload && typeof e.payload === "object" && !Array.isArray(e.payload)
    ? (e.payload as Record<string, unknown>)
    : undefined;
const sameKey = (e: Event, k: DeliveryRejectionKey) => {
  const p = payloadOf(e);
  return (
    e.actor.kind === "system" &&
    p?.assignment_id === k.assignment_id &&
    p.idempotency_key === k.idempotency_key &&
    p.request_fingerprint === k.request_fingerprint
  );
};

/** The newest unclaimed, unexpired failure of exactly this request. */
export function pendingDeliveryRejection(
  events: readonly Event[],
  key: DeliveryRejectionKey,
  now: string,
): Event | undefined {
  const latest = eventsOfType(events, DELIVERY_REJECTED_EVENT)
    .filter((e) => sameKey(e, key))
    .at(-1);
  if (
    !latest ||
    Date.parse(now) - Date.parse(latest.created_at) >
      DELIVERY_REJECTION_CLAIM_MS
  )
    return undefined;
  const claimed = eventsOfType(events, DELIVERY_REJECTION_CLAIMED_EVENT).some(
    (e) => sameKey(e, key) && payloadOf(e)?.rejection_event_id === latest.id,
  );
  return claimed ? undefined : latest;
}

/** Host only: record a failure nobody received. */
export function recordDeliveryRejection(
  state: CommandState,
  actor: Actor,
  p: DeliveryRejectionRecord,
  ports: CommandPorts,
) {
  return command(state, actor, "record_delivery_rejection", ports, (d) => {
    ensure(
      typeof p.idempotency_key === "string" &&
        p.idempotency_key.length > 0 &&
        typeof p.request_fingerprint === "string" &&
        /^[a-f0-9]{64}$/u.test(p.request_fingerprint) &&
        typeof p.error?.code === "string" &&
        typeof p.error.message === "string",
      "validation_failed",
      "Invalid delivery rejection",
    );
    const assignment = d.get("assignments", p.assignment_id);
    ensure(
      assignment.scope === "work_item" &&
        assignment.work_item_id === p.work_item_id,
      "validation_failed",
      "Delivery rejection must name the Assignment's own work item",
    );
    const item = d.get("work_items", p.work_item_id);
    const message = [...p.error.message].slice(0, MESSAGE_LIMIT).join("");
    d.emit(
      DELIVERY_REJECTED_EVENT,
      item.card_id,
      {
        assignment_id: p.assignment_id,
        work_item_id: p.work_item_id,
        idempotency_key: p.idempotency_key,
        request_fingerprint: p.request_fingerprint,
        code: p.error.code,
        message,
        ...(p.error.details === undefined
          ? {}
          : { details: p.error.details as JsonValue }),
      },
      {
        type: "system",
        work_item_id: p.work_item_id,
        body: `${p.assignment_id} 的交付（幂等键 ${p.idempotency_key}）在调用方停止等待后校验完成，未登记：${p.error.code}：${message}。用同一幂等键和相同参数重提一次可取回这条报错；按报错修正后再提交。`,
      },
    );
    return true;
  });
}

/**
 * Host only: hand the pending failure of exactly this request to its caller,
 * once. Nothing pending writes nothing and returns undefined.
 */
export function claimDeliveryRejection(
  state: CommandState,
  actor: Actor,
  p: DeliveryRejectionKey,
  ports: CommandPorts,
) {
  return command(state, actor, "claim_delivery_rejection", ports, (d) => {
    const pending = pendingDeliveryRejection(d.state.events, p, d.now);
    if (!pending) return undefined;
    const payload = payloadOf(pending) ?? {};
    d.emit(DELIVERY_REJECTION_CLAIMED_EVENT, pending.card_id, {
      assignment_id: p.assignment_id,
      idempotency_key: p.idempotency_key,
      request_fingerprint: p.request_fingerprint,
      rejection_event_id: pending.id,
    });
    const claimed: ClaimedDeliveryRejection = {
      error: {
        code: payload.code as DomainError["code"],
        message: String(payload.message ?? ""),
        ...(payload.details && typeof payload.details === "object"
          ? { details: payload.details as Readonly<Record<string, unknown>> }
          : {}),
      },
      settled_at: pending.created_at,
    };
    return claimed;
  });
}
