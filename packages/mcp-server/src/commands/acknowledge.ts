import { acknowledgeRun } from "@cardigan/domain";
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
 * acknowledge its own Run.
 */
export function acknowledgeDispatchedRun(
  store: McpBackend,
  identity: Identity,
  now: () => string = () => new Date().toISOString(),
): void {
  const { actor } = identity;
  const dispatched = store.uow.read((tx) =>
    tx.runs
      .list(actor.project_id)
      .find(
        (run) =>
          run.assignment_id === actor.assignment_id &&
          run.status === "dispatched",
      ),
  );
  if (dispatched === undefined) {
    return;
  }
  const result = store.uow.run((tx) => {
    const effect = acknowledgeRun(
      loadCommandState(tx, actor.project_id),
      actor,
      { run_id: dispatched.id },
      { clock: { now }, ids: tx.ids },
    );
    if (!effect.ok) {
      return effect;
    }
    persistEffect(tx, actor.project_id, effect.value);
    return effect;
  });
  if (!result.ok) {
    // A run that another request already acknowledged is not an error for this
    // request; anything else is surfaced by the tool call itself.
    throw Object.assign(new Error(result.error.message), {
      code: result.error.code,
    });
  }
}
