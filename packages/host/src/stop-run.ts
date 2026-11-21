import type {
  AssignmentId,
  ProjectId,
  Runtime,
  RuntimeRef,
} from "@cardigan/domain";
import type { StoreTransactionContext } from "@cardigan/store";

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
  beforeMayStop?: () => Promise<void>,
  owner?: Parameters<Runtime["release"]>[1]["owner"],
) {
  // For an owner-bound stop the generic feed may omit a live terminal. Only
  // a dedicated read of the bound address/labels can prove exit.
  const observe = () => {
    if (!ref) return;
    const read = owner
      ? runtime.observe_retirement?.(ref, owner)
      : runtime.status(ref);
    return read?.catch(() => undefined);
  };
  const exited = (result: Awaited<ReturnType<typeof observe>>) => {
    if (!result?.ok) return result?.error.code === "runtime_not_found";
    return typeof result.value === "string"
      ? result.value === "exited"
      : result.value.process === "exited";
  };
  if (owner && !ref) return "unconfirmed" as const;
  const before = exited(await observe());
  // A previous release may finish after fresh activity or process loss. Settle
  // its original fence without asking to issue another stop; ownership and the
  // exact runtime reference are checked again by the settlement transaction.
  if (alreadyStopping && (!ref || before)) return "exited" as const;
  if (!releaseLive && ref && !before) return "not_exited" as const;
  if (beforeMayStop) await beforeMayStop();
  if (!mayStop()) return "withdrawn" as const;
  if (!ref) return "exited" as const;
  if (before)
    return !owner || exited(await observe())
      ? ("exited" as const)
      : ("unconfirmed" as const);
  await runtime
    .release(ref, { force: true, ...(owner ? { owner } : {}) })
    .catch(() => undefined);
  return exited(await observe())
    ? ("exited" as const)
    : ("unconfirmed" as const);
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
