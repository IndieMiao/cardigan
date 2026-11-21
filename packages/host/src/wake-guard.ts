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
  repairWakeTarget,
  reviewReceiptTargetCurrent,
  reviewRunWakeDisposition,
  stoppedByHuman,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import {
  type BellAttempt,
  finishBellAttempt,
  type Store,
  settleWakeWithdrawal,
} from "@cardigan/store";
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
    if (run.kind === "rework") {
      const state = loadCommandState(tx, project);
      const target = repairWakeTarget(state, run);
      review ??=
        pending?.review_target ??
        (target && {
          delivery_id: target.id,
          target_sha: target.subject.value,
        });
      if (
        !reviewReceiptTargetCurrent(state, owner, {
          ...run,
          bell_delivery: {
            ...pending,
            run_id: runId,
            ...(review ? { review_target: review } : {}),
          },
        })
      )
        return false;
    }
    tx.runs.put(project, {
      ...run,
      bell_delivery: {
        ...(card ? { card_id: card } : {}),
        ...pending,
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

/** A positive refusal of an ordinary first write is not an ambiguous failure.
 * Tie the evidence to the exact settled claim: later failures cannot reuse it. */
export function recordWakeRefusal(
  store: Store,
  attempt: BellAttempt,
  expected: Assignment,
  at: string,
) {
  const project = attempt.project_id;
  store.uow.run((tx) => {
    const run = tx.runs.get(project, attempt.run_id);
    if (
      !attempt.review_wake &&
      run?.status === "dispatched" &&
      !run.started_at &&
      !run.bell_delivery?.sent_at &&
      !run.dispatch_stop &&
      !run.inactivity_stop &&
      wakeIsCurrent(loadCommandState(tx, project), expected, run.id) &&
      finishBellAttempt(store.database, project, attempt.id, "failed", at)
    ) {
      tx.runs.put(project, {
        ...run,
        bell_delivery: {
          ...run.bell_delivery,
          run_id: run.id,
          refused_attempt_id: attempt.id,
        },
      });
    } else settleWakeWithdrawal(store.database, attempt, at);
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
