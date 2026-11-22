import type {
  AssignmentId,
  ProjectId,
  RetirementIdentity,
  Runtime,
  RuntimeRef,
} from "@cardigan/domain";
import type { StoreTransactionContext } from "@cardigan/store";
import { idleRetirementPolicy } from "./idle-session-retirement.js";
import { observeTurnOwner } from "./stall-evidence.js";

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
) {
  const observe = () =>
    ref ? runtime.status(ref).catch(() => undefined) : undefined;
  const before = await observe();
  // A previous release may finish after fresh activity or process loss. Settle
  // its original fence without asking to issue another stop; ownership and the
  // exact runtime reference are checked again by the settlement transaction.
  if (alreadyStopping && (!ref || exited(before))) return "exited" as const;
  if (!releaseLive && ref && !exited(before)) return "not_exited" as const;
  if (beforeMayStop) await beforeMayStop();
  if (!mayStop()) return "withdrawn" as const;
  if (!ref || exited(before)) return "exited" as const;
  await runtime.release(ref, { force: true }).catch(() => undefined);
  return exited(await observe())
    ? ("exited" as const)
    : ("unconfirmed" as const);
}

/** System-ended bells never use address-based release, even for cleanup. A
 * previously started stop may only read exit evidence; no second signal. */
export async function stopSystemTurn(
  runtime: Runtime,
  ref: RuntimeRef | null,
  owner: RetirementIdentity,
  alreadyStopping: boolean,
  checkWorkspace: () => Promise<boolean>,
  beforeSignal: () => boolean,
) {
  if (!ref) return "terminal_binding_changed";
  const confirmed = async () => {
    const exact = await observeTurnOwner(runtime, ref, owner);
    return exact?.ok === true && exact.value === "exited";
  };
  // Remote stall recovery observes an exit; it never acquires new signal authority.
  if (alreadyStopping || ref.machine_id !== "local")
    return (await confirmed()) ? "exited" : "terminal_exit_unconfirmed";
  if (ref.local_process_receipt) {
    const before = await observeTurnOwner(runtime, ref, owner);
    if (before?.ok && before.value === "exited") return "exited";
  }
  if (!runtime.retire_idle) return "unsupported";
  const { hangup_ms, terminate_ms } = idleRetirementPolicy();
  let workspaceReady = false;
  const result = await runtime
    .retire_idle(ref, {
      ...owner,
      hangup_ms,
      terminate_ms,
      system_finished_turn: true,
      workspace_preflight: async () =>
        (workspaceReady = await checkWorkspace()),
      before_signal: () => {
        // Fail closed if an adapter skips the in-slot preflight.
        if (!workspaceReady) return false;
        workspaceReady = false;
        return beforeSignal();
      },
    })
    .catch(() => undefined);
  if (result?.ok && result.value.outcome === "withdrawn")
    return result.value.evidence.reason;
  if (await confirmed()) return "exited";
  return "terminal_exit_unconfirmed";
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
