import {
  type Assignment,
  type CardId,
  type CommandState,
  hostOpsPending,
  type ProjectId,
  type Run,
  type RunId,
  type RuntimeRef,
  recoveryTargetCurrent,
  reviewRunWakeDisposition,
  stoppedByHuman,
} from "@cardigan/domain";
import type { Store } from "@cardigan/store";
import { HostLaunchError } from "./errors.js";

/** Shared by first delivery, C-56 retry and explicit live-session reuse.
 * Read a fresh state after preparation and again in Runtime.before_send,
 * after adapter queue/lock waits and immediately before the raw send.
 * Run-status policies (including completed-Run unread reminders) stay with
 * the caller; cancellation and stop fences always forbid a new send.
 */
export function wakeIsCurrent(
  state: CommandState,
  expected: Assignment,
  runId: RunId,
): boolean {
  const owner = state.assignments.find((a) => a.id === expected.id);
  const run = state.runs.find((r) => r.id === runId);
  return !!(
    run &&
    run.assignment_id === expected.id &&
    (!run.recovery_policy ||
      run.recovery_policy.root_run_id === run.id ||
      recoveryTargetCurrent(state, run)) &&
    owner?.status === "active" &&
    !owner.external &&
    !reviewRunWakeDisposition(state, owner, run) &&
    owner.role_id === expected.role_id &&
    owner.role_version === expected.role_version &&
    owner.machine_id === expected.machine_id &&
    owner.session_ref === expected.session_ref &&
    owner.runtime_ref &&
    JSON.stringify(owner.runtime_ref) ===
      JSON.stringify(expected.runtime_ref) &&
    !["cancelled", "failed", "unknown"].includes(run.status) &&
    !run.dispatch_stop &&
    !run.inactivity_stop &&
    !stoppedByHuman(state.events, owner.id) &&
    !hostOpsPending(state.events, owner.id)
  );
}

/** The caller proved no wake occurred; withdraw instead of recording failure. */
export class RunWakeWithdrawn extends HostLaunchError {
  constructor() {
    super("dispatch", "准备或排队期间执行或会话状态已变，未发送门铃");
  }
}

/** Pin the actual addressed terminal, not whatever ref is current when hc returns.
 * Only the send boundary may open the application-level receipt window. */
export function armBellReceipt(
  store: Store,
  project: ProjectId,
  runId: RunId,
  ref: RuntimeRef,
  card?: CardId,
  review?: NonNullable<Run["bell_delivery"]>["review_target"],
) {
  return store.uow.run((tx) => {
    const run = tx.runs.get(project, runId);
    if (run?.status !== "dispatched") return false;
    const owner = tx.assignments.get(project, run.assignment_id);
    if (!owner || JSON.stringify(owner.runtime_ref) !== JSON.stringify(ref))
      return false;
    const pending =
      run.bell_delivery?.run_id === run.id ? run.bell_delivery : undefined;
    tx.runs.put(project, {
      ...run,
      bell_delivery: {
        ...(pending ?? (card ? { card_id: card } : {})),
        run_id: runId,
        ...(review
          ? {
              review_target: {
                delivery_id: review.delivery_id,
                target_sha: review.target_sha,
              },
            }
          : {}),
        ...(owner.session_ref ? { session_ref: owner.session_ref } : {}),
        runtime_ref: ref,
      },
    });
    return true;
  });
}

export function confirmBellWrite(
  store: Store,
  project: ProjectId,
  id: RunId,
  at: string,
) {
  store.uow.run((tx) => {
    const run = tx.runs.get(project, id);
    if (
      run?.bell_delivery?.runtime_ref &&
      run.bell_delivery.run_id === id &&
      !run.bell_delivery.sent_at
    )
      tx.runs.put(project, {
        ...run,
        bell_delivery: { ...run.bell_delivery, sent_at: at },
      });
  });
}
