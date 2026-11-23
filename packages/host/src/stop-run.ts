import type {
  AssignmentId,
  ProjectId,
  RetirementIdentity,
  RetirementStop,
  Runtime,
  RuntimeRef,
  TurnIdlePrompt,
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

/**
 * C-620: a managed `assignment stop` may only treat its own release as exit
 * when that release ended a live session: the adapter checked this session's
 * identity and killed it. Observe before releasing; a finished or missing
 * terminal row says nothing about the session's process group.
 */
export async function stoppedSessionLive(
  runtime: Runtime,
  ref: RuntimeRef,
  owner: RetirementIdentity,
): Promise<boolean> {
  if (runtime.observe_retirement) {
    const exact = await runtime
      .observe_retirement(ref, owner)
      .catch(() => undefined);
    return exact?.ok === true && exact.value === "alive";
  }
  const observed = await runtime.status(ref).catch(() => undefined);
  return observed?.ok === true && observed.value.process === "alive";
}

/**
 * C-620: independent exit proof when the release did not end a live session
 * (the row was already finished or gone). Removing or reading a terminal row
 * is never proof. Only the kernel check that this session's launch receipt
 * process and its whole group are gone counts; otherwise the caller keeps the
 * reference and the stop.
 */
export async function stoppedSessionExited(
  runtime: Runtime,
  ref: RuntimeRef,
  owner: RetirementIdentity,
): Promise<boolean> {
  if (ref.machine_id !== "local" || !ref.local_process_receipt) return false;
  for (const check of [
    runtime.confirm_local_group_exit,
    runtime.confirm_local_exit,
  ]) {
    const proof = await check?.call(runtime, ref, owner).catch(() => undefined);
    if (proof?.ok === true && proof.value) return true;
  }
  return false;
}

/** System-ended bells never use address-based release, even for cleanup. A
 * previously started stop may only read exit evidence; no second signal.
 * A local "exited" needs process evidence beyond the finished terminal row:
 * the adapter's own post-signal group check or `processExited`. */
export async function stopSystemTurn(
  runtime: Runtime,
  ref: RuntimeRef | null,
  owner: RetirementIdentity,
  alreadyStopping: boolean,
  checkWorkspace: () => Promise<boolean>,
  beforeSignal: () => boolean,
  processExited: () => Promise<boolean> = async () => false,
  turn: {
    /** C-626: the bound empty editor stands in for missing hc activity. */
    readonly idlePrompt?: TurnIdlePrompt | undefined;
    /** C-626: a macOS worker generation (idle owner, then enrolled PID).
     * Its exit is proven by `processExited` (the registered group). */
    readonly remoteSignal?: boolean;
    /** Which owner-bound TERM was attempted, once the stop has an outcome. */
    readonly report?: (stop: RetirementStop | undefined) => void;
  } = {},
) {
  if (!ref) return "terminal_binding_changed";
  const remote = ref.machine_id !== "local";
  const confirmed = async (groupExited = false) => {
    const exact = await observeTurnOwner(runtime, ref, owner);
    if (exact?.ok !== true || exact.value !== "exited") return false;
    // Observe-only remote callers prove the registered group's exit before calling.
    if (remote) return !turn.remoteSignal || processExited();
    return groupExited || processExited();
  };
  // Other remote stall recovery observes an exit; it never acquires new signal authority.
  if (alreadyStopping || (remote && !turn.remoteSignal))
    return (await confirmed()) ? "exited" : "terminal_exit_unconfirmed";
  if (ref.local_process_receipt && !remote) {
    const before = await observeTurnOwner(runtime, ref, owner);
    if (before?.ok && before.value === "exited")
      return (await processExited()) ? "exited" : "terminal_exit_unconfirmed";
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
      ...(turn.idlePrompt ? { idle_prompt: turn.idlePrompt } : {}),
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
  if (result?.ok)
    turn.report?.(
      result.value.outcome === "exited"
        ? result.value.stop
        : result.value.evidence.stop,
    );
  if (result?.ok && result.value.outcome === "withdrawn")
    return result.value.evidence.reason;
  const groupExited =
    result?.ok === true &&
    result.value.outcome === "exited" &&
    result.value.process_group_exited === true;
  if (await confirmed(groupExited)) return "exited";
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
