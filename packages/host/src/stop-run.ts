import type {
  AssignmentId,
  ProjectId,
  Runtime,
  RuntimeRef,
} from "@cardigan/domain";
import type { StoreTransactionContext } from "@cardigan/store";

const exited = (result: Awaited<ReturnType<Runtime["status"]>> | undefined) =>
  result?.ok
    ? result.value.process === "exited"
    : result?.error.code === "runtime_not_found";

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
  const observedExit = async () => {
    if (!ref) return true;
    if (!owner) return exited(await runtime.status(ref).catch(() => undefined));
    // The generic status feed can omit a live terminal. Only the dedicated
    // get of the bound address/labels may confirm exit on this recovery path.
    const proof = await runtime
      .observe_retirement?.(ref, owner)
      .catch(() => undefined);
    return proof?.ok
      ? proof.value === "exited"
      : proof?.error.code === "runtime_not_found";
  };
  const before = await observedExit();
  // A previous release may finish after fresh activity or process loss. Settle
  // its original fence without asking to issue another stop; ownership and the
  // exact runtime reference are checked again by the settlement transaction.
  if (alreadyStopping && before) return "exited" as const;
  if (!releaseLive && ref && !before) return "not_exited" as const;
  if (beforeMayStop) await beforeMayStop();
  if (!mayStop()) return "withdrawn" as const;
  if (!ref || before)
    return !owner || (await observedExit())
      ? ("exited" as const)
      : ("unconfirmed" as const);
  await runtime
    .release(ref, { force: true, ...(owner ? { owner } : {}) })
    .catch(() => undefined);
  return (await observedExit())
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
