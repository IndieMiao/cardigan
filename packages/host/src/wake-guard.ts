import {
  type Assignment,
  type CommandState,
  hostOpsPending,
  type RunId,
  recoveryTargetCurrent,
  stoppedByHuman,
} from "@cardigan/domain";
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
