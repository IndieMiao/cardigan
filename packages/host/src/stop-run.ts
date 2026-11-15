import type {
  AssignmentId,
  ProjectId,
  Runtime,
  RuntimeRef,
} from "@cardigan/domain";
import type { StoreTransactionContext } from "@cardigan/store";

import { confirmRuntimeExit } from "./runtime-exit.js";

/** Shared automatic-stop primitive: recheck eligibility, stop, independently prove exit. */
export async function stopRunRuntime(
  runtime: Runtime,
  ref: RuntimeRef | null,
  mayStop: () => boolean,
  alreadyStopping = false,
  /**
   * C-247: false for a stop that may only settle an exit it observes; it never
   * releases. Without proof of exit a fresh fence is not started (the caller
   * withdraws it) and a started fence is kept for a later observation.
   */
  releaseLive = true,
) {
  const observe = () => confirmRuntimeExit(runtime, ref);
  const before = await observe();
  // A previous release may finish after fresh activity or process loss. Settle
  // its original fence without asking to issue another stop; ownership and the
  // exact runtime reference are checked again by the settlement transaction.
  if (alreadyStopping && before) return "exited" as const;
  if (!releaseLive && ref && !before) return "not_exited" as const;
  if (!mayStop()) return "withdrawn" as const;
  if (before) return "exited" as const;
  if (ref) await runtime.release(ref, { force: true }).catch(() => undefined);
  return (await observe()) ? ("exited" as const) : ("unconfirmed" as const);
}

/** Call in the same transaction as cancellation, only after proving terminal exit. */
export function revokeStoppedRunTokens(
  tx: StoreTransactionContext,
  project: ProjectId,
  assignment: AssignmentId,
) {
  for (const token of tx.tokensForAssignment(project, assignment))
    if (token.revoked_at === null && !tx.revokeToken(token.id))
      throw new Error("Stopped Run token revocation failed");
}
