import { createHash } from "node:crypto";
import {
  type Actor,
  type ClaimedDeliveryRejection,
  type Clock,
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  claimDeliveryRejection,
  type DeliveryRejectionKey,
  type DomainError,
  pendingDeliveryRejection,
  type Result,
  recordDeliveryRejection,
} from "@cardigan/domain";
import type { ToolContext } from "../tools/types.js";
import { loadCommandState, persistEffect, unwrap } from "./execute.js";

/**
 * C-847: host side of a delivery failure nobody received (see
 * `delivery-rejection.ts` in the domain). Keyed by the caller's own
 * Assignment and work item, its idempotency key and a digest of the exact
 * request parameters, so a different request never receives it.
 */
export function rejectionKey(
  context: ToolContext,
  idempotency_key: string,
  params: unknown,
): DeliveryRejectionKey | undefined {
  const assignment = context.identity.assignment;
  if (assignment.scope !== "work_item") return undefined;
  return {
    assignment_id: assignment.id,
    work_item_id: assignment.work_item_id,
    idempotency_key,
    request_fingerprint: createHash("sha256")
      .update(JSON.stringify(params))
      .digest("hex"),
  };
}

function runSystem<P, T>(
  context: ToolContext,
  params: P,
  reduce: (
    state: CommandState,
    actor: Actor,
    params: P,
    ports: CommandPorts,
  ) => Result<CommandEffect<T>>,
  clock: Clock,
): T {
  const project = context.identity.actor.project_id;
  const actor: Actor = { kind: "system", project_id: project };
  return context.store.uow.run((tx) => {
    const state = loadCommandState(
      tx,
      project,
      context.projectSettings?.(project),
      { targets: [params] },
    );
    const effect = unwrap(reduce(state, actor, params, { clock, ids: tx.ids }));
    persistEffect(tx, project, effect);
    return effect.data;
  });
}

/** A failure recorded for exactly this request, handed out once. */
export function claimRejection(
  context: ToolContext,
  key: DeliveryRejectionKey,
  clock: Clock,
): ClaimedDeliveryRejection | undefined {
  const project = context.identity.actor.project_id;
  // Cheap read first: almost every call has nothing pending.
  const pending = context.store.uow.read((tx) => {
    const card = tx.work_items.get(project, key.work_item_id)?.card_id;
    return card
      ? pendingDeliveryRejection(
          tx.events.listAfter(project, card, 0),
          key,
          clock.now(),
        )
      : undefined;
  });
  if (!pending) return undefined;
  return runSystem(context, key, claimDeliveryRejection, clock);
}

/** Record a failure whose caller had already been answered "processing". */
export function recordRejection(
  context: ToolContext,
  key: DeliveryRejectionKey,
  error: DomainError,
  clock: Clock,
): void {
  runSystem(context, { ...key, error }, recordDeliveryRejection, clock);
}
