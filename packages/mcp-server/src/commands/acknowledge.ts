import { acknowledgeRun, recordRunAckRefusal } from "@cardigan/domain";
import type { Identity } from "../auth.js";
import type { McpBackend } from "../backend.js";
import { loadCommandState, persistEffect } from "./execute.js";

/**
 * M2.6 step 8: the first authenticated tool call of an Assignment acknowledges
 * its dispatched Run.
 *
 * `acknowledgeRun` moves the Run `dispatched → acked → running` and applies
 * `run_started` to the caller's own work item, which is where M1's "starting a
 * Run does not advance the work item" gap is closed. It is called on every
 * authenticated request and does nothing once the Run is running, so a retry
 * or a concurrent call cannot double-apply it.
 *
 * The Run is found by assignment, not by a parameter: an agent can only
 * acknowledge its own Run. A verified session's Run only by the Token its
 * launch issued (C-600).
 */
export function acknowledgeDispatchedRun(
  store: McpBackend,
  identity: Identity,
  now: () => string = () => new Date().toISOString(),
): void {
  const { actor } = identity;
  // C-635: an indexed lookup; scanning every Run of the project on each tool
  // call cost milliseconds of the shared event loop.
  const dispatched = store.dispatchedRunIds
    ? store.dispatchedRunIds(actor.project_id, actor.assignment_id)[0]
    : store.uow.read(
        (tx) =>
          tx.runs
            .list(actor.project_id)
            .find(
              (run) =>
                run.assignment_id === actor.assignment_id &&
                run.status === "dispatched",
            )?.id,
      );
  if (dispatched === undefined) {
    return;
  }
  const result = store.uow.run((tx) => {
    const effect = acknowledgeRun(
      loadCommandState(tx, actor.project_id),
      actor,
      // C-600: compared with the session's launch Token in this write.
      { run_id: dispatched, token_id: identity.token.id },
      { clock: { now }, ids: tx.ids },
    );
    if (!effect.ok) {
      return effect;
    }
    persistEffect(tx, actor.project_id, effect.value);
    return effect;
  });
  if (!result.ok) {
    // C-735: keep the reason on the Run and the card so dispatch patrol, host
    // ops and PM can see it; the tool call still reports the failure.
    recordRefusal(store, identity, dispatched, result.error, now);
    // A run that another request already acknowledged is not an error for this
    // request; anything else is surfaced by the tool call itself.
    throw Object.assign(new Error(result.error.message), {
      code: result.error.code,
    });
  }
}

function recordRefusal(
  store: McpBackend,
  identity: Identity,
  run_id: Parameters<typeof recordRunAckRefusal>[2]["run_id"],
  error: { code: string; message: string },
  now: () => string,
): void {
  const { actor } = identity;
  try {
    store.uow.run((tx) => {
      const effect = recordRunAckRefusal(
        loadCommandState(tx, actor.project_id),
        actor,
        { run_id, code: error.code, message: error.message },
        { clock: { now }, ids: tx.ids },
      );
      if (effect.ok) persistEffect(tx, actor.project_id, effect.value);
    });
  } catch {
    // Best effort: the refusal itself is still thrown to the caller.
  }
}
