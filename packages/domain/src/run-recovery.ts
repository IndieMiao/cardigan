import type { CommandState } from "./commands/core.js";
import { stoppedByHuman } from "./commands/stop-state.js";
import { canStartWork } from "./commands/workflow.js";
import type { Assignment, Run, RuntimeRef, WorkItem } from "./entities.js";
import { flowAtLeast } from "./flow.js";
import { automaticContextActionForRun, hostOpsPending } from "./host-ops.js";
import { verificationTarget } from "./verification-activity.js";

/** Q-744 B1: this threshold does not open a selectable flow version. */
export const RECOVERY_FLOW_VERSION = 6;
const finished = (r: Run) =>
  ["completed", "failed", "cancelled"].includes(r.status);
const holdsExecution = (r: Run) =>
  !finished(r) ||
  r.dispatch_stop ||
  r.inactivity_stop ||
  (r.launch_publication &&
    !["started", "exited"].includes(r.launch_publication.phase));
const field = (p: unknown, key: string) =>
  p && typeof p === "object" ? (p as Record<string, unknown>)[key] : undefined;

/** B1 also permits a not-yet-submitted parallel review of the latest rejected product. */
function recoveryReviewTarget(item: WorkItem, state: CommandState) {
  const submitted = verificationTarget(item, state);
  if (submitted || item.kind !== "verify" || !item.target_work_item_id)
    return submitted;
  const target = state.deliveries
    .filter(
      (v) =>
        v.work_item_id === item.target_work_item_id &&
        v.kind !== "card_completion",
    )
    .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
  return target?.status === "rejected" &&
    target.requested_verifiers.includes(item.id) &&
    !state.reviews.some(
      (r) => r.delivery_id === target.id && r.work_item_id === item.id,
    )
    ? target
    : undefined;
}

/** Only an independent business queue may establish a root. Never backfill old Runs. */
export function newRecoveryPolicy(
  state: CommandState,
  a: Assignment,
  run: Run,
): Run["recovery_policy"] {
  const item = state.work_items.find((w) => w.id === a.work_item_id);
  const card = state.cards.find((c) => c.id === item?.card_id);
  const event = state.events.find((e) => e.id === run.trigger_event_id);
  if (
    !event ||
    event.actor.project_id !== state.project_id ||
    a.scope !== "work_item" ||
    a.external ||
    !card ||
    !flowAtLeast(card, RECOVERY_FLOW_VERSION) ||
    (event.type.startsWith("run_") && event.type !== "run_queued") ||
    event.type.startsWith("runtime_") ||
    event.type.startsWith("bell_") ||
    event.type === "host_ops_action_finished"
  )
    return;
  const target = item && recoveryReviewTarget(item, state);
  return {
    version: 6,
    root_run_id: run.id,
    trigger_event_id: run.trigger_event_id,
    card_id: card.id,
    ...(target ? { delivery_id: target.id } : {}),
  };
}

/** Validate the durable root, including the policy fixed before any dispatch. */
export function recoveryPolicy(
  state: CommandState,
  run: Run,
): Run["recovery_policy"] {
  const policy = run.recovery_policy;
  if (policy?.version !== 6) return;
  const root = state.runs.find((r) => r.id === policy.root_run_id);
  if (
    !root ||
    root.assignment_id !== run.assignment_id ||
    root.trigger_event_id !== policy.trigger_event_id ||
    JSON.stringify(root.recovery_policy) !== JSON.stringify(policy)
  )
    return;
  return policy;
}

export function recoveryChainUsed(state: CommandState, run: Run): boolean {
  const policy = recoveryPolicy(state, run);
  return (
    !!policy &&
    state.events.some(
      (e) =>
        e.actor.kind === "system" &&
        ["run_dispatch_recovered", "run_preparation_recovered"].includes(
          e.type,
        ) &&
        field(e.payload, "assignment_id") === run.assignment_id &&
        field(e.payload, "reason") !== "provider_unavailable" &&
        field(e.payload, "recovery_root_run_id") === policy.root_run_id,
    )
  );
}

/** Fresh business eligibility, shared by all automatic successor paths. */
export function recoveryTargetCurrent(state: CommandState, run: Run): boolean {
  const a = state.assignments.find((a) => a.id === run.assignment_id);
  const policy = recoveryPolicy(state, run);
  if (
    a?.scope !== "work_item" ||
    !policy ||
    a.external ||
    a.status !== "active" ||
    a.role_version !== run.role_version ||
    stoppedByHuman(state.events, a.id) ||
    hostOpsPending(state.events, a.id) ||
    automaticContextActionForRun(state.events, run)
  )
    return false;
  const item = state.work_items.find((w) => w.id === a.work_item_id);
  const card = state.cards.find((c) => c.id === item?.card_id);
  if (
    !item ||
    item.assignment_id !== a.id ||
    item.role_id !== a.role_id ||
    item.reported_blocker ||
    item.replaced_by_work_item_id ||
    !(
      item.status === "in_progress" ||
      canStartWork({ item, work_items: state.work_items })
    ) ||
    !card ||
    card.id !== policy.card_id ||
    !flowAtLeast(card, 6) ||
    ["done", "cancelled"].includes(card.status)
  )
    return false;
  if (
    item.kind === "verify" &&
    recoveryReviewTarget(item, state)?.id !== policy.delivery_id
  )
    return false;
  if (item.kind === "verify" && !policy.delivery_id) return false;
  if (
    state.decisions.some(
      (q) =>
        q.blocking &&
        ["open", "provisional", "snoozed"].includes(q.status) &&
        q.affected_work_items.includes(item.id),
    ) ||
    state.human_actions.some(
      (h) => h.status === "open" && h.blocked_work_items.includes(item.id),
    )
  )
    return false;
  // Never revive the original business after a successor, even one already finished.
  return !state.runs.some(
    (r) =>
      r.id !== run.id &&
      ((r.assignment_id === a.id &&
        (Number(r.id.slice(2)) > Number(run.id.slice(2)) ||
          holdsExecution(r))) ||
        (holdsExecution(r) &&
          state.assignments.some(
            (other) =>
              other.id === r.assignment_id &&
              other.id !== a.id &&
              a.worktree_path &&
              other.machine_id === a.machine_id &&
              other.worktree_path === a.worktree_path,
          ))),
  );
}

/** A complete immutable dispatch target; status IO must use exactly this reference. */
export function recoveryRuntimeBound(state: CommandState, run: Run): boolean {
  const a = state.assignments.find((a) => a.id === run.assignment_id);
  const ref: RuntimeRef | undefined = run.recovery_runtime;
  return !!(
    ref &&
    a &&
    ref.machine_id === a.machine_id &&
    ref.target?.project_id === state.project_id &&
    ref.target.machine_id === a.machine_id &&
    ref.target.session &&
    ref.target.generation &&
    ref.target.fingerprint &&
    ref.launch_generation?.generation &&
    ref.terminal_ref &&
    ref.runtime_machine &&
    (!ref.worktree_path || ref.worktree_path === a.worktree_path) &&
    (!ref.branch || ref.branch === a.branch) &&
    JSON.stringify(a.runtime_ref) === JSON.stringify(ref) &&
    (!run.launch_publication ||
      ["started", "exited"].includes(run.launch_publication.phase))
  );
}

export function c3ExitCandidate(state: CommandState, run: Run): boolean {
  return (
    ["dispatched", "acked", "running", "unknown"].includes(run.status) &&
    !run.pending_finish &&
    !run.inactivity_stop &&
    recoveryTargetCurrent(state, run) &&
    recoveryRuntimeBound(state, run) &&
    !state.deliveries.some((d) => d.run_id === run.id) &&
    !state.reviews.some((r) => r.run_id === run.id)
  );
}
